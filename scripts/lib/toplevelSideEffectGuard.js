'use strict';

/**
 * toplevelSideEffectGuard.js — `RUNTIME-012`「模块顶层副作用」的**纯判定叶子**。
 *
 * 零 IO、零外部依赖（只 `fs`/`path` 都不用，纯字符串处理）、确定性、绝不抛、可离线单测。
 * 读源 / 走盘 / 打印全部在 `scripts/ci/check-toplevel-side-effects.js`；本文件只做判定。
 *
 * ## 判据真源
 *
 * `[DESIGN-ARCH-178] TUI启动44秒病灶…` §3.1 / §4。一句话：
 *
 * > **任何被启动路径 require 的模块，顶层只允许声明与常量初始化；
 * > 禁止在顶层调用会 `require` / `spawn` / `connect` 的函数。**
 *
 * 为什么这条比「逐个修」重要：仓库有 1524 个模块进首帧，只有加门才防得住下一个。
 *
 * ## 病灶实录（2026-10-04 实测）
 *
 * `cacheService.js` 顶层写了 `initRedis();`，而 `initRedis()` 体内
 * `require('redis')` + `createClient()` + `client.connect()`。
 * 后果：`require('cacheService')` 的瞬间同步拉入整棵 redis 依赖树 ——
 * `require.cache` 模块数 **543 → 1**（修掉顶层调用后），单这一条就是 20.4s / 542 模块。
 *
 * ## 为什么必须是「同步可达」而不是「函数体里出现过」
 *
 * 原型 v1 用正则扫函数体**文本**，把 `() => require('./x')` 这种**惰性 thunk** 也算命中
 * —— 实测在 `runtime/node/backend/src` 上 7 条命中里 2 条是假警报
 * （`adapterRegistry._defineBuiltins`、`serviceRegistry._autoRegister` 的 `require`
 * 全在箭头函数里，永不随顶层调用执行）。**低精度守卫比没有守卫更糟**：假警报会被整体绕过。
 *
 * 本叶子改为判「**同步可达**」：命中点若其**语句前缀**里出现过 `=>` 或 `function`，
 * 即视为包在嵌套函数里 ⇒ 不算。方向刻意偏**保守**（宁可漏报，不可误报）：
 * 单行表达式体的箭头函数（`const g = () => require('x'); g();`）会被判成嵌套而漏掉。
 * 这个取舍写进 `LIMITATIONS`，并由 `SCENARIOS` 的 `lazy-thunk` 场景钉死。
 *
 * ⚠ **零依赖是硬约束**：仓库 94 个检查器无一 require 外部 npm 包，且 `scripts/` 里
 * 出现的 `bcryptjs`/`ajv`/`sqlite3` 等全是后端传递依赖，不该被守卫依赖。
 * 原型 v2 曾用 `acorn`（在根 `node_modules` 但**不是**直接依赖）—— 已弃用，
 * 改用本文件的手写词法扫描；并用原型当 oracle 对拍全量结果一致（见 §4 变更日志）。
 */

const SEV = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

/** 阶段常量（唯一权威；`FEATURE-OWNERSHIP.json` 的 rollout 段只是镜像）。 */
const STAGE = 'S1';

/**
 * 判据强度表 —— **唯一**的强度决定点（`PROCESS-006` PP-3）。
 *
 * ⚠ 绝不在判定处写死 `warning`：那会让执行器的 `STAGE` 常量变成**装饰** ——
 * S1 与 S3 跑出完全相同的输出与退出码，升阶后**仍不拦截**，而所有守卫全绿。
 * 验收判据：同一输入在 S1/S3 下 **error 数必须不同**（见测试 `S1/S3 强度差异`）。
 *
 * S1 列刻意让「已知且已裁决」的命中降为 info，于是接线后 baseline 为
 * **0 error / 0 warning / N info** —— 新命中才会以 warning 冒出来。
 * 理由同 `RUNTIME-011` 的 `KNOWN_DRIFTS`：**告警疲劳比不报更糟**。
 */
const CRITERIA = Object.freeze({
  'toplevel-side-effect': { s1: SEV.WARNING, s3: SEV.ERROR },
  'toplevel-side-effect-known': { s1: SEV.INFO, s3: SEV.INFO },
  'source-unreadable': { s1: SEV.WARNING, s3: SEV.ERROR },
  'scan-error': { s1: SEV.WARNING, s3: SEV.ERROR },
  'toplevel-call-imported': { s1: SEV.INFO, s3: SEV.INFO },
});

