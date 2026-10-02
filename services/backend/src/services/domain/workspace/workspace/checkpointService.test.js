'use strict';

// Colocated tests for checkpointService.js.
// child_process, gitExecutableDetector and utils/dataHome are stubbed via
// require.cache BEFORE the target require, so no git/tar subprocess ever runs
// and all checkpoint storage lands in os.tmpdir(). checkpointObjectStore stays
// real so the CAS round-trip is exercised end to end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ckpt-'));

// ── stubs (installed before requiring the service) ──
const cpKey = require.resolve('child_process');
const cpReal = require.cache[cpKey];
const detectorKey = require.resolve('../../../gitExecutableDetector');
const detectorReal = require.cache[detectorKey];
const dataHomeKey = require.resolve('../../../../utils/dataHome');
const dataHomeReal = require.cache[dataHomeKey];

const gitState = {
  repo: false,
  diff: '',
  stat: '',
  untracked: '',
  branch: '',
  head: '',
  stashList: '',
  tarError: false,
  applyError: false,
  applied: [],
};

function fakeExecFileSync(cmd, args) {
  if (cmd !== 'git') throw new Error('unexpected cmd: ' + cmd);
  if (args[0] === 'rev-parse') {
    if (args[1] === '--is-inside-work-tree') {
      if (!gitState.repo) throw new Error('fatal: not a git repository');
      return 'true\n';
    }
    if (args[1] === '--short') return gitState.head;
  }
  if (args[0] === 'diff') return args.includes('--stat') ? gitState.stat : gitState.diff;
  if (args[0] === 'ls-files') return gitState.untracked;
  if (args[0] === 'branch') return gitState.branch;
  if (args[0] === 'stash') return gitState.stashList;
  throw new Error('unexpected git args: ' + args.join(' '));
}

const fakeCp = {
  execFileSync: fakeExecFileSync,
  execSync(cmd, opts) {
    if (cmd.startsWith('tar ')) {
      if (gitState.tarError) throw new Error('tar: failed');
      const m = /tar czf "([^"]+)"/.exec(cmd);
      if (m) fs.writeFileSync(m[1], 'TARDATA');
      return '';
    }
    if (cmd.startsWith('git')) {
      if (gitState.applyError) {
        const err = new Error('patch failed');
        err.stderr = 'conflict in a.txt';
        throw err;
      }
      gitState.applied.push(opts && typeof opts.input === 'string' ? opts.input : '');
      return '';
    }
    throw new Error('unexpected execSync: ' + cmd);
  },
  execFile(file, args, opts, cb) {
    try {
      const out = fakeExecFileSync(file, args);
      cb(null, { stdout: out });
    } catch (err) {
      cb(err);
    }
  },
  exec(cmd, opts, cb) {
    try {
      cb(null, { stdout: fakeExecFileSync('git', ['stash', 'list', '--oneline']) });
    } catch (err) {
      cb(err);
    }
  },
};

require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: fakeCp };
require.cache[detectorKey] = {
  id: detectorKey,
  filename: detectorKey,
  loaded: true,
  exports: { detectGitExecutable: () => 'git' },
};
require.cache[dataHomeKey] = {
  id: dataHomeKey,
  filename: dataHomeKey,
  loaded: true,
  exports: {
    getDataHome: () => TMP,
    getAppDataDir: (sub) => path.join(TMP, sub),
  },
};

const svc = require('./checkpointService');

test.after(() => {
  if (cpReal) require.cache[cpKey] = cpReal;
  else delete require.cache[cpKey];
  if (detectorReal) require.cache[detectorKey] = detectorReal;
  else delete require.cache[detectorKey];
  if (dataHomeReal) require.cache[dataHomeKey] = dataHomeReal;
  else delete require.cache[dataHomeKey];
  fs.rmSync(TMP, { recursive: true, force: true });
});

