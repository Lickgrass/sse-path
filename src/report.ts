import type { Comparison, Finding, Observation, Report } from './types.js';
import {
  integerIn,
  isRecord,
  MAX_EVENTS,
  numberIn,
  parseConfig,
  validRunId,
} from './protocol.js';

const coverage = [
  'Measures this controlled diagnostic route and this CLI client, not browser rendering or arbitrary application streams.',
  'Emission timestamps describe server-side enqueue calls. They do not prove that bytes left the server socket at that instant.',
  'Relative timing does not require synchronized clocks. Delivery aggregation does not identify the responsible middleware, proxy, network, or client.',
  'Passing applies only to this route, configuration, connection, duration, and time of measurement. It is not a hosting certification.',
  'Reports retain synthetic timing metadata only. They are local evidence, not signed attestations.',
];

export function analyzeReport(report: Report): Report {
  const o = report.observations;
  const first = o[0];
  const last = o.at(-1);
  let minimumOffset = Infinity;
  let maxCatchUp = 0;
  let maxGap = 0;
  for (let i = 0; i < o.length; i++) {
    const item = o[i]!;
    const offset = item.emittedMs - item.receivedMs;
    minimumOffset = Math.min(minimumOffset, offset);
    maxCatchUp = Math.max(maxCatchUp, offset - minimumOffset);
    if (i > 0)
      maxGap = Math.max(maxGap, item.receivedMs - o[i - 1]!.receivedMs);
  }
  const emissionSpan = first && last ? last.emittedMs - first.emittedMs : null;
  const arrivalSpan = first && last ? last.receivedMs - first.receivedMs : null;
  report.metrics = {
    firstEventMs: first?.receivedMs ?? null,
    emissionSpanMs: emissionSpan,
    arrivalSpanMs: arrivalSpan,
    maxCatchUpMs: first ? Math.max(0, maxCatchUp) : null,
    maxArrivalGapMs: first ? maxGap : null,
  };
  const findings: Finding[] = [];
  const add = (id: string, status: Finding['status'], summary: string) =>
    findings.push({ id, status, summary });
  const complete = report.termination === 'complete';
  add(
    'http-response',
    report.httpStatus === 200
      ? 'pass'
      : report.httpStatus === null
        ? 'unknown'
        : 'fail',
    report.httpStatus === 200
      ? 'Endpoint returned HTTP 200; completion is checked separately.'
      : report.httpStatus === null
        ? 'No HTTP response was observed.'
        : 'Endpoint did not return the expected HTTP 200 response.',
  );
  add(
    'diagnostic-protocol',
    complete
      ? 'pass'
      : ['invalid-stream', 'limit'].includes(report.termination)
        ? 'fail'
        : 'unknown',
    complete
      ? 'Received a valid, ordered diagnostic sequence with an explicit completion event.'
      : 'A complete valid diagnostic sequence was not observed. Use an sse-path route, not an arbitrary SSE endpoint.',
  );
  add(
    'completion',
    complete ? 'pass' : report.termination === 'aborted' ? 'unknown' : 'fail',
    complete
      ? 'The declared event count and completion marker arrived within the probe deadline.'
      : report.termination === 'aborted'
        ? 'The caller cancelled this measurement.'
        : 'The diagnostic did not complete within the probe contract. Termination: ' +
          report.termination +
          '.',
  );

  // A diagnostic must actually exercise the declared schedule. A late done
  // marker alone cannot turn unspaced ticks into evidence of streaming.
  const ticks = o.filter((item) => item.kind === 'tick');
  const config = report.config;
  const tickSpan =
    ticks.length > 1 ? ticks.at(-1)!.emittedMs - ticks[0]!.emittedMs : 0;
  let cadence = complete && config !== null && ticks.length === config.count;
  if (config && cadence) {
    for (let i = 1; i < ticks.length; i++) {
      const expected =
        i === 1 && config.scenario !== 'steady'
          ? config.idleMs
          : config.intervalMs;
      const actual = ticks[i]!.emittedMs - ticks[i - 1]!.emittedMs;
      if (
        actual < expected - Math.max(5, expected * 0.1) ||
        actual > expected + Math.max(100, expected * 0.25)
      )
        cadence = false;
    }
    if (config.scenario === 'heartbeat' && config.idleMs > config.heartbeatMs) {
      const pause = o.filter(
        (item) =>
          item.emittedMs >= ticks[0]!.emittedMs &&
          item.emittedMs <= ticks[1]!.emittedMs &&
          item.kind !== 'start' &&
          item.kind !== 'done',
      );
      if (!pause.some((item) => item.kind === 'heartbeat')) cadence = false;
      for (let i = 1; i < pause.length; i++) {
        if (
          pause[i]!.emittedMs - pause[i - 1]!.emittedMs >
          config.heartbeatMs + Math.max(50, config.heartbeatMs * 0.25)
        )
          cadence = false;
      }
    }
  }
  add(
    'source-cadence',
    cadence ? 'pass' : 'unknown',
    cadence
      ? 'Source ticks and heartbeat cadence exercised the declared schedule within scheduling tolerance.'
      : 'Source timing did not establish the declared schedule. Check source load, backpressure, and fixture configuration.',
  );
  const sufficient = tickSpan >= report.policy.maxDeliveryLagMs * 2;
  if (!complete || !sufficient || !cadence) {
    add(
      'incremental-delivery',
      'unknown',
      !complete
        ? 'Delivery timing is incomplete; no passing delivery claim is made.'
        : !cadence
          ? 'The source did not exercise the configured timing scenario; delivery cannot be certified.'
          : 'The source tick span is too short for this tolerance. Increase count, interval, or idle duration.',
    );
  } else if (maxCatchUp > report.policy.maxDeliveryLagMs) {
    add(
      'incremental-delivery',
      'fail',
      'Events arrived closer together than they were enqueued: delivery aggregation exceeded the allowed tolerance. The responsible layer is unknown.',
    );
  } else {
    add(
      'incremental-delivery',
      'pass',
      'No delivery aggregation beyond the configured tolerance was observed in this run. Constant delay is not excluded.',
    );
  }
  report.findings = findings;
  report.status = findings.some((f) => f.status === 'fail')
    ? 'failed'
    : findings.some((f) => f.status === 'unknown')
      ? 'inconclusive'
      : 'passed';
  report.coverage = [...coverage];
  return report;
}

