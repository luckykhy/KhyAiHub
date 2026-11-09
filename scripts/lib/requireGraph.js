'use strict';

/**
 * requireGraph — require 边的「装载期 / 延迟」分类（纯叶子，无副作用）
 *
 * 为 `scripts/ci/check-core-layers.js` 提供**函数作用域准确**的 require 边分类。
 *
 * ## 为什么不能用「括号深度」
 *
 * 早期版本用「require 调用处的括号深度」判定顶层/懒加载：
 *   深度 0 ⇒ 顶层（模块一装载即求值）；深度 > 0 ⇒ 懒加载。
 *
 * 这个口径**同时错两个方向**（实测 2026-10-31，四个层根全部对不上）：
 *
 *   ① **漏判**：模块顶层的 `try { require('x') } catch {}` 深度是 1，
 *      但它在**模块求值时**就会执行 —— 是装载期重量，却被记成懒加载。
 *      实例：`bin/khy.js` 的 windowsSpawnHardening / moduleSelfHeal /
 *      startupPhases / debugLog 四个 require 全在 try 块里，
 *      旧口径把它们全当成了懒加载，**入口冷闭包少算了 5 个文件**。
 *
 *   ② **误判**：`if (x) { require('y') }` 这类顶层条件块，深度 > 0，
 *      旧口径记成懒加载 —— 方向同 ①。真正的误判在另一侧：
 *      顶层 `try{}` 里的 require 被记成懒加载后，它的**传递依赖**也不在冷闭包里，
 *      于是冷闭包被系统性低估。
 *
 * 实测差异（AST 口径 vs 括号深度口径）：
 *   L0 bin/khy.js          3 文件 /  2602 行  →   8 文件 /  3512 行
 *   L1 toolUseLoopCore.js  170 文件 / 91608 行 →  71 文件 / 30175 行
 *   L1 aiGateway.js        100 文件 / 50928 行 → 122 文件 / 71078 行
 *
 * ⇒ 同一套「位置规则」下重量能差 2 倍，且**方向不确定** —— 这样的数字不能当预算。
 *
 * ## 本模块的口径
 *
 * **顶层边（装载期）** = 该 require 调用**不在任何函数体内**。
 * 它一定在模块求值时执行（无论它在 `try{}` / `if{}` 块里）。
 * **懒加载边** = 该 require 在某个函数体内 ⇒ 只在被调用时求值。
 *
 * 判定靠 AST（@babel/parser），不是靠括号深度 —— 这正是与旧口径的根本差别。
 *
 * ## 依赖
 *
 * @babel/parser 是 **后端包的直接依赖**（runtime/node/backend/package.json），
 * 从后端目录解析，不靠「恰好被提升到根 node_modules」的运气。
 * 解析不到时**不静默降级**：本模块返回 `mode: 'brace-depth'`，
 * 由调用方决定是告警还是失败 —— 静默降级会让守卫的数字在两台机器上不可比。
 *
 * ## 已知盲区（写在这里，别再踩）
 *
 *   - 顶层 IIFE（`(() => { require('x') })()`）在装载期执行，但箭头函数体算「函数体内」
 *     ⇒ 被记成懒加载边（**低估装载期重量**）。
 *   - 类字段初始化器里的 require 在**实例化**时执行（延迟），
 *     但 AST 看不见「类体不是函数体」⇒ 被记成顶层边（**高估装载期重量**）。
 *   - 动态 require（`require(spec)`，spec 是变量）无法静态解析 ⇒ 只计数，不进边集。
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..', 'runtime/node/backend');

/** AST 里算「函数体」的节点类型 */
const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
]);

let _parser;
let _parserResolved = false;

/**
 * 解析 @babel/parser。优先从后端包解析（它是后端的直接依赖），
 * 退而求其次才用默认解析（根 node_modules）。
 *
 * @returns {object|null} parser 实例；解析不到返回 null
 */
