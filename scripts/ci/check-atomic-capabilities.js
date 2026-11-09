#!/usr/bin/env node
/**
 * check-atomic-capabilities.js — 原子能力聚合守卫。
 *
 * ## 它守什么
 *
 * khy-os 的原子能力今天散在 6 个暴露面（后端工具注册表 / PC 侧手机桥目录 /
 * Android 原生 / 手机 Dart / amoon bridge 契约 / amoo 桥策略），共 336 个工具名。
 * 它们之间**没有任何一处说明关系**，于是二级能力、三级能力想复用某个原子能力时，
 * 只能自己再实现一遍——项目就是这样变大的。
 *
 * 本守卫把「原子能力」变成**可机检的约束**：
 *
 *   1. **注册表必须存在且是最新的** —— 由 `gen-atomic-capabilities.js` 从代码实测生成，
 *      漂移即红（有人加了工具却没归组，或归组改了却没重新生成）。
 *   2. **每个原子能力必须有唯一 canonical** —— canonical 路径必须在磁盘上存在；
 *      同一 canonical 不得被两个能力同时声明为「唯一实现真源」。
 *   3. **每个暴露面工具名必须已归组** —— 新增工具未归组即红（这正是
 *      「重复造轮子」的第一道闸：新工具必须先说清它复用哪个原子能力）。
 *   4. **一个工具名不得同时属于两个原子能力** —— 归组交叉即红。
 *   5. **存量重复只警告不拦截** —— 按本轮裁决「只登记不改动」，
 *      `status: duplicate-logged` 的能力只提醒，不阻断（它们在
 *      `DUPLICATE_GROUPS` 里显式登记，附收敛理由）。
 *
 * ## 用法
 *
 *   node scripts/ci/check-atomic-capabilities.js
 *   node scripts/ci/check-atomic-capabilities.js --changed
 *   node scripts/ci/check-atomic-capabilities.js --strict-warnings
 *
 * `--changed`：只有当改动涉及工具定义面或注册表本身时才跑全套审计，
 * 否则退出 0（不相关改动不该被本守卫拦）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { buildRegistryDocument } = require('../lib/atomicCapabilityRegistry');
const { extractAllSurfaces, SURFACE_DEFS } = require('../lib/atomicCapabilitySurfaces');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_REL = 'docs/10_规范/registry/ATOMIC-CAPABILITIES.json';

const findings = [];
const add = (severity, id, file, line, message) =>
  findings.push({ severity, id, file, line, message });

const args = process.argv.slice(2);
const onlyChanged = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');

/**
 * 列出改动文件（含未跟踪）。与仓库既有守卫同口径。
 * @returns {string[]|null}
 */
