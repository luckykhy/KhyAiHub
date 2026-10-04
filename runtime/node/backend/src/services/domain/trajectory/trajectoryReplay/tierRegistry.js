'use strict';

/**
 * tierRegistry.js — replay tier classification (DESIGN-ARCH-048).
 *
 * Single frozen source of truth mapping a tool name to one of three replay
 * tiers. The replay engine gates re-execution on the tier:
 *   - FILE        → auto-replayed (deterministic file mutation).
 *   - SHELL       → replayed only when pre-approved/confirmed (effects beyond files).
 *   - NETWORK_AI  → never replayed; non-deterministic, surfaced as "not reproduced".
 *
 * Unknown tools default to SHELL — the most conservative *replayable* tier
 * (requires explicit approval), never silently auto-FILE. 防呆: classification
 * is pure and total; it never throws.
 */

const TIER = Object.freeze({
  FILE: 'FILE',
  SHELL: 'SHELL',
  NETWORK_AI: 'NETWORK_AI',
});

// File-mutating tools — derived from the single source tools/_writeToolNames.js
// (the capture whitelist) PLUS the multi-file mutators (apply_patch /
// scaffold_files): the replay FILE tier classifies the whole TURN, which is
// orthogonal to whether a single-path diff is renderable — capture deliberately
// skips those two (see the leaf's header), but a turn that ran them is still a
// file-mutating turn and must land in the FILE tier.
const { WRITE_TOOL_NAMES: _CAPTURE_WRITE_TOOLS } = require(
  '../../../../tools/_writeToolNames'
);
const FILE_TOOLS = Object.freeze(
  new Set([..._CAPTURE_WRITE_TOOLS, 'applypatch', 'scaffoldfiles'])
);

// Shell / process-executing tools.
const SHELL_TOOLS = Object.freeze(
  new Set([
    'shellcommand',
    'shell',
    'bash',
    'sh',
    'executecommand',
    'exec',
    'runcommand',
    'run',
    'executecode',
    'command',
  ])
);

// Network / model-invoking tools — never deterministically reproducible.
const NETWORK_AI_TOOLS = Object.freeze(
  new Set([
    'websearch',
    'webfetch',
    'fetch',
    'search',
    'browse',
    'agent',
    'task',
    'subagent',
    'imagegenerate',
    'webintelligence',
  ])
);

/** Normalize a tool name: lowercase + strip whitespace/underscore/dash. */
function normalize(name) {
  if (name == null) {
    return '';
  }
  return String(name)
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/**
 * Classify a tool name into a tier.
 * @param {string} name
 * @returns {'FILE'|'SHELL'|'NETWORK_AI'|'UNKNOWN'}
 */
function classify(name) {
  const n = normalize(name);
  if (!n) {
    return 'UNKNOWN';
  }
  if (FILE_TOOLS.has(n)) {
    return TIER.FILE;
  }
  if (SHELL_TOOLS.has(n)) {
    return TIER.SHELL;
  }
  if (NETWORK_AI_TOOLS.has(n)) {
    return TIER.NETWORK_AI;
  }
  return 'UNKNOWN';
}

/**
 * Resolve the effective replay tier the engine acts on: UNKNOWN collapses to
 * SHELL (conservative — requires approval, never auto-FILE).
 * @param {string} name
 * @returns {'FILE'|'SHELL'|'NETWORK_AI'}
 */
function effectiveTier(name) {
  const t = classify(name);
  return t === 'UNKNOWN' ? TIER.SHELL : t;
}

module.exports = {
  TIER,
  FILE_TOOLS,
  SHELL_TOOLS,
  NETWORK_AI_TOOLS,
  normalize,
  classify,
  effectiveTier,
};
