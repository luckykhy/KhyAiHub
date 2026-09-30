#!/usr/bin/env bash
# @pattern Command, Template Method, Visitor
#
# Isolated clean build + distribution purity audit.
#
# Enforces two of the goal's packaging laws in one pass:
#   1. Build the distribution in an ISOLATED clean environment so no
#      third-party package-management directory from this working tree can
#      leak into the artifacts (`python -m build` with build isolation).
#   2. Audit the produced sdist + wheel: the multi-language workshop source
#      and lock files must be present, while NO third-party dependency tree
#      (node_modules, site-packages, bower_components, …) or compiled
#      build output may be bundled.
#
# Exit non-zero on the first purity violation so CI / the verification flow
# can react. First-party vendored code (services/backend/vendor/shared, the
# @khy/shared package) is explicitly allowed; only foreign dependency trees
# are rejected.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

# [LAYOUT-005] 构建产物单一根：pip 产物落 entries/pip（BUILD-OUTPUTS.json 已登记），
# 2026-09-29 由根级 dist/ 迁入（方案 R-R2，[DESIGN-LAY-008] §12.55）——与 build-pip-dist.js 同一常量语义。
DIST_DIR="$ROOT_DIR/entries/pip"
NO_ISOLATION='0'   # default: isolated build (the packaging law)
SKIP_BUILD='0'

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/build-and-audit-pip-purity.sh [options]

Options:
  --no-isolation   Build with `python -m build --no-isolation` (offline env
                   that already has build/setuptools/wheel installed). The
                   default builds in an isolated environment.
  --skip-build     Audit existing artifacts in ./entries/pip without rebuilding.
  --dist-dir PATH  Distribution directory (default: ./entries/pip)
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-isolation) NO_ISOLATION='1'; shift ;;
    --skip-build)   SKIP_BUILD='1'; shift ;;
    --dist-dir)     DIST_DIR="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# ── 1. Isolated clean build ──────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == '0' ]]; then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required"
  python3 -c 'import build' 2>/dev/null || fail \
    "python 'build' module missing — run: python3 -m pip install build"

  info "Assembling standalone zero-dependency runtime..."
  node scripts/release/assemble-pip-runtime.js

  # No mermaid prebuild here on purpose. docs/19_资产/site/mermaid.min.js is a 3.12 MB
  # regenerable product that pip_packaging_rules.py now EXCLUDES from the sdist,
  # so building it before packing would install ~126 MB of npm tooling to produce
  # a file the very next step throws away. sdist consumers regenerate it with
  # `npm run docs:mermaid` before `khy docs:build`; the generator ships in the
  # sdist under scripts/docs/mermaid-embed/.

  info "Verifying MANIFEST.in sync..."
  python3 scripts/release/check_manifest_sync.py

  info "Cleaning previous build outputs..."
  rm -rf "$DIST_DIR" build khy_os.egg-info platform/khy_os.egg-info

  # 别试图把构建 cwd 挪到临时目录来"保持仓库根干净"：`python -m build <srcdir>` 会自己
  # chdir 到 srcdir，setuptools 的 build/、*.egg-info/ 与 sdist 暂存树 khy_os-<version>/
  # **全都写在项目根**，与调用方 cwd 无关。前两者已被 .gitignore 覆盖；
  # 只有暂存树会在构建期间短暂出现在 `??` 里（构建结束即被清掉）。
  if [[ "$NO_ISOLATION" == '1' ]]; then
    warn "Building WITHOUT isolation (offline mode)."
    python3 -m build --no-isolation --sdist --wheel --outdir "$DIST_DIR"
  else
    info "Building in ISOLATED clean environment..."
    python3 -m build --sdist --wheel --outdir "$DIST_DIR"
  fi

  # setuptools 残渣（无视 cwd 写在项目根）搬进登记位（[LAYOUT-005] 单一根）。
  for pair in "build:build" "khy_os.egg-info:egg-info"; do
    src="${pair%%:*}"; dst="$ROOT_DIR/entries/pip/${pair##*:}"
    [[ -e "$ROOT_DIR/$src" ]] || continue
    rm -rf "$dst"
    mkdir -p "$(dirname "$dst")"
    mv "$ROOT_DIR/$src" "$dst"
    info "Relocated $src/ -> ${dst#$ROOT_DIR/}"
  done
fi

[[ -d "$DIST_DIR" ]] || fail "Distribution directory not found: $DIST_DIR"
info "Auditing built artifacts..."
python3 scripts/release/audit_pip_artifacts.py --dist-dir "$DIST_DIR"
