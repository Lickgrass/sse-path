import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDiagnosticRoute } from '../dist/route.js';

const token = 'cf7aed5e9ead580c4185b316582441f9f6c06aeae728b567';
const request = (options = {}) =>
  new Request('http://localhost/diagnostic', {
    headers: { authorization: `Bearer ${token}` },
    ...options,
  });
const route = (options = {}) =>
  createDiagnosticRoute({ token, count: 3, intervalMs: 50, ...options });
const events = (text) =>
  text
    .trim()
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      return { kind: lines[0].slice(7), ...JSON.parse(lines[1].slice(6)) };
    });

test('route requires a bounded token and valid bounded configuration', () => {
  for (const invalid of [
    undefined,
    null,
    {},
    { token: '' },
    { token: 'short' },
    { token: 'x'.repeat(513) },
    { token: 'x'.repeat(31) + '\n' },
  ]) {
    assert.throws(() => createDiagnosticRoute(invalid), TypeError);
  }
  for (const [name, values] of Object.entries({
    count: [1, 101, NaN, Infinity, 3.5, null, '3'],
    intervalMs: [49, 5001],
    idleMs: [-1, 30001],
    heartbeatMs: [49, 5001],
    maxConcurrent: [0, 17],
    scenario: ['other', null],
  })) {
    for (const value of values)
      assert.throws(
        () => route({ [name]: value }),
        TypeError,
        `${name}: ${value}`,
      );
  }
  assert.throws(() => route({ count: 100, intervalMs: 5000 }), /60000/);
  assert.throws(
    () =>
      route({ scenario: 'idle', count: 10, intervalMs: 5000, idleMs: 30000 }),
    /60000/,
  );
});

test('route rejects incorrect credentials without reflecting them or adding CORS', async () => {
  const handler = route();
  for (const authorization of [
    '',
    'Basic secret',
    'Bearer wrong',
    `Bearer ${token}x`,
    `Bearer ${'x'.repeat(10000)}`,
  ]) {
    const result = handler(
      request({
        headers: { authorization, origin: 'https://untrusted.example' },
      }),
    );
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
    assert.equal(await result.text(), 'Authorization required.\n');
  }
  const anonymousPost = handler(request({ method: 'POST', headers: {} }));
  assert.equal(anonymousPost.status, 401);
  assert.equal(anonymousPost.headers.get('allow'), null);
  assert.equal(await anonymousPost.text(), 'Authorization required.\n');
  const result = handler(request({ method: 'POST' }));
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('allow'), 'GET');
});

test('route emits real monotonic timestamps, sequential ticks and completion', async () => {
  const response = route()(request());
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'text/event-stream; charset=utf-8',
  );
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const observed = events(await response.text());
  assert.deepEqual(
    observed.map((event) => event.kind),
    ['start', 'tick', 'tick', 'tick', 'done'],
  );
  assert.equal(observed[0].version, 1);
  assert.equal(observed[0].config.scenario, 'steady');
  assert.match(observed[0].runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    observed.filter((event) => event.kind === 'tick').map((event) => event.seq),
    [1, 2, 3],
  );
  for (let i = 1; i < observed.length; i++) {
    assert.equal(observed[i].runId, observed[0].runId);
    assert.ok(observed[i].emittedMs >= observed[i - 1].emittedMs);
  }
  assert.ok(observed[3].emittedMs - observed[1].emittedMs >= 100);
  assert.equal(observed.at(-1).count, 3);
});

test('query inputs cannot change the fixed probe or appear in its output', async () => {
  const response = route({ count: 2 })(
    new Request(
      'http://localhost/diagnostic?count=100000&token=leak&text=malicious',
      {
        headers: { authorization: `Bearer ${token}` },
      },
    ),
  );
  const body = await response.text();
  assert.ok(!body.includes('malicious'));
  assert.ok(!body.includes(token));
  assert.equal(events(body)[0].config.count, 2);
});

test('idle pauses after first tick, heartbeat emits during the same pause', async () => {
  for (const scenario of ['idle', 'heartbeat']) {
    const result = events(
      await route({ scenario, count: 2, idleMs: 180, heartbeatMs: 50 })(
        request(),
      ).text(),
    );
    const ticks = result.filter((event) => event.kind === 'tick');
    assert.ok(ticks[1].emittedMs - ticks[0].emittedMs >= 180);
    const heartbeats = result.filter((event) => event.kind === 'heartbeat');
    if (scenario === 'idle') assert.equal(heartbeats.length, 0);
    else {
      assert.ok(heartbeats.length >= 1);
      for (const heartbeat of heartbeats) {
        assert.equal(heartbeat.seq, 1);
        assert.ok(heartbeat.emittedMs > ticks[0].emittedMs);
        assert.ok(heartbeat.emittedMs < ticks[1].emittedMs);
      }
    }
  }
});

