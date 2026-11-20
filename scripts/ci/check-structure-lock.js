#!/usr/bin/env node
'use strict';

/**
 * check-structure-lock.js — 目录结构锁（PROCESS-008 新机制，S1 起步）
 *
 * ## 治什么
 *
 * 顶层目录与编号轴是「一次授权、长期生效」的结构事实：新增一个根目录、新开一个
 * docs 编号轴、多一个数据档位，都会改变每台机器上每个人对仓库的心智地图，而此前
 * **没有任何守卫看这件事**——check:layout 管层级名册与依赖方向，check-litter 管
 * 垃圾名形态，都不回答「这个条目是谁批准进来的」。
 *
 * ## 判据（单一真源 = 清单快照 diff）
 *
 * 基线是 `docs/10_规范/registry/STRUCTURE-LOCK.json`：root 的 dirs/files、docs 的
 * 编号轴、works/data/khy 的 T0–T4 档位。当前工作区与快照逐项比对：
 *   · 快照里没有、工作区出现了           → finding（kind: structure-drift，direction: added）
 *   · 快照里有、工作区消失了             → finding（kind: structure-drift，direction: removed）
 * 授权通道留给人：改 STRUCTURE-LOCK.json 并 version+1，提交信息加
 * `structure-lock-approved-by: <批准人>`。
 *
 * ## 豁免（三条，与接线任务书一致）
 *
 * 1. 生成物目录：basename 为 build/dist/node_modules，或落在 BUILD-OUTPUTS.json
 *    登记的 entries/ 产物路径之下（entries/ 同时承载跟踪的真源文件与各端产物，
 *    产物部分由那张表定义，不在本锁管辖内）；
 * 2. .git；
 * 3. 根级点目录（.zcode/.cursor/.claude…）按 .gitignore 判为机器本地的——工具家
 *    的落点是工具自己建的目录，本机态不入库，不算结构漂移。判据用
 *    `git check-ignore --no-index`（纯形态匹配，不受 index 里残留跟踪文件影响，
 *    否则 .zcode 这类「有跟踪文件但整目录被忽略」的家会被漏豁免）。
 *
 * ## 阶段铁律
 *
 * `GUARD_STAGE='S1'` ⇒ 恒 exit 0、只记录不阻断（PROCESS-008 PP-3）。
 * check-rollout-stage.js 会拿这个常量与 FEATURE-OWNERSHIP.json 的登记比对，
 * 漂移即报 rollout-stage-authority-drift。升阶是人的决定：样本攒到 ≥200 条且
 * 无解释不了的样本之后，改这一个常量 + 登记表条目，不改判定逻辑。
 *
 * ## 用法
 *
 *   node scripts/ci/check-structure-lock.js                   # 全量比对
 *   node scripts/ci/check-structure-lock.js --changed         # 只报落在暂存区改动面内的 drift（pre-commit 快档）
 *   node scripts/ci/check-structure-lock.js --json            # 机器可读
 *   node scripts/ci/check-structure-lock.js --write-snapshot  # 授权后重基线；--bump 同时 version+1 并刷新 lockedAt
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── 阶段常量：唯一权威（FEATURE-OWNERSHIP.json 的 rollout 段只是镜像）──────────
const GUARD_STAGE = 'S1';

const ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_REL = 'docs/10_规范/registry/STRUCTURE-LOCK.json';
const BUILD_OUTPUTS_REL = 'docs/10_规范/registry/BUILD-OUTPUTS.json';

/** 生成物目录名（按 basename 判，任意层级命中即豁免）。 */
const GENERATED_NAMES = new Set(['dist', 'build', 'node_modules']);

/** 末尾自报一行计数，供 pre-commit 钩子分支（不靠退出码——S1 恒 0）。 */
const MARKER = 'structure-lock-drift-count';

const args = process.argv.slice(2);
const changedMode = args.includes('--changed');
const jsonMode = args.includes('--json');
const writeMode = args.includes('--write-snapshot');
const bumpMode = args.includes('--bump');

