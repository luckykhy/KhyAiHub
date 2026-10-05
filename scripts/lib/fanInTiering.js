'use strict';

/**
 * fanInTiering.js — 热/温/冷 fan-in 分档的**常驻**测量叶子（判据 [RESEARCH-018] §4 C-6）。
 *
 * 此前这份分档表只存在一次性快照里（`.khyos/tmp/fanin-depth-census.js`），
 * 快照会腐烂、也不在任何人重跑的路径上 ⇒ C-6 判据「随 check:data-layout 同批产出」
 * 实质未落地。本叶子把同一算法收进 `scripts/`，由 `check-data-layout.js` 每次调用，
 * 于是读数有了稳定的产地与时间戳。
 *
 * 两条口径纪律：
 *   1. **不另立第二份清单**：扫描范围与域归属全部从
 *      `docs/10_规范/registry/DOMAIN-DEPS.json` 的 `domains.*.roots` / `.overrides` 派生，
 *      阈值从 `DATA-LOCATIONS.json` 的 `fanInTiers` 块读取（同 check-data-layout 的
 *      「参数真源在登记表」惯例）。
 *   2. **代理口径如实标注**：[RESEARCH-018] §2 的分类依据是**变更频率**，
 *      本仓 git 对象库损坏（`git fsck` hash-path mismatch，C-10 FAIL）⇒ 频率取不到，
 *      改用的仍是**静态 fan-in 代理**（多少个源文件 require 了它）。输出里以
 *      `proxy` 字段显式声明，绝不把代理读数说成频率测量。
 *
 * 纯测量：只读文件系统，绝不写盘、绝不 exit、绝不判定合规与否。
 */

const fs = require('fs');
const path = require('path');

const DOMAIN_DEPS_REL = 'docs/10_规范/registry/DOMAIN-DEPS.json';
const DATA_LOCATIONS_REL = 'docs/10_规范/registry/DATA-LOCATIONS.json';

// D5（工程与档案）是冷档归档面，不进核心 fan-in 统计口径。
const EXCLUDED_DOMAIN = 'D5';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
]);

function readJson(absPath, label) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    throw new Error(`${label} 读不到：${absPath}（${e.code || e.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} 解析失败：${absPath}（${e.message}）`);
  }
}

function toRel(repoRoot, abs) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

/**
 * 从 DOMAIN-DEPS.json 派生「前缀 → 域」匹配表。
 * overrides 与 roots 一起参与**最长前缀**竞争，故 `runtime/node/backend/src/services/domain`
 * 这类覆盖项会自然压过 `runtime/node/backend/src/services`。
 * @returns {Array<{prefix:string,domain:string}>}
 */
function loadDomainMatchers(repoRoot) {
  const reg = readJson(path.join(repoRoot, DOMAIN_DEPS_REL), 'DOMAIN-DEPS');
  const domains = reg.domains || {};
  const matchers = [];
  for (const [domain, spec] of Object.entries(domains)) {
    for (const root of spec.roots || []) {
      matchers.push({ prefix: String(root).replace(/\/+$/, ''), domain });
    }
    for (const ov of spec.overrides || []) {
      if (!ov || !ov.prefix || !ov.domain) continue;
      matchers.push({ prefix: String(ov.prefix).replace(/\/+$/, ''), domain: ov.domain });
    }
  }
  matchers.sort((a, b) => b.prefix.length - a.prefix.length);
  return matchers;
}

function domainOf(rel, matchers) {
  for (const m of matchers) {
    if (rel === m.prefix || rel.startsWith(`${m.prefix}/`)) return m.domain;
  }
  return 'UNMAPPED';
}

