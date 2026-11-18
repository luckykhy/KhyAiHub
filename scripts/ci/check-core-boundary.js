'use strict';

/**
 * check-core-boundary.js —— 核心职责边界守卫（一核多终端）
 *
 * 真源：[DESIGN-ARCH-219] §4.3/§11、[DESIGN-ARCH-220] §13.3/§13.5。
 *
 * S1 观察者：finding 一律 severity:'warning'，恒 exit 0，不提供 --strict
 * （PP-3：S1/S2 不得阻断）。门成员资格不走 RULES-REGISTRY（S1 不新增规则 ID，
 * D3），由 pr-gate 显式步骤调用。
 *
 * --json 契约：counts 键名全列、值恒为数值（0 也输出），与 FEATURE-OWNERSHIP
 * core-boundary-guard 的 samples.source.key（counts.checks-run）一一对应。
 * 违规计数键只作读数，不作样本键——健康态恒 0 的键当样本量会让机制永远毕不了业
 * （check-rollout-stage.js PP-2 按实测值判 ≥200）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const GUARD_STAGE = 'S1';

const REPO_ROOT = process.env.KHY_REPO_ROOT
  ? path.resolve(process.env.KHY_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');
const CORE_PKG_DIR = 'runtime/substrate/platform/packages/core';

// 24 键：23 个 finding id + checks-run（[DESIGN-ARCH-219] §11.3）。新增 finding id
// 必须同批在这里加键，否则 --json 契约与登记表的 key 对不上。
const FINDING_IDS = [
  'core-boundary-import',
  'terminal-direct-gateway-import',
  'core-not-in-entry-closure',
  'core-skin-into-server',
  'core-client-node-free',
  'core-env-single-source',
  'terminal-cross-reference',
  'core-private-path',
  'core-carries-composer',
  'core-dynamic-private-require',
  'suite-forks-terminal',
  'suite-deps-core-pkg',
  'terminal-imports-suite',
  'suite-bundle-leak',
  'suite-dynamic-require',
  'suite-runtime-fork',
  'known-exception-applied',
  'known-exception-expired',
  'known-exception-unverifiable',
  'unknown-listener',
  'metering-dual-writer',
  'metering-second-core',
  'metering-unknown-writer',
  'checks-run',
];

// 判据 #2 的基线棘轮（[DESIGN-ARCH-219] §4.3）：khyquant 6 处死引用 + desktop
// host/index.ts:126 动态分段；ai-backend 3 处自包引用、.bat 与文档不计入。
const TERMINAL_GATEWAY_BASELINE = 7;
const AI_BACKEND_ROOT = 'runtime/node/ai-backend';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.khyos', '.venv', '__pycache__', 'dist-electron', '.build-tmp', 'build-tmp']);
const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.vue']);
const EXCEPTIONS_FILE = 'docs/10_规范/registry/KNOWN-EXCEPTIONS.json';

// 行级判据只看代码：注释与文档块不是依赖边（实测反例：App.tsx:99 的注释提到
// aiGateway，被首版误报成终端直连）。
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// 测试夹具不进产物面判据：同目录测试必须 import node:test，且会以路径字面量断言边界
// （实测反例：sharedPortablePaths.test.js 的 module 路径常量被误报成上跳引用）。
function isTestFile(file) {
  return /\.(test|spec)\.(js|cjs|mjs|ts|tsx)$/.test(file) || /(^|[/\\])tests?[/\\]/.test(file);
}

const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');
const onlyChanged = args.has('--changed');
const portableMode = args.has('--portable');
const suiteMode = args.has('--suite-fork');
const lanMode = args.has('--lan');

const findings = [];
const counts = {};
for (const id of FINDING_IDS) counts[id] = 0;
let checksRun = 0;

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function addFinding(id, file, line, message) {
  counts[id] += 1;
  findings.push({ id, severity: 'warning', file: rel(file), line: line || 0, message });
}

function walkFiles(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if ((exts || SOURCE_EXT).has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

// 进程级内容缓存：多个判据遍历同一批文件，只读一次（首版双遍历把 checks-run 虚增到
// 20102、耗时 5 分钟以上）。
const contentCache = new Map();

function readLines(file) {
  const cached = contentCache.get(file);
  if (cached) return cached;
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (_) {
    lines = [];
  }
  contentCache.set(file, lines);
  return lines;
}

// 改动集只取一次：过滤器若按文件反复 execSync git status，772 个改动会把单次运行
// 拖到小时级（实测教训）。取不到（非 git 环境）时按「无改动集」处理——全量扫描。
let changedSet = null;

function changedFiles() {
  if (changedSet) return changedSet;
  try {
    const out = execSync('git status --porcelain --untracked-files=all', { cwd: REPO_ROOT, encoding: 'utf8' });
    changedSet = new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[MADRC?!]+\s+/, '').trim())
        .filter(Boolean)
        .map((p) => path.resolve(REPO_ROOT, p)),
    );
  } catch (_) {
    changedSet = new Set();
  }
  return changedSet;
}

function resolveRequire(fromFile, spec) {
  const base = path.dirname(fromFile);
  const candidates = [spec, `${spec}.js`, `${spec}.cjs`, `${spec}.mjs`, `${spec}.ts`, path.join(spec, 'index.js'), path.join(spec, 'index.ts')];
  for (const c of candidates) {
    const p = path.resolve(base, c);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {
      /* 继续试下一个候选 */
    }
  }
  return null;
}

