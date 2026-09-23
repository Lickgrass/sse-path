# Changelog

## 0.1.0 — 2026-09-23

- Add an authenticated synthetic SSE route with steady, idle, and heartbeat scenarios.
- Add a local probe that records bounded emission and arrival evidence.
- Add human-readable and JSON reports, local inspection, and before/after comparison.
- Add explicit coverage limits, unknown findings, and private exclusive report output.
- Add local fixtures, a runnable demo, and read-only CI checks.
- Reject invalid probe arguments before reserving report output, and print fixed validation errors without exposing untrusted exception text.
- Release route concurrency on setup failures and support numeric timer handles; authenticate before returning method errors.
- Import reports by schema version, preserving the producing tool version across upgrades.
- Accept comment keepalives while bounding individual UTF-8 lines and retained event data independently.
- Centralize tool version, limits, and token validation; show maximum arrival gaps and support subcommand help.
- Ignore local editor settings, enforce LF checkouts, and check dependency updates with Dependabot.
- Prepare a disabled manual npm release workflow that publishes the exact tested archive with provenance after maintainer setup.

Initial public npm release under `@lickgrass/sse-path`. No live provider certification or independent security audit is claimed.
