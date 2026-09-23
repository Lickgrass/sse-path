import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { SseParser, ProtocolCollector, MAX_FRAME } from '../dist/protocol.js';

test('SSE framing supports split CRLF, CR, multiline data, comments, and UTF-8 fragments', () => {
  const bytes = Buffer.from(
    ': keepalive\r\nevent: tick\r\ndata: one\r\ndata: two\r\n\r\n' +
      'event: tick\rdata: café 🛰\r\r',
  );
  for (let split = 0; split <= bytes.length; split++) {
    const events = [];
    const parser = new SseParser((event, data) => events.push([event, data]));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    parser.push(decoder.decode(bytes.subarray(0, split), { stream: true }));
    parser.push(decoder.decode(bytes.subarray(split), { stream: true }));
    parser.push(decoder.decode());
    assert.deepEqual(events, [
      ['tick', 'one\ntwo'],
      ['tick', 'café 🛰'],
    ]);
  }
});

test('unterminated SSE data is not dispatched and frames are bounded', () => {
  const parser = new SseParser(() => assert.fail('Not a complete frame'));
  parser.push('data: incomplete');
  assert.throws(() => parser.push('a'.repeat(MAX_FRAME)), /limit/);
});

test('discarded keepalives and unknown fields do not accumulate against an event limit', () => {
  const events = [];
  const parser = new SseParser((event, data) => events.push([event, data]));
  parser.push(': ping\n'.repeat(MAX_FRAME));
  parser.push('event: tick\r');
  parser.push('\ndata: one\r');
  for (let index = 0; index < MAX_FRAME; index++) {
    // Split CRLF boundaries must not introduce an empty line and dispatch early.
    parser.push('\n: keepalive\r');
  }
  parser.push('\n');
  parser.push('ignored: discarded\n'.repeat(MAX_FRAME));
  assert.deepEqual(events, []);
  parser.push('data: two\n\n');
  assert.deepEqual(events, [['tick', 'one\ntwo']]);
});

test('interleaved comments cannot bypass the retained event-data limit', () => {
  const parser = new SseParser(() => assert.fail('Oversized event dispatched'));
  parser.push(`data: ${'a'.repeat(MAX_FRAME / 2)}\n: ping\n`);
  assert.throws(
    () => parser.push(`data: ${'b'.repeat(MAX_FRAME / 2)}\n`),
    /limit/,
  );
});

test('empty data fields remain bounded even with discarded lines between them', () => {
  const parser = new SseParser(() => assert.fail('Oversized event dispatched'));
  assert.throws(
    () => parser.push('data:\n: ping\n'.repeat(MAX_FRAME + 1)),
    /limit/,
  );
});

test('single comment and unknown-field lines are still bounded in UTF-8 bytes', () => {
  for (const prefix of [': ', 'ignored: ']) {
    const parser = new SseParser(() => assert.fail('No data'));
    assert.throws(
      () => parser.push(prefix + 'é'.repeat(MAX_FRAME / 2)),
      /limit/,
    );
  }
});

test('retained event names and multiline data share a UTF-8 byte bound', () => {
  const parser = new SseParser(() => assert.fail('Oversized event dispatched'));
  parser.push(`event: ${'é'.repeat(MAX_FRAME / 4)}\n`);
  assert.throws(
    () => parser.push(`data: ${'é'.repeat(MAX_FRAME / 4)}\n`),
    /limit/,
  );
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
