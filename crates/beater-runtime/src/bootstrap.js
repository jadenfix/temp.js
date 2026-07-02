// beater.js isolate bootstrap: minimal web-ish shims + the dispatch glue.
// deno_core is not Deno — nothing exists here except what we add.
((core) => {
  const ops = core.ops;

  function fmt(x) {
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.stack ?? String(x);
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  }

  globalThis.console = {
    log: (...args) => core.print(args.map(fmt).join(" ") + "\n", false),
    info: (...args) => core.print(args.map(fmt).join(" ") + "\n", false),
    warn: (...args) => core.print(args.map(fmt).join(" ") + "\n", true),
    error: (...args) => core.print(args.map(fmt).join(" ") + "\n", true),
    debug: (...args) => core.print(args.map(fmt).join(" ") + "\n", false),
  };

  let nextTimerId = 1;
  const cancelledTimers = new Set();
  globalThis.setTimeout = (cb, ms = 0, ...args) => {
    const id = nextTimerId++;
    ops.op_beater_sleep(ms).then(() => {
      if (!cancelledTimers.delete(id)) cb(...args);
    });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    cancelledTimers.add(id);
  };
  globalThis.setInterval = (cb, ms = 0, ...args) => {
    const id = nextTimerId++;
    (async () => {
      while (true) {
        await ops.op_beater_sleep(ms);
        if (cancelledTimers.has(id)) {
          cancelledTimers.delete(id);
          return;
        }
        cb(...args);
      }
    })();
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout;

  globalThis.queueMicrotask ??= (cb) => {
    Promise.resolve().then(cb);
  };

  // Route dispatch: called from Rust with (specifier, method, request).
  // API routes export per-method handlers (GET, POST, ...) or a default.
  globalThis.__beaterDispatch = async (specifier, method, request) => {
    const mod = await import(specifier);
    const handler = mod[method] ?? mod.default;
    if (typeof handler !== "function") {
      throw new Error(
        `route module does not export a ${method} handler or default: ${specifier}`,
      );
    }
    const resp = await handler(request);
    if (
      resp === null ||
      typeof resp !== "object" ||
      typeof resp.status !== "number"
    ) {
      throw new Error(
        `route handler must return { status, headers?, body? }, got: ${fmt(resp)}`,
      );
    }
    return {
      status: resp.status,
      headers: resp.headers ?? {},
      body: resp.body == null ? "" : String(resp.body),
    };
  };
})(Deno.core);