/** 参与统计的核心根 = 除 D5 外所有域的 roots 并集（域内 overrides 不额外扩根）。 */
function loadCoreRoots(repoRoot) {
  const reg = readJson(path.join(repoRoot, DOMAIN_DEPS_REL), 'DOMAIN-DEPS');
  const domains = reg.domains || {};
  const roots = [];
  for (const [domain, spec] of Object.entries(domains)) {
    if (domain === EXCLUDED_DOMAIN) continue;
    for (const root of spec.roots || []) if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/** 阈值真源：DATA-LOCATIONS.json 的 fanInTiers 块。缺块 = 如实报错，不静默兜底。 */
function loadTierThresholds(repoRoot) {
  const reg = readJson(path.join(repoRoot, DATA_LOCATIONS_REL), 'DATA-LOCATIONS');
  const t = reg.fanInTiers;
  if (!t) {
    throw new Error(
      `DATA-LOCATIONS.json 缺 fanInTiers 块：阈值必须在登记表里声明，脚本不另立第二份`
    );
  }
  const missing = ['hot', 'warm', 'cool'].filter((k) => !Number.isInteger(t[k]));
  if (missing.length) {
    throw new Error(`DATA-LOCATIONS.json 的 fanInTiers 缺整数档位：${missing.join(', ')}`);
  }
  return { hot: t.hot, warm: t.warm, cool: t.cool };
}

function isSourceFile(rel) {
  return rel.endsWith('.js') && !rel.endsWith('.test.js') && !/(^|\/)tests?\//.test(rel);
}

function collectFiles(repoRoot, roots) {
  const found = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) found.push(p);
    }
  };
  for (const root of roots) {
    const p = path.join(repoRoot, root);
    if (fs.existsSync(p)) walk(p);
  }
  return found;
}

/**
 * 剥掉注释与行尾噪声，只留代码部分再抓 require 说明符 ——
 * 注释里出现的 require(...) 会虚增 fan-in（首版探针即因此偏高）。
 */
function specifiersOf(absPath) {
  const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    let code = '';
    for (let k = 0; k < raw.length; k += 1) {
      if (inBlock) {
        if (raw[k] === '*' && raw[k + 1] === '/') {
          inBlock = false;
          k += 1;
        }
        code += ' ';
        continue;
      }
      if (raw[k] === '/' && raw[k + 1] === '*') {
        inBlock = true;
        code += '  ';
        k += 1;
        continue;
      }
      if (raw[k] === '/' && raw[k + 1] === '/') break;
      code += raw[k];
    }
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(code))) out.push({ line: i + 1, spec: m[1] });
    // 非字面量参数（require(变量) / require(path.join(...))）：静态口径**盲区**，
    // 实测本仓确有此类站点（delivery/extension/scripts/khy-portable 三处指向 utils/dataHome.js），
    // 故如实计数而不是当作零。
    const dynRe = /require\(\s*(?![\s)'"])/g;
    let d;
    while ((d = dynRe.exec(code))) out.push({ line: i + 1, spec: null, dynamic: true });
  }
  return out;
}

function resolveLocal(repoRoot, fromAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = toRel(repoRoot, path.resolve(path.dirname(fromAbs), spec));
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
  for (const c of candidates) {
    const p = path.join(repoRoot, c);
    try {
      if (fs.statSync(p).isFile()) return c;
    } catch {
      /* 该候选不存在，试下一个 */
    }
  }
  return null;
}

function tierOf(n, thresholds) {
  if (n >= thresholds.hot) return 'hot';
  if (n >= thresholds.warm) return 'warm';
  if (n >= thresholds.cool) return 'cool';
  return 'cold';
}

/**
 * 测量核心域的 fan-in 分档与路径深度分布。
 * @param {object} [options]
 * @param {string} [options.repoRoot] 仓库根（默认本文件上两级）
 * @param {number} [options.topN] topFanIn / unitRolling 各取多少条
 * @returns {object} 分档表（可直接渲染），字段与旧快照兼容
 */
