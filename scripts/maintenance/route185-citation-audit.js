'use strict';

/**
 * citation-audit.js — 把 [DESIGN-ARCH-185] 里每一条**代码引用**对着仓库核一遍。
 *
 * 动机：本轮之前已经抓到三次「文档说的东西在代码里不存在」——
 *   §13 文件清单 3 处（§16.4u）、A8 的 `estimateCost()`（§19.2）、A2 的 `--batch` 开关（§16.4ae）。
 * 三次都是靠通读偶然撞上的，成本高且不可复现。这份脚本把它变成机械检查：
 *   ① 路径是否解析得到（含 W 迁移前的 `services/backend/**` → `runtime/node/backend/**` 映射）；
 *   ② `file.js:NNN` 的行号是否越过文件末尾（行号会漂，漂了要说，不许假装没看见）；
 *   ③ 反引号里的**符号名**（camelCase / 大写开头）在该文件里到底存不存在。
 *
 * 用法：npm run audit:route185-citations [--verbose]
 * 退出码：0 = 全部可解析；1 = 有未解析路径或有符号在文件里查无（行号漂移只报告不失败）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(
  ROOT,
  'docs',
  '03_DESIGN_设计',
  'DESIGN-ARCH',
  '[DESIGN-ARCH-185] 四档模式与智能路由方案.md'
);

const lines = fs.readFileSync(DOC, 'utf8').split('\n');

// 路径候选根：仓库根、后端源码根、后端根、docs、scripts
// （第一版漏了 `runtime/node/backend/src/`，于是 `services/modelTier.js` 这类
//   「从 src 起算的相对路径」全被判成未解析 —— 271 条噪声，仪器自己错。）
const ROOTS = ['', 'runtime/node/backend/src/', 'runtime/node/backend/', 'runtime/node/ai-backend/', 'docs/', 'scripts/'];

// 论文/上游项目的引用**不该**在本仓解析得到：它们是被借鉴对象的路径。
// 单独归类，不混进「未解析」。（§2/§3 整节都在抄 opensquilla/RouteLLM 的文件树。）
const EXTERNAL_RE = /(\.(py|ya?ml|rs|go)$|^routellm\/|^runtime_src\/|^src\/router\/|router\.runtime\.yaml|config\.example\.yaml|artifact_manifest\.json|PROVENANCE\.md|model_card\.md)/i;

// W 迁移前的老前缀 → 现前缀（AGENTS.md 架构速查里写明的物理化结果）
function remaps(p) {
  const out = [p];
  if (p.startsWith('services/backend/')) out.push(p.replace('services/backend/', 'runtime/node/backend/'));
  if (p.startsWith('extensions/')) out.push(p.replace('extensions/', 'delivery/extension/'));
  if (p.startsWith('substrate/')) out.push(p.replace('substrate/', 'runtime/substrate/'));
  if (p.startsWith('entries/') || p.startsWith('delivery/')) out.push(p);
  return out;
}

// 只认真实代码/配置扩展名，且必须带目录或已知文件名，避免把「§5.4 的 `routeDemand.js`」之外
// 的散文词误当路径。
const PATH_RE = /[A-Za-z0-9_.[\]\u4e00-\u9fa5/-]+\.(?:js|json|md|py|ya?ml|bat|sh|ts|vue)\b/g;
const SYM_RE = /`([A-Za-z][A-Za-z0-9_$]*(?:\.[A-Za-z][A-Za-z0-9_$]*){0,2}(?:\(\))?)`/g;

const unresolvedPaths = [];
const external = [];
const staleLines = [];
const missingSymbols = [];
const resolvedPaths = new Set();

// 散文里写「`toolUseLoopCore.js`」是**光文件名**的引用（真身在 src/services/tool/ 下三层）。
// 第一版只在 3 个固定目录里按 basename 找 ⇒ 194 条未解析几乎全是噪声。
// 正确判据：只要全仓（git 跟踪清单）里存在同名文件，这条引用就是**可解析**的。
const INDEX = (() => {
  const out = new Map();
  try {
    const g = require('child_process');
    // 跟踪 + 未跟踪都要进索引。两次踩坑都在这行：只给 `ls-files` 会把本轮新建的
    // route-replay.js / routing-modes.json 判成幽灵；只给 `ls-files -o` 反过来把
    // modelTier.js 这类**已跟踪**文件判成幽灵（194→71 的“改善”因此是假的）。
    const list = [
      g.execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
      g.execFileSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    ].join('\n').split('\n').filter(Boolean);
    for (const p of list) {
      const b = path.basename(p);
      if (!out.has(b)) out.set(b, []);
      out.get(b).push(p);
    }
  } catch {
    /* git 不可用就退回按目录找 */
  }
  return out;
})();

