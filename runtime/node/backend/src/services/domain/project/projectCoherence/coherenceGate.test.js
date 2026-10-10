'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decide, buildGateMessage } = require('./coherenceGate.js');

const HEAD =
  '[项目整体一致性门 — 单个文件看似没问题，但把它们装配成一个项目后存在以下断裂，' +
  '直接交付会导致项目跑不起来。请用工具（写文件/改文件/补文件）逐一修复后再收尾：]';
const MEDIUM_HEAD = '\n\n[以下为疑似问题（置信度较低，请自行判断是否需要处理）：]\n';

const HIGH = { severity: 'high', detail: '入口 index.js 缺少对 ./util.js 的引用' };
const MEDIUM = { severity: 'medium', detail: '命名导出对不上' };
const LOW = { severity: 'low', detail: '疑似重复定义' };

test('decide: 代码文件数不足 minFiles 时直接放行且理由为 too_few_files', () => {
  assert.deepEqual(decide(), { shouldGate: false, blocking: [], reason: 'too_few_files' });
  assert.deepEqual(decide({}), { shouldGate: false, blocking: [], reason: 'too_few_files' });
  assert.deepEqual(decide({ gaps: [HIGH], codeFileCount: 1 }), {
    shouldGate: false,
    blocking: [],
    reason: 'too_few_files',
  });
  // codeFileCount 为负数同样落在「太少」分支
  assert.equal(decide({ gaps: [HIGH], codeFileCount: -7 }).reason, 'too_few_files');
});

test('decide: 恰好 2 个代码文件 + 1 条 HIGH 断裂即拦下，blocking 复用原对象引用', () => {
  const r = decide({ gaps: [HIGH, LOW], codeFileCount: 2, rounds: 0 });
  assert.equal(r.shouldGate, true);
  assert.equal(r.reason, 'incoherent');
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0], HIGH); // identity, not a copy
  assert.equal(r.blocking[0].detail, '入口 index.js 缺少对 ./util.js 的引用');
});

test('decide: MEDIUM 默认只提示不拦，blockOnMedium 为真值时才进 blocking', () => {
  const gaps = [MEDIUM, LOW];
  assert.deepEqual(decide({ gaps, codeFileCount: 9 }), {
    shouldGate: false,
    blocking: [],
    reason: 'no_blocking_gaps',
  });
  const on = decide({ gaps, codeFileCount: 9, blockOnMedium: true });
  assert.deepEqual(on.blocking, [MEDIUM]);
  assert.equal(on.shouldGate, true);
  // 任何非 undefined 真值都算开（'no' 也是真值 → 与布尔语义相反）
  assert.deepEqual(decide({ gaps: [MEDIUM], codeFileCount: 9, blockOnMedium: 'no' }).blocking, [
    MEDIUM,
  ]);
});

test('decide: severity 大小写与未知等级一律不拦（只有小写 high / medium 被识别）', () => {
  const gaps = [
    { severity: 'HIGH', detail: 'a' },
    { severity: 'High', detail: 'b' },
    { severity: 'critical', detail: 'c' },
    { severity: undefined, detail: 'd' },
    {},
  ];
  assert.deepEqual(decide({ gaps, codeFileCount: 9 }), {
    shouldGate: false,
    blocking: [],
    reason: 'no_blocking_gaps',
  });
});

test('decide: gaps 非数组时收敛为空清单（字符串 / 对象 / undefined）', () => {
  for (const junk of ['x', { severity: 'high' }, 42, true]) {
    assert.deepEqual(
      decide({ gaps: junk, codeFileCount: 9 }).reason,
      'no_blocking_gaps',
      `junk input ${JSON.stringify(junk)}`
    );
  }
});

test('decide: 轮次到顶即放行（rounds >= maxRounds），不再看断裂清单', () => {
  assert.deepEqual(decide({ gaps: [HIGH], codeFileCount: 9, rounds: 2 }), {
    shouldGate: false,
    blocking: [],
    reason: 'rounds_exhausted',
  });
  assert.equal(decide({ gaps: [HIGH], codeFileCount: 9, rounds: 7, maxRounds: 3 }).reason,
    'rounds_exhausted');
  // rounds 比 maxRounds 少 1 时仍然拦
  assert.equal(decide({ gaps: [HIGH], codeFileCount: 9, rounds: 2, maxRounds: 3 }).reason,
    'incoherent');
});

test('KNOWN-DEFECT: decide(null) 抛 TypeError —— 默认参数只对 undefined 生效', () => {
  // input=null → `input = {}` 不触发，随后读 input.gaps 抛错（实测消息见下）
  assert.throws(() => decide(null), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'gaps')",
  });
  // 布尔/数字虽不抛，但同样绕过默认参数：false.codeFileCount 是 undefined → 0
  assert.equal(decide(false).reason, 'too_few_files');
  assert.equal(decide(42).reason, 'too_few_files');
});

