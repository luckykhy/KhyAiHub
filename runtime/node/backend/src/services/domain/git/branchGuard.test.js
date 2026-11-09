'use strict';

/**
 * branchGuard.test.js — 分支判据纯叶子的共置测试（node:test 方言）。
 *
 * 覆盖：分支名合法性、未解决冲突、进行中操作、worktree 占用、覆盖风险、
 * 总前置判据（switch / create）、git stderr → 错误码翻译。
 */

const test = require('node:test');
const assert = require('node:assert');

const guard = require('./branchGuard');

// ── 分支名合法性 ────────────────────────────────────────────────────────────

test('isValidBranchName：常规名通过', () => {
  assert.strictEqual(guard.isValidBranchName('main'), true);
  assert.strictEqual(guard.isValidBranchName('feature/git-branch-switcher'), true);
  assert.strictEqual(guard.isValidBranchName('feat/x_1.y-z'), true);
  assert.strictEqual(guard.isValidBranchName('release-2026-11'), true);
});

test('isValidBranchName：非法名被拒', () => {
  assert.strictEqual(guard.isValidBranchName(''), false);
  assert.strictEqual(guard.isValidBranchName('   '), false);
  assert.strictEqual(guard.isValidBranchName('-leading-dash'), false);
  assert.strictEqual(guard.isValidBranchName('trailing/slash/'), false);
  assert.strictEqual(guard.isValidBranchName('double..dot'), false);
  assert.strictEqual(guard.isValidBranchName('double//slash'), false);
  assert.strictEqual(guard.isValidBranchName('has..brace@{0}'), false);
  assert.strictEqual(guard.isValidBranchName('has space'), false);
  assert.strictEqual(guard.isValidBranchName('has~tilde'), false);
  assert.strictEqual(guard.isValidBranchName('has^caret'), false);
  assert.strictEqual(guard.isValidBranchName('has:colon'), false);
  assert.strictEqual(guard.isValidBranchName('has?question'), false);
  assert.strictEqual(guard.isValidBranchName('has*star'), false);
  assert.strictEqual(guard.isValidBranchName('has[bracket'), false);
  assert.strictEqual(guard.isValidBranchName('has\\backslash'), false);
  assert.strictEqual(guard.isValidBranchName('.hidden'), false);
  assert.strictEqual(guard.isValidBranchName('foo.lock'), false);
  assert.strictEqual(guard.isValidBranchName('x'.repeat(256)), false);
});

test('isValidBranchName：非字符串入参不抛', () => {
  assert.strictEqual(guard.isValidBranchName(null), false);
  assert.strictEqual(guard.isValidBranchName(undefined), false);
  assert.strictEqual(guard.isValidBranchName(123), false);
  assert.strictEqual(guard.isValidBranchName({}), false);
});

// ── 未解决冲突 ──────────────────────────────────────────────────────────────

test('hasUnresolvedConflicts：有路径即为有冲突', () => {
  assert.strictEqual(guard.hasUnresolvedConflicts('src/a.js\nsrc/b.js'), true);
  assert.strictEqual(guard.hasUnresolvedConflicts('src/a.js'), true);
});

test('hasUnresolvedConflicts：空输出为无冲突', () => {
  assert.strictEqual(guard.hasUnresolvedConflicts(''), false);
  assert.strictEqual(guard.hasUnresolvedConflicts('   \n  '), false);
  assert.strictEqual(guard.hasUnresolvedConflicts(null), false);
  assert.strictEqual(guard.hasUnresolvedConflicts(undefined), false);
});

// ── 进行中操作 ──────────────────────────────────────────────────────────────

test('hasOperationInProgress：标志列表非空即为有操作', () => {
  assert.strictEqual(guard.hasOperationInProgress(['rebase-merge']), true);
  assert.strictEqual(guard.hasOperationInProgress(['MERGE_HEAD']), true);
});

test('hasOperationInProgress：空列表或全空串为无操作', () => {
  assert.strictEqual(guard.hasOperationInProgress([]), false);
  assert.strictEqual(guard.hasOperationInProgress(['']), false);
  assert.strictEqual(guard.hasOperationInProgress(['  ']), false);
  assert.strictEqual(guard.hasOperationInProgress(null), false);
  assert.strictEqual(guard.hasOperationInProgress(undefined), false);
});

