'use strict';

// khy trace 回放每行出现双 ✓：trace.js 把 row.glyph（上色可信字形）作为独立列，
// 又渲染 row.label —— 而 replayRow.label 之前复用 inlineLabel（自带前导字形）→ `✓ ✓`。
// 修复：抽 labelText（无字形），replayRow.label 用之；inlineLabel 输出逐字节不变
// （ToolLines.js 内联/横幅是「无独立字形列」的独立消费者，必须保留字形）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = (n, fn) => nt.describe(n, fn);
  _test = (n, fn) => nt.test(n, fn);
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (s) => assert.ok(String(actual).includes(s), `expected to contain: ${s}`),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
  });
}

const { TRUST, PRODUCER, makeTrace } = require('../../src/services/domain/trajectory/trajectoryProvenance/khyTrace.js');
const projection = require('../../src/services/domain/trajectory/trajectoryProvenance/traceProjection.js');

const entry = (opts) => ({ _khyTrace: makeTrace(opts) });

_describe('traceProjection 单字形契约', () => {
  _test('inlineLabel 保留前导字形（ToolLines 独立消费契约不变）', () => {
    _expect(projection.inlineLabel(entry({ producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED })))
      .toBe('✓ KHY executed');
    _expect(projection.inlineLabel(entry({ producer: 'codex', producerId: 'c1', trust: TRUST.CLAIMED })))
      .toBe('⟳ codex:c1 claims');
  });

  _test('replayRow 把字形只放在 glyph，label 不含前导字形（去双勾）', () => {
    const r = projection.replayRow(entry({ producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED }));
    _expect(r.glyph).toBe('✓');
    _expect(r.label).toBe('KHY executed');
  });

  _test('trace.js 合成行（glyph + label）恰好一个字形，无双 ✓', () => {
    const r = projection.replayRow(entry({ producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED }));
    const line = `${r.glyph} ${r.label}`;
    _expect(line).toBe('✓ KHY executed');
    _expect(line.includes('✓ ✓')).toBe(false);
  });
});
