'use strict';

/**
 * Co-located tests for manifestIo.js — 随身清单导出/导入。
 * 清单按不可信输入处理（只取 depId+version 两个 token）；manual 条目绝不产出
 * 安装计划是本文件的**核心安全断言**。全部注入桩，零网络零真实安装。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const manifestIo = require('./manifestIo');

const NOW = new Date('2026-11-07T08:30:00.000Z');

const DEFAULT_ENTRIES = [
  { depId: 'python3', language: 'python', state: 'present', version: '3.12.7' },
  { depId: 'openjdk', language: 'java', state: 'present', version: '17' },
  { depId: 'nodejs', language: 'javascript', state: 'missing', version: null },
  { depId: 'moonbit', language: 'moonbit', state: 'manual', version: null },
  { depId: 'html', language: 'html', state: 'informational', version: null },
];

/** 构造清单（entries 可整体替换，避免基础条目与测试条目重复）。 */
function sampleManifest(entries = DEFAULT_ENTRIES) {
  return {
    schemaVersion: 1,
    kind: 'khy-dev-env-manifest',
    exportedAt: NOW.toISOString(),
    platform: 'win32',
    khyVersion: '1.2.2',
    entries,
  };
}

/**
 * 有状态桩：installedSet 由 runInstall 写入，probe 据此报 presence——
 * 模拟「装完 probe 就绪/仍探不到」两种终态。
 */
function stubOpts({ installedSet = null, installFails = false, extra = {} } = {}) {
  const installed = installedSet || new Set();
  return {
    probe: (depId) => ({ id: depId, present: installed.has(depId), kind: 'system-command', detail: null }),
    probeVersion: async (depId) => ({
      version: installed.has(depId) ? `stub-${depId}` : null,
      raw: '',
      binUsed: null,
    }),
    runInstall: async (p) => {
      if (installFails) {
        return { ok: false, error: 'exit-nonzero', steps: [], command: p.displayCommand };
      }
      installed.add(p.depId);
      return { ok: true, steps: [], command: p.displayCommand };
    },
    env: { platform: 'win32', searchExecutable: () => null, cwd: process.cwd() },
    platform: 'win32',
    ...extra,
  };
}

describe('buildManifest（导出）', () => {
  test('四态映射正确，version 只在 present 时携带', () => {
    const snapshot = {
      scannedAt: NOW.toISOString(),
      platform: 'win32',
      winget: { present: true, detail: 'winget.exe' },
      entries: [
        { depId: 'python3', language: 'python', kind: 'installable', present: true, version: '3.12.7' },
        { depId: 'openjdk', language: 'java', kind: 'installable', present: false, version: null },
        { depId: 'moonbit', language: 'moonbit', kind: 'manual', present: false, version: null },
        { depId: 'html', language: 'html', kind: 'informational', present: false, version: null },
      ],
    };
    const m = manifestIo.buildManifest(snapshot, { now: NOW });
    assert.strictEqual(m.schemaVersion, 1);
    assert.strictEqual(m.kind, 'khy-dev-env-manifest');
    assert.strictEqual(m.platform, 'win32');
    assert.strictEqual(m.exportedAt, NOW.toISOString());
    assert.deepStrictEqual(m.entries, [
      { depId: 'python3', language: 'python', state: 'present', version: '3.12.7' },
      { depId: 'openjdk', language: 'java', state: 'missing', version: null },
      { depId: 'moonbit', language: 'moonbit', state: 'manual', version: null },
      { depId: 'html', language: 'html', state: 'informational', version: null },
    ]);
  });

  test('无快照 → DEV_ENV_NO_INVENTORY', () => {
    assert.throws(() => manifestIo.buildManifest(null), (e) => e.code === 'DEV_ENV_NO_INVENTORY');
  });
});