// ── worktree 占用 ───────────────────────────────────────────────────────────

test('isBranchInOtherWorktree：目标分支在别的 worktree 检出 → true', () => {
  const porcelain = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.khy/worktrees/feat',
    'HEAD def456',
    'branch refs/heads/feature/x',
  ].join('\n');
  assert.strictEqual(
    guard.isBranchInOtherWorktree(porcelain, 'feature/x', '/repo'),
    true
  );
});

test('isBranchInOtherWorktree：目标分支就在当前 worktree → false', () => {
  const porcelain = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
  ].join('\n');
  assert.strictEqual(guard.isBranchInOtherWorktree(porcelain, 'main', '/repo'), false);
});

test('isBranchInOtherWorktree：目标分支不在任何 worktree → false', () => {
  const porcelain = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
  ].join('\n');
  assert.strictEqual(
    guard.isBranchInOtherWorktree(porcelain, 'feature/none', '/repo'),
    false
  );
});

test('isBranchInOtherWorktree：斜杠方向不同但同一路径 → false', () => {
  // 回归：git 在 Windows 上输出正斜杠路径（`C:/Users/x/repo`），而 cwd 是
  // 反斜杠（`C:\Users\x\repo`）。不归一化就会把当前 worktree 误判成别的
  // worktree → 切换被无谓阻断。
  const porcelain = [
    'worktree C:/Users/x/repo',
    'HEAD abc123',
    'branch refs/heads/main',
  ].join('\n');
  assert.strictEqual(
    guard.isBranchInOtherWorktree(porcelain, 'main', 'C:\\Users\\x\\repo'),
    false
  );
});

test('isBranchInOtherWorktree：末尾斜杠差异 → false', () => {
  const porcelain = [
    'worktree C:/Users/x/repo/',
    'HEAD abc123',
    'branch refs/heads/main',
  ].join('\n');
  assert.strictEqual(
    guard.isBranchInOtherWorktree(porcelain, 'main', 'C:\\Users\\x\\repo'),
    false
  );
});

test('isBranchInOtherWorktree：确实不同路径 → true', () => {
  const porcelain = [
    'worktree C:/Users/x/repo',
    'HEAD abc123',
    'branch refs/heads/main',
  ].join('\n');
  assert.strictEqual(
    guard.isBranchInOtherWorktree(porcelain, 'main', 'D:\\other\\repo'),
    true
  );
});

test('isBranchInOtherWorktree：空入参不抛', () => {
  assert.strictEqual(guard.isBranchInOtherWorktree('', 'x', '/repo'), false);
  assert.strictEqual(guard.isBranchInOtherWorktree('worktree /repo', '', '/repo'), false);
});

// ── 覆盖风险 ────────────────────────────────────────────────────────────────

test('assessOverwriteRisk：空集合不阻断', () => {
  const risk = guard.assessOverwriteRisk([], []);
  assert.strictEqual(risk.blocked, false);
  assert.deepStrictEqual(risk.tracked, []);
  assert.deepStrictEqual(risk.untracked, []);
});

test('assessOverwriteRisk：已跟踪文件被覆盖 → 阻断', () => {
  const risk = guard.assessOverwriteRisk(['a.js'], []);
  assert.strictEqual(risk.blocked, true);
  assert.deepStrictEqual(risk.tracked, ['a.js']);
});

test('assessOverwriteRisk：未跟踪文件被覆盖 → 阻断', () => {
  const risk = guard.assessOverwriteRisk([], ['b.js']);
  assert.strictEqual(risk.blocked, true);
  assert.deepStrictEqual(risk.untracked, ['b.js']);
});

test('assessOverwriteRisk：非数组入参归一为空', () => {
  const risk = guard.assessOverwriteRisk(null, undefined);
  assert.strictEqual(risk.blocked, false);
});

// ── 总前置判据：切换 ────────────────────────────────────────────────────────

test('assessSwitch：干净仓库放行', () => {
  const v = guard.assessSwitch({ branchName: 'feature/x', branchExists: true });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.code, 'ok');
});