/** 阶段派生：按 `CRITERIA` 表取值；未知判据一律降为 warning（禁 fail-open 到 error）。 */
function severityFor(criterion, stage = STAGE) {
  const row = CRITERIA[criterion];
  if (!row) return SEV.WARNING;
  return stage === 'S3' || stage === 'S4' ? row.s3 : row.s1;
}

/** 内部 severity 只存小写规范形；渲染时经此映射成**定宽 6 字符**方言。 */
function labelOf(severity) {
  if (severity === SEV.ERROR) return '[ERROR]';
  if (severity === SEV.INFO) return '[INFO ]';
  return '[WARN ]';
}

// ── 关心面 ──────────────────────────────────────────────────────────────────

/**
 * 本守卫扫描的源根（`--changed` 的前缀匹配与登记表 `paths` 共用同一集合）。
 * 刻意只收 **Node 模块**：`delivery/web/*` 是浏览器面（无 `require`），
 * `apps/khyos-desktop` 是 TS/Electron 面，均不适用本判据。
 */
const SCAN_ROOTS = Object.freeze([
  'runtime/node/backend/src',
  'runtime/node/backend/vendor/shared/src',
]);

/** 跳过的路径段（测试永不在启动路径上；且测试文件顶层满是 `describe/it` 调用）。 */
const SKIP_SEGMENTS = Object.freeze(['node_modules', '__tests__', '__mocks__']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?js$/;

// ── 副作用形态 ──────────────────────────────────────────────────────────────

/** 同步可达即算副作用的「自由函数」。 */
const SIDE_EFFECT_FUNCS = Object.freeze([
  'require', 'spawn', 'spawnSync',
  'exec', 'execSync', 'execFile', 'execFileSync',
  'createClient',
]);

/** 同步可达即算副作用的「方法名」（任意对象上）。 */
const SIDE_EFFECT_METHODS = Object.freeze(['connect']);

/**
 * 字符分类查表 —— **别在逐字符循环里跑正则**。
 * 实测（2026-10-04）：`/\s/.test(c)` + `/[\w$]/.test(c)` 在 27MB 语料 / 2700 万字符上
 * 是 **4s 级**开销，占全量扫描 73%。查表后同口径降到 ~0.4s。
 * 只覆盖 ASCII；非 ASCII 走慢路径（Unicode 空白极少见，语义完全一致）。
 */
const CHAR_WS = (() => {
  const t = new Uint8Array(128);
  for (const cc of [9, 10, 11, 12, 13, 32]) t[cc] = 1;
  return t;
})();
const CHAR_WORD = (() => {
  const t = new Uint8Array(128);
  for (let cc = 48; cc <= 57; cc++) t[cc] = 1;    // 0-9
  for (let cc = 65; cc <= 90; cc++) t[cc] = 1;    // A-Z
  for (let cc = 97; cc <= 122; cc++) t[cc] = 1;   // a-z
  t[36] = 1;  // $
  t[95] = 1;  // _
  return t;
})();

/**
 * 已知且**已逐条裁决**的顶层副作用白名单（key = `<仓库相对路径>|<函数名>`）。
 *
 * 为什么需要它：实测 2026-10-04 全仓 4 条命中**没有一条在启动首帧路径上**，
 * 全部是「入口脚本」或「刻意 eager」。若与意外命中同等报 warning，观察者会长期挂着
 * 4 条消不掉的 warning，然后学会无视它。**必须给出处**——无出处的降级等于把判据关掉。
 */
const KNOWN_TOPLEVEL_SIDE_EFFECTS = Object.freeze({
  'runtime/node/backend/src/bootstrap/chalkCompat.js|install':
    '刻意：chalk 兼容 shim 必须在 import 时替换 require.cache，否则后续 '
    + 'require("picocolors") 拿不到兼容版。且本文件被 reportKhyError.js:43 在**函数内**'
    + '惰性 require，不在启动首帧路径上。（[DESIGN-ARCH-178] §3.1 例外条款）',
  'runtime/node/backend/src/migrations/run.js|main':
    '入口脚本：全仓无人 require 它，由 `node migrations/run.js` 直接执行。'
    + '顶层的 `main()` 正是它作为脚本的入口语义。',
  'runtime/node/backend/src/services/accountPool.js|_ensureSubModules':
    '刻意：源码注释即判据 —— 「Eagerly initialize sub-modules so delegated exports '
    + 'work before init()」。且全部引用方都在函数体内惰性 require，不在启动首帧路径上。',
  'runtime/node/backend/src/services/daemonEntry.js|start':
    '入口脚本：全仓无人 require 它，是守护进程的直接入口。',
});

/** 明示的判据边界（诚实标注覆盖面，不假装全知）。 */
const LIMITATIONS = Object.freeze([
  '跨文件间接：顶层调用**从别处 import 的函数**时本叶子不追（只盘点，报 toplevel-call-imported）。',
  '单行表达式箭头：`const g = () => require("x"); g();` 会被判成嵌套而**漏报**（保守方向）。',
  '非块体函数定义：`const g = () => require("x")` 这类表达式体无法界定边界，整体跳过。',
  '顶层 if/try 块内：`if (cond) { initRedis(); }` 的花括号深度为 1，**不判**（保守方向）。',
  '仅扫 SCAN_ROOTS 内的 .js；浏览器面 / TS 面不在判据范围内。',
]);

// ── 词法：把非代码字符涂白（等长，保留偏移与行号）─────────────────────────────

/** 正则字面量可否从 `prev` 之后开始（标准启发式）。 */
function isRegexStart(prev, prevWord) {
  if (!prev) return true;
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
  return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'case', 'do', 'else', 'yield', 'await'].includes(prevWord);
}

