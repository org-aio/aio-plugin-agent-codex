#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

cargo test --locked
cargo zigbuild --locked --release \
  --target x86_64-unknown-linux-gnu.2.17

mkdir -p dist/frontend
cp frontend/index.html frontend/styles.css frontend/app.js dist/frontend/
codex_target_dir="${CARGO_TARGET_DIR:-target}"
cp "$codex_target_dir/x86_64-unknown-linux-gnu/release/az-agent-codex-server" dist/server
chmod 0755 dist/server
