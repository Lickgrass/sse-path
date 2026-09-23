import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { probe } from '../dist/probe.js';
import { MAX_EVENTS } from '../dist/protocol.js';

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/diagnostic`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('network event-count limit bounds otherwise parseable synthetic metadata', async () => {
  const runId = 'b9478587-526f-44b3-a91f-e725e925cb61';
  const frame = (kind, value) =>
    `event: ${kind}\ndata: ${JSON.stringify({ runId, ...value })}\n\n`;
  const frames = [
    frame('start', {
      version: 1,
      emittedMs: 0,
      config: {
        scenario: 'heartbeat',
        count: 2,
        intervalMs: 50,
        idleMs: 30000,
        heartbeatMs: 50,
      },
    }),
    frame('tick', { seq: 1, emittedMs: 1 }),
    ...Array.from({ length: MAX_EVENTS }, (_, index) =>
      frame('heartbeat', { seq: 1, emittedMs: index + 2 }),
    ),
  ].join('');
  const server = await fixture((_request, response) => {
    response.on('error', () => {});
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames);
  });
  try {
    const report = await probe(server.url, { timeoutMs: 2000 });
    assert.equal(report.termination, 'invalid-stream');
    assert.equal(report.observations.length, MAX_EVENTS);
    assert.notEqual(report.status, 'passed');
  } finally {
    await server.close();
  }
});

test('caller abort interrupts a stalled HTTP body and settles promptly', async () => {
  const server = await fixture((_request, response) => {
    response.on('error', () => {});
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    const started = performance.now();
    const report = await probe(server.url, {
      timeoutMs: 10000,
      signal: controller.signal,
    });
    assert.equal(report.termination, 'aborted');
    assert.equal(report.status, 'inconclusive');
    assert.ok(performance.now() - started < 1500);
  } finally {
    clearTimeout(timer);
    await server.close();
  }
});

test('an already aborted signal never sends the authenticated request', async () => {
  let requests = 0;
  const server = await fixture((_request, response) => {
    requests += 1;
    response.end();
  });
  const controller = new AbortController();
  controller.abort();
  try {
    const report = await probe(server.url, {
      timeoutMs: 1000,
      token: 'synthetic-token-0123456789abcdef0123456789',
      signal: controller.signal,
    });
    assert.equal(report.termination, 'aborted');
    assert.notEqual(report.status, 'passed');
    assert.equal(requests, 0);
  } finally {
    await server.close();
  }
});
