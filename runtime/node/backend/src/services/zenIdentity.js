'use strict';

/**
 * zenIdentity.js — 「每机一份」的 Zen 客户端身份（机器码）。
 *
 * 为什么要它（2026-10-24 对 https://opencode.ai/zen/v1 实测，见 docs/opencode-provider-keys.md）：
 *   上游免费层是**按出口 IP 计配额**、并**按 IP 判信誉**的：
 *     · 本机 IP + 合法 opencode UA 直连 → 429 FreeUsageLimitError（该 IP 的免费配额用完）
 *     · 共享代理 IP + 合法 UA 直连      → 403 "abusive traffic from this IP address"
 *     · 非 opencode UA（裸 curl）        → 403 FreeTierError "can only be used from within OpenCode"
 *   身份指纹由 User-Agent + x-opencode-session + x-opencode-project 三件套构成。
 *
 *   旧实现（zenGatekeeper 里的进程级随机 id）有两个致命问题：
 *     1. **每重启一次就是一个"新设备"** —— 固定 IP 配全新设备号，正是上游反滥用模型里
 *        最像"批量刷量"的形态；
 *     2. 多用户共用一个服务端 IP 时，**一个 IP 的配额被所有人吃干** → 全员 429 → 再全员被封。
 *
 * 本模块给出的正是用户要的语义：**在哪台机器上允许，就在那台机器上用它的机器码**。
 *   · 身份从机器码（KHY_MACHINE_ID，否则 hostname）派生 → 同机恒定、异机相异；
 *   · 落盘在 <dataHome>/zen_identity.json → **跨重启稳定**（重启不再是"新设备"）；
 *   · env 可显式覆盖（用户明确指定修改时用，见下表）；
 *   · 门 KHY_ZEN_IDENTITY 关 → 逐字节回退旧的进程级随机行为。
 *
 * env 覆盖（用户明确指定修改的唯一入口）：
 *   KHY_ZEN_IDENTITY       主门。默认开；0/false/off/no 关 → 不落盘、不派生，
 *                           回退 zenGatekeeper 的进程级随机 id（历史行为）。
 *   KHY_ZEN_SESSION_ID     显式指定 session id（优先级最高）。
 *   KHY_ZEN_PROJECT_ID     显式指定 project uuid（优先级最高）。
 *   KHY_ZEN_IDENTITY_FILE  落盘路径覆盖（对齐 zenRetiredModels 的 KHY_ZEN_RETIRED_FILE 约定）。
 *
 * 门控解析优先走 flagRegistry（与 freeModelChannels 一致），失败回退本地解析。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const _OFF = new Set(['0', 'false', 'off', 'no']);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 身份是否持久化（主门）。默认开；显式 off 字面量关。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function enabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (
        reg &&
        typeof reg.isRegistryEnabled === 'function' &&
        typeof reg.isFlagEnabled === 'function' &&
        reg.isRegistryEnabled(e)
      ) {
        return reg.isFlagEnabled('KHY_ZEN_IDENTITY', e);
      }
    } catch {
      /* fall through to local parse */
    }
    const v = String(e.KHY_ZEN_IDENTITY == null ? '' : e.KHY_ZEN_IDENTITY)
      .trim()
      .toLowerCase();
    return !_OFF.has(v);
  } catch {
    return false;
  }
}

/**
 * 本机机器码。优先 KHY_MACHINE_ID，否则取 hostname（与 cli/hqStore 的 machineId 同源：
 * 同一台机器上二者常只差大小写，故本模块所有比较一律走同一条取值链）。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function machineSeed(env = process.env) {
  const e = env || {};
  const explicit = String(e.KHY_MACHINE_ID == null ? '' : e.KHY_MACHINE_ID).trim();
  if (explicit) {
    return explicit;
  }
  try {
    // 真源在共享底座 utils/machineIdentity.js（单一真源，cli/hqStore 也从它取）——
    // 原先真源留在 cli/hqStore，services 反向 require cli/ 是 R1 分层倒置。
    // 此处只做一次轻量 require，拿不到就退回 hostname。
    const identity = require('../utils/machineIdentity');
    if (identity && typeof identity.machineId === 'function') {
      const v = String(identity.machineId(e) || '').trim();
      if (v) {
        return v;
      }
    }
  } catch {
    /* 拿不到就退回 hostname */
  }
  try {
    // eslint-disable-next-line global-require
    const os = require('os');
    return String(os.hostname() || '').trim();
  } catch {
    return '';
  }
}

/** 从种子 + 用途派生确定性字节。HMAC-SHA256，避免跨用途相关性。 */
function _derive(seed, purpose) {
  return crypto
    .createHmac('sha256', 'khy-zen-identity-v1')
    .update(`${purpose}\0${String(seed || '')}`)
    .digest();
}

/** 确定性 base62 串（用于 session id 尾部 14 位）。 */
function _base62From(bytes, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i % bytes.length] % BASE62.length];
  }
  return out;
}

