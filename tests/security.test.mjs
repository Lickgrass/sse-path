import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  parseConfig,
  ProtocolCollector,
  MAX_BYTES,
  MAX_FRAME,
} from '../dist/protocol.js';
import { probe } from '../dist/probe.js';
import { validateReport } from '../dist/report.js';

const config = {
  scenario: 'steady',
  count: 3,
  intervalMs: 500,
  idleMs: 3000,
  heartbeatMs: 500,
};
const runId = '79796bbd-bcf7-4a1a-94e3-4716c19af8c2';
function report(overrides = {}) {
  return {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    targetId: 'a'.repeat(64),
    startedAt: '2026-09-23T10:00:00.000Z',
    runId,
    config,
    policy: { timeoutMs: 5000, maxDeliveryLagMs: 250 },
    termination: 'complete',
    httpStatus: 200,
    observations: [
      { kind: 'start', emittedMs: 0, receivedMs: 10 },
      { kind: 'tick', seq: 1, emittedMs: 1, receivedMs: 11 },
      { kind: 'tick', seq: 2, emittedMs: 501, receivedMs: 511 },
      { kind: 'tick', seq: 3, emittedMs: 1001, receivedMs: 1011 },
      { kind: 'done', emittedMs: 1002, receivedMs: 1012 },
    ],
    ...overrides,
  };
}

test('protocol configuration rejects string-coercible non-string scenarios', () => {
  assert.throws(() => parseConfig({ ...config, scenario: ['steady'] }));
  const collector = new ProtocolCollector();
  assert.throws(() =>
    collector.accept(
      'start',
      JSON.stringify({
        version: 1,
        runId,
        emittedMs: 0,
        config: { ...config, scenario: ['steady'] },
      }),
      0,
    ),
  );
});

test('imported completion after its declared deadline can never pass', () => {
  let imported;
  try {
    imported = validateReport(
      report({ policy: { timeoutMs: 100, maxDeliveryLagMs: 25 } }),
    );
  } catch {
    return;
  }
  assert.notEqual(imported.status, 'passed');
  assert.notEqual(
    imported.findings.find((finding) => finding.id === 'completion')?.status,
    'pass',
  );
});

test('a delayed completion marker cannot substitute for spaced source ticks', () => {
  const observations = [
    { kind: 'start', emittedMs: 0, receivedMs: 10 },
    { kind: 'tick', seq: 1, emittedMs: 1, receivedMs: 11 },
    { kind: 'tick', seq: 2, emittedMs: 2, receivedMs: 12 },
    { kind: 'tick', seq: 3, emittedMs: 3, receivedMs: 13 },
    { kind: 'done', emittedMs: 1002, receivedMs: 1012 },
  ];
  let imported;
  try {
    imported = validateReport(report({ observations }));
  } catch {
    return;
  }
  assert.notEqual(imported.status, 'passed');
  assert.notEqual(
    imported.findings.find((finding) => finding.id === 'incremental-delivery')
      ?.status,
    'pass',
  );
});

test('untrusted stored conclusions and metadata are discarded', () => {
  const imported = validateReport(
    report({
      status: 'failed',
      findings: [
        { id: 'secret', status: 'fail', summary: 'untrusted-secret-value' },
      ],
      metrics: { maxCatchUpMs: 999999 },
      coverage: ['untrusted-secret-value'],
      arbitrarySecret: 'untrusted-secret-value',
    }),
  );
  assert.equal(imported.status, 'passed');
  assert.ok(!JSON.stringify(imported).includes('untrusted-secret-value'));
});

test('hostile HTTP stream bytes are bounded, rejected, and never copied into reports', async () => {
  const bodies = [
    { body: Buffer.from([0xc3, 0x28]), termination: 'invalid-stream' },
    {
      body: `data: ${'x'.repeat(MAX_FRAME)}untrusted-secret-value\n\n`,
      termination: 'invalid-stream',
    },
    {
      body: ':x\n\n'.repeat(Math.ceil(MAX_BYTES / 4) + 1),
      termination: 'limit',
    },
    {
      body: 'event: start\ndata: {"secret":"untrusted-secret-value"}\n\n',
      termination: 'invalid-stream',
    },
  ];
  let current = bodies[0];
  const server = createServer((_request, response) => {
    response.on('error', () => {});
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(current.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    for (const sample of bodies) {
      current = sample;
      const observed = await probe(
        `http://127.0.0.1:${address.port}/untrusted-secret-value`,
        { timeoutMs: 2000 },
      );
      assert.equal(observed.termination, sample.termination);
      assert.notEqual(observed.status, 'passed');
      assert.ok(!JSON.stringify(observed).includes('untrusted-secret-value'));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
