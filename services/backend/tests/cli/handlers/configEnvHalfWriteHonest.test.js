'use strict';

/**
 * configEnvHalfWriteHonest.test.js — .env 双写(canonical+mirror)半途失败的三态诚实回执契约。
 *
 * 复现源自 .khy/feedback/hci-r41-env-halfwrite/ :`_writeEnvPatch` 顺序写
 * targets=[canonical, mirror],canonical 落盘后 mirror 抛 errno(实测 mirror 只读
 * → EPERM),而 r40 回执隐含「全部未写入」——「未写入 .env(重启后不生效)」/
 * 「模式未改动」在半写态恰好说反:改动重启后**会**生效,且两份 .env 悄悄分叉。
 * 20x 面失败还吞掉 rc(repro-before-C rcC=0)。
 *
 * 测试用假 resolver 控制 targets(仓库真 mirror 绝不入靶);mirror 故障注入用
 * 真实 fs 目录冲突(EISDIR/EPERM 类),不 stub fs。node --test only.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { success: [], error: [], info: [], warn: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: (m) => rec.warn.push(String(m)),
  printTable: () => {},
});

// 可变解析面:每个测试现搭 targets,仓库 services/.env 永不入靶。
const RES = { canonicalPath: '', targets: [] };
seed(path.join(SRC, 'utils', 'resolveGatewayEnvPaths.js'), () => ({
  canonicalPath: RES.canonicalPath,
  targets: RES.targets.slice(),
}));

const { handleConfig } = require(path.join(SRC, 'cli', 'handlers', 'config.js'));
const { handleTwentyX } = require(path.join(SRC, 'cli', 'handlers', 'twentyX.js'));

const saved = {
  mode: process.env.KHY_20X_MODE,
  lang: process.env.KHY_LANGUAGE,
  exitCode: process.exitCode,
};

function reset() {
  rec.success.length = 0;
  rec.error.length = 0;
  rec.info.length = 0;
  rec.warn.length = 0;
  process.exitCode = saved.exitCode;
}

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (c, ...a) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

// 沙盒:[canonical 可写文件, mirror 同名目录(写必炸,errno 平台相关 EISDIR/EPERM)]
function sandboxPair(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const canonical = path.join(dir, 'canonical.env');
  fs.writeFileSync(canonical, 'KHY_EXISTING=keepme\n');
  const mirror = path.join(dir, 'mirror.env'); // 目录占位 → writeFileSync 必失败
  fs.mkdirSync(mirror);
  RES.canonicalPath = canonical;
  RES.targets = [canonical, mirror];
  return { dir, canonical, mirror };
}

test('T1 半写 set → 「半写入」点名已写/未写两份,禁「未写入 .env(重启后不生效)」,canonical 确已落盘', async () => {
  const s = sandboxPair('cfg41-half-');
  reset();
  try {
    await handleConfig('set', ['language.preference', 'zh'], {});
    assert.equal(rec.success.length, 0, '半写不得 printSuccess: ' + JSON.stringify(rec.success));
    const errs = rec.error.join('\n');
    assert.match(errs, /配置未能持久化/);
    assert.match(errs, /半写入/);
    assert.ok(errs.includes(s.canonical), '必须点名已写入的一份');
    assert.ok(errs.includes(s.mirror), '必须点名未写入的一份');
    assert.match(errs, /重启后会按新值生效/);
    assert.match(errs, /不一致/);
    assert.doesNotMatch(errs, /未写入 \.env\(重启后不生效\)/, '反向谎禁止复发');
    const onDisk = fs.readFileSync(s.canonical, 'utf-8');
    assert.match(onDisk, /KHY_LANGUAGE=/, 'canonical 真被写了——这才是回执必须改口的原因');
    assert.equal(process.exitCode, 1, '半写仍须走 false→_markFailure rc 通道');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('T2 半写 set --json → error=env_write_partial + written/failed 字段,契约仍可解析', async () => {
  const s = sandboxPair('cfg41-json-');
  reset();
  try {
    const out = await captureStdout(() =>
      handleConfig('set', ['language.preference', 'zh'], { json: true })
    );
    const payload = JSON.parse(out);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'env_write_partial');
    assert.deepEqual(payload.written, [s.canonical]);
    assert.equal(payload.failed, s.mirror);
    assert.equal(rec.error.length, 0, 'json 模式不混入文本错误行');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('T3 全未写回归(targets 仅一且不可写)→ 旧「未写入 .env(重启后不生效)」与 env_write_failed 保持', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg41-all-'));
  const ghost = path.join(dir, 'no-dir', 'canonical.env');
  RES.canonicalPath = ghost;
  RES.targets = [ghost];
  reset();
  try {
    await handleConfig('set', ['language.preference', 'zh'], {});
    const errs = rec.error.join('\n');
    assert.match(errs, /配置未能持久化/);
    assert.match(errs, /ENOENT/, '第一目标就失败 → 无半写,原始 errno 到达');
    assert.match(errs, /未写入 \.env\(重启后不生效\)/, '全未写时旧措辞仍为真');
    assert.doesNotMatch(errs, /半写入/);

    reset();
    const out = await captureStdout(() =>
      handleConfig('set', ['language.preference', 'zh'], { json: true })
    );
    const payload = JSON.parse(out);
    assert.equal(payload.error, 'env_write_failed', '全败契约不变(r40 T2 同义)');
    assert.equal(payload.written, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T4 半写 20x on → 「半写入…重启后模式会切换」+ 会话值未悄悄生效 + rc=1(吞 rc 谎复发禁止)', async () => {
  const s = sandboxPair('t20x-half-');
  delete process.env.KHY_20X_MODE;
  reset();
  try {
    const r = await handleTwentyX({ subCommand: 'on' });
    assert.equal(r, true, '仍须 return true 阻断兜底路由(r39 契约不回归)');
    assert.equal(rec.success.length, 0);
    const errs = rec.error.join('\n');
    assert.match(errs, /20x 开关未能持久化/);
    assert.match(errs, /半写入/);
    assert.match(errs, /KHY_20X_MODE=true/);
    assert.match(errs, /重启后模式会切换/);
    assert.ok(errs.includes(s.canonical) && errs.includes(s.mirror));
    assert.doesNotMatch(errs, /模式未改动/, '「模式未改动」在半写态是反向假回执');
    assert.ok(!process.env.KHY_20X_MODE, '当前会话值不得在失败时被改写');
    assert.equal(process.exitCode, 1, 'repro-before-C 实测 rcC=0——必须归真');
    assert.match(fs.readFileSync(s.canonical, 'utf-8'), /KHY_20X_MODE=true/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('T5 happy path 双写行为保持:两份都真落盘 + 「已设置」「已保存到」,无错误行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg41-ok-'));
  const canonical = path.join(dir, 'canonical.env');
  const mirror = path.join(dir, 'mirror.env');
  fs.writeFileSync(canonical, 'KHY_EXISTING=keepme\n');
  fs.writeFileSync(mirror, 'KHY_EXISTING=keepme\n');
  RES.canonicalPath = canonical;
  RES.targets = [canonical, mirror];
  reset();
  try {
    await handleConfig('set', ['language.preference', 'zh'], {});
    assert.equal(rec.error.length, 0);
    assert.match(rec.success.join(''), /已设置/);
    assert.match(rec.info.join(''), /已保存到/);
    assert.match(fs.readFileSync(canonical, 'utf-8'), /KHY_LANGUAGE=/, 'canonical 真落盘');
    assert.match(fs.readFileSync(mirror, 'utf-8'), /KHY_LANGUAGE=/, 'mirror 同步真落盘');
    assert.notEqual(process.exitCode, 1, '成功路径不得误标失败 rc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// rc 通道断言会把 process.exitCode 置 1;必须在 runner 读取退出码之前还原
// (instrument #17:`process.on('exit')` 里赋值已太迟)。
after(() => {
  process.exitCode = saved.exitCode;
});

process.on('exit', () => {
  for (const [k, v] of [
    ['KHY_20X_MODE', saved.mode],
    ['KHY_LANGUAGE', saved.lang],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
