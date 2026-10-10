'use strict';

/**
 * goldenFrames.js — golden-frame ANSI snapshot regression for the TUI.
 *
 * [MGMT-RPT-031] P1-4. The ink/node-pty `reconstruct-terminal` harness needs a
 * PTY and an `--experimental-vm-modules` CI job (neither exists on this repo's
 * default test path, see bootScreenVisual.test.js header), so the goldens here
 * cover the OTHER end of the rendering pipeline instead: the pure ANSI
 * transformations — scrollbackPreserve's four-layer clear-terminal normalizer
 * being the single most delicate one (3J strip / ED2→H+J rewrite / static
 * reprint suppression / tailcut). Text in, text out, fully deterministic —
 * a byte-level golden works without any PTY.
 *
 * Pure leaf: zero IO on the comparison path (only matchGolden reads/writes the
 * snapshot file when told to), deterministic, never throws.
 *
 * Golden files store the ESCAPE-VISIBLE form (`\x1b` as four literal
 * characters) so they stay plain diffable text and survive editors/mirrors
 * that eat raw control bytes — the same discipline scrollbackPreserve.js uses
 * for its own ESC literals.
 *
 * Update flow: run tests with `KHY_GOLDEN_UPDATE=1` to rewrite goldens from
 * current output (then inspect the diff by hand — an update that "just passes"
 * without review is a snapshot nobody trusts).
 */

const fs = require('fs');
const path = require('path');

/** Raw ESC byte, derived — never embedded as a literal (editor/mirror hazard). */
const ESC = String.fromCharCode(27);

/** Raw → escape-visible (`\x1b[2J` as 4+3 literal chars). */
function escapeVisible(text) {
  return String(text).split(ESC).join('\\x1b');
}

/** Escape-visible → raw (replay from a golden file). */
function fromVisible(text) {
  return String(text).split('\\x1b').join(ESC);
}

/**
 * Line-level diff over the escape-visible forms. Returns the first
 * `maxLines` differing lines; equal when `lines.length === 0`.
 */
function diffFrames(actual, expected, maxLines = 12) {
  const a = String(actual).split('\n');
  const b = String(expected).split('\n');
  const lines = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && lines.length < maxLines; i++) {
    if (a[i] !== b[i]) {
      lines.push({ no: i + 1, expected: b[i] === undefined ? '(missing)' : b[i], actual: a[i] === undefined ? '(missing)' : a[i] });
    }
  }
  return {
    equal: lines.length === 0,
    totalDiffLines: lines.length < maxLines ? lines.length : n,
    lines,
  };
}

/**
 * Compare `actualRaw` (raw ANSI, escapes visible-ized internally) against the
 * golden file `<dir>/<name>.golden.txt`.
 *
 * @param {object} p
 * @param {string} p.name - snapshot name (file-safe, no extension)
 * @param {string} p.actualRaw - raw ANSI text produced by the unit under test
 * @param {string} p.dir - golden directory
 * @param {boolean} [p.update] - rewrite the golden from actual (KHY_GOLDEN_UPDATE)
 * @returns {{ok: boolean, reason?: string, diff?: object, file: string, created?: boolean}}
 */
function matchGolden(p) {
  const name = String((p && p.name) || '');
  const dir = (p && p.dir) || '';
  const file = path.join(dir, `${name}.golden.txt`);
  try {
    const actualVisible = escapeVisible((p && p.actualRaw) || '');
    const wantUpdate = Boolean(p && p.update) || String(process.env.KHY_GOLDEN_UPDATE || '').trim() === '1';
    let expectedVisible = null;
    try {
      expectedVisible = fs.readFileSync(file, 'utf8');
    } catch {
      expectedVisible = null;
    }
    if (expectedVisible === null) {
      if (!wantUpdate) {
        return {
          ok: false,
          reason: `金帧缺失：${name}。核对当前输出无误后，用 KHY_GOLDEN_UPDATE=1 生成基线。`,
          file,
        };
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, actualVisible, 'utf8');
      return { ok: true, file, created: true };
    }
    const diff = diffFrames(actualVisible, expectedVisible);
    if (!diff.equal && wantUpdate) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, actualVisible, 'utf8');
      return { ok: true, file, updated: true };
    }
    return { ok: diff.equal, file, diff: diff.equal ? undefined : diff };
  } catch (err) {
    return { ok: false, reason: `金帧比对失败：${err && err.message ? err.message : err}`, file };
  }
}

module.exports = { escapeVisible, fromVisible, diffFrames, matchGolden, ESC };
