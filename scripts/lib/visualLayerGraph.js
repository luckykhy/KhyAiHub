'use strict';

const fs = require('fs');
const path = require('path');

const requireGraph = require('./requireGraph');

/**
 * visualLayerGraph — 视觉层静态加载图的纯叶子分析器
 *
 * 为 `scripts/ci/check-core-layers.js` 提供视觉侧的度量能力，与逻辑侧对称。
 *
 * 【为什么需要单独一个模块】
 * 逻辑侧是 CJS require，视觉侧有三种栈：桌面端 React（ESM import）、
 * web 前端 Vue（SFC + 路由懒加载）、TUI Ink（CJS require）。
 * 统一口径只有一条：**静态边 vs 动态边**。
 *   静态边 = 顶层 import / require 字面量 → 决定首屏冷闭包与 bundle 体积
 *   动态边 = import() → 按需加载
 * 逻辑侧（顶层 require vs 函数内 require）与视觉侧（静态 import vs 动态 import）
 * 是同一个「加载时机」概念的两种语法表现，故用同一套预算语义。
 *
 * 【纯叶子契约】零 IO 副作用、无全局状态、绝不抛；所有 IO 只读。
 */

// ── 语法 ────────────────────────────────────────────────────────────────────
// 顶层 import：import X from 'y' / import {a,b} from 'y' / import 'y'
const RE_IMPORT = /^\s*import\s+(?:[^'";]*?\s+from\s+)?(['"])([^'";\n]+)\1/gm;
// CJS require
const RE_REQUIRE = /require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
// 动态 import()
const RE_DYNAMIC = /import\(\s*(['"])([^'"\n]+)\1\s*\)/g;

const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs', '.cjs'];

/** AST 里算「函数体」的节点类型（与逻辑侧 requireGraph 同口径） */
const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
]);

/**
 * 计算每个字符所在的括号深度，用来区分**顶层 require** 与**函数内懒加载 require**。
 *
 * ## 为什么必须区分
 *
 * 首版把**所有** `require()` 都当成静态边 —— 于是：
 *   ① 「静态冷闭包」被高估（懒加载的模块也算进来了）；
 *   ② 方向判据把懒加载边误报成静态越界（实测误报 1 条：
 *      `tui/runtime/sidebarRail.js → ink-components/SidebarPanel.js`
 *      其实那条 require 在函数体内，是懒加载）。
 *
 * 逻辑侧（check-core-layers.js）用的是同一套口径 —— 两边必须一致，
 * 否则「视觉与逻辑同理」就只在文档上成立。
 *
 * 深度 0 = 顶层（模块一装载即求值）；深度 > 0 = 懒加载（只在调用路径上求值）。
 */
function braceDepthMap(src) {
  const d = new Array(src.length).fill(0);
  let cur = 0;
  let inStr = null;
  let inTpl = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      d[i] = cur;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && nx === '/') {
        inBlock = false;
        i++;
      }
      d[i] = cur;
      continue;
    }
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      d[i] = cur;
      continue;
    }
    if (inTpl) {
      if (ch === '\\') i++;
      else if (ch === '`') inTpl = false;
      d[i] = cur;
      continue;
    }
    if (ch === '/' && nx === '/') {
      inLine = true;
      d[i] = cur;
      continue;
    }
    if (ch === '/' && nx === '*') {
      inBlock = true;
      d[i] = cur;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      d[i] = cur;
      continue;
    }
    if (ch === '`') {
      inTpl = true;
      d[i] = cur;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') cur++;
    else if (ch === '}' || ch === ')' || ch === ']') cur--;
    d[i] = cur;
  }
  return d;
}

