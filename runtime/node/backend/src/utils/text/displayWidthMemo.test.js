'use strict';

// 单元契约测试（与共置的 README.md / khy.module.json 同层）：锁住 displayWidthMemo 的
// 「零依赖记忆层」契约——门控语义、注入式宽度算法、缓存边界与永不抛。
// 行为回归测试在 services/backend/tests/cli/，判据不同，两者不可互替。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const memo = require('./displayWidthMemo');

test('导出面与 khy.module.json 登记的契约一致', () => {
  assert.deepEqual(Object.keys(memo).sort(), [
    'MAX_ENTRIES',
    'MAX_KEY_LEN',
    'OFF_VALUES',
    '_clearCache',
    '_size',
    'getDisplayWidth',
    'isEnabled',
  ]);
  assert.equal(memo.MAX_ENTRIES, 2048);
  assert.equal(memo.MAX_KEY_LEN, 4096);
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('门控：缺省为开，OFF_VALUES 逐字节回退（大小写与空白不敏感）', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_DISPLAY_WIDTH_MEMO: '1' }), true);
  // 空串不是 OFF 取值：设了但留空 = 仍开
  assert.equal(memo.isEnabled({ KHY_DISPLAY_WIDTH_MEMO: '' }), true);
  for (const off of ['0', 'false', 'OFF', ' no ', 'No']) {
    assert.equal(memo.isEnabled({ KHY_DISPLAY_WIDTH_MEMO: off }), false, `off=${off}`);
  }
  // 绝不抛：垃圾 env 也必须给出布尔
  assert.equal(typeof memo.isEnabled(null), 'boolean');
  assert.equal(typeof memo.isEnabled('nonsense'), 'boolean');
});

test('getDisplayWidth 只算一次：同串第二次走缓存，computeFn 不再被调', () => {
  memo._clearCache();
  let calls = 0;
  const compute = (s) => {
    calls += 1;
    return [...s].length * 2;
  };
  const env = { KHY_DISPLAY_WIDTH_MEMO: '1' };
  const first = memo.getDisplayWidth('标题标题', compute, env);
  const second = memo.getDisplayWidth('标题标题', compute, env);
  assert.equal(calls, 1, '记忆层未命中说明注入契约破了');
  assert.equal(first, 8);
  assert.equal(second, first);
  assert.equal(memo._size(), 1);
  memo._clearCache();
});

test('门控关 → 每次现算（缓存整体旁路，逐字节回退历史）', () => {
  memo._clearCache();
  let calls = 0;
  const compute = (s) => {
    calls += 1;
    return s.length;
  };
  const env = { KHY_DISPLAY_WIDTH_MEMO: '0' };
  memo.getDisplayWidth('ab', compute, env);
  memo.getDisplayWidth('ab', compute, env);
  assert.equal(calls, 2);
  assert.equal(memo._size(), 0, '门控关却写缓存 = 关掉开关仍改变行为');
});

test('不入缓存的三类：空串 / 超长串 / 非串入参，且一律透传给 computeFn', () => {
  memo._clearCache();
  const seen = [];
  const compute = (s) => {
    seen.push(s);
    return 7;
  };
  const env = { KHY_DISPLAY_WIDTH_MEMO: '1' };

  assert.equal(memo.getDisplayWidth('', compute, env), 7);
  assert.equal(memo._size(), 0);

  const long = 'x'.repeat(memo.MAX_KEY_LEN + 1);
  assert.equal(memo.getDisplayWidth(long, compute, env), 7);
  assert.equal(memo._size(), 0, '超长串不得进缓存（否则缓存本身成为内存负担）');

  for (const junk of [null, undefined, 42, {}, []]) {
    assert.equal(memo.getDisplayWidth(junk, compute, env), 7);
  }
  assert.equal(memo._size(), 0);
  assert.equal(seen.length, 7);
  memo._clearCache();
});

test('computeFn 返回非有限数时不污染缓存', () => {
  memo._clearCache();
  assert.equal(memo.getDisplayWidth('zz', () => NaN, { KHY_DISPLAY_WIDTH_MEMO: '1' }), NaN);
  assert.equal(memo._size(), 0);
  memo._clearCache();
});

test('LRU 上界：超过 MAX_ENTRIES 时淘汰最旧，size 不越界', () => {
  memo._clearCache();
  const env = { KHY_DISPLAY_WIDTH_MEMO: '1' };
  for (let i = 0; i < memo.MAX_ENTRIES + 5; i += 1) {
    memo.getDisplayWidth(`s${i}`, () => 1, env);
  }
  assert.ok(memo._size() <= memo.MAX_ENTRIES, `size=${memo._size()}`);
  // 最旧的 s0 已被淘汰 → 再测一次会重新现算
  let recomputed = 0;
  memo.getDisplayWidth('s0', () => {
    recomputed += 1;
    return 3;
  }, env);
  assert.equal(recomputed, 1);
  memo._clearCache();
});

test('纯度锁：零 require / 零 IO / 不碰终端与运行时', () => {
  const src = fs.readFileSync(path.join(__dirname, 'displayWidthMemo.js'), 'utf8');
  assert.ok(!src.includes('require('), '本叶子必须零 require（宽度算法由入参注入）');
  for (const forbidden of ['process.stdout', 'process.env.', 'readFileSync', 'fetch(', 'child_process']) {
    assert.ok(!src.includes(forbidden), `出现 ${forbidden}`);
  }
});
