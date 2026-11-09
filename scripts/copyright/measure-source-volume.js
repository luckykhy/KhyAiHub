#!/usr/bin/env node
/**
 * measure-source-volume.js —— 源程序量实测（申请表「源程序量」字段的那个数字）
 *
 * 为什么重写（2026-10-24）
 * ───────────────────────
 * 申请表第 20 项「源程序量」要填**纯数字**，口径是「全部源程序的总行数」。
 * 仓外原实现靠 Python 的 `analyze_project.py`（vendored 上游同款）取这个数，
 * 本机没有 Python → **这个必填字段当前无法重取**。而它恰恰是「移动值」
 * （每次改代码都在变），交表前必须在冻结时点重取一次，不能抄旧值。
 *
 * 本脚本**逐条复刻** vendored 上游 `scripts/common.py` 的判据
 * （`iter_source_files` + `is_source_candidate` + `count_text_lines(skip_blank=False)`），
 * 使 Node 侧取到的数与官方脚本同口径。复刻清单见下方「口径对照」。
 *
 * ── 口径对照（逐条对照 vendored scripts/common.py）──────────────────────
 *   · 遍历：递归跳过 `is_excluded` 命中的目录/文件
 *   · 排除目录 EXCLUDE_DIRS：.git .hg .svn .idea .vscode __pycache__
 *     node_modules dist build .next .nuxt .output coverage target vendor
 *     软件著作权申请资料 software-copyright-materials
 *   · 点目录：名字以 `.` 开头（`.env.example` 除外）
 *   · 锁文件 LOCK_FILES：package-lock.json pnpm-lock.yaml yarn.lock bun.lockb bun.lock
 *   · 压缩产物：*.map *.min.js *.min.css
 *   · 已知配置文件 KNOWN_CONFIG_FILES：babel/eslint/prettier/tsconfig/package.json 等
 *   · 非源码文本：DOCUMENT_EXTS（.md .txt .pdf …）BINARY_EXTS（.png .zip …）
 *     NON_SOURCE_TEXT_EXTS（.csv .log .tsv）
 *   · 文档名前缀：changelog code_of_conduct contributing license readme security
 *   · 内容判据：0 < size ≤ 800000；非二进制；样本非空；
 *     前 80 行无 >3000 字符的行；至少含一个字母或数字
 *   · 行数：`len(text.splitlines())`（**含空行**）
 *
 * ── 为什么要复刻而不是抄旧值 ───────────────────────────────────────────
 * 旧值（如 1,597,819）是 2026-09-20 的快照，此后仓库做了目录物理化与大量功能，
 * 今天的真实值已经不是那个数。申请表填错 = 材料与实物不符。
 *
 * ── 性能注意 ────────────────────────────────────────────────────────────
 * 单趟完成「判据 + 读 + 数行」。早期版本每文件读两遍全文（候选判定一遍、
 * 统计再一遍），在 1.6M 行量级的仓上实测跑不满 5 分钟就被砍掉。
 *
 * 用法
 * ────
 *   node scripts/copyright/measure-source-volume.js               # 打印总行数与语言分布
 *   node scripts/copyright/measure-source-volume.js --json        # 机器可读
 *   node scripts/copyright/measure-source-volume.js --top 20      # 列出最大的 20 个源文件
 *
 * Exit: 0 成功；1 读取失败。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── vendored common.py 的判据（逐条复刻，改动须回看上游）───────────────
const EXCLUDE_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', '__pycache__', 'node_modules',
  'dist', 'build', '.next', '.nuxt', '.output', 'coverage', 'target', 'vendor',
  '软件著作权申请资料', 'software-copyright-materials',
]);

const LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
]);

const KNOWN_CONFIG_FILES = new Set([
  '.babelrc', '.eslintrc', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml',
  '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
  '.swcrc', 'angular.json', 'app.json', 'astro.config.mjs', 'astro.config.ts',
  'babel.config.js', 'babel.config.json', 'Cargo.lock', 'Cargo.toml',
  'composer.json', 'docker-compose.yaml', 'docker-compose.yml',
  'eslint.config.cjs', 'eslint.config.js', 'eslint.config.mjs', 'go.mod',
  'go.sum', 'jsconfig.json', 'lerna.json', 'manifest.json', 'next.config.js',
  'next.config.mjs', 'next.config.ts', 'nuxt.config.js', 'nuxt.config.ts',
  'nx.json', 'package-lock.json', 'package.json', 'playwright.config.js',
  'playwright.config.ts', 'postcss.config.cjs', 'postcss.config.js',
  'prettier.config.cjs', 'prettier.config.js', 'prettier.config.mjs',
  'project.json', 'pyproject.toml', 'rollup.config.js', 'rollup.config.mjs',
  'rollup.config.ts', 'svelte.config.js', 'stylelintrc.json',
  'tailwind.config.js', 'tailwind.config.ts', 'tsconfig.app.json',
  'tsconfig.json', 'tsconfig.node.json', 'tslint.json', 'turbo.json',
  'vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vitest.config.js',
  'vitest.config.ts', 'webpack.config.js', 'webpack.config.ts',
  'workspace.json', '.env.example',
]);

const DOCUMENT_EXTS = new Set([
  '.adoc', '.doc', '.docx', '.md', '.odt', '.pdf', '.rst', '.rtf', '.txt', '.wps',
]);

const BINARY_EXTS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.db', '.dll', '.dmg', '.eot',
  '.exe', '.flac', '.gif', '.gz', '.ico', '.iso', '.jar', '.jpeg', '.jpg', '.lib',
  '.lockb', '.mov', '.mp3', '.mp4', '.o', '.obj', '.ogg', '.otf', '.pdb', '.png',
  '.pyc', '.rar', '.so', '.sqlite', '.sqlite3', '.tar', '.ttf', '.wav', '.webm',
  '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);

const NON_SOURCE_TEXT_EXTS = new Set(['.csv', '.log', '.tsv']);

const DOCUMENT_FILE_PREFIXES = [
  'changelog', 'code_of_conduct', 'contributing', 'license', 'readme', 'security',
];

const MAX_SOURCE_FILE_BYTES = 800000;

// ── argv ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const AS_JSON = has('--json');
const TOP_N = Number(opt('--top', '0')) || 0;
/** 「纯代码」口径：排除 docs/ 与 works/record/（文档不是源程序）。默认关闭（与上游口径一致）。 */
const EXCLUDE_DOCS = has('--exclude-docs');

