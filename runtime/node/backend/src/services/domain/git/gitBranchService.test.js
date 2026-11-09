'use strict';

/**
 * gitBranchService.test.js — 分支执行层的共置测试（node:test 方言）。
 *
 * 与 branchGuard.test.js 的分工：那一份测**判据**（纯函数、零 IO），这一份测
 * **执行**（真跑 git）。执行层的价值恰恰在于「真仓库上真切换」，故测试在
 * 临时目录里建真 git 仓库，而不是 mock 掉 exec。
 *
 * 每次测试自建自销临时仓库，绝不碰仓库自身的 .git。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const service = require('./gitBranchService');

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let _tmpRoot = null;

/** 建一个带一次提交的临时 git 仓库，返回其路径。 */
function _makeRepo() {
  const dir = fs.mkdtempSync(path.join(_tmpRoot, 'repo-'));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf-8');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

/**
 * 读出仓库的当前分支名。
 *
 * 刻意不写死 'main'：`git init` 的默认分支名受 init.defaultBranch 与 git 版本
 * 影响（实测本机不是 main）。写死会让「同名分支已存在」这类用例在别的机器上
 * 变成「分支不存在」而误判为产品缺陷。
 *
 * @param {string} dir
 * @returns {string}
 */
function _currentBranch(dir) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
    encoding: 'utf-8',
    windowsHide: true,
  }).trim();
}

test.before(() => {
  _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-git-branch-'));
});

test.after(() => {
  if (_tmpRoot) {
    try {
      fs.rmSync(_tmpRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻断测试结论 */
    }
  }
});

// ── isGitRepo ───────────────────────────────────────────────────────────────

test('isGitRepo：真实仓库 → true', () => {
  const dir = _makeRepo();
  assert.strictEqual(service.isGitRepo(dir), true);
});

test('isGitRepo：非仓库目录 → false', () => {
  const dir = fs.mkdtempSync(path.join(_tmpRoot, 'plain-'));
  assert.strictEqual(service.isGitRepo(dir), false);
});

// ── listBranches ────────────────────────────────────────────────────────────

test('listBranches：列出本地分支并标出当前分支', () => {
  const dir = _makeRepo();
  const res = service.listBranches(dir);
  assert.strictEqual(res.ok, true);
  assert.ok(res.branches.length >= 1);
  const current = res.branches.filter((b) => b.current);
  assert.strictEqual(current.length, 1, '有且只有一个当前分支');
});

test('listBranches：当前分支排在最前', () => {
  const dir = _makeRepo();
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  git(['branch', 'aaa-first-alphabetically-later']);
  git(['branch', 'zzz-last-alphabetically-earlier']);
  const res = service.listBranches(dir);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.branches[0].current, true, '当前分支必须在首位');
});

test('listBranches：当前分支不被误标成在其它 worktree', () => {
  // 回归：`%(worktreepath)` 对**当前** worktree 检出的分支同样返回路径，
  // 不判 isCurrent 就会把当前分支标成「已在其它 worktree 检出」。
  const dir = _makeRepo();
  const res = service.listBranches(dir);
  assert.strictEqual(res.ok, true);
  const current = res.branches.find((b) => b.current);
  assert.ok(current, '必须有当前分支');
  assert.strictEqual(current.inOtherWorktree, false, '当前分支不算在其它 worktree');
});

test('listBranches：非仓库 → notRepository', () => {
  const dir = fs.mkdtempSync(path.join(_tmpRoot, 'plain2-'));
  const res = service.listBranches(dir);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'notRepository');
});

// ── createBranch ────────────────────────────────────────────────────────────

test('createBranch：创建并切换到新分支', () => {
  const dir = _makeRepo();
  const res = service.createBranch(dir, 'feature/new-branch');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.branch, 'feature/new-branch');

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
    encoding: 'utf-8',
  }).trim();
  assert.strictEqual(branch, 'feature/new-branch', 'HEAD 确实切到了新分支');
});

test('createBranch：同名分支已存在 → branchAlreadyExists', () => {
  const dir = _makeRepo();
  const res = service.createBranch(dir, _currentBranch(dir));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'branchAlreadyExists');
});

test('createBranch：非法分支名 → invalidBranchName', () => {
  const dir = _makeRepo();
  const res = service.createBranch(dir, 'bad name');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'invalidBranchName');
});

test('createBranch：非仓库 → notRepository', () => {
  const dir = fs.mkdtempSync(path.join(_tmpRoot, 'plain3-'));
  const res = service.createBranch(dir, 'x');
  assert.strictEqual(res.code, 'notRepository');
});

// ── switchBranch ────────────────────────────────────────────────────────────

test('switchBranch：在已有分支之间切换', () => {
  const dir = _makeRepo();
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  git(['branch', 'feature/other']);

  const res = service.switchBranch(dir, 'feature/other');
  assert.strictEqual(res.ok, true);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  assert.strictEqual(branch, 'feature/other');
});

test('switchBranch：目标分支不存在 → targetBranchNotFound', () => {
  const dir = _makeRepo();
  const res = service.switchBranch(dir, 'feature/does-not-exist');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'targetBranchNotFound');
});

test('switchBranch：非法分支名 → invalidBranchName', () => {
  const dir = _makeRepo();
  const res = service.switchBranch(dir, '-bad');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'invalidBranchName');
});

test('switchBranch：本地改动会被覆盖 → dirtyWorkingTree 且带明细', () => {
  const dir = _makeRepo();
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });

  // 先记下原分支名——切换到 feature/other 之后「当前分支」就是它自己，
  // 再去读就拿不到目标分支了。
  const baseBranch = _currentBranch(dir);

  // 在 feature/other 上提交一份**内容不同**的 a.txt，再在本地改一次。
  // 只有目标分支与 HEAD 的该文件内容不同，切换才会覆盖本地修改。
  git(['switch', '-q', '-c', 'feature/other']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'committed on feature\n', 'utf-8');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'feature change']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uncommitted local edit\n', 'utf-8');

  const res = service.switchBranch(dir, baseBranch);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'dirtyWorkingTree');
  assert.ok(res.detail, '阻断必须带受影响文件明细');
  assert.ok(res.detail.tracked.includes('a.txt'), 'a.txt 应在受影响已跟踪文件里');
});

test('switchBranch：干净工作区切换成功', () => {
  const dir = _makeRepo();
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  git(['branch', 'feature/clean']);

  const res = service.switchBranch(dir, 'feature/clean');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/clean');
});

test('switchBranch：非仓库 → notRepository', () => {
  const dir = fs.mkdtempSync(path.join(_tmpRoot, 'plain4-'));
  const res = service.switchBranch(dir, 'main');
  assert.strictEqual(res.code, 'notRepository');
});

// ── 错误消息表 ──────────────────────────────────────────────────────────────

test('_MESSAGE：每个判据错误码都有中文兜底文案', () => {
  const codes = [
    'invalidBranchName',
    'branchAlreadyExists',
    'targetBranchNotFound',
    'conflictsPresent',
    'operationInProgress',
    'branchInOtherWorktree',
    'dirtyWorkingTree',
    'notRepository',
    'unknown',
  ];
  for (const code of codes) {
    assert.ok(
      typeof service._MESSAGE[code] === 'string' && service._MESSAGE[code].length > 0,
      `错误码 ${code} 缺中文兜底文案`
    );
  }
});

test('_MESSAGE：文案是中文而非英文 stderr', () => {
  assert.ok(/[一-龥]/.test(service._MESSAGE.invalidBranchName));
  assert.ok(/[一-龥]/.test(service._MESSAGE.targetBranchNotFound));
});
