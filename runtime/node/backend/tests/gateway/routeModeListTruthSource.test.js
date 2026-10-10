'use strict';

/**
 * routeModeListTruthSource.test.js — 档名列表的唯一真源是档位卡，不是任何一处硬编码。
 *
 * 起因（§16.4aj）：完成度审计新增的「§7 接线点现场在位性」把 `③` 与 `①` 读成 FAIL，
 * 顺着查发现供数点 `gatewayModelChoices.js` 里写着
 * `const ORDER = ['auto', 'extreme', 'perf', 'economy']` —— 它是档位卡的**第二份真源**。
 * 危险不在「现在不一致」，而在不一致时的表现：那个循环是 `if (!mode) continue`，
 * 所以卡里改名或加档 ⇒ 那一行在选择器里静默消失，没有任何测试会红。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const rm = require(path.join(BE, 'src/services/gateway/routingMode'));
const autoSelect = require(path.join(BE, 'src/services/gateway/autoModelSelect'));

// 五档卡：**由真卡深拷贝再插一档并改名**，而不是手写一份卡。
// 手写的代价本轮实测过一次：我把 band 的两端写反（真卡是 T0=最强，floor 是较弱那一端），
// `resolveMode` 判「卡坏」直接返回 null ⇒ 测试红的是我的夹具，不是产品。
const REAL_CARD = rm._loadCard();
const FIVE = {
  ...REAL_CARD,
  modes: (() => {
    const m = JSON.parse(JSON.stringify(REAL_CARD.modes));
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      // 两件事一起做：把 perf **改名**（硬编码档名的代码会漏掉这一行）+ 复制出一第五档
      // （硬编码「四行」的代码会少画一行）。
      out[k === 'perf' ? 'fastlane' : k] = v;
      if (k === 'economy') out['eco2'] = { ...v, label: '经济二号' };
    }
    return out;
  })(),
};

test('档位卡说了算：五档卡 ⇒ listModes 出五条且顺序就是卡里的顺序', () => {
  const list = rm.listModes({ card: FIVE });
  assert.deepEqual(
    list.map((m) => m.key),
    ['auto', 'extreme', 'fastlane', 'economy', 'eco2'],
    `列表应逐字跟随卡，实际 ${JSON.stringify(list.map((m) => m.key))}`
  );
  for (const m of list) {
    assert.ok(rm.resolveMode(m.key, { card: FIVE }), `${m.key} 在卡里却解不出档 ⇒ 选择器会静默少一行`);
  }
});

test('正对照：真卡四档 ⇒ 恰好四条，不是硬编码出来的四个名字', () => {
  const real = rm.listModes();
  assert.strictEqual(real.length, 4, `真卡应列出 4 档，实际 ${real.length}`);
  for (const m of real) {
    assert.ok(rm.resolveMode(m.key, { card: REAL_CARD }), `真档 ${m.key} 解不出 ⇒ 下面那条对照无意义`);
  }
  assert.notStrictEqual(
    rm.listModes({ card: FIVE }).length,
    real.length,
    '换卡后条数没变 ⇒ 列表被卡之外的东西钉住了（就是本文件钉的缺陷）'
  );
});

test('渲染侧不补数：给几条 specs 就画几行，costHint 原样带出', () => {
  const specs = rm.listModes({ card: FIVE }).map((m, i) => ({
    key: m.key,
    label: m.label,
    intent: m.intent,
    costHint: `~${i}`,
    preview: '',
    current: i === 0,
  }));
  const rows = autoSelect.buildModeChoices({ modes: specs });
  assert.strictEqual(rows.length, 5, `5 条输入应画 5 行，实际 ${rows.length}`);
  assert.ok(rows.every((r) => /~\d/.test(r.name + r.primary + r.secondary)), 'costHint 被丢了');
  // 空输入必须画空，而不是回落成「四个默认档」——那正是硬编码会藏身的地方。
  assert.deepStrictEqual(autoSelect.buildModeChoices({ modes: [] }), []);
});

test('供数点不再有第二份档名真源（源码形状锁）', () => {
  const src = fs.readFileSync(
    path.join(BE, 'src/cli/handlers/gatewayModelChoices.js'),
    'utf8'
  );
  assert.doesNotMatch(
    src,
    /ORDER\s*=\s*\[\s*['"]auto['"]/,
    '选择器里又出现了硬编码档名数组 ⇒ 与档位卡形成第二份真源，卡改名时那一档会静默消失'
  );
  assert.match(src, /listModes\(/, '供数点应调 listModes() 从卡取列表');
});
