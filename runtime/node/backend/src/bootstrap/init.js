/**
 * init() — memoized, once-only process-level initialization.
 *
 * Runs exactly once per process regardless of how many times it is called.
 * Replaces the inline environment setup scattered across khyquant.js and
 * bootstrap.js.
 *
 * Each step is individually try/caught so a single failure does not block
 * the entire initialization pipeline.
 *
 * Usage:
 *   const { init } = require('./init');
 *   await init(); // safe to call multiple times — returns same promise
 */

const path = require('path');

const { checkpoint } = require('./startupProfiler');
const state = require('./state');

// ── Deferred best-effort init steps ─────────────────────────────────────────
// Measured 2026-10-12: these four steps cost ~218ms inside `await init()` on a
// warm box (ensureProxyCoreEnv 83ms · proxyConfigService 53ms · appRegistry 63ms
// · ensureAuthSecret 19ms) and nothing on the boot path consumes their result
// synchronously — every consumer reads `process.env` / the owning service's
// state lazily, inside a later request or command. So they are moved off the
// boot path with the same `setTimeout(...).unref()`手法 already used by the
// dbHealth step below: a macrotask only fires once the current run-to-completion
// AND the microtask queue are done, i.e. after main() has resumed.
//
// Each step is memoized (one promise per key per process), so a later await
// (shutdown / diagnostics) joins the same run instead of re-executing it.
//
// Escape hatches (every switch keeps a `=0` legacy path):
//   KHY_INIT_DEFER_STEPS=0      → restore the legacy blocking `await` of all four
//   KHY_INIT_DEFER_STEPS_MS=N   → how late to run them (default 0 = next macrotask)

const INIT_STEPS_DEFER_ENV = 'KHY_INIT_DEFER_STEPS';
const INIT_STEPS_DEFER_MS_ENV = 'KHY_INIT_DEFER_STEPS_MS';
const _STEPS_OFF = new Set(['0', 'false', 'off', 'no']);

const _deferredInitSteps = new Map();
let _deferredInitStepsPromise = null;

let _promise = null;
let _dbHealthInitPromise = null;

/**
 * Get the in-flight deferred dbHealthService.init() promise (or null once it
 * settled / when deferral is disabled). Lets shutdown paths await a still
 * running background integrity check instead of racing it.
 * @returns {Promise<void>|null}
 */
function getDbHealthInitPromise() {
  return _dbHealthInitPromise;
}

/**
 * Get the in-flight promise for the four deferred best-effort init steps (or
 * null when they already settled / when deferral is disabled). Lets shutdown and
 * diagnostics await a still-running background step instead of racing it.
 * @returns {Promise<void>|null}
 */
function getDeferredInitStepsPromise() {
  return _deferredInitStepsPromise;
}

/**
 * Run one deferred init step at most once per process; every later caller for
 * the same key joins the same promise.
 * @param {string} key
 * @param {() => void} run
 * @returns {Promise<void>}
 */
function _runDeferredInitStepOnce(key, run) {
  const existing = _deferredInitSteps.get(key);
  if (existing) {
    return existing;
  }
  const promise = Promise.resolve()
    .then(run)
    .catch(() => {
      /* best-effort: a failed step must never reject the shared promise */
    });
  _deferredInitSteps.set(key, promise);
  return promise;
}

/**
 * The four best-effort steps that used to be awaited as one `Promise.allSettled`
 * group before `main()`. `dynamicFreeModelService.warmUp()` is deliberately NOT
 * here — it stays on the boot path (owned elsewhere).
 * @returns {Array<{ key: string, run: () => void }>}
 */
function _buildDeferredInitSteps() {
  return [
    {
      key: 'ensureProxyCoreEnv',
      run: () => {
        const { ensureProxyCoreEnv } = require('./ensureProxyCoreEnv');
        ensureProxyCoreEnv({
          log: (m) => {
            try {
              console.warn(`  ⚠ ${m}`);
            } catch {
              /* ignore */
            }
          },
        });
      },
    },
    {
      key: 'ensureAuthSecret',
      run: () => {
        const { ensureJwtSecret } = require('./ensureAuthSecret');
        ensureJwtSecret({
          log: (m) => {
            try {
              console.warn(`  ⚠ ${m}`);
            } catch {
              /* ignore */
            }
          },
        });
      },
    },
    {
      key: 'proxyConfigService',
      run: () => {
        const proxyConfig = require('../services/proxyConfigService');
        proxyConfig.initFromConfig();
      },
    },
    {
      key: 'appRegistry',
      run: () => {
        const backendDir = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..');
        const appRegistry = require('../services/appRegistry');
        appRegistry.autoRegisterDev(backendDir);
      },
    },
  ];
}

