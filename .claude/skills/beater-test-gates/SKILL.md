---
name: beater-test-gates
description: Run beater.js verification gates on this local macOS workspace, including the PyO3 configuration needed for embedded Python tests.
---

# beater.js test gates

Use this skill when a change needs local verification in `jadenfix/beater.js`, especially if `cargo test` touches `pyo3` or `beater-py`.

## Full workspace gate

Run formatting, whitespace checks, and the workspace tests with the local CommandLineTools Python framework explicitly configured:

```sh
tmp_config=$(mktemp /tmp/beater-pyo3-config.XXXXXX)
printf '%s\n' \
  'implementation=CPython' \
  'version=3.9' \
  'shared=true' \
  'abi3=false' \
  'lib_name=python3.9' \
  'lib_dir=/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/lib' \
  'executable=/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9' > "$tmp_config"
cargo fmt --check
git diff --check
PYO3_CONFIG_FILE="$tmp_config" \
  DYLD_FRAMEWORK_PATH=/Library/Developer/CommandLineTools/Library/Frameworks \
  cargo test
```

## Focused gate

For a targeted test, reuse the same `tmp_config` setup and replace the final command with the focused package/test filter, for example:

```sh
PYO3_CONFIG_FILE="$tmp_config" \
  DYLD_FRAMEWORK_PATH=/Library/Developer/CommandLineTools/Library/Frameworks \
  cargo test -p beater-cli dev_server_serves_routes_ssr_and_mcp_without_api_key -- --nocapture
```

## Known local blockers

- Docker Desktop may fail locally with containerd metadata I/O errors; do not treat that as proof the Docker cold-start gate is good or bad.
- Live Anthropic gates require `ANTHROPIC_API_KEY`; without it, only mock/unit/smoke coverage can run.
