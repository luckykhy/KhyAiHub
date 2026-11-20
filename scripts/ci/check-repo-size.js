#!/usr/bin/env node
/**
 * check-repo-size.js — 仓库体积预算守卫（零依赖、跨平台）。
 *
 *   node scripts/ci/check-repo-size.js            # 报告态：打表，恒 exit 0
 *   node scripts/ci/check-repo-size.js --strict   # 超预算则 exit 1
 *   node scripts/ci/check-repo-size.js --update   # 用当前实测值重写基线（须显式）
 *   node scripts/ci/check-repo-size.js --json     # 机器可读
 *
 * ## 为什么要有这条守卫
 *
 * 本仓工作目录一度涨到 22.5 GB，其中 **95% 是未跟踪的本机态与产物**——源码只占
 * 403 MB。膨胀不是某一次事故，是**没有预算**的日常累积：
 *
 *   - `node_modules/` 顶层 48 个 `.`-前缀暂存目录（npm 安装中断残留）
 *   - `works/data/khy/T4-transient/tmp` 一次性诊断转储（语义上可删，却从没人删）
 *   - `works/brand/khyos-desktop/out/frames` 逐场景 PNG 帧（3.9 GB）
 *   - `works/backup/` 只进不出的冗余构建归档
 *
 * `check-dependency-size.js` 管的是**依赖包数**（谁把依赖树撑大了），
 * `check-runtime-footprint.js` 管的是**运行时加载量**（启动时进内存多少）。
 * **没有任何一条守卫管「磁盘上占了多少」** —— 这个空档就是 22.5 GB 的成因。
 *
 * ## 四条预算线
 *
 *   tracked   git 跟踪的源码总量。涨 = 有人把产物提交进了仓库。
 *   workdir   工作目录总量（含未跟踪本机态）。涨 = 产物/残留堆积。
 *   residue   `node_modules/` 顶层的 npm 暂存残留**个数**。必须为 0。
 *   bundle    发行 bundle 合计。涨 = 发行包在变大。
 *
 * ## 测量口径（关键：必须排除 junction / 符号链接）
 *
 * pnpm 的硬链布局下，`node_modules/` 顶层有大量 `.pkg-hash` 目录是**指向
 * `.pnpm/` 真包的 junction**。用「递归求和」去量会**沿着链接走进 `.pnpm`**
 * 把同一份数据数多次 —— 实测这一项虚高 12 倍（1.57 GB 实际只有 130 MB）。
 *
 * 所以本脚本按 **reparse point 逐项排除**：只累加真实文件的字节，
 * 链接本身计 0 字节（它不占额外磁盘，指向的目标由目标自己计）。
 *
 * ## 为什么「残留个数」是硬预算而「字节」只走容差
 *
 * 残留个数是确定的（目录名以 `.` 开头且不是工具保留名），同一台机器上恒定，
 * 适合当阻断条件。字节则受安装顺序、平台、硬链落地情况影响，只做趋势报告。
 *
 * 基线文件：scripts/ci/repo-size-baseline.json（人可读、可 review、进版本库）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(__dirname, 'repo-size-baseline.json');

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const update = argv.includes('--update');
const asJson = argv.includes('--json');

const MB = 1024 * 1024;
const toPosix = (p) => p.split(path.sep).join('/');
const mb = (n) => (n / MB).toFixed(1) + ' MB';

/**
 * node_modules 顶层要保留的 `.`-前缀文件与目录。
 * 这些是 pnpm / npm 自己用的状态文件与工具目录，不是安装残留。
 */
const NM_RESERVED = new Set([
  '.pnpm',
  '.bin',
  '.vite',
  '.vite-temp',
  '.pnpm_patches',
  '.modules.yaml',
  '.package-lock.json',
  '.pnpm-workspace-state-v1.json',
]);

/** 是否是 reparse point（junction / symlink）。 */
function isReparsePoint(abs) {
  try {
    const st = fs.lstatSync(abs);
    return (st.attributes & fs.constants.Stats.Unix) !== undefined
      ? false
      : (st.mode & 0xf000) === 0xa000
        ? true
        : (st.attributes & 0x400) !== 0;
  } catch {
    return false;
  }
}