/** Validate bounded imported evidence and recompute all conclusions; never trust stored verdicts. */
export function validateReport(value: unknown): Report {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.toolVersion !== '0.1.0' ||
    typeof value.targetId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.targetId) ||
    typeof value.startedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !(value.runId === null || validRunId(value.runId)) ||
    !isRecord(value.policy) ||
    !integerIn(value.policy.timeoutMs, 100, 120000) ||
    !integerIn(value.policy.maxDeliveryLagMs, 1, 30000) ||
    typeof value.termination !== 'string' ||
    ![
      'complete',
      'eof',
      'timeout',
      'aborted',
      'network-error',
      'http-error',
      'invalid-stream',
      'limit',
    ].includes(value.termination) ||
    !(value.httpStatus === null || integerIn(value.httpStatus, 100, 599)) ||
    !Array.isArray(value.observations) ||
    value.observations.length > MAX_EVENTS
  )
    throw new Error('Invalid report.');
  const config = value.config === null ? null : parseConfig(value.config);
  if ((config === null) !== (value.runId === null))
    throw new Error('Invalid report context.');
  let ticks = 0;
  let done = false;
  const observations: Observation[] = [];
  for (const raw of value.observations) {
    if (
      !isRecord(raw) ||
      typeof raw.kind !== 'string' ||
      !['start', 'tick', 'heartbeat', 'done'].includes(raw.kind) ||
      !numberIn(raw.emittedMs, 0, 120000) ||
      !numberIn(raw.receivedMs, 0, 600000) ||
      !config ||
      done
    )
      throw new Error('Invalid observation.');
    const previous = observations.at(-1);
    if (
      previous &&
      (raw.emittedMs < previous.emittedMs ||
        raw.receivedMs < previous.receivedMs)
    )
      throw new Error('Nonmonotonic report.');
    if (!previous) {
      if (raw.kind !== 'start') throw new Error('Missing start.');
    } else if (raw.kind === 'tick') {
      if (raw.seq !== ++ticks || ticks > config.count)
        throw new Error('Invalid sequence.');
    } else if (raw.kind === 'heartbeat') {
      if (config.scenario !== 'heartbeat' || ticks !== 1 || raw.seq !== ticks)
        throw new Error('Invalid heartbeat.');
    } else if (raw.kind === 'done') {
      if (ticks !== config.count) throw new Error('Incomplete report.');
      done = true;
    } else throw new Error('Repeated start.');
    const item: Observation = {
      kind: raw.kind as Observation['kind'],
      emittedMs: raw.emittedMs,
      receivedMs: raw.receivedMs,
    };
    if (raw.kind === 'tick' || raw.kind === 'heartbeat')
      item.seq = raw.seq as number;
    observations.push(item);
  }
  if (
    (value.termination === 'complete' &&
      observations.some(
        (o) => o.receivedMs > (value.policy as { timeoutMs: number }).timeoutMs,
      )) ||
    (config !== null && observations.length === 0) ||
    (value.termination === 'complete' && (!done || value.httpStatus !== 200)) ||
    (done &&
      !['complete', 'invalid-stream', 'limit'].includes(
        String(value.termination),
      ))
  )
    throw new Error('Inconsistent completion.');
  const report: Report = {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    targetId: value.targetId,
    runId: value.runId as string | null,
    startedAt: value.startedAt,
    config,
    policy: {
      timeoutMs: value.policy.timeoutMs,
      maxDeliveryLagMs: value.policy.maxDeliveryLagMs,
    },
    termination: value.termination as Report['termination'],
    httpStatus: value.httpStatus as number | null,
    observations,
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
  return analyzeReport(report);
}

