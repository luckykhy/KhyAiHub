'use strict';

/**
 * Co-located tests for toolchainVersions.js — the pure (depId, version, platform) →
 * curated argv matrix. Zero IO, deterministic, documented as never-throwing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const tv = require('./toolchainVersions');

describe('isEnabled gate', () => {
  test('默认开，缺失/空串视为未设置', () => {
    assert.strictEqual(tv.isEnabled({}), true);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: undefined }), true);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: null }), true);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: '' }), true);
    assert.strictEqual(tv.isEnabled(), true);
  });

  test('关闭词表命中才关，大小写/空白不敏感', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: off }), false, off);
      assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: `  ${off.toUpperCase()}  ` }), false, off);
    }
  });

  test('非关闭词一律视为开', () => {
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: 'anything' }), true);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: '1' }), true);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: 'ON' }), true);
  });

  test('数字 0 与布尔 false 经 String 强转后命中关闭词', () => {
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: 0 }), false);
    assert.strictEqual(tv.isEnabled({ KHY_DEP_VERSIONS: false }), false);
  });
});

describe('resolveDepId', () => {
  test('canonical 与别名归一到 depId', () => {
    assert.strictEqual(tv.resolveDepId('openjdk'), 'openjdk');
    assert.strictEqual(tv.resolveDepId('JDK'), 'openjdk');
    assert.strictEqual(tv.resolveDepId(' java '), 'openjdk');
    assert.strictEqual(tv.resolveDepId('py'), 'python3');
    assert.strictEqual(tv.resolveDepId('.NET'), 'dotnet');
  });

  test('未知名小写原样返回，空输入返回空串', () => {
    assert.strictEqual(tv.resolveDepId('Foobar'), 'foobar');
    assert.strictEqual(tv.resolveDepId(''), '');
    assert.strictEqual(tv.resolveDepId('   '), '');
    assert.strictEqual(tv.resolveDepId(null), '');
    assert.strictEqual(tv.resolveDepId(undefined), '');
    assert.strictEqual(tv.resolveDepId(0), '');
  });
});

describe('parseDepSpec', () => {
  test('拆出 depId 与版本，别名先归一', () => {
    assert.deepStrictEqual(tv.parseDepSpec('openjdk@17'), { depId: 'openjdk', version: '17' });
    assert.deepStrictEqual(tv.parseDepSpec('jdk@8'), { depId: 'openjdk', version: '8' });
    assert.deepStrictEqual(tv.parseDepSpec('python3'), { depId: 'python3', version: null });
    assert.deepStrictEqual(tv.parseDepSpec('dotnet@6'), { depId: 'dotnet', version: '6' });
  });

  test('空版本串归 null，无 @ 时 version 为 null', () => {
    assert.deepStrictEqual(tv.parseDepSpec('openjdk@'), { depId: 'openjdk', version: null });
    assert.deepStrictEqual(tv.parseDepSpec('openjdk@   '), { depId: 'openjdk', version: null });
    assert.deepStrictEqual(tv.parseDepSpec(''), { depId: '', version: null });
    assert.deepStrictEqual(tv.parseDepSpec(null), { depId: '', version: null });
    assert.deepStrictEqual(tv.parseDepSpec(undefined), { depId: '', version: null });
  });
});

describe('isVersionable / supportedVersions / defaultVersion', () => {
  test('版本可选的工具链返回真与版本列表', () => {
    assert.strictEqual(tv.isVersionable('openjdk'), true);
    assert.strictEqual(tv.isVersionable('jdk'), true);
    assert.strictEqual(tv.isVersionable('ffmpeg'), false);
    assert.deepStrictEqual(tv.supportedVersions('openjdk'), ['8', '11', '17', '21']);
    assert.strictEqual(tv.defaultVersion('openjdk'), '21');
    assert.strictEqual(tv.defaultVersion('python3'), '3.12');
  });

  test('非版本可选返回空列表与 null 默认，绝不抛', () => {
    assert.deepStrictEqual(tv.supportedVersions('ffmpeg'), []);
    assert.strictEqual(tv.defaultVersion('ffmpeg'), null);
    assert.deepStrictEqual(tv.supportedVersions(''), []);
    assert.strictEqual(tv.defaultVersion(null), null);
  });

  test('KNOWN-DEFECT: supportedVersions("constructor") 命中原型链并抛错，违背「绝不抛」契约', () => {
    // toolchainVersions.js:169-175 — MATRIX 是对象字面量，MATRIX['constructor'] 取到
    // Object.prototype.constructor（truthy 函数），entry.versions 为 undefined，
    // Object.keys(undefined) 抛 TypeError。文件头承诺「纯叶子:零 IO、确定性、绝不抛」。
    assert.throws(() => tv.supportedVersions('constructor'), TypeError);
  });

  test('KNOWN-DEFECT: isVersionable("constructor") 因原型链误报为 true', () => {
    // toolchainVersions.js:164 — !!MATRIX[resolveDepId('constructor')]，而 resolveDepId
    // 又把 'constructor'（Object.prototype 上的小写键）原样返回，故误判为版本可选。
    assert.strictEqual(tv.isVersionable('constructor'), true);
  });
});

describe('listVersionable / describeVersions', () => {
  test('listVersionable 返回三条工具链的快照', () => {
    const list = tv.listVersionable();
    assert.deepStrictEqual(list.map((x) => x.depId), ['openjdk', 'python3', 'dotnet']);
    const jdk = list[0];
    assert.deepStrictEqual(jdk.aliases, ['jdk', 'java', 'javac', 'openjdk']);
    assert.strictEqual(jdk.default, '21');
    // 别名数组是 slice 拷贝，改写不得污染 MATRIX 原表。
    jdk.aliases.push('INJECTED');
    assert.strictEqual(tv.MATRIX.openjdk.aliases.length, 4);
  });

  test('describeVersions 汇成 gate/enabled/toolchains 快照', () => {
    const d = tv.describeVersions();
    assert.strictEqual(d.gate, 'KHY_DEP_VERSIONS');
    assert.strictEqual(typeof d.enabled, 'boolean');
    assert.strictEqual(d.toolchains.length, 3);
    assert.ok(typeof d.note === 'string' && d.note.length > 0);
  });
});

describe('resolveVersionedCommand', () => {
  test('按平台解析出 curated argv', () => {
    assert.deepStrictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: {} }),
      ['apt-get', 'install', '-y', 'openjdk-17-jdk'],
    );
    assert.deepStrictEqual(
      tv.resolveVersionedCommand({ depId: 'jdk', version: '8', platform: 'win32', env: {} }),
      ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.8.JDK', '-e'],
    );
  });

  test('返回的是防御性拷贝，改写不污染原表', () => {
    const argv = tv.resolveVersionedCommand({ depId: 'python3', version: '3.11', platform: 'darwin', env: {} });
    assert.deepStrictEqual(argv, ['brew', 'install', 'python@3.11']);
    argv.push('INJECTED');
    assert.strictEqual(tv.MATRIX.python3.versions['3.11'].darwin.length, 3);
  });

  test('dotnet 缺 darwin 平台键时诚实返回 null', () => {
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'dotnet', version: '6', platform: 'darwin', env: {} }),
      null,
    );
  });

  test('门控关 / 非法版本 / 空版本 / 非版本可选 一律 null', () => {
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: { KHY_DEP_VERSIONS: 'off' } }),
      null,
    );
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: '999', platform: 'linux', env: {} }),
      null,
    );
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: '', platform: 'linux', env: {} }),
      null,
    );
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: null, platform: 'linux', env: {} }),
      null,
    );
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'ffmpeg', version: '1', platform: 'linux', env: {} }),
      null,
    );
  });

  test('外来字符串永不拼入命令（白名单之外的版本直接 null）', () => {
    assert.strictEqual(
      tv.resolveVersionedCommand({ depId: 'openjdk', version: '; rm -rf /', platform: 'linux', env: {} }),
      null,
    );
    assert.strictEqual(tv.resolveVersionedCommand({}, null), null);
    assert.strictEqual(tv.resolveVersionedCommand(), null);
  });

  test('KNOWN-DEFECT: resolveVersionedCommand({depId:"constructor"}) 抛错，违背「绝不抛」契约', () => {
    // toolchainVersions.js:223 — entry = MATRIX['constructor'] 是原型链上的函数，
    // entry.versions 为 undefined，hasOwnProperty.call(undefined, ...) 抛 TypeError。
    // 头注释（resolver/toolchainVersions 一致红线）承诺「绝不抛」。
    assert.throws(
      () => tv.resolveVersionedCommand({ depId: 'constructor', version: '21', platform: 'linux', env: {} }),
      TypeError,
    );
  });
});
