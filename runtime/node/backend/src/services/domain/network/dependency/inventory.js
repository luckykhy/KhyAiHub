'use strict';

/**
 * dependency/inventory.js — 开发环境全量盘点（[DESIGN-ARCH-204]）。
 *
 * resolver.probe 只回答「单个依赖在不在」；本叶子在其上做「盘点/清单/编排」增量：
 *   1) DEV_ENV_CATALOG  用户点名语言 → depId 的映射与展示元数据（kind 三态）。
 *   2) scanInventory()  逐项 presence + 版本 + winget 可用性，聚合为盘点快照并
 *                       原子写（tmp+rename）到数据家 devEnv 落点。
 *   3) assertInstallable()  manual/informational 条目的**机制闸**（单点实现，
 *                       CLI / HTTP / import apply 三个安装入口共用）。
 *
 * 为什么这个闸必须落在 devenv 层而非 registry/installRunner：实测
 * buildInstallPlan('moonbit') 返回非空计划（manager:'script'），installRunner
 * 全文件无 script 分支、runInstall 只验 command 数组非空即执行——「永不自动执行
 * 官方脚本」在 registry.js 只是注释契约，代码零强制。把硬拒下沉到自愈链属行为
 * 变更（healingLoop 也消费该链），已登记 knownDefectsPinned 交人工单独裁决；
 * v1 的闸在此实现，绝不依赖 registry/installRunner 拒绝。
 *
 * 非开发工具链（puppeteer/torch/whisper/ghidra 等运行时依赖）不进本目录——
 * 它们归 khy deps 自愈语义（见 outOfScope）。
 */

const registry = require('./registry');
const resolver = require('./resolver');
const toolchainVersions = require('./toolchainVersions');
const versionProbe = require('./versionProbe');

/** kind 三态：installable 可安装 / manual 仅手动提示 / informational 无运行时。 */
const KIND = {
  INSTALLABLE: 'installable',
  MANUAL: 'manual',
  INFORMATIONAL: 'informational',
};

/**
 * 开发环境目录。language 是用户口径的名字（含中英文别名归一），depId 对齐
 * registry.js。html/css 无独立运行时：硬造安装目标是伪需求，以 informational
 * 如实呈现。kind:'manual' 当前仅 moonbit（未来任何 script 形态条目照此登记）。
 */
const DEV_ENV_CATALOG = [
  { depId: 'python3', language: 'python', label: 'Python 3', kind: KIND.INSTALLABLE, aliases: ['python', 'py'] },
  { depId: 'nodejs', language: 'javascript', label: 'JavaScript (Node.js)', kind: KIND.INSTALLABLE, aliases: ['javascript', 'js', 'node', 'nodejs'] },
  { depId: 'openjdk', language: 'java', label: 'Java / JDK', kind: KIND.INSTALLABLE, aliases: ['java', 'jdk', 'openjdk'] },
  { depId: 'gcc', language: 'c', label: 'C (GCC)', kind: KIND.INSTALLABLE, aliases: ['c', 'gcc'] },
  { depId: 'gpp', language: 'c++', label: 'C++ (G++)', kind: KIND.INSTALLABLE, aliases: ['c++', 'cpp', 'g++', 'gpp'] },
  { depId: 'dotnet', language: 'c#', label: 'C# (.NET SDK)', kind: KIND.INSTALLABLE, aliases: ['c#', 'csharp', 'dotnet', '.net'] },
  { depId: 'typescript', language: 'typescript', label: 'TypeScript (tsc)', kind: KIND.INSTALLABLE, aliases: ['typescript', 'ts'] },
  { depId: 'moonbit', language: 'moonbit', label: 'MoonBit 工具链', kind: KIND.MANUAL, aliases: ['moonbit', 'moon'] },
  { depId: 'wabt', language: 'wasm', label: 'WebAssembly (wabt)', kind: KIND.INSTALLABLE, aliases: ['wasm', 'webassembly', 'wabt'] },
  { depId: 'html', language: 'html', label: 'HTML', kind: KIND.INFORMATIONAL, aliases: ['html'], note: '无独立运行时，浏览器与编辑器直接消费，无需安装' },
  { depId: 'css', language: 'css', label: 'CSS', kind: KIND.INFORMATIONAL, aliases: ['css'], note: '无独立运行时，浏览器与编辑器直接消费，无需安装' },
  // 用户「……等」的合理邻域：registry 现成条目，盘点同屏展示不另做。
  { depId: 'make', language: 'make', label: 'GNU Make', kind: KIND.INSTALLABLE, aliases: ['make'] },
  { depId: 'cmake', language: 'cmake', label: 'CMake', kind: KIND.INSTALLABLE, aliases: ['cmake'] },
  { depId: 'nasm', language: 'nasm', label: 'NASM (x86 汇编)', kind: KIND.INSTALLABLE, aliases: ['nasm'] },
  { depId: 'clang', language: 'clang', label: 'Clang (LLVM)', kind: KIND.INSTALLABLE, aliases: ['clang', 'llvm'] },
  { depId: 'rust', language: 'rust', label: 'Rust 工具链', kind: KIND.INSTALLABLE, aliases: ['rust', 'rustc', 'cargo'] },
  { depId: 'go', language: 'go', label: 'Go 工具链', kind: KIND.INSTALLABLE, aliases: ['go', 'golang'] },
];