// ── 工具函数 ────────────────────────────────────────────────────────────────

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function readJson(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: `文件不存在：${rel}` };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: `JSON 解析失败：${rel}（${e.message}）` };
  }
}

/** BUILD-OUTPUTS.json 登记的 entries/ 产物路径（豁免判据 1 的后半句）。 */
function entriesBuildOutputPaths() {
  const got = readJson(BUILD_OUTPUTS_REL);
  if (!got.ok) return [];
  const outputs = Array.isArray(got.data && got.data.outputs) ? got.data.outputs : [];
  const out = [];
  for (const o of outputs) {
    const p = o && typeof o.path === 'string' ? toPosix(o.path).replace(/^\/+|\/+$/g, '') : '';
    if (p.startsWith('entries/')) out.push(p);
  }
  return out;
}

/**
 * 一批路径的 .gitignore 形态判定（`--no-index`：只看模式匹配，不问 index）。
 * git 不在 / 不是 git 检出时返回空集合 —— 判据退化为「未忽略」，不静默放行也不假装命中。
 */
function gitIgnoredSet(rels) {
  if (!rels.length) return new Set();
  try {
    const stdout = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', ...rels], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const set = new Set();
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = line.match(/\t(.+)$/);
      if (m) set.add(toPosix(m[1]));
    }
    return set;
  } catch {
    // exit 1 = 一个都没忽略（正常路径）；其它错误（无 git/非检出）同样按「未忽略」走。
    return new Set();
  }
}

/**
 * 豁免判定。relPath 为仓内相对 posix 路径（root 级就是条目名本身）。
 */
