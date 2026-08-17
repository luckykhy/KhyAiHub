'use strict';

/**
 * selfEvidenceVerifier.js — 证据锚点的**唯一**核验实现（无依赖叶子，只读，绝不抛）。
 *
 * 为什么抽成独立叶子：锚点核验（「这个模块文件真的存在吗 / 这个门控真的是开吗」）
 * 一度只存在于 selfAuditVerifier 内部（私有 `_verifyItem` / `_gateEnabled`）。
 * 本仓后续把同一套「声明式锚点 + 运行时核验」模式用于**能力域**
 * （selfCapabilityRegistry）时，若各写一份，就成了同一个概念的**两份定义**——
 * 分叉只是时间问题（对齐 `RUNTIME-010` A2-5 所禁的「两份不一致定义」）。
 *
 * 分工不变（与自审那套一致）：
 *   - 登记表叶子（selfAuditRegistry / selfCapabilityRegistry）= **纯数据**，只**声明**锚点；
 *   - 本叶子 = 把锚点**对着活的文件系统 / 门控注册表核验**；
 *   - 各自的门控 / TTL 缓存 / 对外 API 留在各自的 verifier 里（本叶子不做缓存）。
 *
 * 锚点命名约定（**与历史行为逐字一致，不得更改**）：`modules` 里的名字以
 * `src/services/` 为基准、省略 `.js`，允许 `../tools/x` 这类上跳形式，
 * 也允许 `domain/catalog/commandCatalog/commandCatalog` 这类目录模块。
 *
 * 契约：同步、只读、零副作用、绝不抛（任一项失败 → 该项 `verified:false` + reason；
 * 整个调用 fail-soft）。
 *
 * @module services/selfEvidenceVerifier
 */

const fs = require('fs');
const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。flagRegistry 优先（集中优先级 + dogfood），不可用时回退本地 CANON 词表。
 * 默认开，仅显式 0/false/off/no 关。
 * @param {string} gate
 * @param {object} [env]
 * @returns {boolean}
 */
function gateEnabled(gate, env) {
  const e = env || process.env || {};
  const name = String(gate);
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled(name, e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e[name];
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 把锚点名解析成绝对路径并给出**相对 src/ 的展示路径**。
 * 解析失败（锚点为空/含非法字符）→ `{ok:false, abs:'', display:String(name)}`，绝不抛。
 * @param {string} name
 * @returns {{ok:boolean, abs:string, display:string}}
 */
function resolveAnchorPath(name) {
  const raw = String(name == null ? '' : name);
  try {
    const abs = path.join(__dirname, raw + '.js');
    const display = path
      .relative(path.join(__dirname, '..'), abs)
      .replace(/\\/g, '/');
    return { ok: fs.existsSync(abs), abs, display };
  } catch {
    return { ok: false, abs: '', display: raw };
  }
}

/**
 * 核验一组锚点。锚点形状：`{modules?: string[], gates?: string[]}`。
 *
 * 与 selfAuditVerifier 的历史行为**逐字一致**：
 *   - 无锚点 / 锚点为空 → `verified:false`（并给出对应 reason）；
 *   - 模块不存在 → check.ok:false、failures 记「模块缺失:<display>」；
 *   - 门控为关 → check.ok:false、failures 记「门控为关:<gate>」；
 *   - 全部通过 → `verified:true`，reason『全部证据锚点核验通过』。
 *
 * @param {{modules?:string[], gates?:string[]}} anchors
 * @param {object} [opts] {env}
 * @returns {{verified:boolean, checks:Array, reason:string}}
 */
function verifyAnchors(anchors, opts = {}) {
  const o = opts || {};
  const e = o.env || process.env || {};
  const checks = [];
  const failures = [];
  try {
    if (!anchors || typeof anchors !== 'object') {
      return { verified: false, checks, reason: '该项未声明证据锚点(evidenceAnchors 缺失)' };
    }

    const modules = Array.isArray(anchors.modules) ? anchors.modules : [];
    for (const name of modules) {
      const r = resolveAnchorPath(name);
      checks.push({
        type: 'module',
        target: r.display,
        ok: r.ok,
        detail: r.ok ? '缓解模块文件存在' : '缓解模块文件缺失',
      });
      if (!r.ok) {
        failures.push(`模块缺失:${r.display}`);
      }
    }

    const gates = Array.isArray(anchors.gates) ? anchors.gates : [];
    for (const gate of gates) {
      let ok = false;
      try {
        ok = gateEnabled(String(gate), e);
      } catch {
        ok = false;
      }
      checks.push({
        type: 'gate',
        target: String(gate),
        ok,
        detail: ok ? '门控当前为开' : '门控当前为关',
      });
      if (!ok) {
        failures.push(`门控为关:${gate}`);
      }
    }

    if (checks.length === 0) {
      return { verified: false, checks, reason: '证据锚点为空(无模块/门控可核验)' };
    }
    return failures.length === 0
      ? { verified: true, checks, reason: '全部证据锚点核验通过' }
      : { verified: false, checks, reason: failures.join(';') };
  } catch (err) {
    // Fail-soft：任何意外 → 诚实 verified:false，绝不抛。
    return {
      verified: false,
      checks,
      reason: `核验过程异常:${err && err.message ? err.message : String(err)}`,
    };
  }
}

module.exports = {
  gateEnabled,
  resolveAnchorPath,
  verifyAnchors,
};