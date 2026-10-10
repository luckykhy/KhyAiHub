'use strict';

// Co-located tests for manifestLoader.js. Pure validation logic + a couple of
// tmp-file reads/writes; nothing is spawned and no repo path is written.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const ml = require('./manifestLoader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-manifest-'));
const ENV_KEY = 'KHY_RESOURCE_MANIFEST';
const origEnv = process.env[ENV_KEY];

after(() => {
  if (origEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = origEnv;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

const SHA_A = 'a'.repeat(64);

function variant(over = {}) {
  return { sources: ['https://example.org/a.zip'], sha256: SHA_A, format: 'zip', sentinel: 'pkg/SENTINEL', ...over };
}

function manifest(over = {}) {
  return {
    schemaVersion: 1,
    resources: [{ id: 'tool-a', kind: 'tool', version: '1.0.0', platforms: { 'linux-x64': variant() }, ...over }],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'resources' && k !== 'id' && k !== 'kind' && k !== 'version' && k !== 'platforms')),
  };
}

function resourceItem(over = {}) {
  return { id: 'tool-a', kind: 'tool', version: '1.0.0', platforms: { 'linux-x64': variant() }, ...over };
}

describe('defaultManifestPath', () => {
  test('无 env 时返回 __dirname 三级上溯的 config/resources.json 绝对路径', () => {
    delete process.env[ENV_KEY];
    const p = ml.defaultManifestPath();
    assert.ok(path.isAbsolute(p));
    assert.equal(p, path.resolve(__dirname, '..', '..', '..', 'config', 'resources.json'));
  });

  test('env 覆盖时被 resolve 为绝对路径', () => {
    process.env[ENV_KEY] = path.join(tmp, 'custom.json');
    assert.equal(ml.defaultManifestPath(), path.join(tmp, 'custom.json'));
    delete process.env[ENV_KEY];
  });
});

describe('assertRelativePath', () => {
  test('正常相对路径通过；null/空串/绝对路径/非字符串抛错', () => {
    assert.doesNotThrow(() => ml.assertRelativePath('runtime/bin.exe', 'x'));
    assert.throws(() => ml.assertRelativePath(null, 'x'), /x must be a non-empty relative path/);
    assert.throws(() => ml.assertRelativePath('', 'x'), /non-empty/);
    assert.throws(() => ml.assertRelativePath(123, 'x'), /non-empty/);
    assert.throws(() => ml.assertRelativePath('/abs/path', 'x'), /non-empty/);
    assert.throws(() => ml.assertRelativePath('C:\\abs\\path', 'x'), /non-empty/);
  });

  test('.. / 空段 / . 段（含反斜杠形态）被拒绝', () => {
    assert.throws(() => ml.assertRelativePath('a/../b', 'x'), /unsafe path segment/);
    assert.throws(() => ml.assertRelativePath('a\\..\\b', 'x'), /unsafe path segment/);
    assert.throws(() => ml.assertRelativePath('a//b', 'x'), /unsafe path segment/);
    assert.throws(() => ml.assertRelativePath('./a', 'x'), /unsafe path segment/);
    assert.throws(() => ml.assertRelativePath('a/./b', 'x'), /unsafe path segment/);
  });

  test('单独 . 仅在 allowDot=true 时放行', () => {
    ml.assertRelativePath('.', 'x', true);
    assert.throws(() => ml.assertRelativePath('.', 'x'), /unsafe path segment/);
  });
});

describe('validateManifest', () => {
  test('合法清单被规范化：默认值/小写 sha/canonical URL/数组拷贝', () => {
    const raw = {
      schemaVersion: 1,
      resources: [{
        id: 'tool-a', kind: 'tool', version: '1.0.0',
        platforms: { 'linux-x64': { sources: [{ url: 'https://EXAMPLE.org/a.zip' }], sha256: SHA_A.toUpperCase(), format: 'zip', sentinel: 'S', chmod: ['bin/x'], files: ['a.txt'] } },
      }],
    };
    const out = ml.validateManifest(raw);
    const v = out.resources[0].platforms['linux-x64'];
    assert.equal(out.channel, 'stable');
    assert.equal(out.resources[0].policy, 'manual');
    assert.equal(out.resources[0].description, '');
    assert.deepEqual(v.sources, ['https://example.org/a.zip']);
    assert.equal(v.sha256, SHA_A);
    assert.equal(v.size, null);
    assert.equal(v.sourceSubdir, '.');
    assert.notEqual(v.chmod, raw.resources[0].platforms['linux-x64'].chmod, 'chmod must be a copy, not the live input array');
    assert.deepEqual(v.files, ['a.txt']);
  });

  test('清单本体垃圾入参（null/undefined/数组/字符串/数字）统一报 manifest must be an object', () => {
    for (const bad of [null, undefined, [], 'str', 42, 0, NaN, true]) {
      assert.throws(() => ml.validateManifest(bad), /manifest must be an object/);
    }
  });

  test('schemaVersion 非 1（含 0/"1"）被拒绝', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 2, resources: [] }), /unsupported resource manifest schema: 2/);
    assert.throws(() => ml.validateManifest({ schemaVersion: '1', resources: [] }), /unsupported/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 0, resources: [] }), /unsupported resource manifest schema: 0/);
  });

  test('resources 非数组 / 条目非对象被拒绝', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: 'x' }), /manifest\.resources must be an array/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [null] }), /resources\[0\] must be an object/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [[]] }), /must be an object/);
  });

  test('KNOWN-DEFECT: 数字 id 经 String() 强转校验后按原类型保留，破坏后续 === 查找', () => {
    // manifestLoader.js:74 validates String(item.id) but line 84 stores item.id
    // as-is, so numeric id 42 passes yet never matches find(r => r.id === '42').
    const out = ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: 42 })] });
    assert.equal(out.resources[0].id, 42);
    assert.equal(typeof out.resources[0].id, 'number');
    assert.equal(out.resources.find((r) => r.id === '42'), undefined);
  });

  test('id 非法字符/空/超长(129) 被拒；重复 id 被拒', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: 'Abc' })] }), /id is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: '-x' })] }), /id is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: '' })] }), /id is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: 'a'.repeat(129) })] }), /id is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ id: 'a/../b' })] }), /id is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem(), resourceItem()] }), /duplicate resource id: tool-a/);
  });

  test('kind/version/policy/platforms 的非法值各报对应的字段错误', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ kind: 'game' })] }), /kind is invalid/);
    assert.doesNotThrow(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ kind: 'runtime' })] }));
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ version: '' })] }), /version is required/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ version: '   ' })] }), /version is required/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ version: 1 })] }), /version is required/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ policy: 'auto' })] }), /policy is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: [] })] }), /platforms must be an object/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: null })] }), /platforms must be an object/);
  });

  test('platforms 值允许 null（表示该平台无变体）', () => {
    const out = ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'win32-x64': null } })] });
    assert.equal(out.resources[0].platforms['win32-x64'], null);
  });

  test('变体非法标量与缺失/非法 sha/format 被拒', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': 'str' } })] }), /must be an object or null/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': 0 } })] }), /must be an object or null/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sha256: 'short' }) } })] }), /sha256 must be a 64-character/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sha256: '' }) } })] }), /sha256/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ format: 'rar' }) } })] }), /format is unsupported/);
  });

  test('sources 校验：非数组/空数组/http/垃圾/canonical 重复各自报错', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: [] }) } })] }), /must contain at least one HTTPS URL/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: 'https://a.com/x' }) } })] }), /at least one HTTPS URL/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: ['http://a.com/x'] }) } })] }), /must use HTTPS/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: ['notaurl'] }) } })] }), /is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: [5] }) } })] }), /is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: [null] }) } })] }), /is invalid/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sources: ['https://x.com/a', 'https://X.COM/a'] }) } })] }), /contains duplicates/);
  });

  test('size 边界：0 被保留为 0（不被 || 吞掉）；-1/1e30/abc 被拒', () => {
    const out = ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ size: 0 }) } })] });
    assert.equal(out.resources[0].platforms['linux-x64'].size, 0);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ size: -1 }) } })] }), /non-negative integer/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ size: 1e30 }) } })] }), /non-negative integer/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ size: 'abc' }) } })] }), /non-negative integer/);
  });

  test('非 file 格式必须给合法 sentinel；sourceSubdir 允许 . 但不允许穿越', () => {
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sentinel: undefined }) } })] }), /sentinel must be a non-empty relative path/);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sentinel: '../x' }) } })] }), /unsafe path segment/);
    assert.doesNotThrow(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sourceSubdir: '.' }) } })] }));
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ sourceSubdir: 'a/../b' }) } })] }), /unsafe path segment/);
  });

  test('KNOWN-DEFECT: format=file 时 sentinel 完全不校验，可携带 ../../ 穿越值通过验证', () => {
    // manifestLoader.js:52 — assertRelativePath(raw.sentinel) only runs when
    // format !== 'file'. Downstream (resourceManager.js:127) joins this value
    // into path.join(extracted, value.sentinel), so '../../evil' escapes the
    // staging/extract dir during install.
    const out = ml.validateManifest({
      schemaVersion: 1,
      resources: [resourceItem({ platforms: { 'linux-x64': { sources: ['https://x.com/a.bin'], sha256: SHA_A, format: 'file', sentinel: '../../../../evil/payload' } } })],
    });
    assert.equal(out.resources[0].platforms['linux-x64'].sentinel, '../../../../evil/payload');
  });

  test('KNOWN-DEFECT: chmod 传非数组时抛裸 TypeError 而非字段化校验错误', () => {
    // manifestLoader.js:54-55 — (raw.chmod || []).entries() on a number or a
    // string (strings have no .entries) throws TypeError, losing the
    // `resources[i].platforms.k.chmod[n]` labelling contract of this module.
    // Properly labelled errors from this module always start with
    // `resources[i].platforms.k...` (see normalizeVariant label plumbing);
    // the TypeError here carries only the raw JS engine message.
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ chmod: 123 }) } })] }), (err) => err instanceof TypeError && !err.message.startsWith('resources['));
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ files: 'ab' }) } })] }), (err) => err instanceof TypeError);
    assert.throws(() => ml.validateManifest({ schemaVersion: 1, resources: [resourceItem({ platforms: { 'linux-x64': variant({ chmod: { 0: 'x' } }) } })] }), TypeError);
  });

  test('KNOWN-DEFECT: 平台键 __proto__ 命中原型赋值，声明的变体被静默吞掉且 platforms 继承变体属性', () => {
    // manifestLoader.js:82-83 — platforms is a plain {} and assignment
    // platforms['__proto__'] = <variant object> triggers the inherited setter:
    // the prototype is replaced by the variant and the platform disappears
    // from own keys. A JSON manifest can smuggle a key that never loads.
    const raw = JSON.parse(`{"schemaVersion":1,"resources":[{"id":"tool-a","kind":"tool","version":"1","platforms":{"__proto__":{"sources":["https://x.com/a.zip"],"sha256":"${SHA_A}","format":"zip","sentinel":"S"}}}]}`);
    const out = ml.validateManifest(raw);
    const p = out.resources[0].platforms;
    assert.deepEqual(Object.keys(p), [], 'the declared variant is silently lost from own keys');
    assert.equal(Object.getPrototypeOf(p).sha256, SHA_A, 'variant object became the prototype');
    assert.ok(Array.isArray(p.sources), 'lookup of arbitrary key sources hits the prototype chain');
  });
});