// 判据 #3 的冷闭包：follow 全部相对 require 边（含惰性边）——这是「仅顶层边」的超集，
// 超集无 core ⇒ 冷闭包必然无 core；超集命中时宁多报不漏报（S3b 的入口预算同样禁止惰性边）。
function coldClosure(roots) {
  const seen = new Set();
  const queue = roots.filter((r) => fs.existsSync(r));
  const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readLines(file).join('\n');
    requireRe.lastIndex = 0;
    let m;
    while ((m = requireRe.exec(src))) {
      const target = resolveRequire(file, m[1]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function layerRoots() {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/10_规范/registry/CORE-LAYERS.json'), 'utf8'));
    const roots = [];
    for (const key of ['0', '1']) {
      const layer = registry.layers && registry.layers[key];
      if (layer && Array.isArray(layer.roots)) roots.push(...layer.roots);
    }
    return roots.map((r) => path.resolve(REPO_ROOT, r));
  } catch (_) {
    return [];
  }
}

const scoped = (files) => (onlyChanged ? files.filter((f) => changedFiles().has(f)) : files);

// ── 判据 #1：core 不得回引 backend/apps/delivery/works/scripts/docs/entries ──────
function checkCoreBoundaryImport() {
  const dir = path.join(REPO_ROOT, CORE_PKG_DIR);
  if (!fs.existsSync(dir)) return;
  const forbidden = ['runtime/node/backend', 'apps/', 'delivery/', 'works/', 'scripts/', 'docs/', 'entries/'];
  for (const file of scoped(walkFiles(dir))) {
    checksRun += 1;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/(require\(|import\s|from\s)/.test(line)) continue;
      for (const needle of forbidden) {
        if (line.includes(needle)) {
          addFinding('core-boundary-import', file, i + 1, `core 回引了禁区的 ${needle}：core 只依赖 zod，跨层引用改走契约（[DESIGN-ARCH-220] §13.3-1）`);
          break;
        }
      }
    }
  }
}

// ── 判据 #2：终端直连网关（基线棘轮只降不升） ─────────────────────────────────────
function checkTerminalDirectGateway() {
  const roots = ['apps', 'delivery', AI_BACKEND_ROOT].map((r) => path.join(REPO_ROOT, r));
  let files = [];
  for (const root of roots) files = files.concat(walkFiles(root));
  files = files.filter((f) => !isTestFile(f));
  for (const file of scoped(files)) {
    checksRun += 1;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (!/aiGateway/.test(line)) continue;
      if (!/(require\(|import\s|from\s|path\.join|join\()/.test(line)) continue;
      // ai-backend 引用自己的 gateway 实现不算越界（自包引用，例外登记面）。
      const relSpec = /['"]([^'"]*aiGateway[^'"]*)['"]/.exec(line);
      if (relSpec) {
        const resolved = resolveRequire(file, relSpec[1]);
        if (resolved && rel(resolved).startsWith(`${AI_BACKEND_ROOT}/`)) continue;
      }
      const count = counts['terminal-direct-gateway-import'] + 1;
      const note = count > TERMINAL_GATEWAY_BASELINE ? '（超过基线，棘轮报警）' : '';
      addFinding(
        'terminal-direct-gateway-import',
        file,
        i + 1,
        `终端直连 aiGateway${note}：模型调用必须经 CoreHandle.gateway（基线 ${TERMINAL_GATEWAY_BASELINE}，C3 目标 0）`,
      );
    }
  }
}

// ── 判据 #3：入口冷闭包内不得出现 core ──────────────────────────────────────────
function checkCoreNotInEntryClosure() {
  const roots = layerRoots();
  if (!roots.length) return;
  const closure = coldClosure(roots);
  for (const file of closure) {
    checksRun += 1;
    const r = rel(file);
    if (r.startsWith(`${CORE_PKG_DIR}/`)) {
      addFinding('core-not-in-entry-closure', file, 0, '入口冷闭包内出现 packages/core 源文件：S3b 之前 CLI 不得在入口链上加载 core（[DESIGN-ARCH-220] §13.3-3）');
      continue;
    }
    const src = readLines(file).join('\n');
    // 只认真实 require 边：backend package.json 里的 "@khy/core": "*" 是依赖声明，
    // 不是加载边（v1 按字符串出现判，把声明误报成闭包命中）。
    if (/(require\(\s*['"]@khy\/core|from\s+['"]@khy\/core)/.test(src)) {
      addFinding('core-not-in-entry-closure', file, 0, '入口冷闭包内出现 @khy/core require 边：迁移期只允许 backend 消费面经已导出子路径读取');
    }
  }
}

// ── 判据 #4：终端皮肤/黑名单模块不得进 core ─────────────────────────────────────
function checkCoreSkin() {
  const dir = path.join(REPO_ROOT, CORE_PKG_DIR, 'src');
  if (!fs.existsSync(dir)) return;
  const blacklist = ['coordinator/processAgent', 'coordinator/taskBoard', 'tasks/largeTaskRuntimeStore', 'observability/cpuProfiler', 'observability/eventLoopMonitor', 'observability/slowRequest'];
  // 词边界匹配：'ink' 的子串会命中 link/thinking（v1 把 locator-host.js 注释里的
  // "符号链接"误报成终端皮肤）。
  const skinPatterns = [
    /(^|[^\w-])node-pty/,
    /\bink\b/,
    /\breadline\b/,
    /@khy\/ui-shared/,
    /document\s*\./,
    /window\s*\./,
  ];
  for (const file of scoped(walkFiles(dir))) {
    if (isTestFile(file)) continue; // 皮肤/黑名单判据只针对产物面源文件
    checksRun += 1;
    const src = readLines(file).join('\n');
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      const hit = skinPatterns.find((re) => re.test(lines[i]));
      if (hit) {
        addFinding('core-skin-into-server', file, i + 1, `core 内出现终端皮肤特征 ${hit}：core 零宿主假设，UI/终端专属依赖不得进 core（§13.3-4）`);
      }
    }
    if (/Page\.js$/.test(path.basename(file)) && /template|html/i.test(src)) {
      addFinding('core-skin-into-server', file, 0, 'core 内出现 *Page.js 模板资产：relay/页面模板属宿主侧，不进 core');
    }
    for (const mod of blacklist) {
      if (src.includes(mod)) {
        addFinding('core-skin-into-server', file, 0, `core 内出现黑名单模块路径 ${mod}：任务编排/观测采样本体不进 core（[DESIGN-ARCH-219] §4.2）`);
      }
    }
  }
}

// ── 子档 A：contracts+client 零 node:，locator-host 唯一且非空壳 ─────────────────
function checkClientNodeFree() {
  const pkg = path.join(REPO_ROOT, CORE_PKG_DIR);
  const scanDirs = [path.join(pkg, 'src', 'contracts'), path.join(pkg, 'src', 'client')];
  const guardLine = "if (typeof process === 'undefined' || !process.env) return {};";
  let scanned = 0;
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of scoped(walkFiles(dir))) {
      if (isTestFile(file)) continue;
      checksRun += 1;
      scanned += 1;
      const src = readLines(file).join('\n');
      const lines = readLines(file);
      const nodeHit = /require\(\s*['"]node:/.exec(src);
      if (nodeHit) {
        addFinding('core-client-node-free', file, 1, 'contracts/client 出现 node: 内置：这两个面必须零 node:（[DESIGN-ARCH-220] §2.2）');
      }
      if (rel(file).endsWith('src/contracts/core-env.js')) {
        if (!src.includes(guardLine)) {
          addFinding('core-client-node-free', file, 1, 'core-env.js 缺少 typeof process 守卫：守卫式豁免的唯一形态被破坏');
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (isCommentLine(lines[i])) continue;
          if (/\bprocess\./.test(lines[i])) {
            addFinding('core-client-node-free', file, i + 1, '未守卫的 process. 引用：只有 core-env.js 的 readCoreEnv 可读 env，且守卫必须是函数体首条语句');
          }
        }
      }
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (rel(file).includes('locator-host')) {
          addFinding('core-client-node-free', file, i + 1, 'contracts/client 内出现 locator-host 引用：反向边禁令（§4.0）');
        }
      }
    }
  }
  const locatorHost = path.join(pkg, 'src', 'locator-host.js');
  if (fs.existsSync(locatorHost)) {
    checksRun += 1;
    const src = readLines(locatorHost).join('\n');
    if (!/require\(\s*['"]node:/.test(src)) {
      addFinding('core-client-node-free', locatorHost, 1, 'locator-host.js 未 require 任何 node: 内置：唯一解析面退化成空壳（防伪装豁免）');
    }
  }
}

// ── 子档 B：KHY_CORE_* 单一真源；backend 不得相对上跳 core ──────────────────────
function checkCoreEnvSingleSource() {
  const pkg = path.join(REPO_ROOT, CORE_PKG_DIR);
  const truth = path.join(pkg, 'src', 'contracts', 'core-env.js');
  for (const file of scoped(walkFiles(path.join(REPO_ROOT, 'runtime/node/backend')))) {
    checksRun += 1;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (/KHY_CORE_(ENDPOINT|TOKEN|MODE)/.test(line) && rel(file) !== rel(truth) && !isTestFile(file)) {
        addFinding('core-env-single-source', file, i + 1, 'KHY_CORE_* 键名/默认值出现在 core-env.js 之外：唯一真源在 @khy/core/contracts/core-env（CH-2）');
      }
      if (/\.\.[/\\].*(packages[/\\]core|substrate[/\\]platform)/.test(line) && !isTestFile(file)) {
        addFinding('core-env-single-source', file, i + 1, 'backend 出现上跳 packages/core 的相对引用：跨层深引用同时命中 domain-direction 与跨 workspace 判据，改走已导出子路径');
      }
    }
  }
}

// ── 子档 C：终端之间不直接引用（静态；点对点通信由契约测试兜底） ──────────────────
function checkTerminalCrossReference() {
  const terminalRoots = ['delivery/channel/khyquant', 'delivery/web/ai-frontend', 'delivery/web/provider-hub', 'apps/khyos-desktop'];
  const crossTokens = [
    { from: 'khyquant', to: ['ai-frontend/', 'provider-hub/', 'khyos-desktop/'] },
    { from: 'ai-frontend', to: ['khyquant/', 'provider-hub/', 'khyos-desktop/'] },
    { from: 'provider-hub', to: ['khyquant/', 'ai-frontend/', 'khyos-desktop/'] },
    { from: 'khyos-desktop', to: ['khyquant/', 'ai-frontend/', 'provider-hub/'] },
  ];
  for (const root of terminalRoots) {
    const dir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(dir)) continue;
    const rule = crossTokens.find((r) => root.includes(r.from));
    if (!rule) continue;
    for (const file of scoped(walkFiles(dir))) {
      checksRun += 1;
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (isTestFile(file)) continue;
        if (!/(require\(|import\s|from\s)/.test(lines[i])) continue;
        const hit = rule.to.find((t) => lines[i].includes(t));
        if (hit) {
          addFinding('terminal-cross-reference', file, i + 1, `终端 ${root} 直接引用 ${hit}：终端间只经 CoreHandle 消费能力（产品意图 5）`);
        }
      }
    }
  }
}

// ── --portable：core 可携断言 ─────────────────────────────────────────────────────
function checkPortable() {
  const pkg = path.join(REPO_ROOT, CORE_PKG_DIR);
  if (!fs.existsSync(pkg)) return;
  for (const file of scoped(walkFiles(pkg))) {
    checksRun += 1;
    const src = readLines(file).join('\n');
    const lines = readLines(file);
    if (/(works\/|scripts\/|docs\/|entries\/)/.test(src)) {
      addFinding('core-private-path', file, 1, 'core 携带仓库私有路径：可携发布面不得引用 works/scripts/docs/entries');
    }
    if (/composer/i.test(src)) {
      addFinding('core-carries-composer', file, 1, 'core 内出现 composer：composer 只随组合态装配，core 闭包不得包含它');
    }
    for (let i = 0; i < lines.length; i++) {
      if (/require\(\s*[^'")\s]/.test(lines[i])) {
        addFinding('core-dynamic-private-require', file, i + 1, 'core 出现 require(变量) 动态引用：可携断言无法静态闭环，改注入或显式子路径');
      }
    }
  }
}

// ── --suite-fork：suite 只装配不 fork（apps/suite 尚未存在时计数为 0） ────────────
function checkSuiteFork() {
  const suiteDir = path.join(REPO_ROOT, 'apps', 'suite');
  if (!fs.existsSync(suiteDir)) return;
  for (const file of scoped(walkFiles(suiteDir))) {
    checksRun += 1;
    const src = readLines(file).join('\n');
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(delivery\/|khyos-desktop\/src|node\/backend\/src)/.test(line) && /(require\(|import\s|from\s)/.test(line)) {
        addFinding('suite-forks-terminal', file, i + 1, 'suite 深引用终端源码：组合态只装配，不 fork/复制终端业务代码');
      }
      if (/require\(\s*[^'")\s]/.test(line)) {
        addFinding('suite-dynamic-require', file, i + 1, 'suite 出现 require(变量)：装配面必须静态可判');
      }
    }
    if (/require\.cache/.test(src)) {
      addFinding('suite-runtime-fork', file, 1, 'suite 触碰 require.cache：跨进程装配禁用缓存互窜（R6 交叉验证由契约测试承担）');
    }
  }
  const pkgJson = path.join(suiteDir, 'package.json');
  if (fs.existsSync(pkgJson)) {
    checksRun += 1;
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (!deps['@khy/core']) {
      addFinding('suite-deps-core-pkg', pkgJson, 1, 'suite 未依赖 @khy/core：装配壳必须只依赖 core 包与终端清单');
    }
  }
  for (const terminal of ['apps/khyos-desktop', 'delivery/web/ai-frontend', 'delivery/web/provider-hub']) {
    const dir = path.join(REPO_ROOT, terminal);
    if (!fs.existsSync(dir)) continue;
    for (const file of scoped(walkFiles(dir))) {
      checksRun += 1;
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        if (/(require\(|import\s|from\s)/.test(lines[i]) && lines[i].includes('apps/suite')) {
          addFinding('terminal-imports-suite', file, i + 1, '终端引用 apps/suite：独立态终端不得依赖组合态壳');
        }
      }
    }
  }
}

// ── --lan：例外表消费 + 未知监听 ─────────────────────────────────────────────────
function checkLan() {
  const exceptionsPath = path.join(REPO_ROOT, EXCEPTIONS_FILE);
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  } catch (_) {
    registry = null;
  }
  const entries = registry && Array.isArray(registry.exceptions) ? registry.exceptions : [];
  const now = Date.now();
  for (const entry of entries) {
    checksRun += 1;
    counts['known-exception-applied'] += 1;
    if (entry.expiry && now > Date.parse(entry.expiry)) {
      counts['known-exception-expired'] += 1;
      findings.push({ id: 'known-exception-expired', severity: 'warning', file: EXCEPTIONS_FILE, line: 0, message: `例外 ${entry.id} 已过期（expiry=${entry.expiry}）：复验或删除，过期例外不再放行` });
    }
    if (!entry.owner || !entry.reason || !entry.reverify) {
      counts['known-exception-unverifiable'] += 1;
      findings.push({ id: 'known-exception-unverifiable', severity: 'warning', file: EXCEPTIONS_FILE, line: 0, message: `例外 ${entry.id} 缺 owner/reason/reverify：不可复验的例外等同没有登记` });
    }
  }
  const listenerFiles = walkFiles(path.join(REPO_ROOT, 'runtime/node')).filter((f) => !isTestFile(f) && (/server\.js$/.test(f) || /remote[/\\]/.test(f)));
  for (const file of scoped(listenerFiles)) {
    checksRun += 1;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      if (!/0\.0\.0\.0/.test(lines[i])) continue;
      const covered = entries.some((e) => {
        const target = String(e.target).replace(/\/+$/, '');
        const r = rel(file);
        return r === target || r.startsWith(`${target}/`);
      });
      if (!covered) {
        counts['unknown-listener'] += 1;
        findings.push({ id: 'unknown-listener', severity: 'warning', file: rel(file), line: i + 1, message: `对外监听 0.0.0.0 未登记例外：补 KNOWN-EXCEPTIONS.json 或改绑 127.0.0.1（D6）` });
      }
    }
  }
}

// ── metering：单实例三证的计量面（收敛前一律报 dual-writer） ─────────────────────
function checkMetering() {
  const knownWriters = [
    'runtime/node/backend/src/services/tokenUsageService.js',
    'runtime/node/ai-backend/src/services/tokenUsageService.js',
    'delivery/channel/khyquant/services/tokenUsageService.js',
  ];
  // 单次遍历：写者与第二核心两个判据共用同一批读取（内容已缓存）。
  const files = walkFiles(path.join(REPO_ROOT, 'runtime/node'))
    .concat(walkFiles(path.join(REPO_ROOT, 'delivery')))
    .filter((f) => !isTestFile(f));
  const writers = [];
  for (const file of scoped(files)) {
    checksRun += 1;
    const src = readLines(file).join('\n');
    const writesUsage = /token_usage\.json/.test(src) && /(writeFileSync|saveUsageData|writeFile|appendFileSync|renameSync)/.test(src);
    if (writesUsage) {
      writers.push(file);
      if (!knownWriters.includes(rel(file))) {
        counts['metering-unknown-writer'] += 1;
        findings.push({ id: 'metering-unknown-writer', severity: 'warning', file: rel(file), line: 0, message: `计量写者未登记：${rel(file)} 写 token_usage.json 但不在已知写者清单（D4 收敛范围按实测扩，不按设计假设缩）` });
      }
    }
    if (/createCoreServer/.test(src) && !rel(file).startsWith(`${CORE_PKG_DIR}/`)) {
      counts['metering-second-core'] += 1;
      findings.push({ id: 'metering-second-core', severity: 'warning', file: rel(file), line: 0, message: 'core 之外出现 createCoreServer：第二个核心进程会造出第二份计量' });
    }
  }
  const known = writers.filter((f) => knownWriters.includes(rel(f)));
  if (known.length > 1) {
    counts['metering-dual-writer'] += 1;
    findings.push({ id: 'metering-dual-writer', severity: 'warning', file: known.map(rel).join(', '), line: 0, message: `计量存在 ${known.length} 个活跃/休眠写者：收敛前单实例验收不得报 single（D4）` });
  }
}

// ── 运行 ────────────────────────────────────────────────────────────────────────
checksRun += 1;
checkCoreBoundaryImport();
checkTerminalDirectGateway();
checkCoreNotInEntryClosure();
checkCoreSkin();
checksRun += 1;
checkClientNodeFree();
checkCoreEnvSingleSource();
checkTerminalCrossReference();
if (portableMode) {
  checksRun += 1;
  checkPortable();
}
if (suiteMode) {
  checksRun += 1;
  checkSuiteFork();
}
if (lanMode) {
  checksRun += 1;
  checkLan();
}
{
  checksRun += 1;
  checkMetering();
}

counts['checks-run'] = checksRun;

if (jsonOut) {
  process.stdout.write(`${JSON.stringify({ stage: GUARD_STAGE, findings, counts }, null, 2)}\n`);
} else {
  process.stdout.write(`[core-boundary] stage=${GUARD_STAGE} findings=${findings.length} checks-run=${checksRun}\n`);
  for (const f of findings) {
    process.stdout.write(`  [warning] ${f.id} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}\n`);
  }
  if (!findings.length) process.stdout.write('  未发现核心边界问题（S1 观察者：warning 级，不阻断）\n');
}

// PP-3：S1 恒 exit 0。真正想阻断的调用方应在毕业期（S3）自行决定。
process.exit(0);