test('completed and cancelled streams release their concurrency slots', async () => {
  const handler = route({ count: 2, maxConcurrent: 1 });
  const first = handler(request());
  assert.equal(handler(request()).status, 429);
  await first.body.cancel();
  const second = handler(request());
  assert.equal(second.status, 200);
  await second.text();
  const third = handler(request());
  assert.equal(third.status, 200);
  await third.body.cancel();
});

test('request abort cancels a pending timer and releases concurrency', async () => {
  const handler = route({ intervalMs: 5000, maxConcurrent: 1 });
  const controller = new AbortController();
  const response = handler(request({ signal: controller.signal }));
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  const pending = reader.read();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const next = handler(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
  assert.equal(handler(request({ signal: controller.signal })).status, 408);
});

test('consumer cancellation settles a pending pull without waiting for its timer', async () => {
  const handler = route({ intervalMs: 5000, maxConcurrent: 1 });
  const reader = handler(request()).body.getReader();
  await reader.read();
  await reader.read();
  const pending = reader.read();
  await reader.cancel();
  assert.equal((await pending).done, true);
  const response = handler(request());
  assert.equal(response.status, 200);
  await response.body.cancel();
});

test('slow consumers do not generate an unbounded queue or fictitious emissions', async () => {
  const response = route({ count: 4 })(request());
  // Only the start event can queue until a consumer reads it.
  await delay(130);
  const observed = events(await response.text());
  const ticks = observed.filter((event) => event.kind === 'tick');
  assert.ok(ticks[0].emittedMs >= 100);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].emittedMs - ticks[i - 1].emittedMs >= 50);
  }
});

test('numeric timer handles support completion and release concurrency', async () => {
  const handler = route({ count: 2, maxConcurrent: 1 });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const handles = new Map();
  let nextHandle = 1;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    const id = nextHandle++;
    handles.set(
      id,
      originalSetTimeout(() => {
        handles.delete(id);
        callback(...args);
      }, milliseconds),
    );
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const handle = handles.get(id);
    handles.delete(id);
    if (handle !== undefined) originalClearTimeout(handle);
  };
  try {
    const response = handler(request());
    assert.equal(response.status, 200);
    assert.equal(handler(request()).status, 429);
    assert.equal(events(await response.text()).at(-1).kind, 'done');
    const next = handler(request());
    assert.equal(next.status, 200);
    await next.body.cancel();
    assert.equal(handles.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const handle of handles.values()) originalClearTimeout(handle);
  }
});

test('a throwing start hook clears timers, listeners, and the concurrency slot', async () => {
  const handler = route({ maxConcurrent: 1 });
  const failedRequest = request();
  const listenersBefore = getEventListeners(
    failedRequest.signal,
    'abort',
  ).length;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const handles = new Set();
  let cleared = 0;
  globalThis.setTimeout = (...args) => {
    const handle = originalSetTimeout(...args);
    handles.add(handle);
    handle.unref = () => {
      throw new Error('Injected start failure.');
    };
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handles.delete(handle)) cleared += 1;
    originalClearTimeout(handle);
  };
  try {
    assert.throws(() => handler(failedRequest), /Injected start failure/);
    assert.equal(cleared, 1);
    assert.equal(handles.size, 0);
    assert.equal(
      getEventListeners(failedRequest.signal, 'abort').length,
      listenersBefore,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const handle of handles) originalClearTimeout(handle);
  }
  const next = handler(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('stream and Response construction failures release concurrency', async () => {
  for (const constructor of ['ReadableStream', 'Response']) {
    const handler = route({ maxConcurrent: 1 });
    const failedRequest = request();
    const listenersBefore = getEventListeners(
      failedRequest.signal,
      'abort',
    ).length;
    const Original = globalThis[constructor];
    globalThis[constructor] = class extends Original {
      constructor(...args) {
        super(...args);
        throw new Error('Injected construction failure.');
      }
    };
    try {
      assert.throws(
        () => handler(failedRequest),
        /Injected construction failure/,
      );
      assert.equal(
        getEventListeners(failedRequest.signal, 'abort').length,
        listenersBefore,
      );
    } finally {
      globalThis[constructor] = Original;
    }
    const next = handler(request());
    assert.equal(next.status, 200);
    await next.body.cancel();
  }
});

test('the lifetime watchdog releases a stalled stream and its slot', async () => {
  const handler = route({ maxConcurrent: 1 });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) =>
    originalSetTimeout(
      callback,
      milliseconds === 65000 ? 10 : milliseconds,
      ...args,
    );
  let response;
  try {
    response = handler(request());
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  // Do not read: the internally queued start frame otherwise occupies the slot.
  await delay(30);
  await assert.rejects(response.text(), /lifetime exceeded/);
  const next = handler(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});
