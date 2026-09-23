import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ProbeConfig, RouteOptions } from './types.js';
import {
  LIMITS,
  TOKEN_PATTERN,
  inRange,
  validateConfig,
  validateToken,
} from './limits.js';

const encoder = new TextEncoder();
// A stalled consumer must not hold a concurrency slot indefinitely. The grace
// period accommodates ordinary timer jitter at the maximum configured schedule.
const MAX_LIFETIME_MS = LIMITS.scheduleMs + LIMITS.lifetimeGraceMs;

function normalize(options: RouteOptions): {
  config: ProbeConfig;
  maxConcurrent: number;
} {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Diagnostic route options are required.');
  }
  validateToken(options.token);
  const config = validateConfig({
    scenario: options.scenario === undefined ? 'steady' : options.scenario,
    count: options.count === undefined ? LIMITS.count.default : options.count,
    intervalMs:
      options.intervalMs === undefined
        ? LIMITS.intervalMs.default
        : options.intervalMs,
    idleMs:
      options.idleMs === undefined ? LIMITS.idleMs.default : options.idleMs,
    heartbeatMs:
      options.heartbeatMs === undefined
        ? LIMITS.heartbeatMs.default
        : options.heartbeatMs,
  });
  const maxConcurrent =
    options.maxConcurrent === undefined
      ? LIMITS.maxConcurrent.default
      : options.maxConcurrent;
  if (!inRange(maxConcurrent, LIMITS.maxConcurrent)) {
    throw new TypeError(
      `maxConcurrent must be an integer between ${LIMITS.maxConcurrent.min} and ${LIMITS.maxConcurrent.max}.`,
    );
  }
  return { config, maxConcurrent };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Create a temporary, authenticated SSE diagnostic route. All emitted values
 * are synthetic. The handler runs in Node.js using the standard Request/Response
 * API, including a Next.js Node-runtime GET route. Other runtimes are untested.
 *
 * The authorization token must be generated randomly; length validation alone
 * cannot establish entropy. Query parameters never alter the configured probe.
 */
export function createDiagnosticRoute(
  options: RouteOptions,
): (request: Request) => Response {
  const { config, maxConcurrent } = normalize(options);
  const tokenDigest = digest(options.token);
  let active = 0;

  return (request: Request): Response => {
    const staticHeaders = {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    };
    const authorization = request.headers.get('authorization') ?? '';
    const candidate =
      authorization.length <= LIMITS.token.max + 7 &&
      /^Bearer /i.test(authorization)
        ? authorization.slice(7)
        : '';
    const validCharacters = TOKEN_PATTERN.test(candidate);
    // Fixed-size digests avoid comparing attacker-controlled buffers of
    // different lengths. Neither credentials nor request URLs are reflected.
    const valid = timingSafeEqual(
      tokenDigest,
      digest(validCharacters ? candidate : ''),
    );
    if (!validCharacters || !valid) {
      return new Response('Authorization required.\n', {
        status: 401,
        headers: { ...staticHeaders, 'WWW-Authenticate': 'Bearer' },
      });
    }
    if (request.method !== 'GET') {
      return new Response('Only GET is supported.\n', {
        status: 405,
        headers: { ...staticHeaders, Allow: 'GET' },
      });
    }
    if (request.signal.aborted) {
      return new Response('Request was aborted.\n', {
        status: 408,
        headers: staticHeaders,
      });
    }
    if (active >= maxConcurrent) {
      return new Response('Too many active diagnostic streams.\n', {
        status: 429,
        headers: { ...staticHeaders, 'Retry-After': '5' },
      });
    }

    const runId = randomUUID();
    const started = performance.now();
    let finished = false;
    let slotReserved = false;
    let sentStart = false;
    let ticks = 0;
    let lastTickMs = 0;
    let lastHeartbeatMs = 0;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDelay: (() => void) | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array>;

    const elapsed = (): number => Math.max(0, performance.now() - started);
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      if (slotReserved) {
        active -= 1;
        slotReserved = false;
      }
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
      request.signal.removeEventListener('abort', onAbort);
      resolveDelay?.();
      resolveDelay = undefined;
    };
    const fail = (error: Error): void => {
      if (finished) return;
      cleanup();
      streamController.error(error);
    };
    const onAbort = (): void =>
      fail(new DOMException('Diagnostic request aborted.', 'AbortError'));
    const waitUntil = async (deadline: number): Promise<void> => {
      while (!finished && elapsed() < deadline) {
        await new Promise<void>((resolve) => {
          resolveDelay = resolve;
          delayTimer = setTimeout(
            () => {
              delayTimer = undefined;
              resolveDelay = undefined;
              resolve();
            },
            Math.max(1, Math.ceil(deadline - elapsed())),
          );
        });
      }
    };
    const send = (event: string, data: object): void => {
      streamController.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    };

    try {
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
            active += 1;
            slotReserved = true;
            request.signal.addEventListener('abort', onAbort, { once: true });
            lifetimeTimer = setTimeout(
              () => fail(new Error('Diagnostic stream lifetime exceeded.')),
              MAX_LIFETIME_MS,
            );
            lifetimeTimer.unref?.();
            if (request.signal.aborted) onAbort();
          },
          async pull() {
            try {
              if (finished) return;
              if (!sentStart) {
                sentStart = true;
                send('start', {
                  version: 1,
                  runId,
                  emittedMs: elapsed(),
                  config,
                });
                return;
              }
              if (ticks === config.count) {
                send('done', { runId, count: ticks, emittedMs: elapsed() });
                cleanup();
                streamController.close();
                return;
              }

              if (ticks === 1 && config.scenario !== 'steady') {
                const idleEnd = lastTickMs + config.idleMs;
                if (config.scenario === 'heartbeat') {
                  const heartbeatAt =
                    Math.max(lastTickMs, lastHeartbeatMs) + config.heartbeatMs;
                  if (heartbeatAt < idleEnd && elapsed() < idleEnd) {
                    await waitUntil(heartbeatAt);
                    if (finished) return;
                    // A delayed consumer may resume after the pause. Do not emit a
                    // backlog of scheduled heartbeats with fictitious timestamps.
                    if (elapsed() < idleEnd) {
                      lastHeartbeatMs = elapsed();
                      send('heartbeat', {
                        runId,
                        seq: ticks,
                        emittedMs: lastHeartbeatMs,
                      });
                      return;
                    }
                  }
                }
                await waitUntil(idleEnd);
              } else if (ticks > 0) {
                await waitUntil(lastTickMs + config.intervalMs);
              }
              if (finished) return;
              ticks += 1;
              lastTickMs = elapsed();
              send('tick', { runId, seq: ticks, emittedMs: lastTickMs });
            } catch (error) {
              cleanup();
              throw error;
            }
          },
          cancel() {
            cleanup();
          },
        },
        { highWaterMark: 1 },
      );

      return new Response(body, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      // A synchronous start/constructor/Response failure must release the same
      // resources as cancellation. No response is returned to cancel for us.
      cleanup();
      throw error;
    }
  };
}