test('assessSwitch：分支名非法 → invalidBranchName', () => {
  const v = guard.assessSwitch({ branchName: '-bad' });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'invalidBranchName');
});

test('assessSwitch：目标分支不存在 → targetBranchNotFound', () => {
  const v = guard.assessSwitch({ branchName: 'nope', branchExists: false });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'targetBranchNotFound');
});

test('assessSwitch：有未解决冲突 → conflictsPresent', () => {
  const v = guard.assessSwitch({ branchName: 'x', branchExists: true, conflicted: true });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'conflictsPresent');
});

test('assessSwitch：有进行中操作 → operationInProgress', () => {
  const v = guard.assessSwitch({
    branchName: 'x',
    branchExists: true,
    operationInProgress: true,
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'operationInProgress');
});

test('assessSwitch：分支在别的 worktree → branchInOtherWorktree', () => {
  const v = guard.assessSwitch({
    branchName: 'x',
    branchExists: true,
    inOtherWorktree: true,
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'branchInOtherWorktree');
});

test('assessSwitch：改动会被覆盖 → dirtyWorkingTree 且带明细', () => {
  const v = guard.assessSwitch({
    branchName: 'x',
    branchExists: true,
    trackedOverwrite: ['a.js'],
    untrackedOverwrite: ['b.js'],
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'dirtyWorkingTree');
  assert.deepStrictEqual(v.detail.tracked, ['a.js']);
  assert.deepStrictEqual(v.detail.untracked, ['b.js']);
});

test('assessSwitch：判据优先级——冲突先于分支不存在', () => {
  const v = guard.assessSwitch({
    branchName: 'x',
    branchExists: false,
    conflicted: true,
  });
  assert.strictEqual(v.code, 'conflictsPresent');
});

test('assessSwitch：非法入参不抛', () => {
  assert.strictEqual(guard.assessSwitch(null).allowed, false);
  assert.strictEqual(guard.assessSwitch(undefined).allowed, false);
  assert.strictEqual(guard.assessSwitch({}).code, 'invalidBranchName');
});

// ── 总前置判据：创建 ────────────────────────────────────────────────────────

test('assessCreate：干净仓库放行', () => {
  const v = guard.assessCreate({ branchName: 'feature/new' });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.code, 'ok');
});

test('assessCreate：同名分支已存在 → branchAlreadyExists', () => {
  const v = guard.assessCreate({ branchName: 'main', branchExists: true });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'branchAlreadyExists');
});

test('assessCreate：分支名非法 → invalidBranchName', () => {
  const v = guard.assessCreate({ branchName: 'bad name' });
  assert.strictEqual(v.code, 'invalidBranchName');
});

test('assessCreate：有冲突 → conflictsPresent', () => {
  const v = guard.assessCreate({ branchName: 'x', conflicted: true });
  assert.strictEqual(v.code, 'conflictsPresent');
});

test('assessCreate：有进行中操作 → operationInProgress', () => {
  const v = guard.assessCreate({ branchName: 'x', operationInProgress: true });
  assert.strictEqual(v.code, 'operationInProgress');
});

// ── git stderr → 错误码 ─────────────────────────────────────────────────────

test('classifyGitFailure：常见失败各有对应码', () => {
  assert.strictEqual(
    guard.classifyGitFailure("fatal: a branch named 'x' already exists"),
    'branchAlreadyExists'
  );
  assert.strictEqual(
    guard.classifyGitFailure("fatal: 'x' is not a valid branch name"),
    'invalidBranchName'
  );
  assert.strictEqual(
    guard.classifyGitFailure("fatal: invalid reference: nope"),
    'targetBranchNotFound'
  );
  assert.strictEqual(
    guard.classifyGitFailure("fatal: 'x' is already used by worktree at '/other'"),
    'branchInOtherWorktree'
  );
  assert.strictEqual(
    guard.classifyGitFailure('error: Your local changes to the following files would be overwritten'),
    'dirtyWorkingTree'
  );
});

test('classifyGitFailure：未知失败诚实落到 unknown', () => {
  assert.strictEqual(guard.classifyGitFailure('something odd happened'), 'unknown');
  assert.strictEqual(guard.classifyGitFailure(''), 'unknown');
  assert.strictEqual(guard.classifyGitFailure(null), 'unknown');
});
