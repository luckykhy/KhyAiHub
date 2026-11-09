#!/usr/bin/env node
/**
 * check-core-layers.js — 洋葱分层契约守卫
 *
 * 契约真源：docs/10_规范/registry/CORE-LAYERS.json
 *
 * 守住三条：
 *   1. 芯纯净（L0 purity）      —— L0 不得依赖 L1/L2；L1 不得依赖 L2。
 *   2. 重量预算（core budget）  —— L0/L1 的「冷闭包」（仅顶层 require 边）不得超基线。
 *   3. 倒挂棘轮（inversion）     —— 已知倒挂边只许减不许增，归零后从基线移除。
 *
 * 为什么要有第 2 条：仓库原有的层级守卫（check-repo-layout / archDebtScan R1 / DOMAIN-DEPS）
 * 全部管的是**位置与方向**，没有一根轴管**重量**。结果是位置越理越清、重量一路涨到
 * 73 万行冷可达。本守卫把重量变成可机判的量。
 *
 * 为什么必须区分顶层/懒加载 require：实测 `khy` 全入口的冷闭包是 3 文件 2602 行，
 * 而把懒加载边也算进去是 2170 文件 73 万行 —— 差 280 倍。不区分加载时机，
 * 「重量」这个数字本身就没有意义，预算也就无从谈起。
 *
 * 用法：
 *   node scripts/ci/check-core-layers.js              # 全量检查，error 退出 1
 *   node scripts/ci/check-core-layers.js --json       # 机器可读输出
 *   node scripts/ci/check-core-layers.js --report     # 只报告，不判违规（现状盘点）
 *   node scripts/ci/check-core-layers.js --update     # 用当前实测值重写基线（须显式）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const visualLayerGraph = require('../lib/visualLayerGraph');
const requireGraph = require('../lib/requireGraph');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const CONTRACT_PATH = path.join(REPO_ROOT, 'docs/10_规范/registry/CORE-LAYERS.json');
const BACKEND = path.join(REPO_ROOT, 'runtime/node/backend');
const SRC = path.join(BACKEND, 'src');

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const REPORT_ONLY = args.includes('--report');
const UPDATE = args.includes('--update');

// ── 契约 ──────────────────────────────────────────────────────────────────────
let contract;
try {
  contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
} catch (e) {
  console.error(`[core-layers] 无法读取契约 ${path.relative(REPO_ROOT, CONTRACT_PATH)}: ${e.message}`);
  process.exit(2);
}

const LAYERS = contract.layers || [];
const LAYER_BY_ID = new Map(LAYERS.map((l) => [l.id, l]));
const EDGE_POLICY = contract.edgePolicy || {};

// ── 源码扫描 ──────────────────────────────────────────────────────────────────
const REQ = /require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__tests__']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name) && !/\.(test|spec)\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.js', base + '.cjs', base + '.mjs', base + '.json', path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* next */ }
  }
  return null;
}

/**
 * 计算每个字符所在的括号深度，用来区分顶层 require 与函数内懒加载 require。
 * 深度 0 的 require = 顶层边（模块一装载即求值）；深度 > 0 = 懒加载边。
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

const nodeFiles = new Set([...walk(SRC), ...walk(path.join(BACKEND, 'bin'))]);
// package.json 是 CLI 入口的**顶层依赖之一**（bin/khy.js 第 708 行）——
// 每个命令启动都要解析它（实测 245 行）。旧口径的 resolveRel 不认 .json，
// 于是这份「所有命令都付」的重量被整个漏掉 ⇒ 入口重量被低估。
const BACKEND_PACKAGE_JSON = path.join(BACKEND, 'package.json');
if (fs.existsSync(BACKEND_PACKAGE_JSON)) nodeFiles.add(BACKEND_PACKAGE_JSON);
const relTo = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

const topEdges = new Map(); // file -> Set(target)
const lazyEdges = new Map();
const lineCount = new Map();
const classifierStats = { ast: 0, 'brace-depth': 0, unreadable: 0 };

for (const f of nodeFiles) {
  let src;
  try {
    src = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  lineCount.set(f, src.split('\n').length);
  const top = new Set();
  const lazy = new Set();
  // JSON 不是 JS，没有 require 边，但有重量（行数）—— 计入闭包、不进边集。
  if (/\.(js|cjs|mjs)$/.test(f)) {
    // **分类口径：AST 函数作用域**（不是括号深度）。
    //
    // 括号深度口径在长文件里会被字符串/正则里的花括号带偏 —— 深度再也不回 0，
    // 于是文件后半段的 require 全被误判成「顶层边」，冷闭包虚高；
    // 同时 `try { require(...) }` 这类**装载期** require 又被判成懒加载，冷闭包低估。
    // 两个方向都错（实测最多差 2.4 倍）。AST 口径是唯一自洽的判定。
    const cls = requireGraph.classifyFile(f, src);
    classifierStats[cls.mode] = (classifierStats[cls.mode] || 0) + 1;
    for (const spec of cls.top) {
      if (!spec.startsWith('.')) continue;
      const target = resolveRel(f, spec);
      if (!target || !nodeFiles.has(target)) continue;
      top.add(target);
    }
    for (const spec of cls.lazy) {
      if (!spec.startsWith('.')) continue;
      const target = resolveRel(f, spec);
      if (!target || !nodeFiles.has(target)) continue;
      lazy.add(target);
    }
  }
  topEdges.set(f, top);
  lazyEdges.set(f, lazy);
}

function lineOf(f) {
  if (!lineCount.has(f)) {
    try {
      lineCount.set(f, fs.readFileSync(f, 'utf8').split('\n').length);
    } catch {
      lineCount.set(f, 0);
    }
  }
  return lineCount.get(f);
}

/** 冷闭包：只走顶层边 */
function coldClosure(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f) || !nodeFiles.has(f)) continue;
    seen.add(f);
    for (const d of topEdges.get(f) || []) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

