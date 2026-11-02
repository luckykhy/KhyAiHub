#!/usr/bin/env node
'use strict';

/**
 * canary-mark.js — source-layer canary marking (stamp / verify / report).
 *
 * Why this exists: software copyright registration is still pending while APKs
 * built from this tree get distributed; when a build leaks there is no way to
 * tell WHICH snapshot it came from. This tool writes a batch marker comment
 * (`khy-canary: Khy-<release>-<seq>-<rand8>`) into source files and keeps a
 * sha256 manifest, so a leaked copy traces to a batch and a stripped copy
 * betrays itself against the manifest. It is evidence, not protection: the
 * envelope is grep-able, and its value is the per-file cleaning cost plus the
 * singly-accounted manifest.
 *
 * Layer split: this tool owns the SOURCE layer only. The APK layer (a
 * per-recipient value reaching binary manifest/arsc/dex/.so, accounted in the
 * gitignored works/data/khy/canary/ledger.jsonl) belongs to the build wiring
 * and is out of scope here. canary-manifest.json holds source-layer values
 * only; APK-layer values never enter it.
 *
 * Deliberately not a gate: no git hook, no CI step, no npm script, no khy
 * subcommand; verify/report always exit 0; no FEATURE-OWNERSHIP rollout
 * entry — an offline evidence tool needs no PROCESS-008 stage. This tool also
 * never commits or pushes (PROCESS-001): stamping leaves working-tree changes
 * for a human to review and commit.
 *
 * Safety valves:
 *   - idempotent stamp: files already carrying the `khy-canary:` envelope are
 *     skipped, so re-runs never stack a second marker;
 *   - `stamp --undo` removes exactly the line this tool inserted and accepts
 *     the removal only when the file hashes back to the recorded
 *     beforeSha256 — safe on a dirty tree, never touches other people's
 *     unstaged work;
 *   - stamping shifts line numbers, so the com.stepos.ailauncher freeze table
 *     in scripts/ci/check-amoo-package-literals.cjs is re-anchored by whole
 *     line text before anything is stamped and bumped for every stamped file;
 *     an entry that cannot be re-anchored skips its file (fail-safe, loudly
 *     listed) instead of guessing coordinates.
 *
 * Usage:
 *   node scripts/release/canary-mark.js stamp [--release <yyyymmdd>]
 *        [--max <n>] [--tier mobile,backend,desktop|all] [--only <path>...] [--plan]
 *        [--resync-only] [--undo [--batch <release>]]
 *   node scripts/release/canary-mark.js verify [--manifest <path>] [--json]
 *   node scripts/release/canary-mark.js report [--manifest <path>] [--json]
 *
 * Exit codes: stamp 0 = ran (individual skips are reported, not fatal),
 * 1 = hard failure; verify/report always 0 (evidence readers, not gates).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'canary-manifest.json');
const AMOO_GUARD_PATH = path.join(REPO_ROOT, 'scripts', 'ci', 'check-amoo-package-literals.cjs');
const COPYRIGHT_MATERIALS_PATH = path.join(REPO_ROOT, 'docs', '10_规范', 'registry', 'COPYRIGHT-MATERIALS.json');
const AGENTS_PATH = path.join(REPO_ROOT, 'AGENTS.md');

const MANIFEST_SCHEMA = 'khy-canary-manifest/1';
const MARKER_PREFIX = 'Khy-';
const ENVELOPE = 'khy-canary:';
const RAND_LEN = 8;
const RAND_CHARSET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MARKER_RE = /^Khy-\d{8}-\d{3,}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

const MOBILE_ROOT = 'delivery/mobile/khy-os-client-app/';
const BACKEND_SERVICES = 'runtime/node/backend/src/services/';
const KHY_PLATFORM = 'runtime/substrate/platform/khy_platform/';
const DESKTOP_ROOT = 'apps/khyos-desktop/src/';

// The three backend CLI files named by the plan; AGENTS.md entry points only
// set T2 fill priority, never membership.
const CLI_THREE = [
  'runtime/node/backend/src/cli/router.js',
  'runtime/node/backend/src/cli/aliases.js',
  'runtime/node/backend/src/cli/repl.js',
];

// Worker B's 12 wiring files (ownership contract): never stamped here. Only
// the five tracked ones inside the T1 pool actually hit the exclusion; the
// rest fall out via tier or untracked status.
const WIRING_B12 = new Set([
  MOBILE_ROOT + 'android/app/build.gradle',
  MOBILE_ROOT + 'android/app/src/main/AndroidManifest.xml',
  MOBILE_ROOT + 'android/app/src/main/res/raw/keep.xml',
  MOBILE_ROOT + 'android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
  MOBILE_ROOT + 'android/app/src/main/java/com/khyos/khy_os_client/bridge/HttpBridge.java',
  MOBILE_ROOT + 'android/app/src/main/java/com/khyos/khy_os_client/bridge/BridgeService.java',
  MOBILE_ROOT + 'android/app/src/main/cpp/CMakeLists.txt',
  MOBILE_ROOT + 'android/app/src/main/cpp/khy_js_jni.cpp',
  MOBILE_ROOT + 'lib/core/services/app_logger.dart',
  MOBILE_ROOT + 'lib/core/network/network_diagnostic.dart',
  'scripts/release/build-android.ps1',
  MOBILE_ROOT + 'android/.gitignore',
]);

// T2 hard cap from the plan: backend core is a 954-file raw pool, the batch
// takes the first 120 by (priority, lexicographic) fill order.
const BACKEND_CAP = 120;

// Codegen output dies on the next build, so a marker there would drift and
// lie; these shapes are excluded outright.
const GENERATED_RE = /(?:^|\/)(?:Generated[^/]*|[^/]*\.g\.dart|[^/]*\.freezed\.dart|[^/]*\.mocks\.dart|[^/]*\.min\.[^/]*)$/i;
const EVIDENCE_PREFIXES = ['works/record/evidence/', 'scripts/copyright/vendor/', KHY_PLATFORM + 'bundled/'];

const SLASH_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.dart', '.kt', '.java', '.gradle', '.kts', '.cpp', '.cc', '.h', '.c']);
const HASH_EXT = new Set(['.py', '.ps1', '.sh', '.cmake', '.pro', '.properties']);
const XML_EXT = new Set(['.xml', '.vue']);

const say = (s) => process.stdout.write((s === undefined ? '' : s) + '\n');
const complain = (s) => process.stderr.write((s === undefined ? '' : s) + '\n');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function langFor(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base === 'CMakeLists.txt') return '#';
  const dot = file.lastIndexOf('.');
  const ext = dot < 0 ? '' : file.slice(dot).toLowerCase();
  if (SLASH_EXT.has(ext)) return '//';
  if (HASH_EXT.has(ext)) return '#';
  if (XML_EXT.has(ext)) return '<!--';
  return null;
}

function isT1(file) {
  if (!file.startsWith(MOBILE_ROOT)) return false;
  if (file.startsWith(MOBILE_ROOT + 'lib/') && file.endsWith('.dart')) return true;
  if (file.startsWith(MOBILE_ROOT + 'android/app/src/main/java/') && /\.(java|kt)$/.test(file)) return true;
  if (file.startsWith(MOBILE_ROOT + 'android/app/src/main/kotlin/') && /\.(java|kt)$/.test(file)) return true;
  if (file.startsWith(MOBILE_ROOT + 'android/app/src/main/res/') && file.endsWith('.xml')) return true;
  if (file.startsWith(MOBILE_ROOT + 'android/app/src/test/') && /\.(java|kt)$/.test(file)) return true;
  return false;
}

function isT2(file) {
  if (file.startsWith(BACKEND_SERVICES) && file.endsWith('.js')) {
    const rel = file.slice(BACKEND_SERVICES.length);
    // Strict depth 1 for the services root plus the whole gateway subtree;
    // services/domain/** stays out this round (plan §scope T2).
    return rel.indexOf('/') < 0 || rel.startsWith('gateway/');
  }
  if (CLI_THREE.indexOf(file) >= 0) return true;
  return file.startsWith(KHY_PLATFORM) && file.endsWith('.py');
}

// T3 desktop: electron-vite ships main/preload bundles unminified (out/main
// comments survive verbatim), so a head comment rides into the asar.
function isT3(file) {
  return file.startsWith(DESKTOP_ROOT) && /\.(ts|tsx|js|jsx|cjs|mjs)$/.test(file);
}

function tierOf(file) {
  if (isT1(file)) return 'mobile';
  if (isT2(file)) return 'backend';
  if (isT3(file)) return 'desktop';
  return 'other';
}

/**
 * Candidates for the copyright registration material (DESIGN-IP-001 C-X3)
 * must not be stamped: they are submitted as the registration's source
 * program and must stay byte-identical to the registry listing. The list is
 * parsed from the registry JSON at run time so future scope changes are
 * picked up without touching this tool.
 */
