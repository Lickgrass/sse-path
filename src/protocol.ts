import type { Observation, ProbeConfig, StartEvent } from './types.js';

export const MAX_EVENTS = 1024;
export const MAX_BYTES = 262144;
export const MAX_FRAME = 16384;
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function numberIn(v: unknown, low: number, high: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
}
export function integerIn(v: unknown, low: number, high: number): v is number {
  return numberIn(v, low, high) && Number.isInteger(v);
}
export function parseConfig(v: unknown): ProbeConfig {
  if (
    !isRecord(v) ||
    typeof v.scenario !== 'string' ||
    !['steady', 'idle', 'heartbeat'].includes(v.scenario) ||
    !integerIn(v.count, 2, 100) ||
    !integerIn(v.intervalMs, 50, 5000) ||
    !integerIn(v.idleMs, 0, 30000) ||
    !integerIn(v.heartbeatMs, 50, 5000)
  ) {
    throw new Error('Invalid diagnostic configuration.');
  }
  const duration =
    v.scenario === 'steady'
      ? (v.count - 1) * v.intervalMs
      : (v.count - 2) * v.intervalMs + v.idleMs;
  if (duration > 60000)
    throw new Error('Diagnostic duration exceeds the limit.');
  return {
    scenario: v.scenario as ProbeConfig['scenario'],
    count: v.count,
    intervalMs: v.intervalMs,
    idleMs: v.idleMs,
    heartbeatMs: v.heartbeatMs,
  };
}
export function validRunId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  );
}

/** Bounded incremental SSE framing; handles LF, CRLF and CR across chunk boundaries. */
export class SseParser {
  private line = '';
  private data: string[] = [];
  private event = '';
  private frameSize = 0;
  private afterCr = false;
  constructor(
    private readonly dispatch: (event: string, data: string) => void,
  ) {}
  push(text: string): void {
    for (const ch of text) {
      if (this.afterCr) {
        this.afterCr = false;
        if (ch === '\n') continue;
      }
      if (++this.frameSize > MAX_FRAME)
        throw new Error('SSE frame limit exceeded.');
      if (ch === '\r' || ch === '\n') {
        this.consumeLine();
        this.afterCr = ch === '\r';
      } else {
        this.line += ch;
      }
    }
  }
  private consumeLine(): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      const event = this.event || 'message';
      const data = this.data.join('\n');
      const hasData = this.data.length > 0;
      this.event = '';
      this.data = [];
      this.frameSize = 0;
      if (hasData) this.dispatch(event, data);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const key = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') this.data.push(value);
    if (key === 'event') this.event = value;
  }
}

export class ProtocolCollector {
  start: StartEvent | null = null;
  done = false;
  ticks = 0;
  observations: Observation[] = [];
  accept(kind: string, payload: string, receivedMs: number): void {
    if (this.done || this.observations.length >= MAX_EVENTS)
      throw new Error('Unexpected event.');
    const v: unknown = JSON.parse(payload);
    if (
      !isRecord(v) ||
      !validRunId(v.runId) ||
      !numberIn(v.emittedMs, 0, 120000)
    ) {
      throw new Error('Invalid diagnostic event.');
    }
    if (!this.start) {
      if (kind !== 'start' || v.version !== 1)
        throw new Error('Missing protocol start.');
      this.start = {
        version: 1,
        runId: v.runId,
        emittedMs: v.emittedMs,
        config: parseConfig(v.config),
      };
    } else {
      if (
        v.runId !== this.start.runId ||
        v.emittedMs < this.observations.at(-1)!.emittedMs
      ) {
        throw new Error('Inconsistent event sequence.');
      }
      if (kind === 'tick') {
        if (v.seq !== this.ticks + 1 || this.ticks >= this.start.config.count)
          throw new Error('Invalid tick sequence.');
        this.ticks++;
      } else if (kind === 'heartbeat') {
        if (
          this.start.config.scenario !== 'heartbeat' ||
          v.seq !== this.ticks ||
          this.ticks !== 1
        ) {
          throw new Error('Unexpected heartbeat.');
        }
      } else if (kind === 'done') {
        if (v.count !== this.start.config.count || this.ticks !== v.count)
          throw new Error('Incomplete event sequence.');
        this.done = true;
      } else throw new Error('Unknown diagnostic event.');
    }
    const observation: Observation = {
      kind: kind as Observation['kind'],
      emittedMs: v.emittedMs,
      receivedMs,
    };
    if (kind === 'tick' || kind === 'heartbeat')
      observation.seq = v.seq as number;
    this.observations.push(observation);
  }
}