/**
 * AST 口径的视觉边分类（与逻辑侧同源）。
 *
 * ## 为什么视觉侧也要换口径
 *
 * 逻辑侧在 2026-10-31 查清：旧口径用「require 处的括号深度」区分顶层/懒加载，
 * 而**括号深度 ≠ 函数作用域** —— 顶层 try{} 块、多行解构赋值里的 require 被误判成
 * 懒加载（低估），而**正则字面量里的括号**会让深度整体偏移、把函数体内的 require
 * 误判成顶层（虚高，最多差 2.4 倍）。
 *
 * 视觉侧当时写着「与逻辑侧同口径」，实际用的却是同一份有缺陷的实现 ——
 * **一份写着「同口径」却跑着另一套语义的契约，等于没有契约**。
 * 故一并换掉。
 *
 * ## 视觉侧与逻辑侧的三点不同（必须显式处理，不能照抄）
 *
 *   ① **ESM import 是提升的（hoisted）** —— `import X from './x'` 无论写在模块的哪一行、
 *      哪怕写在函数体内，它都在**模块求值时**执行 ⇒ **永远是装载期边**。
 *      逻辑侧的「函数体内 = 懒加载」规则对 ESM 不适用。
 *   ② **ESM 重导出也是提升的** —— `export { a } from './x'` / `export * from './x'`
 *      同样是装载期边。旧口径的正则**完全没统计这类边**（本仓实测 0 条，
 *      但那是运气，不是口径正确）。
 *   ③ **类型导入会被擦除** —— `import type { T } from './x'` 编译后不存在，
 *      不构成运行时边（否则会凭空多出一条静态边）。
 *
 * ## 降级
 *
 * 解析器不可用或某个文件解析失败 ⇒ 该文件回退到旧的括号深度口径，
 * 并把 mode 记为 'brace-depth'。**不静默降级**：调用方须把它报出来
 * （守卫有 `visual-classifier-degraded` 告警）。
 *
 * @param {string} file 源文件绝对路径
 * @param {string} src 源码
 * @returns {{staticSpecs: Set<string>, dynamicSpecs: Set<string>, mode: 'ast'|'brace-depth'}}
 */
function classifyVisualEdges(file, src) {
  const parser = requireGraph.getParser();
  if (!parser) return classifyVisualEdgesByDepth(file, src);

  const isVue = file.endsWith('.vue');
  let code = src;
  let tsx = false;
  let ts = false;

  if (isVue) {
    const m = /<script([^>]*)>([\s\S]*?)<\/script>/i.exec(src);
    if (!m) {
      // 只有 <template>/<style> 的 SFC —— 没有任何 JS 边
      return { staticSpecs: new Set(), dynamicSpecs: new Set(), mode: 'ast' };
    }
    code = m[2];
    // ⚠ `lang="ts"` 在**标签内部**（`<script lang="ts">`），必须从标签属性里读 ——
    // 只看标签之前的文本会漏掉，于是按 flow 解析，`interface Props` 直接解析失败
    // （实测 MobileToast.vue 因此降级）。降级不是错，但它是**不该发生**的降级。
    ts = /lang\s*=\s*["']ts["']/i.test(m[1] || '');
  } else {
    ts = file.endsWith('.ts') || file.endsWith('.tsx');
    tsx = file.endsWith('.tsx');
  }

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [
        ts ? ['typescript', { isTSX: tsx }] : 'flow',
        'jsx',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'classStaticBlock',
        'optionalChaining',
        'nullishCoalescingOperator',
        'topLevelAwait',
        'objectRestSpread',
        'numericSeparator',
        'logicalAssignment',
        'dynamicImport',
      ],
    });
  } catch {
    return classifyVisualEdgesByDepth(file, src);
  }

  const staticSpecs = new Set();
  const dynamicSpecs = new Set();

  const walk = (node, fnDepth) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, fnDepth);
      return;
    }
    if (typeof node.type !== 'string') return;
    const childDepth = FUNCTION_NODE_TYPES.has(node.type) ? fnDepth + 1 : fnDepth;

    // ① ESM import 声明 —— 提升 ⇒ 永远是装载期；类型导入被擦除 ⇒ 不算边
    if (node.type === 'ImportDeclaration' && node.source && node.source.value) {
      if (node.importKind !== 'type') staticSpecs.add(node.source.value);
    }
    // ② ESM 重导出 —— 同样提升
    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && node.source && node.source.value
    ) {
      if (node.exportKind !== 'type') staticSpecs.add(node.source.value);
    }
    // ③ require / import()
    if (node.type === 'CallExpression' && node.callee) {
      const callee = node.callee;
      if (callee.type === 'Import' || callee.type === 'ImportExpression') {
        const a = node.arguments && node.arguments[0];
        if (a && a.type === 'StringLiteral') dynamicSpecs.add(a.value);
      } else if (callee.type === 'Identifier' && callee.name === 'require') {
        const a = node.arguments && node.arguments[0];
        if (a && a.type === 'StringLiteral') {
          // CJS require：不在函数体内 = 装载期；在函数体内 = 懒加载
          (fnDepth === 0 ? staticSpecs : dynamicSpecs).add(a.value);
        }
      }
    }
    if (node.type === 'ImportExpression' && node.source && node.source.type === 'StringLiteral') {
      dynamicSpecs.add(node.source.value);
    }

    for (const key of Object.keys(node)) {
      if (
        key === 'loc' || key === 'start' || key === 'end' || key === 'range'
        || key === 'leadingComments' || key === 'trailingComments'
        || key === 'innerComments' || key === 'extra' || key === 'comments'
      ) continue;
      const value = node[key];
      if (value && typeof value === 'object') walk(value, childDepth);
    }
  };

  walk(ast.program, 0);
  return { staticSpecs, dynamicSpecs, mode: 'ast' };
}