const proj = path.join(TMP, 'proj');
function freshProj() {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  // manifest 在 ckptDir 里跨用例残留会污染计数——一并清掉
  const ckptDir = path.join(
    TMP,
    'checkpoints',
    require('crypto').createHash('sha256').update(proj).digest('hex').slice(0, 12)
  );
  fs.rmSync(ckptDir, { recursive: true, force: true });
  return proj;
}
function manifestOf(dir) {
  const ckptDir = path.join(TMP, 'checkpoints', require('crypto').createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12));
  const manifestPath = path.join(ckptDir, 'manifest.json');
  try {
    return { ckptDir, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) };
  } catch {
    return { ckptDir, manifest: null };
  }
}

test('CHECKPOINT_ROOT getter 指向桩定的 dataHome', () => {
  assert.equal(svc.CHECKPOINT_ROOT, path.join(TMP, 'checkpoints'));
});

test('saveCheckpoint 垃圾入参：null / 不存在目录 / 未知模式 → 抛错', () => {
  assert.throws(() => svc.saveCheckpoint(null));
  assert.throws(() => svc.saveCheckpoint(path.join(TMP, 'no-such-dir-zz')), /Directory not found/);
  const p = freshProj();
  gitState.repo = false;
  assert.throws(() => svc.saveCheckpoint(p, { mode: 'bogus' }), /Unknown checkpoint mode/);
});

test('saveCheckpoint tar-full（非 git）：execSync 产 tar → files=-1、size 落账', () => {
  const p = freshProj();
  gitState.repo = false;
  gitState.tarError = false;
  const entry = svc.saveCheckpoint(p, { message: 'tar 快照' });
  assert.equal(entry.mode, 'tar-full');
  assert.equal(entry.files, -1);
  assert.equal(entry.size, 7); // 'TARDATA'
  assert.equal(entry.branch, null); // 非 git
  assert.equal(entry.storage, undefined); // 默认 legacy
  const { manifest } = manifestOf(p);
  assert.equal(manifest.checkpoints.length, 1);
  assert.equal(manifest.project, path.resolve(p));
});

test('saveCheckpoint git-diff：patch 落盘、untracked 注释块、files 计数、branch/head', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = 'diff --git a/x b/x\n+added line';
  gitState.stat = '2 files changed, 3 insertions(+)';
  gitState.untracked = 'u1.txt\nu2.txt';
  gitState.branch = 'main';
  gitState.head = 'abc1234';
  const entry = svc.saveCheckpoint(p, { mode: 'git-diff', message: 'git 快照' });
  assert.equal(entry.mode, 'git-diff');
  assert.equal(entry.files, 3); // stat 命中 1 个 "N file" + 2 untracked
  assert.equal(entry.branch, 'main');
  assert.equal(entry.commitHash, 'abc1234');
  const { ckptDir } = manifestOf(p);
  const patchPath = path.join(ckptDir, entry.id + '.patch');
  const patch = fs.readFileSync(patchPath, 'utf-8');
  assert.ok(patch.endsWith('\n')); // trim 后补回尾换行
  assert.ok(patch.includes('# u1.txt'));
  assert.ok(patch.includes('# UNTRACKED FILES'));
});

test('saveCheckpoint：MAX_CHECKPOINTS=10，最旧条目与补丁文件被清', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = '+x';
  gitState.stat = '1 file changed';
  gitState.untracked = '';
  gitState.branch = 'b';
  gitState.head = 'h';
  const ids = [];
  for (let i = 0; i < 11; i++) {
    ids.push(svc.saveCheckpoint(p, { mode: 'git-diff' }).id);
  }
  const { ckptDir, manifest } = manifestOf(p);
  assert.equal(manifest.checkpoints.length, 10);
  assert.equal(manifest.checkpoints[0].id, ids[1]); // 最旧的 ids[0] 已被移出
  assert.equal(fs.existsSync(path.join(ckptDir, ids[0] + '.patch')), false);
  assert.equal(fs.existsSync(path.join(ckptDir, ids[10] + '.patch')), true);
});

test('restoreCheckpoint：dry-run / 未知 id 抛错', () => {
  const p = freshProj();
  gitState.repo = false;
  gitState.tarError = false;
  const entry = svc.saveCheckpoint(p, { mode: 'tar-full' });
  const dry = svc.restoreCheckpoint(p, entry.id, { dryRun: true });
  assert.equal(dry.restored, false);
  assert.ok(dry.message.includes('[dry-run]'));
  assert.ok(dry.message.includes(entry.message));
  assert.throws(() => svc.restoreCheckpoint(p, 'no-such-id'), /not found/);
});

