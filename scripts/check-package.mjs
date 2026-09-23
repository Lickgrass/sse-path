import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: { 'out-dir': { type: 'string' } },
});
if (values['out-dir'] !== undefined) {
  assert.ok(values['out-dir'].trim().length > 0, 'Output directory is empty.');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceManifest = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
assert.equal(sourceManifest.name, '@lickgrass/sse-path');
assert.match(
  sourceManifest.version,
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
);
const npmCli = process.env.npm_execpath;
assert.ok(
  npmCli?.endsWith('.js'),
  'Run this check through npm run check:package.',
);
let createdOutput;
const temporary = await mkdtemp(join(tmpdir(), 'sse-path-package-'));
const npmConfig = join(temporary, 'npmrc');
const cache = join(temporary, 'cache');
const env = {
  ...process.env,
  npm_config_userconfig: npmConfig,
  npm_config_cache: cache,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
};

function runNpm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

try {
  await writeFile(npmConfig, '', { mode: 0o600 });
  const archiveDirectory = join(temporary, 'archive');
  const consumer = join(temporary, 'consumer');
  await mkdir(archiveDirectory);
  await mkdir(consumer);
  const packed = JSON.parse(
    runNpm(
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--offline',
        '--pack-destination',
        archiveDirectory,
      ],
      root,
    ),
  );
  assert.equal(packed.length, 1);
  const metadata = packed[0];
  assert.equal(metadata.name, '@lickgrass/sse-path');
  assert.equal(metadata.version, sourceManifest.version);
  assert.equal(
    metadata.filename,
    `${sourceManifest.name.replace(/^@/, '').replace('/', '-')}-${sourceManifest.version}.tgz`,
  );
  assert.ok(metadata.size > 0 && metadata.size < 2 * 1024 * 1024);
  assert.ok(metadata.unpackedSize < 4 * 1024 * 1024);
  assert.ok(metadata.files.length > 0 && metadata.files.length <= 100);
  const required = new Set([
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/route.js',
    'dist/route.d.ts',
    'dist/cli.js',
    'README.md',
    'LICENSE',
    'SECURITY.md',
  ]);
  for (const file of metadata.files) {
    assert.ok(
      /^(?:package\.json|README\.md|LICENSE|SECURITY\.md|CHANGELOG\.md|(?:dist|docs|examples)\/[A-Za-z0-9_./-]+)$/.test(
        file.path,
      ),
      'Package contains an unexpected file.',
    );
    assert.ok(!file.path.split('/').includes('..'));
    assert.ok(
      !/(?:^|\/)(?:node_modules|\.env|demo-reports|coverage|tests)(?:\/|$)/.test(
        file.path,
      ),
    );
    assert.ok(!/\.(?:tgz|pem|key|log)$/.test(file.path));
    required.delete(file.path);
  }
  assert.equal(
    required.size,
    0,
    'Package is missing an entry point or essential documentation.',
  );
  assert.deepEqual(await readdir(archiveDirectory), [metadata.filename]);
  const archivePath = join(archiveDirectory, metadata.filename);
  const archiveBytes = await readFile(archivePath);
  assert.equal(archiveBytes.length, metadata.size);
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'sse-path-package-smoke',
      version: '0.0.0',
      private: true,
      type: 'module',
    }),
  );
  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      join(archiveDirectory, metadata.filename),
    ],
    consumer,
  );
  const installed = join(consumer, 'node_modules', '@lickgrass', 'sse-path');
  const manifest = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, '@lickgrass/sse-path');
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.bin['sse-path'], './dist/cli.js');
  for (const kind of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    assert.equal(
      Object.keys(manifest[kind] ?? {}).length,
      0,
      `Unexpected ${kind}.`,
    );
  }
  assert.ok(
    (await readFile(join(installed, 'dist', 'cli.js'), 'utf8')).startsWith(
      '#!/usr/bin/env node',
    ),
  );
  const cli = (args) =>
    execFileSync(
      process.execPath,
      [join(installed, 'dist', 'cli.js'), ...args],
      {
        cwd: consumer,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  assert.equal(cli(['--version']).trim(), sourceManifest.version);
  assert.match(cli(['--help']), /sse-path probe URL/);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import * as core from '@lickgrass/sse-path';
    import { createDiagnosticRoute } from '@lickgrass/sse-path/route';
    for (const name of ['probe', 'compareReports', 'validateReport', 'formatReport', 'formatComparison']) {
      assert.equal(typeof core[name], 'function');
    }
    const token = 'package-smoke-synthetic-token-0123456789abcdef';
    const handler = createDiagnosticRoute({ token, count: 2, intervalMs: 50 });
    const response = handler(new Request('http://127.0.0.1/diagnostic', {
      headers: { authorization: 'Bearer ' + token },
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\\/event-stream/);
    await response.body.cancel();
  `,
    ],
    { cwd: consumer, env, encoding: 'utf8', timeout: 10_000 },
  );
  assert.ok(
    archiveBytes.equals(await readFile(archivePath)),
    'Tested archive changed during package checks.',
  );
  if (values['out-dir'] !== undefined) {
    const output = resolve(values['out-dir']);
    await mkdir(output, { mode: 0o700 });
    createdOutput = output;
    await writeFile(join(output, metadata.filename), archiveBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(output, 'metadata.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          name: metadata.name,
          version: metadata.version,
          filename: metadata.filename,
          archiveBytes: archiveBytes.length,
          sha256,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    createdOutput = undefined;
  }
  console.log(
    'Package smoke passed: isolated offline installation, CLI, exports, route, file allowlist, and zero runtime dependencies.',
  );
} finally {
  if (createdOutput !== undefined)
    await rm(createdOutput, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}
