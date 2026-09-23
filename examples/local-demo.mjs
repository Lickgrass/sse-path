import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  probe,
  compareReports,
  formatReport,
  formatComparison,
} from '../dist/index.js';
import { createDiagnosticRoute } from '../dist/route.js';

// This token protects synthetic localhost traffic only. Never use it in a deployment.
export const LOCAL_TOKEN = 'local-synthetic-fixture-only-0123456789abcdef';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  if (!server.listening) return;
  const done = new Promise((resolveClose) => server.close(resolveClose));
  server.closeAllConnections();
  await done;
}

/**
 * Local-only fixture: real HTTP forwarding with deliberately injected faults.
 * A fetch Response must be canceled when its downstream client disconnects,
 * otherwise an abandoned diagnostic stream could keep producing events.
 */
export async function createLocalFixture(options = {}) {
  const route = createDiagnosticRoute({
    token: LOCAL_TOKEN,
    count: 6,
    intervalMs: 100,
    idleMs: 600,
    heartbeatMs: 60,
    ...options,
  });
  let mode = 'pass';
  let destinationHits = 0;
  const active = new Set();

  async function forward(res, response, aborter, fault = 'pass') {
    let reader;
    let idleTimer;
    let interruptionTimer;
    const cancel = () => {
      clearTimeout(idleTimer);
      clearTimeout(interruptionTimer);
      aborter.abort();
      if (reader) void reader.cancel().catch(() => {});
    };
    active.add(cancel);
    res.on('close', cancel);
    try {
      res.statusCode = response.status;
      for (const [name, value] of response.headers) {
        if (
          !['connection', 'transfer-encoding', 'content-length'].includes(name)
        ) {
          res.setHeader(name, value);
        }
      }
      res.flushHeaders();
      if (!response.body) {
        res.end();
        return;
      }
      reader = response.body.getReader();
      const buffered = [];
      let accumulated = '';
      const resetIdle = () => {
        if (fault !== 'idle-timeout') return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => res.destroy(), 220);
      };
      resetIdle();
      while (!aborter.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        if (fault === 'buffer') {
          buffered.push(value);
          continue;
        }
        res.write(value);
        if (
          (fault === 'interrupt' || fault === 'truncate') &&
          !interruptionTimer
        ) {
          accumulated += new TextDecoder().decode(value);
          if (accumulated.includes('event: tick')) {
            if (fault === 'truncate') {
              res.end();
              break;
            }
            interruptionTimer = setTimeout(() => res.destroy(), 25);
          }
        }
      }
      if (!res.destroyed) {
        for (const chunk of buffered) res.write(chunk);
        res.end();
      }
    } catch {
      if (!res.destroyed) res.destroy();
    } finally {
      cancel();
      active.delete(cancel);
      res.off('close', cancel);
    }
  }

  let originUrl;
  const origin = createServer(async (req, res) => {
    const aborter = new AbortController();
    const abort = () => aborter.abort();
    res.once('close', abort);
    try {
      const request = new Request(`${originUrl}${req.url}`, {
        method: req.method,
        headers: req.headers,
        signal: aborter.signal,
      });
      const response = await route(request);
      await forward(res, response, aborter);
    } catch {
      res.destroy();
    } finally {
      res.off('close', abort);
    }
  });
  originUrl = await listen(origin);
  const proxy = createServer(async (req, res) => {
    const fault = mode;
    if (req.url === '/redirect-target') destinationHits += 1;
    if (fault === 'redirect' && req.url !== '/redirect-target') {
      res.writeHead(302, { location: '/redirect-target' });
      res.end();
      return;
    }
    if (fault === 'silent') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      return;
    }
    const aborter = new AbortController();
    const abort = () => aborter.abort();
    res.once('close', abort);
    try {
      const headers = {};
      if (req.headers.authorization)
        headers.authorization = req.headers.authorization;
      const response = await fetch(`${originUrl}/diagnostic`, {
        headers,
        redirect: 'manual',
        signal: aborter.signal,
      });
      await forward(res, response, aborter, fault);
    } catch {
      res.destroy();
    } finally {
      res.off('close', abort);
    }
  });
  let proxyUrl;
  try {
    proxyUrl = await listen(proxy);
  } catch (error) {
    await stop(origin);
    throw error;
  }
  return {
    url: `${proxyUrl}/diagnostic`,
    originUrl: `${originUrl}/diagnostic`,
    setMode(nextMode) {
      if (
        ![
          'pass',
          'buffer',
          'interrupt',
          'truncate',
          'idle-timeout',
          'silent',
          'redirect',
        ].includes(nextMode)
      ) {
        throw new Error('Unknown local fixture mode');
      }
      mode = nextMode;
    },
    get destinationHits() {
      return destinationHits;
    },
    async close() {
      for (const cancel of active) cancel();
      await Promise.all([stop(proxy), stop(origin)]);
    },
  };
}

async function main() {
  if (process.argv.length > 3)
    throw new Error('Usage: node examples/local-demo.mjs [output-directory]');
  const parent = resolve(process.argv[2] ?? 'demo-reports');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'local-'));
  const options = {
    token: LOCAL_TOKEN,
    allowHttp: true,
    timeoutMs: 5000,
    maxDeliveryLagMs: 120,
  };
  const fixture = await createLocalFixture();
  async function save(name, report) {
    await writeFile(
      join(directory, `${name}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(
    'SSE Path — real local HTTP traffic, synthetic diagnostic events.',
  );
  console.log('This fixture does not test a live hosting provider.\n');
  try {
    console.log('1. Healthy delivery');
    const healthy = await probe(fixture.url, options);
    assert.equal(healthy.status, 'passed');
    console.log(formatReport(healthy));
    await save('healthy', healthy);

    console.log('\n2. A local proxy now buffers the entire response');
    fixture.setMode('buffer');
    const before = await probe(fixture.url, options);
    assert.equal(before.status, 'failed');
    console.log(formatReport(before));
    await save('before', before);

    console.log(
      '\n3. Disable buffering and capture a fresh run on the same URL',
    );
    fixture.setMode('pass');
    const after = await probe(fixture.url, options);
    assert.equal(after.status, 'passed');
    console.log(formatReport(after));
    await save('after', after);
    const comparison = compareReports(before, after);
    assert.equal(comparison.status, 'verified');
    console.log(formatComparison(comparison));
    await save('comparison', comparison);

    console.log('\n4. A connection interruption must not count as success');
    fixture.setMode('interrupt');
    const interrupted = await probe(fixture.url, options);
    assert.notEqual(interrupted.status, 'passed');
    console.log(formatReport(interrupted));
    await save('interrupted', interrupted);
  } finally {
    await fixture.close();
  }

  for (const scenario of ['idle', 'heartbeat']) {
    const idleFixture = await createLocalFixture({ scenario });
    idleFixture.setMode('idle-timeout');
    try {
      console.log(
        `\n${scenario === 'idle' ? '5. Idle gap' : '6. Heartbeat traffic'} through a proxy with a 220 ms idle timeout`,
      );
      const report = await probe(idleFixture.url, options);
      if (scenario === 'idle') assert.notEqual(report.status, 'passed');
      else assert.equal(report.status, 'passed');
      console.log(formatReport(report));
      await save(scenario, report);
    } finally {
      await idleFixture.close();
    }
  }
  console.log(`\nSynthetic reports saved to ${directory}`);
  console.log(
    'The tool establishes observed delivery behavior, not which production layer caused it.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Local demo failed');
    process.exitCode = 1;
  });
}
