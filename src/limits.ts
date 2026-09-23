import { InputError } from './errors.js';
import type { ProbeConfig, Report } from './types.js';

export const LIMITS = {
  count: { min: 2, max: 100, default: 10 },
  intervalMs: { min: 50, max: 5000, default: 500 },
  idleMs: { min: 0, max: 30000, default: 3000 },
  heartbeatMs: { min: 50, max: 5000, default: 500 },
  maxConcurrent: { min: 1, max: 16, default: 4 },
  timeoutMs: { min: 100, max: 120000, default: 15000 },
  maxDeliveryLagMs: { min: 1, max: 30000, default: 250 },
  token: { min: 32, max: 512 },
  scheduleMs: 60000,
  lifetimeGraceMs: 5000,
  emittedMs: 120000,
  receivedMs: 600000,
  maxEvents: 1024,
  maxBytes: 262144,
  maxFrameBytes: 16384,
  maxReportBytes: 1048576,
  maxVersionLength: 64,
} as const;
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function numberIn(v: unknown, low: number, high: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
}
export function integerIn(v: unknown, low: number, high: number): v is number {
  return numberIn(v, low, high) && Number.isSafeInteger(v);
}
export function inRange(
  v: unknown,
  range: { min: number; max: number },
): v is number {
  return integerIn(v, range.min, range.max);
}
export function validateToken(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    v.length < LIMITS.token.min ||
    v.length > LIMITS.token.max ||
    !TOKEN_PATTERN.test(v)
  )
    throw new InputError('token');
}
export function scheduledDuration(config: ProbeConfig): number {
  return config.scenario === 'steady'
    ? (config.count - 1) * config.intervalMs
    : (config.count - 2) * config.intervalMs + config.idleMs;
}
export function validateConfig(v: unknown): ProbeConfig {
  if (
    !isRecord(v) ||
    (v.scenario !== 'steady' &&
      v.scenario !== 'idle' &&
      v.scenario !== 'heartbeat') ||
    !inRange(v.count, LIMITS.count) ||
    !inRange(v.intervalMs, LIMITS.intervalMs) ||
    !inRange(v.idleMs, LIMITS.idleMs) ||
    !inRange(v.heartbeatMs, LIMITS.heartbeatMs)
  )
    throw new InputError('config');
  const config: ProbeConfig = {
    scenario: v.scenario,
    count: v.count,
    intervalMs: v.intervalMs,
    idleMs: v.idleMs,
    heartbeatMs: v.heartbeatMs,
  };
  if (scheduledDuration(config) > LIMITS.scheduleMs)
    throw new InputError('duration');
  return config;
}
export function validatePolicy(
  timeoutMs: unknown,
  maxDeliveryLagMs: unknown,
): Report['policy'] {
  if (!inRange(timeoutMs, LIMITS.timeoutMs)) throw new InputError('timeout');
  if (!inRange(maxDeliveryLagMs, LIMITS.maxDeliveryLagMs))
    throw new InputError('tolerance');
  return { timeoutMs, maxDeliveryLagMs };
}
