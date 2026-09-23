# Diagnostic route protocol

The diagnostic route emits synthetic SSE metadata. It never relays application
stream content, reflects request parameters, or includes the authorization token
in its output. The route runs in Node.js and uses the standard `Request` and
`Response` interfaces. Node.js 22.14 or newer is the supported runtime; these
interfaces do not imply support for edge runtimes, Deno, or Workers, which have
not been validated. Numeric timer handles are tolerated, but the route still
uses Node.js modules. Use `runtime = 'nodejs'` in a Next.js route.

Configure a randomly generated bearer token with at least 32 characters. The
factory rejects missing tokens, whitespace, unsupported token characters, and
tokens longer than 512 characters. Length checking does not establish entropy;
generate the token from a cryptographically secure random source. Requests must
use `Authorization: Bearer <token>`. Do not put the token in a URL.

Only `GET` is supported. Successful responses use:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store, no-transform
X-Accel-Buffering: no
X-Content-Type-Options: nosniff
```

These headers request appropriate streaming behavior; an intermediary may
ignore them. The route does not add CORS permission. Query parameters cannot
change the scenario or timing.

## Events

Every frame contains an `event:` field and one JSON `data:` field, followed by a
blank line. Events share a randomly generated `runId` UUID.

| Event       | JSON data                                    |
| ----------- | -------------------------------------------- |
| `start`     | `version: 1`, `runId`, `emittedMs`, `config` |
| `tick`      | `runId`, `seq`, `emittedMs`                  |
| `heartbeat` | `runId`, `seq`, `emittedMs`                  |
| `done`      | `runId`, `count`, `emittedMs`                |

`emittedMs` is monotonic elapsed time in milliseconds since the request's stream
was created, measured immediately before the route enqueues an event. It is not
an epoch timestamp, a scheduled time, or proof that bytes have left the server's
network interface. Server and client wall clocks do not need to agree.

Ticks are numbered consecutively from 1 through `count`. A heartbeat's `seq` is
the number of ticks emitted so far. `done` follows the last tick and the stream
then closes. An interrupted stream may have no `done` event; a client must not
interpret that as successful completion.

## Scenarios and limits

| Option          | Default  | Accepted range                           |
| --------------- | -------- | ---------------------------------------- |
| `scenario`      | `steady` | `steady`, `idle`, `heartbeat`            |
| `count`         | 10       | Integer, 2–100                           |
| `intervalMs`    | 500      | Integer, 50–5,000                        |
| `idleMs`        | 3,000    | Integer, 0–30,000                        |
| `heartbeatMs`   | 500      | Integer, 50–5,000                        |
| `maxConcurrent` | 4        | Integer, 1–16 per route handler instance |

The `start.config` value contains `scenario`, `count`, `intervalMs`, `idleMs`, and
`heartbeatMs` after applying defaults. It does not contain the token or
concurrency setting.

- `steady` emits the first tick promptly, then spaces ticks by `intervalMs`.
- `idle` pauses for `idleMs` after the first tick, replacing that tick's usual
  interval. Later ticks use `intervalMs`.
- `heartbeat` uses the same pause, with heartbeat events at `heartbeatMs`
  intervals during it. No heartbeat is emitted exactly at the pause's end.

The configured schedule must be at most 60 seconds. It is
`(count - 1) × intervalMs` for `steady`, and
`idleMs + (count - 2) × intervalMs` for the other scenarios. Timer jitter and
backpressure may increase actual elapsed time. A 65-second lifetime cap aborts
stalled streams and releases their concurrency slots.

The stream is pull-driven with at most one internally queued event. Backpressure
can delay source emissions. Timestamps record those delays; the route does not
fabricate earlier timestamps or enqueue a backlog of missed heartbeats. A test
that requires regularly spaced source emissions must check the observed source
schedule as well as client arrival times.

Cancellation, request abort, completion, the lifetime cap, and setup failures
clear timers and release concurrency. Excess simultaneous requests return 429;
invalid authorization returns 401 regardless of the HTTP method. Authenticated
requests using other methods return 405. A request already aborted
before creating a stream returns 408. Limits apply independently to each handler
instance and process, not across an entire deployment. Remove the temporary
diagnostic route and its token after testing.
