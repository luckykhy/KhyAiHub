'use strict';

// Co-located contract tests for milestonePlanner.js (pure slice/plan layer).
// './catalog' is stubbed through require.cache so the char budget is deterministic
// (milestoneSlice reads catalog.thresholds at call time); contextProfile stays real.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const CAT_ID = require.resolve('./catalog');
const catStub = { thresholds: { defaultSliceChars: 5000, conceptSummaryMaxChars: 1200 } };
const prevCat = require.cache[CAT_ID];
require.cache[CAT_ID] = { id: CAT_ID, filename: CAT_ID, loaded: true, exports: catStub, children: [], paths: [] };

const planner = require('./milestonePlanner');

after(() => {
  if (prevCat) require.cache[CAT_ID] = prevCat; else delete require.cache[CAT_ID];
});

const ARCH = {
  id: 'demo',
  label: 'Demo 原型',
  templateName: 'tpl',
  stack: { persistence: 'MySQL 8' },
  build: { install: 'npm i', run: 'npm run dev', port: '5173' },
  verify: ['npm test'],
  milestones: [
    {
      id: 'm1',
      title: '骨架',
      goal: '能编译能起',
      conventions: ['Java 17', '包名以 group 起头'],
      steps: ['建 pom；声明 spring-boot-starter-web。细节文字刻意写到很长很长以便触发瘦身阶梯。', '建主类'],
      files: ['pom.xml', 'src/main/java/App.java'],
      acceptance: ['mvn -q compile 通过'],
    },
    { id: 'm2', title: '数据层', files: ['Entity.java'], steps: ['写实体'], acceptance: ['能落库'] },
  ],
};

test('buildPlan 只给目录骨架，不含任何文件正文，且带 full copy 的 files/acceptance', () => {
  const p = planner.buildPlan(ARCH);
  assert.equal(p.id, 'demo');
  assert.equal(p.label, 'Demo 原型');
  assert.equal(p.templateName, 'tpl');
  assert.deepEqual(p.stack, { persistence: 'MySQL 8' });
  assert.deepEqual(p.build, { install: 'npm i', run: 'npm run dev', port: '5173' });
  assert.deepEqual(p.verify, ['npm test']);
  assert.equal(p.total, 2);
  assert.deepEqual(p.milestones.map((m) => [m.index, m.id, m.title, m.fileCount]), [
    [0, 'm1', '骨架', 2],
    [1, 'm2', '数据层', 1],
  ]);
  assert.deepEqual(p.milestones[0].files, ['pom.xml', 'src/main/java/App.java']);
  assert.equal(p.milestones[0].goal, '能编译能起');
  // 里程碑里没有 steps/conventions/正文 —— 这是「目录」而不是「切片」。
  assert.equal(p.milestones[0].steps, undefined);
  assert.deepEqual(Object.keys(p.milestones[0]), ['index', 'id', 'title', 'goal', 'fileCount', 'files', 'acceptance']);
});

test('buildPlan 的数组是浅拷贝：改切片不影响 archetype 本体', () => {
  const src = { id: 'x', milestones: [{ id: 'm', files: ['a'], acceptance: ['b'] }] };
  const p = planner.buildPlan(src);
  p.milestones[0].files.push('INJECTED');
  assert.deepEqual(src.milestones[0].files, ['a']);
});

test('buildPlan 垃圾入参全部收敛成空目录，绝不抛', () => {
  for (const bad of [null, undefined, {}, 0, 'str', [], NaN, false]) {
    const p = planner.buildPlan(bad);
    assert.equal(p.total, 0);
    assert.deepEqual(p.milestones, []);
    assert.equal(p.label, null);
    assert.equal(p.build, null);
    assert.deepEqual(p.verify, []);
  }
  const partial = { id: 'y', milestones: [{}, {}] };
  const pp = planner.buildPlan(partial);
  assert.deepEqual(pp.milestones.map((m) => [m.id, m.title, m.fileCount, m.goal]), [
    [undefined, undefined, 0, ''],
    [undefined, undefined, 0, ''],
  ]);
  assert.equal(pp.total, 2);
});