export function compareReports(
  beforeInput: Report,
  afterInput: Report,
): Comparison {
  const before = validateReport(beforeInput);
  const after = validateReport(afterInput);
  const result = (
    status: Comparison['status'],
    reason: string,
    resolved: string[] = [],
  ): Comparison => ({ schemaVersion: 1, status, reason, resolved });
  if (
    before.targetId !== after.targetId ||
    !before.config ||
    !after.config ||
    JSON.stringify(before.config) !== JSON.stringify(after.config) ||
    JSON.stringify(before.policy) !== JSON.stringify(after.policy)
  ) {
    return result(
      'not-comparable',
      'Use the same endpoint, diagnostic configuration, deadline, and delivery tolerance.',
    );
  }
  if (
    before.runId === after.runId ||
    Date.parse(after.startedAt) <= Date.parse(before.startedAt)
  ) {
    return result(
      'not-comparable',
      'A later, independently captured run is required.',
    );
  }
  const failures = before.findings
    .filter((f) => f.status === 'fail')
    .map((f) => f.id);
  if (failures.length === 0)
    return result(
      'not-verified',
      'The earlier report has no confirmed failure to verify.',
    );
  const resolved = failures.filter((id) =>
    after.findings.some((f) => f.id === id && f.status === 'pass'),
  );
  if (after.status !== 'passed' || resolved.length !== failures.length) {
    return result(
      'not-verified',
      'The later run has remaining failures or incomplete evidence.',
      resolved,
    );
  }
  return result(
    'verified',
    'Earlier failures passed in a fresh comparable diagnostic run. This verifies the tested route and conditions, not an entire application or hosting provider.',
    resolved,
  );
}

export function formatReport(input: Report): string {
  const report = validateReport(input);
  const lines = [
    'SSE Path 0.1.0 — controlled route delivery',
    '',
    report.status.toUpperCase() + ' · termination: ' + report.termination,
  ];
  for (const f of report.findings)
    lines.push(`${f.status.toUpperCase()} ${f.id}: ${f.summary}`);
  lines.push('', `Delivery tolerance: ${report.policy.maxDeliveryLagMs} ms`);
  const display = (n: number | null) =>
    n === null ? 'unknown' : n.toFixed(1) + ' ms';
  lines.push(
    'Source emission span: ' + display(report.metrics.emissionSpanMs),
    'Client arrival span: ' + display(report.metrics.arrivalSpanMs),
    'Maximum catch-up: ' + display(report.metrics.maxCatchUpMs),
    'First event: ' + display(report.metrics.firstEventMs),
    '',
    'Scope: controlled route → CLI. The responsible buffering layer is unknown.',
  );
  return lines.join('\n') + '\n';
}
export function formatComparison(comparison: Comparison): string {
  return (
    `${comparison.status.toUpperCase()}: ${comparison.reason}\n` +
    comparison.resolved.map((id) => `Resolved: ${id}\n`).join('')
  );
}
