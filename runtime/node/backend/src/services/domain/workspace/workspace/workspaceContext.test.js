'use strict';

// Colocated tests for workspaceContext.js.
// All git-touching collaborators (gitContextService, gitExecutableDetector,
// additionalDirectories) are stubbed via require.cache BEFORE the target require,
// so no child process is ever spawned and no repo state is read.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(relPath, exports) {
  const key = require.resolve(relPath);
  const original = require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
  return { key, original, exports };
}

// detector returning null → _git() short-circuits to null on win32 (no execSync).
const dStub = stub('../../../gitExecutableDetector', { detectGitExecutable: () => null });
const gitStub = stub('../../../gitContextService', { collectGitContext: () => ({ isGitRepo: false }) });
const addDirsStub = stub('../../../additionalDirectories', { getDirectories: () => ['D:/extra'] });

const svc = require('./workspaceContext');

test.after(() => {
  for (const s of [dStub, gitStub, addDirsStub]) {
    if (s.original) require.cache[s.key] = s.original;
    else delete require.cache[s.key];
  }
});

test('redactRemote：剥掉 userinfo 凭据，无凭据原样返回', () => {
  assert.equal(svc.redactRemote('https://user:token@host/x.git'), 'https://***@host/x.git');
  assert.equal(svc.redactRemote('https://oauth2:glpat-abc@gitlab.com/a/b.git'), 'https://***@gitlab.com/a/b.git');
  assert.equal(svc.redactRemote('HTTPS://User@Host/x'), 'HTTPS://***@Host/x');
  assert.equal(svc.redactRemote('https://host/x.git'), 'https://host/x.git');
  assert.equal(svc.redactRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git'); // scp 语法无 scheme 不处理
  assert.equal(svc.redactRemote(''), '');
  assert.equal(svc.redactRemote(null), '');
  assert.equal(svc.redactRemote(undefined), '');
  assert.equal(svc.redactRemote(0), '');
});

// KNOWN-DEFECT: redactRemote 对非字符串真值（如 {} / 123）直接抛 TypeError
// （workspaceContext.js:44-50 只判 !url 不判 typeof），与模块「fail-soft 全程」的自我描述不符
// （低危：唯一调用点传的是 _git 产出的 string/null，未见实际崩溃路径）。
test('KNOWN-DEFECT: redactRemote(非字符串真值) 抛 TypeError 而非返回空串', () => {
  assert.throws(() => svc.redactRemote({}), TypeError);
  assert.throws(() => svc.redactRemote(123), TypeError);
  assert.throws(() => svc.redactRemote([]), TypeError);
});

test('_countDirty：staged/unstaged/untracked 计数与 ## 头忽略', () => {
  const status = [
    '## main...origin/main',
    'M  staged.js',
    ' M unstaged.js',
    'MM both.js',
    'A  added.js',
    'D  deleted.js',
    '?? new.txt',
    '?? dir/',
    '',
  ].join('\n');
  assert.deepEqual(svc._countDirty(status), { staged: 4, unstaged: 2, untracked: 2, total: 7 });
});

test('_countDirty 垃圾入参返全零', () => {
  assert.deepEqual(svc._countDirty(null), { staged: 0, unstaged: 0, untracked: 0, total: 0 });
  assert.deepEqual(svc._countDirty(''), { staged: 0, unstaged: 0, untracked: 0, total: 0 });
  assert.deepEqual(svc._countDirty(0), { staged: 0, unstaged: 0, untracked: 0, total: 0 });
});

test('_aheadBehind：git 不可用（detector=null）→ hasUpstream false', () => {
  assert.deepEqual(svc._aheadBehind('D:/anywhere'), { ahead: 0, behind: 0, hasUpstream: false });
});

test('collectWorkspaceContext：非 git 目录 → 安全默认 + additionalDirs 注入', () => {
  const ctx = svc.collectWorkspaceContext('D:/not-a-repo');
  assert.equal(ctx.isGitRepo, false);
  assert.equal(ctx.root, 'D:/not-a-repo');
  assert.equal(ctx.branch, '');
  assert.equal(ctx.hasRemote, false);
  assert.equal(ctx.ahead, 0);
  assert.equal(ctx.isDirty, false);
  assert.deepEqual(ctx.dirtyCounts, { staged: 0, unstaged: 0, untracked: 0, total: 0 });
  assert.deepEqual(ctx.additionalDirs, ['D:/extra']);
});

test('collectWorkspaceContext：collectGitContext 抛错 → 同样降级非 git 形状', () => {
  // workspaceContext 在模块加载时捕获了 stub 的 exports 对象引用——
  // 必须原地换方法，不能整对象替换 require.cache
  const impl = gitStub.exports.collectGitContext;
  gitStub.exports.collectGitContext = () => {
    throw new Error('boom');
  };
  try {
    const ctx = svc.collectWorkspaceContext('D:/x');
    assert.equal(ctx.isGitRepo, false);
    assert.equal(ctx.remoteUrlSafe, '');
  } finally {
    gitStub.exports.collectGitContext = impl;
  }
});

test('collectWorkspaceContext：git 仓库面 fail-soft（git 二进制不可用）', () => {
  const impl = gitStub.exports.collectGitContext;
  gitStub.exports.collectGitContext = () => ({
    isGitRepo: true,
    branch: 'main',
    mainBranch: 'main',
    isDirty: true,
    recentLog: 'abc feat',
  });
  try {
    const ctx = svc.collectWorkspaceContext('D:/repo');
    assert.equal(ctx.isGitRepo, true);
    assert.equal(ctx.branch, 'main');
    assert.equal(ctx.mainBranch, 'main');
    assert.equal(ctx.isDirty, true);
    assert.equal(ctx.recentLog, 'abc feat');
    // detector=null 下 _git 全 null → root 回退 cwd、无远端、脏计数 0、无上游
    assert.equal(ctx.root, 'D:/repo');
    assert.equal(ctx.hasRemote, false);
    assert.equal(ctx.hasUpstream, false);
    assert.deepEqual(ctx.dirtyCounts, { staged: 0, unstaged: 0, untracked: 0, total: 0 });
  } finally {
    gitStub.exports.collectGitContext = impl;
  }
});

test('collectWorkspaceContext 垃圾 cwd：空串回退 env/cwd，不抛', () => {
  const ctx = svc.collectWorkspaceContext('');
  assert.equal(typeof ctx.root, 'string');
  assert.ok(ctx.root.length > 0);
});

test('formatSummary：null → 不可用；非 git → 提示 + 额外目录数', () => {
  assert.equal(svc.formatSummary(null), '工作区信息不可用');
  const nonGit = svc.formatSummary({ isGitRepo: false, root: 'D:/x', additionalDirs: ['a', 'b'] });
  assert.ok(nonGit.includes('非 git 仓库'));
  assert.ok(nonGit.includes('额外目录 2 个'));
  assert.equal(
    svc.formatSummary({ isGitRepo: false, root: 'D:/x' }).includes('额外目录'),
    false
  );
});

test('formatSummary：git 全量面（远端/同步/脏计数/主分支省略）', () => {
  const full = svc.formatSummary({
    isGitRepo: true,
    root: 'D:/repo',
    branch: 'feat',
    mainBranch: 'main',
    hasRemote: true,
    hasUpstream: true,
    ahead: 2,
    behind: 1,
    remoteUrl: 'https://u:p@host/x.git',
    remoteUrlSafe: 'https://***@host/x.git',
    isDirty: true,
    dirtyCounts: { staged: 1, unstaged: 2, untracked: 3, total: 6 },
    additionalDirs: ['e1'],
  });
  assert.ok(full.includes('工作区：D:/repo'));
  assert.ok(full.includes('分支：feat（主分支 main）'));
  assert.ok(full.includes('远端：https://***@host/x.git（领先 2 个提交、落后 1 个提交）'));
  assert.ok(full.includes('改动：已暂存 1、未暂存 2、未跟踪 3（共 6 项待保存）'));
  assert.ok(full.includes('额外目录：1 个'));

  // 分支 === 主分支 → 不重复标注
  const same = svc.formatSummary({ isGitRepo: true, root: 'D:/r', branch: 'main', mainBranch: 'main', hasRemote: false, isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 } });
  assert.ok(!same.includes('主分支'));
  assert.ok(same.includes('远端：未配置'));

  // 无上游 / 同步 / 干净
  const sync = svc.formatSummary({ isGitRepo: true, root: 'D:/r', branch: 'main', hasRemote: true, remoteUrlSafe: 'https://h/x', hasUpstream: false, isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 } });
  assert.ok(sync.includes('尚未设置上游分支'));
  const synced = svc.formatSummary({ isGitRepo: true, root: 'D:/r', branch: 'main', hasRemote: true, remoteUrlSafe: 'https://h/x', hasUpstream: true, ahead: 0, behind: 0, isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 } });
  assert.ok(synced.includes('与远端同步'));
  // remoteUrlSafe 缺失 → 现场再脱敏
  const fallback = svc.formatSummary({ isGitRepo: true, root: 'D:/r', branch: 'm', hasRemote: true, remoteUrl: 'https://a:b@h/x', hasUpstream: true, isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 } });
  assert.ok(fallback.includes('https://***@h/x'));
});
