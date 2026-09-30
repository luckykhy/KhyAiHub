#!/usr/bin/env bash
# @pattern Command, Template Method
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

# [LAYOUT-005] 产物单一根：entries/pip（BUILD-OUTPUTS.json 已登记，方案 R-R2 迁入）。
DIST_DIR="$ROOT_DIR/entries/pip"
rm -rf "$DIST_DIR" build khy_os.egg-info

# Packaging law: build the distribution in an ISOLATED clean environment so no
# third-party package-management tree from this checkout can leak into the
# artifacts. Set KHY_OFFLINE_BUILD=1 to fall back to the offline path that
# reuses the already-installed build toolchain (no env resolution / network).
if [[ "${KHY_OFFLINE_BUILD:-0}" == "1" ]]; then
  python3 -m build --no-isolation --sdist --wheel --outdir "$DIST_DIR"
else
  python3 -m build --sdist --wheel --outdir "$DIST_DIR"
fi

# setuptools 残渣（无视 cwd 写在项目根）搬进登记位。
for pair in "build:build" "khy_os.egg-info:egg-info"; do
  src="${pair%%:*}"; dst="$DIST_DIR/${pair##*:}"
  [[ -e "$ROOT_DIR/$src" ]] || continue
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  mv "$ROOT_DIR/$src" "$dst"
done

echo ""
echo "Built artifacts:"
ls -lh "$DIST_DIR"