/**
 * 把注释 / 字符串 / 模板串 / 正则字面量替换为空格。**输出与输入等长**，
 * 于是所有偏移与行号在涂白文本上依然有效。
 * 模板串整体视为非代码（`${}` 里的代码一并涂白）—— 保守，宁可漏报。
 *
 * ⚠ 实现要点（性能）：**先收集待涂白区间，最后一次性拼接**，不做逐字符数组写入。
 * 初版用 `src.split('')` + `out[k] = ' '` + `join('')`，在 27MB 语料上把每个字符
 * 变成独立字符串对象 ⇒ 实测 **4.5s（占全量扫描 73%）**；改成区间拼接后同口径
 * **≈0.3s**。这是 commit 快档能接受的前提。
 */
function blankNonCode(src) {
  const s = String(src == null ? '' : src);
  const n = s.length;
  const spans = [];
  let i = 0;
  let prev = '';
  let prevWord = '';

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];

    if (c === '/' && c2 === '/') {
      const a = i;
      while (i < n && s[i] !== '\n') i++;
      spans.push([a, i]);
      prev = ''; prevWord = '';
      continue;
    }
    if (c === '/' && c2 === '*') {
      const a = i;
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      if (i < n) i += 2;
      spans.push([a, Math.min(i, n)]);
      prev = ''; prevWord = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      const a = i;
      i++;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      spans.push([a, Math.min(i, n)]);
      prev = q; prevWord = '';
      continue;
    }
    if (c === '/' && isRegexStart(prev, prevWord)) {
      const a = i;
      i++;
      let inClass = false;
      while (i < n) {
        const d = s[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break; // 未闭合 ⇒ 放弃，当除号处理
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      spans.push([a, Math.min(i, n)]);
      prev = '/'; prevWord = '';
      continue;
    }

    const cc = s.charCodeAt(i);
    const isWs = cc < 128 ? CHAR_WS[cc] === 1 : /\s/.test(c);
    if (!isWs) {
      prev = c;
      const isWord = cc < 128 ? CHAR_WORD[cc] === 1 : false;
      if (isWord) {
        const lastCc = prevWord ? prevWord.charCodeAt(prevWord.length - 1) : 0;
        prevWord = (lastCc < 128 && CHAR_WORD[lastCc] === 1 ? prevWord : '') + c;
      } else prevWord = '';
    }
    i++;
  }

  if (!spans.length) return s;
  const parts = [];
  let last = 0;
  for (const [a, b] of spans) {
    if (a > last) parts.push(s.slice(last, a));
    parts.push(s.slice(a, b).replace(/[^\n]/g, ' '));
    last = b;
  }
  if (last < n) parts.push(s.slice(last));
  return parts.join('');
}

// ── 结构：括号配对 / 行号 / 花括号深度 ───────────────────────────────────────