/**
 * 目录的真实磁盘占用（字节）。**排除 reparse point 本身与链接目标**：
 *  - 顶层若是 reparse point → 返回 0（它指向别处，由目标自己计）
 *  - 递归时跳过 reparse point 的子树（链接不占额外磁盘）
 *  - 链接指向的真实文件字节由目标路径自己计，不重复
 */
function realSize(abs, depth = 0) {
  if (depth > 64) return 0;
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;

  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = path.join(abs, e.name);
    if (e.isSymbolicLink()) continue; // 链接本身不占字节
    if (e.isDirectory()) {
      let cst;
      try {
        cst = fs.lstatSync(child);
      } catch {
        continue;
      }
      // junction / reparse point 目录：跳过整个子树，避免走进目标重复计数
      if (cst.isSymbolicLink() || (cst.attributes & 0x400) !== 0) continue;
      total += realSize(child, depth + 1);
    } else {
      try {
        total += fs.lstatSync(child).size;
      } catch {
        /* 文件可能刚被删 */
      }
    }
  }
  return total;
}

/** git 跟踪文件的总字节。 */
function trackedBytes() {
  let out = '';
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * MB,
    });
  } catch {
    return { bytes: -1, files: 0 };
  }
  const files = out.split('\0').filter(Boolean);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += fs.lstatSync(path.join(ROOT, rel)).size;
    } catch {
      /* 已被删除的跟踪文件（暂存删除）不计入 */
    }
  }
  return { bytes, files: files.length };
}

