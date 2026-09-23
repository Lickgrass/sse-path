# Initial release validation

Validated locally on macOS on 2026-09-23:

- Formatting, strict TypeScript type checking, and build pass.
- All 36 tests pass on Node 22.14.0, Node 24, and Node 25.6.1.
- A real local HTTP origin and proxy exercise healthy delivery, response buffering, truncation/interruption, silence, idle disconnects, and heartbeat survival.
- A fresh capture after disabling buffering resolves the earlier failure at the same URL and policy.
- Ten canceled requests release a single route concurrency slot before the next successful probe.
- Parser tests reject malformed UTF-8, excessive frames, excessive bytes/events, malformed protocol metadata, and invalid report sequences.
- Regression tests prevent a late completion marker or arrival beyond the deadline from yielding a passing report.
- An isolated offline consumer installs the packed archive and checks the CLI, public exports, authenticated route, archive allowlist, and absence of runtime dependencies.
- `npm audit --package-lock-only --audit-level=low` reported no known vulnerabilities in the locked dependencies at validation time. This is not a security certification.

The GitHub workflow is configured for Linux, macOS, and Windows, but hosted CI has not run for this new local repository. The Next.js adapter follows its standard Node-runtime Request/Response route interface; a deployed Next.js application and live hosting providers have not been tested. No independent third-party security audit is claimed.

Run `npm run check` to reproduce the local checks, or `npm run demo` to see the diagnostic flow. A report describes the controlled route and observation window only.