function parseCopyrightCandidates() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(COPYRIGHT_MATERIALS_PATH, 'utf8'));
  } catch (e) {
    throw new Error('cannot read COPYRIGHT-MATERIALS.json (' + e.message + '): '
      + 'without the exclusion contract the stamp refuses to run');
  }
  const codeExt = /\.(?:js|cjs|mjs|ts|asm|s|c|h|cpp|cc|py|dart|kt|java)$/i;
  const found = new Set();
  (function walk(v) {
    if (typeof v === 'string') {
      if (v.indexOf(' ') < 0 && v.indexOf('\\') < 0 && v.indexOf('/') >= 0 && codeExt.test(v)) found.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  })(json);
  return found;
}

/**
 * AGENTS.md 「关键入口点」table rows supply T2 fill priority. Table cells only
 * (pipe rows), path-shaped; membership is still gated by the pool filter.
 */
function parseAgentsPriority() {
  let text = '';
  try {
    text = fs.readFileSync(AGENTS_PATH, 'utf8');
  } catch (e) {
    complain('canary-mark: AGENTS.md unreadable (' + e.message + '), T2 priority fill degrades to plain lexicographic');
    return new Set();
  }
  const out = new Set();
  for (const line of text.split('\n')) {
    if (line.charAt(0) !== '|') continue;
    const cells = line.split('|');
    if (cells.length < 3) continue;
    const cell = cells[2].trim().replace(/`/g, '');
    if (/^[A-Za-z0-9_][A-Za-z0-9_/.-]*\.[A-Za-z0-9]+$/.test(cell)) out.add(cell);
  }
  return out;
}

function exclusionReason(file, copyright) {
  if (GENERATED_RE.test(file)) return 'generated';
  if (/(?:^|\/)app_functions[^/]*\.xml$/i.test(file) || /\.xsd$/i.test(file)) return 'md5-or-test-pinned';
  for (const pre of EVIDENCE_PREFIXES) if (file.startsWith(pre)) return 'evidence-or-vendored';
  if (file === 'AGENTS.md' || file === 'CLAUDE.md' || file === 'README.md') return 'instruction-file';
  if (WIRING_B12.has(file)) return 'wiring-b12';
  if (copyright.has(file)) return 'copyright-material';
  return null;
}

function gitRun(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
}

function listTracked() {
  return gitRun(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
}

function listUntracked() {
  return gitRun(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
}

/** porcelain -z map path -> XY; rename pairs consume their second record. */
function readStatus() {
  const raw = gitRun(['status', '--porcelain', '-z', '-unormal']).toString('utf8');
  const map = new Map();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i];
    if (row.length < 4) continue;
    const xy = row.slice(0, 2);
    map.set(row.slice(3), xy);
    if (xy.indexOf('R') >= 0) i++;
  }
  return map;
}

function emptyManifest() {
  return {
    schema: MANIFEST_SCHEMA,
    marker: { prefix: MARKER_PREFIX, envelope: 'khy-canary', randLen: RAND_LEN, randCharset: RAND_CHARSET },
    batches: [],
  };
}

function loadManifest(p) {
  const file = p || MANIFEST_PATH;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveManifest(manifest) {
  const tmp = MANIFEST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, MANIFEST_PATH);
}

function rand8() {
  const bytes = crypto.randomBytes(5);
  let acc = BigInt(0);
  for (const b of bytes) acc = (acc << BigInt(8)) | BigInt(b);
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) {
    out = RAND_CHARSET[Number(acc & BigInt(31))] + out;
    acc >>= BigInt(5);
  }
  return out;
}

function nextSeq(manifest) {
  let max = 0;
  for (const batch of manifest.batches || []) {
    for (const e of batch.entries || []) {
      const m = /^Khy-\d{8}-(\d{3,})-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.exec(e.marker);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

function mintMarker(release, used, seq) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const m = MARKER_PREFIX + release + '-' + String(seq).padStart(3, '0') + '-' + rand8();
    if (!used.has(m)) {
      used.add(m);
      return m;
    }
  }
  throw new Error('marker collision persists at seq ' + seq);
}

function commentFor(lang, marker) {
  if (lang === '<!--') return '<!-- ' + ENVELOPE + ' ' + marker + ' -->';
  return lang + ' ' + ENVELOPE + ' ' + marker;
}

/**
 * Insert the marker comment at byte level so non-UTF-8 bytes and BOMs survive
 * untouched. Position: after a shebang, after the XML declaration (a comment
 * in front of it fails aapt2 compile), else at file head. EOL copies the
 * first line's own terminator.
 */
function insertCanary(buf, lang, marker) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.slice(3) : buf;
  const nl = body.indexOf(0x0a);
  const rawFirst = nl < 0 ? body : body.slice(0, nl);
  const firstLine = rawFirst.toString('utf8').replace(/\r$/, '');
  const eol = rawFirst.length !== firstLine.length ? '\r\n' : '\n';
  let at = 0;
  if (firstLine.startsWith('#!')) at = nl + 1;
  else if (lang === '<!--' && firstLine.startsWith('<?xml')) at = nl + 1;
  const lineBuf = Buffer.from(commentFor(lang, marker) + eol, 'utf8');
  if (at > 0) return { buf: Buffer.concat([body.slice(0, at), lineBuf, body.slice(at)]), line: 2 };
  const head = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return { buf: Buffer.concat([head, lineBuf, body]), line: 1 };
}

/**
 * Remove the 1-based physical line, only if it carries the marker. A leading
 * BOM belongs to the line start anchor: it must survive a line-1 removal or
 * the beforeSha256 round-trip can never match.
 */
function removeLineAt(buf, lineNo, mustContain) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let start = bom ? 3 : 0;
  let line = 1;
  while (line < lineNo && start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) return { ok: false, why: 'line-out-of-range' };
    start = nl + 1;
    line++;
  }
  if (line !== lineNo || start >= buf.length) return { ok: false, why: 'line-out-of-range' };
  let end = buf.indexOf(0x0a, start);
  end = end < 0 ? buf.length : end + 1;
  const seg = buf.slice(start, end);
  if (seg.indexOf(Buffer.from(mustContain, 'utf8')) < 0) return { ok: false, why: 'marker-not-on-recorded-line' };
  return { ok: true, buf: Buffer.concat([buf.slice(0, start), buf.slice(end)]) };
}

// ── amoo freeze table (scripts/ci/check-amoo-package-literals.cjs) ─────────

function extractFrozenBlock(text) {
  const start = text.indexOf('const FROZEN = [');
  if (start < 0) throw new Error('freeze table head "const FROZEN = [" not found');
  const end = text.indexOf('\n];', start);
  if (end < 0) throw new Error('freeze table tail "\\n];" not found');
  return { start, endPlusTail: end + '\n];'.length };
}

function splitFrozenChunks(block) {
  const marks = [];
  const re = /(\r?\n)  \{/g;
  let m;
  while ((m = re.exec(block)) !== null) marks.push({ index: m.index, sep: m[1] });
  if (!marks.length) throw new Error('freeze table has no entry chunks');
  const head = block.slice(0, marks[0].index);
  const chunks = [];
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].index + marks[k].sep.length;
    const to = k + 1 < marks.length ? marks[k + 1].index : block.length;
    chunks.push({ sep: marks[k].sep, body: block.slice(from, to) });
  }
  return { head, chunks };
}

/**
 * The guard file has top-level side effects and sets process.exitCode, so the
 * table is sliced out and evaluated instead of required.
 */
function loadFrozenTable(guardPath) {
  const file = guardPath || AMOO_GUARD_PATH;
  const text = fs.readFileSync(file, 'utf8');
  const { start, endPlusTail } = extractFrozenBlock(text);
  const block = text.slice(start, endPlusTail);
  const arrayText = block.slice('const FROZEN = '.length).replace(/;\s*$/, '');
  let entries;
  try {
    entries = new Function('"use strict"; return (' + arrayText + ');')();
  } catch (e) {
    throw new Error('freeze table evaluation failed: ' + e.message);
  }
  if (!Array.isArray(entries) || !entries.length) throw new Error('freeze table is empty or not an array');
  for (const e of entries) {
    if (!e || typeof e.file !== 'string' || typeof e.line !== 'number' || typeof e.text !== 'string') {
      throw new Error('freeze table entry lacks file/line/text: ' + JSON.stringify(e).slice(0, 120));
    }
  }
  return { path: file, entries, origLines: entries.map((e) => e.line) };
}

/**
 * Re-anchor every freeze entry by its whole line text (the guard compares the
 * same normalized form: only a trailing \r is stripped). Anchored-in-place
 * entries stay untouched; drift is absorbed; text that cannot be found is
 * reported, never guessed.
 */
function resyncFrozen(entries, repoRoot) {
  const root = repoRoot || REPO_ROOT;
  const byFile = new Map();
  entries.forEach((e) => {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  });
  const moves = [];
  const unresolved = [];
  for (const [file, list] of byFile) {
    const abs = path.join(root, file);
    let lines = null;
    if (fs.existsSync(abs)) {
      // utf8 keeps the guard's own comparison semantics (it greps with utf8)
      lines = fs.readFileSync(abs).toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    }
    for (const e of list) {
      if (!lines) {
        unresolved.push({ entry: e, why: 'file-missing' });
        continue;
      }
      const at = e.line - 1;
      if (at >= 0 && at < lines.length && lines[at] === e.text) continue;
      const hits = [];
      for (let i = 0; i < lines.length; i++) if (lines[i] === e.text) hits.push(i + 1);
      if (!hits.length) {
        unresolved.push({ entry: e, why: 'text-not-found' });
        continue;
      }
      hits.sort((a, b) => Math.abs(a - e.line) - Math.abs(b - e.line));
      moves.push({ file: e.file, from: e.line, to: hits[0], candidates: hits.length });
      e.line = hits[0];
    }
  }
  return { moves, unresolved };
}

/**
 * Rewrite only the `line: N` fields inside the freeze block; every other byte
 * of the guard file stays as-is. Each chunk's recorded line must still match
 * the value captured at load time, otherwise the table drifted mid-run and
 * writing would corrupt it.
 */
function writeFrozenTable(table, guardPath) {
  const file = guardPath || table.path || AMOO_GUARD_PATH;
  const text = fs.readFileSync(file, 'utf8');
  const { start, endPlusTail } = extractFrozenBlock(text);
  const block = text.slice(start, endPlusTail);
  const { head, chunks } = splitFrozenChunks(block);
  if (chunks.length !== table.entries.length) {
    throw new Error('freeze chunk count ' + chunks.length + ' != entry count ' + table.entries.length);
  }
  let out = head;
  for (let i = 0; i < chunks.length; i++) {
    const m = chunks[i].body.match(/(\r?\n)(\s*)line: (\d+),/);
    if (!m) throw new Error('freeze entry #' + (i + 1) + ' has no line field');
    if (Number(m[3]) !== table.origLines[i]) {
      throw new Error('freeze entry #' + (i + 1) + ' line field ' + m[3]
        + ' no longer matches the value seen at load (' + table.origLines[i] + '); aborting table write');
    }
    out += chunks[i].sep + chunks[i].body.replace(/(\r?\n)(\s*)line: \d+,/, '$1$2line: ' + table.entries[i].line + ',');
  }
  fs.writeFileSync(file, text.slice(0, start) + out + text.slice(endPlusTail), 'utf8');
}

// ── pool building ──────────────────────────────────────────────────────────

function buildPool(tracked, want, copyright) {
  const pool = [];
  const excluded = [];
  const noLang = { count: 0 };
  for (const file of tracked) {
    const lang = langFor(file);
    if (!lang) {
      noLang.count++;
      continue;
    }
    const reason = exclusionReason(file, copyright);
    if (reason) {
      excluded.push({ file, lang, tier: tierOf(file), reason });
      continue;
    }
    const tier = tierOf(file);
    if (!want.has(tier)) {
      excluded.push({ file, lang, tier, reason: 'tier-off' });
      continue;
    }
    pool.push({ file, lang, tier });
  }
  return { pool, excluded, noLang };
}

/** Untracked stampable-syntax files under the wanted tiers: coverage gaps,
 * reported honestly, never stamped (git ls-files is the pool contract). */
function blindSpots(untracked, want) {
  const out = [];
  for (const file of untracked) {
    const lang = langFor(file);
    if (!lang) continue;
    const tier = tierOf(file);
    const relevant = tier !== 'other' || want.has('other');
    if (!relevant) continue;
    out.push({ file, lang, tier, wiring: WIRING_B12.has(file) });
  }
  return out;
}

function resolveTiers(val) {
  const want = new Set();
  const raw = val || 'mobile,backend,desktop';
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v === 'all') {
      want.add('mobile');
      want.add('backend');
      want.add('desktop');
      want.add('other');
    } else if (v === 'mobile' || v === 'backend' || v === 'desktop' || v === 'other') {
      want.add(v);
    } else {
      throw new Error('unknown tier: ' + v);
    }
  }
  return want;
}

function localYyyymmdd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate());
}

const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

function countBy(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
}

// ── stamp ──────────────────────────────────────────────────────────────────

function planStamp(opts, ctx) {
  say('== canary stamp plan (dry run: nothing is written) ==');
  say('tiers: ' + [...ctx.want].join(',') + '  release: ' + ctx.release);
  say('pool candidates: ' + ctx.ordered.length
    + ' (mobile ' + ctx.t1.length + ', backend prio ' + ctx.t2prio.length + '+' + ctx.t2rest.length
    + ', desktop ' + ctx.td.length + ', other ' + ctx.t3.length + ')');
  say('');
  say('-- freeze table resync preview (text anchors, guard: scripts/ci/check-amoo-package-literals.cjs)');
  if (!ctx.moves.length) say('   all ' + ctx.frozen.entries.length + ' entries already anchored, no coordinate change');
  for (const mv of ctx.moves) say('   resync ' + mv.file + ' ' + mv.from + ' -> ' + mv.to + (mv.candidates > 1 ? '  (WARNING: ' + mv.candidates + ' text matches, nearest taken)' : ''));
  if (ctx.unresolved.length) {
    say('   UNRESOLVED ' + ctx.unresolved.length + ' — files carrying these skip stamping:');
    for (const u of ctx.unresolved) say('     ' + u.why + '  ' + u.entry.file + ':' + u.entry.line);
  }
  say('');
  say('-- would stamp: ' + ctx.selected.length + ' file(s)'
    + (opts.only.length ? '  (--only ' + opts.only.join(', ') + ')' : ''));
  for (const f of ctx.selected) say('   [' + f.tier + '][' + f.lang + '] ' + f.file);
  say('');
  const skipGroups = countBy(ctx.skipped, 'why');
  say('-- skipped: ' + ctx.skipped.length + '  ' + JSON.stringify(skipGroups));
  for (const s of ctx.skipped) {
    if (s.why === 'frozen-anchor-unresolved' || s.why === 'missing-on-disk') say('   ' + s.why + '  ' + s.file);
  }
  say('');
  const dirtyInPool = ctx.selected.filter((f) => ctx.status.has(f.file));
  say('-- dirty (uncommitted) among would-stamp: ' + dirtyInPool.length);
  for (const f of dirtyInPool) say('   ' + ctx.status.get(f.file) + '  ' + f.file);
  say('');
  say('-- untracked blind spots (stampable syntax, NOT in git index, NOT stamped): ' + ctx.blind.length);
  for (const b of ctx.blind) say('   [' + b.tier + ']' + (b.wiring ? '[wiring-b12]' : '') + ' ' + b.file);
  say('');
  const excGroups = countBy(ctx.excluded, 'reason');
  say('-- excluded-with-reason: ' + ctx.excluded.length + '  ' + JSON.stringify(excGroups));
  for (const e of ctx.excluded) {
    if (e.reason !== 'tier-off') say('   ' + e.reason + '  [' + e.tier + '] ' + e.file);
  }
  say('-- no-comment-syntax (not stampable, count only): ' + ctx.noLang.count);
  say('');
  say('-- next seq: ' + ctx.seq + '   manifest: ' + MANIFEST_PATH);
}

function stampOne(f, release, used, seq) {
  const abs = path.join(REPO_ROOT, f.file);
  const buf = fs.readFileSync(abs);
  const before = sha256(buf);
  if (buf.indexOf(Buffer.from(ENVELOPE, 'utf8')) >= 0) return null;
  const marker = mintMarker(release, used, seq);
  const ins = insertCanary(buf, f.lang, marker);
  const after = sha256(ins.buf);
  if (after === before) throw new Error('stamp produced identical bytes for ' + f.file);
  fs.writeFileSync(abs, ins.buf);
  return { file: f.file, marker, beforeSha256: before, afterSha256: after, lang: f.lang, line: ins.line };
}

function cmdStamp(opts) {
  if (opts.undo) return cmdUndo(opts);
  const want = resolveTiers(opts.tier);
  const release = opts.release || localYyyymmdd();
  if (!/^\d{8}$/.test(release)) throw new Error('--release must be yyyymmdd, got: ' + release);
  if (!opts.plan && !opts.resyncOnly) {
    say('canary stamp: release ' + release + ' — working-tree only, nothing is committed (PROCESS-001)');
  }

  const copyright = parseCopyrightCandidates();
  const priority = parseAgentsPriority();
  const frozen = loadFrozenTable();
  const { moves, unresolved } = resyncFrozen(frozen.entries);
  const unresolvedFiles = new Set(unresolved.map((u) => u.entry.file));

  const { pool, excluded, noLang } = buildPool(listTracked(), want, copyright);
  const blind = blindSpots(listUntracked(), want);
  const status = readStatus();

  let candidates = pool;
  if (opts.only.length) candidates = pool.filter((f) => opts.only.some((o) => f.file === o || f.file.startsWith(o)));

  const t1 = candidates.filter((f) => f.tier === 'mobile').sort(byFile);
  const t2all = candidates.filter((f) => f.tier === 'backend');
  const t2prio = t2all.filter((f) => priority.has(f.file)).sort(byFile);
  const t2rest = t2all.filter((f) => !priority.has(f.file)).sort(byFile);
  const t3 = candidates.filter((f) => f.tier === 'other').sort(byFile);
  const td = candidates.filter((f) => f.tier === 'desktop').sort(byFile);
  const ordered = t1.concat(t2prio, t2rest, td, t3);

  const manifest = loadManifest() || emptyManifest();
  const used = new Set();
  const stampedBefore = new Set();
  for (const batch of manifest.batches || []) {
    for (const e of batch.entries || []) {
      used.add(e.marker);
      stampedBefore.add(e.file);
    }
  }
  let seq = nextSeq(manifest);

  const selected = [];
  const skipped = [];
  let backendTaken = 0;
  for (const f of ordered) {
    const abs = path.join(REPO_ROOT, f.file);
    if (!fs.existsSync(abs)) {
      skipped.push({ ...f, why: 'missing-on-disk' });
      continue;
    }
    if (unresolvedFiles.has(f.file)) {
      skipped.push({ ...f, why: 'frozen-anchor-unresolved' });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.indexOf(Buffer.from(ENVELOPE, 'utf8')) >= 0) {
      // A file marked in an earlier run already consumed its tier cap slot:
      // counting it here is what makes a plain re-run converge to no-op
      // instead of pulling the next unstamped window into the batch.
      if (f.tier === 'backend') backendTaken++;
      skipped.push({ ...f, why: 'already-stamped' });
      continue;
    }
    if (f.tier === 'backend' && !opts.only.length && backendTaken >= BACKEND_CAP) {
      skipped.push({ ...f, why: 'backend-cap' });
      continue;
    }
    if (opts.max && selected.length >= opts.max) {
      skipped.push({ ...f, why: 'max-reached' });
      continue;
    }
    if (f.tier === 'backend') backendTaken++;
    selected.push(f);
  }

  const ctx = { want, release, ordered, selected, skipped, excluded, noLang, blind, moves, unresolved, frozen, seq, status, t1, t2prio, t2rest, td, t3 };

  if (opts.resyncOnly) {
    if (moves.length) {
      writeFrozenTable(frozen);
      say('freeze table resynced: ' + moves.length + ' coordinate(s) updated');
    } else {
      say('freeze table already anchored: all ' + frozen.entries.length + ' entries match, no write');
    }
    for (const u of unresolved) complain('UNRESOLVED freeze entry (' + u.why + '): ' + u.entry.file + ':' + u.entry.line + ' — fix by hand, do not guess');
    return 0;
  }

  if (opts.plan) {
    planStamp(opts, ctx);
    return 0;
  }

  if (unresolved.length) {
    complain('freeze table has ' + unresolved.length + ' unresolved entr(y/ies) — the files carrying them are skipped;'
      + ' run with --plan to list them');
  }

  const stamped = [];
  const failed = [];
  for (const f of selected) {
    try {
      const entry = stampOne(f, release, used, seq);
      if (entry) {
        stamped.push(entry);
        seq++;
        say('  stamped [' + f.tier + '] ' + f.file + '  ' + entry.marker + '  (line ' + entry.line + ')');
      }
    } catch (e) {
      failed.push({ file: f.file, error: e.message });
      complain('FAILED ' + f.file + ': ' + e.message);
    }
  }

  const stampedFiles = new Set(stamped.map((s) => s.file));
  let bumped = 0;
  for (const e of frozen.entries) {
    if (stampedFiles.has(e.file)) {
      e.line += 1;
      bumped++;
    }
  }
  if (moves.length || bumped) {
    writeFrozenTable(frozen);
    say('freeze table updated: ' + moves.length + ' resynced, ' + bumped + ' bumped by stamping');
  }

  if (stamped.length) {
    manifest.batches.push({
      release,
      stampedAt: new Date().toISOString(),
      by: 'canary-mark.js stamp',
      entries: stamped.map((s) => ({ file: s.file, marker: s.marker, beforeSha256: s.beforeSha256, afterSha256: s.afterSha256, lang: s.lang, line: s.line })),
    });
    saveManifest(manifest);
  }

  say('');
  say('stamped ' + stamped.length + ' file(s) into batch ' + release
    + ' (skipped: ' + skipped.length + ', failed: ' + failed.length + ')');
  for (const s of failed) complain('  failed: ' + s.file + ' — ' + s.error);
  if (moves.length) for (const mv of moves) complain('  resynced freeze coord: ' + mv.file + ' ' + mv.from + ' -> ' + mv.to);
  for (const u of unresolved) complain('  UNRESOLVED freeze entry (' + u.why + '): ' + u.entry.file + ':' + u.entry.line + ' — fix by hand');
  say('manifest: ' + MANIFEST_PATH);
  say('next: node scripts/ci/check-amoo-package-literals.cjs  (must stay 0 error)');
  return failed.length ? 1 : 0;
}

function cmdUndo(opts) {
  const manifest = loadManifest();
  if (!manifest || !(manifest.batches || []).length) {
    say('nothing to undo: manifest absent or empty');
    return 0;
  }
  let batches = manifest.batches;
  if (opts.batch) {
    batches = batches.filter((b) => b.release === opts.batch);
    if (!batches.length) {
      complain('no batch with release ' + opts.batch);
      return 1;
    }
  }
  const frozen = loadFrozenTable();
  const done = [];
  const refused = [];
  const missing = [];
  const removedLineByFile = new Map();
  for (const batch of batches) {
    const keep = [];
    for (const e of batch.entries) {
      if (opts.only.length && !opts.only.some((o) => e.file === o || e.file.startsWith(o))) {
        keep.push(e);
        continue;
      }
      const abs = path.join(REPO_ROOT, e.file);
      if (!fs.existsSync(abs)) {
        missing.push(e);
        keep.push(e);
        continue;
      }
      const r = removeLineAt(fs.readFileSync(abs), e.line, e.marker);
      if (!r.ok) {
        refused.push({ e, why: r.why });
        keep.push(e);
        continue;
      }
      if (sha256(r.buf) !== e.beforeSha256) {
        refused.push({ e, why: 'sha256-mismatch-after-remove' });
        keep.push(e);
        continue;
      }
      fs.writeFileSync(abs, r.buf);
      done.push(e);
      const prev = removedLineByFile.has(e.file) ? removedLineByFile.get(e.file) : Infinity;
      removedLineByFile.set(e.file, Math.min(prev, e.line));
    }
    batch.entries = keep;
  }
  manifest.batches = manifest.batches.filter((b) => (b.entries || []).length);
  if (removedLineByFile.size) {
    let shifted = 0;
    for (const fe of frozen.entries) {
      const rl = removedLineByFile.get(fe.file);
      if (rl !== undefined && fe.line > rl) {
        fe.line -= 1;
        shifted++;
      }
    }
    if (shifted) {
      writeFrozenTable(frozen);
      say('freeze table shifted back: ' + shifted + ' entr(y/ies)');
    }
  }
  saveManifest(manifest);
  say('undo: removed ' + done.length + ' marker line(s), refused ' + refused.length + ', missing ' + missing.length);
  for (const r of refused) complain('  refused (' + r.why + '): ' + r.e.file + ':' + r.e.line + ' — file evolved after stamping, handle by hand');
  for (const m of missing) complain('  missing on disk: ' + m.file);
  return 0;
}

// ── verify / report ────────────────────────────────────────────────────────

function collectStates(manifestPath) {
  const manifest = loadManifest(manifestPath);
  if (!manifest) return null;
  const rows = [];
  const dupMarker = new Map();
  const dupFile = new Map();
  for (const batch of manifest.batches || []) {
    for (const e of batch.entries || []) {
      let state;
      const abs = path.join(REPO_ROOT, e.file);
      if (!fs.existsSync(abs)) {
        state = 'missing';
      } else {
        const buf = fs.readFileSync(abs);
        const has = buf.indexOf(Buffer.from(e.marker, 'utf8')) >= 0;
        state = has ? (sha256(buf) === e.afterSha256 ? 'ok' : 'drift') : 'stripped';
      }
      rows.push({ release: batch.release, file: e.file, marker: e.marker, lang: e.lang, line: e.line, state });
      dupMarker.set(e.marker, (dupMarker.get(e.marker) || 0) + 1);
      dupFile.set(e.file, (dupFile.get(e.file) || 0) + 1);
    }
  }
  const findings = [];
  for (const [m, n] of dupMarker) if (n > 1) findings.push('duplicate marker: ' + m + ' x' + n);
  for (const [f, n] of dupFile) if (n > 1) findings.push('duplicate file entry: ' + f + ' x' + n);
  for (const r of rows) if (!MARKER_RE.test(r.marker)) findings.push('marker format invalid: ' + r.marker + ' (' + r.file + ')');
  return { manifest, rows, findings };
}

function cmdVerify(opts) {
  const r = collectStates(opts.manifest);
  if (!r) {
    say('no manifest at ' + (opts.manifest || MANIFEST_PATH) + ' — nothing to verify (stamp first)');
    return 0;
  }
  const dist = countBy(r.rows, 'state');
  if (opts.json) {
    say(JSON.stringify({ schema: r.manifest.schema, batches: (r.manifest.batches || []).length, entries: r.rows.length, states: dist, findings: r.findings, rows: r.rows }, null, 2));
    return 0;
  }
  say('canary verify: ' + r.rows.length + ' entr(y/ies) across ' + (r.manifest.batches || []).length + ' batch(es)');
  say('states: ' + JSON.stringify(dist));
  for (const row of r.rows) {
    if (row.state !== 'ok') say('  [' + row.state + '] ' + row.file + '  ' + row.marker);
  }
  if (r.findings.length) {
    say('uniqueness audit: ' + r.findings.length + ' finding(s)');
    for (const f of r.findings) say('  ' + f);
  } else {
    say('uniqueness audit: all markers and files unique, all marker formats valid');
  }
  say('exit 0 by contract — verify reports, it does not gate');
  return 0;
}

function cmdReport(opts) {
  const r = collectStates(opts.manifest);
  if (!r) {
    say('no manifest at ' + (opts.manifest || MANIFEST_PATH) + ' — nothing to report');
    return 0;
  }
  const states = countBy(r.rows, 'state');
  const byTier = {};
  const byDir = {};
  for (const row of r.rows) {
    const tier = tierOf(row.file);
    byTier[tier] = (byTier[tier] || 0) + 1;
    const dir = row.file.slice(0, row.file.lastIndexOf('/') + 1);
    byDir[dir] = (byDir[dir] || 0) + 1;
  }
  const sorted = r.rows.slice().sort((a, b) => (a.marker < b.marker ? -1 : a.marker > b.marker ? 1 : 0));
  const dirs = Object.entries(byDir).sort((a, b) => b[1] - a[1]);
  if (opts.json) {
    say(JSON.stringify({
      schema: r.manifest.schema,
      batches: (r.manifest.batches || []).map((b) => ({ release: b.release, stampedAt: b.stampedAt, by: b.by, entries: (b.entries || []).length })),
      entries: r.rows.length,
      byTier,
      topDirectories: dirs.slice(0, 15),
      states,
      uniquenessFindings: r.findings,
      firstMarker: sorted.length ? sorted[0].marker : null,
      lastMarker: sorted.length ? sorted[sorted.length - 1].marker : null,
      rows: r.rows,
    }, null, 2));
    return 0;
  }
  say('canary report — source-layer markers');
  say('batches:');
  for (const b of r.manifest.batches || []) {
    say('  ' + b.release + '  ' + b.stampedAt + '  ' + (b.entries || []).length + ' file(s)  by ' + b.by);
  }
  say('entries: ' + r.rows.length);
  say('by tier: ' + JSON.stringify(byTier));
  say('top directories:');
  for (const [d, n] of dirs.slice(0, 15)) say('  ' + String(n).padStart(4) + '  ' + d);
  say('states: ' + JSON.stringify(states));
  say('first marker: ' + (sorted.length ? sorted[0].marker + '  (' + sorted[0].file + ')' : '(none)'));
  say('last marker:  ' + (sorted.length ? sorted[sorted.length - 1].marker + '  (' + sorted[sorted.length - 1].file + ')' : '(none)'));
  say('uniqueness: ' + (r.findings.length ? r.findings.length + ' finding(s)' : 'all unique, formats valid'));
  return 0;
}

function cmdHelp() {
  say('canary-mark.js — source-layer canary marking (evidence tool, not a gate)');
  say('');
  say('  stamp [--release <yyyymmdd>] [--max <n>] [--tier mobile,backend,desktop|all]');
  say('        [--only <path>...] [--plan] [--resync-only] [--undo [--batch <release>]]');
  say('  verify [--manifest <path>] [--json]');
  say('  report [--manifest <path>] [--json]');
  say('');
  say('  --plan        dry run: would-stamp / skip / dirty / blind-spot / exclusion lists');
  say('  --resync-only re-anchor the amoo freeze table by line text, stamp nothing');
  say('                (run this after wiring edits shift frozen coordinates)');
  say('  --undo        remove exactly the inserted marker line; only accepts files');
  say('                hashing back to beforeSha256 (dirty-tree safe)');
  say('');
  say('verify/report always exit 0. stamp never commits or pushes.');
  return 0;
}

function parseArgs(argv) {
  const opts = { only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--release': opts.release = argv[++i]; break;
      case '--max': opts.max = Number(argv[++i]); break;
      case '--tier': opts.tier = argv[++i]; break;
      case '--only': opts.only.push(String(argv[++i]).replace(/\\/g, '/')); break;
      case '--plan': opts.plan = true; break;
      case '--undo': opts.undo = true; break;
      case '--batch': opts.batch = argv[++i]; break;
      case '--resync-only': opts.resyncOnly = true; break;
      case '--manifest': opts.manifest = argv[++i]; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.indexOf('--') === 0) throw new Error('unknown option: ' + a);
        opts.only.push(a);
        break;
    }
  }
  return opts;
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const cmd = args[0] || '';
  try {
    if (cmd === 'stamp') return cmdStamp(parseArgs(args.slice(1)));
    if (cmd === 'verify') return cmdVerify(parseArgs(args.slice(1)));
    if (cmd === 'report') return cmdReport(parseArgs(args.slice(1)));
    return cmdHelp();
  } catch (e) {
    complain('canary-mark: ' + e.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
} else {
  // test/inspection hook: pure helpers only, no side effects at require time
  module.exports = {
    REPO_ROOT, MANIFEST_PATH, AMOO_GUARD_PATH, MARKER_RE, RAND_CHARSET,
    langFor, tierOf, isT1, isT2, isT3, insertCanary, removeLineAt, commentFor,
    rand8, mintMarker, nextSeq, emptyManifest, loadFrozenTable, resyncFrozen,
    writeFrozenTable, extractFrozenBlock, splitFrozenChunks, parseCopyrightCandidates,
    parseAgentsPriority, buildPool, blindSpots, resolveTiers, localYyyymmdd,
  };
}