function findFile(token) {
  const clean = token.replace(/^\.\//, '').replace(/^\/+/, '');
  for (const cand of remaps(clean)) {
    for (const root of ROOTS) {
      const abs = path.join(ROOT, root + cand);
      try {
        if (fs.statSync(abs).isFile()) return abs;
      } catch {
        /* 继续试下一个候选 */
      }
    }
  }
  const base = path.basename(clean);
  if (INDEX.has(base)) return path.join(ROOT, INDEX.get(base)[0]);
  return null;
}

const fileCache = new Map();
function read(f) {
  if (!fileCache.has(f)) fileCache.set(f, fs.readFileSync(f, 'utf8').split('\n'));
  return fileCache.get(f);
}

lines.forEach((raw, i) => {
  const ln = i + 1;
  const tokens = raw.match(PATH_RE) || [];
  for (const t of tokens) {
    if (/\$\{|\{.*\}/.test(t)) continue; // 模板占位（如 route-{a,b}.js 的拆分片段）
    if (EXTERNAL_RE.test(t)) { external.push({ ln, token: t }); continue; }
    const f = findFile(t);
    if (!f) {
      unresolvedPaths.push({ ln, token: t });
      continue;
    }
    resolvedPaths.add(t);
    const m = raw.match(new RegExp(`${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`));
    if (m) {
      const n = Number(m[1]);
      // 光文件名会撞同 basename（本仓 3 例：proxyServer.js 733/3102、zhipuRequestShape.js 205/234、
      // App.js 238/7363）。只挑索引里的第一份来判行号，就会把**正确的引用**判成越界 ——
      // 这 3 条假红我自己刚踩过。判据改成「任一同名文件容得下这一行即通过」。
      const baseTok = path.basename(t.replace(/^\.\//, '').replace(/^\/+/, ''));
      const cands = INDEX.get(baseTok) || [];
      const anyHas = cands.length
        ? cands.some((rel) => read(path.join(ROOT, rel)).length >= n)
        : read(f).length >= n;
      if (!anyHas) staleLines.push({ ln, token: t, n, cands: cands.length });
    }
  }

  // 符号检查：只在该行**已经解析出某个文件**时进行，避免对散文里的类名瞎判
  if (tokens.length) {
    const f = findFile(tokens[0]);
    if (!f) return;
    const body = read(f).join('\n');
    let mm;
    SYM_RE.lastIndex = 0;
    while ((mm = SYM_RE.exec(raw))) {
      const sym = mm[1].replace(/\(\)$/, '').split('.').pop();
      if (sym.length < 4) continue;
      if (!new RegExp(`\\b${sym.replace(/[$]/g, '\\$')}\\b`).test(body)) {
        missingSymbols.push({ ln, sym: mm[1], file: path.relative(ROOT, f) });
      }
    }
  }
});

const verbose = process.argv.includes('--verbose');
process.stdout.write(`文档行 ${lines.length}｜可解析路径 ${resolvedPaths.size}｜未解析 ${unresolvedPaths.length}`
  + `｜外部(论文/上游)引用 ${external.length}｜行号越界 ${staleLines.length}｜查无符号 ${missingSymbols.length}\n`);


const dump = (title, arr, fmt) => {
  if (!arr.length) return;
  process.stdout.write(`\n${title}（${arr.length}）\n`);
  (verbose ? arr : arr.slice(0, 40)).forEach((x) => process.stdout.write('  ' + fmt(x) + '\n'));
  if (!verbose && arr.length > 40) process.stdout.write(`  … 其余 ${arr.length - 40} 条加 --verbose\n`);
};

dump('未解析的路径引用', unresolvedPaths, (x) => `L${x.ln}: ${x.token}`);
dump('行号越界（文件比引用的行号短）', staleLines, (x) => `L${x.ln}: ${x.token}:${x.n}（文件仅 ${x.len} 行）`);
dump('反引号符号在所指文件里查无', missingSymbols, (x) => `L${x.ln}: \`${x.sym}\` ∉ ${x.file}`);

process.exitCode = unresolvedPaths.length + missingSymbols.length > 0 ? 1 : 0;
