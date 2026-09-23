import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { probe, compareReports, validateReport } from '../dist/index.js';
import { createLocalFixture, LOCAL_TOKEN } from '../examples/local-demo.mjs';

const OPTIONS = {
  token: LOCAL_TOKEN,
  allowHttp: true,
  timeoutMs: 5000,
  maxDeliveryLagMs: 120,
};

test('actual HTTP proxy: detects buffering, then verifies a fresh repair at the same target', async () => {
  const fixture = await createLocalFixture();
  try {
    const healthy = await probe(fixture.url, OPTIONS);
    assert.equal(healthy.termination, 'complete');
    assert.equal(healthy.status, 'passed');
    assert.equal(healthy.config.count, 6);
    assert.equal(
      healthy.observations.filter((event) => event.kind === 'tick').length,
      6,
    );
    assert.ok(healthy.metrics.emissionSpanMs >= 350);

    fixture.setMode('buffer');
    const before = await probe(fixture.url, OPTIONS);
    assert.equal(before.termination, 'complete');
    assert.equal(before.status, 'failed');
    assert.ok(before.metrics.maxCatchUpMs > OPTIONS.maxDeliveryLagMs);
    assert.ok(
      before.metrics.emissionSpanMs > before.metrics.arrivalSpanMs + 250,
    );
    assert.ok(before.findings.some((finding) => finding.status === 'fail'));

    fixture.setMode('pass');
    const after = await probe(fixture.url, OPTIONS);
    assert.equal(after.status, 'passed');
    assert.notEqual(before.runId, after.runId);
    assert.equal(before.targetId, after.targetId);
    const comparison = compareReports(before, after);
    assert.equal(comparison.status, 'verified');
    assert.ok(comparison.resolved.length > 0);

    const serialized = JSON.stringify({ before, after, comparison });
    assert.ok(!serialized.includes(LOCAL_TOKEN));
    assert.ok(!serialized.includes(fixture.url));
    assert.doesNotThrow(() =>
      validateReport(JSON.parse(JSON.stringify(after))),
    );
    assert.notEqual(compareReports(after, after).status, 'verified');
  } finally {
    await fixture.close();
  }
});

test('an interrupted stream cannot pass even when HTTP status is 200', async () => {
  const fixture = await createLocalFixture();
  try {
    for (const mode of ['interrupt', 'truncate']) {
      fixture.setMode(mode);
      const report = await probe(fixture.url, OPTIONS);
      assert.equal(report.httpStatus, 200);
      assert.equal(
        report.termination,
        mode === 'truncate' ? 'eof' : 'network-error',
      );
      assert.notEqual(report.status, 'passed');
      assert.ok(report.observations.length > 0);
    }
  } finally {
    await fixture.close();
  }
});

test('a silent 200 response is bounded by the probe timeout', async () => {
  const fixture = await createLocalFixture();
  fixture.setMode('silent');
  try {
    const started = performance.now();
    const report = await probe(fixture.url, { ...OPTIONS, timeoutMs: 400 });
    assert.equal(report.termination, 'timeout');
    assert.notEqual(report.status, 'passed');
    assert.ok(performance.now() - started < 2000);
  } finally {
    await fixture.close();
  }
});

test('redirects are not followed and cannot forward the token to another path', async () => {
  const fixture = await createLocalFixture();
  fixture.setMode('redirect');
  try {
    const report = await probe(fixture.url, OPTIONS);
    assert.equal(report.httpStatus, 302);
    assert.equal(report.termination, 'http-error');
    assert.equal(fixture.destinationHits, 0);
    assert.ok(!JSON.stringify(report).includes(LOCAL_TOKEN));
  } finally {
    await fixture.close();
  }
});

test('the route rejects an invalid token without producing a diagnostic stream', async () => {
  const fixture = await createLocalFixture();
  try {
    const report = await probe(fixture.url, {
      ...OPTIONS,
      token: 'wrong-secret-0123456789abcdef0123456789',
    });
    assert.equal(report.httpStatus, 401);
    assert.equal(report.termination, 'http-error');
    assert.equal(report.runId, null);
    assert.equal(report.observations.length, 0);
  } finally {
    await fixture.close();
  }
});

test('idle and heartbeat scenarios expose idle disconnect behavior', async () => {
  for (const scenario of ['idle', 'heartbeat']) {
    const fixture = await createLocalFixture({ scenario });
    fixture.setMode('idle-timeout');
    try {
      const report = await probe(fixture.url, OPTIONS);
      if (scenario === 'idle') {
        assert.notEqual(report.termination, 'complete');
        assert.notEqual(report.status, 'passed');
      } else {
        assert.equal(report.termination, 'complete');
        assert.equal(report.status, 'passed');
        assert.ok(
          report.observations.some((event) => event.kind === 'heartbeat'),
        );
      }
    } finally {
      await fixture.close();
    }
  }
});

test('repeated downstream cancellation releases the route concurrency slot', async () => {
  const fixture = await createLocalFixture({ maxConcurrent: 1, count: 12 });
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const controller = new AbortController();
      const deadline = performance.now() + 400;
      let response;
      // Cancellation traverses two HTTP connections asynchronously. A transient
      // 429 is allowed, but a leaked slot cannot wait for the full source run.
      do {
        response = await fetch(fixture.url, {
          headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
          signal: controller.signal,
        });
        if (response.status !== 429) break;
        await response.body?.cancel();
        await delay(10);
      } while (performance.now() < deadline);
      assert.equal(
        response.status,
        200,
        `Concurrency slot leaked after cancellation ${attempt}`,
      );
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const deadline = performance.now() + 400;
    let healthy;
    do {
      healthy = await probe(fixture.url, OPTIONS);
      if (healthy.httpStatus !== 429) break;
      await delay(10);
    } while (performance.now() < deadline);
    assert.equal(healthy.status, 'passed');
    assert.equal(healthy.termination, 'complete');
  } finally {
    await fixture.close();
  }
});
