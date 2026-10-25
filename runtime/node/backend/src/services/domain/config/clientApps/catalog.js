'use strict';

/**
 * clientApps/catalog.js — 「应用中心」客户端应用登记表的装载与校验
 * （DESIGN-ARCH-189 §7.1；S1 只读阶段）。
 *
 * 职责与边界：
 * - catalog.json 是本特性的唯一真源：页面与 /scan 都从它派生，调用方不得另写清单。
 * - 装载即校验，且 fail-loud：缺字段 / 非法 category / appId 重复 / 探针形状非法，
 *   一律抛出带定位信息的错误。登记表是声明式真源，静默补默认值会把配置漂移变成
 *   静默失败（规则 2.2 状态透明）。
 * - 本模块的 IO 只有一处：读同目录 catalog.json。刻意不 require 任何 adapter ——
 *   登记表接口要保持轻（不含副作用加载）；adapter 存在性 / switch 可达性由
 *   catalog.test.js 钉住。
 *
 * @module services/domain/config/clientApps/catalog
 */

const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, 'catalog.json');

/** 合法分类：对应页面页签（cli → 「CLI Code」，desktop → 「桌面端」）。 */
const CATEGORIES = Object.freeze(['cli', 'desktop']);

/** 合法探针种类（scan.js 的 resolveProbeTarget 逐个实现）。 */
const PROBE_KINDS = Object.freeze(['home', 'userAppConfig']);

/** 模型下拉的合法能力分组（S1 一律为空数组 = 不渲染下拉；见 DESIGN-ARCH-189 §8 D6）。 */
const MODEL_SLOTS = Object.freeze(['image', 'video']);

const REQUIRED_STRING_FIELDS = ['appId', 'name', 'pkgName', 'desc', 'category'];

function _fail(where, why) {
  const err = new Error(`clientApps 登记表非法：${where} — ${why}（修复动作：编辑 ${CATALOG_FILE} 后重试）`);
  err.code = 'CLIENT_APPS_CATALOG_INVALID';
  throw err;
}

function _assertNonEmptyString(entry, field, where) {
  const v = entry[field];
  if (typeof v !== 'string' || !v.trim()) {
    _fail(where, `字段 ${field} 必须是非空字符串，实得 ${JSON.stringify(v)}`);
  }
}

// backupKeys 的字符集与 backup.js 的 assertBackupKey 同一套判据 —— 两处各写一份
// 正则就会漂移，而备份 key 写错会让备份落到意外位置。故从这里 import 单一真源。
const { BACKUP_KEY_RE } = require('./backup');

/**
 * backupKeys 校验（[DESIGN-ARCH-189] P3）。
 *
 * 三条：
 *   1. 必须是字符串数组，且每个 key 过 backup.js 的字符集（≠ appId 由编排层保证，
 *      这里只保证形状合法——同一 app 有多份受管文件正是要有多个 key 的原因）。
 *   2. **空数组必须配 backupNote**。允许「这个 app 没有受管文件可备」，但不允许
 *      静默地没有备份——那是 fail-open。command-code/ycode 只写 env 引用、
 *      trae 的 configPath 指向 khy-os 自己的 store，都靠这句话显式说明。
 *   3. 同一 app 内 key 不得重复。
 */
function _validateBackupKeys(entry, where) {
  const keys = entry.backupKeys;
  if (!Array.isArray(keys)) {
    _fail(where, `backupKeys 必须是数组，实得 ${JSON.stringify(keys)}`);
  }
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== 'string' || !BACKUP_KEY_RE.test(k)) {
      _fail(where, `backupKey "${k}" 含非法字符（只允许字母数字与 -_.，且不以点开头，最长 64）`);
    }
    if (seen.has(k)) {
      _fail(where, `backupKey "${k}" 在同一条目内重复`);
    }
    seen.add(k);
  }
  if (keys.length === 0) {
    _assertNonEmptyString(entry, 'backupNote', where);
  } else if (entry.backupNote !== undefined) {
    _fail(where, '配了 backupKeys 就不该再有 backupNote（二者互斥）');
  }
}