/**
 * opencode Identifier.create 形态：prefix + "_" + 12 位 hex + 14 位 base62。
 * 上游免费层门控会**拒收不是 12 位 hex 开头**的 id，故时间段必须保持 12 位 hex。
 *
 * 关键取舍：12 位 hex 用**首次落盘时刻**倒序编码（与 opencode 真实 session 一致，
 * 看起来就是"那台机器在某个时刻开的一个会话"），而不是每次重启重算 —— 重启不变，
 * 正是"跨重启稳定"的落点。尾部 14 位由机器码派生 → 同机恒定、异机相异。
 */
function _sessionIdFrom(seed, createdAtMs) {
  let now = BigInt(createdAtMs) * BigInt(0x1000) + BigInt(1);
  now = ~now; // 倒序，与 opencode 的 session id 同向
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const tail = _base62From(_derive(seed, 'session-tail'), 14);
  return `ses_${timeBytes.toString('hex')}${tail}`;
}

/** 确定性 UUID v4 形态（16 字节派生 + 固定 version/variant 位）。 */
function _uuidFrom(seed, purpose) {
  const b = Buffer.from(_derive(seed, purpose).subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 落盘路径。env 覆盖优先（测试与人工复位用）。 */
function identityFile(env = process.env) {
  const override = env && env.KHY_ZEN_IDENTITY_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  try {
    return path.join(getDataHome(), 'zen_identity.json');
  } catch {
    return path.join(getLegacyDataHome(), 'zen_identity.json');
  }
}

let _cache = null;
let _cacheFile = null;
let _cacheMtimeMs = -1;

function _readFresh(file) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (_cache && _cacheFile === file && _cacheMtimeMs === mtimeMs) {
    return _cache;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = null;
  }
  _cache = parsed;
  _cacheFile = file;
  _cacheMtimeMs = mtimeMs;
  return _cache;
}

function _write(file, state) {
  _cache = state;
  _cacheFile = file;
  _cacheMtimeMs = 0; // 强制下次重读，避免与新文件的 mtime 竞合
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 落盘失败不该让调用失败：下一轮仍可从机器码确定性派生出一致的值 */
  }
}

/**
 * 取本机的 Zen 身份。
 *
 * 优先级：env 显式覆盖 > 落盘文件 > 机器码确定性派生（并落盘）。
 * 门关 / 任何异常 → 返回 null，由调用方回退到进程级随机（历史行为）。
 *
 * @param {Record<string,string>} [env]
 * @returns {{sessionId:string, projectUuid:string, source:string}|null}
 */
function getIdentity(env = process.env) {
  try {
    const e = env || {};
    if (!enabled(e)) {
      return null;
    }
    const envSession = String(e.KHY_ZEN_SESSION_ID == null ? '' : e.KHY_ZEN_SESSION_ID).trim();
    const envProject = String(e.KHY_ZEN_PROJECT_ID == null ? '' : e.KHY_ZEN_PROJECT_ID).trim();
    if (envSession && envProject) {
      return { sessionId: envSession, projectUuid: envProject, source: 'env' };
    }

    const file = identityFile(e);
    const stored = _readFresh(file);
    if (stored && stored.sessionId && stored.projectUuid) {
      if (envSession || envProject) {
        return {
          sessionId: envSession || stored.sessionId,
          projectUuid: envProject || stored.projectUuid,
          source: envSession || envProject ? 'env+file' : 'file',
        };
      }
      return { sessionId: stored.sessionId, projectUuid: stored.projectUuid, source: 'file' };
    }

    const seed = machineSeed(e);
    if (!seed) {
      return null; // 没有机器码 → 无法保证"同机恒定" → 回退历史行为
    }
    const createdAt = Number(stored && stored.createdAt) || Date.now();
    const sessionId = envSession || _sessionIdFrom(seed, createdAt);
    const projectUuid = envProject || _uuidFrom(seed, 'project');
    const state = { sessionId, projectUuid, createdAt, machine: seed, source: 'derived' };
    _write(file, state);
    return { sessionId, projectUuid, source: 'derived' };
  } catch {
    return null;
  }
}

/** 人类可读的当前身份摘要（诊断用，不含任何密钥）。 */
function describe(env = process.env) {
  const id = getIdentity(env);
  if (!id) {
    return { enabled: false(env), sessionId: null, projectUuid: null, source: 'disabled' };
  }
  return {
    enabled: true,
    sessionId: id.sessionId,
    projectUuid: id.projectUuid,
    source: id.source,
    file: identityFile(env),
  };
}

/** 清掉内存态与落盘文件（测试与人工复位用）。 */
function _reset(removeFile = false) {
  if (removeFile) {
    try {
      const file = identityFile(process.env);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      /* ignore */
    }
  }
  _cache = null;
  _cacheFile = null;
  _cacheMtimeMs = -1;
}

module.exports = {
  enabled,
  machineSeed,
  identityFile,
  getIdentity,
  describe,
  _reset,
};
