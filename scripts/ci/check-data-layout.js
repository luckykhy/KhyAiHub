#!/usr/bin/env node
/**
 * [DESIGN-LAY-007] / LAYOUT-007 三态目录立体分层守卫。
 *
 * 四条检查：
 *   L-1 档位归属 —— 数据态根下出现的 T* 档必须在 DATA-LOCATIONS.json 登记；
 *                   未登记的条目（既非档位、又非索引）计入「未归位」。
 *   L-2 预算     —— 按登记表 budgets 逐目录比对直接条目数。
 *   L-3 绕表直拼 —— 非 dataHome.js 的源文件里字面拼接 .khy/.khyos 段。
 *   L-4 格式卫生 —— 数据根下的裸 .txt / *.tmp.* 残留 / 畸形 .json 目录 /
 *                   白名单外运行时 YAML / 无扩展名文件（内容寻址子树豁免）。
 *                   判据真源：FILE-FORMAT-PROTOCOL.md §2.0/§2.7，
 *                   参数真源：登记表 formats 块（本脚本不另立第二份）。
 *
 * 落地阶段见 [DESIGN-PROCESS-002]：本守卫自身登记为 S1 观察者（PP-1），
 * 只记录不拦截，恒 exit 0。升档只改 GUARD_STAGE 与登记表 stage，不改判定逻辑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const GUARD_STAGE = 'S1';
const REGISTRY_REL = 'docs/10_规范/registry/DATA-LOCATIONS.json';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TIER_PREFIX = /^T\d+-[a-z]+$/;
const INDEX_FILE = '00_INDEX_data.md';

// [RESEARCH-018] §4 C-6：热/温/冷分档表必须与本体检同批产出（真仪器在 scripts/lib/fanInTiering.js）。
// --no-tiers 供需要快档的调用方跳过（全量扫描 ~30s）。
function measureTiers() {
  if (args.includes('--no-tiers')) return null;
  process.stdout.write('布局体检：测量热/温/冷 fan-in 分档（判据 C-6，逐个核心域源文件）…\n');
  try {
    return require('../lib/fanInTiering').measureFanInTiers({ repoRoot: REPO_ROOT, topN: 8 });
  } catch (e) {
    process.stdout.write(`布局体检：fan-in 分档未产出 —— ${e.message}\n`);
    return { error: e.message };
  }
}

const args = process.argv.slice(2);
const opts = {
  json: args.includes('--json'),
  report: args.includes('--report'),
  index: args.includes('--index'),
  quiet: args.includes('--quiet'),
};

function loadRegistry() {
  if (_registry) return _registry;
  const p = path.join(REPO_ROOT, REGISTRY_REL);
  _registry = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _registry;
}
let _registry = null;

// 文案真源在登记表，脚本不另立第二份（[DESIGN-LAY-007] §10 Q4）。
const REGISTRY_TIER_NOTE = (() => {
  try {
    return loadRegistry().tierPrefixNote || '登记表缺 tierPrefixNote 字段：命名声明未落地';
  } catch {
    return `登记表 ${REGISTRY_REL} 不可读：命名声明未取到`;
  }
})();

function directEntries(absDir) {
  let names;
  try {
    names = fs.readdirSync(absDir);
  } catch {
    return null;
  }
  return names.filter((n) => n !== '.DS_Store');
}

/** 定位深度：从数据态根到任一 T0 权威条目的路径段数，须落在 [2,5]。 */
function measureDepth(rootRel, absDir, acc = []) {
  const out = [];
  for (const name of directEntries(absDir) || []) {
    if (name.startsWith('.')) continue;
    const abs = path.join(absDir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      continue; // 悬空符号链接（如 diag 残留 junction）：跳过该项，不炸整轮体检
    }
    if (!isDir) {
      out.push(acc.length + 1);
      continue;
    }
    out.push(...measureDepth(rootRel, abs, [...acc, name]));
  }
  return out;
}

