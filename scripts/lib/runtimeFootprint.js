'use strict';

/**
 * runtimeFootprint — 运行时重量探针（纯叶子）
 *
 * 为 `scripts/ci/check-runtime-footprint.js` 提供「进程实际加载了多少」的能力，
 * 与 `scripts/lib/visualLayerGraph.js`（静态图）互补：
 *
 *   静态图（require.cache 之前）  = 估算「如果全加载会进多少」
 *   运行时（require.cache 之后）  = 事实「实际进了多少」
 *
 * ## 为什么两者都要
 *
 * 实测（2026-10-30）：`khy --version` 的**静态冷闭包**是 3 文件 2602 行，
 * 运行时实际加载 11 文件 7805 行；`khy ai -p "hi"` 的**静态全可达闭包**是
 * 2178 文件，而运行时实际加载 468 文件 / 21 万行。
 *
 * 差 80 倍不是因为静态分析有盲区（实测盲区 = 0 个模块），
 * 而是因为**懒加载边在运行期被求值**。所以：
 *   - 静态冷闭包 衡量「启动瞬间的重量」
 *   - 运行时足迹 衡量「一条真实命令路径的总重量」
 * 两个数字都要，才是完整的「体积」轴。
 *
 * ## 用法
 *
 * 作为 `--require` 预挂：
 *   node -r ./scripts/lib/runtimeFootprint.js bin/khy.js --version
 *
 * 探针在 `process.on('exit')` 时把快照写到 `KHY_FOOTPRINT_OUT`（默认不写文件，
 * 只把 JSON 打到 stderr，由调用方决定去向）。**绝不抛、绝不阻塞退出。**
 */

const fs = require('fs');
const path = require('path');

// **宿主预挂**（NODE_OPTIONS=--require 注入的 shim、覆盖率工具、agent 运行时的
// 语言垫片）在探针装载前就已经躺在 require.cache 里。它们不属于被测仓库，
// 却会被下面的口径算成「外部依赖」。
//
// 实测（2026-10-31，本机 NODE_OPTIONS 注入 WorkBuddy 的 2 个 shim / 32038B）：
// `khy --version` 真实外部依赖是 0，却读成 2 个 32038B；`khy doctor` 真实
// 12 个 / 56088B，读成 14 个 / 88126B（差 32038，正好是那两个 shim）——
// 两处「超基线 57.1%」红的都是宿主，仓库一行没变。
//
// 只在以 `-r` 预挂时采信：那时 require.main 尚未装载，cache 里现存的东西
// 必然是环境注入，不可能是被测路径自己 require 的。
const PRELOADED = require.main ? null : new Set(Object.keys(require.cache || {}));

/**
 * 采集当前进程的运行时重量快照。
 *
 * @param {object} [opts]
 * @param {string} [opts.backendRoot] 第一方根目录（用于区分第一方/外部包）
 * @param {string} [opts.label] 本次快照的场景标签
 * @returns {{label: string, firstPartyFiles: number, firstPartyBytes: number,
 *   firstPartyLines: number, externalFiles: number, externalBytes: number,
 *   preloadedFiles: number, preloadedBytes: number,
 *   heapUsedMB: number, rssMB: number, topDirs: Array<[string, number]>}}
 */
