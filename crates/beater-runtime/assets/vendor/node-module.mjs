// Minimal node:module shim for server-side package compatibility.
// It exposes Beater-supported built-in discovery while keeping CommonJS
// require() fail-closed: no filesystem lookup, eval, or host module loading.

const COMMONJS_REQUIRE_ERROR = "CommonJS require is not supported in beater.js isolates";

export const builtinModules = Object.freeze([
  "assert",
  "assert/strict",
  "buffer",
  "events",
  "module",
  "os",
  "path",
  "process",
  "querystring",
  "stream",
  "stream/promises",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
]);

const builtinSet = new Set(builtinModules);

function normalizeBuiltinName(name) {
  if (typeof name !== "string") return "";
  return name.startsWith("node:") ? name.slice("node:".length) : name;
}

function isValidFileUrlString(value) {
  if (!value.startsWith("file:///")) return false;
  if (typeof URL === "undefined") return false;
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
}

function unsupportedRequire() {
  throw new Error(COMMONJS_REQUIRE_ERROR);
}

function assertCreateRequireSpecifier(filename) {
  if (typeof filename === "string" && (filename.startsWith("/") || isValidFileUrlString(filename))) {
    return;
  }
  if (typeof URL !== "undefined" && filename instanceof URL && filename.protocol === "file:") return;
  throw new TypeError("module.createRequire requires a file URL or absolute path string");
}

export function isBuiltin(name) {
  return builtinSet.has(normalizeBuiltinName(name));
}

export function createRequire(filename) {
  assertCreateRequireSpecifier(filename);
  function require() {
    unsupportedRequire();
  }
  require.resolve = () => unsupportedRequire();
  require.cache = Object.freeze({});
  require.extensions = Object.freeze({});
  require.main = undefined;
  return require;
}

export function syncBuiltinESMExports() {
  return undefined;
}

export class Module {
  constructor(id = "") {
    this.id = String(id);
    this.filename = String(id);
    this.loaded = false;
    this.exports = {};
    this.children = [];
    this.paths = [];
  }

  require() {
    unsupportedRequire();
  }

  static builtinModules = builtinModules;
  static createRequire = createRequire;
  static isBuiltin = isBuiltin;
  static syncBuiltinESMExports = syncBuiltinESMExports;
}

const module = {
  Module,
  builtinModules,
  createRequire,
  isBuiltin,
  syncBuiltinESMExports,
};

export default module;
