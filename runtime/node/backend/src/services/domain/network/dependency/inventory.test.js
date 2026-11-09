'use strict';

/**
 * Co-located tests for inventory.js — 开发环境盘点目录与全量盘点。
 * scanInventory 走注入桩零真实探测；快照写盘用临时数据家（KHY_PROJECT_DATA_HOME），
 * 不触碰真实 works/data/khy。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据家指到临时目录必须先于任何 getSnapshotPath() 调用（dataHome 有进程级缓存）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-devenv-test-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const inventory = require('./inventory');
const resolver = require('./resolver');

/** 纯内存盘点桩：presentMap 决定 presence，versionMap 决定版本。 */
function stubDeps(presentMap = {}, versionMap = {}) {
  return {
    probe: (depId) => ({
      id: depId,
      present: !!presentMap[depId],
      kind: 'system-command',
      detail: presentMap[depId] ? `C:\\stub\\${depId}.exe` : 'not on PATH',
    }),
    probeVersion: async (depId) => ({
      version: versionMap[depId] || null,
      raw: versionMap[depId] ? `stub ${versionMap[depId]}` : '',
      binUsed: presentMap[depId] ? depId : null,
    }),
    searchExecutable: (name) => (name === 'winget' ? 'C:\\stub\\winget.exe' : null),
  };
}

after(() => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('normalizeToDepId（语言名归一）', () => {
  test('设计定稿点名的归一映射', () => {
    assert.strictEqual(inventory.normalizeToDepId('c'), 'gcc');
    assert.strictEqual(inventory.normalizeToDepId('c++'), 'gpp');
    assert.strictEqual(inventory.normalizeToDepId('C#'), 'dotnet');
    assert.strictEqual(inventory.normalizeToDepId('csharp'), 'dotnet');
    assert.strictEqual(inventory.normalizeToDepId('java'), 'openjdk');
    assert.strictEqual(inventory.normalizeToDepId('jdk'), 'openjdk');
    assert.strictEqual(inventory.normalizeToDepId('javascript'), 'nodejs');
    assert.strictEqual(inventory.normalizeToDepId('js'), 'nodejs');
    assert.strictEqual(inventory.normalizeToDepId('wasm'), 'wabt');
    assert.strictEqual(inventory.normalizeToDepId('python'), 'python3');
  });

  test('depId 直接命中与未知返回', () => {
    assert.strictEqual(inventory.normalizeToDepId('python3'), 'python3');
    assert.strictEqual(inventory.normalizeToDepId('JAVA'), 'openjdk');
    assert.strictEqual(inventory.normalizeToDepId('moonbitlang'), null);
    assert.strictEqual(inventory.normalizeToDepId(''), null);
    assert.strictEqual(inventory.normalizeToDepId(null), null);
  });
});

describe('DEV_ENV_CATALOG 三态', () => {
  test('moonbit 是唯一的 manual，html/css 是 informational', () => {
    const manual = inventory.DEV_ENV_CATALOG.filter((e) => e.kind === 'manual');
    assert.deepStrictEqual(manual.map((e) => e.depId), ['moonbit']);
    const info = inventory.DEV_ENV_CATALOG.filter((e) => e.kind === 'informational');
    assert.deepStrictEqual(info.map((e) => e.depId).sort(), ['css', 'html']);
  });

  test('可安装/手动条目的 depId 都登记在 registry（informational 是纯目录项，无运行时无条目）', () => {
    for (const entry of inventory.DEV_ENV_CATALOG) {
      if (entry.kind === 'informational') {
        assert.strictEqual(require('./registry').getDependency(entry.depId), null, entry.depId);
        continue;
      }
      assert.ok(registryHas(entry.depId), `catalog depId 不在 registry: ${entry.depId}`);
    }
  });

  function registryHas(depId) {
    return require('./registry').getDependency(depId) != null;
  }
});

describe('assertInstallable（manual/informational 硬短路闸）', () => {
  test('moonbit 拒绝并给 installHint，绝不构建计划', () => {
    const r = inventory.assertInstallable('moonbit');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'DEV_ENV_MANUAL_ONLY');
    assert.ok(r.installHint.includes('cli.moonbitlang.com'), r.installHint);
  });

  test('html/informational 拒绝，code 为 NOT_INSTALLABLE', () => {
    const r = inventory.assertInstallable('html');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'DEV_ENV_NOT_INSTALLABLE');
  });

  test('未登记 depId 拒绝', () => {
    const r = inventory.assertInstallable('no-such-dep');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'DEV_ENV_UNKNOWN_DEP');
  });

  test('installable 条目放行', () => {
    assert.deepStrictEqual(inventory.assertInstallable('gcc'), { ok: true, depId: 'gcc' });
  });

  // KNOWN-DEFECT: registry/installRunner 对 manager:'script' 无分支强制——
  // 实测 buildInstallPlan('moonbit') 返回非空计划且 runInstall 只验 command
  // 数组非空即执行（installRunner 全文件无 script 分支）。本断言把该现状钉住：
  // devenv 层的 assertInstallable 闸因此**必须**先于 buildInstallPlan 调用；
  // 若有人把硬拒下沉到 resolver/installRunner（自愈链行为变更，需人工裁决），
  // 本断言翻红即为提示，不得静默删除。
  test('KNOWN-DEFECT: buildInstallPlan(moonbit) 仍产出 script 计划，闸必须落在 devenv 层', () => {
    const plan = resolver.buildInstallPlan('moonbit');
    assert.ok(plan, '若 installRunner/buildInstallPlan 已加 script 硬拒，请同步更新本钉子与本注释');
    assert.strictEqual(plan.manager, 'script');
  });
});

