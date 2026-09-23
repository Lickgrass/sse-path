#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  compareReports,
  formatComparison,
  formatReport,
  probe,
  validateReport,
} from './index.js';
import type { ProbeOptions, Report } from './types.js';
import { InputError } from './errors.js';
import { validateProbeInput } from './input.js';
import { LIMITS, validatePolicy } from './limits.js';
import { VERSION } from './version.js';
const HELP = `sse-path — measure incremental SSE delivery

Usage:
  sse-path probe URL [--out report.json] [--json]
      [--timeout-ms 15000] [--max-delivery-lag-ms 250] [--allow-http]
  sse-path inspect report.json [--json]
  sse-path compare before.json after.json [--json]
  sse-path --help
  sse-path --version

Probe a controlled sse-path diagnostic route, not an arbitrary SSE endpoint.
Supply its bearer token through SSE_PATH_TOKEN. Never put tokens in the URL.
Remote plain HTTP requires --allow-http; use it only on a trusted network.
Reports exclude target URLs, bearer tokens, headers, and application bodies.
--out creates a new file (0600 where supported) and never overwrites a file.

Exit codes:
  probe:   0 passed, 1 failed, 2 inconclusive or invalid input
  inspect: 0 passed, 1 failed, 2 inconclusive or invalid input
  compare: 0 verified, 1 not verified, 2 not comparable or invalid input
`;

class CliError extends Error {}

interface Arguments {
  command: 'probe' | 'inspect' | 'compare';
  positional: string[];
  json: boolean;
  out?: string;
  probeOptions: ProbeOptions;
}

function parse(args: string[]): Arguments {
  if (args.some((argument) => argument.length > 16_384)) {
    throw new CliError('Argument is too long.');
  }
  const command = args[0];
  if (command !== 'probe' && command !== 'inspect' && command !== 'compare') {
    throw new CliError(
      'Expected probe, inspect, or compare. Run sse-path --help.',
    );
  }
  const parsed: Arguments = {
    command,
    positional: [],
    json: false,
    probeOptions: {},
  };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) {
      parsed.positional.push(argument);
      continue;
    }
    if (seen.has(argument))
      throw new CliError('Duplicate option. Run sse-path --help.');
    seen.add(argument);
    if (argument === '--json') {
      parsed.json = true;
      continue;
    }
    if (command !== 'probe') {
      throw new CliError('Unknown or misplaced option. Run sse-path --help.');
    }
    if (argument === '--allow-http') {
      parsed.probeOptions.allowHttp = true;
      continue;
    }
    if (
      !['--out', '--timeout-ms', '--max-delivery-lag-ms'].includes(argument)
    ) {
      throw new CliError('Unknown or misplaced option. Run sse-path --help.');
    }
    const value = args[++index];
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new CliError('Option requires a value. Run sse-path --help.');
    }
    if (argument === '--out') {
      parsed.out = value;
      continue;
    }
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new CliError(
        'Timing options require positive whole numbers of milliseconds.',
      );
    }
    const milliseconds = Number(value);
    if (argument === '--timeout-ms') {
      parsed.probeOptions.timeoutMs = milliseconds;
    } else {
      parsed.probeOptions.maxDeliveryLagMs = milliseconds;
    }
  }
  const expected = command === 'compare' ? 2 : 1;
  if (parsed.positional.length !== expected) {
    throw new CliError('Wrong number of arguments. Run sse-path --help.');
  }
  if (command === 'probe') {
    validatePolicy(
      parsed.probeOptions.timeoutMs ?? LIMITS.timeoutMs.default,
      parsed.probeOptions.maxDeliveryLagMs ?? LIMITS.maxDeliveryLagMs.default,
    );
  }
  return parsed;
}

async function readReport(path: string): Promise<Report> {
  let file: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > LIMITS.maxReportBytes
    ) {
      throw new Error();
    }
    file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size > LIMITS.maxReportBytes ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error();
    }
    // The extra byte also rejects files that grow after the initial stat.
    const buffer = Buffer.alloc(LIMITS.maxReportBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > LIMITS.maxReportBytes) throw new Error();
    return validateReport(
      JSON.parse(buffer.subarray(0, bytes).toString('utf8')),
    );
  } catch (error: unknown) {
    if (error instanceof InputError) throw error;
    throw new CliError(
      'Cannot read report: use a valid report in a regular, non-symlink file of at most 1 MiB.',
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function reserveReport(path: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    throw new CliError(
      'Cannot create report: choose a new file in an existing writable directory. Existing files and symlinks are never overwritten.',
    );
  }
}

function reportExitCode(report: Report): number {
  return report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (
    args.length === 0 ||
    (args.length === 1 && ['--help', '-h'].includes(args[0]!)) ||
    (['probe', 'inspect', 'compare'].includes(args[0]!) &&
      args.slice(1).some((argument) => ['--help', '-h'].includes(argument)))
  ) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const parsed = parse(args);
  if (parsed.command === 'inspect') {
    const report = await readReport(parsed.positional[0]!);
    process.stdout.write(
      `${parsed.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
    );
    return reportExitCode(report);
  }
  if (parsed.command === 'compare') {
    const before = await readReport(parsed.positional[0]!);
    const after = await readReport(parsed.positional[1]!);
    const comparison = compareReports(before, after);
    process.stdout.write(
      `${parsed.json ? JSON.stringify(comparison, null, 2) : formatComparison(comparison)}\n`,
    );
    return comparison.status === 'verified'
      ? 0
      : comparison.status === 'not-verified'
        ? 1
        : 2;
  }
  const token = process.env.SSE_PATH_TOKEN;
  const options: ProbeOptions = {
    ...parsed.probeOptions,
    ...(token === undefined ? {} : { token }),
  };
  // Validate all request inputs before creating even an empty output file.
  validateProbeInput(parsed.positional[0]!, options);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let output: FileHandle | undefined;
  try {
    // Reserve the output before any request, so an existing path fails locally.
    if (parsed.out !== undefined) output = await reserveReport(parsed.out);
    const report = await probe(parsed.positional[0]!, {
      ...options,
      signal: controller.signal,
    });
    if (output !== undefined) {
      try {
        await output.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await output.sync();
      } catch {
        throw new CliError(
          'Cannot finish writing the report. The newly created file may be incomplete.',
        );
      }
    }
    process.stdout.write(
      `${parsed.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
    );
    return reportExitCode(report);
  } finally {
    await output?.close().catch(() => undefined);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

// Only fixed validation messages and local CLI errors may cross this boundary.
// Never print arbitrary exceptions from network, parsing, or filesystem APIs.
process.stdout.on('error', () => {
  process.exitCode = 2;
});
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `sse-path: ${error instanceof CliError || error instanceof InputError ? error.message : 'Request or input could not be processed. Check the URL, token, and timing options; run sse-path --help.'}\n`,
    );
    process.exitCode = 2;
  },
);
