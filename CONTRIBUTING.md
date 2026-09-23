# Contributing

Contributions are welcome. Keep the focus on measured SSE delivery through a controlled route, useful explanations, and reports that never claim more than their evidence supports.

## Run locally

Use Node.js 22.14 or newer:

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

`npm run format` applies repository formatting. `npm run build` emits the library, route adapter, and CLI into `dist/`. Tests use local synthetic fixtures and must not require provider credentials or Internet services.

## Propose a change

For a bug, include the expected behavior, actual behavior, Node version, platform, and a minimal synthetic reproduction. Review any report before attaching it. Do not include tokens or private deployment details. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

For a feature, explain which observation cannot currently be made and what evidence would justify the proposed finding. Prefer one bounded scenario over a generic framework. New integrations should preserve an ordinary `Request`/`Response` route interface where practical.

## Pull requests

- Keep changes focused. Describe the concrete behavior before and after the change.
- Add regression coverage for protocol, parser, timing, cancellation, privacy, or filesystem behavior that changes.
- Distinguish confirmed observations from possible causes. Missing evidence must remain unknown.
- Keep fixture timing assertions tolerant enough for CI scheduling variation without hiding a real buffering or truncation failure.
- Keep tokens, full URLs, headers, and arbitrary stream content out of reports and diagnostic errors.
- Avoid new runtime dependencies unless the maintenance and security tradeoff is justified.
- Run `npm run check` and inspect `npm pack --dry-run` before submitting package changes.

CI runs with read-only repository permissions and does not publish packages or deploy routes. Maintainers review and release separately. Contributing does not grant access to production infrastructure.

Contributions are provided under this repository's MIT license.
