'use strict';

/**
 * Guard: every `khy <cmd> <verb>` a module *tells the user to run* must actually
 * resolve. Three real defects this catches, all found by running the CLI:
 *   - restoreService's index warning advertised `khy session reindex`, a verb that
 *     exists nowhere; following it rendered `khy session list` (rc=0, no error).
 *   - bootstrap's gateway-reset advice advertised `khy config reset`, which answers
 *     "Unsupported sub-command: reset".
 *   - selfProfile's capability list advertised `khy doctor diagnostics`; `doctor`
 *     takes no verb at all, so it answered with a generic 36-check report and rc=0.
 *
 * Resolution is asked of the repo's own parser plus the channels the CLI itself
 * uses — never a hand-written verb list.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BE = path.resolve(__dirname, '../..');
const TARGETS = [
  'src/services/domain/backup/backup/restoreService.js',
  'src/cli/bootstrap.js',
  // The outward-facing self-portrait: `khy self --json` hands this JSON to
  // frontends, so a command-shaped string inside it is advice too.
  'src/services/selfProfile.js',
  // Generated model cards. `train upload` → uploadToGitRepo writes README.md from its
  // template (LIVE); uploadToHuggingFace's template is the same shape but the function
  // has no caller in src, only the export (LATENT — real, but not reachable today).
  'src/services/modelTrainingService.js',
];

// Comments are removed character by character, not by a regex pair: a `/*` inside a
// line comment opens a block that a naive `/\/\*[\s\S]*?\*\//` then swallows — that
// bug ate 11 real `case 'claude':` labels and manufactured false phantoms.
function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? src.length : j + 2;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        if (c !== '`' && src[j] === '\n') break;
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// `khy backup restore <id>` -> ['backup restore']; the placeholder arg is not a verb.
function advertisedVerbs(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bkhy\s+([a-z][\w-]{2,})\s+([a-z][\w-]{2,})\b(?!:\/\/)/g)) {
    out.add(`${m[1]} ${m[2]}`);
  }
  return [...out];
}

// Verbs the router's own switch accepts live in routerDispatch*.js, not in a handler
// file named after the command — `case 'verdict':` is a real entry with no handler
// module of its own.
function routerCaseLabels() {
  const dir = path.join(BE, 'src/cli');
  const labels = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => /^router.*\.js$/.test(n))) {
    const text = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of text.matchAll(/^\s*case\s+'([a-z][\w-]*)'\s*:/gm)) labels.add(m[1]);
  }
  return labels;
}

function resolves(router, declared, handlerBranches, verbPair) {
  const [cmd, verb] = verbPair.split(' ');
  const parsed = router.parseInput(`${cmd} ${verb}`);
  if (!parsed || !parsed.command) return false;
  const canonical = String(parsed.command);
  if (parsed.subCommand === verb) return true;
  if (routerCaseLabels().has(canonical) && handlerBranches.get(canonical).has(verb)) return true;
  const subs = declared[canonical] || declared[cmd] || [];
  if (subs.includes(verb)) return true;
  // Self-registering commands reconcile from their own manifest at dispatch time.
  try {
    const reg = require(path.join(BE, 'src/cli/commandAutoRegistry'));
    const entry = reg.getCompletions().find((c) => c.name === canonical);
    if (entry && (entry.subCommands || []).includes(verb)) return true;
  } catch { /* registry unavailable — fall through to the handler-branch check */ }
  return handlerBranches.get(canonical).has(verb);
}

// Which verbs does the handler behind this command actually branch on? Deliberately
// narrow: only the command's own handler file counts. Widening this to "any verb
// appearing anywhere in the router" would make the guard unable to fail.
function handlerBranchVerbs(canonical) {
  const dir = path.join(BE, 'src/cli/handlers');
  const exact = path.join(dir, `${canonical}.js`);
  let text = '';
  if (fs.existsSync(exact)) text = stripComments(fs.readFileSync(exact, 'utf8'));
  else {
    // `test-keys` lives in handlers/testKey.js: names differ by casing and plural.
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(canonical);
    const forms = want.endsWith('s') ? [want, want.slice(0, -1)] : [want];
    const hit = fs.readdirSync(dir).find(
      (f) => f.endsWith('.js') && forms.includes(norm(path.basename(f, '.js')))
    );
    if (hit) text = stripComments(fs.readFileSync(path.join(dir, hit), 'utf8'));
  }
  const verbs = new Set();
  for (const m of text.matchAll(/case\s+'([a-z][\w-]*)'\s*:/g)) verbs.add(m[1]);
  for (const m of text.matchAll(/===\s*'([a-z][\w-]*)'/g)) verbs.add(m[1]);
  return verbs;
}