test('restoreCheckpoint git-diff：git apply 收到去除注释行后的补丁', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = 'diff --git a/x b/x\n+line';
  gitState.stat = '';
  gitState.untracked = 'u1.txt';
  gitState.branch = 'b';
  gitState.head = 'h';
  gitState.applyError = false;
  const entry = svc.saveCheckpoint(p, { mode: 'git-diff' });
  const r = svc.restoreCheckpoint(p, entry.id);
  assert.equal(r.restored, true);
  assert.equal(r.mode, 'git-diff');
  assert.equal(gitState.applied.length, 1);
  const applied = gitState.applied[0];
  assert.ok(applied.includes('+line'));
  assert.equal(applied.includes('# u1.txt'), false); // 注释块被过滤
  assert.ok(applied.endsWith('\n'));
});

test('restoreCheckpoint git-diff：apply 失败 → 抛出含 stderr 的错误', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = '+x';
  gitState.stat = '';
  gitState.untracked = '';
  gitState.applyError = true;
  const entry = svc.saveCheckpoint(p, { mode: 'git-diff' });
  gitState.applyError = false;
  // 单独构造一次失败
  gitState.applyError = true;
  assert.throws(() => svc.restoreCheckpoint(p, entry.id), /Failed to apply patch/);
  gitState.applyError = false;
});

test('CAS 往返：storageMode=cas → 对象入库、裸 patch 删除、restore 物化且临时文件清零', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = 'diff --git a/x b/x\n+cas line';
  gitState.stat = '';
  gitState.untracked = '';
  gitState.branch = 'b';
  gitState.head = 'h';
  gitState.applyError = false;
  const entry = svc.saveCheckpoint(p, { mode: 'git-diff', storageMode: 'cas' });
  assert.equal(entry.storage, 'cas');
  assert.equal(entry.schemaVersion, 2);
  assert.equal(entry.objects.length, 1);
  assert.match(entry.objects[0].digest, /^[a-f0-9]{64}$/);

  const { ckptDir } = manifestOf(p);
  assert.equal(fs.existsSync(path.join(ckptDir, entry.id + '.patch')), false); // 已入 CAS

  const beforeApply = gitState.applied.length;
  const r = svc.restoreCheckpoint(p, entry.id);
  assert.equal(r.restored, true);
  assert.equal(gitState.applied.length, beforeApply + 1);
  assert.ok(gitState.applied[gitState.applied.length - 1].includes('+cas line'));
  // 物化的临时文件已清理
  const leftovers = fs.readdirSync(ckptDir).filter((f) => f.includes('.restore-'));
  assert.deepEqual(leftovers, []);
});

test('diffCheckpoint：git-diff 统计增删行；CAS 条目也可 diff；tar-full 占位文案', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = '+a\n+b\n-del\ncx';
  gitState.stat = '';
  gitState.untracked = '';
  gitState.branch = 'b';
  gitState.head = 'h';
  const legacy = svc.saveCheckpoint(p, { mode: 'git-diff' });
  const d1 = svc.diffCheckpoint(p, legacy.id);
  assert.equal(d1.stats.additions, 2);
  assert.equal(d1.stats.deletions, 1);
  assert.ok(d1.diff.includes('+a'));

  gitState.diff = '+cas line'; // CAS 那次保存换个 diff，统计口径才可断言
  const cas = svc.saveCheckpoint(p, { mode: 'git-diff', storageMode: 'cas', message: 'm2' });
  const d2 = svc.diffCheckpoint(p, cas.id);
  assert.equal(d2.stats.additions, 1); // '+cas line'

  gitState.repo = false;
  const tar = svc.saveCheckpoint(p, { mode: 'tar-full' });
  const d3 = svc.diffCheckpoint(p, tar.id);
  assert.ok(d3.diff.startsWith('[tar-full checkpoint'));
  assert.deepEqual(d3.stats, { additions: 0, deletions: 0 });

  assert.throws(() => svc.diffCheckpoint(p, 'nope'), /not found/);
});

