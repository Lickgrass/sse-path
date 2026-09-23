import {
  LIMITS,
  isRecord,
  numberIn,
  validateConfig as parseConfig,
} from './limits.js';
import type { Observation, StartEvent } from './types.js';

export {
  isRecord,
  numberIn,
  integerIn,
  validateConfig as parseConfig,
} from './limits.js';
export const MAX_EVENTS = LIMITS.maxEvents;
export const MAX_BYTES = LIMITS.maxBytes;
export const MAX_FRAME = LIMITS.maxFrameBytes;
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
  private lineBytes = 0;
  private data: string[] = [];
  private dataBytes = 0;
  private event = '';
  private eventBytes = 0;
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
      if (ch === '\r' || ch === '\n') {
        this.consumeLine();
        this.afterCr = ch === '\r';
      } else {
        this.lineBytes += Buffer.byteLength(ch, 'utf8');
        if (this.lineBytes > MAX_FRAME)
          throw new Error('SSE frame limit exceeded.');
        this.line += ch;
      }
    }
  }
  private consumeLine(): void {
    const line = this.line;
    this.line = '';
    this.lineBytes = 0;
    if (line === '') {
      const event = this.event || 'message';
      const data = this.data.join('\n');
      const hasData = this.data.length > 0;
      this.event = '';
      this.data = [];
      this.eventBytes = 0;
      this.dataBytes = 0;
      if (hasData) this.dispatch(event, data);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const key = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') {
      // Include one separator byte per field so even empty data lines are bounded.
      const bytes = Buffer.byteLength(value, 'utf8') + 1;
      if (this.dataBytes + bytes + this.eventBytes > MAX_FRAME)
        throw new Error('SSE frame limit exceeded.');
      this.dataBytes += bytes;
      this.data.push(value);
    }
    if (key === 'event') {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (this.dataBytes + bytes > MAX_FRAME)
        throw new Error('SSE frame limit exceeded.');
      this.eventBytes = bytes;
      this.event = value;
    }
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
      !numberIn(v.emittedMs, 0, LIMITS.emittedMs)
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
