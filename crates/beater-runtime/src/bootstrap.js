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

  globalThis.performance ??= { now: () => Date.now() };

  // Minimal UTF-8 TextEncoder — enough for react-dom/server's renderToString
  // path. Full web-streams support arrives with streaming SSR.
  if (!globalThis.TextEncoder) {
    globalThis.TextEncoder = class TextEncoder {
      get encoding() {
        return "utf-8";
      }
      encode(input = "") {
        const out = [];
        for (let i = 0; i < input.length; i++) {
          let c = input.codePointAt(i);
          if (c > 0xffff) i++;
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
          else if (c < 0x10000)
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
          else
            out.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 63),
              0x80 | ((c >> 6) & 63),
              0x80 | (c & 63),
            );
        }
        return new Uint8Array(out);
      }
      encodeInto(src, dest) {
        const bytes = this.encode(src);
        const written = Math.min(bytes.length, dest.length);
        dest.set(bytes.subarray(0, written));
        return { read: src.length, written };
      }
    };
  }

  // Page SSR: render the default-export component to HTML (M4).
  globalThis.__beaterRenderPage = async (specifier, request) => {
    const [mod, React, ReactDOMServer] = await Promise.all([
      import(specifier),
      import("react"),
      import("react-dom/server"),
    ]);
    const Component = mod.default;
    if (typeof Component !== "function") {
      throw new Error(`page route must export a default component: ${specifier}`);
    }
    const html = ReactDOMServer.renderToString(
      React.createElement(Component, { request }),
    );
    const bodyChunks = ["<!DOCTYPE html>", html];
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: bodyChunks.join(""),
      body_chunks: bodyChunks,
    };
  };

  // Agent Access Layer: read a route module's optional `agent` metadata
  // export ({title, description, crawl}) for llms.txt / sitemap generation.
  globalThis.__beaterRouteMeta = async (specifier) => {
    const mod = await import(specifier);
    const meta = mod.agent;
    if (!meta || typeof meta !== "object") return null;
    return {
      title: typeof meta.title === "string" ? meta.title : null,
      description: typeof meta.description === "string" ? meta.description : null,
      crawl: meta.crawl !== false,
    };
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
    let bodyChunks = [];
    if (resp.body_chunks !== undefined) {
      if (
        !Array.isArray(resp.body_chunks) ||
        !resp.body_chunks.every((chunk) => typeof chunk === "string")
      ) {
        throw new Error("route handler body_chunks must be an array of strings");
      }
      bodyChunks = resp.body_chunks;
    }
    return {
      status: resp.status,
      headers: resp.headers ?? {},
      body: resp.body == null ? "" : String(resp.body),
      body_chunks: bodyChunks,
    };
  };
})(Deno.core);
