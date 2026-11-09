#!/usr/bin/env node
'use strict';

/**
 * check-ssot-data.js — 数据事实「单一真源」守卫（LAYOUT-008）。
 *
 * ## 它治什么病
 *
 * 同一份数据写在两个地方时，两处一开始相同；改了一处，另一处就成了**矛盾**。
 * 这类漂移的特点是：没有任何一个文件是错的，只有两个文件对同一件事说法不同。
 * 所以守卫不问「这个文件对不对」，只问「这件事有几处声明」。
 *
 * 判据（详见 scripts/lib/ssotDataGuard.js）：
 *   D1 ssot-shadow-copy         影子副本（warning）：真源之外又写了一遍真源的值
 *   D2 ssot-value-contradiction 值矛盾（error）  ：同一事实出现两个不同的值
 *   D3 ssot-mirror-drift        镜像失步（error）  ：已登记的授权镜像与真源不一致
 *   D4 ssot-source-shadow-copy  整文件副本（error）：真源文件被逐字节复制到第二处
 *   D5 ssot-*-missing           判据失效（error）  ：真源/指针/镜像取不到 —— 必须报红
 *
 * ## 真源在哪
 *
 * `docs/10_规范/registry/DATA-SSOT.json` 登记**真源在哪、怎么取、谁是授权镜像**，
 * **不登记值本身** —— 值一律运行时从真源文件读。登记表若也存一份值，它自己就成了
 * 第二真源，本守卫立刻失去意义。
 *
 * ## 落地阶段（PROCESS-006 PP-1 / PROCESS-008）
 *
 * `STAGE = 'S1'`：观察者，只记录不阻断，恒 exit 0。
 * 加 `--strict` 时有 error 即 exit 1（供升档前自测与本地把关）。
 * 阶段登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`ssot-data-guard`）。
 *
 * ## 用法
 *
 *   node scripts/ci/check-ssot-data.js                # 全量扫描（默认）
 *   node scripts/ci/check-ssot-data.js --changed      # 只扫改动文件（PR 快速档）
 *   node scripts/ci/check-ssot-data.js --json         # 机读输出
 *   node scripts/ci/check-ssot-data.js --strict       # error 即 exit 1
 *   node scripts/ci/check-ssot-data.js --list=ssot-shadow-copy
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const guard = require('../lib/ssotDataGuard');

const STAGE = 'S1';
const OBSERVER_STAGES = new Set(['S1', 'S2']);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_REL = 'docs/10_规范/registry/DATA-SSOT.json';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const changedMode = args.includes('--changed');
const strictMode = args.includes('--strict');
const listMode = (() => {
  const m = args.find((a) => a.startsWith('--list='));
  return m ? m.slice('--list='.length) : null;
})();

/** 语料候选扩展名：代码 + JSON。md/html 不入语料（文档主张由 DOCS-006/007 负责）。 */
const CORPUS_EXT = /\.(js|mjs|cjs|ts|tsx|vue|py|dart|json)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function run(cmd, cmdArgs) {
  try {
    return cp.execFileSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    return e.stdout ? String(e.stdout) : '';
  }
}

function loadRegistry() {
  const abs = path.join(REPO_ROOT, REGISTRY_REL);
  if (!fs.existsSync(abs)) {
    console.error(`[ERROR] ${REGISTRY_REL} 不存在 —— 判据失效，报红。`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`[ERROR] ${REGISTRY_REL} 不是合法 JSON：${e.message} —— 判据失效，报红。`);
    process.exit(1);
  }
}

/** 受版本控制的文件 + 未跟踪新文件（`git diff` 看不见 untracked，会漏掉新影子副本）。 */
function listRepoFiles() {
  const set = new Set();
  for (const line of run('git', ['ls-files']).split('\n')) {
    const rel = line.trim();
    if (rel) set.add(rel.replace(/\\/g, '/'));
  }
  for (const rel of listUntrackedFiles()) set.add(rel);
  return [...set];
}

