// Minimal virtual POSIX path shim for server-side package compatibility.
// It performs string-only path operations and never reads the host cwd,
// filesystem, environment, or platform path settings.

export const sep = "/";
export const delimiter = ":";

function assertPath(path) {
  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string. Received ${typeof path}`);
  }
}

function normalizeString(path, allowAboveRoot) {
  const parts = path.split("/");
  const output = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (output.length > 0 && output[output.length - 1] !== "..") {
        output.pop();
      } else if (allowAboveRoot) {
        output.push("..");
      }
      continue;
    }
    output.push(part);
  }
  return output.join("/");
}

function trimTrailingSlashes(path) {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) {
    end--;
  }
  return path.slice(0, end);
}

export function isAbsolute(path) {
  assertPath(path);
  return path.startsWith("/");
}

export function normalize(path) {
  assertPath(path);
  if (path.length === 0) {
    return ".";
  }
  const absolute = isAbsolute(path);
  const trailing = path.endsWith("/");
  let normalized = normalizeString(path, !absolute);
  if (normalized.length === 0 && !absolute) {
    normalized = ".";
  }
  if (normalized.length > 0 && trailing) {
    normalized += "/";
  }
  return `${absolute ? "/" : ""}${normalized}`;
}

export function join(...paths) {
  if (paths.length === 0) {
    return ".";
  }
  let joined = "";
  for (const path of paths) {
    assertPath(path);
    if (path.length === 0) {
      continue;
    }
    joined = joined.length === 0 ? path : `${joined}/${path}`;
  }
  return joined.length === 0 ? "." : normalize(joined);
}

export function resolve(...paths) {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = paths.length - 1; i >= 0; i--) {
    const path = paths[i];
    assertPath(path);
    if (path.length === 0) {
      continue;
    }
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.startsWith("/");
    if (resolvedAbsolute) {
      break;
    }
  }
  if (!resolvedAbsolute) {
    resolvedPath = `/${resolvedPath}`;
  }
  return trimTrailingSlashes(normalize(resolvedPath));
}

export function dirname(path) {
  assertPath(path);
  if (path.length === 0) {
    return ".";
  }
  const trimmed = trimTrailingSlashes(path);
  const index = trimmed.lastIndexOf("/");
  if (index === -1) {
    return ".";
  }
  if (index === 0) {
    return "/";
  }
  return trimmed.slice(0, index);
}

export function basename(path, suffix = "") {
  assertPath(path);
  if (suffix !== undefined) {
    assertPath(suffix);
  }
  const trimmed = trimTrailingSlashes(path);
  const index = trimmed.lastIndexOf("/");
  let base = index === -1 ? trimmed : trimmed.slice(index + 1);
  if (suffix && base.endsWith(suffix)) {
    base = base.slice(0, -suffix.length);
  }
  return base;
}

export function extname(path) {
  assertPath(path);
  const base = basename(path);
  const index = base.lastIndexOf(".");
  if (index <= 0) {
    return "";
  }
  return base.slice(index);
}

export function relative(from, to) {
  assertPath(from);
  assertPath(to);
  if (from === to) {
    return "";
  }
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  return [
    ...Array(fromParts.length - common).fill(".."),
    ...toParts.slice(common),
  ].join("/");
}

export function parse(path) {
  assertPath(path);
  const root = isAbsolute(path) ? "/" : "";
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(path);
  const name = ext ? base.slice(0, -ext.length) : base;
  return { root, dir, base, ext, name };
}

export function format(pathObject) {
  if (pathObject == null || typeof pathObject !== "object") {
    throw new TypeError("The pathObject argument must be an object");
  }
  const dir = pathObject.dir || pathObject.root || "";
  const base = pathObject.base || `${pathObject.name || ""}${pathObject.ext || ""}`;
  return dir ? join(String(dir), String(base)) : String(base);
}

export function toNamespacedPath(path) {
  assertPath(path);
  return path;
}

const win32 = Object.freeze({});

const path = {
  sep,
  delimiter,
  basename,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  toNamespacedPath,
  win32,
};

path.posix = path;

export const posix = path;
export { win32 };
export default path;