/** 可达闭包：顶层边 + 懒加载边（用于倒挂检测） */
function reachClosure(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f) || !nodeFiles.has(f)) continue;
    seen.add(f);
    for (const d of topEdges.get(f) || []) if (!seen.has(d)) stack.push(d);
    for (const d of lazyEdges.get(f) || []) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

// ── 层归属判定 ────────────────────────────────────────────────────────────────
/**
 * 一个文件属于哪一层？
 *
 * 不能按目录硬切：services/tool 既被 L0 用也被 L1 用；src/cli/tui 里既有表现层
 * 组件也有被芯复用的纯算法叶子（如 effectiveDims / railLayout）。
 * 也不能按「谁 require 我」反推：一个文件可被多层引用。
 *
 * 判据是**可达性 + 最内层优先**：
 *   1. 先算出各层的冷闭包（顶层边）。
 *   2. 文件落在哪一层的冷闭包里，它就是那一层的成员。
 *   3. 同时落在多层 → 取最内层（更严格），因为能被芯触达的文件必须按芯的标准要求。
 *   4. 谁都不在 → 不属于任何层，不参与方向判定。
 */
function computeLayerSets() {
  const layerRoots = new Map();
  for (const l of LAYERS) {
    layerRoots.set(l.id, (l.roots || []).map((r) => path.join(REPO_ROOT, r)));
  }
  const coldByLayer = new Map();
  for (const [id, roots] of layerRoots) {
    const set = new Set();
    for (const r of roots) for (const f of coldClosure(r)) set.add(f);
    coldByLayer.set(id, set);
  }
  return coldByLayer;
}

const coldByLayer = computeLayerSets();

/** 文件的最内层归属（'L0' | 'L1' | 'L2' | null） */
const layerOfFileCache = new Map();
function layerOfFile(file) {
  if (layerOfFileCache.has(file)) return layerOfFileCache.get(file);
  let best = null;
  let bestOrder = 99;
  for (const [id, set] of coldByLayer) {
    if (!set.has(file)) continue;
    const o = layerOrder(id);
    if (o < bestOrder) {
      bestOrder = o;
      best = id;
    }
  }
  layerOfFileCache.set(file, best);
  return best;
}

/** 表现层路径特征：TUI / 桌面 / Web 前端 —— 这些是「皮」 */
function isSkinPath(file) {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  return (
    rel.includes('/src/cli/tui/') ||
    rel.includes('apps/khyos-desktop/') ||
    rel.includes('/delivery/web/') ||
    rel.includes('/delivery/channel/')
  );
}

// ── 判据 1：芯纯净 ────────────────────────────────────────────────────────────
function layerOrder(id) {
  const i = LAYERS.findIndex((l) => l.id === id);
  return i < 0 ? 99 : i;
}

