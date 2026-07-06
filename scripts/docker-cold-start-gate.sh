#!/usr/bin/env bash
# Build a beater bundle, build its Docker image, and prove the container serves
# the generated app from a cold start.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${BEATER_DOCKER_GATE_MODE:-auto}" # auto | local | builder
BIN="${BEATER_BIN:-$ROOT/target/debug/beater}"
COLD_START_MS="${BEATER_DOCKER_COLD_START_MS:-1000}"
BUILDER_IMAGE="${BEATER_DOCKER_BUILDER_IMAGE:-rust:bookworm}"
if [[ -n "${BEATER_DOCKER_IMAGE:-}" ]]; then
  IMAGE="$BEATER_DOCKER_IMAGE"
  CLEAN_IMAGE=0
else
  IMAGE="beater-docker-cold-start-gate:$(date -u +%Y%m%dT%H%M%SZ)-$$"
  CLEAN_IMAGE=1
fi
if [[ -n "${BEATER_DOCKER_GATE_TMP:-}" ]]; then
  TMP="$BEATER_DOCKER_GATE_TMP"
  CLEAN_TMP=0
else
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/beater-docker-gate.XXXXXX")"
  CLEAN_TMP=1
fi
APP="$TMP/app"
BUNDLE="$TMP/bundle"
CONTAINER=""

fail() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

now_ms() {
  python3 -c 'import time; print(int(time.monotonic() * 1000))'
}

cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "$CLEAN_IMAGE" == "1" ]]; then
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ "$CLEAN_TMP" == "1" && "${BEATER_DOCKER_GATE_KEEP:-}" != "1" ]]; then
    rm -rf "$TMP"
  else
    echo "kept gate workspace: $TMP"
  fi
}

choose_mode() {
  case "$MODE" in
    auto)
      if [[ "$(uname -s)" == "Linux" ]]; then
        echo local
      else
        echo builder
      fi
      ;;
    local | builder)
      echo "$MODE"
      ;;
    *)
      fail "BEATER_DOCKER_GATE_MODE must be auto, local, or builder"
      ;;
  esac
}

assert_linux_binary() {
  local binary="$1"
  if command -v file >/dev/null 2>&1; then
    local description
    description="$(file "$binary")"
    [[ "$description" == *"ELF"* ]] || fail "bundle binary is not a Linux ELF executable: $description"
  fi
}

build_bundle_local() {
  need cargo
  [[ "$(uname -s)" == "Linux" ]] || fail "local mode requires a Linux host-built beater binary; use BEATER_DOCKER_GATE_MODE=builder on this host"

  cargo build --locked -p beater-cli
  [[ -x "$BIN" ]] || fail "missing executable $BIN"
  "$BIN" new "$APP"
  "$BIN" build "$APP" --out "$BUNDLE"
  assert_linux_binary "$BUNDLE/bin/beater"
}

build_bundle_in_builder() {
  echo "building Linux bundle in Docker builder image: $BUILDER_IMAGE"
  docker run --rm \
    -v "$ROOT:/workspace:ro" \
    -v "$TMP:/out" \
    -w /workspace \
    "$BUILDER_IMAGE" \
    bash -lc '
      set -euo pipefail
      export PATH="/usr/local/cargo/bin:$PATH"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        pkg-config \
        python3 \
        python3-dev \
        python3-venv \
        build-essential
      export PYO3_PYTHON="$(command -v python3)"
      export CARGO_TARGET_DIR=/tmp/beater-target
      command -v cargo >/dev/null
      cargo build --locked -p beater-cli
      /tmp/beater-target/debug/beater new /out/app
      /tmp/beater-target/debug/beater build /out/app --out /out/bundle
    '
  assert_linux_binary "$BUNDLE/bin/beater"
}

wait_for_container_port() {
  local mapping
  for _ in $(seq 1 100); do
    mapping="$(docker port "$CONTAINER" 3000/tcp 2>/dev/null | head -n1 || true)"
    if [[ -n "$mapping" ]]; then
      echo "${mapping##*:}"
      return 0
    fi
    sleep 0.1
  done
  fail "timed out waiting for Docker to publish container port 3000"
}

wait_for_health() {
  local port="$1"
  local deadline_ms="$2"
  local last=""

  while (( $(now_ms) <= deadline_ms )); do
    if last="$(curl -fsS --max-time 0.5 "http://127.0.0.1:$port/api/health" 2>&1)"; then
      if [[ "$last" == *'"runtime":"beater.js"'* ]]; then
        return 0
      fi
    fi
    sleep 0.05
  done

  echo "last /api/health response:" >&2
  echo "$last" >&2
  echo "container logs:" >&2
  docker logs "$CONTAINER" >&2 || true
  fail "container did not serve /api/health within ${COLD_START_MS}ms"
}

verify_mcp_auth() {
  local port="$1"
  local body='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  local missing_auth
  local authed

  missing_auth="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 2 \
    -H 'accept: application/json, text/event-stream' \
    -H 'content-type: application/json' \
    --data "$body" \
    "http://127.0.0.1:$port/mcp")"
  [[ "$missing_auth" == "401" ]] || fail "expected unauthenticated /mcp to return 401, got $missing_auth"

  authed="$(curl -fsS \
    --max-time 2 \
    -H 'accept: application/json, text/event-stream' \
    -H 'authorization: Bearer docker-gate-token' \
    -H 'content-type: application/json' \
    --data "$body" \
    "http://127.0.0.1:$port/mcp")"
  [[ "$authed" == *'"tools"'* ]] || fail "authenticated /mcp response did not include tools"
}

main() {
  trap cleanup EXIT
  need docker
  need curl
  need python3

  case "$TMP" in
    "" | "/")
      fail "refusing unsafe gate workspace: $TMP"
      ;;
  esac
  mkdir -p "$TMP"

  local selected_mode
  selected_mode="$(choose_mode)"
  case "$selected_mode" in
    local)
      build_bundle_local
      ;;
    builder)
      build_bundle_in_builder
      ;;
  esac

  echo "building Docker image: $IMAGE"
  docker build -t "$IMAGE" "$BUNDLE"

  local start_ms
  start_ms="$(now_ms)"
  CONTAINER="$(docker run --rm -d \
    -e BEATER_MCP_TOKEN=docker-gate-token \
    -p 127.0.0.1::3000 \
    "$IMAGE")"

  local port
  port="$(wait_for_container_port)"
  wait_for_health "$port" "$((start_ms + COLD_START_MS))"
  local elapsed_ms
  elapsed_ms="$(( $(now_ms) - start_ms ))"
  verify_mcp_auth "$port"

  echo "docker cold-start gate passed: $IMAGE served /api/health on port $port in ${elapsed_ms}ms"
}

main "$@"
