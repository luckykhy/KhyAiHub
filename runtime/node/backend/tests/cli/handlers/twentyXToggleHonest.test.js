'use strict';

/**
 * twentyXToggleHonest.test.js — `khy 20x on|off` 持久化失败面的诚实回执契约。
 *
 * 复现源自 .khy/feedback/hci-r39-20x-env-crash/ :_handleToggle 的 try 只包
 * require('./config'),`writeEnvPatch(...)` 裸调用 → .env 写失败(路径拼错
 * ENOENT / Windows 文件锁 EBUSY / 只读 EACCES)时原始 errno 抛穿 handler,
 * 由 commandAutoRegistry 的泛化 catch 打印后再以 handled:false 落进
 * 未知命令兜底路由(switch 里没有 case '20x')——报错的话被二次处理。
 *
 * 触发不需要故障注入:KHY_ENV_FILE 本就是代码支持的正规配置面。
 * node --test only.
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

const rec = { success: [], error: [], info: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: () => {},
  printTable: () => {},
});

const { handleTwentyX } = require(path.join(SRC, 'cli', 'handlers', 'twentyX.js'));

const saved = {
  envFile: process.env.KHY_ENV_FILE,
  sync: process.env.KHY_ENV_SYNC_ROOT,
  mode: process.env.KHY_20X_MODE,
  exitCode: process.exitCode,
};

function reset() {
  rec.success.length = 0;
  rec.error.length = 0;
  rec.info.length = 0;
  // r41 起 handler 失败会 _markFailure();逐测试复位,防串扰。
  process.exitCode = saved.exitCode;
}

function withEnv(envFile) {
  process.env.KHY_ENV_FILE = envFile;
  process.env.KHY_ENV_SYNC_ROOT = 'false'; // 只打 canonical,永不碰仓库真 .env
  delete process.env.KHY_20X_MODE;
}

test('T1 on + .env 父目录不存在(ENOENT) → 诚实错误两行,禁成功/已写入,不抛穿', async () => {
  const ghost = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't20x-')), 'no-dir', '.env');
  withEnv(ghost);
  reset();
  try {
    const r = await handleTwentyX({ subCommand: 'on' });
    assert.equal(r, true, '必须 return true 阻断未知命令兜底路由');
    assert.equal(rec.success.length, 0, '写失败不得 printSuccess: ' + JSON.stringify(rec.success));
    assert.ok(!rec.info.join('').includes('已写入'), '「已写入」是假回执');
    assert.match(rec.error.join('\n'), /20x 开关未能持久化/);
    assert.match(rec.error.join('\n'), /ENOENT/, '原始 errno 必须到达用户');
    assert.match(rec.error.join('\n'), /模式未改动/);
    assert.ok(!process.env.KHY_20X_MODE, '持久化失败时会话值也不得悄悄生效');
  } finally {
    fs.rmSync(path.dirname(ghost), { recursive: true, force: true });
  }
});

test('T2 off 分支同样诚实(措辞不偏向「已关闭」)', async () => {
  const ghost = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't20x-')), 'no-dir', '.env');
  withEnv(ghost);
  reset();
  try {
    await handleTwentyX({ subCommand: 'off' });
    assert.equal(rec.success.length, 0);
    assert.ok(!rec.success.join('').includes('已关闭'), '假「已关闭」与假「已开启」同罪');
    assert.match(rec.error.join('\n'), /20x 开关未能持久化/);
  } finally {
    fs.rmSync(path.dirname(ghost), { recursive: true, force: true });
  }
});

test('T3 happy path 行为保持:on 真写盘 + 「已开启」「已写入」+ 会话值生效', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 't20x-ok-'));
  withEnv(path.join(DATA, '.env'));
  reset();
  try {
    const r = await handleTwentyX({ subCommand: 'on' });
    assert.equal(r, true);
    assert.equal(rec.error.length, 0);
    assert.match(rec.success.join(''), /已开启/);
    assert.match(rec.info.join(''), /已写入/);
    assert.equal(process.env.KHY_20X_MODE, 'true', '会话内立即生效(既有行为)');
    const written = fs.readFileSync(path.join(DATA, '.env'), 'utf-8');
    assert.match(written, /KHY_20X_MODE=true/, '真落盘,非空转断言');

    reset();
    await handleTwentyX({ subCommand: 'off' });
    assert.match(rec.success.join(''), /已关闭/);
    assert.equal(process.env.KHY_20X_MODE, 'false');
    assert.match(fs.readFileSync(path.join(DATA, '.env'), 'utf-8'), /KHY_20X_MODE=false/);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

// rc 断言/标记会把 process.exitCode 置 1,须在 runner 读退出码前还原(instrument #17)。
after(() => {
  process.exitCode = saved.exitCode;
});

process.on('exit', () => {
  for (const [k, v] of [['KHY_ENV_FILE', saved.envFile], ['KHY_ENV_SYNC_ROOT', saved.sync], ['KHY_20X_MODE', saved.mode]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
