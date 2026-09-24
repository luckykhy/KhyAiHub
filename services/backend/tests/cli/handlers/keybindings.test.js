'use strict';

/**
 * keybindings.test.js — `/keybindings` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → printInfo 提示 + 返回 false;无参 → 打印全部分组;上下文名参 → 仅该组;
 * 自由查询参 → 过滤;无命中 → 友好提示 + true。经 require.cache 桩 formatters 捕获通知输出。
 *
 * 面板正文走裸行输出(而非 printInfo):printInfo 只给整段的第一行挂通知标记,
 * 于是首组标题「【全局】」被当成一条提示、其余组标题却没有 —— 同层级两种样子。
 * 因此断言用 notice 通道(info)+ 正文通道(raw)合并的完整面板。
 *
 * 正文通道的取法:**注入写入器** —— 薄壳把写入器作为末位可选参数收进来,
 * 测试传自己的收集器,不必猴子补丁全局输出。与同族的 `?` 浮层同款。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/keybindings');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');

let calls;

/** Run the handler, routing the catalog body into `calls.raw` via the injected writer. */
async function runCaptured(handleKeybindings, sub, args) {
  calls.raw = [];
  return handleKeybindings(sub, args, {}, (m) => calls.raw.push(String(m)));
}

/** Whole panel as the user sees it: notice lines + bare content lines. */
function panel() {
  return calls.info.concat(calls.raw).join('\n');
}

function stubFormatters() {
  require.cache[FORMATTERS_PATH] = {
    id: FORMATTERS_PATH,
    filename: FORMATTERS_PATH,
    loaded: true,
    exports: {
      printInfo: (m) => calls.info.push(String(m)),
      printSuccess: (m) => calls.success.push(String(m)),
      printWarn: (m) => calls.warn.push(String(m)),
      printError: (m) => calls.error.push(String(m)),
    },
  };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/keybindings');
}

beforeEach(() => {
  calls = { info: [], raw: [], success: [], warn: [], error: [] };
  stubFormatters();
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete process.env.KHY_KEYBINDINGS;
});

describe('门控关 → 不接管', () => {
  test('KHY_KEYBINDINGS=0 → printInfo 提示 + 返回 false', async () => {
    process.env.KHY_KEYBINDINGS = '0';
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', []);
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /\?/.test(m)));
  });
});

// Group headers are panel CONTENT, never notices: only the title/hint lines may
// come through the printInfo channel. Pinned once here so the panel-body
// decision in the handler cannot silently regress to a decorated first line.
describe('无参 → 全部分组', () => {
  test('打印含多组标题与关键键位', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await runCaptured(handleKeybindings, '', []);
    assert.equal(r, true);
    const all = panel();
    assert.match(all, /【全局】/);
    assert.match(all, /【编辑】/);
    assert.match(all, /Shift \+ Tab/);
    assert.doesNotMatch(calls.info.join('\n'), /【/);
  });
});

describe('上下文名参 → 仅该组', () => {
  test('/keybindings vim → 只含 Vim 组', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await runCaptured(handleKeybindings, '', ['vim']);
    assert.equal(r, true);
    const all = panel();
    assert.match(all, /Vim 模式/);
    assert.doesNotMatch(all, /【全局】/);
  });
});

describe('自由查询参 → 过滤', () => {
  test('/keybindings ctrl → 仅含 ctrl 行', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await runCaptured(handleKeybindings, '', ['ctrl']);
    assert.equal(r, true);
    const all = panel();
    assert.match(all, /Ctrl/);
    assert.match(all, /过滤/);
  });
});

describe('无命中 → 友好提示', () => {
  test('/keybindings zzzz → 提示 + 返回 true', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', ['zzzz-nope']);
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /未找到/.test(m)));
  });
});
