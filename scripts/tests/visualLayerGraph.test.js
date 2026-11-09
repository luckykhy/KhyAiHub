'use strict';

/**
 * visualLayerGraph.test.js — 视觉层分析纯叶子的判定正确性回归
 *
 *   node --test scripts/tests/visualLayerGraph.test.js
 *
 * ## 为什么需要它
 *
 * `scripts/lib/visualLayerGraph.js` 的 `findLazyCandidates()` 与 `checkStillLazy()`
 * 是**判据本身**。判据也会骗人 —— 本文件在开发这两个函数时实测踩了三个真实的坑：
 *
 *   1. **`lazy()` 写在「导入方」文件里，不在被导入的组件文件里。**
 *      一开始去查「组件文件自己有没有 lazy」⇒ 判据永远不报（假绿）。
 *   2. **组件名与文件名常不同。**
 *      `DiffSummary` 来自 `DiffViewer`、`TerminalPanel` 来自 `Terminal`
 *      ⇒ 不能用 basename 匹配，
 *      必须认 `.then(m => ({ default: m.X }))` 里**显式写的 X**。
 *      （下面 fixture 用的 `ContextUsagePanel` / `ContextUsage` 是**合成名** ——
 *        真实仓里那份 ContextUsage.tsx 已于 2026-11-01 随月配额面板一起删除，
 *        fixture 不该依赖任何真实文件的存在。）
 *   3. **正则里不能用 `[^)]` / `[^}]` 跨嵌套括号。**
 *      `((m) => ({ default: m.X }))` 里两种括号都有，任何单一排除都会在中间截断。
 *
 * 这三条都不会让脚本崩溃，只会让判据**静默失效** —— 所以必须用测试钉死。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vg = require('../lib/visualLayerGraph');

// ── fixture 工具 ──────────────────────────────────────────────────────────────
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vlg-'));
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    written.push(abs);
  }
  return { dir, written };
}

// ═════════════════════════════════════════════════════════════════════════════
// checkStillLazy
// ═════════════════════════════════════════════════════════════════════════════

test('checkStillLazy：组件名与文件名不同时，按 .then 里的 default: m.X 识别', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { lazy } from 'react'",
      "const ContextUsagePanel = lazy(() =>",
      "  import('./components/message/ContextUsage').then((m) => ({ default: m.ContextUsagePanel }))",
      ')',
      '',
    ].join('\n'),
  });
  try {
    const res = vg.checkStillLazy(
      [{ file: 'App.tsx', components: ['ContextUsagePanel'] }],
      dir
    );
    assert.equal(res.length, 1);
    assert.equal(res[0].ok, true, '应识别为 lazy import');
    assert.match(res[0].reason, /lazy import/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkStillLazy：同一文件里两个导出（文件名与组件名都不同）也能分别识别', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { lazy } from 'react'",
      "const DiffSummary = lazy(() =>",
      "  import('./components/message/DiffViewer').then((m) => ({ default: m.DiffSummary }))",
      ')',
      '',
    ].join('\n'),
  });
  try {
    const res = vg.checkStillLazy(
      [{ file: 'App.tsx', components: ['DiffSummary'] }],
      dir
    );
    assert.equal(res[0].ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkStillLazy：静态 import（回退）必须判为 false 并给出原因', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { SettingsPage } from './components/settings/SettingsPage'",
      '',
    ].join('\n'),
  });
  try {
    const res = vg.checkStillLazy(
      [{ file: 'App.tsx', components: ['SettingsPage'] }],
      dir
    );
    assert.equal(res[0].ok, false, '静态 import 必须判为非懒加载');
    assert.match(res[0].reason, /已无懒加载/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkStillLazy：动态 import()（Vue 形态）也算按需加载', () => {
  const { dir } = makeFixture({
    'router.js': ["component: () => import('@/views/AIChat.vue')", ''].join('\n'),
  });
  try {
    const res = vg.checkStillLazy(
      [{ file: 'router.js', components: ['AIChat'] }],
      dir
    );
    assert.equal(res[0].ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkStillLazy：文件不存在时判为 false 而不是抛错', () => {
  const { dir } = makeFixture({ 'a.txt': 'x' });
  try {
    const res = vg.checkStillLazy([{ file: 'nope.tsx', components: ['X'] }], dir);
    assert.equal(res[0].ok, false);
    assert.match(res[0].reason, /文件不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// findLazyCandidates
// ═════════════════════════════════════════════════════════════════════════════

test('findLazyCandidates：条件渲染的组件被识别为候选并量出传递重量', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { Panel } from './Panel';",
      'export function App({ show }) {',
      '  return <div>{show && <Panel />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Panel.tsx': [
      "import { deep } from './deep';",
      'export function Panel() { return <div>{deep()}</div>; }',
      '',
    ].join('\n'),
    'deep.tsx': 'export function deep() { return 1; }\n',
  });
  try {
    const nodes = new Set([
      path.join(dir, 'App.tsx'),
      path.join(dir, 'Panel.tsx'),
      path.join(dir, 'deep.tsx'),
    ]);
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set([path.join(dir, 'Panel.tsx')])],
      [path.join(dir, 'Panel.tsx'), new Set([path.join(dir, 'deep.tsx')])],
      [path.join(dir, 'deep.tsx'), new Set()],
    ]);
    const lineCount = new Map([
      [path.join(dir, 'App.tsx'), 4],
      [path.join(dir, 'Panel.tsx'), 1],
      [path.join(dir, 'deep.tsx'), 1],
    ]);
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    const panel = rows.find((r) => r.comp === 'Panel');
    assert.ok(panel, 'Panel 应被识别为候选');
    assert.equal(panel.transitFiles, 2, '传递闭包应含 Panel 与 deep');
    assert.ok(panel.transitLines >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLazyCandidates：已经在懒加载的组件不是候选（避免把已完成的刀反复报成待办）', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { lazy } from 'react';",
      "const Panel = lazy(() => import('./Panel').then((m) => ({ default: m.Panel })));",
      'export function App({ show }) {',
      '  return <div>{show && <Panel />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Panel.tsx': 'export function Panel() { return null; }\n',
  });
  try {
    const nodes = new Set([path.join(dir, 'App.tsx'), path.join(dir, 'Panel.tsx')]);
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set()],
      [path.join(dir, 'Panel.tsx'), new Set()],
    ]);
    const lineCount = new Map([
      [path.join(dir, 'App.tsx'), 6],
      [path.join(dir, 'Panel.tsx'), 1],
    ]);
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    assert.equal(
      rows.find((r) => r.comp === 'Panel'),
      undefined,
      '已懒加载的 Panel 不应再出现在候选里'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLazyCandidates：被入口静态引用但条件渲染的组件仍是候选（占比低于首屏主体阈值）', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { Composer } from './Composer';",
      "import { Filler } from './Filler';",
      'export function App({ show }) {',
      '  return <div><Filler />{show && <Composer />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Composer.tsx': 'export function Composer() { return null; }\n',
    // 撑大入口闭包，使 Composer 的占比远低于 20% 阈值
    'Filler.tsx': 'export function Filler() { return null; }\n'.repeat(40),
  });
  try {
    const nodes = new Set([path.join(dir, 'App.tsx'), path.join(dir, 'Composer.tsx'), path.join(dir, 'Filler.tsx')]);
    const filler = path.join(dir, 'Filler.tsx');
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set([path.join(dir, 'Composer.tsx'), filler])],
      [path.join(dir, 'Composer.tsx'), new Set()],
      [filler, new Set()],
    ]);
    const lineCount = new Map([
      [path.join(dir, 'App.tsx'), 5],
      [path.join(dir, 'Composer.tsx'), 1],
      [filler, 100],
    ]);
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    const composer = rows.find((r) => r.comp === 'Composer');
    assert.ok(composer, '条件渲染的 Composer 应是候选');
    assert.equal(
      composer.isFirstScreenBody,
      false,
      '条件渲染的组件不算首屏主体 —— 它本来就是「按需才用」的形态'
    );
    assert.equal(composer.verdict, 'safe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLazyCandidates：被多处静态引用的组件判为「共用基础设施」', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { Icon } from './Icon';",
      'export function App({ show }) {',
      '  return <div>{show && <Icon />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Icon.tsx': 'export function Icon() { return null; }\n',
    'B.tsx': "import { Icon } from './Icon';\nexport function B() { return <Icon />; }\n",
    'C.tsx': "import { Icon } from './Icon';\nexport function C() { return <Icon />; }\n",
  });
  try {
    const nodes = new Set(
      ['App.tsx', 'Icon.tsx', 'B.tsx', 'C.tsx'].map((f) => path.join(dir, f))
    );
    const icon = path.join(dir, 'Icon.tsx');
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set([icon])],
      [path.join(dir, 'B.tsx'), new Set([icon])],
      [path.join(dir, 'C.tsx'), new Set([icon])],
      [icon, new Set()],
    ]);
    const lineCount = new Map([...nodes].map((f) => [f, 1]));
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    const r = rows.find((x) => x.comp === 'Icon');
    assert.ok(r);
    assert.equal(r.verdict, 'shared-infra');
    assert.ok(r.inboundCount >= 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLazyCandidates：副作用带完整 cleanup 时不算阻塞项', () => {
  const { dir } = makeFixture({
    // 静态 import + 条件渲染 —— 这才是「候选」的真实形态。
    // （lazy 引入的组件按定义不是候选：它已经是按需加载了。）
    'App.tsx': [
      "import { Dialog } from './Dialog';",
      "import { Filler } from './Filler';",
      'export function App({ show }) {',
      '  return <div><Filler />{show && <Dialog />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Dialog.tsx': [
      "import { useEffect } from 'react';",
      'export function Dialog() {',
      '  useEffect(() => {',
      '    const t = setInterval(() => {}, 1000);',
      '    return () => clearInterval(t);',
      '  }, []);',
      '  return null;',
      '}',
      '',
    ].join('\n'),
    'Filler.tsx': 'export function Filler() { return null; }\n'.repeat(40),
  });
  try {
    const nodes = new Set([path.join(dir, 'App.tsx'), path.join(dir, 'Dialog.tsx'), path.join(dir, 'Filler.tsx')]);
    const filler = path.join(dir, 'Filler.tsx');
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set([path.join(dir, 'Dialog.tsx'), filler])],
      [path.join(dir, 'Dialog.tsx'), new Set()],
      [filler, new Set()],
    ]);
    const lineCount = new Map([
      [path.join(dir, 'App.tsx'), 5],
      [path.join(dir, 'Dialog.tsx'), 9],
      [filler, 100],
    ]);
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    const d = rows.find((r) => r.comp === 'Dialog');
    assert.ok(d, 'Dialog 应被识别为候选');
    assert.equal(d.hasCleanup, true, '应检出 clearInterval cleanup');
    assert.deepEqual(d.blockingEffects, [], '有 cleanup 时不应有阻塞项');
    assert.equal(d.verdict, 'safe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLazyCandidates：副作用无 cleanup 时判为「需人判」', () => {
  const { dir } = makeFixture({
    'App.tsx': [
      "import { Widget } from './Widget';",
      "import { Filler } from './Filler';",
      'export function App({ show }) {',
      '  return <div><Filler />{show && <Widget />}</div>;',
      '}',
      '',
    ].join('\n'),
    'Widget.tsx': [
      "import { useEffect } from 'react';",
      'export function Widget() {',
      '  useEffect(() => { window.addEventListener("x", () => {}); }, []);',
      '  return null;',
      '}',
      '',
    ].join('\n'),
    'Filler.tsx': 'export function Filler() { return null; }\n'.repeat(40),
  });
  try {
    const nodes = new Set([path.join(dir, 'App.tsx'), path.join(dir, 'Widget.tsx'), path.join(dir, 'Filler.tsx')]);
    const filler = path.join(dir, 'Filler.tsx');
    const staticEdges = new Map([
      [path.join(dir, 'App.tsx'), new Set([path.join(dir, 'Widget.tsx'), filler])],
      [path.join(dir, 'Widget.tsx'), new Set()],
      [filler, new Set()],
    ]);
    const lineCount = new Map([
      [path.join(dir, 'App.tsx'), 5],
      [path.join(dir, 'Widget.tsx'), 5],
      [filler, 100],
    ]);
    const rows = vg.findLazyCandidates(
      staticEdges, nodes, lineCount, nodes, dir, [path.join(dir, 'App.tsx')]
    );
    const w = rows.find((r) => r.comp === 'Widget');
    assert.ok(w);
    assert.equal(w.hasCleanup, false);
    assert.ok(w.blockingEffects.length > 0);
    assert.equal(w.verdict, 'needs-human');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// assignLayers / attributeEntry（既有能力的回归）
// ═════════════════════════════════════════════════════════════════════════════

test('assignLayers：同层内可达归本层，跨层根不入本层', () => {
  const { dir } = makeFixture({
    'V0.js': "require('./V0leaf');\n",
    'V0leaf.js': 'export const a = 1;\n',
    'V1.js': "require('./V1leaf');\n",
    'V1leaf.js': 'export const b = 1;\n',
  });
  try {
    const v0 = path.join(dir, 'V0.js');
    const v0leaf = path.join(dir, 'V0leaf.js');
    const v1 = path.join(dir, 'V1.js');
    const v1leaf = path.join(dir, 'V1leaf.js');
    const nodes = new Set([v0, v0leaf, v1, v1leaf]);
    const staticEdges = new Map([
      [v0, new Set([v0leaf])],
      [v0leaf, new Set()],
      [v1, new Set([v1leaf])],
      [v1leaf, new Set()],
    ]);
    const assign = vg.assignLayers(staticEdges, nodes, [
      { id: 'V0', roots: [v0] },
      { id: 'V1', roots: [v1] },
    ]);
    assert.equal(assign.get(v0leaf), 'V0');
    assert.equal(assign.get(v1leaf), 'V1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attributeEntry：按可达重量降序给出直接依赖', () => {
  const { dir } = makeFixture({
    'Entry.js': "require('./Heavy');\nrequire('./Light');\n",
    'Heavy.js': "require('./HeavyLeaf');\n",
    'HeavyLeaf.js': 'export const x = 1;\n',
    'Light.js': 'export const y = 1;\n',
  });
  try {
    const entry = path.join(dir, 'Entry.js');
    const heavy = path.join(dir, 'Heavy.js');
    const heavyLeaf = path.join(dir, 'HeavyLeaf.js');
    const light = path.join(dir, 'Light.js');
    const nodes = new Set([entry, heavy, heavyLeaf, light]);
    const staticEdges = new Map([
      [entry, new Set([heavy, light])],
      [heavy, new Set([heavyLeaf])],
      [heavyLeaf, new Set()],
      [light, new Set()],
    ]);
    const lineCount = new Map([
      [entry, 2],
      [heavy, 1],
      [heavyLeaf, 100],
      [light, 1],
    ]);
    const rows = vg.attributeEntry(staticEdges, nodes, lineCount, entry);
    assert.equal(rows[0].file, heavy, '可达重量最大的应排第一');
    assert.ok(rows[0].reachableLines > rows[1].reachableLines);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── classifyVisualEdges：视觉侧的加载时机判定 ────────────────────────────────
// 2026-10-31：视觉侧从「括号深度」换到 AST（与逻辑侧同源）。
// 换的理由与逻辑侧完全一样：**括号深度 ≠ 函数作用域**。
// 视觉侧还多三条语义差异：ESM import 是**提升**的、ESM 重导出也是提升的、
// 类型导入会被**擦除**。这三条都会改变「静态边 vs 动态边」的归属，必须逐条钉死。

test('classifyVisualEdges：顶层 try{} 里的 require 是静态边（装载期）', () => {
  const r = vg.classifyVisualEdges('a.js', "try { require('./x'); } catch {}\n");
  assert.equal(r.mode, 'ast');
  assert.deepEqual([...r.staticSpecs], ['./x']);
  assert.equal(r.dynamicSpecs.size, 0);
});

test('classifyVisualEdges：函数体内的 require 是动态边', () => {
  const r = vg.classifyVisualEdges('a.js', "function f(){ return require('./y'); }\n");
  assert.deepEqual([...r.dynamicSpecs], ['./y']);
  assert.equal(r.staticSpecs.size, 0);
});

test('classifyVisualEdges：注释里的 require 不是边（旧正则会把它当真边）', () => {
  // 实测踩到：caretGeometry.js 的注释写着「本叶子绝不 require('./PromptFrame')」，
  // 旧口径的正则匹配到了注释文本 ⇒ 生成一条指向自己的假静态边 ——
  // 测量工具读到了架构注释，并把它当成了代码。
  const r = vg.classifyVisualEdges('a.js', "// 绝不 require('./PromptFrame')\nconst a = require('./real');\n");
  assert.deepEqual([...r.staticSpecs], ['./real']);
});

test('classifyVisualEdges：ESM import 是提升的 ⇒ 恒为静态边', () => {
  const r = vg.classifyVisualEdges('a.ts', "import { X } from './x';\nfunction f(){ return X; }\n");
  assert.deepEqual([...r.staticSpecs], ['./x']);
  assert.equal(r.dynamicSpecs.size, 0);
});

test('classifyVisualEdges：ESM 重导出（export ... from）是提升的 ⇒ 静态边', () => {
  const r = vg.classifyVisualEdges('a.ts', "export { X } from './x';\nexport * from './y';\n");
  assert.deepEqual([...r.staticSpecs].sort(), ['./x', './y']);
});

test('classifyVisualEdges：类型导入被擦除 ⇒ 不构成运行时边', () => {
  const r = vg.classifyVisualEdges('a.ts', "import type { T } from './types';\nimport { X } from './x';\n");
  assert.deepEqual([...r.staticSpecs], ['./x']);
});

test('classifyVisualEdges：动态 import() 恒为动态边', () => {
  const r = vg.classifyVisualEdges('a.tsx', "const P = lazy(() => import('./p'));\n");
  assert.deepEqual([...r.dynamicSpecs], ['./p']);
  assert.equal(r.staticSpecs.size, 0);
});

test('classifyVisualEdges：.vue 的 script 块能解析，且 lang="ts" 走 TS 语法', () => {
  // `lang="ts"` 在**标签内部** —— 只看标签之前的文本会漏掉，
  // 于是按 flow 解析、interface 直接解析失败（实测 MobileToast.vue 因此降级）。
  const vue = '<template><div/></template>\n<script lang="ts">\ninterface P { a: string }\nconst x = 1;\n</script>\n';
  const r = vg.classifyVisualEdges('a.vue', vue);
  assert.equal(r.mode, 'ast', 'lang=ts 必须被识别，否则 interface 会解析失败而降级');
});

test('classifyVisualEdges：只有 template 的 SFC 没有边，但不算降级', () => {
  const r = vg.classifyVisualEdges('a.vue', '<template><div/></template>\n');
  assert.equal(r.mode, 'ast');
  assert.equal(r.staticSpecs.size, 0);
  assert.equal(r.dynamicSpecs.size, 0);
});