test('no advertised khy command in these files is a phantom', () => {
  const router = require(path.join(BE, 'src/cli/router'));
  const declared = require(path.join(BE, 'src/constants/commandSchema')).getRouterSubCommands();
  const branchCache = new Map();
  const handlerBranches = {
    get: (name) => {
      if (!branchCache.has(name)) branchCache.set(name, handlerBranchVerbs(name));
      return branchCache.get(name);
    },
  };

  for (const rel of TARGETS) {
    const src = stripComments(fs.readFileSync(path.join(BE, rel), 'utf8'));
    const pairs = advertisedVerbs(src);
    // Vacuous-green floor: each target must really contain an advertised command.
    assert.ok(pairs.length > 0, `no \`khy <cmd> <verb>\` found in ${rel} — the scan is blind`);
    const dead = pairs.filter((p) => !resolves(router, declared, handlerBranches, p));
    assert.deepStrictEqual(dead, [], `unresolvable advice printed to the user in ${rel}: ${dead.join(', ')}`);
  }
});

test('the known phantoms stay dead and their replacements are real', () => {  // Comments may narrate the old bugs; only what the code can print matters here.
  const restore = stripComments(
    fs.readFileSync(path.join(BE, 'src/services/domain/backup/backup/restoreService.js'), 'utf8')
  );
  const boot = stripComments(fs.readFileSync(path.join(BE, 'src/cli/bootstrap.js'), 'utf8'));
  const profile = stripComments(
    fs.readFileSync(path.join(BE, 'src/services/selfProfile.js'), 'utf8')
  );
  assert.ok(!/khy\s+session\s+reindex/.test(restore), '`khy session reindex` must not be advertised');
  assert.ok(/khy\s+backup\s+restore/.test(restore), 'the remedy should point at backup restore');
  assert.ok(!/khy\s+config\s+reset/.test(boot), '`khy config reset` must not be advertised');
  assert.ok(/khy\s+gateway\s+config/.test(boot), 'the remedy should point at the gateway wizard');
  // `doctor` has no sub-commands at all — `khy doctor diagnostics` printed a generic
  // health report with rc=0, i.e. a fake success for a verb that does not exist.
  assert.ok(!/khy\s+doctor\s+\w/.test(profile), '`khy doctor <verb>` must not be advertised');

  // Model cards: `train` has no `import` verb (its chain ends at `upload`, and an
  // unknown sub-verb falls through to the status panel with rc=0 — measured).
  const cards = stripComments(
    fs.readFileSync(path.join(BE, 'src/services/modelTrainingService.js'), 'utf8')
  );
  assert.ok(!/khy\s+train\s+import/.test(cards), '`khy train import` must not be advertised');
  assert.strictEqual(
    (cards.match(/khy\s+models\s+import\b/g) || []).length,
    2,
    'both card templates should point at the real `models import`'
  );
});

// Positive control for the resolver itself: a command that resolves ONLY through a
// self-registering manifest alias must not be called a phantom. `khy trajectory list`
// is spelled by AGENTS.md, dispatches to handlers/trace.js through that manifest's
// `aliases: ['trajectory']`, and `trace` really branches on 'list' (trace.js:202).
// The alias is declared behind a COMPUTED export key (`[MANIFEST_EXPORT_KEY]`), so no
// text scan of the handler sees it — a resolver built on case labels, the schema table
// and registry names alone reports this working command as dead advice.
test('manifest-alias commands resolve (resolver positive control)', () => {
  const router = require(path.join(BE, 'src/cli/router'));
  const declared = require(path.join(BE, 'src/constants/commandSchema')).getRouterSubCommands();
  const branchCache = new Map();
  const handlerBranches = {
    get: (name) => {
      if (!branchCache.has(name)) branchCache.set(name, handlerBranchVerbs(name));
      return branchCache.get(name);
    },
  };
  assert.strictEqual(
    resolves(router, declared, handlerBranches, 'trajectory list'),
    true,
    '`khy trajectory list` works (trace manifest alias) — the resolver must not call it a phantom',
  );
});