function snapshot(opts = {}) {
  // 路径必须规范化后再比较：Windows 上 `D:/x` 与 `D:\x` 是不同的字符串，
  // 不规范化会让 startsWith 恒假 —— 第一方计数变成 0，而外部计数虚高。
  const backendRoot = opts.backendRoot ? path.resolve(opts.backendRoot) : '';
  const label = opts.label || '(unlabeled)';
  const cache = require.cache || {};

  // **排除探针自己**：本文件以 `--require` 预挂，必然在 require.cache 里，
  // 于是会被算进「外部依赖」。而探针文件的大小随功能增长（归因逻辑加进来后
  // 从 5.8 KB 涨到 11.6 KB）—— 于是「外部字节数」会随探针自身的体积变化，
  // 被测对象一点没变，数字却变了。
  // 这就是「探针污染自己的测量」：外部字节预算会跟着探针改代码而漂移。
  const selfPath = path.resolve(__filename).toLowerCase();

  let firstPartyFiles = 0;
  let firstPartyBytes = 0;
  let firstPartyLines = 0;
  let externalFiles = 0;
  let externalBytes = 0;
  // 宿主预挂单独一桶：既不进第一方，也不进外部 —— 但它必须**可见**，
  // 否则「数字对不上」只能靠猜（本文件第 5 条坑就是「静默降级」）。
  let preloadedFiles = 0;
  let preloadedBytes = 0;
  const dirs = new Map();
  const fileLines = new Map(); // 供归因报告复用（避免二次读盘）

  for (const key of Object.keys(cache)) {
    const entry = cache[key];
    const filename = entry && entry.filename ? entry.filename : '';
    if (!filename) continue;
    // 探针自身不计入（见上方说明）
    if (path.resolve(filename).toLowerCase() === selfPath) continue;

    let bytes = 0;
    let lines = 0;
    try {
      const src = fs.readFileSync(filename, 'utf8');
      bytes = Buffer.byteLength(src);
      lines = src.split('\n').length;
    } catch {
      // 二进制或读不到 → 只计文件数，不计字节/行
    }

    // filename 来自 require.cache，已经是绝对路径；用 path.resolve 归一化，
    // 保证与 backendRoot 的比较在同一形态下（Windows 上大小写不敏感）。
    // 宿主预挂先判：它在 backend 之外，若放任则必然落进「外部」桶（见文件头）。
    if (PRELOADED && PRELOADED.has(key)) {
      preloadedFiles++;
      preloadedBytes += bytes;
      continue;
    }

    const isFirstParty = backendRoot && path.resolve(filename).toLowerCase().startsWith(backendRoot.toLowerCase());
    if (isFirstParty) {
      firstPartyFiles++;
      firstPartyBytes += bytes;
      firstPartyLines += lines;
      fileLines.set(path.resolve(filename), lines);
      const bucket = bucketOf(filename, backendRoot);
      dirs.set(bucket, (dirs.get(bucket) || 0) + lines);
    } else {
      externalFiles++;
      externalBytes += bytes;
    }
  }

  const mem = process.memoryUsage();
  const snap = {
    label,
    firstPartyFiles,
    firstPartyBytes,
    firstPartyLines,
    externalFiles,
    externalBytes,
    preloadedFiles,
    preloadedBytes,
    heapUsedMB: round1(mem.heapUsed / 1048576),
    rssMB: round1(mem.rss / 1048576),
    topDirs: [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };

  // 加载归因：只有装了归因钩子才有（钩子在模块自安装时已装上）。
  // 归因回答「谁把重量拽进来的」——静态图答不了这个问题。
  const edges = global.__khyFootprintEdges;
  if (edges && edges.size) {
    snap.attribution = attributionReport(edges, fileLines, backendRoot.length).slice(0, 25);
    snap.attributionEdgeCount = edges.size;
  }

  // **顶层 vs 懒加载的重量分摊** —— 这是逻辑侧与视觉侧对称的关键能力。
  //
  // 冷闭包（顶层边）与路径触发（懒加载边）分开计量，才能回答：
  // 「重量该从哪头减？」—— 顶层边减了是所有命令都受益；
  // 懒加载边减了只对那条路径受益（且要确认那条路径本来就不需要它）。
  const topEdges = global.__khyFootprintTopEdges;
  const lazyEdges = global.__khyFootprintLazyEdges;
  if (topEdges && topEdges.size) {
    const reachOf = (edgeMap) => {
      const seen = new Set();
      const stack = [];
      for (const set of edgeMap.values()) for (const d of set) stack.push(d);
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of edgeMap.get(n) || []) if (!seen.has(d)) stack.push(d);
      }
      return seen;
    };
    const topReach = reachOf(topEdges);
    const lazyReach = reachOf(lazyEdges);
    const linesIn = (set) => {
      let l = 0;
      for (const f of set) l += fileLines.get(path.resolve(f)) || 0;
      return l;
    };
    snap.coldVsLazy = {
      topEdgeCount: topEdges.size,
      lazyEdgeCount: lazyEdges.size,
      topReachFiles: topReach.size,
      topReachLines: linesIn(topReach),
      lazyReachFiles: lazyReach.size,
      lazyReachLines: linesIn(lazyReach),
      note:
        '⚠ 这两个数字**不是**「冷闭包 vs 路径触发」，而是「顶层边可达 vs 懒加载边可达」。' +
        '顶层边在任何模块的顶层都算 —— 一个被懒加载进来的模块，它自己的顶层 require ' +
        '照样是顶层边（照样在它装载时求值）。' +
        '真正的「冷闭包」只算**入口的**顶层闭包（bin/khy.js 的顶层 require）。' +
        '所以要分清三层：① 入口冷闭包（所有命令都付）② 被触发模块的顶层闭包' +
        '（那条命令付）③ 懒加载边触达的部分（只在走到那条路径时付）。' +
        '顶层与懒加载有重叠，两个数字不可相加。' +
        '【口径（2026-10-31 修正）】顶层/懒加载的判定改为**运行时真相**：' +
        '「这次 require 是否发生在加载者正在求值期间」。' +
        '旧口径用加载者源码里的括号深度判定 —— 长文件里深度被字符串/正则的花括号带偏，' +
        '把大量真实懒加载的 require 误判成顶层边。运行时判定没有这个问题。',
    };
  }
  return snap;
}