/** node_modules 顶层的 npm 暂存残留（`.`-前缀、非保留名、非 junction）。 */
function npmResidue() {
  const nm = path.join(ROOT, 'node_modules');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.name.startsWith('.')) continue;
    if (NM_RESERVED.has(e.name)) continue;
    const abs = path.join(nm, e.name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    // junction / symlink 是 pnpm 硬链布局的正常产物（指向 .pnpm 真包），不是残留
    if (st.isSymbolicLink() || (st.attributes & 0x400) !== 0) continue;
    out.push({ name: e.name, bytes: realSize(abs) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** 发行 bundle 合计（pip 与 npm 实际发出去的东西）。 */
function bundleBytes() {
  const dir = path.join(ROOT, 'entries', 'executables', 'modules');
  let ids;
  try {
    ids = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total: 0, items: [] };
  }
  const items = [];
  for (const d of ids) {
    if (!d.isDirectory()) continue;
    const f = path.join(dir, d.name, 'bundle.mjs');
    try {
      items.push({ id: d.name, bytes: fs.statSync(f).size });
    } catch {
      /* 该模块未构建 */
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { total: items.reduce((s, i) => s + i.bytes, 0), items };
}

// ── 基线 ────────────────────────────────────────────────────────────────

const DEFAULT_BASELINE = {
  $comment:
    '仓库体积预算基线（[DESIGN-SIZE-002] §3.2 P1-b）。tracked/workdir/bundle 走容差报告，'
    + 'residueCount 走硬预算（必须为 0）。用 --update 重写。',
  tolerancePct: 10,
  budgets: {},
};

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { ...DEFAULT_BASELINE, budgets: {} };
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { ...DEFAULT_BASELINE, budgets: {} };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

const tracked = trackedBytes();
const workdirBytes = realSize(ROOT);
const residue = npmResidue();
const bundle = bundleBytes();

const measured = {
  trackedBytes: tracked.bytes,
  trackedFiles: tracked.files,
  workdirBytes,
  residueCount: residue.length,
  residueBytes: residue.reduce((s, r) => s + r.bytes, 0),
  bundleBytes: bundle.total,
};

const baseline = loadBaseline();
const budgets = baseline.budgets || {};
const tolerance = Number(baseline.tolerancePct) || 10;

const findings = [];

/**
 * 判一条预算线。
 * @param hard true = 零容差（超过即违规）；false = 走容差百分比
 */
function check(id, label, actual, budgetKey, hard, unit) {
  const raw = budgets[budgetKey];
  const base = Number(raw);
  // 「未登记」= 该键根本不存在；基线为 0 是合法值（残留个数的目标就是 0）。
  if (raw === undefined || raw === null || !Number.isFinite(base)) {
    return { id, label, actual, base: null, over: false, unit };
  }
  const pct = base > 0 ? ((actual - base) / base) * 100 : actual > base ? 100 : 0;
  const over = hard ? actual > base : pct > tolerance;
  if (over) {
    findings.push({
      id,
      severity: 'error',
      label,
      actual,
      max: base,
      unit,
      message:
        `${label} ${unit === 'files' ? actual : mb(actual)}`
        + `${hard ? ' > ' : ' 超基线 '}${unit === 'files' ? base : mb(base)}`
        + `${hard ? '' : `（超 ${pct.toFixed(1)}%，容差 ${tolerance}%）`}`,
    });
  }
  return { id, label, actual, base, over, unit, pct };
}

const checks = [
  check('size-tracked', 'git 跟踪源码总量', measured.trackedBytes, 'trackedBytes', false, 'bytes'),
  check('size-workdir', '工作目录总量', measured.workdirBytes, 'workdirBytes', false, 'bytes'),
  check('size-residue', 'npm 暂存残留个数', measured.residueCount, 'residueCount', true, 'files'),
  check('size-bundle', '发行 bundle 合计', measured.bundleBytes, 'bundleBytes', false, 'bytes'),
];

if (asJson) {
  console.log(JSON.stringify({ ok: findings.length === 0, measured, checks, findings, residue, bundles: bundle.items }, null, 2));
  process.exit(findings.length === 0 || !strict ? 0 : 1);
}

console.log('══ 仓库体积预算检查 ══');
console.log(`契约: ${toPosix(path.relative(ROOT, BASELINE_PATH))}`);
console.log(`口径: 排除 junction / 符号链接（pnpm 硬链布局的必然产物，链接不占额外磁盘）\n`);

console.log('── 预算线 ──');
for (const c of checks) {
  const base = c.base == null ? '基线未登记' : c.unit === 'files' ? `${c.base}` : mb(c.base);
  const cur = c.unit === 'files' ? `${c.actual}` : mb(c.actual);
  const pct = c.base == null ? '' : c.base > 0 ? ` (${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%)` : ' (基线为 0)';
  console.log(
    `  ${c.label.padEnd(22)} ${cur.padStart(12)}  基线 ${base.padStart(12)}${pct}`
    + (c.over ? '   ⚠ 超预算' : '')
  );
}

console.log('');
console.log('── git 跟踪源码 ──');
console.log(`  ${measured.trackedFiles} 个文件，${mb(measured.trackedBytes)}`);

console.log('');
console.log('── npm 暂存残留（node_modules 顶层 `.`-前缀、非保留名、非 junction）──');
if (residue.length === 0) {
  console.log('  无残留 ✅');
} else {
  console.log(`  ${residue.length} 个，合计 ${mb(measured.residueBytes)}`);
  for (const r of residue.slice(0, 10)) {
    console.log(`    ${mb(r.bytes).padStart(10)}  ${r.name}`);
  }
  if (residue.length > 10) console.log(`    …（共 ${residue.length} 个）`);
}

console.log('');
console.log('── 发行 bundle（entries/executables/modules/*/bundle.mjs）──');
if (bundle.items.length === 0) {
  console.log('  未构建，跳过。重建：node works/ship/build/esbuild-modules.js --prod');
} else {
  for (const b of bundle.items) console.log(`    ${mb(b.bytes).padStart(10)}  ${b.id}`);
  console.log(`    合计 ${mb(bundle.total)}`);
}

console.log('');
if (findings.length === 0) {
  console.log('✅ 体积在预算内');
} else {
  for (const f of findings) console.log(`❌ [${f.id}] ${f.message}`);
}

if (update) {
  budgets.trackedBytes = measured.trackedBytes;
  budgets.trackedFiles = measured.trackedFiles;
  budgets.workdirBytes = measured.workdirBytes;
  budgets.residueCount = measured.residueCount;
  budgets.bundleBytes = measured.bundleBytes;
  budgets.measuredAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ ...baseline, tolerancePct: tolerance, budgets }, null, 2) + '\n',
    'utf8'
  );
  console.log(`\n基线已更新 → ${toPosix(path.relative(ROOT, BASELINE_PATH))}`);
}

if (!strict) {
  console.log('\n(报告态：违规不判错。加 --strict 阻断)');
  process.exit(0);
}
process.exit(findings.length === 0 ? 0 : 1);
