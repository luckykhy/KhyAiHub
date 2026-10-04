'use strict';

/**
 * chatChordsHelpSync.test.js — 「?」帮助浮层与 chatChords 实现的双向一致性守卫
 * （[DESIGN-ARCH-147] P1 落地物，node:test，零 IO，落地即绿）。
 *
 * 背景：chatChords.js（键→动作的单一真源纯叶子）接线晚于 keybindingCatalog 的
 * ESSENTIAL 精简表定稿，四键中三键（Meta+P/O/T）漏登在「?」速查浮层里——用户不读
 * 源码就不知道这几个键存在（判据四「易懂」的残余缺口，G-02）。本文件钉住两层：
 *
 *   ① 实现侧 → 目录侧：chatChords 每个可解析的 chord 都能在完整目录 KEYBINDING_CATALOG
 *      中找到同名条目（防「实现有键、目录没登」再次发生）；
 *   ② 目录侧 → 实现侧：ESSENTIAL 精简表中每个「Meta + X」条目经 resolveChatChord
 *      实测解析出非空动作名（防「目录有字、按了没反应」——假承诺比没承诺更糟）。
 *
 * 另钉一条**决策**而非实现：Ctrl+T（任务清单，仅宽屏 ≥120 列可用）刻意不进精简表，
 * 防速查层向窄屏用户承诺按了没反应的键（[DESIGN-ARCH-147] §「实施记录」登记的理由）。
 * 未来若想把它加回精简表，应先改这条测试并写明窄屏语义如何呈现——不要静默加。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const chatChords = require('../../../src/cli/tui/chatChords');
const {
  KEYBINDING_CATALOG,
  getEssentialShortcuts,
} = require('../../../src/services/domain/config/keybindings/keybindingCatalog.js');

const EMPTY_ENV = Object.freeze({});

/** 把目录键位串「Meta + X」翻译成 resolveChatChord 的事件形状；非该族返回 null。 */
function chordEventFor(keysLabel) {
  const m = /^Meta \+ ([A-Za-z])$/.exec(String(keysLabel).trim());
  if (!m) return null;
  return { key: { meta: true, ctrl: false }, input: m[1].toLowerCase() };
}

describe('chatChords ↔ 键位目录 双向一致([DESIGN-ARCH-147] G-02)', () => {
  test('① 实现侧：chatChords 每个 chord 在完整目录有同名条目', () => {
    const catalogKeys = new Set(
      KEYBINDING_CATALOG.flatMap((g) => g.bindings).map((b) => b.keys)
    );
    // chatChords 的四个动作与目录标签的对应（键位真源是 resolveChatChord 的分支）。
    const chords = [
      { ev: { key: { meta: true, ctrl: false }, input: 'p' }, label: 'Meta + P' },
      { ev: { key: { meta: true, ctrl: false }, input: 'o' }, label: 'Meta + O' },
      { ev: { key: { meta: true, ctrl: false }, input: 't' }, label: 'Meta + T' },
      { ev: { key: { ctrl: true, meta: false, shift: false }, input: 't' }, label: 'Ctrl + T' },
    ];
    for (const { ev, label } of chords) {
      const action = chatChords.resolveChatChord(ev, EMPTY_ENV);
      assert.ok(action, `chord ${label} 应解析出动作名`);
      assert.ok(catalogKeys.has(label), `chatChords 动作 ${action}(${label}) 未登记进键位目录`);
    }
  });

  test('② 目录侧：ESSENTIAL 每个「Meta + X」条目实测能解析出动作', () => {
    for (const [keys] of getEssentialShortcuts()) {
      const ev = chordEventFor(keys);
      if (!ev) continue;
      const action = chatChords.resolveChatChord(ev, EMPTY_ENV);
      assert.ok(
        action,
        `速查浮层条目「${keys}」按下去没有对应动作——假承诺(诚实红线)`
      );
    }
  });

  test('③ ESSENTIAL 无孤儿：每条键位在完整目录中精确或合并写法可寻', () => {
    // 精简表有历史的合并速记（'Ctrl + A / E'、'Ctrl + K / U'——完整目录里是分开两条,
    // 精简行把它们写成一行）。判据：ESSENTIAL 键位 compact 后,要么与某目录键位 compact
    // 精确相等,要么包含某目录键位 compact 作为子串（合并写法场景）。
    // 'Ctrl + Z' 这类目录里根本不存在的自造键位,两种命中都拿不到 → 红。
    const dirKeys = KEYBINDING_CATALOG.flatMap((g) => g.bindings).map((b) =>
      b.keys.replace(/\s*\+\s*/g, '+')
    );
    for (const [keys] of getEssentialShortcuts()) {
      const k = keys.replace(/\s*\+\s*/g, '+');
      const hit =
        dirKeys.some((d) => d === k) || dirKeys.some((d) => k.includes(d));
      assert.ok(
        hit,
        `精简表条目「${keys}」在完整目录中无可寻条目——速查层不得自造键位`
      );
    }
  });

  test('④ 决策钉：Ctrl+T 不进精简表(条件性键位防误导窄屏)', () => {
    const essential = getEssentialShortcuts().map(([k]) => k);
    assert.ok(
      !essential.includes('Ctrl + T'),
      'Ctrl+T 仅宽屏(≥120 列)可用，进速查表会向窄屏用户做假承诺；' +
        '要加回请先修订本测试与 [DESIGN-ARCH-147] 实施记录'
    );
    // 但它在完整目录里必须存在(①的补充面：全局用户用 /keybindings 能查到)。
    const global = KEYBINDING_CATALOG.find((g) => g.context === 'global');
    assert.ok(global.bindings.some((b) => b.keys === 'Ctrl + T'));
  });
});
