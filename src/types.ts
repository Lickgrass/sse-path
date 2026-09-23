/** Only synthetic protocol metadata is retained; no stream bodies or headers. */
export type Scenario = 'steady' | 'idle' | 'heartbeat';
export interface RouteOptions {
  scenario?: Scenario;
  count?: number;
  intervalMs?: number;
  idleMs?: number;
  heartbeatMs?: number;
  /** Required by createDiagnosticRoute. Pass a high-entropy deployment secret. */
  token: string;
  maxConcurrent?: number;
}
export interface ProbeConfig {
  scenario: Scenario;
  count: number;
  intervalMs: number;
  idleMs: number;
  heartbeatMs: number;
}
export interface StartEvent {
  version: 1;
  runId: string;
  emittedMs: number;
  config: ProbeConfig;
}
export interface TimedEvent {
  runId: string;
  emittedMs: number;
  seq: number;
}
export interface DoneEvent {
  runId: string;
  emittedMs: number;
  count: number;
}
export interface Observation {
  kind: 'start' | 'tick' | 'heartbeat' | 'done';
  emittedMs: number;
  receivedMs: number;
  seq?: number;
}
export type FindingStatus = 'pass' | 'fail' | 'unknown';
export interface Finding {
  id: string;
  status: FindingStatus;
  summary: string;
}
export interface ProbeOptions {
  token?: string;
  timeoutMs?: number;
  maxDeliveryLagMs?: number;
  allowHttp?: boolean;
  signal?: AbortSignal;
}
export type Termination =
  | 'complete'
  | 'eof'
  | 'timeout'
  | 'aborted'
  | 'network-error'
  | 'http-error'
  | 'invalid-stream'
  | 'limit';
export interface Report {
  schemaVersion: 1;
  toolVersion: string;
  targetId: string;
  runId: string | null;
  startedAt: string;
  config: ProbeConfig | null;
  policy: { timeoutMs: number; maxDeliveryLagMs: number };
  termination: Termination;
  httpStatus: number | null;
  observations: Observation[];
  metrics: {
    firstEventMs: number | null;
    emissionSpanMs: number | null;
    arrivalSpanMs: number | null;
    maxCatchUpMs: number | null;
    maxArrivalGapMs: number | null;
  };
  findings: Finding[];
  status: 'passed' | 'failed' | 'inconclusive';
  coverage: string[];
}
export interface Comparison {
  schemaVersion: 1;
  status: 'verified' | 'not-verified' | 'not-comparable';
  reason: string;
  resolved: string[];
}