// ── 判据 ────────────────────────────────────────────────────────────────
const isExcludedName = (name) => {
  if (EXCLUDE_DIRS.has(name)) return true;
  if (name.startsWith('.') && name !== '.env.example') return true;
  if (LOCK_FILES.has(name)) return true;
  if (name.endsWith('.map') || name.endsWith('.min.js') || name.endsWith('.min.css')) return true;
  return false;
};

/**
 * 路径的任一**目录段**命中排除目录 ⇒ 整条路径排除。
 *
 * 为什么需要：上游 iter_project_files 是 os.walk 递归，遇到排除目录就剪枝（不进去）。
 * 本脚本的 git 枚举给出的是**平铺**的文件列表，原来只对 basename 跑 is_excluded ——
 * 于是 `runtime/boot/kernel/vendor/moonbit/*.c`、`scripts/copyright/vendor/**` 这些
 * 第三方代码全被算进了「源程序量」（实测 131 个文件 / 25491 行，占总量约 1.2%）。
 * 申报的源程序量里混进第三方代码，与 B6「第三方代码不进登记材料」直接冲突。
 */
const hasExcludedDirSegment = (rel) =>
  rel.split('/').slice(0, -1).some((seg) => EXCLUDE_DIRS.has(seg));

function looksBinary(buf, suffix) {
  const chunk = buf.subarray(0, 8192);
  if (!chunk.length) return false;
  if (BINARY_EXTS.has(suffix)) return true;
  const startsWith = (sig) => chunk.subarray(0, sig.length).equals(sig);
  if (startsWith(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return true;
  if (startsWith(Buffer.from('%PDF-', 'latin1'))) return true;
  if (startsWith(Buffer.from([0x1f, 0x8b]))) return true;
  if (startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return true;
  if (startsWith(Buffer.from('GIF8', 'latin1'))) return true;
  if (startsWith(Buffer.from([0xff, 0xfe])) || startsWith(Buffer.from([0xfe, 0xff]))) return false;
  if (startsWith(Buffer.from([0xff, 0xfe, 0x00, 0x00]))) return false;
  if (startsWith(Buffer.from([0x00, 0x00, 0xfe, 0xff]))) return false;
  if (chunk.includes(0)) return true;
  let control = 0;
  for (const b of chunk) {
    if (b < 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) control += 1;
  }
  return control / chunk.length > 0.02;
}

/** Python `text.splitlines()` 的行数语义（尾随换行不产生空行）。 */
function splitLineCount(text) {
  if (!text) return 0;
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * 判据 + 取回内容（一次读）。
 * 返回 Buffer 表示「是源文件」，返回 null 表示不是。
 */
function readCandidateBuffer(abs, name) {
  if (KNOWN_CONFIG_FILES.has(name)) return null;
  const suffix = path.extname(name).toLowerCase();
  const lower = name.toLowerCase();
  if (DOCUMENT_EXTS.has(suffix) || BINARY_EXTS.has(suffix) || NON_SOURCE_TEXT_EXTS.has(suffix)) return null;
  if (DOCUMENT_FILE_PREFIXES.some((p) => lower.startsWith(p))) return null;

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  // 体积闸门必须在**读之前** —— 否则超大文件会先整份读进内存才被丢掉。
  if (stat.size <= 0 || stat.size > MAX_SOURCE_FILE_BYTES) return null;

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (looksBinary(buf, suffix)) return null;

  const sample = buf.subarray(0, 20000).toString('utf8');
  if (!sample.trim()) return null;
  const firstLines = sample.split(/\r\n|\r|\n/).slice(0, 80);
  if (firstLines.some((l) => l.length > 3000)) return null;
  // Python `any(char.isalnum() for char in sample)`：字母或数字（含非 ASCII）
  if (!/[0-9A-Za-zÀ-￿]/.test(sample)) return null;
  return buf;
}

// ── 遍历 + 统计（单趟）─────────────────────────────────────────────────
// 每读一次就把行数记下，不在第二趟重读 —— 一趟双读在 1.6M 行量级的仓上
// 实测能把 5 分钟跑满（每文件两遍全文 I/O）。
//
// 枚举用 `git ls-files`（**跟踪文件**）而不是 fs 递归，两个理由：
//   ① 正确：works/data/ 是运行态数据根（.gitignore + DATA-LOCATIONS 双重真源），
//      实测在本机躺着 75497 个文件、约 500MB —— 它**永远不进提交**，
//      不属于登记软件的源程序。把它算进去 = 申请表数字虚高。
//   ② 快：fs 递归要 stat+read 7.5 万个运行态文件；git ls-files 只列 11526 个。
//      实测 fs 递归版跑满 600 秒仍未结束，git 版秒级返回。
// git 不可用时回退到 fs 递归（口径会含未跟踪文件，报告里标注）。
const TRACKED = trackedFiles();

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return { files, mode: 'git-tracked' };
  } catch {
    /* git 不可用 → 回退 fs 递归 */
  }
  const files = [];
  (function scan(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isExcludedName(e.name)) continue;
        scan(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (isExcludedName(e.name)) continue;
        files.push(childRel);
      }
    }
  })(REPO_ROOT, '');
  return { files, mode: 'fs-walk' };
}

