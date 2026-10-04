'use strict';

// Unit-level contract tests for updateGuard.js (co-located, per [RESEARCH-018] §2.3).
// Three defenses over a single official update package: plan (every target must stay inside
// the core track AND outside every protected user track, or the whole package is fail-closed
// unsafe), compatibility diff (removed entry points ⇒ a migration prompt, never a silent void),
// and apply (write only when the plan is safe). Path math is pure (no disk); the writer's fs is
// injected and recorded. Expected values are read straight off the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('path');

const { planOfficialUpdate, detectBreakingChange, applyOfficialUpdate } = require('./updateGuard');

const CORE = P.resolve('official_core');

test('planOfficialUpdate requires a coreRoot', () => {
  assert.throws(() => planOfficialUpdate({ incomingFiles: [] }), /缺少 coreRoot/);
});

test('a package fully inside the core track is safe', () => {
  const plan = planOfficialUpdate({
    coreRoot: CORE,
    incomingFiles: [{ path: 'a.js', content: 'x' }, { path: P.join('sub', 'b.js'), content: 'y' }],
  });
  assert.equal(plan.safe, true);
  assert.equal(plan.allowed.length, 2);
  assert.deepEqual(plan.rejected, []);
  assert.equal(plan.allowed[0].abs, P.resolve(CORE, 'a.js'));
  assert.equal(plan.allowed[0].content, 'x');
});

test('a file escaping the core track rejects and fails the whole package closed (红线4)', () => {
  const plan = planOfficialUpdate({
    coreRoot: CORE,
    incomingFiles: [{ path: 'ok.js' }, { path: P.join('..', 'escape.js') }],
  });
  assert.equal(plan.safe, false);
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /落在官方核心轨之外/);
});

test('a target with no path is rejected as malformed', () => {
  const plan = planOfficialUpdate({ coreRoot: CORE, incomingFiles: [{}, { content: 'x' }] });
  assert.equal(plan.rejected.length, 2);
  assert.ok(plan.rejected.every((r) => r.reason === '缺少 path'));
  assert.equal(plan.safe, false);
});

test('a target landing in a protected user track is rejected (红线4)', () => {
  const protectedRoot = P.resolve('user_patch');
  const plan = planOfficialUpdate({
    coreRoot: protectedRoot, // core overlaps the protected dir to prove the protected check wins
    protectedRoots: [protectedRoot],
    incomingFiles: [{ path: 'keep.js' }],
  });
  assert.equal(plan.safe, false);
  assert.match(plan.rejected[0].reason, /命中受保护用户扩展轨/);
});

test('a path segment naming a protected track is rejected even if nominally inside core', () => {
  const plan = planOfficialUpdate({
    coreRoot: CORE,
    incomingFiles: [{ path: P.join('user_patch', 'x.js') }, { path: P.join('extensions', 'y.js') }],
  });
  assert.equal(plan.safe, false);
  assert.equal(plan.rejected.length, 2);
  assert.ok(plan.rejected.every((r) => /命中受保护用户扩展轨/.test(r.reason)));
});

test('detectBreakingChange reports removed entry points with a migration prompt', () => {
  const res = detectBreakingChange({ oldEntryPoints: ['registerOverride', 'action.params'], newEntryPoints: ['registerOverride'] });
  assert.equal(res.breaking, true);
  assert.deepEqual(res.removed, ['action.params']);
  assert.match(res.migrationPrompt, /破坏性更新/);
  assert.match(res.migrationPrompt, /  - action\.params/);
  assert.match(res.migrationPrompt, /手动迁移/);
});

test('detectBreakingChange is clean when nothing is removed', () => {
  const res = detectBreakingChange({ oldEntryPoints: ['a', 'b'], newEntryPoints: ['a', 'b', 'c'] });
  assert.deepEqual(res, { breaking: false, removed: [], migrationPrompt: null });
});

test('detectBreakingChange tolerates non-array inputs', () => {
  assert.equal(detectBreakingChange({}).breaking, false);
  // old present but new missing → everything in old is removed.
  const res = detectBreakingChange({ oldEntryPoints: ['x'], newEntryPoints: undefined });
  assert.equal(res.breaking, true);
  assert.deepEqual(res.removed, ['x']);
});

test('applyOfficialUpdate refuses an unsafe or missing plan', () => {
  const fs = { mkdirSync: () => { throw new Error('must not write'); }, writeFileSync: () => { throw new Error('must not write'); } };
  assert.deepEqual(applyOfficialUpdate({ plan: null, fs }), {
    applied: [], aborted: true, reason: '更新包不安全（命中用户轨或越界），已拒绝施工（红线4）',
  });
  assert.equal(applyOfficialUpdate({ plan: { safe: false, allowed: [] }, fs }).aborted, true);
});

test('applyOfficialUpdate writes exactly the allowed set when the plan is safe', () => {
  const writes = [];
  const fs = { mkdirSync: () => {}, writeFileSync: (abs, content, enc) => writes.push({ abs, content, enc }) };
  const aAbs = P.resolve(CORE, 'a.js');
  const bAbs = P.resolve(CORE, 'b.js');
  const plan = { safe: true, allowed: [{ abs: aAbs, content: 'AAA' }, { abs: bAbs, content: null }], rejected: [] };
  const res = applyOfficialUpdate({ plan, fs });
  assert.equal(res.aborted, false);
  assert.deepEqual(res.applied, [aAbs, bAbs]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].content, 'AAA');
  assert.equal(writes[1].content, '', 'null content is written as empty string');
  assert.ok(writes.every((w) => w.enc === 'utf8'));
});