test('KNOWN-DEFECT: milestones 混进 null 时 buildPlan 整体抛 TypeError（_milestones 只校验容器）', () => {
  // milestonePlanner.js:19-21 只用 Array.isArray 校验容器，:38-46 逐项直接读 m.id/m.title。
  // 蓝图 JSON 少写一格（`milestones: [ {...}, null ]`）时，「小到任何窗口都放得下、
  // 作为目录」的 buildPlan 直接崩，而调用方 projectBlueprint/index.js:132 没有 try/catch，
  // 工具调用以裸 TypeError 收尾而不是可恢复的错误信封。
  assert.throws(
    () => planner.buildPlan({ id: 'y', milestones: [{ id: 'm', files: ['a'] }, null] }),
    /Cannot read properties of null/,
  );
  // 同一份 JSON 交给 milestoneSlice：null 占位仍被算进 total，取到它同样崩。
  assert.deepEqual(planner.milestoneSlice({ id: 'y', milestones: [{ id: 'm' }, null] }, 2), {
    ok: false, error: '里程碑序号越界: 2（共 2 个）', total: 2,
  });
  assert.throws(
    () => planner.milestoneSlice({ id: 'y', milestones: [{ id: 'm' }, null] }, 1),
    /Cannot read properties of null/,
  );
  assert.equal(planner.milestoneSlice({ id: 'y', milestones: [{ id: 'm' }, null] }, 0).id, 'm');
});

