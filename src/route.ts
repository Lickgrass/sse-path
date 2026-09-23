import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ProbeConfig, RouteOptions } from './types.js';

const encoder = new TextEncoder();
const MAX_SCHEDULE_MS = 60_000;
// A stalled consumer must not hold a concurrency slot indefinitely. The grace
// period accommodates ordinary timer jitter at the maximum configured schedule.
const MAX_LIFETIME_MS = MAX_SCHEDULE_MS + 5_000;
const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

function integer(
  name: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < min ||
    result > max
  ) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return result;
}

function normalize(options: RouteOptions): {
  config: ProbeConfig;
  maxConcurrent: number;
} {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Diagnostic route options are required.');
  }
  if (
    typeof options.token !== 'string' ||
    options.token.length < 32 ||
    options.token.length > 512 ||
    !TOKEN.test(options.token)
  ) {
    throw new TypeError(
      'token must contain 32–512 bearer-token characters; use a random deployment secret.',
    );
  }
  const scenario = options.scenario === undefined ? 'steady' : options.scenario;
  if (
    scenario !== 'steady' &&
    scenario !== 'idle' &&
    scenario !== 'heartbeat'
  ) {
    throw new TypeError('scenario must be steady, idle, or heartbeat.');
  }
  const config: ProbeConfig = {
    scenario,
    count: integer('count', options.count, 10, 2, 100),
    intervalMs: integer('intervalMs', options.intervalMs, 500, 50, 5_000),
    idleMs: integer('idleMs', options.idleMs, 3_000, 0, 30_000),
    heartbeatMs: integer('heartbeatMs', options.heartbeatMs, 500, 50, 5_000),
  };
  const duration =
    scenario === 'steady'
      ? (config.count - 1) * config.intervalMs
      : (config.count - 2) * config.intervalMs + config.idleMs;
  if (duration > MAX_SCHEDULE_MS) {
    throw new TypeError(
      'The configured emission schedule must not exceed 60000 ms.',
    );
  }
  return {
    config,
    maxConcurrent: integer('maxConcurrent', options.maxConcurrent, 4, 1, 16),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Create a temporary, authenticated SSE diagnostic route. All emitted values
 * are synthetic. The handler is compatible with the standard Request/Response
 * API, including a Next.js Node-runtime GET route.
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
    if (request.method !== 'GET') {
      return new Response('Only GET is supported.\n', {
        status: 405,
        headers: { ...staticHeaders, Allow: 'GET' },
      });
    }
    const authorization = request.headers.get('authorization') ?? '';
    const match =
      authorization.length <= 520
        ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)
        : null;
    // Fixed-size digests avoid comparing attacker-controlled buffers of
    // different lengths. Neither credentials nor request URLs are reflected.
    const valid = timingSafeEqual(tokenDigest, digest(match?.[1] ?? ''));
    if (!match || !valid) {
      return new Response('Authorization required.\n', {
        status: 401,
        headers: { ...staticHeaders, 'WWW-Authenticate': 'Bearer' },
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

    active += 1;
    const runId = randomUUID();
    const started = performance.now();
    let finished = false;
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
      active -= 1;
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

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streamController = controller;
          request.signal.addEventListener('abort', onAbort, { once: true });
          lifetimeTimer = setTimeout(
            () => fail(new Error('Diagnostic stream lifetime exceeded.')),
            MAX_LIFETIME_MS,
          );
          lifetimeTimer.unref();
          if (request.signal.aborted) onAbort();
        },
        async pull() {
          if (finished) return;
          if (!sentStart) {
            sentStart = true;
            send('start', { version: 1, runId, emittedMs: elapsed(), config });
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
  };
}
