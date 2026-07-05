# Runtime Limits

beater.js is pre-alpha. The current runtime is optimized for a correct vertical slice, not production throughput.

## Current Concurrency Model

`beater dev` accepts concurrent HTTP connections through axum. By default, user JS/TS route work is sent to one V8 worker isolate over a channel, so route handlers and React SSR render work serialize. Setting `[app].workers = N` starts N route isolates and round-robins route work across them.

What is concurrent today:

- the Rust HTTP server can accept multiple client connections
- non-JS control surfaces such as simple error responses do not need the route isolate
- JS/TS routes can run on separate isolates when `[app].workers` is greater than 1
- Python tool execution is offloaded away from the async runtime
- agent run durability lives in Rust and is not reset by JS hot reload

What is not concurrent today:

- with `workers = 1`, multiple JS/TS route handlers do not execute in parallel
- with `workers = 1`, multiple React SSR renders do not execute in parallel
- one `beater dev` process serves one app directory
- hot reload swaps the whole worker pool; in-flight streams on the old pool are aborted rather than silently truncated

## Operational Guidance

For v0.1, treat `beater dev` as a local development server and remote-management test target, not a production load target.

- Do not use current request throughput as a benchmark for the future runtime.
- Avoid long-running route handlers; put durable external work in tools or agent runs where it can be journaled.
- Run separate beater processes for separate apps.
- When binding beyond localhost, still use `BEATER_MCP_TOKEN`, trusted origins, and `--base-url` as documented in `docs/security.md`.

## Planned Fix

The channel protocol between the host and JS workers now supports an isolate pool. The remaining production path is:

- prove throughput scaling under load
- tune worker-count guidance for CPU count and memory use
- preserve route metadata extraction and stream cancellation as the pool grows

The Phase C acceptance criterion remains: `wrk` or an equivalent load test shows near-linear route throughput scaling to core count.
