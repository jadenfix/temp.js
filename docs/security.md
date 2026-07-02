# Security And Trust Model

beater.js is currently a local-first development runtime. Binding beyond localhost is useful for containers and remote testing, but it changes the threat model.

## Network Exposure

`beater dev` defaults to `127.0.0.1`. Use `--host 0.0.0.0` only inside a trusted network or container boundary.

Current `/mcp` behavior:

- no authentication
- JSON-RPC over `POST /mcp`
- local `Origin` allow-list to reduce browser DNS-rebinding risk
- no server-initiated SSE stream

Before exposing `/mcp` to a remote manager or another machine, beater needs bearer-token authentication, explicit trusted-host/origin configuration, and tests that prove unauthorized calls fail closed.

## Python Tools

Python tools are first-party code and run with the same OS privileges as the beater process. They can read files, open sockets, import packages from the configured venv, and mutate external systems.

Do not run untrusted Python tools. The planned Wasmtime tier is the sandbox path for untrusted or agent-generated code.

## Journal Data

The journal is plaintext SQLite under `<app>/.beater/journal.db`. It stores prompts, model responses, tool inputs, tool outputs, run status, and step attempts.

Operational implications:

- do not commit `.beater/`
- treat journal backups as sensitive
- redact secrets before passing them to agents or tools
- add redaction hooks before production deployments that handle private data

## Remote Integrations

Networked tools should have explicit timeouts, retry policy, idempotency keys, and secret handling. Remote MCP tools, SaaS API integrations, and browser automation sessions should all be declared through the registry so calls are journaled before side effects happen.

## Agentic Browsing

Browser automation is powerful enough to read authenticated pages and perform destructive actions. Browser-provider work must include session lifecycle cleanup, scoped credentials, and e2e tests for crash handling before it is considered production-ready.