/**
 * 回退口径：正则 + 括号深度（**仅在 AST 不可用/解析失败时使用**）。
 * 与逻辑侧同理：调用方必须把 mode 报出来，不许静默降级。
 *
 * @param {string} file 源文件绝对路径
 * @param {string} src 源码
 * @returns {{staticSpecs: Set<string>, dynamicSpecs: Set<string>, mode: 'brace-depth'}}
 */
function classifyVisualEdgesByDepth(file, src) {
  const staticSpecs = new Set();
  const dynamicSpecs = new Set();
  for (const m of src.matchAll(RE_IMPORT)) {
    if (m[2].startsWith('.')) staticSpecs.add(m[2]);
  }
  const dm = braceDepthMap(src);
  for (const m of src.matchAll(RE_REQUIRE)) {
    if (!m[2].startsWith('.')) continue;
    if ((dm[m.index] || 0) === 0) staticSpecs.add(m[2]);
    else dynamicSpecs.add(m[2]);
  }
  for (const m of src.matchAll(RE_DYNAMIC)) {
    if (m[2].startsWith('.')) dynamicSpecs.add(m[2]);
  }
  return { staticSpecs, dynamicSpecs, mode: 'brace-depth' };
}

/**
 * @param {string} dir 递归根
 * @returns {string[]} 源文件绝对路径（跳过 node_modules / dist）
 */
function walkSources(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      walkSources(p, out);
    } else if (EXTENSIONS.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 解析一个相对说明符到实际文件
 * @returns {string|null}
 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const x of EXTENSIONS) candidates.push(base + x);
  for (const x of EXTENSIONS) candidates.push(path.join(base, 'index' + x));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * 构建视觉侧静态图
 * @param {string[]} roots 需要纳入图的目录根
 * @returns {{nodes: Set<string>, staticEdges: Map<string, Set<string>>, dynamicEdges: Map<string, Set<string>>, lineCount: Map<string, number>}}
 */