function scanDataRoot(rootRel, reg) {
  const abs = path.join(REPO_ROOT, rootRel);
  const entries = directEntries(abs);
  if (!entries) return { rootRel, exists: false };

  const tierIds = new Set(reg.tiers.map((t) => t.id));
  const findings = [];
  const tiers = [];

  for (const name of entries) {
    const isIndex = name === INDEX_FILE || name.startsWith('00_INDEX');
    const isTier = tierIds.has(name);
    if (!isIndex && !isTier) findings.push({ code: 'L-1/unregistered', entry: name });
    if (TIER_PREFIX.test(name) && !isTier) findings.push({ code: 'L-1/unknown-tier', entry: name });
    if (isTier) {
      const def = reg.tiers.find((t) => t.id === name);
      const kids = directEntries(path.join(abs, name)) || [];
      if (kids.length > def.budget) {
        findings.push({ code: 'L-2/over-budget', entry: `${rootRel}/${name}`, n: kids.length, max: def.budget });
      }
      if (def.perChildBudget) {
        for (const k of kids) {
          const kk = directEntries(path.join(abs, name, k)) || [];
          if (kk.length > def.perChildBudget) {
            findings.push({ code: 'L-2/over-budget-child', entry: `${rootRel}/${name}/${k}`, n: kk.length, max: def.perChildBudget });
          }
        }
      }
      tiers.push({ id: name, entries: kids.length });
    }
  }

  findings.push(...scanFormats(rootRel, reg));

  const rootBudget = (reg.budgets.find((b) => b.dir === rootRel) || {}).max;
  const visible = entries.filter((n) => !n.startsWith('.'));
  if (rootBudget && visible.length > rootBudget) {
    findings.push({ code: 'L-2/over-budget', entry: rootRel, n: visible.length, max: rootBudget });
  }

  const depths = measureDepth(rootRel, abs);
  return {
    rootRel,
    exists: true,
    directTotal: entries.length,
    directVisible: visible.length,
    rootBudget: rootBudget || null,
    tiers,
    depths: depths.length
      ? { min: Math.min(...depths), max: Math.max(...depths), outOfRange: depths.filter((d) => d < 2 || d > 5).length }
      : null,
    findings,
  };
}

/**
 * L-4 落盘格式卫生：遍历数据根，按登记表 formats 块判型。
 * 每类只聚合成一条 finding（n + 限量 sample），避免 66 个裸 txt 刷屏。
 */
function scanFormats(rootRel, reg) {
  const fmt = reg.formats || {};
  const blobRoots = new Set(fmt.blobRoots || []);
  const machineNames = new Set(fmt.machineTreeNames || []);
  const machinePatterns = (fmt.machineTreePatterns || []).map((s) => new RegExp(s));
  const yamlExceptions = (fmt.yamlExceptions || []).map((s) => new RegExp(s));
  const noExtWhitelist = (fmt.noExtWhitelist || []).map((s) => new RegExp(s));
  const cap = fmt.detailCap || 12;
  const isMachineTree = (name) => machineNames.has(name) || machinePatterns.some((re) => re.test(name));
  const abs = path.join(REPO_ROOT, rootRel);
  const buckets = new Map();
  const add = (code, rel) => {
    let b = buckets.get(code);
    if (!b) { b = { n: 0, sample: [] }; buckets.set(code, b); }
    b.n += 1;
    if (b.sample.length < cap) b.sample.push(rel);
  };

  const MAX_VISIT = 50000;
  const stack = [{ dir: abs, inBlob: false }];
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    if (visited >= MAX_VISIT) { truncated = true; break; }
    const { dir, inBlob } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const name = e.name;
      if (name === '.DS_Store') continue;
      const rel = path.relative(abs, path.join(dir, name)).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (isMachineTree(name)) continue; // 缓存/备份/隔离树不受格式卫生管辖
        if (name.endsWith('.json')) add('L-4/malformed-json-dir', rel);
        stack.push({ dir: path.join(dir, name), inBlob: inBlob || blobRoots.has(name) });
        continue;
      }
      visited += 1;
      // 数据根**直接子层**的裸 txt 才违 D3；任务/证据目录内的 .txt 合法（D4）。
      if (!rel.includes('/') && /\.txt$/i.test(name)) add('L-4/bare-txt', rel);
      if (/\.tmp\./i.test(name)) add('L-4/tmp-residue', rel);
      if (/\.ya?ml$/i.test(name) && !yamlExceptions.some((re) => re.test(name))) add('L-4/runtime-yaml', rel);
      if (!inBlob && !name.startsWith('.') && !name.includes('.')
        && !noExtWhitelist.some((re) => re.test(name))) add('L-4/extensionless', rel);
    }
  }

  const findings = [...buckets.entries()].map(([code, b]) => ({
    code, entry: `${rootRel}/`, n: b.n, sample: b.sample,
  }));
  if (truncated) {
    findings.push({ code: 'L-4/scan-truncated', entry: `${rootRel}/`, n: MAX_VISIT, sample: [] });
  }
  return findings;
}

