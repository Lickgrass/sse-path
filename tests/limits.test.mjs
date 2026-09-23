import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticRoute } from '../dist/route.js';
import { parseConfig } from '../dist/protocol.js';
import { validateProbeInput } from '../dist/input.js';
import { LIMITS, scheduledDuration } from '../dist/limits.js';
import { InputError } from '../dist/errors.js';

test('route and probe use the same bounded bearer-token alphabet', async () => {
  for (const token of [
    'a'.repeat(32),
    'A+/_-.~09'.repeat(5) + '==',
    'a'.repeat(512),
  ]) {
    const handler = createDiagnosticRoute({ token });
    assert.doesNotThrow(() =>
      validateProbeInput('http://127.0.0.1/probe', { token }),
    );
    const response = handler(
      new Request('http://127.0.0.1/probe', {
        headers: { authorization: 'Bearer ' + token },
      }),
    );
    assert.equal(response.status, 200);
    await response.body.cancel();
  }
  for (const token of [
    'a'.repeat(31),
    'a'.repeat(513),
    'a'.repeat(32) + '!',
    'a'.repeat(32) + '\n',
    '=bad'.repeat(10),
  ]) {
    assert.throws(() => createDiagnosticRoute({ token }), InputError);
    assert.throws(
      () => validateProbeInput('http://127.0.0.1/probe', { token }),
      InputError,
    );
  }
});

test('shared schedule validation has identical route and wire boundaries', () => {
  const token = 'a'.repeat(32);
  const baseline = {
    scenario: 'steady',
    count: 3,
    intervalMs: 100,
    idleMs: 500,
    heartbeatMs: 100,
  };
  for (const key of ['count', 'intervalMs', 'idleMs', 'heartbeatMs']) {
    for (const value of [LIMITS[key].min - 1, LIMITS[key].max + 1]) {
      const config = { ...baseline, [key]: value };
      assert.throws(() => createDiagnosticRoute({ ...config, token }));
      assert.throws(() => parseConfig(config));
    }
  }
  assert.equal(scheduledDuration(baseline), 200);
  assert.equal(scheduledDuration({ ...baseline, scenario: 'idle' }), 600);
  for (const options of [
    { timeoutMs: 99 },
    { timeoutMs: 120001 },
    { maxDeliveryLagMs: 0 },
    { maxDeliveryLagMs: 30001 },
  ]) {
    assert.throws(
      () => validateProbeInput('https://example.com', options),
      InputError,
    );
  }
});
