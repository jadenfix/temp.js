// The `beater:agent` module — the DX surface agents/<name>/agent.ts imports.
// These produce plain config objects; the loop itself runs in Rust.

export function defineAgent(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("defineAgent(config) requires a config object");
  }
  return {
    name: cfg.name ?? "agent",
    model: cfg.model ?? "claude-opus-4-8",
    system: cfg.system ?? "",
    tools: cfg.tools ?? [],
  };
}

// Python tool: full-fat CPython embedded in the host (numpy/torch work).
// Not idempotent unless declared — the resume-safety contract.
export function pyTool(name, path, opts = {}) {
  return { kind: "python", name, path, idempotent: opts.idempotent ?? false };
}

// Rust built-in tool, compiled into the host.
export function rustTool(name, opts = {}) {
  return { kind: "rust", name, idempotent: opts.idempotent ?? true };
}