function scanRepoRoot(reg) {
  const entries = directEntries(REPO_ROOT) || [];
  const protectedSet = new Set(reg.protected.toolContractRootFiles);
  const installSet = new Set((reg.topLevel.installArtifacts || []).map((a) => a.name));
  // 自愈型本机态按模式豁免（如 *.baiduyun.uploading.cfg）：每台机器各自产生、
  // gitignore 已隔离，不是仓库内容；不计预算但报告单列，不得静默隐藏。
  const localPats = (reg.topLevel.localStatePatterns || []).map((p) => String(p.pattern || ''));
  const isLocalState = (n) => localPats.some((p) => p.startsWith('*') && n.endsWith(p.slice(1)));
  const dirs = entries.filter((n) => {
    if (!n.startsWith('.') && fs.statSync(path.join(REPO_ROOT, n)).isDirectory()) return true;
    return false;
  });
  const files = entries.filter((n) => !dirs.includes(n));
  const installArtifacts = [...installSet].filter((d) => entries.includes(d));
  const localStateResidue = entries.filter((n) => !installSet.has(n) && isLocalState(n));
  const addressable = entries.filter((n) => !installSet.has(n) && !isLocalState(n));
  const strays = files.filter((f) => !protectedSet.has(f) && !f.startsWith('.') && !installSet.has(f));
  return {
    directTotal: entries.length,
    addressableTotal: addressable.length,
    maxAddressable: (reg.topLevel || {}).maxAddressable || (reg.budgets.find((b) => b.dir === '.') || {}).max,
    installArtifacts,
    localStateResidue,
    dirs: dirs.length,
    files: files.length,
    unprotectedRootFiles: strays,
  };
}

/** L-3：绕开 dataHome 的字面拼接。 */
function scanBypass() {
  const allowed = new Set([
    path.join('services', 'backend', 'src', 'utils', 'dataHome.js').replace(/\\/g, '/'),
    REGISTRY_REL.replace(/\\/g, '/'),
    'scripts/ci/check-data-layout.js',
  ]);
  const roots = ['runtime/node/backend/src', 'runtime/node/backend/bin', 'electron', 'scripts', 'delivery/extension/scripts'];
  const hits = [];
  const stack = roots.map((r) => path.join(REPO_ROOT, r));
  let visited = 0;
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!/\.(js|py|ts|vue)$/.test(e.name) || e.name.endsWith('.test.js')) continue;
      visited += 1;
      const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
      if (allowed.has(rel)) continue;
      let body;
      try {
        body = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const m = body.match(/['"`]\.khy(?:quant|os)?['"`]/);
      if (m) hits.push({ rel, token: m[0] });
    }
  }
  return { visited, hits };
}

function buildReport() {
  const reg = loadRegistry();
  const dataRoots = reg.roots;
  const scans = [];
  for (const key of Object.keys(dataRoots)) {
    const rel = dataRoots[key].rel;
    if (rel === '.state') continue;
    if (!opts.quiet) process.stdout.write(`布局体检：扫描 ${rel}（第 ${scans.length + 1}/${Object.keys(dataRoots).length - 1} 个数据根）…\n`);
    const s = scanDataRoot(rel, reg);
    if (s.exists) scans.push(s);
  }
  const bypass = scanBypass();
  const findings = [];
  for (const s of scans) findings.push(...s.findings);
  return {
    guardStage: GUARD_STAGE,
    blocking: GUARD_STAGE === 'S3' || GUARD_STAGE === 'S4',
    repoRoot: scanRepoRoot(reg),
    dataRoots: scans,
    bypass: { files: bypass.hits.length, scanned: bypass.visited },
    tiers: measureTiers(),
    findingCount: findings.length,
    findings,
  };
}