describe('loadManifest / tryLoadManifest', () => {
  test('tmp 中的合法清单文件可加载并规范化', () => {
    const file = path.join(tmp, 'good.json');
    fs.writeFileSync(file, JSON.stringify(manifest()));
    const out = ml.loadManifest(file);
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.resources[0].id, 'tool-a');
  });

  test('显式自定义路径下的坏 JSON 直接抛出（不静默兜底）', () => {
    const file = path.join(tmp, 'bad.json');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => ml.loadManifest(file), SyntaxError);
    assert.throws(() => ml.loadManifest(path.join(tmp, 'missing.json')), (err) => err.code === 'ENOENT');
  });

  test('env 显式指向坏文件时 loadManifest 抛错而不是回退捆绑清单', () => {
    const file = path.join(tmp, 'bad2.json');
    fs.writeFileSync(file, '{"schemaVersion":9}');
    process.env[ENV_KEY] = file;
    assert.throws(() => ml.loadManifest(), /unsupported resource manifest schema: 9/);
    delete process.env[ENV_KEY];
  });

  test('默认路径（env 未设）经兜底 require 返回仓库捆绑清单', () => {
    delete process.env[ENV_KEY];
    const out = ml.loadManifest();
    assert.equal(out.schemaVersion, 1);
    assert.ok(Array.isArray(out.resources));
  });

  test('tryLoadManifest 恒不抛：成功带 ok:true，失败带 ok:false+错误文本', () => {
    const good = path.join(tmp, 't1.json');
    fs.writeFileSync(good, JSON.stringify(manifest()));
    const ok = ml.tryLoadManifest(good);
    assert.equal(ok.ok, true);
    assert.equal(ok.path, good);
    assert.equal(ok.error, null);
    const bad = ml.tryLoadManifest(path.join(tmp, 'nope.json'));
    assert.equal(bad.ok, false);
    assert.equal(bad.manifest, null);
    assert.match(bad.error, /ENOENT/);
  });
});