function buildVisualGraph(roots) {
  const all = [];
  for (const r of roots) walkSources(r, all);
  const nodes = new Set(all);
  const staticEdges = new Map();
  const dynamicEdges = new Map();
  const lineCount = new Map();
  let degradedFiles = 0; // 解析失败/解析器不可用而回退到括号深度口径的文件数

  for (const f of all) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    lineCount.set(f, src.split('\n').length);
    // 分类口径：**AST**（与逻辑侧同源）。ESM import/重导出是提升的 ⇒ 装载期；
    // CJS require 按函数作用域分；import() 恒为动态边。详见 classifyVisualEdges。
    const cls = classifyVisualEdges(f, src);
    if (cls.mode !== 'ast') degradedFiles++;
    const statSpecs = cls.staticSpecs;
    const dynSpecs = cls.dynamicSpecs;
    const resolved = new Set();
    for (const spec of statSpecs) {
      const r = resolveRelative(f, spec);
      if (r && nodes.has(r)) resolved.add(r);
    }
    const resolvedDyn = new Set();
    for (const spec of dynSpecs) {
      const r = resolveRelative(f, spec);
      if (r && nodes.has(r)) resolvedDyn.add(r);
    }
    staticEdges.set(f, resolved);
    dynamicEdges.set(f, resolvedDyn);
  }
  return { nodes, staticEdges, dynamicEdges, lineCount, degradedFiles };
}

/**
 * 闭包计算
 * @param {Map} edges 边表
 * @param {string} root 起点
 * @param {Set<string>} nodes 节点全集
 * @returns {Set<string>}
 */
function closureOf(edges, root, nodes) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f) || !nodes.has(f)) continue;
    seen.add(f);
    for (const d of edges.get(f) || []) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

/**
 * 闭包重量
 * @returns {{files: number, lines: number, set: Set<string>}}
 */
function weigh(closure, lineCount) {
  let lines = 0;
  for (const f of closure) lines += lineCount.get(f) || 0;
  return { files: closure.size, lines, set: closure };
}

/**
 * 给视觉层文件打归属标签。
 *
 * ## 为什么需要「归属」而不是「闭包」
 *
 * 方向判据问的是「A 层的东西依赖了 B 层的东西」，但闭包会**互相重叠**：
 * V0 视觉芯的静态闭包里会包含 V2 的根（因为 V0 的组件引用了它们），
 * 于是「V0 不得依赖 V2」按闭包判会误报成 25 条。
 *
 * 正确做法与逻辑侧一致：**先判归属，再判边**。
 *   1. 每个层的根 → 该层的锚点；
 *   2. 从锚点出发 BFS，**只走本层内**（遇到别的层的根就停）；
 *   3. 一个文件被多层认领时，取**更内层**（V0 > V1 > V2）。
 *
 * @param {Map<string, Set<string>>} staticEdges 静态边表
 * @param {Set<string>} nodes 节点全集
 * @param {Array<{id: string, roots: string[]}>} layers 层定义（roots 为绝对路径）
 * @returns {Map<string, string>} file → layerId
 */
function assignLayers(staticEdges, nodes, layers) {
  const assign = new Map();
  const rootLayer = new Map();

  for (const layer of layers) {
    for (const root of layer.roots || []) {
      if (!nodes.has(root)) continue;
      rootLayer.set(root, layer.id);
      assign.set(root, layer.id);
    }
  }

  const order = new Map(layers.map((l, i) => [l.id, i])); // 越小越内层
  const inner = (a, b) => (order.get(a) ?? 99) <= (order.get(b) ?? 99);

  for (const [root, layerId] of rootLayer) {
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      for (const d of staticEdges.get(f) || []) {
        if (seen.has(d)) continue;
        // 别的层的根 → 不纳入本层（那是「依赖别的层」，由方向判据管）
        if (rootLayer.has(d) && rootLayer.get(d) !== layerId) continue;
        seen.add(d);
        stack.push(d);
      }
    }
    for (const f of seen) {
      if (!assign.has(f) || inner(layerId, assign.get(f))) assign.set(f, layerId);
    }
  }
  return assign;
}

