'use strict';

/**
 * dependencies.resource.js contract tests — the manage-side funnel for
 * `khy manage dependencies list|install`.
 *
 * The three real dependencies (installRunner / resolver / dependencyInventory)
 * plus the lazily required networkDetector are replaced in require.cache by
 * stub objects keyed on their fully resolved paths before the module under test
 * is required, and everything is restored in `after`. Nothing here shells out,
 * touches the network or writes to disk; the resource's own logic (argument
 * gating, server-side tier re-validation, the offline probe, result shaping)
 * is what is under test.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const P = {
  self: require.resolve('./dependencies.resource'),
  installRunner: require.resolve('../../../network/dependency/installRunner'),
  resolver: require.resolve('../../../network/dependency/resolver'),
  inventory: require.resolve('../../../../dependencyInventory'),
  net: require.resolve('../../../../networkDetector'),
};

const MANUAL_REASON_SYS = 'System-level / elevation-required dependency: command provided, run it manually.';
const MANUAL_REASON_RISK = 'High-risk dependency: command provided, run it manually.';
const OFFLINE_ERR = 'Offline: cannot download this dependency. Reconnect and retry.';

// Mutable seams: every stub delegates here so a single installed stub set can
// serve every case.
const H = {};
function resetHooks() {
  H.listResult = { runtime: [], packages: [] };
  H.listCalls = [];
  H.env = { platform: 'linux', cwd: path.join(TMP, 'project') };
  H.envCalls = 0;
  H.plan = null;
  H.planCalls = [];
  H.autoInstallable = true;
  H.autoCalls = [];
  H.netIsOnline = () => true;
  H.netCalls = 0;
  H.runResult = { ok: true, command: 'apt install ffmpeg', steps: ['fetch'], error: null, hint: null };
  H.installCalls = [];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-manage-deps-'));

function stubModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const inventoryStub = {
  async listInventory(...args) {
    H.listCalls.push(args);
    return H.listResult;
  },
  _isPlanAutoInstallable(plan) {
    H.autoCalls.push(plan);
    return typeof H.autoInstallable === 'function' ? H.autoInstallable(plan) : H.autoInstallable;
  },
};

const resolverStub = {
  defaultEnv() {
    H.envCalls += 1;
    return H.env;
  },
  buildInstallPlan(depId, env, opts) {
    H.planCalls.push({ depId, env, opts });
    return H.plan;
  },
};

// installRunner's export is destructured at load time, so the stub function has
// to be a live dispatcher rather than a value copy.
const installRunnerStub = {
  async runInstall(plan, opts) {
    H.installCalls.push({ plan, opts });
    return typeof H.runResult === 'function' ? H.runResult(plan, opts) : H.runResult;
  },
};

const netStub = {
  isOnline() {
    H.netCalls += 1;
    return H.netIsOnline();
  },
};

const saved = {};
let contract = null;

describe('management/resources/dependencies.resource', () => {
  before(() => {
    for (const key of Object.keys(P)) {
      saved[key] = Object.prototype.hasOwnProperty.call(require.cache, P[key]) ? require.cache[P[key]] : undefined;
      delete require.cache[P[key]];
    }
    require.cache[P.installRunner] = stubModule(P.installRunner, installRunnerStub);
    require.cache[P.resolver] = stubModule(P.resolver, resolverStub);
    require.cache[P.inventory] = stubModule(P.inventory, inventoryStub);
    require.cache[P.net] = stubModule(P.net, netStub);
    resetHooks();
    contract = require(P.self);
  });

  after(() => {
    for (const key of Object.keys(P)) {
      if (saved[key]) require.cache[P[key]] = saved[key];
      else delete require.cache[P[key]];
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetHooks();
    netStub.isOnline = () => {
      H.netCalls += 1;
      return H.netIsOnline();
    };
  });

  it('出厂契约声明：process 真源 + list/install 两个能力', () => {
    assert.equal(contract.id, 'dependencies');
    assert.equal(contract.label, '依赖清单');
    assert.equal(contract.source, 'process');
    assert.equal(contract.sourceDetail, 'host:dependency-inventory');
    assert.deepEqual(contract.capabilities, ['list', 'install']);
    assert.deepEqual(contract.schema, { install: { id: { type: 'string', required: true } } });
    assert.deepEqual(Object.keys(contract.ops), ['list', 'install']);
  });

  it('契约通过 resourceContract 的真·校验（唯一漏斗的入册前提）', () => {
    const { validateContract } = require('../resourceContract');
    assert.deepEqual(validateContract(contract), { ok: true, errors: [] });
  });

  it('list 原样透传 dependencyInventory 的结果，不额外包一层', async () => {
    H.listResult = { runtime: [{ id: 'node', present: true }], packages: [{ id: 'ffmpeg' }] };
    const r = await contract.ops.list();
    assert.deepEqual(r, H.listResult);
    assert.equal(H.listCalls.length, 1);
    assert.deepEqual(H.listCalls[0], [], 'listInventory() is called with no arguments');
  });

  it('KNOWN-DEFECT: list 与同级 cron/api-keys 的返回形状不一致，且不做任何归一化', async () => {
    // Measured: cron.list → {jobs}, apiKeys.list → {providers}, but
    // dependencies.list returns whatever listInventory yields — null included.
    for (const junk of [null, undefined, 'oops', 0, [], '']) {
      H.listResult = junk;
      const r = await contract.ops.list();
      assert.deepEqual(r, junk, `list passes ${JSON.stringify(junk)} straight through`);
    }
    // The two install-free surfaces above would have produced { jobs: null } /
    // { providers: null }; here the caller gets a bare null instead.
    H.listResult = null;
    assert.deepEqual(await contract.ops.list(), null);
  });

  it('install 缺 id：null/undefined/{}/空串/0/false 全部抛同一句话', async () => {
    for (const args of [undefined, null, {}, { id: '' }, { id: 0 }, { id: false }, { id: null }, { name: 'ffmpeg' }]) {
      await assert.rejects(() => contract.ops.install(args), { message: 'id is required', name: 'Error' });
      assert.equal(H.envCalls, 0, 'nothing is resolved before the id gate');
      assert.equal(H.installCalls.length, 0);
    }
  });

  it('install 解析不到计划时抛 unknown or non-installable，并把 id 原样插进文案', async () => {
    H.plan = null;
    await assert.rejects(() => contract.ops.install({ id: 'ffmpeg' }), {
      message: 'unknown or non-installable dependency: ffmpeg',
    });
    // Measured: any falsy plan collapses into the same message, and a non-string
    // id is stringified by the template.
    for (const falsy of [undefined, 0, '', false, NaN]) {
      H.plan = falsy;
      await assert.rejects(() => contract.ops.install({ id: 'x' }), {
        message: 'unknown or non-installable dependency: x',
      }, `plan=${String(falsy)}`);
    }
    H.plan = null;
    await assert.rejects(() => contract.ops.install({ id: 123 }), {
      message: 'unknown or non-installable dependency: 123',
    });
  });

  it('install 把 defaultEnv() 的结果同时用于计划构建与 runInstall 的 cwd', async () => {
    H.plan = { depId: 'ffmpeg', scope: 'project', displayCommand: 'apt install ffmpeg' };
    await contract.ops.install({ id: 'ffmpeg' });
    assert.equal(H.envCalls, 1, 'defaultEnv() is consulted exactly once per install');
    assert.deepEqual(H.planCalls, [{ depId: 'ffmpeg', env: H.env, opts: undefined }]);
    assert.equal(H.planCalls[0].env, H.env, 'the same env object is handed to the resolver');
    assert.equal(H.autoCalls[0], H.plan, 'the plan itself is re-validated server-side');
    assert.deepEqual(H.installCalls, [{ plan: H.plan, opts: { cwd: path.join(TMP, 'project') } }]);
  });

  it('tier 复检不过时返回 manualOnly 三态，且绝不触发安装', async () => {
    H.autoInstallable = false;
    H.plan = {
      depId: 'ffmpeg',
      scope: 'system',
      requiresElevation: true,
      docsUrl: 'https://example.invalid/ffmpeg',
      displayCommand: 'sudo apt install ffmpeg',
    };
    const r = await contract.ops.install({ id: 'ffmpeg' });
    assert.deepEqual(r, {
      success: false,
      manualOnly: true,
      displayCommand: 'sudo apt install ffmpeg',
      docsUrl: 'https://example.invalid/ffmpeg',
      reason: MANUAL_REASON_SYS,
    });
    assert.equal(H.installCalls.length, 0, 'a manual-only verdict must never reach runInstall');
  });

  it('manualOnly 的 reason 三分支：提权 / 非 project 作用域 / 纯高危', async () => {
    H.autoInstallable = false;
    const cases = [
      [{ scope: 'project', requiresElevation: true }, MANUAL_REASON_SYS],
      [{ scope: 'system', requiresElevation: false }, MANUAL_REASON_SYS],
      [{ scope: 'project', requiresElevation: false }, MANUAL_REASON_RISK],
      [{ scope: undefined, requiresElevation: undefined }, MANUAL_REASON_SYS],
    ];
    for (const [over, expected] of cases) {
      H.plan = { depId: 'd', displayCommand: 'cmd', ...over };
      const r = await contract.ops.install({ id: 'd' });
      assert.equal(r.reason, expected, JSON.stringify(over));
    }
  });

  it('KNOWN-DEFECT: manualOnly 返回体既无 depId 也无 steps/error，且 docsUrl 缺省时键仍在', async () => {
    // Measured: the manual-only branch echoes displayCommand/docsUrl/reason but
    // drops depId, command, steps, error and hint, which the success branch
    // always carries — a caller cannot correlate the verdict with the request.
    H.autoInstallable = false;
    H.plan = { depId: 'ffmpeg', scope: 'project', displayCommand: 'brew install ffmpeg' };
    const r = await contract.ops.install({ id: 'ffmpeg' });
    assert.deepEqual(Object.keys(r), ['success', 'manualOnly', 'displayCommand', 'docsUrl', 'reason']);
    assert.equal('depId' in r, false, 'depId is absent from the manual-only shape');
    assert.equal(r.docsUrl, undefined, 'docsUrl key exists with an undefined value');
    // The success shape for the same id is a different set of keys entirely.
    H.autoInstallable = true;
    const ok = await contract.ops.install({ id: 'ffmpeg' });
    assert.deepEqual(Object.keys(ok), ['success', 'depId', 'command', 'steps', 'error', 'hint']);
  });

  it('离线且有网络的依赖：返回 offline 结果并跳过 runInstall', async () => {
    H.plan = { depId: 'ffmpeg', scope: 'project', needsNetwork: true, displayCommand: 'x' };
    H.netIsOnline = () => false;
    const r = await contract.ops.install({ id: 'ffmpeg' });
    assert.deepEqual(r, { success: false, offline: true, error: OFFLINE_ERR });
    assert.equal(H.netCalls, 1);
    assert.equal(H.installCalls.length, 0);
  });

  it('needsNetwork 不为真时完全不做联网探测', async () => {
    for (const needsNetwork of [false, undefined, null, 0]) {
      resetHooks();
      H.plan = { depId: 'd', scope: 'project', needsNetwork, displayCommand: 'x' };
      H.netIsOnline = () => false;
      const r = await contract.ops.install({ id: 'd' });
      assert.equal(H.netCalls, 0, `needsNetwork=${String(needsNetwork)} skips the probe`);
      assert.equal(r.success, true);
    }
  });

  it('KNOWN-DEFECT: 联网判定用严格 === false，isOnline 返回 0/undefined/“offline” 时照样开装', async () => {
    // Measured: only a literal `false` blocks; every other falsy or truthy-yet
    // -not-true value falls straight through to runInstall.
    for (const notReallyOnline of [0, undefined, null, '', NaN, 'offline', 'no']) {
      resetHooks();
      H.plan = { depId: 'd', scope: 'project', needsNetwork: true, displayCommand: 'x' };
      H.netIsOnline = () => notReallyOnline;
      const r = await contract.ops.install({ id: 'd' });
      assert.equal(r.success, true, `isOnline()=${String(notReallyOnline)} still installed`);
      assert.equal(H.installCalls.length, 1, `isOnline()=${String(notReallyOnline)} reached runInstall`);
    }
  });

  it('networkDetector 没有 isOnline 时降级为不阻塞安装', async () => {
    delete netStub.isOnline;
    H.plan = { depId: 'd', scope: 'project', needsNetwork: true, displayCommand: 'x' };
    const r = await contract.ops.install({ id: 'd' });
    assert.equal(r.success, true);
    assert.equal(H.netCalls, 0);
  });

  it('KNOWN-DEFECT: 联网探测的异常与 require 失败都被 catch 吞掉，安装照常发生', async () => {
    H.plan = { depId: 'd', scope: 'project', needsNetwork: true, displayCommand: 'x' };
    // Measured: isOnline() throwing is indistinguishable from "online".
    H.netIsOnline = () => {
      throw new Error('dns blew up');
    };
    let r = await contract.ops.install({ id: 'd' });
    assert.equal(r.success, true, 'a throwing probe was swallowed');
    assert.equal(H.installCalls.length, 1);

    // Measured: if the module itself cannot be loaded, the catch swallows that
    // too and the install proceeds.
    const savedNet = require.cache[P.net];
    require.cache[P.net] = {
      id: P.net,
      filename: P.net,
      loaded: true,
      get exports() {
        throw new Error('MODULE_NOT_FOUND-ish');
      },
      children: [],
      paths: [],
    };
    try {
      H.netCalls = 0;
      H.installCalls = [];
      r = await contract.ops.install({ id: 'd' });
      assert.equal(r.success, true, 'an unloadable networkDetector was swallowed');
      assert.equal(H.installCalls.length, 1);
    } finally {
      require.cache[P.net] = savedNet;
    }
  });

  it('runInstall 的成功/失败形状：ok 强制布尔，error 与 hint 的假值归一为 null', async () => {
    H.plan = { depId: 'd', scope: 'project', needsNetwork: false, displayCommand: 'x' };
    H.runResult = { ok: 1, command: 'c', steps: ['s1', 's2'], error: '', hint: 0 };
    let r = await contract.ops.install({ id: 'd' });
    assert.deepEqual(r, { success: true, depId: 'd', command: 'c', steps: ['s1', 's2'], error: null, hint: null });

    H.runResult = { ok: false, command: 'c', steps: [], error: 'exit 1' };
    r = await contract.ops.install({ id: 'd' });
    assert.deepEqual(r, { success: false, depId: 'd', command: 'c', steps: [], error: 'exit 1', hint: null });

    // Measured: `depId` in the reply is the caller's args.id, not plan.depId.
    H.runResult = { ok: true };
    r = await contract.ops.install({ id: 'alias-name' });
    assert.equal(r.depId, 'alias-name');
    assert.equal(r.command, undefined);
    assert.equal(r.steps, undefined);
  });

  it('KNOWN-DEFECT: runInstall 解析为 null/undefined 时崩，解析为 false/0/空串时被读成一次无因失败', async () => {
    // Measured: install reads result.ok / result.command with no shape guard.
    // null/undefined → TypeError; the other falsy primitives survive property
    // access, so the caller sees success:false with error:null — a failed
    // install that reports no reason at all.
    H.plan = { depId: 'd', scope: 'project', needsNetwork: false, displayCommand: 'x' };
    for (const junk of [undefined, null]) {
      H.runResult = junk;
      await assert.rejects(() => contract.ops.install({ id: 'd' }), TypeError, `runInstall → ${String(junk)}`);
    }
    for (const junk of [false, 0, '']) {
      H.runResult = junk;
      const r = await contract.ops.install({ id: 'd' });
      assert.deepEqual(r, {
        success: false,
        depId: 'd',
        command: undefined,
        steps: undefined,
        error: null,
        hint: null,
      }, `runInstall → ${JSON.stringify(junk)}`);
    }
  });

  it('runInstall 抛错原样上抛且不影响联网判定；install 不接受第二个 ctx 参数', async () => {
    H.plan = { depId: 'd', scope: 'project', needsNetwork: true, displayCommand: 'x' };
    H.netIsOnline = () => 'nope';
    H.runResult = () => {
      throw new Error('spawn EACCES');
    };
    await assert.rejects(() => contract.ops.install({ id: 'd' }, { source: 'web', user: 'root' }), {
      message: 'spawn EACCES',
    });
    assert.equal(H.netCalls, 1, 'the probe ran once even though a non-false answer let it through');
    assert.equal(contract.ops.install.length, 1, 'install has no ctx parameter at all');
    assert.equal(contract.ops.list.length, 0, 'list accepts nothing, ctx included or not');
  });

  it('defaultEnv 返回 undefined 时 install 在取 cwd 前就崩，env 照样传给了 resolver', async () => {
    H.env = undefined;
    H.plan = { depId: 'd', scope: 'project', needsNetwork: false, displayCommand: 'x' };
    await assert.rejects(() => contract.ops.install({ id: 'd' }), TypeError);
    assert.deepEqual(H.planCalls, [{ depId: 'd', env: undefined, opts: undefined }]);
  });
});
