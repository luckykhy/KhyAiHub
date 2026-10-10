'use strict';

/**
 * peekTargetAgreement.test.js — 「执行中按 ↓ 开板」这条键位与面板取的内容是同一把尺。
 *
 * 背景(2026-10-09 用户反馈「执行过程中的下键不知道搞什么的」):executing 的 ↓ 此前是
 * 无条件开板,本回合还没有工具调用时按下去就得到一个占满主区的空框。修法是把该绑定改成
 * 条件绑定,条件由 `ShellView.latestTool` 供给 —— App 判「有没有内容可看」与面板取
 * 「看哪一个」用同一个函数,不靠两处各记一遍。
 *
 * 这把尺此前只是渲染内部实现(没有单测);一旦它成了**键位判定的输入**,它就得有自己的契约,
 * 否则一次静默的渲染侧改动就能把刚修好的行为重新弄坏:
 *   ① 两种容器形状(timeline 优先、tools 兜底)、最后一个胜出、缺 `.tool` 的条目跳过;
 *   ② 任何畸形入参绝不抛(键位判定路径不能因渲染数据抛);
 *   ③ 叶子仍只吃布尔(不反向依赖 React 侧)—— `hasTool` 是调用方算好递进来的;
 *   ④ 叶子能返回的两个动作在 App 的分派 switch 里都有 case(改词表不改消费方会让方向键
 *      漏进输入框,变成"按一下光标动一下"这种更难查的现象)。
 *
 * Run: `node --test tests/cli/tui/peekTargetAgreement.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ShellView = require('../../../src/cli/tui/ink-components/ShellView');
const { resolveArrowAction } = require('../../../src/cli/tui/arrowRouting');

const SRC = path.join(__dirname, '../../../src/cli/tui');
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const DOWN = { downArrow: true };
const EXECUTING = { busy: true, empty: true };
const { latestTool } = ShellView;

// ── ① 谓词契约:面板与键位都读它,形状必须钉住 ────────────────────────────────

test('latestTool: timeline 优先,tools 兜底', () => {
  assert.equal(latestTool({ timeline: [{ type: 'tool', tool: { name: 'Read' } }] }).name, 'Read');
  assert.equal(latestTool({ tools: [{ name: 'Bash' }] }).name, 'Bash');
  // 两容器都有 → timeline 胜(该回合的正文顺序才是权威顺序)
  assert.equal(
    latestTool({
      timeline: [{ type: 'tool', tool: { name: 'FromTimeline' } }],
      tools: [{ name: 'FromTools' }],
    }).name,
    'FromTimeline'
  );
});

test('latestTool: 取最后一条(timeline 扫描方向与 tools 同源)', () => {
  assert.equal(latestTool({ tools: [{ name: 'A' }, { name: 'B' }] }).name, 'B');
  assert.equal(
    latestTool({
      timeline: [
        { type: 'text', text: '...' },
        { type: 'tool', tool: { name: 'A' } },
        { type: 'text', text: '...' },
      ],
    }).name,
    'A'
  );
});

test('latestTool: timeline 存在但无可认工具条目 → 回落到 tools', () => {
  // `{type:'tool'}` 缺 `.tool` 的条目要跳过,不是当作"有工具"
  assert.equal(latestTool({ timeline: [{ type: 'tool' }] }), null);
  assert.equal(latestTool({ timeline: [{ type: 'tool' }], tools: [{ name: 'T' }] }).name, 'T');
});

test('latestTool: 空 / 缺失 / 畸形入参 → null,绝不抛', () => {
  for (const v of [undefined, null, 42, 'x', [], {}, { tools: [] }, { timeline: [] }]) {
    assert.equal(latestTool(v), null, `latestTool(${JSON.stringify(v)})`);
  }
});

// ── ② 一致性:叶子的动作 ⟺ 面板是否有内容可看 ────────────────────────────────

test('执行中按 ↓:有内容才开板,没内容降级为提示(逐条对照,不各算一遍)', () => {
  const shapes = [undefined, null, {}, { tools: [] }, { timeline: [] }, { tools: [{ name: 'Bash' }] }, {
    timeline: [{ type: 'tool', tool: { name: 'Read' } }],
  }];
  for (const streaming of shapes) {
    const expected = latestTool(streaming) ? 'subview:openShell' : 'subview:peekUnavailable';
    assert.equal(
      resolveArrowAction({ ...EXECUTING, hasTool: !!latestTool(streaming), key: DOWN }),
      expected,
      `streaming=${JSON.stringify(streaming)}`
    );
  }
});

// ── ③④ 接线锚点:单一真源与词表消费方 ──────────────────────────────────────

test('App 的 hasTool 取自 ShellView.latestTool(不另写一份谓词)', () => {
  const app = readSrc('ink-components/App.js');
  assert.match(app, /hasTool:\s*!!\(?\s*ShellView\.latestTool/, 'App 未用 ShellView.latestTool 供 hasTool');
  assert.match(
    readSrc('ink-components/ShellView.js'),
    /module\.exports\.latestTool\s*=/,
    'ShellView 未导出 latestTool —— App 会静默拿不到(hasTool 恒假,↓ 永不 openShell)'
  );
});

test('叶子不反向依赖 React 侧:只吃布尔的 hasTool,不认识"工具"', () => {
  const leaf = readSrc('arrowRouting.js');
  assert.doesNotMatch(leaf, /latestTool|ShellView|streaming/, '箭头叶子被塞进了渲染侧概念');
  assert.match(leaf, /args\.hasTool|a\.hasTool/, '叶子未消费 hasTool');
});

test('叶子能返回的两个动作,App 的 switch 都有 case(否则方向键会漏进输入框)', () => {
  const app = readSrc('ink-components/App.js');
  for (const action of ['subview:openShell', 'subview:peekUnavailable']) {
    assert.match(app, new RegExp(`case '${action}':`), `App 缺 case '${action}'`);
  }
});