let totalLines = 0;
let fileCount = 0;
const byExt = new Map();
const perFile = [];

for (const rel of TRACKED.files) {
  // 锁文件/压缩产物等：上游 iter_project_files 对文件也跑 is_excluded，
  // git 枚举路径绕过了那一层，故这里补上（pnpm-lock.yaml 单文件就 15734 行）。
  const nameOnly = rel.split('/').pop();
  if (isExcludedName(nameOnly)) continue;
  // 目录级排除（git 枚举是平铺的，没有 os.walk 的剪枝）：路径任一段命中排除目录即整条排除。
  if (hasExcludedDirSegment(rel)) continue;
  // 「纯代码」口径：文档不是源程序。上游口径**会**把 docs/ 下的 HTML 孪生算进去
  // （实测 161786 行，占总量约 7.6%），本开关给出排除文档后的数字供人工选择。
  if (EXCLUDE_DOCS) {
    const top = rel.split('/')[0];
    if (top === 'docs' || rel.startsWith('works/record/')) continue;
  }
  const abs = path.join(REPO_ROOT, rel.split('/').join(path.sep));
  const buf = readCandidateBuffer(abs, nameOnly);
  if (!buf) continue;
  const lines = splitLineCount(buf.toString('utf8'));
  totalLines += lines;
  fileCount += 1;
  const ext = path.extname(abs).toLowerCase() || '(无扩展名)';
  byExt.set(ext, (byExt.get(ext) || 0) + lines);
  perFile.push({ file: rel, lines });
}

const sortedExt = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
perFile.sort((a, b) => b.lines - a.lines);

const result = {
  measuredAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  repo: 'khy-os',
  enumeration: TRACKED.mode,
  sourceFileCount: fileCount,
  totalLineCount: totalLines,
  byExtension: Object.fromEntries(sortedExt),
  note:
    '口径与 vendored 上游 analyze_project.py 一致（内容检测 + 含空行的物理行数）。' +
    '这是「移动值」—— 交表前须在冻结时点重取，不要抄旧值。',
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`源程序量（申请表第 20 项填这个纯数字）: ${totalLines}`);
  console.log(`源文件数: ${fileCount}`);
  console.log(`取数时点: ${result.measuredAt}`);
  console.log('');
  console.log('语言分布（按行数）:');
  for (const [ext, n] of sortedExt.slice(0, 15)) {
    console.log(`  ${ext.padEnd(8)} ${n}`);
  }
  if (TOP_N > 0) {
    console.log('');
    console.log(`最大的 ${TOP_N} 个源文件:`);
    for (const f of perFile.slice(0, TOP_N)) {
      console.log(`  ${String(f.lines).padStart(8)}  ${f.file}`);
    }
  }
  console.log('');
  console.log('⚠ 这是移动值：交表前须在冻结时点重跑本命令，不要抄历史值。');
}
