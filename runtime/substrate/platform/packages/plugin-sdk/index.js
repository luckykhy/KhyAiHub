'use strict';

/**
 * @khy/plugin-sdk — the single source of truth for the khy plugin contract.
 *
 * Two concerns, both exported so the loader and the (future) third-party plugin
 * authors validate against the *same* rules instead of a copy:
 *
 *   1. Manifest validation — `validateManifest()` + `MANIFEST_FIELDS`.
 *      Mirrors [DESIGN-TOOL-002] §3 and the built-in fallback validator that
 *      lives in `services/backend/src/plugin-loader/index.js`. The fallback is
 *      kept byte-compatible: same four required fields, same error strings,
 *      same `{ valid, errors }` shape.
 *
 *   2. Discovery source constants — `SOURCES` / `SOURCE_ORDER` / `PERMISSIONS`.
 *      The loader's six discovery sources are documented as data, not prose,
 *      so a test can pin the contract ("source 4 is lazy, sources 1/2/3/5/6
 *      are eager") without re-deriving it from the loader's source.
 *
 * This package is declared an OPTIONAL peerDependency of the backend — a clean
 * install legitimately lacks it and the loader runs the fallback validator above.
 * It therefore must stay zero-dependency and side-effect-free at require time:
 * no fs, no network, no env reads.
 */

// ── Manifest contract ───────────────────────────────────────────────────────

/**
 * Required manifest fields, with the exact error strings the loader emits when
 * each is missing. Keeping the message here (rather than in the loader) makes
 * the contract assertable: a test can pin that "missing required field: name"
 * is the canonical error for an absent `name`, and the loader's fallback stays
 * in lockstep because it copies the same strings.
 *
 * @type {Array<{ field: string, message: string }>}
 */
const MANIFEST_FIELDS = [
  { field: 'name', message: 'missing required field: name' },
  { field: 'namespace', message: 'missing required field: namespace' },
  { field: 'engines.khy', message: 'missing required field: engines.khy' },
  { field: 'main', message: 'missing required field: main' },
];

/**
 * Validate a khy plugin manifest.
 *
 * Accepts either the canonical `khy.extension.json` body or the legacy
 * `package.json#khy` merged shape (loader's `readManifest` merges `name`/
 * `version` from the npm package onto the `khy` block before validating).
 *
 * @param {*} manifest - The parsed manifest object.
 * @returns {{ valid: boolean, errors: string[] }} `valid` true when every
 *   required field is present and correctly typed; `errors` lists each
 *   missing/typed-wrong field in `MANIFEST_FIELDS` order.
 */
function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('missing required field: name');
  }
  if (!manifest.namespace || typeof manifest.namespace !== 'string') {
    errors.push('missing required field: namespace');
  }
  if (!manifest.engines || typeof manifest.engines.khy !== 'string') {
    errors.push('missing required field: engines.khy');
  }
  if (!manifest.main || typeof manifest.main !== 'string') {
    errors.push('missing required field: main');
  }
  return { valid: errors.length === 0, errors };
}

// ── Discovery source contract ───────────────────────────────────────────────

/**
 * The loader's six discovery sources, in priority order (high → low).
 *
 * The `lazy` flag encodes the eager-vs-deferred boundary from
 * [DESIGN-TOOL-002] §4: directory-scan sources that the user may have simply
 * dropped a folder into are only *indexed* at init (namespace reserved, entry
 * NOT required) and activated on first use; explicit-naming sources activate
 * during init. Pinned here so a test can assert "exactly source 4 is lazy"
 * without scraping the loader.
 *
 * @type {Array<{ source: string, eager: boolean, notes: string }>}
 */
const SOURCES = [
  { source: 'config', eager: true, notes: '~/.khyquant/config.json plugins[] — explicit paths' },
  { source: 'workspace', eager: true, notes: 'node_modules/khy-* under cwd/backend/workspace' },
  { source: 'global', eager: true, notes: 'npm -g prefix/lib/node_modules/khy-*' },
  { source: 'ext:builtin', eager: false, notes: 'extensionRoots scan (KHY_PLUGIN_LAZY_LOAD gates deferral)' },
  { source: 'dir', eager: true, notes: '~/.khyquant/plugins/<name>/ directory scan' },
  { source: 'env', eager: true, notes: 'KHY_PLUGINS=khyquant,khy-notes require.resolve' },
];

/** Stable priority order — the `source` string of each SOURCES entry, top first. */
const SOURCE_ORDER = SOURCES.map((s) => s.source);

/**
 * Permission keys the loader's contextFactory enforces. `network` is the one
 * that gates outbound I/O; the rest are advisory surface declarations.
 * @type {string[]}
 */
const PERMISSIONS = ['network', 'fs', 'shell', 'http'];

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * Build a KhyPlugin-shaped object from a partial definition. Fills in the
 * lifecycle no-ops so authors only implement what they use; the loader
 * requires `activate` to be a function at activation time, so this default
 * makes "I only register commands" a valid plugin.
 *
 * @param {object} def
 * @param {string} [def.name] - Display name
 * @param {string} [def.namespace] - Command/tool prefix
 * @param {(ctx: object) => void|Promise<void>} [def.activate] - lifecycle hook
 * @param {(ctx: object) => void|Promise<void>} [def.deactivate] - lifecycle hook
 * @returns {object} A KhyPlugin-compatible instance.
 */
function defineKhyPlugin(def = {}) {
  return {
    name: def.name || '',
    namespace: def.namespace || '',
    activate: def.activate || (() => {}),
    deactivate: def.deactivate || (() => {}),
  };
}

module.exports = {
  validateManifest,
  MANIFEST_FIELDS,
  SOURCES,
  SOURCE_ORDER,
  PERMISSIONS,
  defineKhyPlugin,
};