function matchBrace(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

/** 从 `from` 起找第 `startDepth` 层之后的第一个 `{`（params 闭合后）。 */
function findBodyBrace(text, from, startDepth) {
  let d = startDepth;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) { /* params 结束 */ } }
    else if (c === '{' && d === 0) return i;
    else if (c === ';' && d === 0) return -1; // 声明结束还没见到体
    else if (c === ')' && d < 0) return -1;
  }
  return -1;
}

function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * 逐字符的三种括号深度（涂白文本上算，字符串/注释里的括号已被涂掉）。
 *
 * 为什么三种都要：**顶层语句**要求三者同时为 0。只看花括号会误报 ——
 * `routes/auth.js:201` 的 `body('username')` 出现在多行实参列表的续行上
 * （`router.post(\n  [\n  body('username')`），花括号深度为 0 却只是数组元素。
 * 判据是「顶层**语句**」，不是「行首且不在块里」。
 */
function depthMaps(text) {
  const brace = new Int32Array(text.length + 1);
  const paren = new Int32Array(text.length + 1);
  const bracket = new Int32Array(text.length + 1);
  let b = 0, p = 0, k = 0;
  for (let i = 0; i < text.length; i++) {
    brace[i] = b; paren[i] = p; bracket[i] = k;
    const c = text[i];
    if (c === '{') b++;
    else if (c === '}') b = Math.max(0, b - 1);
    else if (c === '(') p++;
    else if (c === ')') p = Math.max(0, p - 1);
    else if (c === '[') k++;
    else if (c === ']') k = Math.max(0, k - 1);
  }
  brace[text.length] = b; paren[text.length] = p; bracket[text.length] = k;
  return { brace, paren, bracket };
}

/** 兼容旧名（仅供外部诊断脚本使用）。 */
function braceDepthMap(text) {
  return depthMaps(text).brace;
}

/**
 * 只在**关心的偏移**上取三种括号深度，不建全长数组。
 *
 * 为什么不直接用 `depthMaps`：3035 个文件 / 27MB 上会分配 3 × N × 4 字节 ≈ 324MB
 * 的 `Int32Array`，GC 压力显著（实测 718ms 且拉高整体耗时）。候选顶层调用每文件
 * 只有个位数，按需取值即可。
 *
 * @returns {Map<number, {brace:number, paren:number, bracket:number}>}
 */
