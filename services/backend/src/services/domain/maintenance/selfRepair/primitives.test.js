'use strict';

/**
 * primitives.js contract tests — the IO-primitive factory of the self-repair
 * transaction. Hermetic by construction: validateFiles runs against throwaway files
 * under .khyos/tmp (never the repo's own sources), and no case triggers a git
 * snapshot/stash on the real worktree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { create } = require('./primitives');

const TMP = path.join(process.cwd(), '.khyos', 'tmp', 'b25-selfrepair-primitives');
function freshDir() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}
function write(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return rel;
}

test('create() exposes the three primitives plus the resolved projectDir', () => {
  const p = create({ projectDir: '/tmp/does-not-matter' });
  assert.deepEqual(Object.keys(p).sort(), ['projectDir', 'restore', 'snapshot', 'validateFiles']);
  assert.equal(p.projectDir, '/tmp/does-not-matter');
  for (const k of ['snapshot', 'restore', 'validateFiles']) assert.equal(typeof p[k], 'function');
  assert.equal(create({}).projectDir, process.cwd(), 'no projectDir falls back to the ambient cwd');
});

test('restore() refuses to act without a git snapshot handle', async () => {
  const p = create({ projectDir: freshDir() });
  assert.equal(await p.restore(null, { validatable: ['a.js'] }), false);
  assert.equal(await p.restore({ kind: 'none' }, { validatable: ['a.js'] }), false);
  assert.equal(await p.restore({}, { validatable: ['a.js'] }), false, 'a handle without kind is not git');
});

test('validateFiles: a broken .js is reported with a relative path and a line number', async () => {
  const p = create({ projectDir: freshDir() });
  const rel = write('bad.js', 'const a = ;\n');
  const res = await p.validateFiles([rel], { runSyntax: true });
  assert.equal(res.syntax.length, 1, JSON.stringify(res.syntax));
  assert.equal(res.syntax[0].file.replace(/\\/g, '/'), 'bad.js');
  assert.equal(typeof res.syntax[0].line, 'number');
  assert.ok(res.syntax[0].message.length > 0);
  assert.deepEqual(res.guards, [], 'guards are off unless the plan asks for them');
  assert.equal(res.tests.ran, false);
  assert.equal(res.coverage, undefined, 'no coverage unless tests ran');
});

test('validateFiles: a valid .js yields no findings, and empty plans find nothing to do', async () => {
  const dir = freshDir();
  const p = create({ projectDir: dir });
  const rel = write('ok.js', "'use strict';\nmodule.exports = 1;\n");
  assert.deepEqual((await p.validateFiles([rel], { runSyntax: true })).syntax, []);
  assert.deepEqual((await p.validateFiles([rel], {})).syntax, [], 'plan off → no probe');
  assert.deepEqual((await p.validateFiles([], { runSyntax: true })).syntax, []);
  assert.deepEqual((await p.validateFiles(null, { runSyntax: true })).syntax, [], 'null is not an error');
});

test('validateFiles: malformed JSON is judged by parse, not by node --check', async () => {
  const p = create({ projectDir: freshDir() });
  const bad = write('broken.json', '{ "a": }');
  const good = write('fine.json', '{"a":1}');
  const res = await p.validateFiles([bad, good], { runSyntax: true });
  assert.equal(res.syntax.length, 1);
  assert.match(res.syntax[0].message, /JSON 解析失败/);
  assert.equal(res.syntax[0].file.replace(/\\/g, '/'), 'broken.json');
});

test('validateFiles: extension-less-to-node-check types are skipped, not misreported', async () => {
  const p = create({ projectDir: freshDir() });
  // node --check cannot load .ts/.tsx/.jsx by extension at all; the unit must not turn
  // that loader limitation into a fake syntax error (documented .jsx trap).
  const jsx = write('comp.jsx', "export default () => <div className='a'>x</div>;\n");
  const ts = write('typed.ts', 'export const n: number = 1;\n');
  const res = await p.validateFiles([jsx, ts], { runSyntax: true });
  assert.deepEqual(res.syntax, [], JSON.stringify(res.syntax));
});

test('validateFiles: a vanished path (rename/delete) is skipped rather than reported', async () => {
  const dir = freshDir();
  const p = create({ projectDir: dir });
  assert.deepEqual((await p.validateFiles(['never-existed.js'], { runSyntax: true, runGuards: true })).syntax, []);
  const rel = write('broken-then-deleted.js', 'const a = ;\n');
  const before = await p.validateFiles([rel], { runSyntax: true });
  assert.equal(before.syntax.length, 1, 'sanity: the file did have a syntax error');
  fs.rmSync(path.join(dir, rel), { force: true });
  const after = await p.validateFiles([rel], { runSyntax: true });
  assert.deepEqual(after.syntax, [], 'once it is gone it is not an error');
});

test('validateFiles: a missing or unparseable target never rejects the probe', async () => {
  const p = create({ projectDir: freshDir() });
  const r = await p.validateFiles(['missing.js'], { runSyntax: true, runGuards: true });
  assert.ok(Array.isArray(r.syntax) && Array.isArray(r.guards));
  assert.equal(typeof r.tests.ok, 'boolean', 'tests always carry a boolean shape');
  assert.equal(r.tests.ran, false, 'no runnable tests were discovered');
});

test('the IO surface is confined to this factory (worktree safety)', () => {
  const src = fs.readFileSync(require.resolve('./primitives'), 'utf8');
  assert.ok(/'stash', 'create'/.test(src), 'snapshot must use git stash create (worktree untouched)');
  assert.ok(!/git stash (push|save)/.test(src) && !/'stash', 'push'/.test(src),
    'never stash push/save — that would move the user worktree');
  assert.ok(!/'checkout',\s*'--'/.test(src), 'never bare git checkout -- (would discard other work)');
});
