import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalFixture, LOCAL_TOKEN } from '../examples/local-demo.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function cli(args, token = LOCAL_TOKEN) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, SSE_PATH_TOKEN: token, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.setEncoding('utf8').on('data', (data) => {
      stdout += data;
    });
    child.stderr.setEncoding('utf8').on('data', (data) => {
      stderr += data;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('CLI produces private reports and inspects/compares actual before and after captures', async () => {
  const fixture = await createLocalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'sse-path-cli-'));
  const beforeFile = join(directory, 'before.json');
  const afterFile = join(directory, 'after.json');
  const args = (file) => [
    'probe',
    fixture.url,
    '--allow-http',
    '--timeout-ms',
    '5000',
    '--max-delivery-lag-ms',
    '120',
    '--out',
    file,
    '--json',
  ];
  try {
    fixture.setMode('buffer');
    const before = await cli(args(beforeFile));
    assert.equal(before.signal, null);
    assert.notEqual(before.code, 0);
    assert.equal(JSON.parse(before.stdout).status, 'failed');

    fixture.setMode('pass');
    const after = await cli(args(afterFile));
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).status, 'passed');
    const report = JSON.parse(await readFile(afterFile, 'utf8'));
    assert.equal(report.status, 'passed');
    if (process.platform !== 'win32')
      assert.equal((await stat(afterFile)).mode & 0o777, 0o600);

    const inspected = await cli(['inspect', afterFile, '--json']);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).runId, report.runId);

    const compared = await cli(['compare', beforeFile, afterFile, '--json']);
    assert.equal(compared.code, 0, compared.stderr);
    assert.equal(JSON.parse(compared.stdout).status, 'verified');
    for (const result of [before, after, inspected, compared]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(LOCAL_TOKEN));
    }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI bounds silent responses and rejects malformed report files', async () => {
  const fixture = await createLocalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'sse-path-invalid-'));
  try {
    fixture.setMode('silent');
    const result = await cli([
      'probe',
      fixture.url,
      '--allow-http',
      '--timeout-ms',
      '400',
      '--json',
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).termination, 'timeout');
    const file = join(directory, 'invalid.json');
    await writeFile(file, '{"schemaVersion":1,"status":"passed"}');
    const invalid = await cli(['inspect', file]);
    assert.notEqual(invalid.code, 0);
    assert.ok(invalid.stderr.length > 0);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI refuses a token argument and does not echo supplied secrets', async () => {
  const secret = 'never-print-me-0123456789abcdef';
  const result = await cli([
    'probe',
    'https://example.invalid/diagnostic',
    '--token',
    secret,
  ]);
  assert.notEqual(result.code, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test('CLI preserves existing output and refuses symlink inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sse-path-files-'));
  try {
    const file = join(directory, 'existing.json');
    const content = 'existing evidence must survive';
    await writeFile(file, content);
    const existing = await cli([
      'probe',
      'https://example.invalid/diagnostic',
      '--out',
      file,
    ]);
    assert.equal(existing.code, 2);
    assert.match(existing.stderr, /Cannot create report/);
    assert.equal(await readFile(file, 'utf8'), content);
    if (process.platform !== 'win32') {
      const link = join(directory, 'symlink.json');
      await symlink(file, link);
      const input = await cli(['inspect', link]);
      assert.equal(input.code, 2);
      assert.match(input.stderr, /non-symlink/);
      const output = await cli([
        'probe',
        'https://example.invalid/diagnostic',
        '--out',
        link,
      ]);
      assert.equal(output.code, 2);
      assert.equal(await readFile(file, 'utf8'), content);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid probe inputs leave no output file and permit a valid retry', async () => {
  const fixture = await createLocalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'sse-path-validation-'));
  const file = join(directory, 'report.json');
  const secret = 'secret-marker-that-must-never-appear';
  try {
    const cases = [
      { url: 'not-a-url-' + secret, message: /valid HTTP\(S\) endpoint/ },
      {
        url: 'ftp://example.invalid/' + secret,
        message: /Use HTTPS or loopback HTTP/,
      },
      {
        url: 'http://example.invalid/' + secret,
        message: /remote HTTP requires --allow-http/,
      },
      {
        url: 'https://user:' + secret + '@example.invalid/',
        message: /credentials and fragments are forbidden/,
      },
      {
        url: fixture.url,
        token: secret + '!',
        message: /RFC 6750 bearer-token characters/,
      },
      {
        url: fixture.url,
        options: ['--timeout-ms', '99'],
        message: /timeoutMs must be/,
      },
      {
        url: fixture.url,
        options: ['--max-delivery-lag-ms', '30001'],
        message: /maxDeliveryLagMs must be/,
      },
    ];
    for (const entry of cases) {
      const result = await cli(
        ['probe', entry.url, '--out', file, ...(entry.options ?? [])],
        entry.token ?? LOCAL_TOKEN,
      );
      assert.equal(result.code, 2);
      assert.match(result.stderr, entry.message);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      await assert.rejects(stat(file), { code: 'ENOENT' });
    }
    const result = await cli([
      'probe',
      fixture.url,
      '--out',
      file,
      '--timeout-ms',
      '5000',
      '--max-delivery-lag-ms',
      '120',
      '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'passed');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('subcommands accept help without requiring input or credentials', async () => {
  for (const command of ['probe', 'inspect', 'compare']) {
    for (const flag of ['--help', '-h']) {
      const result = await cli([command, flag], 'invalid!');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /sse-path probe URL/);
      assert.equal(result.stderr, '');
    }
  }
});

test('report validation errors are useful without reflecting report content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sse-path-report-error-'));
  const file = join(directory, 'invalid.json');
  const secret = 'do-not-print-report-content';
  try {
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 999, token: secret }),
    );
    const result = await cli(['inspect', file]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Invalid or unsupported report/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
