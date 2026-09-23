import { createHash } from 'node:crypto';
import { validateProbeInput } from './input.js';
import { VERSION } from './version.js';
import { analyzeReport } from './report.js';
import { MAX_BYTES, ProtocolCollector, SseParser } from './protocol.js';
import type { ProbeOptions, Report } from './types.js';

export async function probe(
  address: string,
  options: ProbeOptions = {},
): Promise<Report> {
  const { url, policy } = validateProbeInput(address, options);
  const { timeoutMs, maxDeliveryLagMs } = policy;
  const report: Report = {
    schemaVersion: 1,
    toolVersion: VERSION,
    targetId: createHash('sha256').update(url.href).digest('hex'),
    runId: null,
    startedAt: new Date().toISOString(),
    config: null,
    policy: { timeoutMs, maxDeliveryLagMs },
    termination: 'network-error',
    httpStatus: null,
    observations: [],
    metrics: {
      firstEventMs: null,
      emissionSpanMs: null,
      arrivalSpanMs: null,
      maxCatchUpMs: null,
      maxArrivalGapMs: null,
    },
    findings: [],
    status: 'inconclusive',
    coverage: [],
  };
  const began = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const collector = new ProtocolCollector();
  let receivedMs = 0;
  const parser = new SseParser((kind, data) =>
    collector.accept(kind, data, receivedMs),
  );
  try {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'cache-control': 'no-cache',
    };
    if (options.token) headers.authorization = 'Bearer ' + options.token;
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
      cache: 'no-store',
    });
    report.httpStatus = response.status;
    if (response.status !== 200) {
      report.termination = 'http-error';
      await response.body?.cancel();
    } else if (
      response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'text/event-stream' ||
      !response.body
    ) {
      report.termination = 'invalid-stream';
      await response.body?.cancel();
    } else {
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      report.termination = 'eof';
      while (true) {
        const chunk = await reader.read();
        receivedMs = performance.now() - began;
        if (receivedMs > timeoutMs) {
          report.termination = 'timeout';
          break;
        }
        if (chunk.done) {
          try {
            parser.push(decoder.decode());
          } catch {
            report.termination = 'invalid-stream';
          }
          break;
        }
        bytes += chunk.value.length;
        if (bytes > MAX_BYTES) {
          report.termination = 'limit';
          break;
        }
        try {
          parser.push(decoder.decode(chunk.value, { stream: true }));
        } catch {
          report.termination = 'invalid-stream';
          break;
        }
        if (collector.done) {
          report.termination = 'complete';
          break;
        }
      }
    }
  } catch {
    // Network exceptions may contain credentials or URL query strings. Never retain them.
    report.termination = options.signal?.aborted
      ? 'aborted'
      : timedOut
        ? 'timeout'
        : 'network-error';
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      /* aborted readers may already be closed */
    }
  }
  report.observations = collector.observations;
  report.runId = collector.start?.runId ?? null;
  report.config = collector.start?.config ?? null;
  return analyzeReport(report);
}