function depthsAt(text, offsets) {
  const want = new Map();
  for (const o of offsets) if (!want.has(o)) want.set(o, null);
  const sorted = [...want.keys()].sort((a, b) => a - b);
  let b = 0, p = 0, k = 0, si = 0;
  for (let i = 0; i < text.length && si < sorted.length; i++) {
    // 先记深度、再吃当前字符 ⇒ 记录的是「该字符之前」的深度，与数组版语义一致
    while (si < sorted.length && sorted[si] === i) {
      want.set(sorted[si], { brace: b, paren: p, bracket: k });
      si++;
    }
    const c = text[i];
    if (c === '{') b++;
    else if (c === '}') b = Math.max(0, b - 1);
    else if (c === '(') p++;
    else if (c === ')') p = Math.max(0, p - 1);
    else if (c === '[') k++;
    else if (c === ']') k = Math.max(0, k - 1);
  }
  while (si < sorted.length) {
    want.set(sorted[si], { brace: b, paren: p, bracket: k });
    si++;
  }
  return want;
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

/** 顶层可静态识别的函数定义：名字 → 体区间 [start, end)。 */
function collectFunctions(blanked) {
  const fns = new Map();
  const put = (name, open) => {
    if (open < 0) return;
    const close = matchBrace(blanked, open);
    if (close < 0) return;
    if (!fns.has(name)) fns.set(name, { bodyStart: open + 1, bodyEnd: close });
  };

  const declRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = declRe.exec(blanked))) {
    put(m[1], findBodyBrace(blanked, m.index + m[0].length, 1));
  }

  // const NAME = async? function (...) {…}   /   const NAME = (...) => {…}
  const varRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\(|\([^()]*\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
  while ((m = varRe.exec(blanked))) {
    const tail = m[0];
    if (/function\s*\($/.test(tail)) {
      put(m[1], findBodyBrace(blanked, m.index + tail.length, 1));
      continue;
    }
    // 箭头：`=>` 之后若是 `{` 才是块体；表达式体整体跳过（保守）
    const after = blanked.slice(m.index + tail.length).match(/^\s*/)[0].length;
    const at = m.index + tail.length + after;
    if (blanked[at] === '{') put(m[1], at);
  }
  return fns;
}

/** 从 `require` 解构 / 直接赋值出来的标识符（用于盲区盘点）。 */
function collectImported(blanked) {
  const set = new Set();
  const re = /\b(?:const|let|var)\s+([^=;\n]+?)\s*=\s*require\s*\(/g;
  let m;
  while ((m = re.exec(blanked))) {
    const lhs = m[1].trim();
    const braced = lhs.match(/^\{([\s\S]*)\}$/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const seg = part.split(':').pop().trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(seg)) set.add(seg);
      }
    } else if (/^[A-Za-z_$][\w$]*$/.test(lhs)) {
      set.add(lhs);
    }
  }
  return set;
}

const SE_FUNC_RE = new RegExp(
  `(?<![.\\w$])(${SIDE_EFFECT_FUNCS.join('|')})\\s*\\(`, 'g',
);
const SE_REQUIRE_MEMBER_RE = /\brequire\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;
const SE_METHOD_RE = new RegExp(`\\.\\s*(${SIDE_EFFECT_METHODS.join('|')})\\s*\\(`, 'g');

/**
 * 在函数体内找**同步可达**的副作用调用。
 *
 * 「同步可达」= 命中点所在的**语句前缀**里没有 `=>` / `function`。
 * 前缀起点取「该点之前最近的 `;` / `{` / `}`」——`{` 一起取是关键：
 * `{ create: (opts) => require('./x') }` 的前缀正是 `create: (opts) => `，
 * 于是 `=>` 落在前缀里，命中被正确排除。
 */
function syncSideEffects(blanked, body) {
  const text = blanked.slice(body.bodyStart, body.bodyEnd);
  const base = body.bodyStart;
  const hits = [];

  const consider = (rel, name) => {
    const abs = base + rel;
    const cut = Math.max(
      blanked.lastIndexOf(';', abs - 1),
      blanked.lastIndexOf('{', abs - 1),
      blanked.lastIndexOf('}', abs - 1),
      body.bodyStart - 1,
    );
    const prefix = blanked.slice(Math.max(cut, body.bodyStart), abs);
    if (/=>|\bfunction\b/.test(prefix)) return; // 包在嵌套函数里 ⇒ 非同步可达
    hits.push({ name, offset: abs });
  };

  let m;
  SE_FUNC_RE.lastIndex = 0;
  while ((m = SE_FUNC_RE.exec(text))) consider(m.index, `${m[1]}()`);
  SE_REQUIRE_MEMBER_RE.lastIndex = 0;
  while ((m = SE_REQUIRE_MEMBER_RE.exec(text))) {
    consider(m.index, `${m[0].replace(/\s+/g, '')}`);
  }
  SE_METHOD_RE.lastIndex = 0;
  while ((m = SE_METHOD_RE.exec(text))) consider(m.index, `.${m[1]}()`);

  return hits;
}

/**
 * 扫描一份源码。**绝不抛**。
 * @returns {{topLevelCalls:Array, functions:Map, imported:Set, error?:string}}
 */
function scanSource(src) {
  try {
    const blanked = blankNonCode(String(src == null ? '' : src));
    const lineOf = lineIndexer(blanked);
    const functions = collectFunctions(blanked);
    const imported = collectImported(blanked);

    // 先找候选行首调用，再按需取深度 —— 不建全长深度数组（见 depthsAt 注释）
    const cands = [];
    const callRe = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(/gm;
    let m;
    while ((m = callRe.exec(blanked))) {
      cands.push({ name: m[1], off: m.index + m[0].indexOf(m[1]) });
    }
    const dep = depthsAt(blanked, cands.map((c) => c.off));

    const topLevelCalls = [];
    for (const c of cands) {
      if (c.name === 'require') continue;   // 顶层 require 是模块装配，非本判据目标
      const d = dep.get(c.off);
      // 「顶层语句」= 三种括号深度同时为 0
      if (!d || d.brace !== 0 || d.paren !== 0 || d.bracket !== 0) continue;
      topLevelCalls.push({ name: c.name, line: lineOf(c.off), offset: c.off });
    }
    return { topLevelCalls, functions, imported, blanked, lineOf };
  } catch (err) {
    return {
      topLevelCalls: [], functions: new Map(), imported: new Set(),
      error: (err && err.message) || String(err),
    };
  }
}

// ── 判定 ────────────────────────────────────────────────────────────────────

/**
 * @param {{files:Array<{path:string, src?:string, error?:string}>}} input
 * @param {{stage?:string}} ctx
 */
function evaluate(input, ctx = {}) {
  const stage = ctx.stage || STAGE;
  const findings = [];
  const files = (input && Array.isArray(input.files)) ? input.files : [];

  for (const f of files) {
    const rel = f && f.path ? String(f.path).replace(/\\/g, '/') : '(unknown)';
    if (!f || f.error) {
      findings.push({
        criterion: 'source-unreadable', severity: severityFor('source-unreadable', stage),
        file: rel, line: 0, name: '-', via: '-',
        message: `源码读不到：${(f && f.error) || 'unknown'}`,
      });
      continue;
    }
    const r = scanSource(f.src);
    if (r.error) {
      findings.push({
        criterion: 'scan-error', severity: severityFor('scan-error', stage),
        file: rel, line: 0, name: '-', via: '-',
        message: `扫描失败：${r.error}`,
      });
      continue;
    }

    for (const call of r.topLevelCalls) {
      const def = r.functions.get(call.name);
      if (!def) {
        if (r.imported.has(call.name)) {
          findings.push({
            criterion: 'toplevel-call-imported', severity: severityFor('toplevel-call-imported', stage),
            file: rel, line: call.line, name: call.name, via: '-',
            message: `顶层调用 ${call.name}()，其定义来自跨文件 import —— 本叶子不追（盲区盘点，非违规）。`,
          });
        }
        continue;
      }
      const hits = syncSideEffects(r.blanked, def);
      if (!hits.length) continue;

      const known = KNOWN_TOPLEVEL_SIDE_EFFECTS[`${rel}|${call.name}`] || null;
      const criterion = known ? 'toplevel-side-effect-known' : 'toplevel-side-effect';
      const viaList = [...new Set(hits.map((h) => h.name))].join(', ');
      findings.push({
        criterion, severity: severityFor(criterion, stage),
        file: rel, line: call.line, name: call.name, via: viaList,
        message: known
          ? `顶层调用 ${call.name}() 同步可达 [${viaList}] —— 已裁决保留：${known}`
          : `顶层调用 ${call.name}()，而该函数体内同步可达 [${viaList}]`
            + ` ⇒ 模块被 require 的瞬间即 eager 拉入依赖树。`
            + ` 修法：删掉顶层调用改为惰性初始化（见 cacheService 的 _ensureInit 范式）。`,
      });
    }
  }
  return findings;
}

function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const s = { errors: 0, warnings: 0, infos: 0, total: list.length };
  for (const f of list) {
    if (f.severity === SEV.ERROR) s.errors++;
    else if (f.severity === SEV.WARNING) s.warnings++;
    else s.infos++;
  }
  return s;
}

// ── 反例矩阵 ────────────────────────────────────────────────────────────────

const SYNTH_EAGER = [
  'let client = null;',
  'async function initRedis() {',
  '  try {',
  "    const { createClient } = require('redis');",
  '    client = createClient({ url: process.env.REDIS_URL });',
  "    client.on('error', () => {});",
  '    await client.connect();',
  '  } catch (e) {',
  '    // Redis 不可用时静默降级到内存缓存',
  '  }',
  '}',
  'initRedis();',                       // ← 第 12 行：顶层 eager，应命中
  'module.exports = { initRedis };',
].join('\n');

const SYNTH_LAZY_THUNK = [
  'const _registry = new Map();',
  'function _defineBuiltins() {',
  "  _registry.set('feishu', {",
  '    displayName: x,',
  "    create: (opts) => require('./feishuAdapter').create(opts),",
  '  });',
  '}',
  '_defineBuiltins();',                 // ← require 在箭头里 ⇒ 应放行
  'module.exports = { _defineBuiltins };',
].join('\n');

const SYNTH_ENTRY_GUARDED = [
  'function main() {',
  "  const heavy = require('./heavy');",
  '  heavy.run();',
  '}',
  'if (require.main === module) {',     // ← 入口守卫 ⇒ 应放行
  '  main();',
  '}',
  'module.exports = { main };',
].join('\n');

const SYNTH_PLAIN_TOPLEVEL = [
  'const path = require("path");',
  'function setup() {',
  '  const x = path.join(__dirname, "a");',
  '  return x;',
  '}',
  'setup();',                           // ← 无副作用 ⇒ 应放行
  'module.exports = { setup };',
].join('\n');

const SYNTH_IMPORTED = [
  "const { boot } = require('./boot');",
  'boot();',                            // ← 跨文件 ⇒ 盲区盘点，非违规
  'module.exports = {};',
].join('\n');

const SYNTH_SCENARIO = 'function f() {\n  require(\'x\');\n}\nf();\n';

const SCENARIOS = Object.freeze([
  'clean', 'eager', 'lazy-thunk', 'entry-guarded', 'plain-toplevel', 'imported', 'unreadable',
]);

/** 期望（S1 语义）：[error, warning] 下界/上界，以及是否必须出现某个判据。 */
const SCENARIO_EXPECT = Object.freeze({
  clean: { errors: 0, warnings: 0 },
  eager: { errors: 0, warnings: 1, has: 'toplevel-side-effect' },
  'lazy-thunk': { errors: 0, warnings: 0 },
  'entry-guarded': { errors: 0, warnings: 0 },
  'plain-toplevel': { errors: 0, warnings: 0 },
  imported: { errors: 0, warnings: 0, has: 'toplevel-call-imported' },
  unreadable: { errors: 0, warnings: 1, has: 'source-unreadable' },
});

/** 把场景套到真实输入上（只替换 files，保留其它字段）。 */
function applyScenario(name, real) {
  const base = { files: [] };
  switch (name) {
    case 'clean':
      return { ...base };
    case 'eager':
      return { ...base, files: [{ path: 'synth/eager.js', src: SYNTH_EAGER }] };
    case 'lazy-thunk':
      return { ...base, files: [{ path: 'synth/lazy.js', src: SYNTH_LAZY_THUNK }] };
    case 'entry-guarded':
      return { ...base, files: [{ path: 'synth/entry.js', src: SYNTH_ENTRY_GUARDED }] };
    case 'plain-toplevel':
      return { ...base, files: [{ path: 'synth/plain.js', src: SYNTH_PLAIN_TOPLEVEL }] };
    case 'imported':
      return { ...base, files: [{ path: 'synth/imported.js', src: SYNTH_IMPORTED }] };
    case 'unreadable':
      return { ...base, files: [{ path: 'synth/missing.js', error: 'ENOENT' }] };
    default:
      throw new Error(`未知场景：${name}（可用：${SCENARIOS.join(', ')}）`);
  }
}

/** 校验场景结果是否符合期望。返回 `{ok, reasons[]}`。 */
function checkScenario(name, findings, stage = STAGE) {
  const exp = SCENARIO_EXPECT[name];
  const reasons = [];
  if (!exp) return { ok: false, reasons: [`场景 ${name} 没有期望定义`] };
  const s = summarize(findings);
  if (s.errors !== exp.errors) reasons.push(`error 期望 ${exp.errors}，实得 ${s.errors}`);
  if (s.warnings !== exp.warnings) reasons.push(`warning 期望 ${exp.warnings}，实得 ${s.warnings}`);
  if (exp.has && !findings.some((f) => f.criterion === exp.has)) {
    reasons.push(`期望出现判据 ${exp.has}，未出现`);
  }
  if (exp.has === undefined && findings.length > 0 && name !== 'unreadable') {
    const bad = findings.filter((f) => f.severity !== SEV.INFO).map((f) => f.criterion);
    if (bad.length) reasons.push(`期望无 error/warning，实得 ${bad.join(', ')}`);
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  SEV, STAGE, CRITERIA, severityFor, labelOf,
  SCAN_ROOTS, SKIP_SEGMENTS, TEST_FILE_RE,
  SIDE_EFFECT_FUNCS, SIDE_EFFECT_METHODS,
  KNOWN_TOPLEVEL_SIDE_EFFECTS, LIMITATIONS,
  blankNonCode, matchBrace, depthMaps, depthsAt, braceDepthMap, lineIndexer,
  collectFunctions, collectImported, syncSideEffects, scanSource,
  evaluate, summarize,
  SCENARIOS, SCENARIO_EXPECT, applyScenario, checkScenario,
  SYNTH_EAGER, SYNTH_LAZY_THUNK, SYNTH_ENTRY_GUARDED, SYNTH_PLAIN_TOPLEVEL,
  SYNTH_IMPORTED, SYNTH_SCENARIO,
};
