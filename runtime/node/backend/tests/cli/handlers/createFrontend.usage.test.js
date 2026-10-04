'use strict';

/**
 * createFrontend.usage.test.js — `khy create-frontend` 用法块渲染契约(node:test)。
 *
 * 锁定 #137:「示例：」下的三条 create-frontend 示例是表头的缩进续行,不该各吃一个
 * printInfo 的「  i 」信息子弹(否则竖排三枚 i、且示例前导空格被挤到子弹之后)。
 * 只允许「用法/说明/示例/原型」四行走 printInfo;三条示例行走裸 console.log 且缩进对齐。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/createFrontend');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');

let infoCalls;
let errCalls;
let logLines;
let realLog;

beforeEach(() => {
  infoCalls = [];
  errCalls = [];
  logLines = [];
  realLog = console.log;
  console.log = (...a) => { logLines.push(a.join(' ')); };
  require.cache[FORMATTERS_PATH] = {
    id: FORMATTERS_PATH,
    filename: FORMATTERS_PATH,
    loaded: true,
    exports: {
      printInfo: (m) => infoCalls.push(String(m)),
      printError: (m) => errCalls.push(String(m)),
      printSuccess: () => {},
      printWarn: () => {},
    },
  };
  delete require.cache[HANDLER_PATH];
});

afterEach(() => {
  console.log = realLog;
  for (const p of [HANDLER_PATH, FORMATTERS_PATH]) delete require.cache[p];
});

describe('khy create-frontend 用法块:示例续行不吃信息子弹(#137)', () => {
  test('三条示例走裸 console.log,4 空格缩进,不含信息子弹字形', () => {
    const { handleCreateFrontend } = require(HANDLER_PATH);
    handleCreateFrontend(null, [], {});

    const isExample = (l) => /后台管理系统|电商前端：|数据可视化大屏/.test(l);
    const examples = logLines.filter(isExample);
    assert.equal(examples.length, 3, `期望 3 条示例走 console.log,实得 ${examples.length}:${JSON.stringify(examples)}`);
    // 每条示例必须是纯空格缩进的续行,前 5 显示列不得出现 i/✓/⚠/✗ 子弹字形。
    assert.ok(
      examples.every((l) => /^ {4}create-frontend/.test(l) && !/[i✓⚠✗]/.test(l.slice(0, 5))),
      `示例行缩进/字形异常:${JSON.stringify(examples)}`
    );
    // 示例绝不应再出现在 printInfo 里(否则又吃一枚「  i 」子弹)。
    assert.ok(
      !infoCalls.some(isExample),
      `示例仍走 printInfo:${JSON.stringify(infoCalls)}`
    );
  });

  test('printInfo 仅承载 用法/说明/示例/原型 四条标题行', () => {
    const { handleCreateFrontend } = require(HANDLER_PATH);
    handleCreateFrontend(null, [], {});

    const joined = infoCalls.join('\n');
    assert.match(joined, /用法：/);
    assert.match(joined, /说明：/);
    assert.match(joined, /示例：/);
    assert.match(joined, /原型：/);
    assert.equal(infoCalls.length, 4, `期望 4 条 printInfo 标题行,实得 ${infoCalls.length}:${JSON.stringify(infoCalls)}`);
  });
});