describe('_normalizeManifest（不可信输入校验）', () => {
  test('结构不对 → DEV_ENV_MANIFEST_INVALID', () => {
    for (const bad of [
      null,
      'str',
      42,
      [],
      { kind: 'other', schemaVersion: 1, entries: [] },
      { kind: 'khy-dev-env-manifest', schemaVersion: 2, entries: [] },
      { kind: 'khy-dev-env-manifest', schemaVersion: 1 },
    ]) {
      assert.throws(
        () => manifestIo._internal._normalizeManifest(bad),
        (e) => e.code === 'DEV_ENV_MANIFEST_INVALID'
      );
    }
  });

  test('未知 depId 进 unknown，不进安装列表；未知 state 按 missing 处理（fail-safe）', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([
        { depId: 'evil-tool', state: 'present', version: null },
        { depId: 'gcc', state: 'yolo', version: null },
      ]),
      stubOpts()
    );
    assert.ok(plan.unknown.includes('evil-tool'));
    assert.ok(!plan.toInstall.some((i) => i.depId === 'evil-tool'));
    assert.ok(plan.skipped.find((s) => s.depId === 'gcc'));
  });

  test('informational 目录项（html，无 registry 条目）被认回，进 skipped 不进 unknown', async () => {
    const plan = await manifestIo.previewImport(sampleManifest(), stubOpts());
    assert.ok(plan.skipped.find((s) => s.depId === 'html' && s.reason.includes('informational')));
    assert.deepStrictEqual(plan.unknown, []);
  });

  test('文件里的命令/路径字段被丢弃，绝不进入执行计划', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'gcc', state: 'present', version: null, command: 'rm -rf /', url: 'http://evil.example' }]),
      stubOpts()
    );
    const item = plan.toInstall.find((i) => i.depId === 'gcc');
    assert.ok(item);
    assert.ok(!item.command.includes('rm -rf'), item.command);
    assert.ok(item.command.startsWith('winget install'), item.command);
  });
});

describe('previewImport（导入预览）', () => {
  test('四段齐全：将安装/跳过/手动/拒绝', async () => {
    const plan = await manifestIo.previewImport(sampleManifest(), stubOpts());
    assert.deepStrictEqual(plan.toInstall.map((i) => i.depId).sort(), ['openjdk', 'python3']);
    assert.ok(plan.skipped.find((s) => s.depId === 'nodejs' && s.reason.includes('清单来源机器')));
    assert.ok(plan.skipped.find((s) => s.depId === 'html' && s.reason.includes('informational')));
    assert.strictEqual(plan.manual.length, 1);
    assert.strictEqual(plan.manual[0].depId, 'moonbit');
    assert.ok(plan.manual[0].installHint.includes('cli.moonbitlang.com'));
    assert.deepStrictEqual(plan.unknown, []);
  });

  test('★ 核心安全断言：manual 条目永不产出 command 字段/安装计划', async () => {
    const plan = await manifestIo.previewImport(sampleManifest(), stubOpts());
    // manual 段只有 installHint，绝无 command。
    for (const m of plan.manual) {
      assert.strictEqual(m.command, undefined);
    }
    // toInstall 里也绝无 manual depId。
    assert.ok(!plan.toInstall.some((i) => i.depId === 'moonbit'));
  });

  test('state=present 的 manual 条目（被人改过的清单）也被闸拦下，进 manual 段', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'moonbit', language: 'moonbit', state: 'present', version: null }]),
      stubOpts()
    );
    assert.ok(!plan.toInstall.some((i) => i.depId === 'moonbit'));
    assert.ok(plan.manual.find((m) => m.depId === 'moonbit'));
  });

  test('白名单内版本照用：openjdk@17 → Temurin.17 curated 命令', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'openjdk', language: 'java', state: 'present', version: '17' }]),
      stubOpts()
    );
    const jdk = plan.toInstall.find((i) => i.depId === 'openjdk');
    assert.strictEqual(jdk.version, '17');
    assert.ok(jdk.command.includes('EclipseAdoptium.Temurin.17.JDK'), jdk.command);
    assert.strictEqual(jdk.note, null);
  });

  test('白名单外版本退默认并在 note 如实标注（3.12.7 → 3.12）', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'python3', language: 'python', state: 'present', version: '3.12.7' }]),
      stubOpts()
    );
    const py = plan.toInstall.find((i) => i.depId === 'python3');
    assert.strictEqual(py.version, '3.12');
    assert.ok(String(py.note).includes('3.12.7'), py.note);
    assert.ok(String(py.note).includes('3.12'), py.note);
  });

  test('清单版本 null → 默认版本，note 标注', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'openjdk', language: 'java', state: 'present', version: null }]),
      stubOpts()
    );
    const jdk = plan.toInstall.find((i) => i.depId === 'openjdk');
    assert.strictEqual(jdk.version, '21');
    assert.ok(String(jdk.note).includes('默认 21'), jdk.note);
  });

  test('非版本可选工具链忽略 version 请求', async () => {
    const plan = await manifestIo.previewImport(
      sampleManifest([{ depId: 'gcc', language: 'c', state: 'present', version: '99.9' }]),
      stubOpts()
    );
    const gcc = plan.toInstall.find((i) => i.depId === 'gcc');
    assert.strictEqual(gcc.version, null);
    assert.ok(String(gcc.note).includes('不按版本安装'), gcc.note);
  });

  test('本机已装 → skipped 带版本', async () => {
    const installed = new Set(['python3']);
    const plan = await manifestIo.previewImport(
      sampleManifest(),
      stubOpts({ installedSet: installed })
    );
    const py = plan.skipped.find((s) => s.depId === 'python3');
    assert.ok(py, '本机已装项应在 skipped');
    assert.ok(!plan.toInstall.some((i) => i.depId === 'python3'));
  });
});

