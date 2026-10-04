'use strict';

/**
 * configEnvWriteHonest.test.js — `khy config set/openclaw/opencode` 的 .env 写失败
 * 诚实回执契约(hci-r40 同族,承 [90] 的 twentyX 站点守护)。
 *
 * 复现源自 .khy/feedback/hci-r40-config-env-crash/ :三处裸
 * `_writeEnvPatch(...)` 调用在 .env 不可写时把裸 errno 抛穿 handler ——
 * 文本面英文异常直泄,json 面契约行整个消失,且 rc 不进 _markFailure 通道。
 *
 * 触发零故障注入:KHY_ENV_FILE 是正规配置面。node --test only.
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

const { handleConfig } = require(path.join(SRC, 'cli', 'handlers', 'config.js'));

const saved = {
  envFile: process.env.KHY_ENV_FILE,
  sync: process.env.KHY_ENV_SYNC_ROOT,
  lang: process.env.KHY_LANGUAGE,
  exitCode: process.exitCode,
};

function withEnv(envFile) {
  process.env.KHY_ENV_FILE = envFile;
  process.env.KHY_ENV_SYNC_ROOT = 'false'; // 永不触碰仓库真实 .env
}

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

function ghost() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg40-')), 'no-dir', '.env');
}

test('T1 set + ENOENT → 中文两行错误,禁「已保存」,rc 经 _markFailure 归真,不抛穿', async () => {
  const g = ghost();
  withEnv(g);
  reset();
  try {
    await handleConfig('set', ['language.preference', 'zh'], {});
    assert.equal(rec.success.length, 0, '写失败不得 printSuccess: ' + JSON.stringify(rec.success));
    assert.ok(!rec.info.join('').includes('已保存'), '「已保存到」是假回执');
    assert.match(rec.error.join('\n'), /配置未能持久化/);
    assert.match(rec.error.join('\n'), /ENOENT/, '原始 errno 必须到达用户');
    assert.match(rec.error.join('\n'), /未写入 .env/);
    assert.equal(process.exitCode, 1, '失败必须进 rc 通道(既有 false→_markFailure)');
  } finally {
    fs.rmSync(path.dirname(g), { recursive: true, force: true });
  }
});

test('T2 set --json + ENOENT → 合法 ok:false JSON 契约行,不再零输出', async () => {
  const g = ghost();
  withEnv(g);
  reset();
  try {
    const out = await captureStdout(() =>
      handleConfig('set', ['language.preference', 'zh'], { json: true })
    );
    const payload = JSON.parse(out); // 抛穿时代码根本不会输出可解析 JSON
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'env_write_failed');
    assert.match(payload.message, /ENOENT/);
    assert.equal(rec.error.length, 0, 'json 模式不混入文本错误行');
  } finally {
    fs.rmSync(path.dirname(g), { recursive: true, force: true });
  }
});

test('T3 happy path 行为保持:set 真写盘 + 「已设置」「已保存到」', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg40-ok-'));
  withEnv(path.join(DATA, '.env'));
  reset();
  try {
    await handleConfig('set', ['language.preference', 'zh'], {});
    assert.equal(rec.error.length, 0);
    assert.match(rec.success.join(''), /已设置/);
    assert.match(rec.info.join(''), /已保存到/);
    // 既有归一化:zh → Chinese(见 _normalizeLanguagePreference),断言键落盘即可。
    assert.match(fs.readFileSync(path.join(DATA, '.env'), 'utf-8'), /KHY_LANGUAGE=/, '真落盘');
    assert.notEqual(process.exitCode, 1, '成功路径不得误标失败 rc');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T4 openclaw 显式参数 + ENOENT → 诚实错误且不弹 gateway 向导', async () => {
  const g = ghost();
  withEnv(g);
  reset();
  try {
    await handleConfig('openclaw', ['https://example.invalid/v1', 'sk-dummy', 'openai'], {});
    assert.equal(rec.success.length, 0);
    assert.match(rec.error.join('\n'), /配置未能持久化/);
    assert.ok(
      !rec.info.join('').includes('向导'),
      '有显式参数时失败不得再兜底进 gateway config 向导'
    );
  } finally {
    fs.rmSync(path.dirname(g), { recursive: true, force: true });
  }
});

// rc 通道断言会把 process.exitCode 置 1;必须在 runner 读取退出码之前(in-process)
// 还原,`process.on('exit')` 里再赋值已太迟(整个文件被判 fail)。
after(() => {
  process.exitCode = saved.exitCode;
});

process.on('exit', () => {
  for (const [k, v] of [
    ['KHY_ENV_FILE', saved.envFile],
    ['KHY_ENV_SYNC_ROOT', saved.sync],
    ['KHY_LANGUAGE', saved.lang],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