test('deleteCheckpoint：删除成功清补丁；重复删/垃圾 id 返 false', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = '+x';
  gitState.stat = '';
  gitState.untracked = '';
  gitState.branch = '';
  gitState.head = '';
  const entry = svc.saveCheckpoint(p, { mode: 'git-diff' });
  const { ckptDir } = manifestOf(p);
  assert.equal(svc.deleteCheckpoint(p, entry.id), true);
  assert.equal(fs.existsSync(path.join(ckptDir, entry.id + '.patch')), false);
  assert.equal(svc.deleteCheckpoint(p, entry.id), false);
  assert.equal(svc.deleteCheckpoint(p, null), false);
});

test('cleanupCheckpoints(keep)：保留最近 N 条并清文件；垃圾 keep 行为如实', () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = '+x';
  gitState.stat = '';
  gitState.untracked = '';
  gitState.branch = '';
  gitState.head = '';
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(svc.saveCheckpoint(p, { mode: 'git-diff' }).id);
  }
  const removed = svc.cleanupCheckpoints(p, 2);
  assert.equal(removed, 3);
  const { ckptDir, manifest } = manifestOf(p);
  assert.equal(manifest.checkpoints.length, 2);
  assert.equal(manifest.checkpoints[0].id, ids[3]);
  assert.equal(fs.existsSync(path.join(ckptDir, ids[0] + '.patch')), false);
  assert.equal(fs.existsSync(path.join(ckptDir, ids[4] + '.patch')), true);
  // keep 大于现有 → 0 删
  assert.equal(svc.cleanupCheckpoints(p, 10), 0);
  // keep=0 → 全清
  assert.equal(svc.cleanupCheckpoints(p, 0), 2);
  assert.equal(svc.listCheckpoints(p).length, 0);
});

test('listCheckpoints / getCheckpointStats：损坏 manifest fail-soft 返空', () => {
  const p = freshProj();
  const { ckptDir } = manifestOf(p);
  fs.mkdirSync(ckptDir, { recursive: true });
  fs.writeFileSync(path.join(ckptDir, 'manifest.json'), '{oops');
  assert.deepEqual(svc.listCheckpoints(p), []);
  const stats = svc.getCheckpointStats(p);
  assert.equal(stats.totalSize, 0);
  assert.equal(stats.count, 0);
  assert.equal(stats.formatted, '0 B');
});

test('getCheckpointStats：size 缺失按 0 计、formatted 走 formatBytes', () => {
  const p = freshProj();
  const { ckptDir } = manifestOf(p);
  fs.mkdirSync(ckptDir, { recursive: true });
  fs.writeFileSync(
    path.join(ckptDir, 'manifest.json'),
    JSON.stringify({
      project: p,
      checkpoints: [
        { id: 'a', size: 1536 },
        { id: 'b' }, // size 缺失
        { id: 'c', size: null },
      ],
    })
  );
  const stats = svc.getCheckpointStats(p);
  assert.equal(stats.totalSize, 1536);
  assert.equal(stats.count, 3);
  assert.equal(stats.formatted, '1.5 KB');
});

test('saveCheckpointAsync：git-diff 全异步路径与同步版同账', async () => {
  const p = freshProj();
  gitState.repo = true;
  gitState.diff = 'diff --git a/x b/x\n+async line';
  gitState.stat = '1 file changed';
  gitState.untracked = 'ua.txt';
  gitState.branch = 'async';
  gitState.head = 'bbb2222';
  const entry = await svc.saveCheckpointAsync(p, { mode: 'git-diff', message: '异步快照' });
  assert.equal(entry.mode, 'git-diff');
  assert.equal(entry.files, 2); // 1 (stat) + 1 untracked
  assert.equal(entry.branch, 'async');
  assert.equal(entry.commitHash, 'bbb2222');

  // 垃圾入参 → rejects
  await assert.rejects(() => svc.saveCheckpointAsync(null));
  await assert.rejects(
    () => svc.saveCheckpointAsync(path.join(TMP, 'nope-zz')),
    /Directory not found/
  );
  await assert.rejects(() => svc.saveCheckpointAsync(p, { mode: 'bogus' }), /Unknown checkpoint mode/);
});
