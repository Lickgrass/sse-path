# Initial release validation

Validated locally on macOS on 2026-09-23:

- Formatting, strict TypeScript type checking, and build pass.
- All 52 tests pass on Node 22.14.0, Node 24, and Node 25.6.1.
- A real local HTTP origin and proxy exercise healthy delivery, response buffering, truncation/interruption, silence, idle disconnects, and heartbeat survival.
- A fresh capture after disabling buffering resolves the earlier failure at the same URL and policy.
- Ten canceled requests release a single route concurrency slot before the next successful probe.
- Parser tests reject malformed UTF-8, excessive frames, excessive bytes/events, malformed protocol metadata, and invalid report sequences.
- Repeated comment keepalives are accepted without weakening the retained event-data limit. Tests split UTF-8 input at every byte boundary and cover interleaved comments, empty data fields, and oversized multibyte lines.
- Numeric timer handles, throwing stream setup, constructor failures, aborts, cancellation, and watchdog expiry release the route's concurrency slot.
- Invalid URLs, tokens, and timing options leave no output file; a valid retry can use the same filename. CLI error tests check that supplied secrets are not reflected.
- Schema-compatible reports from different tool versions can be inspected and compared; unsupported schemas and unsafe version strings are rejected.
- Regression tests prevent a late completion marker or arrival beyond the deadline from yielding a passing report.
- An isolated offline consumer installs the packed archive and checks the CLI, public exports, authenticated route, archive allowlist, and absence of runtime dependencies.
- `npm audit --package-lock-only --audit-level=low` reported no known vulnerabilities in the locked dependencies at validation time. This is not a security certification.

The GitHub workflow runs the checks on Linux, macOS, and Windows; see the [hosted run history](https://github.com/Lickgrass/sse-path/actions/workflows/ci.yml) for results on individual commits. LF checkout rules address the Windows formatting failure found in the initial run. The Next.js adapter follows its standard Node-runtime Request/Response route interface; a deployed Next.js application and live hosting providers have not been tested. Numeric-timer tests do not establish edge-runtime compatibility. No independent third-party security audit is claimed.

Run `npm run check` to reproduce the local checks, or `npm run demo` to see the diagnostic flow. A report describes the controlled route and observation window only.