/** 语言名/别名/depId → 规范 depId；未命中返回 null。大小写不敏感。 */
function normalizeToDepId(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) {
    return null;
  }
  for (const entry of DEV_ENV_CATALOG) {
    if (entry.depId === n || entry.language === n || (entry.aliases || []).includes(n)) {
      return entry.depId;
    }
  }
  return null;
}

/** 盘点快照的机内缓存落点（T2-regenerable，重跑 scan 即可再生）。 */
function getSnapshotPath() {
  // 惰性 require：dataHome 解析有存储盘扫描副作用，保持本叶子按需加载。
  const { getProjectDataPath } = require('../../../../utils/dataHome');
  return getProjectDataPath('devEnv', 'scan-latest.json');
}

/** 原子写（tmp + rename，commandAutoRegistry._writeCache 同款）。失败 fail-soft。 */
function _writeJsonAtomic(filePath, obj) {
  const fs = require('fs');
  const path = require('path');
  try {
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/** 读取上次盘点快照；无文件/损坏一律返回 null（由调用方诚实提示「尚未盘点」）。 */
function loadLatestSnapshot() {
  const fs = require('fs');
  try {
    const raw = fs.readFileSync(getSnapshotPath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.entries)) {
      return obj;
    }
  } catch {
    /* missing/corrupt → no snapshot */
  }
  return null;
}

/** 默认探测环境（测试注入纯内存桩覆盖）。 */
function defaultDeps() {
  let searchExecutable = null;
  try {
    searchExecutable = require('../../../../tools/platformUtils').searchExecutable;
  } catch {
    searchExecutable = () => null;
  }
  return {
    probe: resolver.probe,
    probeVersion: versionProbe.probeVersion,
    searchExecutable,
  };
}

/** winget 可用性探测（兜底分支的判据；非 win32 恒 false）。 */
function _detectWinget(platform, searchExecutable) {
  if (platform !== 'win32') {
    return { present: false, detail: '非 Windows 平台，winget 不适用' };
  }
  const found = searchExecutable('winget');
  return found
    ? { present: true, detail: found }
    : { present: false, detail: 'winget 不在 PATH（Windows 10 早期版本可能未内置），安装将走官方下载器兜底或手动' };
}

/**
 * 全量盘点。对 DEV_ENV_CATALOG 逐项：presence（resolver.probe）→ 版本
 * （versionProbe）→ 可安装性预检（buildInstallPlan 非空）→ winget 可用性，
 * 聚合为盘点快照并原子写。永不抛（单项探测失败按「缺失/版本未知」如实聚合）。
 *
 * @param {object} [opts] { deps, platform, now, writeSnapshot }
 * @returns {Promise<object>} 快照 { scannedAt, platform, winget, entries }
 */
async function scanInventory(opts = {}) {
  const deps = opts.deps || defaultDeps();
  const platform = opts.platform || process.platform;
  const now = opts.now || new Date();
  const writeSnapshot = opts.writeSnapshot !== false;

  const winget = _detectWinget(platform, deps.searchExecutable);
  const entries = [];

  for (const item of DEV_ENV_CATALOG) {
    const def = registry.getDependency(item.depId) || {};
    const versionable = toolchainVersions.isVersionable(item.depId);
    const versions = versionable ? toolchainVersions.supportedVersions(item.depId) : [];

    if (item.kind === KIND.INFORMATIONAL) {
      entries.push({
        depId: item.depId,
        language: item.language,
        label: item.label,
        kind: item.kind,
        present: false,
        version: null,
        versionDetail: null,
        versionable: false,
        versions: [],
        docsUrl: def.docsUrl || null,
        installable: false,
        installHint: null,
        note: item.note || null,
      });
      continue;
    }

    let present = false;
    let presentDetail = null;
    try {
      const p = deps.probe(item.depId);
      present = !!p.present;
      presentDetail = p.detail || null;
    } catch {
      present = false;
    }

    let version = null;
    let versionDetail = null;
    if (present) {
      try {
        const v = await deps.probeVersion(item.depId);
        version = v.version || null;
        versionDetail = v.raw ? String(v.raw).slice(0, 120) : null;
      } catch {
        version = null;
      }
    }

    // 可安装性预检：本平台有 curated 安装命令才算可装（ghidra 类诚实降级的先例）。
    let installable = false;
    try {
      installable = !!(item.kind === KIND.INSTALLABLE && resolver.buildInstallPlan(item.depId));
    } catch {
      installable = false;
    }

    entries.push({
      depId: item.depId,
      language: item.language,
      label: item.label,
      kind: item.kind,
      present,
      version,
      versionDetail,
      versionable,
      versions,
      docsUrl: def.docsUrl || null,
      installable,
      // manual 条目带 installHint（registry curated 只读展示）：web/桌面「复制安装
      // 命令」按钮与导入预览同源，不再各自兜底拼装。
      installHint:
        item.kind === KIND.MANUAL ? assertInstallable(item.depId, { platform }).installHint || null : null,
      note: item.kind === KIND.MANUAL
        ? '手动安装项：khy 不自动执行官方安装脚本（DEV_ENV_MANUAL_ONLY）'
        : item.note || null,
      _presentDetail: presentDetail,
    });
  }

  const snapshot = {
    scannedAt: now.toISOString(),
    platform,
    winget,
    entries,
  };

  // 快照不是数据真源（真源是机器系统状态本身），写入失败不阻断盘点结果。
  // 落盘剥掉 _ 前缀内部字段（_presentDetail 只服务当次诊断，不入持久 schema）。
  if (writeSnapshot) {
    const stripInternal = (e) => Object.fromEntries(
      Object.entries(e).filter(([k]) => !k.startsWith('_'))
    );
    snapshot._snapshotWritten = _writeJsonAtomic(getSnapshotPath(), {
      scannedAt: snapshot.scannedAt,
      platform: snapshot.platform,
      winget: snapshot.winget,
      entries: snapshot.entries.map(stripInternal),
    });
  }

  return snapshot;
}

/** 汇总计数（CLI 尾行 / HTTP 完成态 progress 复用）。 */
function summarizeInventory(snapshot) {
  const counts = { total: 0, present: 0, missing: 0, manual: 0, informational: 0 };
  for (const e of (snapshot && snapshot.entries) || []) {
    counts.total += 1;
    if (e.kind === KIND.INFORMATIONAL) {
      counts.informational += 1;
    } else if (e.kind === KIND.MANUAL) {
      counts.manual += 1;
    } else if (e.present) {
      counts.present += 1;
    } else {
      counts.missing += 1;
    }
  }
  return counts;
}

/**
 * 单点安装闸：manual（含任何 registry manager:'script' 条目）与 informational
 * 条目在 buildInstallPlan **之前**拒绝。三个安装入口（CLI install / HTTP install
 * / import apply）共用，绝不依赖 registry/installRunner 拒绝（见头注释的实测）。
 *
 * @param {string} depId
 * @param {object} [opts] { platform }
 * @returns {{ ok:true, depId:string } | { ok:false, code:string, message:string, installHint?:(string|null), note?:(string|null) }}
 */
function assertInstallable(depId, opts = {}) {
  const platform = opts.platform || process.platform;
  const catalogEntry = DEV_ENV_CATALOG.find((e) => e.depId === depId);

  // informational 先于 registry 判定：html/css 无 registry 条目，先查目录
  // 才能给出「无需安装」而非「未知依赖」。
  if (catalogEntry && catalogEntry.kind === KIND.INFORMATIONAL) {
    return {
      ok: false,
      code: 'DEV_ENV_NOT_INSTALLABLE',
      message: `${depId} 无独立运行时，无需安装`,
      note: catalogEntry.note || null,
    };
  }

  const def = registry.getDependency(depId);
  if (!def) {
    return {
      ok: false,
      code: 'DEV_ENV_UNKNOWN_DEP',
      message: `未知依赖:${depId}`,
    };
  }

  const inst = def.install || {};
  const scriptShaped = inst.manager === 'script' || (catalogEntry && catalogEntry.kind === KIND.MANUAL);
  if (scriptShaped) {
    // installHint 只从 registry curated 数据**读取展示**，不构建执行计划。
    const argv = (inst.platform && inst.platform[platform]) || inst.command;
    return {
      ok: false,
      code: 'DEV_ENV_MANUAL_ONLY',
      message: `${depId} 为手动安装项：khy 不自动执行官方安装脚本（该限制由本命令强制，不依赖依赖表）`,
      installHint: Array.isArray(argv) ? argv.join(' ') : null,
    };
  }

  return { ok: true, depId };
}

module.exports = {
  KIND,
  DEV_ENV_CATALOG,
  normalizeToDepId,
  getSnapshotPath,
  loadLatestSnapshot,
  scanInventory,
  summarizeInventory,
  assertInstallable,
  defaultDeps,
  _internal: { _detectWinget, _writeJsonAtomic },
};