/**
 * 加载归因：对某个入口，算出它的每个**直接依赖**各拽进多少重量。
 *
 * ## 为什么需要它
 *
 * 静态闭包只回答「总共多重」，不回答「**下一刀该砍谁**」。
 * 逻辑侧有对应的运行时归因（scripts/lib/runtimeFootprint.js 拦 Module._load），
 * 视觉侧此前没有 —— 于是选刀只能靠「哪些页面看起来低频」的直觉。
 *
 * 本函数给出**机械的**选刀依据：入口的直接依赖里，谁的可达重量最大，
 * 谁就是下一刀的候选；再叠加「它是不是按需才用」的判读即可。
 *
 * @param {Map<string, Set<string>>} staticEdges 静态边表
 * @param {Set<string>} nodes 节点全集
 * @param {Map<string, number>} lineCount 每文件行数
 * @param {string} entry 入口文件
 * @returns {Array<{file: string, direct: number, reachable: number, reachableLines: number}>}
 */
function attributeEntry(staticEdges, nodes, lineCount, entry) {
  const directSet = staticEdges.get(entry) || new Set();
  const rows = [];
  for (const d of directSet) {
    const reach = closureOf(staticEdges, d, nodes);
    let lines = 0;
    for (const x of reach) lines += lineCount.get(x) || 0;
    rows.push({ file: d, direct: directSet.size, reachable: reach.size, reachableLines: lines });
  }
  rows.sort((a, b) => b.reachableLines - a.reachableLines);
  return rows;
}

/**
 * 扫出「本可以懒加载」的候选组件。
 *
 * ## 为什么需要它
 *
 * 归因（attributeEntry）回答「哪个直接依赖最重」，
 * 但重量排序 ≠ 可切清单 —— 排第一的可能是首屏主体（拆它等于拆首屏），
 * 也可能带订阅型副作用（条件挂载会漏订阅）。
 *
 * 本函数把「能不能切」变成**机器可判**的三问：
 *   1. 它是不是**条件渲染**的？（`{cond && <X/>}` 或 `{cond ? <X/> : ...}`）
 *   2. 它有多重？（改 lazy 能省多少传递依赖）
 *   3. 它有没有**订阅型副作用**？（useEffect / addEventListener / setInterval / window.*）
 *      —— 有的话条件挂载会漏订阅，**不能切**。
 *
 * ## 三条切法判据（与契约 visual.lazyLoadSafety 一致）
 *   ① 不显示时确实不渲染任何东西（return null 语义）
 *   ② 挂载/卸载不会漏掉或重复注册订阅型副作用
 *   ③ 没有依赖常驻的状态（快捷键注册、全局单例）
 * 本函数只自动判 ②（副作用扫描）；①③ 仍需人判，故结论分 safe/needs-human。
 *
 * @param {Map<string, Set<string>>} staticEdges 静态边表
 * @param {Set<string>} nodes 节点全集
 * @param {Map<string, number>} lineCount 每文件行数
 * @param {Set<string>} closure 只在首屏闭包内找候选
 * @param {string} repoRoot 用于相对化路径
 * @param {string[]} [entryRoots] 入口根（用于识别「首屏主体」——被入口直接引用的组件）
 * @returns {Array<{comp: string, file: string, transitFiles: number, transitLines: number,
 *   selfLines: number, sideEffects: string[], verdict: 'safe'|'needs-human'|'shared-infra'|'first-screen-body'}>}
 */
