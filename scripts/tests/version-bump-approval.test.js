'use strict';

/**
 * 版本守卫的契约测试（node:test）。
 *
 * 锁三件事：
 *   ① MINOR/MAJOR 递增无批准标记 → 拦（exit 1），且拦的是「绕过 version-mode.js
 *      直接编辑 pyproject.toml」这条路径——暂存区和工作区两边都要看
 *   ② PATCH 递增 → 放行（开发态批次 bump 已由 T4 预授权，逐次审批会废掉自动 bump）
 *   ③ 版本号未变 / 非 X.Y.Z → 放行不误伤
 *
 * 做法：把仓库真文件复制到临时目录当 fixture，跑真实子进程，只断言退出码与 stderr。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'check-version-bump-approval.js');
const PYPROJECT = 'pyproject.toml';

function fixture(headVersion, worktreeVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vappr-'));
  fs.writeFileSync(path.join(dir, PYPROJECT), `[project]\nname = "khy-os"\nversion = "${worktreeVersion}"\n`);
  // 造一个最小 git 仓，让 HEAD:<file> 与 :<file> 都能取到值
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, PYPROJECT), `[project]\nname = "khy-os"\nversion = "${headVersion}"\n`);
  git(['add', PYPROJECT]);
  git(['commit', '-q', '-m', 'base']);
  // 然后把工作区改成目标版本（不 add，模拟「手改了但没 git add」）
  fs.writeFileSync(path.join(dir, PYPROJECT), `[project]\nname = "khy-os"\nversion = "${worktreeVersion}"\n`);
  // 复制脚本
  fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'ci', 'check-version-bump-approval.js'));
  return dir;
}

function run(dir, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'ci', 'check-version-bump-approval.js'), ...extra], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('MINOR 递增无批准标记 → 拦', () => {
  const dir = fixture('1.2.0', '1.3.0');
  const r = run(dir);
  assert.equal(r.code, 1, '应 exit 1');
  assert.match(r.out, /MINOR/, '应说明是 MINOR');
  assert.match(r.out, /R-2a/, '应引用规则');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MAJOR 递增无批准标记 → 拦', () => {
  const dir = fixture('1.2.0', '2.0.0');
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /MAJOR/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('带批准标记 → 放行', () => {
  const dir = fixture('1.2.0', '1.3.0');
  const msg = path.join(dir, 'msg.txt');
  fs.writeFileSync(msg, 'feat: whatever\n\nversion-bump-approved-by: 孔浩原\n');
  const r = run(dir, ['--message-file', msg]);
  assert.equal(r.code, 0, '有批准人应放行');
  assert.match(r.out, /批准人/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('批准标记为空 → 仍拦（不许写个空壳糊弄）', () => {
  const dir = fixture('1.2.0', '1.3.0');
  const msg = path.join(dir, 'msg.txt');
  fs.writeFileSync(msg, 'feat: whatever\n\nversion-bump-approved-by:    \n');
  const r = run(dir, ['--message-file', msg]);
  assert.equal(r.code, 1, '空批准人应视为未批准');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PATCH 递增 → 放行（开发态已预授权）', () => {
  const dir = fixture('1.2.0', '1.2.7');
  const r = run(dir);
  assert.equal(r.code, 0, 'PATCH 不得拦，否则开发态自动 bump 就废了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('版本号未变 → 放行不误伤', () => {
  const dir = fixture('1.2.0', '1.2.0');
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /未变/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非 X.Y.Z → 放行不误伤（归 check-version-sync 管）', () => {
  const dir = fixture('1.2.0', 'abc');
  const r = run(dir);
  assert.equal(r.code, 0, '非 semver 不是本守卫的管辖范围');
  fs.rmSync(dir, { recursive: true, force: true });
});
