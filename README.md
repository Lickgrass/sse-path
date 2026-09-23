# SSE Path

Find out whether your deployment delivers a stream incrementally—or holds it until the end.

SSE Path sends numbered, synthetic events through a small diagnostic route in your application. A local CLI compares the route's recorded emission times with event arrival times, reports observed batching and incomplete delivery, and compares fresh runs after a configuration change.

Built by [Lickgrass](https://lickgrass.com). MIT licensed. No account, telemetry, or runtime dependencies. The tool works independently of your hosting provider.

**Status:** initial source release. The intended package name is `@lickgrass/sse-path`; it has not been published to npm. Use the source commands below. This is a diagnostic tool, not a claim that an application is production ready.

## Try it locally

Requires Node.js 22.14 or newer and npm:

```sh
git clone https://github.com/Lickgrass/sse-path.git
cd sse-path
npm ci --ignore-scripts
npm run build
npm run demo
```

The demo exercises a healthy stream, deliberate buffering, and a forced timeout using local fixtures. It makes no cloud requests and needs no provider credentials. Read its output as fixture evidence, not as a live hosting benchmark.

```sh
node dist/cli.js --help
```

## Put a diagnostic route in your application

To install the built package in another local application before publication:

```sh
# In the SSE Path repository:
npm pack
# In your application, use the actual path to the generated archive:
npm install /absolute/path/to/lickgrass-sse-path-0.1.0.tgz
```

For a Next.js App Router application, add `app/api/stream-check/route.ts`:

```ts
import { createDiagnosticRoute } from '@lickgrass/sse-path/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let handler: ReturnType<typeof createDiagnosticRoute> | undefined;

export function GET(request: Request) {
  const token = process.env.SSE_PATH_TOKEN;
  if (!token) return new Response('Unavailable', { status: 503 });
  handler ??= createDiagnosticRoute({
    token,
    scenario: 'steady',
    count: 20,
    intervalMs: 250,
  });
  return handler(request);
}
```

Generate a dedicated high-entropy secret, put it in your application's deployment environment, and set the same `SSE_PATH_TOKEN` in the shell running the CLI. A password manager or your normal secret manager is preferable to a literal secret in shell history. The token is read at request time in this example, so a build does not require it. Restart the application after rotating it; the initialized handler retains its token and concurrency limit.

The route only emits synthetic timing metadata. Keep it temporary, protected, and behind your normal access controls. A valid token still permits requests that consume connections. Remove the route when finished. See [security guidance](SECURITY.md).

```sh
node dist/cli.js probe https://your-app.example/api/stream-check --out before.json
# Change your proxy or application configuration, then deploy it.
node dist/cli.js probe https://your-app.example/api/stream-check --out after.json
node dist/cli.js compare before.json after.json
```

Use fresh filenames: output is created exclusively with mode `0600`, and existing files and symlinks are never overwritten. The directory must already exist. On POSIX filesystems this requests owner-only access. On Windows, mode `0600` does not set a private ACL: use an output directory whose ACL already limits access appropriately.

## What it measures

The diagnostic route records monotonic elapsed time immediately before handing an event to its response stream. The CLI records monotonic elapsed time when it parses the received event. These are separate clocks: SSE Path does not subtract server wall-clock timestamps from the client's clock.

Recorded emission is an application observation, **not proof of when bytes reached the server's network interface**. Middleware, compression, proxies, the runtime, and the network can affect delivery after that point. The tool can demonstrate that delivery fell behind the route's emission schedule and later caught up. It does not identify which hop caused that behavior.

The source must actually exercise its declared schedule. SSE Path checks tick spacing and the heartbeat cadence during the configured pause, allowing bounded scheduling variation. Source load or backpressure can prevent the intended schedule from being exercised; in that case timing findings remain unknown. The interval from the first tick to the last tick must span at least twice the delivery tolerance. A delayed start or completion marker cannot substitute for spaced tick evidence.

The three route scenarios are:

| Scenario    | Purpose                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `steady`    | Emit events at regular intervals and check incremental delivery.            |
| `idle`      | Include a controlled quiet period to observe completion across an idle gap. |
| `heartbeat` | Include the same kind of quiet period with observable heartbeat events.     |

Use a separate route or a new deployed route configuration for each scenario. The client cannot turn URL parameters into arbitrary server workload. Compare a scenario against the same scenario; an idle-to-heartbeat comparison changes the experiment and cannot verify a repair.

A passing run establishes the recorded behavior on **that route, under that scenario and policy**. It does not establish browser rendering, EventSource reconnect behavior, model output quality, WebSocket behavior, application correctness, production traffic capacity, or the behavior of a different route. The diagnostic route's response headers can themselves affect buffering; test your real application separately before generalizing a result.

## CLI reference

```text
sse-path probe URL [--out report.json] [--json]
  [--timeout-ms 15000] [--max-delivery-lag-ms 250] [--allow-http]
sse-path inspect report.json [--json]
sse-path compare before.json after.json [--json]
```

When using the source checkout, replace `sse-path` with `node dist/cli.js`.

- **`probe`** requests only the supplied diagnostic URL and does not follow redirects. HTTPS and loopback HTTP are allowed; `--allow-http` explicitly permits remote plaintext HTTP on a trusted network. Never send the token over an untrusted plaintext connection.
- **`inspect`** validates and displays a saved report without making network requests.
- **`compare`** requires the same normalized target URL, scenario configuration, deadline, and tolerance. The later run must have a different run ID and a later capture timestamp. It evaluates whether a fresh successful run resolves a recorded failure; it does not prove that your configuration edit was the cause.
- **`--timeout-ms`** bounds the whole probe: 100–120,000 ms, default 15,000. Allow enough time for the configured scenario, including its idle period.
- **`--max-delivery-lag-ms`** sets the tolerated delivery catch-up: 1–30,000 ms, default 250. It measures aggregation of recorded emission into closer arrivals, not absolute network latency. A constant delay is not excluded. Choose a policy appropriate to your route rather than treating the default as a universal service-level objective. The source tick span must reach at least twice this tolerance for a conclusive timing finding.
- **`--json`** prints structured output for scripts. `--out` saves a report independently of output formatting.
- **`SSE_PATH_TOKEN`** is the only CLI token input. Tokens in URLs or command-line options are not supported.

| Command            | Exit 0   | Exit 1       | Exit 2                          |
| ------------------ | -------- | ------------ | ------------------------------- |
| `probe`, `inspect` | Passed   | Failed       | Inconclusive or invalid input   |
| `compare`          | Verified | Not verified | Not comparable or invalid input |

Missing evidence is reported as unknown. A successful HTTP status alone is not a successful streaming result. Completion requires the valid terminal event within the deadline; the client then cancels its reader instead of waiting for the connection to close. Interrupting a probe aborts its request; it cannot produce a verified successful run.

## Reports and privacy

Reports contain synthetic event timing, a hashed target identifier, scenario settings, findings, and coverage limits. They omit the requested URL, token, response headers, and arbitrary application content. A target hash is pseudonymous, not anonymous: someone who guesses a URL may recognize it. Treat reports as internal diagnostics until reviewed.

Inspect and compare accept regular, non-symlink JSON report files of at most 1 MiB. Malformed reports are rejected, and derived metrics and verdicts are recomputed from the validated observations instead of trusting stored conclusions. Report parsing does not replay requests, execute code, or load referenced resources. Network error details are deliberately not printed because they may contain credentials or URLs.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm pack --dry-run
```

Tests use controlled local fixtures. CI requires no cloud account or production secret. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process and [SECURITY.md](SECURITY.md) for security boundaries.

If you are also evaluating hosting, [Lickgrass](https://lickgrass.com) is the company building this tool. Using SSE Path does not require moving your application or creating an account.
