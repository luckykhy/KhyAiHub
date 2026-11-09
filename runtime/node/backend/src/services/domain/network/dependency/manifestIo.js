'use strict';

/**
 * dependency/manifestIo.js — 开发环境随身清单的导出/导入（[DESIGN-ARCH-204]）。
 *
 * 清单是「旧机有什么 → 新机装什么」的搬运载体。两条硬安全规则（永不放宽）：
 *
 * (a) 导入文件是**不可信输入**——只读每个条目的 depId 与 version 两个 token：
 *     depId 必须命中 registry（未知即拒并回可选列表），version 必须过
 *     toolchainVersions 白名单（不在表内退回默认版本并在预览里如实标注）。
 *     文件里的任何命令/路径/URL 字符串**绝不**进入执行——安装 argv 的唯一来源
 *     是 registry/toolchainVersions curated 表（registry.js 红线在导入面同样成立）。
 * (b) manual 条目硬短路——kind manual（当前=moonbit；未来任何 manager:'script'
 *     条目）在 applyImport 内同样过 assertInstallable 闸，置 skipped
 *     (DEV_ENV_MANUAL_ONLY)，绝不执行脚本（实测既有链不会拒，见 inventory.js 头注释）。
 *
 * 清单文件本身不入数据家：导出由调用方写 stdout/用户显式路径/浏览器下载，
 * 导入由用户给路径。服务端不接收任何导出落盘路径（杜绝路径注入）。
 */

const registry = require('./registry');
const resolver = require('./resolver');
const toolchainVersions = require('./toolchainVersions');
const inventory = require('./inventory');

const MANIFEST_KIND = 'khy-dev-env-manifest';
const SCHEMA_VERSION = 1;
const KNOWN_STATES = new Set(['present', 'missing', 'manual', 'informational']);

/** 带 code 的失败（routes 层映射 HTTP 状态码；CLI 层直接展示 message）。 */
function _fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 后端包版本（G1 真源之一），读不到如实返回 null。 */
function _khyVersion() {
  try {
    // 本文件在 src/services/domain/network/dependency/ 下，上溯 5 层到 backend 根。
    return require('../../../../../package.json').version || null;
  } catch {
    return null;
  }
}

/**
 * 由盘点快照构建随身清单。entries 覆盖整个 DEV_ENV_CATALOG（含 manual/
 * informational，导入端据此展示/跳过）。
 * @param {object} snapshot  scanInventory 的快照；null → DEV_ENV_NO_INVENTORY
 * @param {object} [opts] { now }
 */
