'use strict';

/**
 * manage.matrix.test.js — `khy manage` 能力矩阵渲染契约(node:test)。
 *
 * 锁定 #133:装饰分隔线与「来源/能力」是资源标题(printSuccess)的缩进续行,
 * 不该各吃一个 printInfo 的「  i 」信息子弹。只允许标题行与用法行走 printInfo;
 * 分隔线/明细行走裸 console.log。经 require.cache 桩 formatters/management。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/manage');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const MANAGEMENT_PATH = require.resolve('../../../src/services/management');

let infoCalls;
let successCalls;
let logLines;
let realLog;

const ROWS = [
  { id: 'api-keys', label: 'API 密钥池', source: 'file', sourceDetail: '/x/api_keys.json', capabilities: ['list', 'add', 'remove'] },
  { id: 'users', label: '用户', source: 'db', sourceDetail: 'users', capabilities: ['list', 'get', 'create'] },
];

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function installStubs() {
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => infoCalls.push(String(m)),
    printSuccess: (m) => successCalls.push(String(m)),
    printWarn: () => {},
    printError: () => {},
  });
  cacheStub(MANAGEMENT_PATH, {
    describe: () => ROWS,
    get: () => null,
    listIds: () => ROWS.map((r) => r.id),
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/manage');
}

beforeEach(() => {
  infoCalls = [];
  successCalls = [];
  logLines = [];
  realLog = console.log;
  console.log = (...a) => { logLines.push(a.join(' ')); };
  installStubs();
});

afterEach(() => {
  console.log = realLog;
  for (const p of [HANDLER_PATH, FORMATTERS_PATH, MANAGEMENT_PATH]) {
    delete require.cache[p];
  }
});

describe('khy manage 能力矩阵:续行不吃信息子弹(#133)', () => {
  test('printInfo 只出现标题 + 用法两条,分隔线/明细走裸 console.log', async () => {
    const { handleManage } = freshHandler();
    await handleManage({ args: [] });

    // printInfo 只应为「标题」「用法」两行,绝不含分隔线或来源/能力。
    assert.equal(infoCalls.length, 2, `期望 2 条 printInfo,实得 ${infoCalls.length}:${JSON.stringify(infoCalls)}`);
    assert.ok(/统一管理面/.test(infoCalls[0]), '首条应为标题');
    assert.ok(/用法:/.test(infoCalls[1]), '末条应为用法');
    assert.ok(!infoCalls.some((m) => /^─/.test(m.trim())), '分隔线不应吃 printInfo');
    assert.ok(!infoCalls.some((m) => /来源:|能力:/.test(m)), '来源/能力不应吃 printInfo');

    // 每个资源:1 条 printSuccess 标题 + 2 行裸 console.log 明细。
    assert.equal(successCalls.length, ROWS.length, '每条资源标题应为 printSuccess');
    const sourceLines = logLines.filter((l) => /来源:/.test(l));
    const capLines = logLines.filter((l) => /能力:/.test(l));
    assert.equal(sourceLines.length, ROWS.length);
    assert.equal(capLines.length, ROWS.length);
    // 明细行缩进为纯空格,不得含信息子弹字形(i/✓/⚠/✗)。
    assert.ok(sourceLines.every((l) => /^\s+来源:/.test(l) && !/[i✓⚠✗]/.test(l.slice(0, 5))), `明细行含多余字形:${JSON.stringify(sourceLines)}`);
    // 分隔线为裸 console.log,不吃信息子弹。
    const rules = logLines.filter((l) => /^[\s─]+$/.test(l) && l.includes('─'));
    assert.equal(rules.length, 2, `期望 2 条分隔线,实得 ${rules.length}:${JSON.stringify(rules)}`);
    assert.ok(rules.every((l) => !/[i✓⚠✗]/.test(l)), '分隔线不应含信息子弹字形');
  });
});
