'use strict';

/**
 * gelabConfig.js — the one place GELab-Zero settings are resolved.
 *
 * WHY a config leaf of its own. Two rules converge here:
 *
 *   1. R2 (密钥防泄露). The API key is the only secret in this unit. It is read
 *      from the environment, never from a file, never given a placeholder
 *      default, and never copied into any other returned field — so `status`
 *      and the plan text can be logged freely. `keyFromEnv` exists so the
 *      caller can report honestly whether a key is present without ever
 *      showing it.
 *
 *   2. No scattered literals. The model name appears exactly once in this file
 *      (check-model-hardcoding enforces it), and the base URL comes from
 *      serviceDefaults rather than a `localhost` literal, so pointing the agent
 *      at a remote Ollama is an env change and not a code change.
 *
 * Contract: pure, total, never throws. Every field has a default; every default
 * is a number or a string, never undefined.
 */

const { OLLAMA_OPENAI_BASE_URL } = require('../../../../../constants/serviceDefaults');

/** The only place the default model name is written. */
const DEFAULT_MODEL = 'gelab-zero-4b';

const DEFAULTS = Object.freeze({
  // ── model ────────────────────────────────────────────────────────────────
  temperature: 0.1,
  topP: 0.95,
  maxTokens: 4096,
  imageWidth: 728,
  imageQuality: 60,
  timeoutMs: 120000,

  // ── agent loop ───────────────────────────────────────────────────────────
  // maxSteps is 100 against upstream's 400. Upstream's number assumes a PC-side
  // loop with no human watching; 400 steps of a model tapping a real phone is
  // a lot of unsupervised touching, and the tool schema caps at 200 anyway.
  maxSteps: 100,
  deadlineMs: 600000,
  stepDeadlineMs: 60000,
  // Upstream's delay_after_capture is 2 (seconds). Matched rather than
  // invented: a shorter delay captures a screen that is still animating.
  captureDelayMs: 2000,
  screenRetries: 3,
  screenMinBytes: 2048,
  historySteps: 12,
  historyChars: 24000,
  noteChars: 2000,
  keepImages: 1,
  sessionTtlMs: 1800000,
  adbBackend: true,
  geometryRefreshSteps: 1,
  sensitiveGuard: true,
  verifyEachStep: true,
  feedback: true,
  // Ceiling on the long-press duration forwarded to the bridge. This was 1500
  // while the bridge's gesture latch waited a hardcoded 2s regardless of the
  // requested duration, so anything above ~1900ms was reported as "gesture
  // cancelled" even though it ran — a silent failure. That latch is fixed (it
  // now waits durationMs + 500ms), so the ceiling is the bridge's own 10000
  // limit rather than a workaround. If the latch ever regresses, drop this back
  // to 1500: the failure is silent, so the guard is cheap insurance.
  longpressMaxMs: 10000,
});

function num(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function bool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const s = String(raw).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(s)) {
    return false;
  }
  if (['1', 'true', 'on', 'yes'].includes(s)) {
    return true;
  }
  return fallback;
}

/**
 * Resolve the whole configuration from an environment map.
 *
 * @param {object} [env] defaults to process.env
 * @returns {{
 *   model: {baseUrl:string, model:string, apiKey:string|null, keyFromEnv:boolean,
 *           temperature:number, topP:number, maxTokens:number,
 *           imageWidth:number, imageQuality:number, timeoutMs:number},
 *   agent: {maxSteps:number, deadlineMs:number, stepDeadlineMs:number,
 *           captureDelayMs:number, screenRetries:number, screenMinBytes:number,
 *           historySteps:number, historyChars:number, noteChars:number,
 *           keepImages:number, sessionTtlMs:number, adbBackend:boolean,
 *           geometryRefreshSteps:number, sensitiveGuard:boolean,
 *           verifyEachStep:boolean, feedback:boolean, longpressMaxMs:number},
 *   gates: {enabled:boolean, toolEnabled:boolean}
 * }}
 */
