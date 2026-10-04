'use strict';

/**
 * sandboxToggle.test.js — `/sandbox-toggle` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不写;无动作 → 只读查看;on → writeEnvMap(KHY_OS_SANDBOX=true);
 * off → writeEnvMap(false);auto → unsetEnvKeys;未知动作 → 用法提示不写;**诚实边界**:
 * 写了 true 但后端不可用 → 如实告知未生效。经 require.cache 桩 formatters/toolSandbox/gatewayEnvFile。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/sandboxToggle');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const TOOLSANDBOX_PATH = require.resolve('../../../src/services/toolSandbox');
const ENVFILE_PATH = require.resolve('../../../src/services/gatewayEnvFile');

let calls;
let envWrites;
let envUnsets;
let bwrapAvailable;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function installStubs() {
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
  });
  cacheStub(TOOLSANDBOX_PATH, {
    _detectBwrap: () => (bwrapAvailable ? '/usr/bin/bwrap' : null),
    _detectSeatbelt: () => false,
  });
  cacheStub(ENVFILE_PATH, {
    writeEnvMap: (map) => { envWrites.push(map); },
    unsetEnvKeys: (keys) => { envUnsets.push(keys); },
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/sandboxToggle');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  envWrites = [];
  envUnsets = [];
  bwrapAvailable = true;
  delete process.env.KHY_OS_SANDBOX;
  delete process.env.KHY_SANDBOX_TOGGLE;
  installStubs();
});

afterEach(() => {
  for (const p of [HANDLER_PATH, FORMATTERS_PATH, TOOLSANDBOX_PATH, ENVFILE_PATH]) {
    delete require.cache[p];
  }
  delete process.env.KHY_OS_SANDBOX;
  delete process.env.KHY_SANDBOX_TOGGLE;
});

describe('门控关 → 不接管', () => {
  test('KHY_SANDBOX_TOGGLE=0 → printInfo + 返回 false,不写 env', async () => {
    process.env.KHY_SANDBOX_TOGGLE = '0';
    const { handleSandboxToggle } = freshHandler();
    const r = await handleSandboxToggle('on', []);
    assert.equal(r, false);
    assert.equal(envWrites.length, 0);
    assert.equal(envUnsets.length, 0);
  });
});

describe('无动作 → 只读查看', () => {
  test('打印当前态 + 用法,不写 env', async () => {
    const { handleSandboxToggle } = freshHandler();
    const r = await handleSandboxToggle('', []);
    assert.equal(r, true);
    assert.equal(envWrites.length, 0);
    assert.ok(calls.info.some((m) => /OS 沙箱/.test(m)));
    assert.ok(calls.info.some((m) => /用法/.test(m)));
  });

  // 状态与解释必须是同一个信息块:原因只是标题行的续行,不再单独吃一个「i」子弹。
  // 视图 = 状态块 + 用法 = 恰好 2 条 info;若回归成竖排两个信息符,则 >2。
  test('态标题与原因合为一个 info 块(无重复信息子弹)', async () => {
    const { handleSandboxToggle } = freshHandler();
    await handleSandboxToggle('', []);
    const statusBlock = calls.info.find((m) => /OS 沙箱/.test(m));
    assert.ok(statusBlock, '缺少状态块');
    // 同一条 info 里既有标题行也有原因行(换行拼接)。
    assert.ok(statusBlock.includes('\n'), '原因应并入同一 info 块');
    assert.ok(/后端=/.test(statusBlock));
    // 只有 2 条 info:状态块 + 用法。
    assert.equal(
      calls.info.length,
      2,
      `期望 2 条 info,实得 ${calls.info.length}:${JSON.stringify(calls.info)}`
    );
    // 没有一条独立的、只是原因的 info 子弹。
    assert.ok(
      !calls.info.some((m) => !/OS 沙箱/.test(m) && !/用法/.test(m)),
      `出现多余的信息子弹:${JSON.stringify(calls.info)}`
    );
  });
});

describe('on → 写 KHY_OS_SANDBOX=true', () => {
  test('writeEnvMap(true) + 回显', async () => {
    const { handleSandboxToggle } = freshHandler();
    const r = await handleSandboxToggle('on', []);
    assert.equal(r, true);
    assert.equal(envWrites.length, 1);
    assert.equal(envWrites[0].KHY_OS_SANDBOX, 'true');
    assert.ok(calls.success.some((m) => /KHY_OS_SANDBOX=true/.test(m)));
  });
});

describe('off → 写 KHY_OS_SANDBOX=false', () => {
  test('writeEnvMap(false)', async () => {
    const { handleSandboxToggle } = freshHandler();
    await handleSandboxToggle('off', []);
    assert.equal(envWrites[0].KHY_OS_SANDBOX, 'false');
  });
});

describe('auto → unsetEnvKeys', () => {
  test('删除 KHY_OS_SANDBOX 回默认', async () => {
    process.env.KHY_OS_SANDBOX = 'true';
    const { handleSandboxToggle } = freshHandler();
    await handleSandboxToggle('auto', []);
    assert.equal(envWrites.length, 0);
    assert.equal(envUnsets.length, 1);
    assert.deepEqual(envUnsets[0], ['KHY_OS_SANDBOX']);
  });
});

describe('toggle:基于当前生效语义翻转', () => {
  test('当前 false → 写 true', async () => {
    process.env.KHY_OS_SANDBOX = 'false';
    const { handleSandboxToggle } = freshHandler();
    await handleSandboxToggle('toggle', []);
    assert.equal(envWrites[0].KHY_OS_SANDBOX, 'true');
  });
});

describe('未知动作 → 用法提示不写', () => {
  test('printWarn + 不写 env', async () => {
    const { handleSandboxToggle } = freshHandler();
    const r = await handleSandboxToggle('frobnicate', []);
    assert.equal(r, true);
    assert.equal(envWrites.length, 0);
    assert.ok(calls.warn.some((m) => /未知动作/.test(m)));
  });
});

describe('诚实边界:写 true 但后端不可用 → 告知未生效', () => {
  test('bwrap 不可用 → 仍写 true 但提示未生效', async () => {
    bwrapAvailable = false; // Linux 但无 bwrap
    const { handleSandboxToggle } = freshHandler();
    await handleSandboxToggle('on', []);
    assert.equal(envWrites[0].KHY_OS_SANDBOX, 'true');
    // 现态打印里必有「未生效」与「不可用」提示,绝不假装已生效。
    assert.ok(calls.info.some((m) => /未生效/.test(m)));
    assert.ok(calls.warn.some((m) => /不可用|安装/.test(m)));
  });
});