function findLazyCandidates(staticEdges, nodes, lineCount, closure, repoRoot, entryRoots) {
  // 条件渲染的两种形态
  const RE_AND = /\{[^{}]*&&\s*\(?\s*<([A-Z][A-Za-z0-9_]*)/g;
  const RE_TERNARY = /\?\s*\(?\s*<([A-Z][A-Za-z0-9_]*)/g;
  // 订阅型副作用标记
  const RE_EFFECT = [
    ['useEffect', /\buseEffect\s*\(/],
    ['addEventListener', /\baddEventListener\s*\(/],
    ['setInterval', /\bsetInterval\s*\(/],
    ['window.*', /\bwindow\./],
  ];
  // **cleanup 完整**的副作用标记 —— 有对应的清理函数时，条件挂载不会「漏订阅」，
  // 反而更正确（组件不挂载 ⇒ 副作用本就不该跑）。
  // 典型：ProcessMonitorDialog 的 1s 轮询 + Esc 监听，都带 cleanup，
  // 常驻挂载反而让对话框关着时还在轮询。
  const RE_CLEANUP = [
    ['clearInterval', /\bclearInterval\s*\(/],
    ['clearTimeout', /\bclearTimeout\s*\(/],
    ['removeEventListener', /\bremoveEventListener\s*\(/],
  ];

  const found = new Map(); // comp → {file, forms:Set}
  for (const f of closure) {
    if (!/\.(tsx|jsx)$/.test(f)) continue;
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const [re, form] of [[RE_AND, 'and'], [RE_TERNARY, 'ternary']]) {
      for (const m of src.matchAll(re)) {
        const key = `${m[1]}@${f}`;
        if (!found.has(key)) found.set(key, { comp: m[1], file: f, forms: new Set() });
        found.get(key).forms.add(form);
      }
    }
  }

  const rows = [];
  const seen = new Set();
  for (const { comp, file, forms } of found.values()) {
    // 组件自身的文件：comp 名 → 同目录下同名文件，或该文件导出的名字
    let self = null;
    for (const cand of closure) {
      if (!/\.(tsx|jsx)$/.test(cand)) continue;
      const base = path.basename(cand).replace(/\.(tsx|jsx)$/, '');
      if (base === comp) { self = cand; break; }
    }
    if (!self) continue;

    // 已经在懒加载的组件不是「候选」—— 它已经是按需加载了。
    // 不排除的话，扫描器会把已完成的刀反复报成待办。
    //
    // ⚠ 要查的是**导入方文件**（`file`，即条件渲染发生的那个文件）里的 lazy，
    //   不是组件自身文件（`self`）—— `lazy()` 写在导入方。
    //   查错对象 ⇒ 排除逻辑恒不命中 ⇒ 已完成的刀被反复报成待办。
    let importerSrc = '';
    try {
      importerSrc = fs.readFileSync(file, 'utf8');
    } catch { /* ignore */ }
    const importerLazies = /\blazy\s*\(/.test(importerSrc);
    const importerDynamic = /\bimport\s*\(/.test(importerSrc);
    if (importerLazies || importerDynamic) {
      // 导入方确实在做懒加载 —— 但要确认**这个组件**在那批懒加载里，
      // 否则（导入方为别的组件 lazy）它仍然是候选。
      const compLazy = new RegExp(
        `lazy\\s*\\(\\s*\\(\\)\\s*=>\\s*import\\([^)]*${comp}\\b`
      ).test(importerSrc);
      const compDynamic = new RegExp(`import\\(\\s*['"][^'"]*${comp}\\b`).test(importerSrc);
      if (compLazy || compDynamic) continue;
    }

    // 组件自身文件的内容（副作用扫描用）
    let selfSrc = '';
    try {
      selfSrc = fs.readFileSync(self, 'utf8');
    } catch { /* ignore */ }

    const sideEffects = [];
    for (const [name, re] of RE_EFFECT) {
      if (re.test(selfSrc)) sideEffects.push(name);
    }
    // 有 cleanup 的副作用不算阻塞项：条件挂载时 cleanup 会跑，
    // 不存在「漏订阅」；反而常驻挂载会让本不该跑的副作用一直跑。
    const hasCleanup = RE_CLEANUP.some(([, re]) => re.test(selfSrc));
    const blockingEffects = hasCleanup ? [] : sideEffects;

    // 同一组件在多个文件被条件渲染 → 只留一次（取传递重量最大的那次）
    const dedupKey = self;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // **共用基础设施不是候选**：若该组件被首屏闭包内 ≥N 个模块静态引用，
    // 它就是人人要用的基础件（典型：Icon 329 行，被 26 个文件引用）。
    // 把它改成懒加载不仅没收益（每个用它的模块都要等它加载），
    // 还会把「一个必用组件」变成「N 处异步等待」。
    const inbound = new Set();
    for (const [from, tos] of staticEdges) {
      if (tos.has(self)) inbound.add(from);
    }
    const isSharedInfra = inbound.size >= 3;

    // **首屏主体不是候选**：首屏主体的特征是「它在首屏的每个形态里都在」。
    // 典型：Composer（消息输入框，空态居中 / 有消息在底部 —— 两个分支都要它）、
    //       AppHeader（会话头部）、ModeSelector（模式选择器）。
    // 把它摘掉等于把首屏的主交互变成异步 —— 不是瘦身，是劣化。
    //
    // 判据（两条满足其一即是首屏主体）：
    //   A. 被入口根静态引用，且其传递重量占入口闭包的 ≥SHARE_PCT（首屏大头）；
    //   B. 被入口根静态引用，且入口根里**没有**条件渲染它（无条件 ⇒ 永远在首屏）。
    //
    // ⚠ 「条件渲染」本身**不足以**判定它是候选 —— Composer 就是条件渲染的，
    //   但它在首屏的两种形态里都出现，摘掉它会延迟首屏主交互。
    const SHARE_PCT = 20;
    // 占比要**按该组件所属的那个入口根**算，不能把所有入口根的闭包加在一起 ——
    // 那是 11 个根的总和，分母被稀释得离谱，Composer 的 25% 会掉到 2%，
    // 判据就永远不触发（实测踩过）。
    const entryRootFor = (entryRoots || []).find((r) =>
      (staticEdges.get(r) || new Set()).has(self)
    );
    let entryShare = 0;
    if (entryRootFor) {
      const c = closureOf(staticEdges, entryRootFor, nodes);
      for (const x of c) entryShare += lineCount.get(x) || 0;
    }
    const sub0 = closureOf(staticEdges, self, nodes);
    let selfLines0 = 0;
    for (const x of sub0) selfLines0 += lineCount.get(x) || 0;
    const sharePct = entryShare > 0 ? (selfLines0 / entryShare) * 100 : 0;

    const isFirstScreenBody = (entryRoots || []).some((r) => {
      if (!(staticEdges.get(r) || new Set()).has(self)) return false;
      let rootSrc = '';
      try {
        rootSrc = fs.readFileSync(r, 'utf8');
      } catch { /* ignore */ }
      const condRe = new RegExp(`\\{[^{}]*&&\\s*\\(?\\s*<${comp}\\b`);
      const ternRe = new RegExp(`\\?\\s*\\(?\\s*<${comp}\\b`);
      const renderedConditionally = condRe.test(rootSrc) || ternRe.test(rootSrc);
      // A：首屏大头（条件渲染也算 —— Composer 正是这种）
      if (sharePct >= SHARE_PCT) return true;
      // B：入口无条件渲染它
      return !renderedConditionally;
    });

    const sub = closureOf(staticEdges, self, nodes);
    let transitLines = 0;
    for (const x of sub) transitLines += lineCount.get(x) || 0;

    rows.push({
      comp,
      file: path.relative(repoRoot, file).split(path.sep).join('/'),
      selfFile: path.relative(repoRoot, self).split(path.sep).join('/'),
      selfLines: lineCount.get(self) || 0,
      transitFiles: sub.size,
      transitLines,
      forms: [...forms],
      sideEffects,
      hasCleanup,
      blockingEffects,
      inboundCount: inbound.size,
      isSharedInfra,
      isFirstScreenBody,
      sharePct: Math.round(sharePct * 10) / 10,
      verdict: isSharedInfra
        ? 'shared-infra'
        : isFirstScreenBody
          ? 'first-screen-body'
          : blockingEffects.length === 0
            ? 'safe'
            : 'needs-human',
    });
  }
  rows.sort((a, b) => b.transitLines - a.transitLines);
  return rows;
}

/**
 * 检查一批「文件 + 组件」是否**仍然是懒加载**的（防回退）。
 *
 * 契约 `visual.lazyLoadSafety.safe` 列的是「已确认可懒加载」的组件，
 * 形如「App.tsx: SettingsPage / AutomationsPage / KeyManagerPage」——
 * 意思是**在 App.tsx 里，这几个组件是懒加载引入的**。
 *
 * ⚠ 关键：`lazy()` 写在**导入方**文件里，不在被导入的组件文件里。
 * 所以检查对象是「导入方文件里对该组件名的 lazy import 还在不在」，
 * 而不是「组件文件自己有没有 lazy」。
 *
 * 若有人把 `lazy(() => import('./SettingsPage'))` 改回
 * `import { SettingsPage } from './SettingsPage'`，重量棘轮会**事后**抓到
 * （首屏闭包变大）；本函数给**事前**的直接信号。
 *
 * @param {Array<{file: string, components: string[]}>} entries
 *   file 为仓库相对路径，components 为组件名列表
 * @param {string} repoRoot
 * @returns {Array<{file: string, component: string, ok: boolean, reason: string}>}
 */
function checkStillLazy(entries, repoRoot) {
  const out = [];
  for (const entry of entries) {
    const abs = path.join(repoRoot, entry.file);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      out.push({
        file: entry.file,
        component: entry.components.join(','),
        ok: false,
        reason: '文件不存在',
      });
      continue;
    }
    // 该文件里所有 lazy(() => import('...').then(m => ({default: m.X}))) 的 **组件名 X**
    // ⚠ 不能用「文件名 basename == 组件名」来匹配 —— 现实里两者常不同：
    //   DiffSummary       来自 ./components/message/DiffViewer（一个文件两个导出）
    //   TerminalPanel     来自 ../terminal/Terminal
    // 所以认的是 `.then(... => ({ default: m.X }))` 里**显式写的 X**。
    //
    // ⚠⚠ 正则里**不能**用 `[^)]` / `[^}]` 去跨嵌套括号：
    //   `((m) => ({ default: m.X }))` 里既有 `)` 也有 `}`，
    //   任何单一字符类的排除都会在中间截断，导致匹配失败。
    //   故改成**两步法**：① 定位 `lazy(` 的起点；② 从该点起在有限窗口内
    //   找 `default:` 后面的**属性名**（形如 `default: m.X` ⇒ 取 X）。
    //   ⚠ 不能只抓 `default:\s*(\w+)` —— 那会抓到参数名 `m`（`default: m.X` 的 `m`）。
    const lazyTargets = new Set();
    const RE_LAZY_START = /lazy\s*\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g;
    const RE_DEFAULT_PROP = /default:\s*\w+\.(\w+)/g;
    const LAZY_WINDOW = 260; // 一次 lazy 声明的合理长度上限
    for (const m of src.matchAll(RE_LAZY_START)) {
      // 无 .then 形态：组件名 = 文件名 basename
      const base = path.basename(m[1]).replace(/\.(tsx|jsx|ts|js|vue)$/, '');
      lazyTargets.add(base);
      // 有 .then 形态：在窗口内找 default: m.X 里的 X
      const window = src.slice(m.index, m.index + LAZY_WINDOW);
      const d = RE_DEFAULT_PROP.exec(window);
      if (d) lazyTargets.add(d[1]);
      RE_DEFAULT_PROP.lastIndex = 0;
    }
    // 动态 import('...') 的目标（Vue / 其他框架的按需加载形态）
    const dynTargets = new Set();
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      dynTargets.add(path.basename(m[1]).replace(/\.(tsx|jsx|ts|js|vue)$/, ''));
    }

    for (const comp of entry.components) {
      const ok = lazyTargets.has(comp) || dynTargets.has(comp);
      out.push({
        file: entry.file,
        component: comp,
        ok,
        reason: ok
          ? lazyTargets.has(comp)
            ? 'lazy import'
            : 'dynamic import'
          : '**已无懒加载 —— 静态 import 会把重量拉回首屏**',
      });
    }
  }
  return out;
}

module.exports = {
  walkSources,
  resolveRelative,
  buildVisualGraph,
  classifyVisualEdges,
  closureOf,
  weigh,
  assignLayers,
  attributeEntry,
  findLazyCandidates,
  checkStillLazy,
  EXTENSIONS,
};