function measureFanInTiers(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
  const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : 40;
  const thresholds = options.thresholds || loadTierThresholds(repoRoot);
  const matchers = loadDomainMatchers(repoRoot);
  const roots = loadCoreRoots(repoRoot);

  const sources = collectFiles(repoRoot, roots)
    .map((abs) => ({ abs, rel: toRel(repoRoot, abs) }))
    .filter((x) => isSourceFile(x.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const inSet = new Map();
  const fanOut = new Map();
  const dangling = [];
  let dynamicSites = 0;
  const dynamicByTargetDir = new Map();
  for (const { abs, rel } of sources) {
    if (!fanOut.has(rel)) fanOut.set(rel, 0);
    for (const { line, spec, dynamic } of specifiersOf(abs)) {
      if (dynamic) {
        dynamicSites += 1;
        const dir = path.dirname(rel);
        dynamicByTargetDir.set(dir, (dynamicByTargetDir.get(dir) || 0) + 1);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const target = resolveLocal(repoRoot, abs, spec);
      if (!target) {
        dangling.push({ from: rel, line, spec });
        continue;
      }
      fanOut.set(rel, fanOut.get(rel) + 1);
      if (!inSet.has(target)) inSet.set(target, new Set());
      inSet.get(target).add(rel);
    }
  }

  const tiers = { hot: 0, warm: 0, cool: 0, cold: 0 };
  const byDomain = {};
  const perFile = [];
  const unitAgg = new Map();
  const depthHist = {};
  for (const { rel } of sources) {
    const n = (inSet.get(rel) || new Set()).size;
    const out = fanOut.get(rel) || 0;
    const tier = tierOf(n, thresholds);
    const domain = domainOf(rel, matchers);
    tiers[tier] += 1;
    byDomain[domain] = (byDomain[domain] || 0) + 1;
    const segs = rel.split('/').length;
    depthHist[segs] = (depthHist[segs] || 0) + 1;
    perFile.push({ rel, fanIn: n, fanOut: out, tier, domain });
    // 单元聚合按前 7 段（域根 → 层 → 能力目录）收口，避免每文件一行读不出结构。
    const unit = rel.split('/').slice(0, 7).join('/');
    if (!unitAgg.has(unit)) unitAgg.set(unit, { files: 0, fanInSum: 0, maxFanIn: 0, domain });
    const a = unitAgg.get(unit);
    a.files += 1;
    a.fanInSum += n;
    a.maxFanIn = Math.max(a.maxFanIn, n);
  }

  const ranked = perFile.slice().sort((a, b) => b.fanIn - a.fanIn || a.rel.localeCompare(b.rel));
  return {
    proxy: 'static fan-in（多少个源文件 require 了它）；变更频率不可得：git 对象库损坏 ⇒ C-10 FAIL',
    thresholds,
    scope: { coreRoots: roots, sourceFiles: perFile.length, excludedDomain: EXCLUDED_DOMAIN },
    fanInTiers: tiers,
    fanInByDomain: byDomain,
    zeroFanIn: perFile.filter((x) => x.fanIn === 0).length,
    topFanIn: ranked.slice(0, topN).map((x) => ({
      file: x.rel,
      fanIn: x.fanIn,
      domain: x.domain,
      tier: x.tier,
    })),
    depthHistogram: depthHist,
    depthOver6: perFile.filter((x) => x.rel.split('/').length > 6).length,
    unresolvedSpecifiers: dangling.length,
    unresolvedSample: dangling.slice(0, 20),
    // 静态盲区自证：非字面量 require 的站点数与最集中的目录。这些边**不计入** fan-in。
    dynamicRequires: {
      sites: dynamicSites,
      topDirs: [...dynamicByTargetDir.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([dir, count]) => ({ dir, count })),
    },
    unitRolling: [...unitAgg.entries()]
      .sort((a, b) => b[1].fanInSum - a[1].fanInSum || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([unit, a]) => ({ unit, ...a })),
  };
}

module.exports = {
  measureFanInTiers,
  loadDomainMatchers,
  loadCoreRoots,
  loadTierThresholds,
  domainOf,
  tierOf,
};