function isExempt(relPath, entriesOutputs) {
  const rel = toPosix(relPath);
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (GENERATED_NAMES.has(base)) return true;
  for (const p of entriesOutputs) {
    if (rel === p || rel.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** 根级点目录 + 被 .gitignore 覆盖 ⇒ 机器本地工具家，不参与判定。 */
function isLocalToolHome(relPath, ignoredRootDots) {
  const rel = toPosix(relPath);
  if (rel.includes('/')) return false;
  return rel.startsWith('.') && ignoredRootDots.has(rel);
}

// ── 快照生成（--write-snapshot）─────────────────────────────────────────────

function snapshotTierSpecs() {
  return {
    'works/data/khy': {
      path: 'works/data/khy',
      label: '数据家 T0–T4 档位',
      match: '^T[0-9]+-',
    },
    docs: {
      path: 'docs',
      label: 'docs 编号轴',
      match: '^[0-9]{2}_',
    },
  };
}

function listRoot() {
  const dirs = [];
  const files = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  return { dirs: dirs.sort(), files: files.sort() };
}

function listTierDirs(absDir, nameRe) {
  return fs.readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && nameRe.test(e.name))
    .map((e) => e.name)
    .sort();
}

function writeSnapshot() {
  const prev = readJson(SNAPSHOT_REL);
  const prevData = prev.ok ? prev.data : null;
  const version = bumpMode ? Number(prevData && prevData.version) + 1 : (prevData && prevData.version) || 1;
  const lockedAt = bumpMode || !prevData ? new Date().toISOString() : String(prevData.lockedAt || '');

  const root = listRoot();
  const tiers = {};
  for (const [key, spec] of Object.entries(snapshotTierSpecs())) {
    const abs = path.join(ROOT, spec.path);
    tiers[key] = {
      path: spec.path,
      label: spec.label,
      match: spec.match,
      dirs: fs.existsSync(abs) ? listTierDirs(abs, new RegExp(spec.match)) : [],
    };
  }

  const snapshot = {
    version,
    lockedAt,
    generatedBy: 'scripts/ci/check-structure-lock.js --write-snapshot',
    notes: '授权基线：STRUCTURE-LOCK.json 登记「谁批准了哪些结构条目」。判据 = 当前工作区与本快照的 diff——快照外新增/快照内消失即 finding（kind: structure-drift）。授权变更须改本文件并 version+1，提交信息加 structure-lock-approved-by: <批准人>。豁免：.git；生成物目录（build/dist/node_modules 与 BUILD-OUTPUTS.json 登记的 entries/ 产物路径）；根级点目录中按 .gitignore 判为机器本地的工具家。tiers 的 match 限定该节只管辖同名形态的条目（编号轴 / T 档位），其余子目录由各自真源管。',
    root,
    tiers,
  };

  const abs = path.join(ROOT, SNAPSHOT_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const counts = Object.entries(tiers)
    .map(([k, v]) => `${k} ${v.dirs.length}`)
    .join(' · ');
  process.stdout.write(
    `[structure-lock] snapshot written: ${SNAPSHOT_REL} version=${version} · ` +
    `root dirs=${root.dirs.length} files=${root.files.length} · ${counts}\n`
  );
  return 0;
}

// ── 比对 ───────────────────────────────────────────────────────────────────

function collectFindings(entriesOutputs) {
  const findings = [];
  const skipped = [];
  const got = readJson(SNAPSHOT_REL);
  if (!got.ok) {
    return { findings, skipped, fatal: got.reason };
  }
  const snap = got.data;
  if (!snap || typeof snap !== 'object' || !snap.root) {
    return { findings, skipped, fatal: '快照缺少 root 段' };
  }

  // 根级点目录的 gitignore 形态判定（一次批量调用，省 N 次 spawn）
  const rootLive = listRoot();
  const ignoredRootDots = gitIgnoredSet(
    [...rootLive.dirs, ...rootLive.files].filter((n) => n.startsWith('.'))
  );

  const exempt = (rel) => isExempt(rel, entriesOutputs) || isLocalToolHome(rel, ignoredRootDots);

  const diffSection = (section, label, registered, live) => {
    const reg = new Set(registered.map(toPosix));
    const liv = new Set(live.map(toPosix));
    for (const name of liv) {
      if (reg.has(name)) continue;
      const rel = section === 'root' ? name : `${section}/${name}`;
      if (exempt(rel)) continue;
      findings.push({
        kind: 'structure-drift',
        direction: 'added',
        section,
        path: rel,
        message: `${label}出现快照外条目：${rel}（未授权的结构变更）`,
      });
    }
    for (const name of reg) {
      if (liv.has(name)) continue;
      const rel = section === 'root' ? name : `${section}/${name}`;
      if (exempt(rel)) continue;
      findings.push({
        kind: 'structure-drift',
        direction: 'removed',
        section,
        path: rel,
        message: `${label}已登记条目消失：${rel}（未授权的结构变更）`,
      });
    }
  };

  diffSection('root', '根目录', snap.root.dirs || [], rootLive.dirs);
  diffSection('root', '根目录', snap.root.files || [], rootLive.files);

  const tiers = snap.tiers && typeof snap.tiers === 'object' ? snap.tiers : {};
  for (const [key, spec] of Object.entries(tiers)) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.dirs)) {
      skipped.push({ section: key, reason: '快照 tiers 段形状不合法（缺 dirs 数组）' });
      continue;
    }
    const sectionPath = toPosix(spec.path || key);
    const abs = path.join(ROOT, sectionPath);
    if (!fs.existsSync(abs)) {
      // 父目录整体不存在（典型：未 provision 的机器本机数据家）≠ 漂移，不报 finding。
      skipped.push({ section: key, reason: `${sectionPath} 不存在（机器本机态，未 provision 时整体跳过）` });
      continue;
    }
    let nameRe = null;
    try {
      nameRe = new RegExp(String(spec.match || ''));
    } catch (e) {
      skipped.push({ section: key, reason: `match 不是合法正则：${spec.match}（${e.message}）` });
      continue;
    }
    diffSection(sectionPath, spec.label || sectionPath, spec.dirs, listTierDirs(abs, nameRe));
  }

  return { findings, skipped, fatal: null };
}

/** git 改动面（暂存区）。pre-commit 快档只报落在其中的 drift。 */
function stagedSurface() {
  try {
    const stdout = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return new Set(String(stdout).split('\0').filter(Boolean).map(toPosix));
  } catch {
    return null;
  }
}

