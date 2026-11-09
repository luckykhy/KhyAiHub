'use strict';

/**
 * Co-located tests for versionProbe.js — depId → 已装版本探针。
 * 全部走注入桩，零网络零真实子进程（真实探测由人工在实机跑 `khy devenv scan`）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const versionProbe = require('./versionProbe');

/** 组装一个按 bin 顺序应答的桩 runner。map: bin → {ok, stdout, stderr} | 'throw' */
function stubRunner(map) {
  const calls = [];
  const runner = async (bin, args) => {
    calls.push({ bin, args });
    const spec = map[bin];
    if (spec === 'throw') {
      throw new Error('stub throw');
    }
    if (!spec) {
      return { ok: false, stdout: '', stderr: 'stub ENOENT' };
    }
    return { ok: spec.ok !== false, stdout: spec.stdout || '', stderr: spec.stderr || '' };
  };
  runner.calls = calls;
  return runner;
}

describe('probeVersion 基本语义', () => {
  test('未收录 depId 返回全空，绝不抛', async () => {
    const r = await versionProbe.probeVersion('no-such-dep');
    assert.deepStrictEqual(r, { version: null, raw: '', binUsed: null });
  });

  test('多候选逐个试，首中即返（python3 在 win32 只有 python/py 的形态）', async () => {
    const runner = stubRunner({
      python: { ok: true, stdout: 'Python 3.12.7\n' },
    });
    const r = await versionProbe.probeVersion('python3', { runner, platform: 'win32' });
    assert.strictEqual(r.version, '3.12.7');
    assert.strictEqual(r.binUsed, 'python');
    // python3 桩未命中（ENOENT）→ 先试 python3 再 python，命中即停，不试 py。
    assert.deepStrictEqual(runner.calls.map((c) => c.bin), ['python3', 'python']);
  });

  test('解析先例：node v 前缀 / tsc Version / javac / gcc 首个 semver', async () => {
    const cases = [
      ['nodejs', { node: { ok: true, stdout: 'v20.11.0\n' } }, '20.11.0'],
      ['typescript', { tsc: { ok: true, stdout: 'Version 5.6.3\n' } }, '5.6.3'],
      ['openjdk', { javac: { ok: true, stdout: 'javac 21.0.5\n' } }, '21.0.5'],
      [
        'gcc',
        { gcc: { ok: true, stdout: 'gcc (MinGW-W64 x86_64-posix-seh) 13.2.0\nCopyright\n' } },
        '13.2.0',
      ],
      ['go', { go: { ok: true, stdout: 'go version go1.22.1 windows/amd64\n' } }, '1.22.1'],
    ];
    for (const [depId, map, expected] of cases) {
      const r = await versionProbe.probeVersion(depId, { runner: stubRunner(map) });
      assert.strictEqual(r.version, expected, depId);
    }
  });

  test('runner 抛错视为该 bin 未命中，继续下一候选', async () => {
    const runner = stubRunner({ python3: 'throw', python: { ok: true, stdout: 'Python 3.11.9\n' } });
    const r = await versionProbe.probeVersion('python3', { runner });
    assert.strictEqual(r.version, '3.11.9');
    assert.strictEqual(r.binUsed, 'python');
  });

  test('全部候选未命中 → version=null 且不抛', async () => {
    const r = await versionProbe.probeVersion('gcc', { runner: stubRunner({}) });
    assert.strictEqual(r.version, null);
    assert.strictEqual(r.binUsed, null);
    assert.strictEqual(r.raw, '');
  });

  test('命令成功但解析不出版本 → version=null，raw 保留原文', async () => {
    const runner = stubRunner({ dotnet: { ok: true, stdout: 'weird output\n' } });
    const r = await versionProbe.probeVersion('dotnet', { runner });
    assert.strictEqual(r.version, null);
    assert.strictEqual(r.raw, 'weird output');
    assert.strictEqual(r.binUsed, 'dotnet');
  });

  test('注入缝：opts.platform 透传给 runner（真实执行器 _realRunner 同签名消费）', async () => {
    const seen = [];
    const runner = async (bin, args, opts) => {
      seen.push(opts);
      return { ok: true, stdout: 'v1.2.3\n' };
    };
    await versionProbe.probeVersion('nodejs', { runner, platform: 'linux' });
    assert.strictEqual(seen[0].platform, 'linux');
    // 缺省时传 process.platform（probeVersion 侧已兜底）。
    await versionProbe.probeVersion('nodejs', { runner });
    assert.strictEqual(seen[1].platform, process.platform);
  });
});

describe('win32 .cmd 垫片解析', () => {
  test('win32 经 cmd.exe /d /s /c 调用（tsc/moon 是 npm 全局 shim）', () => {
    const inv = versionProbe._internal._buildInvocation('tsc', ['--version'], 'win32');
    assert.strictEqual(inv.exe, process.env.COMSPEC || 'cmd.exe');
    assert.deepStrictEqual(inv.args, ['/d', '/s', '/c', 'tsc', '--version']);
  });

  test('POSIX 直跑 bin，不引入 shell', () => {
    const inv = versionProbe._internal._buildInvocation('node', ['--version'], 'linux');
    assert.strictEqual(inv.exe, 'node');
    assert.deepStrictEqual(inv.args, ['--version']);
  });
});

describe('表完整性', () => {
  test('盘点目录里非 informational 的 depId 都有版本探针', () => {
    const inventory = require('./inventory');
    for (const entry of inventory.DEV_ENV_CATALOG) {
      if (entry.kind === 'informational') {
        continue;
      }
      assert.ok(
        versionProbe.VERSION_PROBES[entry.depId],
        `缺版本探针: ${entry.depId}`
      );
    }
  });

  test('listProbedDepIds 覆盖 moonbit 与 wabt（盘点点名语言）', () => {
    const ids = versionProbe.listProbedDepIds();
    assert.ok(ids.includes('moonbit'));
    assert.ok(ids.includes('wabt'));
    assert.ok(ids.includes('nodejs'));
  });
});
