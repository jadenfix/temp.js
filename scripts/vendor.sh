#!/usr/bin/env bash
# Vendor single-file ESM builds of React for SSR inside the embedded isolate (M4).
# Fetched once, checked in — no npm resolution in the framework.
#
# esm.sh entry URLs return tiny re-export shims; we fetch the real es2022
# builds directly and rewrite their absolute imports to the bare specifiers
# the beater module loader maps ("react", "react/jsx-runtime").
set -euo pipefail

REACT_V=19.2.7
OUT="$(dirname "$0")/../crates/beater-runtime/assets/vendor"
mkdir -p "$OUT"

fetch() { # url out
  curl -fsSL "$1" -o "$2"
  # absolute-path imports -> bare specifiers our loader resolves
  sed -i '' \
    -e "s|\"/react@${REACT_V}/es2022/react.mjs\"|\"react\"|g" \
    -e "s|\"/react@${REACT_V}/es2022/jsx-runtime.mjs\"|\"react/jsx-runtime\"|g" \
    "$2"
}

fetch "https://esm.sh/react@${REACT_V}/es2022/react.mjs" "$OUT/react.mjs"
fetch "https://esm.sh/react@${REACT_V}/es2022/jsx-runtime.mjs" "$OUT/react-jsx-runtime.mjs"
fetch "https://esm.sh/react-dom@${REACT_V}/es2022/server.edge.bundle.mjs" "$OUT/react-dom-server.mjs"

echo "vendored into $OUT:"
ls -la "$OUT"
echo "remaining absolute imports (should be none):"
grep -o 'from"/[^"]*"' "$OUT"/*.mjs || echo "  none"
