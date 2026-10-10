'use strict';

/**
 * envFingerprint.test.js — 钉死环境指纹契约：探针列表/超时的 env 解析、capture 的字段形状与
 * 全 total（缺工具→null、缺 manifest→null、绝不抛）、compare 的叶子级 diff 语义。
 *
 * 实测更正（与直觉注释不同的两处，均如实钉住）：
 * ① compare 会把 capturedAt 之外的「单侧缺失键(undefined) vs null」判为分歧，
 *    且 diff 条目两侧都显示 null（envFingerprint.js:127-128，潜在缺陷，已报）。
 * ② _probeTools 对纯逗号/空白 env 值回退默认 ['node']（filter(Boolean) 后长度 0）。
 * 探针 spawn 仅允许 'node'（本运行时）；其余 capture 测试用不存在的工具名（spawn 立即 ENOENT）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('./envFingerprint');
const artifactHash = require('./artifactHash');

const GHOST_TOOL = '__khy_test_missing_tool_zz9__';

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

test('导出恰为 capture/compare/两探针解析器/两默认常量共 6 个符号', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'DEFAULT_PROBE_TIMEOUT_MS',
    'DEFAULT_PROBE_TOOLS',
    '_probeTimeoutMs',
    '_probeTools',
    'capture',
    'compare',
  ]);
  assert.strictEqual(mod.DEFAULT_PROBE_TOOLS, 'node');
  assert.strictEqual(mod.DEFAULT_PROBE_TIMEOUT_MS, 3000);
});

test('_probeTools 未设 env 时回退默认单元素列表 node', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', undefined, () => {
    assert.deepStrictEqual(mod._probeTools(), ['node']);
  });
});

test('_probeTools 同时按逗号与空白切分并去空', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', 'node, git  python', () => {
    assert.deepStrictEqual(mod._probeTools(), ['node', 'git', 'python']);
  });
});

test('_probeTools 对空白串与纯逗号 env 值都回退默认 node', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', '   ', () => {
    assert.deepStrictEqual(mod._probeTools(), ['node']);
  });
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', ',,', () => {
    assert.deepStrictEqual(mod._probeTools(), ['node']);
  });
});

test('_probeTimeoutMs 接受正整数 env 覆盖', () => {
  withEnv('KHY_REPLAY_PROBE_TIMEOUT_MS', '500', () => {
    assert.strictEqual(mod._probeTimeoutMs(), 500);
  });
});

test('_probeTimeoutMs 对 0/负数/非数字 env 一律回退 3000', () => {
  for (const v of ['0', '-3', 'abc', '']) {
    withEnv('KHY_REPLAY_PROBE_TIMEOUT_MS', v, () => {
      assert.strictEqual(mod._probeTimeoutMs(), 3000, `env=${JSON.stringify(v)}`);
    });
  }
});

test('capture 返回恰含 os/node/cwd/toolchain/manifestHash/capturedAt 六字段', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', GHOST_TOOL, () => {
    const cap = mod.capture();
    assert.deepStrictEqual(Object.keys(cap), ['os', 'node', 'cwd', 'toolchain', 'manifestHash', 'capturedAt']);
    assert.strictEqual(typeof cap.capturedAt, 'number');
  });
});

test('capture 的 os 字段与 os 模块当前读数逐项一致', () => {
  const cap = mod.capture();
  assert.deepStrictEqual(cap.os, { platform: os.platform(), release: os.release(), arch: os.arch() });
  assert.ok(cap.os.platform); // 反空转：当前主机平台必须非空
});

test('capture 的 node 字段即 process.version', () => {
  assert.strictEqual(mod.capture().node, process.version);
});

test('capture 的 cwd 默认取 process.cwd，opts.cwd 覆盖并强转字符串', () => {
  assert.strictEqual(mod.capture().cwd, process.cwd());
  assert.strictEqual(mod.capture({ cwd: '/synthetic/cwd' }).cwd, '/synthetic/cwd');
  assert.strictEqual(mod.capture({ cwd: 123 }).cwd, '123');
  assert.strictEqual(mod.capture({ cwd: null }).cwd, process.cwd());
});

test('capture 对缺失工具在 toolchain 里落 null 值但键保留（探针列表非空）', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', GHOST_TOOL, () => {
    const cap = mod.capture();
    assert.deepStrictEqual(cap.toolchain, { [GHOST_TOOL]: null });
    assert.ok(Object.keys(cap.toolchain).length > 0);
  });
});

test('capture 默认探针 node 得到 v 开头的版本首行', () => {
  withEnv('KHY_REPLAY_FINGERPRINT_TOOLS', undefined, () => {
    const cap = mod.capture();
    assert.strictEqual(typeof cap.toolchain.node, 'string');
    assert.match(cap.toolchain.node, /^v\d+/);
    assert.ok(!cap.toolchain.node.includes('\n'));
  });
});

test('capture 对 manifestPath 哈希文件字节，与 artifactHash.hashFile 完全一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-envfp-'));
  try {
    const f = path.join(dir, 'package.json');
    fs.writeFileSync(f, '{"name":"fixture"}');
    const cap = mod.capture({ manifestPath: f });
    assert.strictEqual(cap.manifestHash, artifactHash.hashFile(f));
    assert.match(cap.manifestHash, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture 对不存在的 manifestPath 返回 null 不抛；缺省 opts 也为 null', () => {
  assert.strictEqual(mod.capture({ manifestPath: 'Z:/no/such/manifest.json' }).manifestHash, null);
  assert.strictEqual(mod.capture().manifestHash, null);
});

test('compare 忽略 capturedAt：仅时间戳不同也算 match', () => {
  const a = { node: 'v1', capturedAt: 100 };
  const b = { node: 'v1', capturedAt: 999 };
  assert.deepStrictEqual(mod.compare(a, b), { match: true, diffs: [] });
});

test('compare 对相同对象返回 match 且 diffs 为空数组', () => {
  const f = { os: { platform: 'x' }, node: 'v1', cwd: '/p', toolchain: { node: 'v1' }, manifestHash: null };
  assert.deepStrictEqual(mod.compare(f, JSON.parse(JSON.stringify(f))), { match: true, diffs: [] });
});

test('compare 顶层字段分歧报字段名与两侧值', () => {
  const r = mod.compare({ node: 'v1' }, { node: 'v2' });
  assert.strictEqual(r.match, false);
  assert.deepStrictEqual(r.diffs, [{ field: 'node', recorded: 'v1', current: 'v2' }]);
});

test('compare 嵌套对象逐叶子展开为点路径 toolchain.node', () => {
  const r = mod.compare({ toolchain: { node: 'v1' } }, { toolchain: { node: 'v9' } });
  assert.deepStrictEqual(r.diffs, [{ field: 'toolchain.node', recorded: 'v1', current: 'v9' }]);
});

test('compare 把数组当可遍历对象：按下标报 arr.1', () => {
  const r = mod.compare({ arr: [1, 2] }, { arr: [1, 3] });
  assert.deepStrictEqual(r.diffs, [{ field: 'arr.1', recorded: 2, current: 3 }]);
});

test('compare 单侧新增键计为分歧，缺失侧以 null 呈现', () => {
  const r = mod.compare({ a: 1 }, { a: 1, extra: 'e' });
  assert.deepStrictEqual(r.diffs, [{ field: 'extra', recorded: null, current: 'e' }]);
});

test('compare 对 null/undefined/空对象入参 total：双侧空即 match', () => {
  assert.deepStrictEqual(mod.compare(null, null), { match: true, diffs: [] });
  assert.deepStrictEqual(mod.compare(), { match: true, diffs: [] });
  assert.deepStrictEqual(mod.compare(undefined, undefined), { match: true, diffs: [] });
});

test('compare 一侧为空对象时逐字段列出分歧，其中 null vs undefined 也算分歧且两侧都显示 null（实测缺陷行为）', () => {
  // 现状钉死：JSON.stringify(undefined)!==JSON.stringify(null)，但 diff 展示层把 undefined 归一成 null，
  // 产生 "recorded:null current:null" 这种看不出病因的条目。
  const r = mod.compare({}, { manifestHash: null, node: 'v1' });
  assert.strictEqual(r.match, false);
  const mf = r.diffs.find((d) => d.field === 'manifestHash');
  assert.deepStrictEqual(mf, { field: 'manifestHash', recorded: null, current: null });
  assert.ok(r.diffs.length > 0);
});