function buildManifest(snapshot, opts = {}) {
  if (!snapshot || !Array.isArray(snapshot.entries)) {
    throw _fail('DEV_ENV_NO_INVENTORY', '尚未盘点：请先运行扫描');
  }
  const now = opts.now || new Date();
  const entries = snapshot.entries.map((e) => {
    let state;
    if (e.kind === 'informational') {
      state = 'informational';
    } else if (e.kind === 'manual') {
      state = 'manual';
    } else {
      state = e.present ? 'present' : 'missing';
    }
    return {
      depId: e.depId,
      language: e.language || null,
      state,
      version: state === 'present' ? e.version || null : null,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    exportedAt: now.toISOString(),
    platform: snapshot.platform || null,
    khyVersion: _khyVersion(),
    entries,
  };
}

/** 从最近快照构建清单（导出便捷入口；无快照 → DEV_ENV_NO_INVENTORY）。 */
function buildManifestFromLatest(opts = {}) {
  return buildManifest(inventory.loadLatestSnapshot(), opts);
}

/**
 * 校验并归一清单（不可信输入的唯一入口）。结构不对 → DEV_ENV_MANIFEST_INVALID。
 * 未知 state 按 'missing' 处理（fail-safe：绝不因此安装任何东西）。
 */
function _normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw _fail('DEV_ENV_MANIFEST_INVALID', '清单格式不正确：应为 khy-dev-env-manifest JSON 对象');
  }
  if (manifest.kind !== MANIFEST_KIND || manifest.schemaVersion !== SCHEMA_VERSION) {
    throw _fail(
      'DEV_ENV_MANIFEST_INVALID',
      `清单不被识别：kind 必须为 ${MANIFEST_KIND}、schemaVersion 必须为 ${SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw _fail('DEV_ENV_MANIFEST_INVALID', '清单格式不正确：entries 应为数组');
  }
  // 已知 depId = registry ∪ 盘点目录（html/css 是纯目录项，无 registry 条目，
  // 但 buildManifest 会把它们以 state:'informational' 导出——导入端必须认回）。
  const registered = new Set(registry.listDependencyIds());
  for (const e of inventory.DEV_ENV_CATALOG) {
    registered.add(e.depId);
  }
  const entries = [];
  const unknown = [];
  for (const raw of manifest.entries) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    // 只取 depId 与 version 两个 token；其余字段（含任何命令/路径/URL）一律丢弃。
    const depId = String(raw.depId || '').trim().toLowerCase();
    if (!depId || !registered.has(depId)) {
      if (depId && !unknown.includes(depId)) {
        unknown.push(depId);
      }
      continue;
    }
    const state = KNOWN_STATES.has(raw.state) ? raw.state : 'missing';
    // version 只在白名单校验通过后才参与安装计划；这里先原样保留字符串，
    // 白名单判定在 _resolveInstallVersion（唯一裁决点）。
    const version = raw.version == null ? null : String(raw.version).trim() || null;
    entries.push({ depId, state, version });
  }
  return { entries, unknown };
}

/**
 * 版本请求 → 实际采用版本的唯一裁决点。返回 { version, note }：
 *   - 版本可选工具链：白名单内用之；不在表内退默认并如实标注。
 *   - 非版本可选：忽略 version 走默认安装。
 */
function _resolveInstallVersion(depId, requested) {
  if (toolchainVersions.isVersionable(depId)) {
    const whitelist = toolchainVersions.supportedVersions(depId);
    const fallback = toolchainVersions.defaultVersion(depId);
    if (requested && whitelist.includes(requested)) {
      return { version: requested, note: null };
    }
    if (requested) {
      return {
        version: fallback,
        note: `请求版本 ${requested} 无预置映射，改用默认 ${fallback || '（随发行版）'}`,
      };
    }
    return fallback
      ? { version: fallback, note: `清单版本 null→默认 ${fallback}` }
      : { version: null, note: null };
  }
  if (requested) {
    return {
      version: null,
      note: `请求版本 ${requested}：该工具链不按版本安装，走默认`,
    };
  }
  return { version: null, note: null };
}

/**
 * 导入预览：将安装 / 跳过 / 手动 / 拒绝 四段。永不执行安装。
 *
 * @param {object} manifest  解析后的清单 JSON
 * @param {object} [opts] { probe, probeVersion, env, platform }
 * @returns {Promise<object>} { toInstall, skipped, manual, unknown }
 */
async function previewImport(manifest, opts = {}) {
  const { entries, unknown } = _normalizeManifest(manifest);
  const probe = opts.probe || resolver.probe;
  const probeVersion = opts.probeVersion || require('./versionProbe').probeVersion;
  const platform = opts.platform || process.platform;

  const toInstall = [];
  const skipped = [];
  const manual = [];

  for (const entry of entries) {
    if (entry.state === 'informational') {
      skipped.push({ depId: entry.depId, reason: 'informational（无独立运行时，无需安装）' });
      continue;
    }
    if (entry.state === 'missing') {
      skipped.push({ depId: entry.depId, reason: '清单来源机器也未安装' });
      continue;
    }
    if (entry.state === 'manual') {
      const gate = inventory.assertInstallable(entry.depId, { platform });
      manual.push({
        depId: entry.depId,
        installHint: (gate && gate.installHint) || null,
      });
      continue;
    }
    // state === 'present'：旧机有 → 新机装；本机已装则跳过（幂等，诚实告知）。
    let localPresent = false;
    let localVersion = null;
    try {
      localPresent = !!probe(entry.depId).present;
      if (localPresent) {
        const v = await probeVersion(entry.depId);
        localVersion = v && v.version ? v.version : null;
      }
    } catch {
      localPresent = false;
    }
    if (localPresent) {
      skipped.push({ depId: entry.depId, reason: `本机已装${localVersion ? ' ' + localVersion : ''}` });
      continue;
    }
    const gate = inventory.assertInstallable(entry.depId, { platform });
    if (!gate.ok) {
      // defensive：state=present 的 manual 条目（被人改过的清单）绝不进安装列表。
      if (gate.code === 'DEV_ENV_MANUAL_ONLY') {
        manual.push({ depId: entry.depId, installHint: gate.installHint || null });
      } else if (gate.code === 'DEV_ENV_NOT_INSTALLABLE') {
        skipped.push({ depId: entry.depId, reason: gate.message });
      } else {
        skipped.push({ depId: entry.depId, reason: gate.message || gate.code });
      }
      continue;
    }
    const { version, note } = _resolveInstallVersion(entry.depId, entry.version);
    let command = null;
    try {
      const plan = resolver.buildInstallPlan(entry.depId, opts.env || resolver.defaultEnv(), { version });
      command = plan ? plan.displayCommand : null;
    } catch {
      command = null;
    }
    if (!command) {
      skipped.push({ depId: entry.depId, reason: '本平台无预置安装命令（诚实降级，不伪装可装）' });
      continue;
    }
    toInstall.push({ depId: entry.depId, version, command, note });
  }

  return { toInstall, skipped, manual, unknown };
}

/**
 * 导入执行：顺序安装预览出的 toInstall 项，装后 probe 复验。manual 条目经
 * assertInstallable 短路置 skipped，绝不执行脚本。运行态经 opts.onProgress
 * 上报「动作+目标+进度」，settle 于子进程退出（无 wall-clock kill）。
 *
 * @param {object} manifest  解析后的清单 JSON
 * @param {object} [opts] { onProgress, runInstall, probe, env, platform }
 * @returns {Promise<object>} { ok, state, succeeded, failed, skipped, results }
 */
async function applyImport(manifest, opts = {}) {
  const plan = await previewImport(manifest, opts);
  const runInstall = opts.runInstall || require('./installRunner').runInstall;
  const probe = opts.probe || resolver.probe;
  const platform = opts.platform || process.platform;

  const results = [];
  const skipped = plan.skipped.slice();
  // manual 条目并入执行结果的 skipped（契约：apply 中遇到 manual 置
  // skipped(DEV_ENV_MANUAL_ONLY) 继续其余项）——不能整条丢掉，否则调用方对账
  // 时清单条目数对不上。
  for (const m of plan.manual || []) {
    skipped.push({
      depId: m.depId,
      reason: `DEV_ENV_MANUAL_ONLY${m.installHint ? `：khy 拒绝代跑，请手动执行 — ${m.installHint}` : '：khy 不自动执行官方安装脚本'}`,
    });
  }
  let succeeded = 0;
  let failed = 0;
  const total = plan.toInstall.length;

  for (let i = 0; i < total; i++) {
    const item = plan.toInstall[i];
    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress({
          index: i + 1,
          total,
          depId: item.depId,
          label: `正在安装 ${item.depId}${item.version ? ' ' + item.version : ''}（第 ${i + 1}/${total} 项）`,
        });
      } catch {
        /* 进度回调失败不阻断安装 */
      }
    }

    // 双保险：预览已过闸，这里再过一次——闸是单点实现，改清单绕不过。
    const gate = inventory.assertInstallable(item.depId, { platform });
    if (!gate.ok && gate.code === 'DEV_ENV_MANUAL_ONLY') {
      skipped.push({ depId: item.depId, reason: `DEV_ENV_MANUAL_ONLY：${gate.message}` });
      continue;
    }

    let installResult = null;
    let verified = false;
    try {
      const p = resolver.buildInstallPlan(item.depId, opts.env || resolver.defaultEnv(), {
        version: item.version,
      });
      installResult = p ? await runInstall(p, { cwd: (opts.env || resolver.defaultEnv()).cwd }) : null;
      verified = !!probe(item.depId).present;
    } catch (e) {
      installResult = { ok: false, error: 'runner-threw', steps: [], command: '', hint: (e && e.message) || '' };
    }
    const ok = !!(installResult && installResult.ok) && verified;
    if (ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
    results.push({
      depId: item.depId,
      version: item.version,
      command: item.command,
      installOk: !!(installResult && installResult.ok),
      verified,
      ok,
      error: installResult && !installResult.ok ? installResult.error || 'exit-nonzero' : null,
      hint: (installResult && installResult.hint) || null,
    });
  }

  return {
    ok: failed === 0,
    state: failed === 0 ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed',
    succeeded,
    failed,
    skipped,
    results,
  };
}

module.exports = {
  MANIFEST_KIND,
  SCHEMA_VERSION,
  buildManifest,
  buildManifestFromLatest,
  previewImport,
  applyImport,
  _internal: { _normalizeManifest, _resolveInstallVersion, _khyVersion },
};