describe('applyImport（导入执行）', () => {
  test('顺序安装 + 装后复验通过 + 进度上报', async () => {
    const progress = [];
    const installedSet = new Set();
    const plan = await manifestIo.applyImport(
      sampleManifest([{ depId: 'python3', state: 'present', version: '3.12' }, { depId: 'openjdk', state: 'present', version: '17' }]),
      stubOpts({ installedSet, extra: { onProgress: (info) => progress.push(info) } })
    );
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.state, 'succeeded');
    assert.strictEqual(plan.succeeded, 2);
    assert.strictEqual(plan.failed, 0);
    assert.strictEqual(plan.results.every((r) => r.ok && r.verified), true);
    assert.strictEqual(progress.length, 2);
    assert.match(progress[0].label, /正在安装 /);
    assert.match(progress[0].label, /第 1\/2 项/);
    assert.match(progress[1].label, /第 2\/2 项/);
  });

  test('★ manual 条目绝不执行：置 skipped(DEV_ENV_MANUAL_ONLY)，不出现在 results/installed', async () => {
    const installed = new Set();
    const plan = await manifestIo.applyImport(
      sampleManifest(),
      stubOpts({ installedSet: installed })
    );
    assert.ok(!installed.has('moonbit'), '绝不执行 script 形态计划');
    assert.ok(!plan.results.some((r) => r.depId === 'moonbit'));
    // 契约要求 manual 条目在执行结果里可见（置 skipped），不能整条丢掉。
    const skippedMoon = plan.skipped.find((s) => s.depId === 'moonbit');
    assert.ok(skippedMoon, 'manual 条目应并入 skipped');
    assert.ok(skippedMoon.reason.includes('DEV_ENV_MANUAL_ONLY'), skippedMoon.reason);
    assert.ok(skippedMoon.reason.includes('cli.moonbitlang.com'), skippedMoon.reason);
  });

  test('装了但探不到 → failed + verified:false（绝不静默当好）', async () => {
    // installFails=false 会写入 installedSet；这里要「命令 ok 但 probe 始终探不到」，
    // 故 runInstall 不写 set（独立桩）。
    const plan = await manifestIo.applyImport(
      sampleManifest([{ depId: 'openjdk', state: 'present', version: '17' }]),
      stubOpts({
        extra: {
          runInstall: async (p) => ({ ok: true, steps: [], command: p.displayCommand }),
        },
      })
    );
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.state, 'failed');
    assert.strictEqual(plan.failed, 1);
    assert.strictEqual(plan.results[0].verified, false);
  });

  test('runInstall 失败 → failed + 错误码透传，逐项继续不阻断', async () => {
    const plan = await manifestIo.applyImport(
      sampleManifest([{ depId: 'python3', state: 'present', version: '3.12' }, { depId: 'openjdk', state: 'present', version: '17' }]),
      stubOpts({ installFails: true })
    );
    assert.strictEqual(plan.state, 'failed');
    assert.strictEqual(plan.succeeded, 0);
    assert.strictEqual(plan.results.every((r) => !r.ok && r.error === 'exit-nonzero'), true);
  });
});