const purityFindings = [];
{
  const seenEdge = new Set();
  for (const [from, targets] of topEdges) {
    const fromLayer = layerOfFile(from);
    if (!fromLayer) continue; // 不属于任何层的文件不参与方向判定
    for (const to of targets) {
      const toLayer = layerOfFile(to);
      if (!toLayer || toLayer === fromLayer) continue;
      const allowed = EDGE_POLICY[`${fromLayer}->${toLayer}`];
      if (allowed === false) {
        const key = `${from}|${to}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        purityFindings.push({
          rule: 'core-purity',
          severity: 'error',
          from: relTo(from),
          to: relTo(to),
          edge: `${fromLayer}->${toLayer}`,
          message: `${fromLayer} 依赖 ${toLayer}：${relTo(from)} → ${relTo(to)}`,
        });
      }
    }
  }
}

// ── 判据 2：重量预算 ──────────────────────────────────────────────────────────
const budgetFindings = [];
const measurements = [];
for (const layer of LAYERS) {
  if (!layer.budget || layer.budget.accountingOnly) continue;
  if (layer.budget.perRoot) {
    for (const [rootRel, budget] of Object.entries(layer.budget.perRoot)) {
      const root = path.join(REPO_ROOT, rootRel);
      if (!fs.existsSync(root)) continue;
      const c = coldClosure(root);
      let lines = 0;
      for (const f of c) lines += lineOf(f);
      const rec = {
        layer: layer.id,
        root: rootRel,
        files: c.size,
        lines,
        maxFiles: budget.maxFiles,
        maxLines: budget.maxLines,
        baselineFiles: budget.baselineFiles,
        baselineLines: budget.baselineLines,
      };
      measurements.push(rec);
      if (c.size > budget.maxFiles) {
        budgetFindings.push({
          rule: 'core-budget-files',
          severity: 'error',
          ...rec,
          message: `${layer.id} ${rootRel} 冷闭包 ${c.size} 文件 > 预算 ${budget.maxFiles}`,
        });
      }
      if (lines > budget.maxLines) {
        // 行数给 1% 容差：行数会因换行符（CRLF vs LF）差 1-2 行，
        // 零容差会让守卫因编辑器换行设置而随机红 —— 那等于没有门禁。
        // 文件数仍是零容差（它不随换行符变）。
        const pct = ((lines - budget.maxLines) / budget.maxLines) * 100;
        if (pct > 1) {
          budgetFindings.push({
            rule: 'core-budget-lines',
            severity: 'error',
            ...rec,
            message: `${layer.id} ${rootRel} 冷闭包 ${lines} 行 > 预算 ${budget.maxLines}（超 ${pct.toFixed(2)}%，容差 1%）`,
          });
        }
      }
    }
  } else {
    const roots = (layer.roots || []).map((r) => path.join(REPO_ROOT, r));
    const c = new Set();
    for (const r of roots) for (const f of coldClosure(r)) c.add(f);
    let lines = 0;
    for (const f of c) lines += lineOf(f);
    const rec = {
      layer: layer.id,
      root: (layer.roots || []).join(', '),
      files: c.size,
      lines,
      maxFiles: layer.budget.maxFiles,
      maxLines: layer.budget.maxLines,
      baselineFiles: layer.budget.baselineFiles,
      baselineLines: layer.budget.baselineLines,
    };
    measurements.push(rec);
    if (c.size > layer.budget.maxFiles) {
      budgetFindings.push({
        rule: 'core-budget-files',
        severity: 'error',
        ...rec,
        message: `${layer.id} 冷闭包 ${c.size} 文件 > 预算 ${layer.budget.maxFiles}`,
      });
    }
    if (lines > layer.budget.maxLines) {
      const pct = ((lines - layer.budget.maxLines) / layer.budget.maxLines) * 100;
      if (pct > 1) {
        budgetFindings.push({
          rule: 'core-budget-lines',
          severity: 'error',
          ...rec,
          message: `${layer.id} 冷闭包 ${lines} 行 > 预算 ${layer.budget.maxLines}（超 ${pct.toFixed(2)}%，容差 1%）`,
        });
      }
    }
  }
}

// ── 判据 2b：入口顶层 require 预算 ───────────────────────────────────────────
// 「入口的顶层 require」= **不在任何函数体内**的 require —— 它们在**每个命令**
// 启动时都会求值。这份重量由所有人承担，是剥洋葱时最该先减的那一份。
//
// 为什么要单独一条（冷闭包预算答不了）：
//   冷闭包预算答的是「整个闭包有多重」，涨了只告诉你「变重了」；
//   这条答的是「**谁把它挂到顶层的**」—— 入口新增一个顶层 require，
//   是让**所有命令**都多付一份重量，且这种重量不会因为「那条路径用不到」而消失。
//   它是剥洋葱的第一刀，也是最容易被人无意间捅破的一刀。
//
// 口径与冷闭包一致（AST 函数作用域）：入口的顶层 require 闭包 = 装载期重量。
const entryFindings = [];
const entryMeasurement = [];
{
  const entryBudget = (contract.entryBudget) || null;
  const entryRel = (entryBudget && entryBudget.entry) || 'runtime/node/backend/bin/khy.js';
  const entryFile = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(entryFile)) {
    entryFindings.push({
      rule: 'core-entry-missing',
      severity: 'error',
      message: `契约 entryBudget.entry 指向的文件不存在：${entryRel}`,
    });
  } else {
    // 入口的直接顶层 require（只看第一方；node 内置不计重量）
    const direct = [];
    for (const spec of (requireGraph.classifyFile(entryFile).top || [])) {
      if (!spec.startsWith('.')) continue;
      const target = resolveRel(entryFile, spec);
      if (!target || !nodeFiles.has(target)) continue;
      direct.push({ spec, target });
    }
    const directLines = direct.reduce((sum, d) => sum + lineOf(d.target), 0);
    // 入口的顶层 require 闭包（只沿顶层边走）—— 「所有命令都付」的那一份
    const closure = coldClosure(entryFile);
    const closureDeps = new Set([...closure].filter((f) => f !== entryFile));
    let closureLines = 0;
    for (const f of closure) closureLines += lineOf(f);
    const closureDepLines = closureLines - lineOf(entryFile);

    const rec = {
      entry: entryRel,
      topLevelRequires: direct.length,
      topLevelLines: directLines,
      coldClosureFiles: closure.size,
      coldClosureLines: closureLines,
      coldClosureDepFiles: closureDeps.size,
      coldClosureDepLines: closureDepLines,
      maxTopLevelRequires: entryBudget ? entryBudget.maxTopLevelRequires : null,
      maxTopLevelLines: entryBudget ? entryBudget.maxTopLevelLines : null,
    };
    entryMeasurement.push(rec);

    if (entryBudget) {
      if (
        entryBudget.maxTopLevelRequires != null
        && direct.length > entryBudget.maxTopLevelRequires
      ) {
        entryFindings.push({
          rule: 'core-entry-toplevel-requires',
          severity: 'error',
          ...rec,
          direct: direct.map((d) => `${d.spec} → ${relTo(d.target)}`),
          message:
            `入口 ${entryRel} 的顶层 require 有 ${direct.length} 个 > 预算 ${entryBudget.maxTopLevelRequires}`
            + ' —— 顶层 require 的重量由**所有命令**承担，不是只有走那条路径的命令',
        });
      }
      if (entryBudget.maxTopLevelLines != null && directLines > entryBudget.maxTopLevelLines) {
        const pct = ((directLines - entryBudget.maxTopLevelLines) / entryBudget.maxTopLevelLines) * 100;
        if (pct > 1) {
          entryFindings.push({
            rule: 'core-entry-toplevel-lines',
            severity: 'error',
            ...rec,
            message:
              `入口 ${entryRel} 的顶层 require 合计 ${directLines} 行 > 预算 ${entryBudget.maxTopLevelLines}`
              + `（超 ${pct.toFixed(2)}%，容差 1%）`,
          });
        }
      }
    }
  }
}

// ── 判据 3：倒挂棘轮 ──────────────────────────────────────────────────────────
const inversionFindings = [];
{
  const entries = (contract.inversions && contract.inversions.entries) || [];
  for (const e of entries) {
    if (e.status === 'fixed') continue;
    const from = path.join(REPO_ROOT, e.from);
    const to = path.join(REPO_ROOT, e.to);
    if (!fs.existsSync(from) || !fs.existsSync(to)) continue;
    const fromLayer = layerOfFile(from);
    const toLayer = layerOfFile(to);
    // 该边是否仍实际存在（顶层或懒加载）
    const stillTop = (topEdges.get(from) || new Set()).has(to);
    const stillLazy = (lazyEdges.get(from) || new Set()).has(to);
    if (!stillTop && !stillLazy) {
      inversionFindings.push({
        rule: 'inversion-resolved',
        severity: 'info',
        from: e.from,
        to: e.to,
        message: `已知倒挂 ${e.from} → ${e.to} 已不存在，可从基线移除`,
      });
      continue;
    }
    if (stillTop) {
      inversionFindings.push({
        rule: 'inversion-persists',
        severity: 'error',
        from: e.from,
        to: e.to,
        edge: `${fromLayer}->${toLayer}`,
        message: `倒挂边仍以顶层 require 存在：${e.from} → ${e.to}`,
      });
    } else {
      inversionFindings.push({
        rule: 'inversion-lazy',
        severity: 'warning',
        from: e.from,
        to: e.to,
        edge: `${fromLayer}->${toLayer}`,
        message: `倒挂边仍以懒加载存在：${e.from} → ${e.to}`,
      });
    }
  }
}

// ── 判据 5：皮侧门面不得被跨层引用 ───────────────────────────────────────────
/**
 * 下沉手术在 `src/cli/tui/` 留了 8 个 re-export 门面（兼容既有调用路径）。
 * 门面的存在是「兼容」，不是「让人继续走老路」——
 * 若逻辑侧经门面引用通用能力，依赖方向又变成 芯→皮，前面的下沉就白做了。
 *
 * 判据：非皮位置的模块，不得 require 皮侧门面。
 */
const facadeFindings = [];
{
  // 皮侧门面的识别：cli/tui/ 下、文件名属于已知下沉集合的 re-export 门面
  const FACADE_NAMES = new Set([
    'effectiveCols', 'effectiveDims', 'sidebarLayout', 'railLayout',
    'chromeBudget', 'noticeInbox', 'mouseButtons', 'terminalCapabilities',
  ]);
  const isSkinDir = (f) => relTo(f).includes('/src/cli/tui/');
  const facades = new Map();
  for (const f of nodeFiles) {
    if (!isSkinDir(f)) continue;
    const base = path.basename(f).replace(/\.(js|cjs|mjs)$/, '');
    if (!FACADE_NAMES.has(base)) continue;
    // 门面必须是转发到 utils/terminal/ 的 re-export（单行 module.exports = require(...)）
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/module\.exports\s*=\s*require\([^)]*utils\/terminal\//.test(src)) continue;
    if (!facades.has(base)) facades.set(base, f);
  }
  if (facades.size) {
    // 顶层边与懒加载边都要查：跨层引用无论何时求值，方向都是错的
    // （懒加载边一样会把皮拖进芯的可达闭包）。
    for (const [from, targets] of topEdges) {
      if (isSkinDir(from)) continue; // 皮内引用合规
      for (const to of targets) {
        for (const [name, facadePath] of facades) {
          if (to !== facadePath) continue;
          facadeFindings.push({
            rule: 'facade-cross-layer',
            severity: 'error',
            from: relTo(from),
            to: relTo(to),
            message: `${relTo(from)} 跨层引用皮侧门面 ${name}：应直连 utils/terminal/${name}.js`,
          });
        }
      }
    }
    for (const [from, targets] of lazyEdges) {
      if (isSkinDir(from)) continue;
      for (const to of targets) {
        for (const [name, facadePath] of facades) {
          if (to !== facadePath) continue;
          facadeFindings.push({
            rule: 'facade-cross-layer',
            severity: 'error',
            from: relTo(from),
            to: relTo(to),
            message: `${relTo(from)} 跨层引用皮侧门面 ${name}：应直连 utils/terminal/${name}.js`,
          });
        }
      }
    }
  }
}
// ── 判据 4：皮不得渗入芯（逻辑 × 视觉的交叉守卫）────────────────────────────
/**
 * 视觉皮（TUI / 桌面 / Web）的文件，不应出现在逻辑芯的**可达闭包**里。
 *
 * 这条是「逻辑与视觉同理」的落点：逻辑侧被视觉污染，与视觉侧被逻辑污染，
 * 是同一个洋葱被剥错方向的两种表现。
 *
 * 实测依据：核心 toolUseLoopCore 的可达闭包里有 8 个 cli/tui/ 文件
 * （effectiveCols / effectiveDims / railLayout / chromeBudget / sidebarLayout …），
 * 路径为 核心 → AgentTool → cli/ai.js → aiConversationOps → handlers/gateway → cli/tui/。
 * 这几个文件本身是零 IO 的纯布局算法叶子 —— 它们只是**放错了层**（住在皮上，
 * 却被芯引用），而根因仍是 AgentTool 那条 L1→L2 倒挂边。
 */
const skinFindings = [];
{
  const L1_ROOTS = (LAYER_BY_ID.get('L1') || { roots: [] }).roots || [];
  const skinSet = new Set([...nodeFiles].filter(isSkinPath));
  for (const rootRel of L1_ROOTS) {
    const root = path.join(REPO_ROOT, rootRel);
    if (!fs.existsSync(root)) continue;
    const reach = reachClosure(root);
    const leaked = [...reach].filter((f) => skinSet.has(f));
    if (leaked.length === 0) continue;
    skinFindings.push({
      rule: 'skin-into-core',
      severity: 'error',
      from: rootRel,
      count: leaked.length,
      files: leaked.map(relTo),
      message: `${rootRel} 的可达闭包渗入 ${leaked.length} 个视觉皮文件（芯不应知道皮的存在）`,
    });
  }
}

// ── 判据 6：视觉侧（逻辑 × 视觉的对称轴）────────────────────────────────────
/**
 * 视觉侧与逻辑侧同构，判据也对称：
 *   visual-budget      —— V0 视觉芯的冷闭包（仅静态 import/require 边）不得超基线。
 *   skin-into-visual-core —— 「应懒加载的低频页面」不得出现在 V0/V1 的静态冷闭包里。
 *
 * 后者是视觉侧最典型的病：页面用静态 import 引入、只在某个路由下显示，
 * 但首屏 bundle 照样把它拉进来 —— 与逻辑侧「能力放错层导致重量前置」完全同构。
 *
 * 视觉侧的重量口径 = 首屏要付的代价（静态边），动态 import() 不计。
 */
const visualFindings = [];
const visualMeasurements = [];
const visualAttribution = [];
const visualCandidates = [];
{
  const visual = contract.visual || {};
  const roots = [
    path.join(REPO_ROOT, 'apps/khyos-desktop/src'),
    path.join(REPO_ROOT, 'delivery/web/ai-frontend/src'),
    path.join(REPO_ROOT, 'delivery/channel/khyquant/frontend/src'),
    path.join(REPO_ROOT, 'runtime/node/backend/src/cli/tui'),
  ].filter((d) => fs.existsSync(d));

  if (roots.length) {
    const graph = visualLayerGraph.buildVisualGraph(roots);
    const relOf = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

    // 分类口径状态：视觉侧与逻辑侧同源用 AST。解析器不可用/解析失败时
    // 会回退到括号深度口径 —— 那会让「静态边 vs 动态边」的判定不可信，
    // 故必须显式报出来，不许静默降级（与逻辑侧 core-classifier-degraded 同理）。
    if (graph.degradedFiles > 0) {
      visualFindings.push({
        rule: 'visual-classifier-degraded',
        severity: 'warning',
        count: graph.degradedFiles,
        message:
          `${graph.degradedFiles} 个视觉侧文件没能用 AST 解析（@babel/parser 不可用或解析失败），`
          + '已回退到括号深度口径 —— 该口径会把顶层 try{} 里的 require 误判成懒加载，数字不可信',
      });
    }

    // 判据 6a：V0 视觉芯的冷闭包重量预算
    const v0 = (visual.layers || []).find((l) => l.id === 'V0');
    if (v0 && v0.budget && v0.budget.perRoot) {
      for (const [rootRel, budget] of Object.entries(v0.budget.perRoot)) {
        const root = path.join(REPO_ROOT, rootRel);
        if (!fs.existsSync(root)) continue;
        const closure = visualLayerGraph.closureOf(graph.staticEdges, root, graph.nodes);
        const w = visualLayerGraph.weigh(closure, graph.lineCount);
        visualMeasurements.push({
          layer: 'V0',
          root: rootRel,
          files: w.files,
          lines: w.lines,
          maxFiles: budget.maxFiles,
          maxLines: budget.maxLines,
        });
        if (w.files > budget.maxFiles) {
          visualFindings.push({
            rule: 'visual-budget-files',
            severity: 'error',
            message: `V0 ${rootRel} 首屏冷闭包 ${w.files} 文件 > 预算 ${budget.maxFiles}`,
          });
        }
        if (w.lines > budget.maxLines) {
          // 行数给 1% 容差：文件数的**行数**会因换行符（CRLF vs LF）差 1-2 行，
          // 零容差会让守卫因编辑器换行设置而随机红 —— 那等于没有门禁。
          // 文件数仍是零容差（它不随换行符变）。
          const pct = ((w.lines - budget.maxLines) / budget.maxLines) * 100;
          if (pct > 1) {
            visualFindings.push({
              rule: 'visual-budget-lines',
              severity: 'error',
              message: `V0 ${rootRel} 首屏冷闭包 ${w.lines} 行 > 预算 ${budget.maxLines}（超 ${pct.toFixed(2)}%，容差 1%）`,
            });
          }
        }
      }
    }

    // 判据 6b：应懒加载的低频页面不得进 V0/V1 的静态冷闭包
    const v2 = (visual.layers || []).find((l) => l.id === 'V2');
    const lazyRequired = (v2 && v2.budget && v2.budget.lazyRequired) || [];
    if (lazyRequired.length) {
      const lazySet = new Set(lazyRequired.map((p) => path.join(REPO_ROOT, p)));
      const v0roots = (v0 && v0.roots) || [];
      const v1roots = ((visual.layers || []).find((l) => l.id === 'V1') || {}).roots || [];
      for (const rootRel of [...v0roots, ...v1roots]) {
        const root = path.join(REPO_ROOT, rootRel);
        if (!fs.existsSync(root)) continue;
        const closure = visualLayerGraph.closureOf(graph.staticEdges, root, graph.nodes);
        const leaked = [...closure].filter((f) => lazySet.has(f));
        if (!leaked.length) continue;
        visualFindings.push({
          rule: 'skin-into-visual-core',
          severity: 'error',
          from: rootRel,
          count: leaked.length,
          files: leaked.map(relOf),
          message: `${rootRel} 的首屏冷闭包含 ${leaked.length} 个「应懒加载」的低频页面（皮渗入了芯）`,
        });
      }
    }
    // 判据 6c：视觉侧方向矩阵（消费 contract.visual.edgePolicy）
    //
    // 这是逻辑侧 `core-purity` 的**对称镜像**：芯(V0) 不依赖膜(V1) 与皮(V2)，
    // 膜(V1) 不依赖皮(V2)。
    //
    // 契约里定义了矩阵但守卫从不消费它 —— 那是一份**没人执行的契约**，
    // 等于没有约束。故此处补上，让矩阵真正生效。
    //
    // 判定用「归属 + 逐条边」，不用闭包：闭包互相重叠会把 1 条真违例
    // 放大成 25 条误报（V0 闭包含 V2 的根）。归属算法见
    // scripts/lib/visualLayerGraph.js 的 assignLayers。
    const vPolicy = visual.edgePolicy || {};
    if (Object.keys(vPolicy).some((k) => k.includes('->'))) {
      const layerDefs = (visual.layers || []).map((l) => ({
        id: l.id,
        roots: (l.roots || []).map((r) => path.join(REPO_ROOT, r)).filter((r) => fs.existsSync(r)),
      }));
      const assign = visualLayerGraph.assignLayers(graph.staticEdges, graph.nodes, layerDefs);
      const seenEdge = new Set();
      for (const [from, targets] of graph.staticEdges) {
        const fromLayer = assign.get(from);
        if (!fromLayer) continue;
        for (const to of targets) {
          const toLayer = assign.get(to);
          if (!toLayer || toLayer === fromLayer) continue;
          if (vPolicy[`${fromLayer}->${toLayer}`] !== false) continue;
          const key = `${from}|${to}`;
          if (seenEdge.has(key)) continue;
          seenEdge.add(key);
          visualFindings.push({
            rule: 'visual-layer-direction',
            severity: 'error',
            from: relOf(from),
            to: relOf(to),
            edge: `${fromLayer}->${toLayer}`,
            message: `视觉层越界：${relOf(from)}（${fromLayer}）依赖 ${relOf(to)}（${toLayer}）`,
          });
        }
      }
    }
    // 判据 6d：视觉侧加载归因（选刀指引，报告档不阻断）
    //
    // 静态闭包只回答「总共多重」，不回答「下一刀该砍谁」。
    // 逻辑侧有运行时归因（runtimeFootprint.js 拦 Module._load），
    // 视觉侧此前没有 —— 选刀只能靠直觉。本判据给出机械依据：
    // 入口的直接依赖里，谁的可达重量最大，谁就是下一刀候选。
    //
    // 与逻辑侧的 `runtime-attribution-gate` 对称但作用不同：
    //   逻辑侧：盯闸门**不许变大**（约束）
    //   视觉侧：给出**下一刀候选**（指引）—— 视觉层的重量天然会随功能长，
    //           只锁不许减没有意义，要告诉人往哪儿砍。
    const vAttr = (visual.layers || []).find((l) => l.id === 'V0');
    if (vAttr && vAttr.budget && vAttr.budget.perRoot) {
      for (const rootRel of Object.keys(vAttr.budget.perRoot)) {
        const root = path.join(REPO_ROOT, rootRel);
        if (!fs.existsSync(root)) continue;
        const rows = visualLayerGraph.attributeEntry(graph.staticEdges, graph.nodes, graph.lineCount, root);
        if (!rows.length) continue;
        const worst = rows[0];
        visualAttribution.push({
          root: rootRel,
          worst: relOf(worst.file),
          worstReachable: worst.reachable,
          worstReachableLines: worst.reachableLines,
          top: rows.slice(0, 5).map((r) => ({ file: relOf(r.file), lines: r.reachableLines })),
        });
      }
    }
    // 判据 6e：safe 名单防回退 —— 已确认可懒加载的组件必须仍在懒加载
    //
    // 重量棘轮能**事后**抓到「有人把 lazy 改回静态」（闭包变大），
    // 但那是等 PR 跑完才发现。本判据给**事前**的直接信号。
    const safeList = (visual.lazyLoadSafety && visual.lazyLoadSafety.safe) || [];
    // safe 名单是「机器可读」形态：[{file, components:[...], note}]。
    // 若仍是旧的人读串（字符串数组），跳过 —— 不猜格式，避免误报。
    if (safeList.length && safeList.every((e) => e && typeof e === 'object' && e.file && Array.isArray(e.components))) {
      for (const r of visualLayerGraph.checkStillLazy(safeList, REPO_ROOT)) {
        if (!r.ok) {
          visualFindings.push({
            rule: 'visual-lazy-regression',
            severity: 'error',
            from: `${r.file} → ${r.component}`,
            message: `${r.file} 里的 ${r.component} 不再是懒加载（${r.reason}）—— 它在契约的 safe 名单里，静态 import 会把重量拉回首屏`,
          });
        }
      }
    }

    // 判据 6f：懒加载候选扫描（指引，报告档不阻断）
    //
    // 「能不能切」现在是机器判的三问：① 是不是条件渲染的 ② 有多重
    // ③ 有没有订阅型副作用。②③ 自动判；①的「return null 语义」与
    // 「是否依赖常驻状态」仍需人判，故 safe / needs-human 分开报。
    const v0Layer = (visual.layers || []).find((l) => l.id === 'V0');
    if (v0Layer && v0Layer.budget && v0Layer.budget.perRoot) {
      const entryRoots = Object.keys(v0Layer.budget.perRoot)
        .map((r) => path.join(REPO_ROOT, r))
        .filter((f) => fs.existsSync(f));
      for (const rootRel of Object.keys(v0Layer.budget.perRoot)) {
        const root = path.join(REPO_ROOT, rootRel);
        if (!fs.existsSync(root)) continue;
        const closure = visualLayerGraph.closureOf(graph.staticEdges, root, graph.nodes);
        const cands = visualLayerGraph.findLazyCandidates(
          graph.staticEdges, graph.nodes, graph.lineCount, closure, REPO_ROOT, entryRoots
        );
        if (cands.length) {
          visualCandidates.push({
            root: rootRel,
            safe: cands.filter((c) => c.verdict === 'safe').slice(0, 5),
            needsHuman: cands.filter((c) => c.verdict === 'needs-human').slice(0, 5),
            sharedInfra: cands.filter((c) => c.verdict === 'shared-infra').slice(0, 3),
            firstScreenBody: cands.filter((c) => c.verdict === 'first-screen-body').slice(0, 3),
          });
        }
      }
    }
  }
}
// ── 判据 7：文档 ↔ 契约 对账 ─────────────────────────────────────────────────
/**
 * 设计文档里引用的基线数字，必须与契约里的当前值一致。
 *
 * ## 为什么需要这条
 *
 * 「文档说的」与「机器做的」各说各话，是本契约一路在消灭的那类漂移 ——
 * 本轮就实测到两处：契约被 `--update` 更新后（91,540 → 91,608），
 * 文档里还写着旧值。**人不会记得同步，而守卫会。**
 *
 * 判据：在设计文档里找契约给出的基线数字组合（文件数 + 行数），
 * 找不到即红 —— 说明文档里的数字与契约已经漂移。
 */
const docSyncFindings = [];
{
  const docPath = path.join(
    REPO_ROOT,
    'docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-197] 剥洋葱：Khy OS 最小核心与分层重量治理.md'
  );
  if (fs.existsSync(docPath)) {
    const doc = fs.readFileSync(docPath, 'utf8');
    const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    // 契约里所有「文件数 + 行数」的基线组合，逐个在文档里找
    const targets = [];
    for (const layer of LAYERS) {
      if (!layer.budget || !layer.budget.perRoot) continue;
      for (const [rootRel, b] of Object.entries(layer.budget.perRoot)) {
        targets.push({ label: `${layer.id} ${rootRel}`, files: b.maxFiles, lines: b.maxLines });
      }
    }
    const vLayers = (contract.visual && contract.visual.layers) || [];
    for (const layer of vLayers) {
      if (!layer.budget || !layer.budget.perRoot) continue;
      for (const [rootRel, b] of Object.entries(layer.budget.perRoot)) {
        targets.push({ label: `${layer.id} ${rootRel}`, files: b.maxFiles, lines: b.maxLines });
      }
    }

    for (const t of targets) {
      // 文档表格里形如 `| 40 | 9,815 |`（行数可能带 ** 强调）
      const f = String(t.files);
      const l = fmt(t.lines);
      const re = new RegExp(
        `\\|\\s*\\*?\\*?${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?\\*?\\s*\\|\\s*\\*?\\*?${l
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/,/g, ',?')}\\s*\\*?\\*?`
      );
      if (!re.test(doc)) {
        docSyncFindings.push({
          rule: 'doc-contract-drift',
          severity: 'warning',
          message: `设计文档里找不到 ${t.label} 的当前基线（${f} 文件 / ${l} 行）—— 文档与契约可能已漂移`,
        });
      }
    }
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────────
// 分类口径状态：AST 解析器不可用时会静默降级到括号深度 —— 那会让两台机器的
// 数字不可比（且旧口径本身就错）。所以必须显式报出来，不许埋在日志里。
const degradedFiles = (classifierStats['brace-depth'] || 0) + (classifierStats.unreadable || 0);
if (degradedFiles > 0) {
  budgetFindings.push({
    rule: 'core-classifier-degraded',
    severity: 'warning',
    message:
      `${degradedFiles} 个模块没能用 AST 解析（@babel/parser 不可用或解析失败），`
      + '已回退到括号深度口径 —— 该口径会把装载期 require 误判成懒加载，数字不可信',
  });
}

const errors = [
  ...purityFindings,
  ...budgetFindings.filter((f) => f.severity === 'error'),
  ...entryFindings,
  ...skinFindings,
  ...facadeFindings,
  ...visualFindings,
  ...inversionFindings.filter((f) => f.severity === 'error'),
];
const warnings = [
  ...budgetFindings.filter((f) => f.severity === 'warning'),
  ...inversionFindings.filter((f) => f.severity === 'warning'),
  ...docSyncFindings,
];
const infos = inversionFindings.filter((f) => f.severity === 'info');

if (JSON_MODE) {
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        measurements,
        entryMeasurements: entryMeasurement,
        classifier: classifierStats,
        visualMeasurements,
        visualAttribution,
        visualCandidates,
        findings: [
          ...purityFindings,
          ...budgetFindings,
          ...entryFindings,
          ...skinFindings,
          ...facadeFindings,
          ...visualFindings,
          ...inversionFindings,
          ...docSyncFindings,
        ],
      },
      null,
      2
    )
  );
  process.exit(errors.length === 0 ? 0 : 1);
}

console.log('══ 洋葱分层契约检查 ══');
console.log(`契约: ${path.relative(REPO_ROOT, CONTRACT_PATH)}`);
console.log(`扫描: ${nodeFiles.size} 个模块`);
console.log(
  `口径: AST 函数作用域（AST ${classifierStats.ast || 0} 个`
  + `${degradedFiles ? ` / 回退 ${degradedFiles} 个` : ''}）\n`
);

console.log('── 冷闭包重量（仅顶层 require 边）──');
for (const m of measurements) {
  const fPct = ((m.files / m.maxFiles) * 100).toFixed(1);
  const lPct = ((m.lines / m.maxLines) * 100).toFixed(1);
  console.log(
    `  ${m.layer} ${m.root}\n      文件 ${m.files}/${m.maxFiles} (${fPct}%)  行 ${m.lines}/${m.maxLines} (${lPct}%)`
  );
}

if (entryMeasurement.length) {
  console.log('\n── 入口顶层 require（所有命令都付的那一份）──');
  for (const m of entryMeasurement) {
    const rPct = m.maxTopLevelRequires
      ? ((m.topLevelRequires / m.maxTopLevelRequires) * 100).toFixed(1)
      : '-';
    const lPct = m.maxTopLevelLines
      ? ((m.topLevelLines / m.maxTopLevelLines) * 100).toFixed(1)
      : '-';
    console.log(`  ${m.entry}`);
    console.log(
      `      直接顶层 require ${m.topLevelRequires}`
      + `${m.maxTopLevelRequires ? '/' + m.maxTopLevelRequires : ''} (${rPct}%)`
      + `  合计 ${m.topLevelLines} 行`
      + `${m.maxTopLevelLines ? '/' + m.maxTopLevelLines : ''} (${lPct}%)`
    );
    console.log(
      `      顶层闭包 ${m.coldClosureFiles} 文件 / ${m.coldClosureLines} 行`
      + `（其中依赖 ${m.coldClosureDepFiles} 文件 / ${m.coldClosureDepLines} 行）`
    );
  }
}

if (visualMeasurements.length) {
  console.log('\n── 视觉侧首屏冷闭包（仅静态 import/require 边）──');
  for (const m of visualMeasurements) {
    const fPct = ((m.files / m.maxFiles) * 100).toFixed(1);
    const lPct = ((m.lines / m.maxLines) * 100).toFixed(1);
    console.log(
      `  ${m.layer} ${m.root}\n      文件 ${m.files}/${m.maxFiles} (${fPct}%)  行 ${m.lines}/${m.maxLines} (${lPct}%)`
    );
  }
}
if (visualAttribution.length) {
  console.log('\n── 视觉侧下一刀候选（加载归因；只指引，不阻断）──');
  for (const a of visualAttribution) {
    console.log(`  ${a.root}\n      最大直接依赖 ${a.worst}（可达 ${a.worstReachable} 模块 / ${a.worstReachableLines} 行）`);
  }
}
if (visualCandidates.length) {
  console.log('\n── 懒加载候选扫描（条件渲染 × 传递重量 × 副作用；只指引，不阻断）──');
  for (const c of visualCandidates) {
    if (c.safe.length) {
      console.log(`  ${c.root} —— 可切（无订阅型副作用）：`);
      for (const x of c.safe) {
        console.log(`      ${x.comp.padEnd(24)} ${String(x.transitFiles).padStart(3)} 文件 / ${String(x.transitLines).padStart(6)} 行  ${x.selfFile}`);
      }
    }
    if (c.needsHuman.length) {
      console.log(`  ${c.root} —— 需人判（有副作用或依赖常驻状态）：`);
      for (const x of c.needsHuman) {
        console.log(`      ${x.comp.padEnd(24)} ${String(x.transitFiles).padStart(3)} 文件 / ${String(x.transitLines).padStart(6)} 行  副作用: ${x.sideEffects.join(', ') || '（未检出）'}`);
      }
    }
    if (c.sharedInfra.length) {
      console.log(`  ${c.root} —— 共用基础设施（被多处静态引用，不宜懒加载）：`);
      for (const x of c.sharedInfra) {
        console.log(`      ${x.comp.padEnd(24)} ${String(x.transitFiles).padStart(3)} 文件 / ${String(x.transitLines).padStart(6)} 行  被 ${x.inboundCount} 个模块引用`);
      }
    }
    if (c.firstScreenBody.length) {
      console.log(`  ${c.root} —— 首屏主体（被入口直接引用，摘掉等于拆首屏）：`);
      for (const x of c.firstScreenBody) {
        console.log(`      ${x.comp.padEnd(24)} ${String(x.transitFiles).padStart(3)} 文件 / ${String(x.transitLines).padStart(6)} 行`);
      }
    }
  }
}
console.log('');

if (errors.length === 0 && warnings.length === 0 && infos.length === 0) {
  console.log('✅ 芯纯净 · 重量在预算内 · 皮未渗入芯 · 门面无跨层引用 · 视觉侧同构判据通过 · 无倒挂残留');
} else {
  for (const f of infos) console.log(`ℹ️  [${f.rule}] ${f.message}`);
  for (const f of warnings) console.log(`⚠️  [${f.rule}] ${f.message}`);
  for (const f of errors) {
    console.log(`❌ [${f.rule}] ${f.message}`);
    if (f.files && f.files.length <= 12) for (const x of f.files) console.log(`        ${x}`);
  }
}

if (REPORT_ONLY) {
  console.log('\n(报告态：违规不判错)');
  process.exit(0);
}

if (UPDATE) {
  // 用实测值重写基线（显式 --update 才执行）
  //
  // 逻辑侧（L0/L1）：measurements 来自 layer.budget.perRoot。
  for (const m of measurements) {
    const layer = LAYER_BY_ID.get(m.layer);
    if (!layer) continue;
    if (layer.budget.perRoot) {
      const b = layer.budget.perRoot[m.root];
      if (b) {
        b.baselineFiles = m.files;
        b.baselineLines = m.lines;
        b.maxFiles = m.files;
        b.maxLines = m.lines;
      }
    } else {
      layer.budget.baselineFiles = m.files;
      layer.budget.baselineLines = m.lines;
      layer.budget.maxFiles = m.files;
      layer.budget.maxLines = m.lines;
    }
  }

  // 视觉侧（V0）也要能更新 —— 首版只写了逻辑侧，于是视觉预算永远改不动，
  // `--update` 跑完守卫仍然报红（看着像「场景有非确定性」，其实是更新机制不完整）。
  // 这与运行时守卫漏掉 external 字段是同一型 bug。
  //
  // 同时同步 visual.measured.coldClosures：**「文档说的」与「机器做的」必须同源**，
  // 否则契约里会留着一份过期数字（实测踩过：口径修正后该段仍写着 172 文件/5 万行），
  // 而读者会拿它当事实 —— 正是本契约要消灭的那类漂移。
  const visualMeasured = (contract.visual && contract.visual.measured) || (contract.visual.measured = {});
  visualMeasured.coldClosures = visualMeasured.coldClosures || {};
  for (const m of visualMeasurements) {
    visualMeasured.coldClosures[m.root] = { files: m.files, lines: m.lines };
  }
  for (const m of visualMeasurements) {
    const vLayer = ((contract.visual && contract.visual.layers) || []).find((l) => l.id === m.layer);
    if (!vLayer || !vLayer.budget || !vLayer.budget.perRoot) continue;
    const b = vLayer.budget.perRoot[m.root];
    if (!b) continue;
    b.baselineFiles = m.files;
    b.baselineLines = m.lines;
    b.maxFiles = m.files;
    b.maxLines = m.lines;
  }

  // 入口顶层 require 预算也要能更新 —— 否则这条判据的基线永远钉死在一个数字上，
  // 人想「主动认账」也认不了（与运行时守卫漏掉 external 字段同型 bug）。
  for (const m of entryMeasurement) {
    if (!contract.entryBudget) continue;
    contract.entryBudget.maxTopLevelRequires = m.topLevelRequires;
    contract.entryBudget.maxTopLevelLines = m.topLevelLines;
    contract.entryBudget.baselineTopLevelRequires = m.topLevelRequires;
    contract.entryBudget.baselineTopLevelLines = m.topLevelLines;
    contract.entryBudget.measuredAt = new Date().toISOString().slice(0, 10);
  }

  contract.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  console.log(`\n基线已更新 → ${path.relative(REPO_ROOT, CONTRACT_PATH)}`);
}

process.exit(errors.length === 0 ? 0 : 1);