function listChangedFiles() {
  const git = 'git -c core.quotePath=false';
  const run = (cmd) => {
    try {
      return require('child_process').execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const split = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`${git} diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return split(out);
  }
  // 暂存 / 未暂存 / 未跟踪是**并集**，不是短路三选一。
  //
  // 原来「暂存非空就只返回暂存」：工作区里既有暂存内容、又有 src/tools/ 下的改动时，
  // 守卫只看见暂存的那几个文件 → 「本次改动未触及工具定义面」→ 整个审计被跳过，
  // 守卫自述的头条能力（新增工具未归组即红）在 --changed 下形同虚设。
  const files = new Set();
  for (const cmd of [
    `${git} diff --name-only --cached --diff-filter=ACMR`,
    `${git} diff --name-only --diff-filter=ACMR HEAD`,
    `${git} ls-files --others --exclude-standard`,
  ]) {
    for (const f of split(run(cmd))) files.add(f);
  }
  return files.size ? [...files] : null;
}

/**
 * 本次改动是否触及「工具定义面」或注册表本身。
 * @param {string[]} changed
 * @returns {boolean}
 */
function touchesCapabilitySurfaces(changed) {
  const relevant = new Set([REGISTRY_REL]);
  for (const def of SURFACE_DEFS) relevant.add(def.entry);
  // 工具目录整体（新增/删除工具文件）
  for (const file of changed) {
    if (relevant.has(file)) return true;
    if (file.startsWith('runtime/node/backend/src/tools/')) return true;
    if (file.startsWith('scripts/lib/atomicCapability')) return true;
    if (file.startsWith('scripts/lib/resolveCanonical')) return true;
  }
  return false;
}

function lineOf(text, needle) {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : text.slice(0, i).split('\n').length;
}

// ── --changed 短路 ────────────────────────────────────────────────────────
if (onlyChanged) {
  const changed = listChangedFiles();
  if (changed && !touchesCapabilitySurfaces(changed)) {
    console.log('check-atomic-capabilities: 改动未触及工具定义面或注册表，跳过。');
    process.exit(0);
  }
}

// ── 1. 注册表存在且最新 ───────────────────────────────────────────────────
const registryAbs = path.join(REPO_ROOT, REGISTRY_REL);
if (!fs.existsSync(registryAbs)) {
  add('error', 'atomic-registry-missing', REGISTRY_REL, 1,
    '原子能力注册表不存在。请运行：node scripts/ci/gen-atomic-capabilities.js');
} else {
  const onDisk = fs.readFileSync(registryAbs, 'utf8');
  const fresh = `${JSON.stringify(buildRegistryDocument(), null, 2)}\n`;
  if (onDisk !== fresh) {
    add('error', 'atomic-registry-stale', REGISTRY_REL, 1,
      '原子能力注册表与当前代码不一致（新增/移除工具，或能力分组变动）。'
      + '请运行：node scripts/ci/gen-atomic-capabilities.js 重新生成。');
  }
}

// ── 2~5. 基于实测暴露面做审计 ────────────────────────────────────────────
const { surfaces } = extractAllSurfaces();
const capabilities = buildRegistryDocument().capabilities;

// 2a. canonical 必须存在
for (const cap of capabilities) {
  if (!cap.canonical) {
    add('error', 'atomic-no-canonical', REGISTRY_REL, lineOf(JSON.stringify(capabilities), cap.id),
      `原子能力 ${cap.id} 没有解析出 canonical：该能力没有唯一实现真源。`);
    continue;
  }
  if (!fs.existsSync(path.join(REPO_ROOT, cap.canonical))) {
    add('error', 'atomic-canonical-missing', REGISTRY_REL, lineOf(JSON.stringify(capabilities), cap.id),
      `原子能力 ${cap.id} 的 canonical ${cap.canonical} 在磁盘上不存在：登记指向死路径。`);
  }
}

// 2b. 同一 canonical 不得被两个能力同时声明
//     注意：一个文件承载多个动作是**正常**的（如 Tools.java 承载全部手机原子动作），
//     所以这条只对「同一 canonical 但两能力语义相近」的情况提示，不做硬拦截。
const canonicalOwners = new Map();
for (const cap of capabilities) {
  if (!cap.canonical) continue;
  if (!canonicalOwners.has(cap.canonical)) canonicalOwners.set(cap.canonical, []);
  canonicalOwners.get(cap.canonical).push(cap.id);
}
for (const [canonical, owners] of canonicalOwners) {
  if (owners.length > 1) {
    // 同一 canonical 下若两个能力的前缀段不同（如 fs.* / device.*），说明它们是
    // 「同一文件里的不同动作」——正常。只在同一前缀段内重复才是可疑的。
    const prefixes = new Set(owners.map((id) => id.split('.')[0]));
    if (prefixes.size === 1) {
      add('warn', 'atomic-canonical-shared-same-family', REGISTRY_REL,
        lineOf(JSON.stringify(capabilities), owners[0]),
        `canonical ${canonical} 被同族原子能力 ${owners.join('、')} 共用：`
        + '同族能力指向同一文件通常意味着它们其实是同一个能力被拆成了多条登记，'
        + '请确认是否应合并为一条。');
    }
  }
}

// 3. 每个暴露面工具名必须已归组
const registeredBySurface = new Map();
for (const cap of capabilities) {
  for (const [surface, names] of Object.entries(cap.surfaces || {})) {
    if (!registeredBySurface.has(surface)) registeredBySurface.set(surface, new Map());
    const bucket = registeredBySurface.get(surface);
    for (const name of names) {
      if (!bucket.has(name)) bucket.set(name, []);
      bucket.get(name).push(cap.id);
    }
  }
}

for (const surface of surfaces) {
  if (!surface.available) {
    add('warn', 'atomic-surface-unavailable', surface.entry, 1,
      `暴露面 ${surface.id}（${surface.label}）当前不可读：${surface.reason}。`
      + '该面的工具名本轮无法核对。');
    continue;
  }
  const bucket = registeredBySurface.get(surface.id) || new Map();
  const orphans = surface.names.filter((name) => !bucket.has(name));
  if (orphans.length) {
    add('error', 'atomic-orphan-exposure', REGISTRY_REL, 1,
      `暴露面 ${surface.id}（${surface.label}）有 ${orphans.length} 个工具名未归入任何原子能力：`
      + `${orphans.join('、')}。请在 scripts/lib/atomicCapabilityRegistry.js 的 ATOMIC_GROUPS 中`
      + '把它们归入已有原子能力，或新建一个原子能力并登记 canonical。');
  }
}

// 4. 一个工具名不得同时属于两个原子能力
for (const cap of capabilities) {
  for (const [surface, names] of Object.entries(cap.surfaces || {})) {
    for (const name of names) {
      const owners = (registeredBySurface.get(surface) || new Map()).get(name) || [];
      if (owners.length > 1) {
        add('error', 'atomic-name-cross-registered', REGISTRY_REL,
          lineOf(JSON.stringify(capabilities), cap.id),
          `工具名 ${name}（${surface} 面）同时归入 ${owners.length} 个原子能力：${owners.join('、')}。`
          + '一个暴露名只能属于一个原子能力——否则「复用」无从判断。');
      }
    }
  }
}

// 5. 接口分歧：同一原子能力在不同面的参数契约不一致
//    这是「不能直接照抄某一面的参数」的信号——二级能力复用时会踩的坑。
//    已登记的分歧只警告（`divergenceStatus: divergence-logged`），
//    未登记的新分歧即红——防止又长出一个行为不一致的接入点。
for (const cap of capabilities) {
  const iface = cap.interface || {};
  const severe = iface.severeDivergent || [];
  if (!severe.length) continue;
  const isLogged = cap.divergenceStatus === 'divergence-logged';
  const detail = severe.map((name) => {
    const info = (iface.divergenceDetail || {})[name] || {};
    const kind = info.kind === 'incompatible' ? '类型不兼容' : '必填性不一致';
    return `${name}（${kind}：${(info.types || []).join(' / ')}；`
      + `必填于 ${(info.requiredIn || []).length} 处、可选于 ${(info.optionalIn || []).length} 处）`;
  }).join('、');
  add(isLogged ? 'warn' : 'error', 'atomic-interface-divergent', REGISTRY_REL,
    lineOf(JSON.stringify(capabilities), cap.id),
    `原子能力 ${cap.id} 的接口在不同暴露面存在分歧：${detail}。`
    + (isLogged
      ? '该分歧已登记（见 DIVERGENT_GROUPS），本轮只警告不拦截；'
      + '统一各面必填性后从 DIVERGENT_GROUPS 移除即可消除。'
      : '请统一该能力各暴露面的参数契约，或在 DIVERGENT_GROUPS 中显式登记'
      + '并写明为何允许不一致。'));
}

// 6. 存量重复：只警告
for (const cap of capabilities) {
  if (cap.status !== 'duplicate-logged') continue;
  const multi = Object.entries(cap.surfaces || {})
    .filter(([, names]) => names.length > 1);
  add('warn', 'atomic-known-duplicate', REGISTRY_REL, lineOf(JSON.stringify(capabilities), cap.id),
    `原子能力 ${cap.id} 存在已登记的存量重复${multi.length ? `（${multi.map(([s, n]) => `${s}:${n.join('/')}`).join('，')}）` : ''}：`
    + `${cap.note.replace('【存量重复】', '')}。按「只登记不改动」本轮不拦截；`
    + '收敛时把 status 改为 active 并更新 note。');
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
findings.sort((a, b) => a.severity.localeCompare(b.severity) || a.id.localeCompare(b.id));
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

const totalExposed = surfaces.reduce((sum, s) => sum + (s.available ? s.names.length : 0), 0);
console.log('check-atomic-capabilities: 原子能力聚合守卫');
console.log(`暴露面 ${surfaces.length} 个 · 暴露名 ${totalExposed} 个 · 原子能力 ${capabilities.length} 个`);
console.log(`注册表 ${REGISTRY_REL}`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);

if (errors.length) {
  process.exitCode = 1;
} else if (warns.length && strictWarnings) {
  process.exitCode = 1;
}
