import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateReport, compareReports, formatReport } from '../dist/index.js';

function sample(buffered = false) {
  const emissions = [0, 1, 501, 1001, 1002];
  const kinds = ['start', 'tick', 'tick', 'tick', 'done'];
  return {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    targetId: 'a'.repeat(64),
    runId: randomUUID(),
    startedAt: '2026-01-01T00:00:00.000Z',
    config: {
      scenario: 'steady',
      count: 3,
      intervalMs: 500,
      idleMs: 3000,
      heartbeatMs: 500,
    },
    policy: { timeoutMs: 15000, maxDeliveryLagMs: 200 },
    termination: 'complete',
    httpStatus: 200,
    observations: emissions.map((emittedMs, i) => ({
      kind: kinds[i],
      emittedMs,
      receivedMs: buffered ? 1010 : emittedMs + 10,
      ...(kinds[i] === 'tick' ? { seq: i } : {}),
    })),
  };
}

test('constant network delay does not look like delivery aggregation; full buffering does', () => {
  const a = sample();
  a.observations.forEach((o) => {
    o.receivedMs += 2000;
  });
  assert.equal(validateReport(a).status, 'passed');
  const b = validateReport(sample(true));
  assert.equal(b.status, 'failed');
  assert.equal(b.metrics.maxCatchUpMs, 1002);
  assert.equal(b.metrics.arrivalSpanMs, 0);
});

test('partial buffering is detected even when total arrival span matches total emission span', () => {
  const a = sample();
  a.observations[1].receivedMs = 511;
  const report = validateReport(a);
  assert.equal(report.metrics.emissionSpanMs, report.metrics.arrivalSpanMs);
  assert.equal(report.metrics.maxCatchUpMs, 500);
  assert.equal(report.status, 'failed');
});

test('timing verdict is inconclusive when the observation window is too short', () => {
  const a = sample();
  a.observations.forEach((o) => {
    o.emittedMs /= 10;
    o.receivedMs /= 10;
  });
  assert.notEqual(validateReport(a).status, 'passed');
});

test('import recomputes fake verdicts, strips arbitrary data, and rejects malformed evidence', () => {
  const a = sample(true);
  a.status = 'passed';
  a.findings = [];
  a.secret = 'dont-retain-me';
  const report = validateReport(a);
  assert.equal(report.status, 'failed');
  assert.ok(!JSON.stringify(report).includes('dont-retain-me'));
  assert.match(formatReport(report), /FAIL incremental-delivery/);
  for (const change of [
    (r) => {
      r.schemaVersion = 2;
    },
    (r) => {
      r.observations[1].seq = 99;
    },
    (r) => {
      r.observations[2].emittedMs = -1;
    },
    (r) => {
      r.observations[2].receivedMs = 0;
    },
    (r) => {
      r.observations.pop();
    },
    (r) => {
      r.httpStatus = 401;
    },
    (r) => {
      r.config.intervalMs = Infinity;
    },
    (r) => {
      r.runId = null;
    },
  ]) {
    const b = sample();
    change(b);
    assert.throws(() => validateReport(b));
  }
});

test('comparison requires same target, policy, configuration, fresh and later evidence', () => {
  const before = validateReport(sample(true));
  const after = sample();
  after.startedAt = '2026-01-01T00:00:30.000Z';
  assert.equal(
    compareReports(before, validateReport(after)).status,
    'verified',
  );
  for (const change of [
    (r) => {
      r.targetId = 'b'.repeat(64);
    },
    (r) => {
      r.policy.maxDeliveryLagMs = 5000;
    },
    (r) => {
      r.config.intervalMs = 1000;
    },
    (r) => {
      r.runId = before.runId;
    },
    (r) => {
      r.startedAt = before.startedAt;
    },
  ]) {
    const b = structuredClone(after);
    change(b);
    assert.equal(
      compareReports(before, validateReport(b)).status,
      'not-comparable',
    );
  }
  const truncated = structuredClone(after);
  truncated.observations.pop();
  truncated.termination = 'eof';
  assert.equal(
    compareReports(before, validateReport(truncated)).status,
    'not-verified',
  );
});