/** 未跟踪新文件（git grep 只搜已跟踪文件，新文件必须单独补进来）。 */
function listUntrackedFiles() {
  const out = [];
  for (const line of run('git', ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const rel = line.trim();
    if (rel) out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

/** 改动文件（已跟踪变更 + 未跟踪新文件）。 */
function listChangedFiles() {
  const set = new Set();
  for (const line of run('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']).split('\n')) {
    const rel = line.trim();
    if (rel) set.add(rel.replace(/\\/g, '/'));
  }
  for (const line of run('git', ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const rel = line.trim();
    if (rel) set.add(rel.replace(/\\/g, '/'));
  }
  return [...set];
}

/** 登记表里的 scan 段决定语料范围；缺省时用内置保守范围。 */
function scanConfig(registry) {
  const scan = (registry && registry.scan) || {};
  return {
    include: Array.isArray(scan.include) && scan.include.length
      ? scan.include
      : ['runtime/', 'delivery/', 'apps/', 'scripts/', 'tools/', 'works/', 'docs/', 'entries/'],
    exclude: Array.isArray(scan.exclude) ? scan.exclude : [],
  };
}

/** 路径是否落在 include 范围内（include 为目录前缀或精确路径）。 */
function inInclude(relPath, include) {
  if (include.length === 0) return true;
  return include.some((entry) => {
    const e = String(entry).replace(/\\/g, '/');
    if (e.endsWith('/')) return relPath.startsWith(e);
    return relPath === e;
  });
}

/** 路径是否命中排除项（支持 `dir/` 前缀与 `**` 通配）。 */
function inExclude(relPath, exclude) {
  return guard.isExcluded(relPath, exclude);
}

function readTextFile(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** 事实声明过的全部标识符（影子副本扫描的锚点）。 */
function allIdentifiers(registry) {
  const ids = new Set();
  for (const fact of (registry && registry.facts) || []) {
    const detect = (fact && fact.detect) || {};
    for (const id of detect.identifiers || []) {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids];
}

/**
 * 字段级语料：**只读可能含标识符的文件**。
 *
 * 逐事实全量扫描要读遍全仓（实测 5900 文件 → 88 秒），进不了 CI。
 * 改用 `git grep` 一次定位：把全部标识符拼成一个正则，让 git 在 C 层筛出候选文件，
 * 再由 Node 逐行判定。实测降到秒级。
 */
function buildFieldCorpus(registry) {
  const scan = scanConfig(registry);
  const identifiers = allIdentifiers(registry);
  const required = new Set();
  for (const source of (registry.sources || [])) {
    if (source && source.path) required.add(source.path);
  }
  for (const fact of (registry.facts || [])) {
    if (fact && fact.ssot && fact.ssot.path) required.add(fact.ssot.path);
    for (const mirror of (fact && fact.mirrors) || []) {
      if (mirror && mirror.path) required.add(mirror.path);
    }
  }

  const candidates = new Set();

  // 候选定位：**一次** git grep 同时定位「含标识符」与「含可区分值」的文件。
  //
  // 为什么合成一次而不是分两轮：实测 7 轮 grep（1 轮标识符 + 6 轮值）要 30 秒，
  // 一轮只要几秒 —— grep 每次都要重新扫一遍索引。合成后候选集更大一点
  // （约 100 个文件），但读取成本可忽略。
  //
  // 为什么要**按值**再筛一遍：补网存在的意义是抓「没有登记标识符的别名副本」，
  // 只按标识符 grep 会把补网的候选全过滤掉，等于没上这层网。
  const patternParts = identifiers.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const fact of registry.facts || []) {
    const detect = (fact && fact.detect) || {};
    if (!detect.valueAnchor) continue;
    const ssot = fact.ssot || {};
    if (!ssot.path) continue;
    const text = readTextFile(ssot.path);
    if (text === null) continue;
    const resolved = guard.resolveValue(text, ssot.kind, ssot.pointer);
    if (!resolved) continue;
    const numeric = Number(resolved.value);
    // 只有区分度够的值才进补网（小于 100 的值噪声压过价值，见守卫核心的说明）。
    if (!Number.isFinite(numeric) || numeric < 100) continue;
    patternParts.push(`(^|[^0-9.])${numeric}([^0-9.]|$)`);
  }
  if (patternParts.length > 0) {
    const paths = scan.include.map((p) => p.replace(/\/$/, ''));
    const out = run('git', ['grep', '-l', '-I', '-E', patternParts.join('|'), '--', ...paths]);
    for (const line of out.split('\n')) {
      const rel = line.trim();
      if (rel) candidates.add(rel.replace(/\\/g, '/'));
    }
  }

  // 未跟踪新文件 git grep 看不见，单独补（否则新增的影子副本能溜过守卫）。
  for (const rel of listUntrackedFiles()) {
    if (!inInclude(rel, scan.include)) continue;
    candidates.add(rel);
  }
  for (const rel of required) candidates.add(rel);

  // --changed 档：只判定改动文件（真源与镜像仍必读，否则无法取值）。
  const changed = changedMode ? new Set(listChangedFiles()) : null;

  const corpus = [];
  for (const rel of candidates) {
    if (!CORPUS_EXT.test(rel)) continue;
    if (!inInclude(rel, scan.include)) continue;
    if (changed && !required.has(rel) && !changed.has(rel)) continue;
    if (!required.has(rel) && inExclude(rel, scan.exclude)) continue;
    const text = readTextFile(rel);
    if (text === null) continue;
    corpus.push({ relPath: rel, text });
  }
  return corpus;
}

/**
 * 指纹语料：用于「整文件副本」判定。
 *
 * 只装两类：① 全部 .json（登记表副本是最可能的影子形态）；② 代码真源的 grep 候选
 * （逐字节复制代码真源的文件必然含它的特征行，先用 git grep 粗筛再比对指纹）。
 * 逐字节复制代码真源的文件在字段级扫描里也会被抓住（常量必然重复声明），
 * 故代码侧的指纹扫描是补漏，不是唯一防线。
 */
function buildFingerprintCorpus(registry) {
  const scan = scanConfig(registry);
  const set = new Set();

  for (const rel of listRepoFiles()) {
    if (rel.endsWith('.json')) set.add(rel);
  }

  for (const source of (registry.sources || [])) {
    if (!source || source.kind !== 'code' || !source.path) continue;
    const text = readTextFile(source.path);
    if (text === null) continue;
    const probes = pickProbes(text);
    if (probes.length === 0) continue;
    const args = ['grep', '-l', '-I', '-F'];
    for (const probe of probes) args.push('-e', probe);
    args.push('--', ...scan.include.map((p) => p.replace(/\/$/, '')));
    for (const line of run('git', args).split('\n')) {
      const rel = line.trim();
      if (rel) set.add(rel.replace(/\\/g, '/'));
    }
    set.add(source.path);
  }

  const corpus = [];
  for (const rel of set) {
    if (!inInclude(rel, scan.include)) continue;
    if (inExclude(rel, scan.exclude)) continue;
    const text = readTextFile(rel);
    if (text === null) continue;
    corpus.push({ relPath: rel, text });
  }
  return corpus;
}

/** 挑 3 行「有代表性」的内容作指纹探针：够长、非 import/require、非纯注释。 */
function pickProbes(text) {
  const lines = String(text).split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 40)
    .filter((l) => !/^(import|const .*require\(|use strict|\/\/|\/\*|\*)/.test(l));
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

function main() {
  const registry = loadRegistry();
  const corpus = buildFieldCorpus(registry);
  const fingerprintCorpus = buildFingerprintCorpus(registry);
  const { findings: assessed, stats } = guard.assess({
    registry,
    files: corpus,
    fingerprintFiles: fingerprintCorpus,
  });

  // 判据失效检查（作用域可达性）：纯函数 + 注入 exists，IO 留在这层。
  // 作用域不存在的事实永远 0 finding —— 看起来全绿，实则没在看。
  const scopeFindings = guard.validateScopes(registry, (rel) => {
    try {
      return fs.existsSync(path.join(REPO_ROOT, rel));
    } catch {
      return false;
    }
  });
  const findings = [...scopeFindings, ...assessed];

  const selected = listMode ? findings.filter((f) => f.id === listMode) : findings;
  const report = {
    rule: guard.RULE_ID,
    stage: STAGE,
    observer: OBSERVER_STAGES.has(STAGE),
    scope: changedMode ? 'changed' : 'full',
    stats,
    findings: selected,
  };
  if (listMode) {
    for (const f of selected) {
      process.stdout.write(`${f.file}${f.line ? ':' + f.line : ''}  ${f.id}  ${f.message}\n`);
    }
    process.exit(0);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const errors = selected.filter((f) => f.severity === 'error');
    const warns = selected.filter((f) => f.severity === 'warning');
    process.stdout.write(`数据单一真源守卫（LAYOUT-008 · S1 观察者 · 恒 exit 0）\n`);
    process.stdout.write('='.repeat(60) + '\n');
    process.stdout.write(
      `语料 ${stats.filesScanned} 文件 / 事实 ${stats.facts} 条 / 授权镜像 ${stats.mirrors} 个\n`,
    );
    process.stdout.write(
      `影子副本 ${stats.shadowCopies} · 值矛盾 ${stats.contradictions} · 镜像失步 ${stats.mirrorDrifts} · 整文件副本 ${stats.sourceShadowCopies} · 自相矛盾 ${stats.selfContradictions}\n`,
    );
    for (const f of selected) {
      const prefix = f.severity === 'error' ? '[ERROR]' : '[warn ]';
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      process.stdout.write(` ${prefix} ${f.id}  ${where}\n   ${f.message}\n`);
      if (f.detail) process.stdout.write(`   ${f.detail}\n`);
    }
    if (selected.length === 0) {
      process.stdout.write('\n未发现影子副本、值矛盾或镜像失步。\n');
    }
    process.stdout.write('\n判据真源：docs/10_规范/registry/DATA-SSOT.json（只登记「真源在哪」，不登记值）。\n');
    process.stdout.write('S1 观察者：只报告，不阻断。\n');
    void errors;
    void warns;
  }

  const hasError = selected.some((f) => f.severity === 'error');
  if (hasError && strictMode) process.exit(1);
  if (OBSERVER_STAGES.has(STAGE)) process.exit(0);
  process.exit(hasError ? 1 : 0);
}

main();