/** 按第一方目录归桶 */
function bucketOf(filename, backendRoot) {
  const rel = path.relative(path.resolve(backendRoot), path.resolve(filename)).split(path.sep).join('/');
  const parts = rel.split('/');
  if (parts[0] === 'src' && parts.length >= 2) return `src/${parts[1]}`;
  if (parts[0] === 'src') return 'src/(root)';
  return `(backend root)`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 安装 exit 钩子，把快照写到 KHY_FOOTPRINT_OUT（文件）或 stderr（JSON 行）。
 * 幂等：重复安装只生效一次。
 */
function installExitHook(opts = {}) {
  if (global.__khyFootprintInstalled) return;
  global.__khyFootprintInstalled = true;
  const out = opts.out || process.env.KHY_FOOTPRINT_OUT || '';
  const backendRoot = opts.backendRoot || process.env.KHY_FOOTPRINT_ROOT || '';
  const label = opts.label || process.env.KHY_FOOTPRINT_LABEL || '(unlabeled)';

  process.on('exit', () => {
    try {
      const snap = snapshot({ backendRoot, label });
      if (out) {
        fs.writeFileSync(out, JSON.stringify(snap, null, 2));
      }
      // 默认**不写 stderr**：探针不得污染被测命令的用户可见输出。
      // 需要看数据时，由调用方设 KHY_FOOTPRINT_OUT 落文件，或自己 require 本模块调 snapshot()。
    } catch (err) {
      // exit 阶段绝不抛 —— 探针不能影响被测进程的行为。
      //
      // 但**不能静默**：首版这里只有一个空 catch，把「归因报告里的变量名笔误」
      // 变成了「快照缺 attribution 字段」——探针照样写文件、照样 exit 0，
      // 而守卫读到的是一个不完整的快照，却无从知道。
      // 故：把失败痕迹写进快照文件旁边的 .err 文件，守卫可据此判「本轮不可测」。
      try {
        if (out) {
          fs.writeFileSync(
            out + '.err',
            String((err && err.stack) || err) + '\n'
          );
        }
      } catch {
        /* 连痕迹都写不了就算了 —— 仍然不能抛 */
      }
    }
  });
}

/**
 * 加载归因：记录「哪个模块加载了哪个模块」。
 *
 * ## 为什么需要它
 *
 * §七 证明了 lite 路径的 468 个模块**全部**落在静态全可达闭包内（静态盲区 = 0），
 * 即重量来自「被触发的懒加载边」。但**哪些边**被触发了？静态图答不了，
 * 因为静态图不知道运行时到底走了哪条路。
 *
 * 答案只能从运行时拿：拦截 `Module._load`，记下每次加载的「加载者 → 被加载者」。
 * 于是「谁把重量拽进来的」从猜测变成事实。
 *
 * ## 实现口径
 *
 * 拦截 `Module._load`（而非 `Module.prototype.require`）—— 前者是所有加载路径
 * 的收口，包括 `require()`、`import()` 的 CJS 侧、以及内部 `require` 调用。
 * 记录的是**第一方**边的加载者（外部包的加载者价值低，且量太大）。
 */
function installLoadAttribution(opts = {}) {
  if (global.__khyFootprintAttributionInstalled) return;
  global.__khyFootprintAttributionInstalled = true;

  const backendRoot = opts.backendRoot ? path.resolve(opts.backendRoot) : '';
  const Module = require('module');
  const originalLoad = Module._load;

  // edges: Map<loaderFilename, Set<loadedFilename>>
  const edges = new Map();
  const loadOrder = [];
  // 顶层边 / 懒加载边分开记 —— 「重量 = 冷闭包 + 被触发路径的懒加载边」，
  // 两项分别计量才知道该动哪一头。
  const topEdges = new Map();
  const lazyEdges = new Map();

  // ── 求值栈 ────────────────────────────────────────────────────────────────
  // 「这次 require 是装载期还是延迟」——**运行时真相**，不是源码猜测。
  //
  // 旧口径用「加载者源码里 require 处的括号深度」判定（深度 0 = 顶层）。
  // 那个口径在长文件里会被字符串/正则里的花括号带偏：深度再也不回 0，
  // 于是文件后半段的 require 全被误判成「顶层边」；反过来 `try { require() }`
  // 这类**装载期** require 又被判成懒加载。两个方向都错。
  //
  // 运行时判定没有这个问题：**加载者此刻是否正在求值**，
  // 就是「这次 require 是不是装载期求值」的定义本身。
  //
  // 实现：`Module._load` 里 `originalLoad` 的调用是**同步**完成被加载模块的求值的，
  // 所以把「被加载模块」在 originalLoad 期间压栈、出栈，
  // 栈中的模块 = 正在求值的模块。
  const evalStack = [];
  const evalStackSet = new Map(); // filename -> 嵌套计数（循环 require 会重复压栈）

  // 路径比较必须归一化：Node 的 _resolveFilename 返回的是平台原生形态
  // （Windows 上是反斜杠），拿正斜杠前缀去 startsWith 恒假 —— 会让归因表全空，
  // 而探针依然「正常」运行。这个坑在本文件里踩过两次，统一走这一个比较器。
  //
  // ROOT 为空时不设限（记录所有加载边）—— 空表比全表更难排查，
  // 而归因表的用途是「找重量来源」，多几条无关边不影响判断。
  const rootLower = backendRoot ? backendRoot.toLowerCase() : '';
  const isUnderRoot = (f) => {
    if (!f) return false;
    if (!rootLower) return true;
    return path.resolve(f).toLowerCase().startsWith(rootLower);
  };

  Module._load = function patched(request, parent, isMain) {
    let loadedFilename = null;
    try {
      loadedFilename = Module._resolveFilename(request, parent, isMain);
    } catch {
      /* 解析不了就让它按原样抛 */
    }

    // 装载期判定：**加载者此刻是否正在求值**。
    //   在求值 ⇒ 这次 require 是装载期求值（模块一装载就进内存）；
    //   不在求值 ⇒ 是延迟调用（某个函数被调用时才 require）。
    const loaderIsEvaluating = !!(parent && parent.filename && evalStackSet.has(parent.filename));

    // 被加载模块的求值发生在 originalLoad 期间（同步）—— 压栈后它的子加载
    // 才能判定「是否在它自己的求值期间」。
    if (loadedFilename) {
      evalStack.push(loadedFilename);
      evalStackSet.set(loadedFilename, (evalStackSet.get(loadedFilename) || 0) + 1);
    }
    let result;
    try {
      result = originalLoad.apply(this, arguments);
    } finally {
      if (loadedFilename) {
        evalStack.pop();
        // 计数归零才移出集合：循环 require 会把同一模块压栈多次，
        // 若用 Set，内层弹出就会把仍在求值的外层「误判为已结束」。
        const n = (evalStackSet.get(loadedFilename) || 1) - 1;
        if (n > 0) evalStackSet.set(loadedFilename, n);
        else evalStackSet.delete(loadedFilename);
      }
    }

    if (loadedFilename && parent && parent.filename) {
      const loader = parent.filename;
      if (isUnderRoot(loader) && isUnderRoot(loadedFilename)) {
        if (!edges.has(loader)) edges.set(loader, new Set());
        edges.get(loader).add(loadedFilename);
        loadOrder.push({ loader, loaded: loadedFilename, request });
        // 顶层边 vs 懒加载边：**这是逻辑侧与视觉侧对称的关键能力**。
        // 顶层边 = 模块一装载即入内存（进冷闭包）；懒加载边 = 只在被触发的路径上求值。
        // 「重量 = 冷闭包 + 被触发路径的懒加载边」—— 两项分别计量，才知道该动哪一头。
        if (loaderIsEvaluating) {
          if (!topEdges.has(loader)) topEdges.set(loader, new Set());
          topEdges.get(loader).add(loadedFilename);
        } else {
          if (!lazyEdges.has(loader)) lazyEdges.set(loader, new Set());
          lazyEdges.get(loader).add(loadedFilename);
        }
      }
    }
    return result;
  };

  global.__khyFootprintEdges = edges;
  global.__khyFootprintLoadOrder = loadOrder;
  global.__khyFootprintTopEdges = topEdges;
  global.__khyFootprintLazyEdges = lazyEdges;
}

/**
 * 从加载边表算出「加载者 → 它拽进来的第一方重量」。
 *
 * @param {Map} edges Map<loaderFilename, Set<loadedFilename>>
 * @param {Map} lineCount 每文件行数
 * @param {number} backendRootLen 第一方根的路径长度（用于相对化）
 * @returns {Array<{loader: string, direct: number, directLines: number, reachable: number, reachableLines: number}>}
 */
function attributionReport(edges, lineCount, backendRootLen) {
  // edges 里的键是 require.cache 的原始 filename；lineCount 的键是 resolve 过的。
  // 两个形态都要能查到，否则行数会是 0（Windows 上分隔符不同就会踩这个坑）。
  const linesOf = (f) => lineCount.get(f) || lineCount.get(path.resolve(f)) || 0;

  const rows = [];
  for (const [loader] of edges) {
    // 该加载者「直接」拽进来多少个第一方模块、多少行
    const directSet = edges.get(loader);
    let directLines = 0;
    for (const l of directSet) directLines += linesOf(l);

    // 「可达」：从 loader 出发能走到的全部第一方模块（传递闭包）
    const reach = new Set();
    const stack = [...directSet];
    while (stack.length) {
      const n = stack.pop();
      if (reach.has(n)) continue;
      reach.add(n);
      for (const d of edges.get(n) || []) if (!reach.has(d)) stack.push(d);
    }
    let reachLines = 0;
    for (const n of reach) reachLines += linesOf(n);

    rows.push({
      loader: loader.slice(backendRootLen).replace(/^[\\/]/, ''),
      direct: directSet.size,
      directLines,
      reachable: reach.size,
      reachableLines: reachLines,
    });
  }
  rows.sort((a, b) => b.reachableLines - a.reachableLines);
  return rows;
}

module.exports = { snapshot, installExitHook, bucketOf, installLoadAttribution, attributionReport };

// ── 自安装 ────────────────────────────────────────────────────────────────────
// 本模块常以 `node -r <this-file>` 预挂。预挂的语义是「require 完就执行」，
// 所以钩子必须在这里自动装上 —— 否则 require 进来却什么都不做，
// 守卫只会看到「场景未产出快照」。
//
// 幂等：installExitHook 内部有 global 标记，重复 require 不会重复装钩子。
installExitHook();
installLoadAttribution({ backendRoot: process.env.KHY_FOOTPRINT_ROOT || '' });