describe('scanInventory（注入桩，writeSnapshot:false）', () => {
  test('逐项聚合 presence/版本/winget，informational 恒缺失带 note', async () => {
    const deps = stubDeps(
      { python3: true, openjdk: true, moonbit: true },
      { python3: '3.12.7', openjdk: '21.0.5', moonbit: '0.1.0' }
    );
    const snap = await inventory.scanInventory({ deps, platform: 'win32', writeSnapshot: false });

    assert.strictEqual(snap.platform, 'win32');
    assert.deepStrictEqual(snap.winget, { present: true, detail: 'C:\\stub\\winget.exe' });
    const byId = Object.fromEntries(snap.entries.map((e) => [e.depId, e]));

    assert.strictEqual(byId.python3.present, true);
    assert.strictEqual(byId.python3.version, '3.12.7');
    assert.strictEqual(byId.python3.kind, 'installable');
    assert.strictEqual(byId.python3.versionable, true);
    assert.ok(byId.python3.versions.includes('3.12'));

    assert.strictEqual(byId.openjdk.present, true);
    assert.strictEqual(byId.openjdk.version, '21.0.5');
    assert.ok(byId.openjdk.versions.includes('17'));

    assert.strictEqual(byId.moonbit.kind, 'manual');
    assert.strictEqual(byId.moonbit.present, true);
    assert.ok(String(byId.moonbit.note).includes('DEV_ENV_MANUAL_ONLY'));
    // 快照条目带 installHint：web/桌面「复制安装命令」按钮同源数据（复审 #2）。
    assert.ok(String(byId.moonbit.installHint).includes('cli.moonbitlang.com'), byId.moonbit.installHint);
    assert.strictEqual(byId.html.installHint, null);

    assert.strictEqual(byId.html.kind, 'informational');
    assert.strictEqual(byId.html.present, false);
    assert.strictEqual(byId.html.version, null);
    assert.ok(String(byId.html.note).includes('无需安装'));

    assert.strictEqual(byId.nodejs.present, false);
    assert.strictEqual(byId.nodejs.version, null);

    // 可安装性预检：gcc 在 win32 有 winget curated 命令 → installable:true。
    assert.strictEqual(byId.gcc.installable, true);
  });

  test('非 win32 平台 winget 恒不可用', async () => {
    const snap = await inventory.scanInventory({
      deps: stubDeps(),
      platform: 'linux',
      writeSnapshot: false,
    });
    assert.strictEqual(snap.winget.present, false);
  });

  test('单项 probe 抛错按缺失聚合，盘点整体不抛', async () => {
    const deps = stubDeps();
    deps.probe = (depId) => {
      if (depId === 'gcc') {
        throw new Error('stub probe boom');
      }
      return { id: depId, present: false, kind: 'system-command', detail: null };
    };
    const snap = await inventory.scanInventory({ deps, platform: 'win32', writeSnapshot: false });
    const byId = Object.fromEntries(snap.entries.map((e) => [e.depId, e]));
    assert.strictEqual(byId.gcc.present, false);
    assert.strictEqual(snap.entries.length, inventory.DEV_ENV_CATALOG.length);
  });
});

describe('快照落点与原子写（临时数据家）', () => {
  test('getSnapshotPath 落在 T1-domains/tools/env 下', () => {
    const p = inventory.getSnapshotPath();
    assert.ok(p.includes(path.join('T1-domains', 'tools', 'env', 'scan-latest.json')));
  });

  test('scanInventory 默认写快照，loadLatestSnapshot 可回读；损坏文件返回 null', async () => {
    const snap = await inventory.scanInventory({ deps: stubDeps({ go: true }, { go: '1.22.1' }), platform: 'win32' });
    assert.strictEqual(snap._snapshotWritten, true);

    const loaded = inventory.loadLatestSnapshot();
    assert.ok(loaded);
    assert.strictEqual(loaded.platform, 'win32');
    const go = loaded.entries.find((e) => e.depId === 'go');
    assert.strictEqual(go.version, '1.22.1');

    // 损坏 → 诚实返回 null，不抛。
    fs.writeFileSync(inventory.getSnapshotPath(), '{corrupt', 'utf8');
    assert.strictEqual(inventory.loadLatestSnapshot(), null);
  });

  test('原子写失败 fail-soft（目录不可写不抛）', () => {
    const bogus = path.join(TMP_HOME, 'no-such-dir', 'x', 'file.json');
    assert.strictEqual(inventory._internal._writeJsonAtomic(bogus, { a: 1 }), false);
  });
});

describe('summarizeInventory', () => {
  test('四态计数', async () => {
    const snap = await inventory.scanInventory({
      deps: stubDeps({ python3: true, openjdk: true, moonbit: true }),
      platform: 'win32',
      writeSnapshot: false,
    });
    const counts = inventory.summarizeInventory(snap);
    assert.strictEqual(counts.total, inventory.DEV_ENV_CATALOG.length);
    assert.strictEqual(counts.present, 2);
    assert.strictEqual(counts.manual, 1);
    assert.strictEqual(counts.informational, 2);
    assert.strictEqual(counts.missing, counts.total - counts.present - counts.manual - counts.informational);
  });
});
