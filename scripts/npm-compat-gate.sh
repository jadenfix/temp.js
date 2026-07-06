#!/usr/bin/env bash
# Prove the Phase C npm/node-compat wedge: a route can import a real ESM
# package, a leaf CommonJS default export, and a first Node built-in shim from
# node_modules with bare specifiers, while unsupported CommonJS require() fails
# closed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" == "Darwin" && -d /Library/Developer/CommandLineTools/Library/Frameworks ]]; then
  export DYLD_FRAMEWORK_PATH="${DYLD_FRAMEWORK_PATH:+$DYLD_FRAMEWORK_PATH:}/Library/Developer/CommandLineTools/Library/Frameworks"
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="${BEATER_BIN:-$TARGET_DIR/debug/beater}"
APP="$(mktemp -d "${TMPDIR:-/tmp}/beater-npm-gate.XXXXXX")/zod-app"
PORT="${BEATER_NPM_PORT:-$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)}"
LOG="${BEATER_NPM_LOG:-$TARGET_DIR/npm-compat-gate.log}"

cleanup() {
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$(dirname "$APP")"
}
trap cleanup EXIT

if [[ "${BEATER_SKIP_BUILD:-0}" != "1" || ! -x "$BIN" ]]; then
  cargo build -p beater-cli
fi

"$BIN" new "$APP" >/dev/null
npm install --prefix "$APP" zod@4.4.3 >/dev/null

mkdir -p "$APP/node_modules/legacy-cjs"
cat >"$APP/node_modules/legacy-cjs/package.json" <<'JSON'
{"name":"legacy-cjs","main":"index.cjs"}
JSON
cat >"$APP/node_modules/legacy-cjs/index.cjs" <<'JS'
module.exports = {
  label: "legacy-cjs",
  double(value) {
    return value * 2;
  },
};
JS

mkdir -p "$APP/node_modules/require-cjs"
cat >"$APP/node_modules/require-cjs/package.json" <<'JSON'
{"name":"require-cjs","main":"index.cjs"}
JSON
cat >"$APP/node_modules/require-cjs/index.cjs" <<'JS'
module.exports = require("fs");
JS

mkdir -p "$APP/node_modules/buffered"
cat >"$APP/node_modules/buffered/package.json" <<'JSON'
{
  "name": "buffered",
  "type": "module",
  "exports": {
    ".": "./index.js"
  }
}
JSON

cat >"$APP/node_modules/buffered/index.js" <<'JS'
import { Buffer } from "node:buffer";

export function encode(value) {
  const buffer = Buffer.from(value, "utf8");
  return {
    text: buffer.toString("utf8"),
    hex: buffer.toString("hex"),
    base64: buffer.toString("base64"),
    bytes: Buffer.byteLength(value, "utf8"),
    isBuffer: Buffer.isBuffer(buffer),
  };
}
JS

cat >"$APP/app/routes/api/zod.ts" <<'TS'
import { z } from "zod";

const Payload = z.object({ value: z.string().min(3) });

export function GET() {
  const parsed = Payload.parse({ value: "beater" });
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true, value: parsed.value }),
  };
}
TS

cat >"$APP/app/routes/api/cjs.ts" <<'TS'
import legacy from "legacy-cjs";

export function GET() {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      label: legacy.label,
      doubled: legacy.double(21),
    }),
  };
}
TS

cat >"$APP/app/routes/api/cjs-require.ts" <<'TS'
import blocked from "require-cjs";

export function GET() {
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: String(blocked),
  };
}
TS

cat >"$APP/app/routes/api/buffered.ts" <<'TS'
import { encode } from "buffered";

export function GET() {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(encode("beater")),
  };
}
TS

mkdir -p "$(dirname "$LOG")"
(
  unset ANTHROPIC_API_KEY
  unset BEATER_BASE_URL
  unset BEATER_MCP_TOKEN
  unset BEATER_MCP_TRUSTED_ORIGINS
  "$BIN" dev "$APP" --host 127.0.0.1 --port "$PORT"
) >"$LOG" 2>&1 &
pid=$!

python3 - "$PORT" "$LOG" <<'PY'
import http.client
import json
import sys
import time

port = int(sys.argv[1])
log = sys.argv[2]
deadline = time.monotonic() + 20

while True:
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.5)
        conn.request("GET", "/api/health")
        response = conn.getresponse()
        response.read()
        conn.close()
        if response.status == 200:
            break
    except OSError:
        pass
    if time.monotonic() > deadline:
        print(f"server did not become ready on {port}; log follows", file=sys.stderr)
        try:
            print(open(log, encoding="utf-8").read(), file=sys.stderr)
        except OSError:
            pass
        sys.exit(1)
    time.sleep(0.1)

conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
conn.request("GET", "/api/zod")
response = conn.getresponse()
body = response.read().decode("utf-8")
conn.close()
if response.status != 200:
    sys.exit(f"expected 200 from /api/zod, got {response.status}: {body}")
zod_payload = json.loads(body)
if zod_payload != {"ok": True, "value": "beater"}:
    sys.exit(f"unexpected /api/zod payload: {zod_payload!r}")

conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
conn.request("GET", "/api/cjs")
response = conn.getresponse()
body = response.read().decode("utf-8")
conn.close()
if response.status != 200:
    sys.exit(f"expected 200 from /api/cjs, got {response.status}: {body}")
cjs_payload = json.loads(body)
if cjs_payload != {"label": "legacy-cjs", "doubled": 42}:
    sys.exit(f"unexpected /api/cjs payload: {cjs_payload!r}")

conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
conn.request("GET", "/api/buffered")
response = conn.getresponse()
body = response.read().decode("utf-8")
conn.close()
if response.status != 200:
    sys.exit(f"expected 200 from /api/buffered, got {response.status}: {body}")
buffer_payload = json.loads(body)
expected_buffer = {
    "text": "beater",
    "hex": "626561746572",
    "base64": "YmVhdGVy",
    "bytes": 6,
    "isBuffer": True,
}
if buffer_payload != expected_buffer:
    sys.exit(f"unexpected /api/buffered payload: {buffer_payload!r}")

conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
conn.request("GET", "/api/cjs-require")
response = conn.getresponse()
body = response.read().decode("utf-8")
conn.close()
if response.status < 500:
    sys.exit(f"expected /api/cjs-require to fail closed, got {response.status}: {body}")
if "CommonJS require" not in body:
    sys.exit(f"expected /api/cjs-require failure to mention CommonJS require, got: {body}")
print(
    "npm compat passed: "
    f"zod import returned {zod_payload['value']}; "
    f"cjs doubled {cjs_payload['doubled']}; "
    f"buffer base64 {buffer_payload['base64']}; "
    "require failed closed"
)
PY
