'use strict';

// Child-process environment hygiene (borrowed conclusion, idea档):
// AI-driven shell subprocesses inherit the parent's full environment by
// default, so token/secret-shaped variable names are stripped before spawn
// unless explicitly allowed. Blacklist-shaped on purpose: whitelist-only env
// breaks git/npm/cloud CLIs that need many ordinary variables.

const SENSITIVE_NAME_RE =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH)(_|$)/i;

function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_CHILD_ENV_POLICY == null ? '' : e.KHY_CHILD_ENV_POLICY;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function isSensitiveName(name) {
  return SENSITIVE_NAME_RE.test(String(name == null ? '' : name));
}

function _allowSet(allow) {
  if (!allow) return null;
  const list = Array.isArray(allow)
    ? allow
    : String(allow).split(',');
  const set = new Set();
  for (const a of list) {
    const name = String(a == null ? '' : a).trim();
    if (name) set.add(name.toUpperCase());
  }
  return set.size > 0 ? set : null;
}

function buildChildEnv(parentEnv, options) {
  const opts = options || {};
  const gateEnv = opts.envOverrides || parentEnv;
  if (!isEnabled(gateEnv)) return parentEnv;
  const src = parentEnv == null ? {} : parentEnv;
  const allow = _allowSet(opts.allow);
  const out = {};
  for (const key of Object.keys(src)) {
    if (!isSensitiveName(key) || (allow && allow.has(key.toUpperCase()))) {
      out[key] = src[key];
    }
  }
  return out;
}

module.exports = { isEnabled, isSensitiveName, buildChildEnv };
