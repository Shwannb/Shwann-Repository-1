#!/usr/bin/env bash
# Build a downloadable tarball of the Safyr Deal Terminal repo.
# Excludes node_modules, the Next.js build output, git history, and any
# local .env files. The resulting archive can be `tar -xzf`'d and brought
# up with `docker compose up --build`.
#
# Usage: scripts/pack.sh [output-path]
# Default output: ./dist/safyr-deal-terminal-phase1.tar.gz

set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$repo_dir/dist/safyr-deal-terminal-phase1.tar.gz}"
mkdir -p "$(dirname "$out")"

parent="$(dirname "$repo_dir")"
name="$(basename "$repo_dir")"

tar -czf "$out" \
  -C "$parent" \
  --exclude="$name/node_modules" \
  --exclude="$name/.next" \
  --exclude="$name/.git" \
  --exclude="$name/dist" \
  --exclude="$name/tsconfig.tsbuildinfo" \
  --exclude="$name/.env" \
  --exclude="$name/.env.local" \
  --transform "s,^$name,safyr-deal-terminal," \
  "$name"

size=$(du -h "$out" | cut -f1)
count=$(tar -tzf "$out" | wc -l | tr -d ' ')
echo "wrote $out ($size, $count entries)"
