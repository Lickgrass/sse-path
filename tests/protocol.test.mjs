import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { SseParser, ProtocolCollector, MAX_FRAME } from '../dist/protocol.js';

test('SSE framing supports split CRLF, CR, multiline data, comments, and UTF-8 fragments', () => {
  const events = [];
  const parser = new SseParser((event, data) => events.push([event, data]));
  for (const part of [
    ': keepalive\r',
    '\nevent: tick\r',
    '\ndata: one\r\ndata: two\r',
    '\n\r',
    '\nevent: tick\rdata: café\r\r',
  ])
    parser.push(part);
  assert.deepEqual(events, [
    ['tick', 'one\ntwo'],
    ['tick', 'café'],
  ]);
});

test('unterminated SSE data is not dispatched and frames are bounded', () => {
  const parser = new SseParser(() => assert.fail('Not a complete frame'));
  parser.push('data: incomplete');
  assert.throws(() => parser.push('a'.repeat(MAX_FRAME)), /limit/);
});

const config = {
  scenario: 'steady',
  count: 3,
  intervalMs: 500,
  idleMs: 3000,
  heartbeatMs: 500,
};
test('collector rejects missing, reordered, duplicate, foreign, and post-completion events', () => {
  const runId = randomUUID();
  const c = new ProtocolCollector();
  assert.throws(() =>
    c.accept('tick', JSON.stringify({ runId, seq: 1, emittedMs: 0 }), 0),
  );
  c.accept(
    'start',
    JSON.stringify({ version: 1, runId, emittedMs: 0, config }),
    0,
  );
  assert.throws(() =>
    c.accept('tick', JSON.stringify({ runId, seq: 2, emittedMs: 2 }), 2),
  );
  assert.throws(() =>
    c.accept(
      'tick',
      JSON.stringify({ runId: randomUUID(), seq: 1, emittedMs: 2 }),
      2,
    ),
  );
  assert.throws(() =>
    c.accept('heartbeat', JSON.stringify({ runId, seq: 0, emittedMs: 2 }), 2),
  );
  for (let seq = 1; seq <= 3; seq++)
    c.accept(
      'tick',
      JSON.stringify({ runId, seq, emittedMs: seq * 500 }),
      seq * 500,
    );
  assert.throws(() =>
    c.accept(
      'done',
      JSON.stringify({ runId, count: 2, emittedMs: 1501 }),
      1501,
    ),
  );
  c.accept('done', JSON.stringify({ runId, count: 3, emittedMs: 1501 }), 1501);
  assert.throws(() =>
    c.accept(
      'done',
      JSON.stringify({ runId, count: 3, emittedMs: 1502 }),
      1502,
    ),
  );
});
