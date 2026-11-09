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
    # Drop the Python-probe cache: repair may provision a portable Python, and a
    # cached "none" would keep sending us to Node until the PATH signature moved.
    rm -f "${KHY_CACHE_HOME:-$SCRIPT_DIR/.khy/cache}/py-probe.txt" 2>/dev/null || true
    shift
    node "$NODE_SCRIPT_DIR/delivery/extension/scripts/khy-portable/repair-portable.js" "$@"
    exit $?
fi

# --- Detect Python 3.8+ ---
PYTHON_CMD=""

# Same negative-result cache khy.bat keeps, same file format, same PATH
# signature (first/last 48 chars). The probe is two `type -ap` PATH scans plus a
# `py -3` spawn; its answer only changes when PATH does, so a Python-less box
# pays it once rather than once per command. A change in the middle of PATH is
# not detected; the failure mode is benign (we fall through to the Node launch,
# which is the same CLI) and `khy repair` / KHY_PY_PROBE_REFRESH=1 force a
# re-probe. The declarations mirror khy.bat's early block because :set_portable_env
# runs after this point.
#
# 早探测只需要一个**缓存**落点（py-probe.txt），不需要数据家。
# 这里**刻意不设** KHY_DATA_HOME：:set_portable_env（后面的 :149）会用
# "$SCRIPT_DIR/works/data/khy" 作为默认值（与 khy-env.bat 逐行对齐）。早先把
# KHY_DATA_HOME 设成 "$SCRIPT_DIR/.khy" 会让那个默认值永远不生效 —— POSIX 侧的数据家
# 就与 Windows 侧分叉了，而且在仓库根留下一棵 .khy 影子树（违反 CLAUDE.md §二 B8，
# 也会被 check-repo-layout 的 root-shadow-dir 拦下）。
if [ -z "${KHY_CACHE_HOME:-}" ]; then KHY_CACHE_HOME="$SCRIPT_DIR/works/data/khy/cache"; fi
PY_CACHE="$KHY_CACHE_HOME/py-probe.txt"
PYSIG1="${PATH:0:48}"
PYSIG2="${PATH: -48}"
PYSIG_HITS=0
PY_CACHED=""
if [ "${KHY_PY_PROBE_REFRESH:-}" != "1" ] && [ -f "$PY_CACHE" ]; then
    while IFS='=' read -r _py_key _py_val; do
        case "$_py_key" in
            sig1) if [ "$_py_val" = "$PYSIG1" ]; then PYSIG_HITS=$((PYSIG_HITS + 1)); fi ;;
            sig2) if [ "$_py_val" = "$PYSIG2" ]; then PYSIG_HITS=$((PYSIG_HITS + 1)); fi ;;
            py)   PY_CACHED="$_py_val" ;;
        esac
    done < "$PY_CACHE"
fi
if [ "$PYSIG_HITS" -eq 2 ]; then
    # Both signature lines matched; a single match would mean a truncated or
    # hand-edited cache, which is treated as a miss rather than a stale hit.
    if [ "$PY_CACHED" != "none" ]; then
        _py_first="${PY_CACHED%% *}"
        if command -v "$_py_first" >/dev/null 2>&1; then PYTHON_CMD="$PY_CACHED"; fi
    fi