function getParser() {
  if (_parserResolved) return _parser;
  _parserResolved = true;
  for (const paths of [[BACKEND], undefined]) {
    try {
      const spec = paths
        ? require.resolve('@babel/parser', { paths })
        : require.resolve('@babel/parser');
      _parser = require(spec);
      return _parser;
    } catch {
      /* 试下一个 */
    }
  }
  _parser = null;
  return _parser;
}

/** 解析器是否可用 */
function hasParser() {
  return getParser() != null;
}

const PARSE_PLUGINS = [
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'classStaticBlock',
  'optionalChaining',
  'nullishCoalescingOperator',
  'dynamicImport',
  'topLevelAwait',
  'objectRestSpread',
  'numericSeparator',
  'logicalAssignment',
];

/**
 * 用 AST 提取 require 调用，按「是否在函数体内」分成顶层/懒加载。
 *
 * @param {string} src 源码
 * @returns {{top: string[], lazy: string[], dynamic: number, mode: 'ast'|'brace-depth'}}
 */
function classifyByAst(src) {
  const parser = getParser();
  const ast = parser.parse(src, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: PARSE_PLUGINS,
  });

  const top = [];
  const lazy = [];
  let dynamic = 0;

  const walk = (node, fnDepth) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, fnDepth);
      return;
    }
    if (typeof node.type !== 'string') return;

    const childDepth = FUNCTION_NODE_TYPES.has(node.type) ? fnDepth + 1 : fnDepth;

    if (
      node.type === 'CallExpression'
      && node.callee
      && node.callee.type === 'Identifier'
      && node.callee.name === 'require'
    ) {
      const arg = node.arguments && node.arguments[0];
      if (arg && arg.type === 'StringLiteral') {
        (fnDepth === 0 ? top : lazy).push(arg.value);
      } else {
        // 动态 require：无法静态解析，只计数
        dynamic++;
      }
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
  return { top, lazy, dynamic, mode: 'ast' };
}

/**
 * 回退口径：括号深度。**只在 AST 解析器不可用时使用**，
 * 且调用方必须把 `mode` 报出来（不许静默降级）。
 *
 * @param {string} src 源码
 * @returns {{top: string[], lazy: string[], dynamic: number, mode: 'brace-depth'}}
 */
function classifyByBraceDepth(src) {
  const top = [];
  const lazy = [];
  let dynamic = 0;
  const dm = braceDepthMap(src);
  const re = /require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (const m of src.matchAll(re)) {
    if ((dm[m.index] || 0) === 0) top.push(m[2]);
    else lazy.push(m[2]);
  }
  // 动态 require 计数（AST 口径才有这个字段，回退时用正则粗数）
  for (const m of src.matchAll(/require\(\s*[^'")\s]/g)) dynamic++;
  return { top, lazy, dynamic, mode: 'brace-depth' };
}

/**
 * 计算每个字符所在的括号深度（回退口径用）。
 *
 * @param {string} src 源码
 * @returns {number[]} 每字符的括号深度
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

const _classifyCache = new Map();

/**
 * 取一个文件的 require 分类（按文件路径缓存）。
 *
 * @param {string} file 文件绝对路径
 * @param {string} [src] 源码（不传则读盘）
 * @returns {{top: string[], lazy: string[], dynamic: number, mode: 'ast'|'brace-depth'}}
 */
function classifyFile(file, src) {
  if (_classifyCache.has(file)) return _classifyCache.get(file);
  let text = src;
  if (text == null) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      const empty = { top: [], lazy: [], dynamic: 0, mode: 'unreadable' };
      _classifyCache.set(file, empty);
      return empty;
    }
  }
  let result;
  try {
    result = classifyByAst(text);
  } catch {
    // AST 解析失败（如语法超出插件集）→ 回退，但要在 mode 里体现出来
    result = classifyByBraceDepth(text);
    result.mode = 'brace-depth';
  }
  _classifyCache.set(file, result);
  return result;
}

/** 清空缓存（测试用） */
function clearCache() {
  _classifyCache.clear();
}

module.exports = {
  getParser,
  hasParser,
  classifyByAst,
  classifyByBraceDepth,
  classifyFile,
  braceDepthMap,
  clearCache,
};
