# Security

SSE Path is a local diagnostic client and an opt-in synthetic streaming route. It is not a security scanner, traffic interception proxy, or application certification tool.

## Reporting an issue

Please do not post tokens, private URLs, production reports, or a working credential exploit in a public issue. Use the private vulnerability reporting option on this repository if enabled. If it is unavailable, open a minimal public issue asking maintainers for a private reporting channel, without technical exploit details or sensitive data. A dedicated reporting address has not been established for this initial source release.

No third-party security audit or security certification is claimed. Supported fixes initially target the latest source version.

## Diagnostic route

- Use a unique high-entropy token, separate from application or provider credentials. The route requires bearer authentication. Authentication is not rate limiting.
- Deploy it only where you intend to test. Keep normal network access controls and rate limits. Do not expose it anonymously or accept arbitrary client-supplied scenario settings.
- Reuse one handler per application instance so its concurrency limit remains effective. Creating a new handler for each request would create a new per-handler limit.
- A concurrency limit applies to one handler in one process. It does not limit a fleet, other processes, serverless instances, or a distributed attack.
- Scenarios and event counts are bounded, but authenticated requests still consume resources. Long-lived streaming responses may incur hosting charges.
- Remove the diagnostic route when finished. Rotate its token if accidentally disclosed, and restart processes that retain the old handler.
- The route emits only synthetic metadata. Do not adapt it to echo request headers, cookies, environment values, or application payloads.

## Client and report boundaries

- Probe only endpoints you control or have permission to test. The CLI makes an outbound request to the URL you explicitly provide. It is not a safe general-purpose fetch service for untrusted URLs, including when embedded in another application.
- Use HTTPS outside local development. Loopback HTTP is allowed automatically; `--allow-http` explicitly permits remote HTTP on a trusted network. Bearer authentication over plaintext can be observed on the network.
- Set the token through `SSE_PATH_TOKEN`. Avoid shell tracing and do not put secrets in process arguments or URLs.
- The probe does not print raw exceptions, headers, or response bodies. Reports retain constrained synthetic timing evidence rather than captured application content.
- The target identifier is a hash, not a secrecy guarantee for guessable URLs. Timing, scenario configuration, and run metadata can still disclose operational information.
- Saved reports are data, not authenticated attestations. Someone can manufacture a well-formed report. Validate conclusions using a fresh probe on infrastructure you trust.
- The CLI bounds report reads, refuses symlink report inputs, and creates new output files exclusively with mode `0600`. On POSIX filesystems this requests owner-only access. On Windows it does not establish a private ACL: use a directory with appropriate access controls. Protect the parent directory: these checks are not a filesystem sandbox against another user who can mutate that directory.
- A failed or interrupted write may leave an incomplete newly created file. It will not replace a previous report. Delete the incomplete file or choose a fresh path before retrying.

## What a result does not establish

A passing diagnostic route does not prove application security, browser behavior, other route behavior, data integrity, sustained production capacity, or which intermediary caused a prior failure. Local fixture tests establish behavior of the fixture only. Do not publish a hosting benchmark without documenting the actual routes, deployment configuration, policy, and test conditions.