function emitIndex(rep) {
  const lines = [
    '<!-- 由 scripts/ci/check-data-layout.js --index 生成，不得手改 -->',
    '# 数据态楼层索引',
    '',
    '| 数据根 | 直接条目 | 预算 | 已登记档位 | 深度区间 | 未归位 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of rep.dataRoots) {
    const d = s.depths ? `${s.depths.min}–${s.depths.max}` : '—';
    lines.push(`| \`${s.rootRel}/\` | ${s.directVisible} | ${s.rootBudget ?? '—'} | ${s.tiers.length} | ${d} | ${s.findings.filter((f) => f.code === 'L-1/unregistered').length} |`);
  }
  lines.push('');
  lines.push(`守卫阶段 ${GUARD_STAGE}（观察者，不拦截）；生成时间 ${new Date().toISOString()}`);
  lines.push(`[命名声明] ${REGISTRY_TIER_NOTE}`);
  return lines.join('\n') + '\n';
}

function main() {
  let rep;
  try {
    rep = buildReport();
  } catch (e) {
    process.stdout.write(`布局体检失败：无法读取登记表 ${REGISTRY_REL} —— ${e.message}\n`);
    process.exitCode = 0;
    return;
  }

  if (opts.index) {
    for (const s of rep.dataRoots) {
      const p = path.join(REPO_ROOT, s.rootRel, INDEX_FILE);
      fs.writeFileSync(p, emitIndex({ dataRoots: [s] }));
      process.stdout.write(`已生成索引 ${s.rootRel}/${INDEX_FILE}（1/1 个数据根）\n`);
    }
    return;
  }

  if (opts.json || opts.report) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  } else {
    const rr = rep.repoRoot;
    process.stdout.write(
      `仓库顶层：可寻址 ${rr.addressableTotal} 项（预算 ${rr.maxAddressable}），另有目录 ${rr.dirs} / 文件 ${rr.files}；` +
        `安装产物（已登记·不搬·不计预算）：${rr.installArtifacts.length ? rr.installArtifacts.join(', ') : '无'}；` +
        `本机态残留（已登记·不搬·不计预算）：${rr.localStateResidue.length ? `${rr.localStateResidue.length} 项（${rr.localStateResidue[0]} 等）` : '无'}\n`
    );
    for (const s of rep.dataRoots) {
      const unreg = s.findings.filter((f) => f.code === 'L-1/unregistered').length;
      const l4 = s.findings
        .filter((f) => f.code.startsWith('L-4'))
        .reduce((acc, f) => acc + (typeof f.n === 'number' ? f.n : 1), 0);
      process.stdout.write(
        `${s.rootRel}/：${s.directVisible} 个可见条目（预算 ${s.rootBudget ?? '∞'}），已归位档位 ${s.tiers.length}，未归位 ${unreg}，L-4 格式卫生 ${l4} 项` +
          (s.depths ? `，深度区间 ${s.depths.min}–${s.depths.max}` : '') +
          '\n'
      );
    }
    const t = rep.tiers;
    if (t && !t.error) {
      const f = t.fanInTiers;
      process.stdout.write(
        `fan-in 分档（静态代理：多少个源文件 require 了它；变更频率不可得——git 对象库损坏，见 C-10）：` +
          `热 ${f.hot} / 温 ${f.warm} / 凉 ${f.cool} / 冷 ${f.cold}` +
          `（阈值 ≥${t.thresholds.hot} / ≥${t.thresholds.warm} / ≥${t.thresholds.cool}，` +
          `核心域源文件 ${t.scope.sourceFiles} 个，fan-in 为 0 者 ${t.zeroFanIn} 个）\n`
      );
      process.stdout.write(
        `  最热 ${t.topFanIn.slice(0, 5).map((x) => `${x.file}(${x.fanIn})`).join('、')}\n`
      );
      process.stdout.write(
        `  路径深度 >6 段：${t.depthOver6} 个（C-2 存量）；非字面量 require 站点 ${t.dynamicRequires.sites} 处——盲区，不计入 fan-in\n`
      );
    } else if (t) {
      process.stdout.write(`fan-in 分档缺席：${t.error}\n`);
    }
    process.stdout.write(`绕表直拼：${rep.bypass.files} 个文件（已扫 ${rep.bypass.files ? rep.bypass.scanned : rep.bypass.scanned} 个源文件）\n`);
    process.stdout.write(`合计 ${rep.findingCount} 条待归位项。\n`);
  }

  if (GUARD_STAGE !== 'S1' && GUARD_STAGE !== 'S2' && rep.findingCount > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[LAYOUT-007 ${GUARD_STAGE}] 观察者档：只记录，不阻断。\n`);
  process.stdout.write(`[命名声明] ${REGISTRY_TIER_NOTE}\n`);
  process.exitCode = 0;
}

main();