test('KNOWN-DEFECT: gaps 数组含 null / undefined 元素时 decide 抛错而非跳过', () => {
  // gaps=[null] → g.severity 在读属性时抛，「零副作用纯决策」契约下仍会炸调用方
  assert.throws(() => decide({ gaps: [null], codeFileCount: 9 }), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'severity')",
  });
  assert.throws(() => decide({ gaps: [{ severity: 'high' }, undefined], codeFileCount: 9 }), {
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'severity')",
  });
});

test('KNOWN-DEFECT: maxRounds=0 / minFiles=0 被 || 吞成默认值，无法表达「零容忍」', () => {
  // maxRounds:0 意图「一轮都不许拦」→ 实测回退 2 且照样拦截
  assert.deepEqual(decide({ gaps: [HIGH], codeFileCount: 2, rounds: 0, maxRounds: 0 }), {
    shouldGate: true,
    blocking: [HIGH],
    reason: 'incoherent',
  });
  // minFiles:0 意图「单文件也拦」→ 实测回退 2，0 个文件仍判 too_few_files
  assert.equal(decide({ gaps: [HIGH], codeFileCount: 0, minFiles: 0 }).reason, 'too_few_files');
  // NaN 同样被 || 吞掉
  assert.equal(decide({ gaps: [HIGH], codeFileCount: 2, maxRounds: NaN }).reason, 'incoherent');
});

test('buildGateMessage: blocking 为空数组时产出「头部 + 空行 + 轮次尾注」的整串', () => {
  assert.equal(
    buildGateMessage([], 1, 2),
    `${HEAD}\n\n\n[一致性轮次 1/2。修复断裂后再给最终结论；` +
      '若判断某条是误报（如该模块由外部依赖提供），请简要说明理由再收尾。]'
  );
});

test('buildGateMessage: 逐条编号列出断裂并附轮次尾注，不传 allGaps 时无「疑似问题」段', () => {
  const msg = buildGateMessage([HIGH, MEDIUM], 2, 3);
  const lines = msg.split('\n');
  assert.equal(lines[0], HEAD);
  assert.equal(lines[1], '  1. 入口 index.js 缺少对 ./util.js 的引用');
  assert.equal(lines[2], '  2. 命名导出对不上');
  assert.equal(lines[3], '');
  assert.match(lines[4], /^\[一致性轮次 2\/3。/);
  assert.ok(!msg.includes('疑似问题'));
});

test('buildGateMessage: 最多列 12 条 blocking，mediums 去重且最多 6 条', () => {
  const many = [];
  for (let i = 0; i < 15; i++) many.push({ severity: 'high', detail: `H${i}` });
  const msg = buildGateMessage(many, 1, 2);
  assert.ok(msg.includes('  12. H11'), '第 12 条应出现');
  assert.ok(!msg.includes('H12'), '第 13 条不得出现');
  assert.equal(msg.split('\n  ').length - 1, 12);

  // allGaps 中与 blocking 同引用者被排除（identity 判重，非按 detail）
  const mediums = [];
  for (let i = 0; i < 8; i++) mediums.push({ severity: 'medium', detail: `M${i}` });
  const withMedium = buildGateMessage([HIGH], 1, 2, [HIGH, ...mediums]);
  assert.ok(withMedium.startsWith(`${HEAD}\n  1. ${HIGH.detail}${MEDIUM_HEAD}`));
  assert.ok(withMedium.includes('  - M0'));
  assert.ok(withMedium.includes('  - M5'));
  assert.ok(!withMedium.includes('M6'), '第 7 条 medium 不得出现');
  assert.ok(!withMedium.includes('  - 入口'), '已在 blocking 中的项不得重复提示');
  assert.equal(withMedium.split('  - ').length - 1, 6);
});

test('KNOWN-DEFECT: blocking 项缺 detail 时文案直出 "undefined"，无兜底', () => {
  // [{severity:'high'}] → 实测行内容 '  1. undefined'
  const msg = buildGateMessage([{ severity: 'high' }], 1, 2);
  assert.ok(msg.includes('\n  1. undefined\n') || msg.endsWith('  1. undefined'));
  assert.equal(msg.split('\n')[1], '  1. undefined');
});

test('KNOWN-DEFECT: buildGateMessage 对 null blocking / 含 null 的 allGaps 直接抛错', () => {
  assert.throws(() => buildGateMessage(null, 1, 2), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'slice')",
  });
  assert.throws(() => buildGateMessage([HIGH], 1, 2, [null]), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'severity')",
  });
  // 但字符串元素安全（有自己的属性命名空间，severity 只是 undefined）
  assert.ok(buildGateMessage([HIGH], 1, 2, ['oops']).includes(HIGH.detail));
});
