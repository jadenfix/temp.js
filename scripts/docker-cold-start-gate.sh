#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
RUST_IMAGE=${BEATER_DOCKER_RUST_IMAGE:-rust:1-bookworm}
IMAGE=${BEATER_DOCKER_IMAGE:-beater-hello:docker-gate}
COLD_START_MS=${BEATER_DOCKER_COLD_START_MS:-1000}
MIN_FREE_KIB=${BEATER_DOCKER_MIN_FREE_KIB:-12582912}
WORKDIR=${BEATER_DOCKER_GATE_WORKDIR:-}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

free_kib() {
  df -Pk "$1" | awk 'NR == 2 { print $4 }'
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

need docker
need python3

if ! docker version >/dev/null 2>&1; then
  echo "docker daemon is not available" >&2
  exit 1
fi

if [ -z "$WORKDIR" ]; then
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/beater-docker-gate.XXXXXX")
else
  mkdir -p "$WORKDIR"
fi

cleanup() {
  status=$?
  if [ -n "${CID:-}" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  if [ "$status" -eq 0 ] && [ "${BEATER_DOCKER_KEEP:-0}" != "1" ]; then
    rm -rf "$WORKDIR/target"
  fi
  if [ "$status" -ne 0 ]; then
    echo "kept gate workdir: $WORKDIR" >&2
  fi
}
trap cleanup EXIT

available=$(free_kib "$WORKDIR")
if [ "$available" -lt "$MIN_FREE_KIB" ]; then
  echo "not enough free space for Linux release build: ${available} KiB available, ${MIN_FREE_KIB} KiB required" >&2
  echo "set BEATER_DOCKER_GATE_WORKDIR to a filesystem with more room, or lower BEATER_DOCKER_MIN_FREE_KIB after validating locally" >&2
  exit 1
fi

mkdir -p "$WORKDIR/target" "$WORKDIR/bundle" "$WORKDIR/logs"

if ! docker image inspect "$RUST_IMAGE" >/dev/null 2>"$WORKDIR/logs/rust-image-inspect.err"; then
  if grep -qi "No such image" "$WORKDIR/logs/rust-image-inspect.err"; then
    docker pull "$RUST_IMAGE" 2>&1 | tee "$WORKDIR/logs/rust-image-pull.log"
  else
    echo "docker cannot inspect builder image $RUST_IMAGE" >&2
    cat "$WORKDIR/logs/rust-image-inspect.err" >&2
    echo "logs: $WORKDIR/logs" >&2
    exit 1
  fi
fi

echo "building Linux beater bundle in $RUST_IMAGE"
docker run --rm \
  --mount "type=bind,src=$ROOT,dst=/src,readonly" \
  --mount "type=bind,src=$WORKDIR/target,dst=/target" \
  --mount "type=bind,src=$WORKDIR/bundle,dst=/bundle" \
  -w /src \
  "$RUST_IMAGE" \
  bash -lc 'set -euo pipefail
    export PATH=/usr/local/cargo/bin:$PATH
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates file pkg-config python3-dev
    PYO3_PYTHON=/usr/bin/python3 CARGO_TARGET_DIR=/target cargo build --release -p beater-cli
    /target/release/beater build /src/examples/hello --out /bundle --force
    file /bundle/bin/beater
  ' 2>&1 | tee "$WORKDIR/logs/linux-bundle-build.log"

echo "building runtime image $IMAGE"
docker build -t "$IMAGE" "$WORKDIR/bundle" 2>&1 | tee "$WORKDIR/logs/docker-build.log"

PORT=$(free_port)
start=$(now_ms)
CID=$(docker run -d --rm \
  -e BEATER_MCP_TOKEN=docker-gate-token \
  -p "127.0.0.1:$PORT:3000" \
  "$IMAGE")

deadline=$((start + 10000))
while :; do
  if python3 - "$PORT" >"$WORKDIR/logs/health.json" 2>"$WORKDIR/logs/health.err" <<'PY'
import sys
from urllib.request import urlopen

port = sys.argv[1]
with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.5) as response:
    body = response.read().decode("utf-8")
    if response.status != 200 or '"runtime":"beater.js"' not in body:
        raise SystemExit(f"unexpected health response: {response.status} {body}")
    print(body)
PY
  then
    end=$(now_ms)
    elapsed=$((end - start))
    break
  fi
  if [ "$(now_ms)" -ge "$deadline" ]; then
    docker logs "$CID" >"$WORKDIR/logs/container.log" 2>&1 || true
    echo "container did not serve /api/health within 10s" >&2
    echo "logs: $WORKDIR/logs" >&2
    exit 1
  fi
  sleep 0.05
done

docker logs "$CID" >"$WORKDIR/logs/container.log" 2>&1 || true

if [ "$elapsed" -gt "$COLD_START_MS" ]; then
  echo "docker cold start exceeded ${COLD_START_MS}ms: ${elapsed}ms" >&2
  echo "logs: $WORKDIR/logs" >&2
  exit 1
fi

cat >"$WORKDIR/evidence.md" <<EOF
# Docker Cold-Start Gate

- image: \`$IMAGE\`
- rust builder: \`$RUST_IMAGE\`
- route: \`/api/health\`
- cold start: \`${elapsed}ms\`
- limit: \`${COLD_START_MS}ms\`
- logs: \`$WORKDIR/logs\`
EOF

echo "docker cold-start gate passed in ${elapsed}ms"
echo "evidence: $WORKDIR/evidence.md"