function resolveGelabConfig(env = process.env) {
  const e = env || {};

  // The key is read once and never re-derived. Absent means null, NOT a
  // placeholder: a placeholder would make a misconfigured deployment look
  // configured, and would put a fake credential into every error path.
  const rawKey = typeof e.KHY_GELAB_API_KEY === 'string' ? e.KHY_GELAB_API_KEY.trim() : '';
  const apiKey = rawKey.length > 0 ? rawKey : null;

  const model = {
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    model: typeof e.KHY_GELAB_MODEL === 'string' && e.KHY_GELAB_MODEL.trim()
      ? e.KHY_GELAB_MODEL.trim()
      : DEFAULT_MODEL,
    apiKey,
    keyFromEnv: apiKey !== null,
    temperature: num(e, 'KHY_GELAB_TEMPERATURE', DEFAULTS.temperature, 0, 2),
    topP: num(e, 'KHY_GELAB_TOP_P', DEFAULTS.topP, 0, 1),
    maxTokens: num(e, 'KHY_GELAB_MAX_TOKENS', DEFAULTS.maxTokens, 1, 32768),
    imageWidth: num(e, 'KHY_GELAB_IMAGE_WIDTH', DEFAULTS.imageWidth, 64, 2048),
    imageQuality: num(e, 'KHY_GELAB_IMAGE_QUALITY', DEFAULTS.imageQuality, 10, 100),
    timeoutMs: num(e, 'KHY_GELAB_TIMEOUT_MS', DEFAULTS.timeoutMs, 1000, 3600000),
  };

  const agent = {
    maxSteps: num(e, 'KHY_GELAB_MAX_STEPS', DEFAULTS.maxSteps, 1, 200),
    deadlineMs: num(e, 'KHY_GELAB_DEADLINE_MS', DEFAULTS.deadlineMs, 10000, 3600000),
    stepDeadlineMs: num(e, 'KHY_GELAB_STEP_DEADLINE_MS', DEFAULTS.stepDeadlineMs, 1000, 600000),
    captureDelayMs: num(e, 'KHY_GELAB_CAPTURE_DELAY_MS', DEFAULTS.captureDelayMs, 0, 30000),
    screenRetries: num(e, 'KHY_GELAB_SCREEN_RETRIES', DEFAULTS.screenRetries, 0, 10),
    screenMinBytes: num(e, 'KHY_GELAB_SCREEN_MIN_BYTES', DEFAULTS.screenMinBytes, 0, 1048576),
    historySteps: num(e, 'KHY_GELAB_HISTORY_STEPS', DEFAULTS.historySteps, 1, 100),
    historyChars: num(e, 'KHY_GELAB_HISTORY_CHARS', DEFAULTS.historyChars, 1000, 500000),
    noteChars: num(e, 'KHY_GELAB_NOTE_CHARS', DEFAULTS.noteChars, 0, 20000),
    keepImages: num(e, 'KHY_GELAB_KEEP_IMAGES', DEFAULTS.keepImages, 0, 10),
    sessionTtlMs: num(e, 'KHY_GELAB_SESSION_TTL_MS', DEFAULTS.sessionTtlMs, 60000, 86400000),
    adbBackend: bool(e, 'KHY_GELAB_ADB_BACKEND', DEFAULTS.adbBackend),
    geometryRefreshSteps: num(e, 'KHY_GELAB_GEOMETRY_REFRESH_STEPS', DEFAULTS.geometryRefreshSteps, 1, 100),
    sensitiveGuard: bool(e, 'KHY_GELAB_SENSITIVE_GUARD', DEFAULTS.sensitiveGuard),
    verifyEachStep: bool(e, 'KHY_GELAB_VERIFY_EACH_STEP', DEFAULTS.verifyEachStep),
    feedback: bool(e, 'KHY_GELAB_FEEDBACK', DEFAULTS.feedback),
    // Ceiling on the long-press duration we will forward to the bridge. The
    // bridge's gesture latch historically waited a fixed 2s regardless of the
    // requested duration, so anything above ~1900ms was reported as "gesture
    // cancelled" even though it ran. Capping here is the honest workaround
    // until that latch is fixed; it is a compromise, not a fix, and says so.
    longpressMaxMs: num(e, 'KHY_GELAB_LONGPRESS_MAX_MS', DEFAULTS.longpressMaxMs, 200, 10000),
  };

  const gates = {
    enabled: bool(e, 'KHY_GELAB_AGENT', true),
    toolEnabled: bool(e, 'KHY_GELAB_AGENT_TOOL', true),
  };

  return { model, agent, gates };
}

module.exports = {
  resolveGelabConfig,
  DEFAULT_MODEL,
  GELAB_DEFAULTS: DEFAULTS,
};
