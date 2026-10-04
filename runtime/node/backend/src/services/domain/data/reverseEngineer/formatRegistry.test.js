'use strict';

/**
 * formatRegistry.test.js — 制品格式单一真源的契约（零 IO、确定性）。
 *
 * 真源规范：DESIGN-ARCH-054 §3.1。本文件钉住的是「其余逆向模块只读这张表」所依赖的
 * 不变式：表非空、每条描述符形状齐、id 唯一、返回的是冻结副本、按 id 取值的回退顺序。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('./formatRegistry');

test('RECOVERABILITY 是冻结的五档枚举，取值对外稳定', () => {
  assert.deepStrictEqual(
    { ...registry.RECOVERABILITY },
    {
      SOURCE: 'source',
      BYTECODE: 'bytecode',
      NATIVE: 'native',
      ARCHIVE: 'archive',
      UNKNOWN: 'unknown',
    }
  );
  assert.strictEqual(Object.isFrozen(registry.RECOVERABILITY), true);
});

test('FORMATS 非空且每条描述符形状齐（防空转）', () => {
  assert.ok(registry.FORMATS.length >= 15, `实测 ${registry.FORMATS.length} 条顶层格式`);
  for (const f of registry.FORMATS) {
    assert.strictEqual(typeof f.id, 'string');
    assert.strictEqual(typeof f.label, 'string');
    assert.strictEqual(typeof f.family, 'string');
    assert.ok(
      Object.values(registry.RECOVERABILITY).includes(f.recoverability),
      `${f.id} 的 recoverability=${f.recoverability} 不在五档枚举内`
    );
    assert.ok(Array.isArray(f.signatures) && f.signatures.length > 0, `${f.id} 无签名`);
    for (const s of f.signatures) {
      assert.strictEqual(typeof s.offset, 'number');
      assert.ok(Buffer.isBuffer(s.bytes), `${f.id} 的签名 bytes 不是 Buffer`);
      assert.ok(s.bytes.length > 0, `${f.id} 有空签名`);
    }
    assert.ok(Array.isArray(f.ext));
    assert.ok(Array.isArray(f.tools));
  }
});

test('FORMATS 的 id 全局唯一（含嵌入标记），否则 getById 会静默遮蔽', () => {
  const ids = [...registry.FORMATS, ...registry.EMBEDDED_MARKERS].map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, `重复 id: ${ids.join(',')}`);
});

test('cafebabe 是刻意登记的撞号：java-class 与 macho 都声明它', () => {
  const cafe = (id) =>
    registry.FORMATS.find((f) => f.id === id).signatures.some((s) => s.bytes.toString('hex') === 'cafebabe');
  assert.strictEqual(cafe('java-class'), true);
  assert.strictEqual(cafe('macho'), true);
  // 消歧逻辑在 artifactScanner，本表只声明撞号事实。
  assert.strictEqual(
    registry.FORMATS.find((f) => f.id === 'macho').note.includes('Java class'),
    true
  );
});

test('tar 的签名偏移在 257（POSIX magic 不在文件头）', () => {
  const tar = registry.FORMATS.find((f) => f.id === 'archive-tar');
  assert.deepStrictEqual(
    { offset: tar.signatures[0].offset, magic: tar.signatures[0].bytes.toString('ascii') },
    { offset: 257, magic: 'ustar' }
  );
});

test('listFormats 返回冻结副本，写穿不影响单一真源', () => {
  const list = registry.listFormats();
  assert.strictEqual(list.length, registry.FORMATS.length);
  assert.strictEqual(Object.isFrozen(list[0]), true);
  // 本文件是 'use strict'，写冻结对象直接抛；原表在任何模式下都不许被写穿。
  assert.throws(() => {
    list[0].label = 'tampered';
  }, TypeError);
  assert.notStrictEqual(registry.FORMATS[0].label, 'tampered');
});

test('listEmbeddedMarkers 返回冻结副本且条数与真源一致', () => {
  const markers = registry.listEmbeddedMarkers();
  assert.strictEqual(markers.length, registry.EMBEDDED_MARKERS.length);
  assert.ok(markers.length >= 5);
  assert.strictEqual(Object.isFrozen(markers[0]), true);
});

test('getById 先查顶层格式、再查嵌入标记，未命中返回 null', () => {
  assert.strictEqual(registry.getById('pe').family, 'pe');
  assert.strictEqual(registry.getById('dotnet').id, 'dotnet'); // 只在嵌入标记表里
  assert.strictEqual(registry.getById('no-such-format'), null);
  assert.strictEqual(registry.getById(undefined), null);
});

test('candidateTools 去重、未知 id 返回空数组、归档类无外部候选', () => {
  assert.deepStrictEqual(registry.candidateTools('no-such-format'), []);
  const pe = registry.candidateTools('pe');
  assert.deepStrictEqual(pe, Array.from(new Set(pe)));
  assert.ok(pe.includes('radare2'));
  assert.deepStrictEqual(registry.candidateTools('archive-zip'), []);
});

test('apk 标记刻意不声明 recoverability（不降级 zip 的 SOURCE 档）', () => {
  const apk = registry.EMBEDDED_MARKERS.find((m) => m.id === 'apk');
  assert.strictEqual(apk.recoverability, undefined);
  assert.strictEqual(apk.appliesTo, 'archive-zip');
  assert.ok(apk.tools.includes('jadx'));
});

test('node-sea 标记带 altMarkers，pkg/nexe 哨兵任一命中即算 Node 自包含', () => {
  const sea = registry.getById('node-sea');
  assert.strictEqual(sea.contentMarker.toString('ascii'), 'NODE_SEA_BLOB');
  const alts = sea.altMarkers.map((b) => b.toString('ascii'));
  assert.deepStrictEqual(alts, ['PAYLOAD_POSITION', '__NEXE_PATCH__']);
});
