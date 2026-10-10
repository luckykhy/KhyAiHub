'use strict';

/**
 * releaseNotes.test.js — `/release-notes` 薄壳契约(node:test,隔离 process.env + 临时 CHANGELOG)。
 *
 * 锁定:门控 off → 字节回退(不接管,返回 false);env KHY_CHANGELOG_PATH 定位优先;
 * 默认最新 1 个;数量参数;版本参数;版本未命中友好提示;文件缺失 fail-soft;
 * 捕获 printInfo/printWarn/printError 验证不抛、输出脱敏无关(无 key)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const HANDLER_PATH = require.resolve('../../../src/cli/handlers/releaseNotes');

const SAMPLE = [
  '# Changelog', '', '---', '',
  '## 0.2.0', '', '第二版摘要。', '', '### Highlights', '', '- **A**：详情', '- B 无标题', '', '---', '',
  '## 0.1.0', '', '首版摘要。', '', '### Highlights', '', '- 初始发布', '', '---',
].join('\n');

let tmpDir, changelogPath, captured;

function loadHandlerWithCapture() {
  // 用捕获版 formatters 替换 require.cache,记录所有输出行。
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[HANDLER_PATH];
  const real = require('../../../src/cli/formatters');
  captured = [];
  const stub = Object.assign({}, real, {
    printInfo: (m) => captured.push(['info', String(m)]),
    printWarn: (m) => captured.push(['warn', String(m)]),
    printError: (m) => captured.push(['error', String(m)]),
  });
  require.cache[FORMATTERS_PATH] = { id: FORMATTERS_PATH, filename: FORMATTERS_PATH, loaded: true, exports: stub };
  return require('../../../src/cli/handlers/releaseNotes');
}

function allText() { return captured.map((c) => c[1]).join('\n'); }

describe('handleReleaseNotes', () => {
  let savedGate, savedPath;
  beforeEach(() => {
    savedGate = process.env.KHY_RELEASE_NOTES;
    savedPath = process.env.KHY_CHANGELOG_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-relnotes-'));
    changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, SAMPLE, 'utf-8');
    process.env.KHY_CHANGELOG_PATH = changelogPath;
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.KHY_RELEASE_NOTES; else process.env.KHY_RELEASE_NOTES = savedGate;
    if (savedPath === undefined) delete process.env.KHY_CHANGELOG_PATH; else process.env.KHY_CHANGELOG_PATH = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete require.cache[FORMATTERS_PATH];
    delete require.cache[HANDLER_PATH];
  });

  test('默认锚点(无 KHY_CHANGELOG_PATH)解析到的 CHANGELOG 必须真实存在', async () => {
    // 层级迁移把「从 __dirname 向上数 N 层」的默认锚点挪跑了：路径照拼、文件在别处，
    // 用户只看到一句「未找到 CHANGELOG.md」。形状断言看不见漂移，只能验存在性。
    delete process.env.KHY_RELEASE_NOTES;
    delete process.env.KHY_CHANGELOG_PATH;
    const { handleReleaseNotes } = loadHandlerWithCapture();
    const r = await handleReleaseNotes('', []);
    assert.equal(r, true);
    const text = allText();
    assert.ok(!/未找到 CHANGELOG/.test(text), `默认锚点解析失败，实际输出：${text}`);
    assert.match(text, /## \d+\.\d+\.\d+/, `未渲染任何版本条目：${text}`);
  });

  test('门控 off → 不接管,返回 false(字节回退)', async () => {
    process.env.KHY_RELEASE_NOTES = 'off';
    const { handleReleaseNotes } = loadHandlerWithCapture();
    const r = await handleReleaseNotes('', []);
    assert.equal(r, false);
  });

  test('默认 → 最新 1 个版本', async () => {
    delete process.env.KHY_RELEASE_NOTES;
    const { handleReleaseNotes } = loadHandlerWithCapture();
    const r = await handleReleaseNotes('', []);
    assert.equal(r, true);
    const text = allText();
    assert.match(text, /## 0\.2\.0/);
    assert.match(text, /第二版摘要/);
    assert.match(text, /•\s*A/);
    assert.ok(!/## 0\.1\.0/.test(text)); // 默认只 1 个
  });

  test('数量参数 → 最近 N 个', async () => {
    delete process.env.KHY_RELEASE_NOTES;
    const { handleReleaseNotes } = loadHandlerWithCapture();
    await handleReleaseNotes('2', []);
    const text = allText();
    assert.match(text, /## 0\.2\.0/);
    assert.match(text, /## 0\.1\.0/);
  });

  test('版本参数 → 指定版本', async () => {
    delete process.env.KHY_RELEASE_NOTES;
    const { handleReleaseNotes } = loadHandlerWithCapture();
    await handleReleaseNotes('0.1.0', []);
    const text = allText();
    assert.match(text, /## 0\.1\.0/);
    assert.match(text, /首版摘要/);
    assert.ok(!/## 0\.2\.0/.test(text));
  });

  test('版本未命中 → 友好提示 + 返回 false', async () => {
    delete process.env.KHY_RELEASE_NOTES;
    const { handleReleaseNotes } = loadHandlerWithCapture();
    const r = await handleReleaseNotes('9.9.9', []);
    assert.equal(r, false);
    assert.match(allText(), /未找到版本 9\.9\.9/);
  });

  test('CHANGELOG 缺失 → fail-soft 返回 false 不抛', async () => {
    delete process.env.KHY_RELEASE_NOTES;
    process.env.KHY_CHANGELOG_PATH = path.join(tmpDir, 'does-not-exist.md');
    const { handleReleaseNotes } = loadHandlerWithCapture();
    const r = await handleReleaseNotes('', []);
    assert.equal(r, false);
    assert.match(allText(), /未找到 CHANGELOG/);
  });
});