test('milestoneSlice 命中第一个里程碑：标题带 1/2、含全部小节与 nextHint', () => {
  const s = planner.milestoneSlice(ARCH, 0, { contextWindow: 0 });
  assert.equal(s.ok, true);
  assert.equal(s.index, 0);
  assert.equal(s.total, 2);
  assert.equal(s.id, 'm1');
  assert.match(s.text, /# 里程碑 1\/2: 骨架/);
  assert.match(s.text, /目标: 能编译能起/);
  assert.match(s.text, /约定:\n {2}- Java 17/);
  assert.match(s.text, /1\. 建 pom/);
  assert.match(s.text, /产物文件:\n {2}- pom\.xml/);
  assert.match(s.text, /验收:\n {2}- mvn -q compile 通过/);
  assert.equal(s.nextHint, '完成本阶段后取里程碑 2/2');
  assert.equal(s.truncated, false);
  assert.equal(s.charBudget, 5000);
});

test('milestoneSlice 最后一个里程碑的 nextHint 指向 verify 收尾', () => {
  const s = planner.milestoneSlice(ARCH, 1);
  assert.equal(s.nextHint, '这是最后一个里程碑，完成后跑 verify 收尾');
  assert.match(s.text, /下一步: 这是最后一个里程碑/);
});

test('milestoneSlice 越界（负数、等于/大于 total）返回结构化错误并带 total', () => {
  assert.deepEqual(planner.milestoneSlice(ARCH, 2), {
    ok: false, error: '里程碑序号越界: 2（共 2 个）', total: 2,
  });
  assert.equal(planner.milestoneSlice(ARCH, -1).ok, false);
  assert.equal(planner.milestoneSlice(ARCH, 9).error, '里程碑序号越界: 9（共 2 个）');
  assert.equal(planner.milestoneSlice(null, 0).ok, false);
  assert.equal(planner.milestoneSlice({}, 0).total, 0);
});

test('KNOWN-DEFECT: 越界判断只挡整数，小数/非数字 index 绕过后直接 TypeError', () => {
  // milestonePlanner.js:100 `index < 0 || index >= total` 对 NaN/undefined/'abc' 都是 false，
  // 1.5 也落在区间内，于是 ms[index] → undefined，:113 读 m.id 抛 TypeError。
  for (const bad of [NaN, undefined, null, 'abc', {}, [], 1.5]) {
    assert.throws(() => planner.milestoneSlice(ARCH, bad), TypeError, `index=${String(bad)}`);
  }
  // 小数被当合法序号绕进去；而字符串数字靠数组下标强转「碰巧能用」，-0.5 则被区间判断挡下。
  assert.equal(planner.milestoneSlice(ARCH, -0.5).ok, false);
  assert.equal(planner.milestoneSlice(ARCH, '1').index, '1');
  // 同一函数的可选参数也只挡 undefined：显式 opts=null 在 :104 `opts.contextWindow` 抛。
  assert.throws(() => planner.milestoneSlice(ARCH, 0, null), TypeError);
  assert.equal(planner.milestoneSlice(ARCH, 0, undefined).ok, true);
  // 调用方 projectBlueprint/index.js:140 用 Number(index)||0 挡了一层，但 '2abc' 被 Number
  // 转成 NaN→0：用户要第 3 片、拿到第 1 片，且 truncated/nextHint 全是另一阶段的内容。
  assert.equal(planner.milestoneSlice(ARCH, Number('2abc') || 0).index, 0);
});

// Fixture sized so the three trimming tiers are measurable:
//   full text 1293 chars → drop conventions 679 → compress steps 109.
const FAT = {
  id: 'x',
  milestones: [{
    id: 'm',
    title: 'T',
    goal: 'G',
    conventions: ['c'.repeat(300), 'd'.repeat(300)],
    steps: [
      '第一步。' + 'x'.repeat(190),
      '第二步。' + 'y'.repeat(190),
      '第三步。' + 'z'.repeat(190),
    ],
    files: ['a.ts'],
    acceptance: ['验收项'],
  }],
};

test('瘦身阶梯第一级：预算 700 时只砍 conventions，steps 原样保留', () => {
  const base = planner.milestoneSlice(FAT, 0);
  assert.equal(base.text.length, 1293);
  assert.equal(base.truncated, false);

  catStub.thresholds.defaultSliceChars = 700;
  try {
    const s = planner.milestoneSlice(FAT, 0);
    assert.equal(s.charBudget, 700);
    assert.equal(s.truncated, true);
    assert.deepEqual(s.conventions, []);
    assert.deepEqual(s.steps, FAT.milestones[0].steps);
    assert.match(s.text, /x{100}/);
    assert.ok(!/约定:/.test(s.text));
    assert.ok(s.text.length <= 700, `${s.text.length} <= 700`);
    // 原始 archetype 不被改写（瘦身只动切片副本）。
    assert.equal(FAT.milestones[0].conventions.length, 2);
  } finally {
    catStub.thresholds.defaultSliceChars = 5000;
  }
});

test('瘦身阶梯第二级：预算落到下限时 steps 也被压成一句要点', () => {
  catStub.thresholds.defaultSliceChars = 500;
  try {
    const s = planner.milestoneSlice(FAT, 0);
    assert.equal(s.charBudget, 500);
    assert.equal(s.truncated, true);
    assert.deepEqual(s.conventions, []);
    assert.deepEqual(s.steps, ['第一步…', '第二步…', '第三步…']);
    assert.ok(!/x{20}/.test(s.text));
    // 最小必要信息（标题/目标/产物文件名/验收）仍在文本里。
    assert.match(s.text, /# 里程碑 1\/1: T/);
    assert.match(s.text, /目标: G/);
    assert.match(s.text, /产物文件:\n {2}- a\.ts/);
    assert.match(s.text, /验收:\n {2}- 验收项/);
    assert.ok(s.text.length <= 500, `${s.text.length} <= 500`);
  } finally {
    catStub.thresholds.defaultSliceChars = 5000;
  }
});

test('硬截断兜底：保留信息本身超预算时文本被切到 charBudget 并以 … 结尾', () => {
  const heavy = {
    id: 'x',
    milestones: [{
      id: 'm',
      title: '标题',
      goal: '目标',
      files: Array.from({ length: 40 }, (_, i) => `file-name-${String(i).padStart(2, '0')}.ts`),
      acceptance: ['最后一条验收项必须在结构字段里可见'],
    }],
  };
  catStub.thresholds.defaultSliceChars = 100;
  try {
    const s = planner.milestoneSlice(heavy, 0);
    // 砍完 conventions、压完 steps 仍然超预算 → 走 :145-148 的硬截断。
    assert.equal(s.charBudget, 500);
    assert.equal(s.truncated, true);
    assert.equal(s.text.length, 500);
    assert.ok(s.text.endsWith('…'));
    // 结构字段完好（40 个产物 + 验收），但渲染文本尾部丢掉了验收。
    assert.equal(s.files.length, 40);
    assert.deepEqual(s.acceptance, ['最后一条验收项必须在结构字段里可见']);
    assert.ok(!/验收:/.test(s.text));
    // milestonePlanner.js:90 的注释承诺「任何窗口下标题/目标/产物文件名/验收恒保留」，
    // 对 text 而言只在下两层阶梯成立；超预算时验收整段被硬切掉，只读 text 的模型看不到它。
  } finally {
    catStub.thresholds.defaultSliceChars = 5000;
  }
});

test('KNOWN-DEFECT: 配置出来的 sliceChars 小于 500 时被 Math.max 静默抬到 500（预算下限与配置无关）', () => {
  catStub.thresholds.defaultSliceChars = 7;
  try {
    const s = planner.milestoneSlice({ id: 'x', milestones: [{ id: 'm', title: 'T', files: ['f'] }] }, 0, {});
    // milestonePlanner.js:105-106 把 catalog.thresholds.defaultSliceChars 交给
    // contextProfile.deriveToolResultCap，后者 :173 是 Math.max(500, floor(defaultChars))：
    // 运维把 KHY_BLUEPRINT_SLICE_CHARS 设成 7（短窗口实验）得到的是 500，而不是 7。
    assert.equal(s.charBudget, 500);
  } finally {
    catStub.thresholds.defaultSliceChars = 5000;
  }
});

test('短窗口按比例收紧预算（800 下限），窗口 0 用默认值', () => {
  const arch = { id: 'x', milestones: [{ id: 'm', title: 'T' }] };
  assert.equal(planner.milestoneSlice(arch, 0, { contextWindow: 2000 }).charBudget, 800);
  assert.equal(planner.milestoneSlice(arch, 0, { contextWindow: 32000 }).charBudget, 5000);
  assert.equal(planner.milestoneSlice(arch, 0, { contextWindow: 'abc' }).charBudget, 5000);
  assert.equal(planner.milestoneSlice(arch, 0, { contextWindow: -5 }).charBudget, 5000);
  assert.equal(planner.milestoneSlice(arch, 0, {}).charBudget, 5000);
  // opts 只认 contextWindow 一个键；非对象 opts（除 null）也只是取不到窗口 → 退回默认。
  assert.equal(planner.milestoneSlice(arch, 0, 'abc').charBudget, 5000);
  assert.equal(planner.milestoneSlice(arch, 0, 5000).charBudget, 5000);
  assert.equal(planner.milestoneSlice(arch, 0, []).charBudget, 5000);
});

test('KNOWN-DEFECT: files/acceptance 写成字符串时被 .slice() 成字符串，渲染时逐字符拆行', () => {
  const weird = { id: 'x', milestones: [{ id: 'm', title: 'T', files: 'a.java', acceptance: 'ok' }] };
  const p = planner.buildPlan(weird);
  assert.equal(p.milestones[0].fileCount, 6);
  assert.equal(p.milestones[0].files, 'a.java');
  const s = planner.milestoneSlice(weird, 0);
  assert.match(s.text, /产物文件:\n {2}- a\n {2}- \.\n {2}- j/);
  assert.match(s.text, /验收:\n {2}- o\n {2}- k/);
  // milestonePlanner.js:43-44、:116-119 全是 `(m.X || []).slice()`，不校验 Array.isArray：
  // 蓝图 JSON 把 files 写成字符串（单文件原型极易手误）会得到「按字符切开的产物清单」，
  // fileCount 变成字符数 6，模型据此建出一堆单字符文件。
  // 同一族的 steps 更糟：:65 用 .forEach，字符串直接 TypeError 崩掉整个切片。
  assert.throws(
    () => planner.milestoneSlice({ id: 'x', milestones: [{ id: 'm', title: 'T', steps: 'do.it' }] }, 0),
    /slice\.steps\.forEach is not a function|forEach is not a function/,
  );
  // conventions 走 :59 的 for..of，于是又是「逐字符」而不是崩。
  const cv = planner.milestoneSlice({ id: 'x', milestones: [{ id: 'm', title: 'T', conventions: 'ab' }] }, 0);
  assert.match(cv.text, /约定:\n {2}- a\n {2}- b/);
});

test('_renderSliceText 对空对象只出一个 NaN 标题，对 null 直接抛', () => {
  assert.equal(planner._renderSliceText({}), '# 里程碑 NaN/undefined: undefined');
  assert.throws(() => planner._renderSliceText(null), TypeError);
  assert.throws(() => planner._renderSliceText(undefined), TypeError);
  const one = planner._renderSliceText({ index: 0, total: 1, title: 'T', steps: ['s'], conventions: [], files: [], acceptance: [] });
  assert.equal(one, '# 里程碑 1/1: T\n步骤:\n  1. s');
});

test('切片数组字段是拷贝：改返回值不会写回 archetype', () => {
  const src = { id: 'x', milestones: [{ id: 'm', files: ['a'], steps: ['s'], conventions: ['c'], acceptance: ['v'] }] };
  const s = planner.milestoneSlice(src, 0);
  s.files.push('INJECT');
  s.steps.push('INJECT');
  s.conventions.push('INJECT');
  s.acceptance.push('INJECT');
  assert.deepEqual(src.milestones[0], { id: 'm', files: ['a'], steps: ['s'], conventions: ['c'], acceptance: ['v'] });
});

test('milestoneSlice 的 opts 只认 contextWindow，其他键被忽略', () => {
  const s = planner.milestoneSlice(ARCH, 0, { contextWindow: 128000, index: 99, total: 1 });
  assert.equal(s.index, 0);
  assert.equal(s.total, 2);
  assert.equal(s.charBudget, 5000);
});