function _validateEntry(entry, index, seen) {
  const where = `apps[${index}]（${entry && entry.appId ? entry.appId : '未命名'}）`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    _fail(where, '条目必须是对象');
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    _assertNonEmptyString(entry, field, where);
  }
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(entry.appId)) {
    _fail(where, `appId "${entry.appId}" 必须是 kebab-case`);
  }
  if (seen.has(entry.appId)) {
    _fail(where, `appId "${entry.appId}" 重复登记`);
  }
  seen.add(entry.appId);
  if (!CATEGORIES.includes(entry.category)) {
    _fail(where, `category 必须是 ${CATEGORIES.join(' | ')} 之一，实得 "${entry.category}"`);
  }
  const hasAdapter = typeof entry.adapter === 'string' && entry.adapter.trim().length > 0;
  if (entry.adapter !== null && !hasAdapter) {
    _fail(where, 'adapter 只能是非空字符串（写配置器模块名）或 null（只读卡）');
  }
  _validateBackupKeys(entry, where);
  if (!hasAdapter && !entry.probe) {
    _fail(where, '无写配置器（adapter=null）的卡片必须提供 probe，否则连「装了没」都无法探测');
  }
  if (entry.probe !== undefined) {
    const probe = entry.probe;
    if (!probe || typeof probe !== 'object') {
      _fail(where, 'probe 必须是对象');
    }
    if (!PROBE_KINDS.includes(probe.kind)) {
      _fail(where, `probe.kind 必须是 ${PROBE_KINDS.join(' | ')} 之一，实得 "${probe.kind}"`);
    }
    if (!Array.isArray(probe.segs) || probe.segs.length === 0 || probe.segs.some((s) => typeof s !== 'string' || !s)) {
      _fail(where, 'probe.segs 必须是非空字符串数组（相对路径段，禁止写绝对路径）');
    }
    if (probe.segs.some((s) => /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.includes('..'))) {
      _fail(where, 'probe.segs 禁止绝对路径与 .. 上跳（零硬编码 / 路径安全）');
    }
  }
  if (entry.modelSlots !== undefined) {
    if (!Array.isArray(entry.modelSlots) || entry.modelSlots.some((s) => !MODEL_SLOTS.includes(s))) {
      _fail(where, `modelSlots 只能是 [${MODEL_SLOTS.join(', ')}] 的子集（S1 应为空数组）`);
    }
  }
  return entry;
}

/**
 * 装载并校验登记表。
 *
 * @param {{ file?: string }} [opts] 测试可注入文件路径；生产一律走同目录 catalog.json。
 * @returns {{ apps: object[], count: number, updated: string|null, version: number|null }}
 * @throws {Error} 文件缺失 / JSON 损坏 / 任一条目非法（code = CLIENT_APPS_CATALOG_INVALID 或 CLIENT_APPS_CATALOG_MISSING）
 */
function loadCatalog(opts = {}) {
  const file = opts.file || CATALOG_FILE;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const err = new Error(`clientApps 登记表不可读：${file} — ${e.message}`);
    err.code = 'CLIENT_APPS_CATALOG_MISSING';
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`clientApps 登记表 JSON 损坏：${file} — ${e.message}`);
    err.code = 'CLIENT_APPS_CATALOG_INVALID';
    throw err;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.apps) || doc.apps.length === 0) {
    _fail('根', '必须包含非空 apps 数组');
  }
  const seen = new Set();
  const apps = doc.apps.map((entry, i) => _validateEntry(entry, i, seen));
  return {
    apps,
    count: apps.length,
    updated: typeof doc.updated === 'string' ? doc.updated : null,
    version: typeof doc.version === 'number' ? doc.version : null,
  };
}

module.exports = { loadCatalog, CATEGORIES, PROBE_KINDS, MODEL_SLOTS, CATALOG_FILE };