else
    probe_python() {
        # Probe one candidate binary; accept only real 3.8+. A broken shim (e.g. a
        # Windows store-alias stub under Git Bash) prints nothing and exits
        # non-zero, so probing — not resolving — tells fakes from real installs.
        # Whitespace is stripped with parameter expansion rather than a piped
        # `tr`: one process per candidate otherwise, and the stub candidates are
        # skipped before we get here anyway.
        local ver major minor
        ver="$("$1" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)" || return 0
        ver="${ver//[[:space:]]/}"
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
        # shadowing a real install further down PATH. The WindowsApps store-alias
        # stub is recognised from `type -ap` output alone and never executed —
        # launching it costs ~1s each and always fails, which is the single
        # largest slice of startup on a Python-less box.
        while IFS= read -r candidate; do
            [ -n "$candidate" ] || continue
            case "$candidate" in
                */WindowsApps/*) continue ;;
            esac
            probe_python "$candidate"
            [ -z "$PYTHON_CMD" ] || break
        done < <(type -ap "$cmd" 2>/dev/null)
    done

    if [ -z "$PYTHON_CMD" ] && command -v py >/dev/null 2>&1; then
        ver="$(py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)" || ver=""
        ver="${ver//[[:space:]]/}"
        major="${ver%%.*}"
        minor="${ver##*.}"
        if [ "$major" -ge 3 ] 2>/dev/null && { [ "$major" -gt 3 ] || [ "$minor" -ge 8 ] 2>/dev/null; }; then
            PYTHON_CMD="py -3"
        fi
    fi
fi

# Persist the answer, unless the caller asked for a forced re-probe.
if [ "${KHY_PY_PROBE_REFRESH:-}" != "1" ]; then
    if mkdir -p "$KHY_CACHE_HOME" 2>/dev/null; then
        py_out="none"
        if [ -n "$PYTHON_CMD" ]; then py_out="$PYTHON_CMD"; fi
        printf 'sig1=%s\nsig2=%s\npy=%s\n' "$PYSIG1" "$PYSIG2" "$py_out" >"$PY_CACHE" 2>/dev/null || true
    fi
fi

set_portable_env() {
    # Node is resolved by khy_platform.node_provisioner after Python starts.
    # This keeps the launcher usable on machines without a system Node install.
    export KHYQUANT_PORTABLE_ROOT="$SCRIPT_DIR"
    export KHY_PORTABLE_ROOT="$SCRIPT_DIR"
    export KHY_OS_ROOT="$SCRIPT_DIR"
    # Defaults now match khy-env.bat (the single source khy.bat calls) line for
    # line, so the same command sees the same sessions and cache on Windows and
    # POSIX. They used to point at "$SCRIPT_DIR/.khy" while khy.bat pointed at
    # "works\data\khy", which left two parallel state trees on disk.
    #
    # Env still wins over these defaults (the ${VAR:-...} form), matching
    # khy-env.bat's `if not defined` guards.
    #
    # NOTE: changing this table does NOT move an existing installation. The data
    # home is hard-pinned by ~/.khy/.location.json (base dataHome,
    # pinnedReason "established-wins") and by works/data/khy/.location.json
    # (project dataHome, pinnedReason "repair-recalibrate"); the pointer file
    # overrides any default here. Migrating a live install means running
    # delivery/extension/scripts/khy-portable/consolidate-khy-data.js first and
    # then clearing the stale pointer -- a data migration, not a code change.
    export KHY_DATA_HOME="${KHY_DATA_HOME:-$SCRIPT_DIR/works/data/khy}"
    export KHY_PROJECT_DATA_HOME="${KHY_PROJECT_DATA_HOME:-$SCRIPT_DIR/works/data/khy}"
    export KHYQUANT_DATA_HOME="${KHYQUANT_DATA_HOME:-$KHY_DATA_HOME}"
    export KHYOS_HOME="${KHYOS_HOME:-$SCRIPT_DIR/works/data/khyos}"
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
    # Windows console handshake, same one khy.bat exports: tells bin/khy.js the
    # console is already UTF-8 so it skips its own synchronous chcp.com spawn
    # (measured 230-475ms on the startup path). Only meaningful under MSYS/Cygwin
    # where the Node child is a native Windows process on a UTF-8 terminal; on
    # Linux/macOS khy.js ignores the var because it gates on
    # process.platform === 'win32'.
    case "$(uname -s 2>/dev/null)" in
        MINGW* | MSYS* | CYGWIN*) export KHY_CONSOLE_CP=65001 ;;
    esac
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

# The fallback note is printed once per data home, not once per launch: it
# describes an environment fact, and re-printing it on every command both spams
# scripts/CI output and misleads — the Node fallback below works, so "Permanent
# fix: install Python" is not an action the user needs to take. Delete the
# marker file to see it again. Same wording as khy.bat.
PY_NOTE_FILE="$KHY_CACHE_HOME/python-fallback-noted"
if [ ! -f "$PY_NOTE_FILE" ]; then
    echo "Note: Python 3.8+ not found, launching the same CLI directly through Node."
    echo "This machine works fine as-is; install Python only if you need the Python toolchain."
    if mkdir -p "$KHY_CACHE_HOME" 2>/dev/null; then
        echo ok >"$PY_NOTE_FILE" 2>/dev/null || true
    fi
fi
exec node "$NODE_CLI" "$@"