/**
 * Run all one-time initialization steps.
 * Memoized: first call creates the promise, subsequent calls return it.
 * @param {{ machineReadable?: boolean }} [options]
 * @returns {Promise<void>}
 */
function init(options = {}) {
  if (_promise) {
    return _promise;
  }
  _promise = _doInit(options);
  return _promise;
}

async function _doInit(options) {
  checkpoint('init:start');

  // 1. Load .env from canonical env file
  try {
    const envPath = process.env.KHY_ENV_FILE
      ? path.resolve(process.env.KHY_ENV_FILE)
      : path.resolve(process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..'), '.env');
    require('dotenv').config({ path: envPath });
  } catch {
    // dotenv not available or .env missing — proceed with process.env as-is
  }

  // 1.2 Load the user-level persistent env overlay (~/.khy/.env). This is where
  //     `khy claude adopt-env` stores the reused Claude Code credentials
  //     (ANTHROPIC_BASE_URL relay + ANTHROPIC_AUTH_TOKEN, etc.). It lives OUTSIDE
  //     site-packages, so `pip install -U` never overwrites it — configure once,
  //     every future upgrade still works. Loaded with override:false so a real
  //     shell env always wins; it only fills vars that are otherwise unset, which
  //     reproduces the normal env code path (source-aware AUTH_TOKEN → Bearer).
  try {
    const os = require('os');
    const userEnvPath = (() => {
      try {
        return path.join(require('../utils/dataHome').getDataHome(), '.env');
      } catch {
        return path.join(os.homedir(), '.khy', '.env');
      }
    })();
    require('dotenv').config({ path: userEnvPath, override: false });
  } catch {
    // Overlay is optional; absence is the common case.
  }

  // 1.15 Expand `{env:VAR}` cross-references now that BOTH env layers are loaded
  //      (canonical .env + ~/.khy/.env overlay). Must run after the overlay so a
  //      placeholder can point at a variable defined in either file. dotenv does
  //      not do this itself — without it `RELAY_API_KEY={env:STEPFUN_API_KEY}`
  //      ships literally as `Bearer {env:STEPFUN_API_KEY}` → 401 on every relay call.
  try {
    const { expandEnvPlaceholders } = require('./expandEnvPlaceholders');
    expandEnvPlaceholders(process.env);
  } catch {
    /* expansion is best-effort; raw values still flow through */
  }

  // 1.3 warmUp is deliberately left exactly as it was: fire-and-forget inside
  //     the old `Promise.allSettled` group, i.e. never awaited by `init()`.
  //     dynamicFreeModelService.js is owned elsewhere, so this call site keeps
  //     its original shape (including not awaiting the returned promise).
  try {
    const dynamicFreeModelService = require('../services/dynamicFreeModelService');
    dynamicFreeModelService.warmUp();
  } catch {
    /* dynamicFreeModelService not available */
  }

  // 1.4-1.7 Four best-effort init steps, moved off the boot path.
  //      They are memoized fire-and-forget: nothing between `await init()` and
  //      the first user-visible action reads their result synchronously
  //      (checked per call site 2026-10-12 — every consumer of JWT_SECRET,
  //      KHY_PROXY_CORE, the active proxy and the dev app entry reads it lazily
  //      inside a later request/command, never at module load).
  const _steps = _buildDeferredInitSteps();
  const _stepsDeferRaw = String(process.env[INIT_STEPS_DEFER_ENV] ?? '')
    .trim()
    .toLowerCase();
  const _stepsDeferred = !_STEPS_OFF.has(_stepsDeferRaw);
  const _stepsDelayRaw = Number.parseInt(String(process.env[INIT_STEPS_DEFER_MS_ENV] ?? ''), 10);
  const _stepsDelayMs = Number.isFinite(_stepsDelayRaw) && _stepsDelayRaw >= 0 ? _stepsDelayRaw : 0;
  const _runAllDeferredSteps = () =>
    Promise.allSettled(_steps.map((step) => _runDeferredInitStepOnce(step.key, step.run)));
  if (_stepsDeferred) {
    // Truly off the boot path: a macrotask timer only fires once the current
    // run-to-completion is done AND the microtask queue is empty, i.e. after
    // main() has resumed. `Promise.resolve().then(...)` would look deferred but
    // is not — a microtask still drains before the caller's continuation.
    //
    // unref'd so a one-shot command still exits immediately; shutdown paths can
    // join the in-flight run via getDeferredInitStepsPromise().
    _deferredInitStepsPromise = new Promise((resolve) => {
      const _timer = setTimeout(() => {
        _runAllDeferredSteps().finally(resolve);
      }, _stepsDelayMs);
      if (_timer.unref) {
        _timer.unref();
      }
    });
  } else {
    // KHY_INIT_DEFER_STEPS=0 — legacy blocking behaviour, byte-for-byte.
    await _runAllDeferredSteps();
  }

  // 2. Database health service initialization.
  //    Deferred by default (KHY_DB_HEALTH_DEFER=0 restores the legacy blocking
  //    await): the startup integrity check is pure defense — nothing in the
  //    boot path consumes its result — yet it serially opens and integrity-
  //    checks every known SQLite file (~100ms warm, growing with DB count and
  //    size) before the REPL input box is ready. Run it on the background tick
  //    instead and export the in-flight promise for shutdown/diagnostics.
  checkpoint('init:dbHealth:start');
  const _deferDbHealth = String(process.env.KHY_DB_HEALTH_DEFER ?? '1').trim() !== '0';
  try {
    const dbHealthService = require('../services/dbHealthService');
    const _initDbHealth = async () => {
      try {
        await dbHealthService.init({ silentConsole: options.machineReadable === true });
      } catch (err) {
        // Non-fatal: log and continue. Database health is defensive — if init fails,
        // the databases might still work, just without auto-healing.
        try {
          console.warn(`  ⚠ Database health service init failed: ${err.message}`);
        } catch {
          /* ignore */
        }
      } finally {
        checkpoint('init:dbHealth:done');
      }
    };
    if (_deferDbHealth) {
      // Truly off the boot path.
      //
      // This used to be `Promise.resolve().then(_initDbHealth)`, which *looked*
      // deferred but was not: a microtask still drains BEFORE the caller's
      // `await init()` continuation resumes, so the synchronous `PRAGMA
      // quick_check` bursts inside dbHealthService.init() (hundreds of ms per
      // large database, measured ~1.0-1.5s on a 28MB sessions.db) ran before
      // main() could take a single further step. The checkpoint timeline showed
      // `init:done` -> `main:start` as a ~1.1s gap that the boot path paid in
      // full, on every launch.
      //
      // A macrotask timer only fires once the current run-to-completion is done
      // AND the microtask queue is empty, i.e. after main() has resumed, mounted
      // the REPL/TUI and printed the first prompt. The integrity check is pure
      // defence — nothing in the boot path consumes its result — so running it
      // late costs nothing.
      //
      // KHY_DB_HEALTH_DEFER_MS tunes how late (default 2500ms; 0 = next macrotask).
      // The timer is unref'd so a one-shot command (`khy status`) still exits
      // immediately instead of waiting for the check.
      const _delayRaw = Number.parseInt(String(process.env.KHY_DB_HEALTH_DEFER_MS ?? ''), 10);
      const _delayMs = Number.isFinite(_delayRaw) && _delayRaw >= 0 ? _delayRaw : 2500;
      _dbHealthInitPromise = new Promise((resolve) => {
        const _timer = setTimeout(() => {
          _initDbHealth().finally(resolve);
        }, _delayMs);
        if (_timer.unref) {
          _timer.unref();
        }
      });
    } else {
      await _initDbHealth();
    }
  } catch {
    /* dbHealthService not available — it is defensive only */
  }

  // 8. Mark as initialized
  state.set('initialized', true);

  checkpoint('init:done');
}

/**
 * Check if init has completed without triggering it.
 */
function isComplete() {
  return state.get('initialized');
}

module.exports = { init, isComplete, getDbHealthInitPromise, getDeferredInitStepsPromise };
