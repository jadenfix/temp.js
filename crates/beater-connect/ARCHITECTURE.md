# Beater Connect Architecture

Beater Connect is the agent access layer for `beater.js`. It provides a single
registry for agent-readable resources and agent-callable actions, then generates
the discovery, API, crawl, and policy surfaces required for safe agent
interoperability.

The crate is intentionally independent from the HTTP runtime. `beater-runtime`
can serve the generated surfaces, but the registry and generators remain usable
by other hosts and future adapters.

## Goals

- Define resources and actions once, with typed schemas and policy metadata.
- Generate consistent agent-facing surfaces from that single source of truth.
- Keep public crawl content separate from authenticated user operations.
- Make action safety explicit through auth, scopes, confirmation requirements,
  dry-run support, and idempotency requirements.
- Provide a stable foundation for future MCP transport, OpenAPI, OAuth consent,
  receipts, and Beater Agents trace export.

## Non-Goals

- This crate does not execute actions.
- This crate does not implement OAuth or user consent screens.
- This crate does not provide the live MCP JSON-RPC transport.
- This crate does not persist receipts or traces.

Those concerns belong in `beater-runtime`, an auth layer, and `beater-agents`.

## System Context

`beater.js` owns application routing, request handling, and local development.
`beater-agents` owns observability, replay, evaluation, and longer-term agent
governance.

Beater Connect sits between them:

```text
application code
  -> Beater Connect registry
  -> generated crawl/API/agent surfaces
  -> runtime transport and auth
  -> Beater Agents traces, receipts, and evals
```

This separation lets the framework expose agent capabilities without coupling
the registry to a specific server implementation.

## Registry Model

### Resource

A `Resource` describes data an agent can read. Examples include documentation,
product catalogs, support articles, public records, tickets, and orders.

Resources carry stable identifiers, human-readable descriptions, canonical
paths, optional markdown paths, visibility, tags, and freshness metadata.

### Action

An `Action` describes an operation an agent can request. Examples include
searching, drafting, adding an item to a cart, booking a demo, creating a
support ticket, sending a message, purchasing, publishing, or deleting.

Actions carry:

- stable operation ID
- HTTP method and path
- input and output schemas
- auth policy and scopes
- side-effect level
- confirmation requirement
- dry-run support
- idempotency requirement

### Schema

The MVP schema model is deliberately small: object schemas with named fields,
basic JSON types, descriptions, and required fields. The crate emits these as
JSON Schema-compatible structures for OpenAPI and MCP metadata.

The model can be replaced or extended later with a richer schema backend without
changing the top-level registry concepts.

## Generated Surfaces

| Surface | Purpose |
| --- | --- |
| `/.well-known/beater.json` | Canonical Beater discovery manifest. |
| `/.well-known/agent-card.json` | Agent discovery metadata for task-capable clients. |
| `/openapi.json` | HTTP API contract for resources and actions. |
| `/mcp` metadata | Tool, resource, and prompt catalog for MCP integration. |
| `/llms.txt` | Curated LLM-readable site and action map. |
| `/robots.txt` | Crawler policy with pointers to discovery files. |
| `/sitemap.xml` | Public crawlable URL inventory. |

The current crate generates static metadata for these surfaces. Runtime
integration will decide how each file or endpoint is served.

## Safety Model

Agent-facing operations must expose their risk level explicitly. Beater Connect
uses a simple side-effect ladder:

```text
read -> draft -> write -> send -> purchase -> delete
```

Default behavior:

| Level | Default Safety Requirement |
| --- | --- |
| `read` | Allowed when auth policy passes. |
| `draft` | Previewable and non-committing. |
| `write` | Idempotency required; confirmation recommended by the host. |
| `send` | Confirmation required. |
| `purchase` | Confirmation and spending limits required. |
| `delete` | Confirmation and elevated scope required. |

The generator includes this metadata in the manifest, OpenAPI extension fields,
and MCP catalog metadata so hosts can present clear approval and review flows.

## Idempotency

Any mutating action requires an idempotency key. The OpenAPI generator exposes
this as a required `Idempotency-Key` header for mutating operations.

The crate does not enforce idempotency by itself. Enforcement belongs in the
runtime action executor and receipt store.

## Receipts and Traceability

Receipts are not implemented in this crate. The registry is designed so action
execution can later emit durable records containing:

- user and client identity
- action ID and version
- input and output hashes
- approval state
- idempotency key
- timestamps
- Beater Agents trace ID

This gives agents an auditable path from discovery to authorization to execution
to evaluation.

## Integration Path

The intended integration path is incremental:

1. Use `beater-connect` as the canonical registry for resources and actions.
2. Have `beater-runtime` serve the generated crawl and discovery surfaces.
3. Replace hand-built MCP tool/resource metadata with registry-backed metadata.
4. Add live MCP JSON-RPC dispatch through runtime action handlers.
5. Add OAuth consent, approval tokens, and receipt persistence.
6. Export execution traces and receipts to `beater-agents`.

The current PR implements step 1 and static generation needed by steps 2 and 3.

## Compatibility

The crate is designed to be usable outside `beater.js`. Future adapters can map
the same registry model onto Next.js, Express, Remix, Axum, Rails, Django, or a
sidecar process for existing applications.

That adapter work should not change the core registry contract unless a concrete
integration exposes a missing primitive.
