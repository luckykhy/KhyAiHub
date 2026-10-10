#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# khy.sh - Linux/macOS launcher for Khy-OS CLI
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Git Bash's `pwd` yields MSYS-style paths ("/d/Portable/khy-os"), which Windows Node
# resolves as "D:\d\Portable\khy-os" (prepends the current drive and treats the leading
# "d" as a literal directory name) -> MODULE_NOT_FOUND. Convert before handing to node.
NODE_SCRIPT_DIR="$SCRIPT_DIR"
if command -v cygpath >/dev/null 2>&1; then
    NODE_SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR")"
fi

# --- khy repair: one-shot portable self-repair (Node only, bypasses python cli) ---
if [[ "${1:-}" == "repair" ]]; then
    if ! command -v node >/dev/null 2>&1; then
        echo "[ERROR] khy repair needs Node.js 20+ in PATH: https://nodejs.org/"
        exit 1
    fi
    export KHYQUANT_PORTABLE_ROOT="$SCRIPT_DIR"
    shift
    node "$NODE_SCRIPT_DIR/delivery/extension/scripts/khy-portable/repair-portable.js" "$@"
    exit $?
fi

# --- Detect Python 3.8+ ---
PYTHON_CMD=""

probe_python() {
    # Probe one candidate binary; accept only real 3.8+. A broken shim (e.g. a
    # Windows store-alias stub under Git Bash) prints nothing and exits
    # non-zero, so probing — not resolving — tells fakes from real installs.
    # Whitespace is stripped because some wrappers emit a trailing space.
    local ver major minor
    ver="$("$1" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null | tr -d '[:space:]')" || return 0
    case "$ver" in
        [1-9]*.[0-9]*) ;;
        *) return 0 ;;
    esac
    major="${ver%%.*}"
    minor="${ver##*.}"
    if [ "$major" -ge 3 ] 2>/dev/null; then
        if [ "$major" -gt 3 ] || [ "$minor" -ge 8 ] 2>/dev/null; then
            PYTHON_CMD="$1"
        fi
    fi
}

for cmd in python3 python; do
    [ -z "$PYTHON_CMD" ] || break
    # Every PATH hit must be probed: the first hit can be a broken shim
    # shadowing a real install further down PATH.
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        probe_python "$candidate"
        [ -z "$PYTHON_CMD" ] || break
    done < <(type -ap "$cmd" 2>/dev/null)
done

if [ -z "$PYTHON_CMD" ] && command -v py >/dev/null 2>&1; then
    ver="$(py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null | tr -d '[:space:]')" || ver=""
    major="${ver%%.*}"
    minor="${ver##*.}"
    if [ "$major" -ge 3 ] 2>/dev/null && { [ "$major" -gt 3 ] || [ "$minor" -ge 8 ] 2>/dev/null; }; then
        PYTHON_CMD="py -3"
    fi
fi

set_portable_env() {
    # Node is resolved by khy_platform.node_provisioner after Python starts.
    # This keeps the launcher usable on machines without a system Node install.
    export KHYQUANT_PORTABLE_ROOT="$SCRIPT_DIR"
    export KHY_PORTABLE_ROOT="$SCRIPT_DIR"
    export KHY_OS_ROOT="$SCRIPT_DIR"
    export KHY_DATA_HOME="${KHY_DATA_HOME:-$SCRIPT_DIR/.khy}"
    export KHY_PROJECT_DATA_HOME="${KHY_PROJECT_DATA_HOME:-$KHY_DATA_HOME}"
    export KHYQUANT_DATA_HOME="${KHYQUANT_DATA_HOME:-$KHY_DATA_HOME}"
    export KHYOS_HOME="${KHYOS_HOME:-$KHY_DATA_HOME}"
    export KHY_RUNTIME_HOME="${KHY_RUNTIME_HOME:-$KHY_DATA_HOME/runtime}"
    export KHY_CACHE_HOME="${KHY_CACHE_HOME:-$KHY_DATA_HOME/cache}"
    export KHY_LOG_HOME="${KHY_LOG_HOME:-$KHY_DATA_HOME/logs}"
    export KHY_TEMP_HOME="${KHY_TEMP_HOME:-$KHY_DATA_HOME/tmp}"
    export KHY_PLATFORM_PATH="$SCRIPT_DIR/runtime/substrate/platform"
    # Tell the platform launcher which entry alias was used (python -m loses argv[0]).
    export KHY_INVOKED_AS="khy"
    # Direct-Node fallback parity: khy_platform.cli pins this for the Node child.
    export KHYQUANT_ROOT="$SCRIPT_DIR/runtime/node/backend"
    export KHYQUANT_INVOKED_AS="khy"
}

if [ -n "$PYTHON_CMD" ]; then
    set_portable_env
    # --- Launch CLI ---
    # Official design: route through the platform launcher (khy_platform), not the
    # khyquant app launcher — the latter forces KHYQUANT_INVOKED_AS=khyquant and the
    # Node backend then blocks platform commands like `khy chat`.
    # Path expansion must happen in Python (os.environ), not bash: the -c script is
    # single-quoted, so bash would hand literal "$VARS" strings to Python.
    exec "$PYTHON_CMD" -c "import os,sys,runpy; sys.path[:0]=[os.environ['KHY_PLATFORM_PATH'], os.path.join(os.environ['KHY_OS_ROOT'],'software','khyquant')]; sys.argv=['khy']+sys.argv[1:]; runpy.run_module('khy_platform', run_name='__main__')" "$@"
fi

# --- Self-heal: no usable Python -> degrade to a direct Node launch ---
# khy_platform.cli is a thin bootstrap; for a source checkout its launch is
# `node backend/bin/khy.js` plus env. Replicate it here so a machine without
# Python still reaches the same CLI instead of dying at the Python probe.
set_portable_env
export GATEWAY_PREFERRED_STRICT="true"
export GATEWAY_RELAY_ENABLED="false"

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] No usable Python 3.8+ and no usable Node.js found; cannot self-heal startup."
    echo "Checked: PATH (with broken-shim probing), py launcher, common Node install locations."
    echo "Please install Python 3.8+: https://www.python.org/downloads/ or Node.js 20+: https://nodejs.org/"
    exit 1
fi

NODE_CLI="$SCRIPT_DIR/runtime/node/backend/bin/khy.js"
if [ ! -f "$NODE_CLI" ]; then
    echo "[ERROR] Node CLI entry not found: $NODE_CLI"
    echo "Please install Python 3.8+: https://www.python.org/downloads/"
    exit 1
fi

echo "Note: Python 3.8+ not found, falling back to direct Node launch of the same CLI."
echo "Permanent fix: install Python 3.8+ (https://www.python.org/downloads/) or run \"khy repair\" for portable installs."
exec node "$NODE_CLI" "$@"
