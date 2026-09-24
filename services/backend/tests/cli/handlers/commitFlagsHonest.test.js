'use strict';

/**
 * commitFlagsHonest.test.js — `khy commit` 长选项诚实契约(hci-r43)。
 *
 * 复现源自 .khy/feedback/hci-r43-commit-yes-phantom/ :parseInput 把 `--yes`/`--summary`/
 * `--message` 全装进 options(args 里一个不剩,且 `-m` 被 `--yes` 贪婪吞作值),旧
 * handleCommit 只 raw-scan args、`_options` 即弃 → 文档三处承诺的
 * `khy commit --yes -m "…"` 永不提交,判据全绿时反而谎报「确认后加 --yes」。
 * 短形式 `-y -m` 是正对照(落 args,修复前后字节不变)。
 *
 * 集成测试用**真实 parseInput + 真实 handleCommit + 真实临时 git 仓库**——
 * 提交是否发生以 `git log` 实测断言,非空转。node --test only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { info: [], error: [], warn: [], success: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: (m) => rec.warn.push(String(m)),
  printTable: () => {},
});

const router = require(path.join(SRC, 'cli', 'router.js'));
const { handleCommit, _optionTokens } = require(path.join(SRC, 'cli', 'handlers', 'commit.js'));

const ORIG_CWD = process.cwd();

/** 造一个「判据全绿可提交」的临时仓库:1 个 staged 新文件 + 比它新的 verify.txt。 */
function newRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r43-${tag}-`));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  git(['add', 'f.txt']);
  const vd = path.join(dir, '.khy', 'feedback', 't1');
  fs.mkdirSync(vd, { recursive: true });
  fs.writeFileSync(path.join(vd, 'verify.txt'), 'verified\n');
  return { dir, git };
}

function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (c, ...a) => {
    chunks.push(String(c));
    return true;
  };
  rec.info.length = 0;
  rec.error.length = 0;
  rec.warn.length = 0;
  rec.success.length = 0;
  try {
    return Promise.resolve(fn()).then((v) => ({
      out: chunks.join('') + '\n' + rec.info.join('\n') + '\n' + rec.error.join('\n') + '\n' + rec.success.join('\n'),
      value: v,
    }));
  } finally {
    process.stdout.write = orig;
  }
}

async function runCommit(repo, cmd) {
  const p = router.parseInput(cmd);
  process.chdir(repo.dir);
  const cap = await capture(() => handleCommit(null, p.args, p.options));
  return cap.out;
}

test('T1 纯回填:_optionTokens 还原被吞的 token 对', () => {
  assert.deepEqual(_optionTokens({ yes: '-m' }), ['--yes', '-m']);
  assert.deepEqual(_optionTokens({ summary: true }), ['--summary']);
  assert.deepEqual(_optionTokens({ yes: true, message: 'x' }), ['--yes', '--message', 'x']);
  assert.deepEqual(_optionTokens({}), []);
  assert.deepEqual(_optionTokens(undefined), []);
});

test('T2 主案:`commit --yes -m "…"` 真提交(git log 实测),不再谎报「加 --yes」', async () => {
  const repo = newRepo('t2');
  const out = await runCommit(repo, 'commit --yes -m "feat: r43 honest"');
  try {
    const subject = repo.git(['log', '--pretty=%s', '-1']).trim();
    assert.equal(subject, 'feat: r43 honest'); // 非空转:真实写路径落库
  } finally {
    process.chdir(ORIG_CWD);
  }
  assert.match(out, /已提交/);
  assert.doesNotMatch(out, /确认后加 --yes/);
  assert.doesNotMatch(out, /用 --yes 确认提交/); // 已确认时矛盾提示被抑制
});

test('T3 只给 --yes 不给说明:如实要求补 -m,不提交', async () => {
  const repo = newRepo('t3');
  const out = await runCommit(repo, 'commit --yes');
  let log = '';
  try {
    log = repo.git(['log', '--oneline']);
  } catch {
    log = '(none)';
  }
  try {
    assert.match(log, /no commits|does not have any commits|none/i);
    assert.match(out, /要提交就得给个说明/);
  } finally {
    process.chdir(ORIG_CWD);
  }
});

test('T4 `--summary` 真出一行紧凑结论(幻影修复面)', async () => {
  const repo = newRepo('t4');
  const out = await runCommit(repo, 'commit --summary');
  process.chdir(ORIG_CWD);
  assert.match(out, /^(commit-now|do-not-commit|ask-first)\t/m);
  assert.doesNotMatch(out, /提交时机判断/); // 不再打全量判断列表
});

test('T5 短形式正对照 `-y -m "…"` 行为字节不变(兼容面不回归)', async () => {
  const repo = newRepo('t5');
  const out = await runCommit(repo, 'commit -y -m "chore: short ok"');
  try {
    const subject = repo.git(['log', '--pretty=%s', '-1']).trim();
    assert.equal(subject, 'chore: short ok');
  } finally {
    process.chdir(ORIG_CWD);
  }
  assert.match(out, /已提交/);
});

test('T6 裸 `commit` 仍只判断不提交(默认安全面不回归)', async () => {
  const repo = newRepo('t6');
  const out = await runCommit(repo, 'commit');
  let hasCommit = true;
  try {
    repo.git(['log', '--oneline']);
  } catch {
    hasCommit = false;
  }
  process.chdir(ORIG_CWD);
  assert.equal(hasCommit, false);
  assert.match(out, /没有提交（本命令默认只判断）。确认后加 --yes/);
});

test('after-hook: cwd 已复位', () => {
  assert.equal(process.cwd(), ORIG_CWD);
});
