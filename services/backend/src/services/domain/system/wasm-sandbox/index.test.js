'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const index = require('./index');
const constants = require('./m1Constants');
const codec = require('./ipcCodec');
const bridge = require('./moonbitHostBridge');
const loopback = require('./loopbackTransport');
const khySysHost = require('./khySysHost');

// 展开顺序即优先级：index.js 是 constants → codec → bridge → loopback → khySysHost。
const SOURCES = [['constants', constants], ['codec', codec], ['bridge', bridge], ['loopback', loopback], ['khySysHost', khySysHost]];

test('门面不抛，且导出面是五个子模块键的并集', () => {
  assert.equal(typeof index, 'object');
  const union = new Set();
  for (const [, mod] of SOURCES) for (const k of Object.keys(mod)) union.add(k);
  for (const k of union) assert.ok(k in index, `门面缺键 ${k}`);
});

test('门面每个键的类型与来源模块一致（不做二次加工）', () => {
  for (const [name, mod] of SOURCES) {
    for (const k of Object.keys(mod)) {
      if (!(k in index)) continue; // 被后展开的模块遮蔽，下一条用例单独处理
      assert.equal(typeof index[k], typeof mod[k], `${name}.${k} 类型被门面改变`);
    }
  }
});

test('五个子模块之间没有同名键（遮蔽为零；本条是防未来冲突的测护，不是缺陷钉）', () => {
  // 遮蔽集合由实测得出，不硬编码：按 index.js 的展开顺序重放一遍即可发现谁被盖掉。
  const order = [['constants', constants], ['codec', codec], ['bridge', bridge], ['loopback', loopback], ['khySysHost', khySysHost]];
  const seen = new Map();
  const shadowed = [];
  for (const [name, mod] of order) {
    for (const k of Object.keys(mod)) {
      if (seen.has(k)) shadowed.push(`${k}: ${seen.get(k)} 被 ${name} 遮蔽`);
      else seen.set(k, name);
    }
  }
  // 2026-09-29 实测：并集去重 23 · 遮蔽 0 · 门面键数 23。若将来新增同名键，这里会指出被遮蔽的具体一侧。
  assert.deepEqual(shadowed, [], `出现静默遮蔽：${shadowed.join('; ')}`);
  assert.equal(Object.keys(index).length, seen.size, '门面键数应等于去重后的并集数');
});