/** finding 路径与改动面是否相交（相等 / 目录前后代关系任一方向）。 */
function touchesSurface(findingPath, surface) {
  for (const changed of surface) {
    if (changed === findingPath) return true;
    if (changed.startsWith(`${findingPath}/`)) return true;
    if (findingPath.startsWith(`${changed}/`)) return true;
  }
  return false;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  if (writeMode) return writeSnapshot();

  const entriesOutputs = entriesBuildOutputPaths();
  const { findings, skipped, fatal } = collectFindings(entriesOutputs);

  if (fatal) {
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ stage: GUARD_STAGE, fatal, findings: [], count: 0 }, null, 2)}\n`);
    } else {
      process.stdout.write(`[structure-lock][ERROR] 基线不可用：${fatal}\n`);
      process.stdout.write('[structure-lock][ERROR] 没有快照就没有判据 —— 请用 --write-snapshot 重建基线（授权变更走 version+1）。\n');
      process.stdout.write(`[structure-lock] ${MARKER}=-1（基线缺失，未做比对）\n`);
    }
    return 0; // S1 铁律：恒 exit 0
  }

  let reported = findings;
  let surfaceSize = null;
  if (changedMode) {
    const surface = stagedSurface();
    if (surface === null) {
      // 读不到改动面（非 git 检出 / git 不可用）时退回全量比对并明说，不静默少报。
      if (!jsonMode) {
        process.stdout.write('[structure-lock][WARN] --changed 读不到暂存区改动面，本次退回全量比对。\n');
      }
    } else {
      surfaceSize = surface.size;
      reported = findings.filter((f) => touchesSurface(f.path, surface));
    }
  }

  const snap = readJson(SNAPSHOT_REL);
  const snapMeta = snap.ok
    ? `version=${snap.data.version} lockedAt=${snap.data.lockedAt}`
    : '(不可用)';

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      stage: GUARD_STAGE,
      mode: changedMode ? 'changed' : 'full',
      snapshot: { path: SNAPSHOT_REL, version: snap.ok ? snap.data.version : null },
      changeSurface: surfaceSize,
      skipped,
      findings: reported,
      count: reported.length,
    }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`[structure-lock] S1 观察者档（恒 exit 0，不阻断）· 基线 ${SNAPSHOT_REL}（${snapMeta}）\n`);
  process.stdout.write(`[structure-lock] 判据 = 清单快照 diff（kind: structure-drift）· 豁免：.git / 生成物目录 / 机器本地工具家\n`);
  if (changedMode) {
    process.stdout.write(`[structure-lock] --changed：只报告落在暂存区改动面（${surfaceSize === null ? '不可用→全量' : `${surfaceSize} 个路径`}）内的 drift\n`);
  }
  for (const s of skipped) {
    process.stdout.write(`[structure-lock] skip：${s.section} — ${s.reason}\n`);
  }

  if (!reported.length) {
    process.stdout.write(`[structure-lock] OK：0 drift\n`);
  } else {
    process.stdout.write(`[structure-lock] DRIFT：${reported.length} 处未授权结构变更\n`);
    for (const f of reported) {
      process.stdout.write(`  [structure-drift] ${f.direction === 'added' ? '新增未登记' : '已登记消失'} ${f.path} — ${f.message}\n`);
    }
    process.stdout.write('[structure-lock] 未授权的结构变更。确认后请更新 docs/10_规范/registry/STRUCTURE-LOCK.json（version+1）并在提交信息加 structure-lock-approved-by: <批准人>\n');
  }
  process.stdout.write(`[structure-lock] ${MARKER}=${reported.length}\n`);
  return 0; // S1 铁律：恒 exit 0
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  GUARD_STAGE,
  SNAPSHOT_REL,
  BUILD_OUTPUTS_REL,
  GENERATED_NAMES,
  MARKER,
  entriesBuildOutputPaths,
  gitIgnoredSet,
  isExempt,
  isLocalToolHome,
  listRoot,
  listTierDirs,
  collectFindings,
  stagedSurface,
  touchesSurface,
  writeSnapshot,
};
