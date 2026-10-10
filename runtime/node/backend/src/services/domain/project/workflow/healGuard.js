/**
 * healGuard.js — 自愈声明的真判据（方案 [DESIGN-ARCH-141] §5-D2 点 2）。
 *
 * 背景：`RPATool` 的自愈协议是「AI 按提示词手工做」的 —— 失败后 AI 修复图，
 * 再 `RPA.save(..., healedFrom=<失败节点 id>)` 声称这一版是对该失败的治愈。
 * 在引入本闸之前，`healedFrom` 是**只写不读**的（写入方 `RPATool`、透传方
 * `flowRegistry`，消费方 0 处）⇒ 一个**凭空捏造**的 `healedFrom` 与一个真溯源
 * 的 `healedFrom` 在系统里毫无区别。
 *
 * 本叶子把「声称」变成「可判定的判据」，四条全部通过才认可该自愈声明：
 *   ① `healedFrom` 必须是非空字符串（失败节点 id）；
 *   ② 必须**存在上一版**可溯源 —— 没有上一版就无从谈起「治愈了上一版的失败」；
 *   ③ 根因节点必须**存在于上一版图中** —— 否则该自愈是幻觉（§5-D2 原文）；
 *   ④ 自愈链深度不得超过上限 —— 补丁的补丁会掩盖根因，且让审计无法回溯。
 *
 * 契约（与同目录 graphPatch / expandTemplate 一致）：
 * - **零 IO**：只吃入参，不 require 任何有 IO/单例的模块 ⇒ 可离线单测；
 * - **确定性**：同输入同输出，不读时钟 / 环境 / 随机数；
 * - **绝不抛**：任何畸形入参都收敛为 `{ ok:false, errors }`；
 * - 判据通过返回 `{ ok:true, depth }`，`depth` 供调用方持久化为 `_meta.healDepth`。
 *
 * ⚠ 本叶子**不**校验契约断言（那需要 vars 与真实工具，只能在重放侧做），
 * 也**不**做物理回退 —— 见 §5-D2 裁决「只报不滚」。
 */
'use strict';

// 自愈链深度上限。取值理由：一次失败 → 一次修复是正常闭环；修复后又失败 → 再修复，
// 说明根因未被定位。5 次已是「链式补丁」而非「治愈」，且超过后审计无法回溯原始失败。
const DEFAULT_MAX_HEAL_DEPTH = 5;

// 上一版图里的节点 id 集合。畸形图返回空集合（不抛）。
function _nodeIds(graph) {
  const nodes = graph && typeof graph === 'object' && Array.isArray(graph.nodes) ? graph.nodes : [];
  const ids = new Set();
  for (const n of nodes) {
    if (n && typeof n === 'object' && typeof n.id === 'string' && n.id) {
      ids.add(n.id);
    }
  }
  return ids;
}

// 读上一版的 healDepth。未声明 ⇒ 0（自愈链在上一版处断开）；
// 已声明但不是非负整数 ⇒ 数据损坏，判为不可信（fail-closed），不静默当 0。
function _prevDepth(prevMeta) {
  const m = prevMeta && typeof prevMeta === 'object' ? prevMeta : {};
  if (m.healDepth === undefined || m.healDepth === null) {
    return { ok: true, depth: 0 };
  }
  const d = Number(m.healDepth);
  if (!Number.isInteger(d) || d < 0) {
    return { ok: false, reason: `上一版 _meta.healDepth 非法（${JSON.stringify(m.healDepth)}）` };
  }
  return { ok: true, depth: d };
}

/**
 * 校验一条自愈声明。
 * @param {object} claim
 * @param {string} claim.healedFrom      AI 声称被治愈的失败节点 id
 * @param {object|null} claim.prevGraph  上一版的 canonical 图 `{ nodes, connections }`（无上一版传 null）
 * @param {object|null} claim.prevMeta   上一版的 `_meta`（无上一版传 null）
 * @param {number} [claim.maxDepth]      深度上限，缺省 DEFAULT_MAX_HEAL_DEPTH
 * @returns {{ok:true,depth:number}|{ok:false,errors:string[]}}  绝不抛
 */
function checkHealClaim(claim) {
  try {
    const c = claim && typeof claim === 'object' ? claim : {};
    const errors = [];

    // ① 声明本身必须成形
    const healedFrom = typeof c.healedFrom === 'string' ? c.healedFrom.trim() : '';
    if (!healedFrom) {
      return { ok: false, errors: ['自愈声明 healedFrom 必须是非空字符串（失败节点 id）'] };
    }

    // ② 必须有上一版可溯源
    const prevIds = c.prevGraph ? _nodeIds(c.prevGraph) : null;
    if (!prevIds || prevIds.size === 0) {
      return {
        ok: false,
        errors: [
          `自愈声明 healedFrom='${healedFrom}' 不可溯源：不存在上一版流程（或上一版无节点）` +
            ' ⇒ 该自愈是幻觉',
        ],
      };
    }

    // ③ 根因节点必须存在于上一版图中
    if (!prevIds.has(healedFrom)) {
      return {
        ok: false,
        errors: [
          `自愈声明 healedFrom='${healedFrom}' 不可溯源：该节点不在上一版流程中` +
            `（上一版共 ${prevIds.size} 个节点） ⇒ 该自愈是幻觉`,
        ],
      };
    }

    // ④ 自愈链深度上限
    const prev = _prevDepth(c.prevMeta);
    if (!prev.ok) {
      return { ok: false, errors: [`${prev.reason} ⇒ 自愈链深度不可信，拒绝该自愈声明`] };
    }
    const depth = prev.depth + 1;
    const cap = Number.isFinite(Number(c.maxDepth))
      ? Number(c.maxDepth)
      : DEFAULT_MAX_HEAL_DEPTH;
    if (depth > cap) {
      return {
        ok: false,
        errors: [
          `自愈链深度 ${depth} 超过上限 ${cap}（上一版 healDepth=${prev.depth}）` +
            ' ⇒ 拒绝：链式自愈会掩盖根因',
        ],
      };
    }

    return { ok: true, depth };
  } catch (err) {
    return { ok: false, errors: [`自愈声明校验异常：${(err && err.message) || String(err)}`] };
  }
}


// ── 重放侧：自愈闭环三态裁决（§5-D2 点 1）────────────────────────────────────

/**
 * 由一次重放的结果算出「这一版自愈到底算不算治愈」。
 *
 * 裁决依据（§5-D2 点 1）：自愈版本必须让契约断言**全绿**才算 healed。
 * 三态**必须可区分** —— 同一处「没通过」有多种成因，若错误串不可区分，等于把
 * 「静默失真」换成「误导失真」（步 A 的教训）。
 *
 * - `healRejected`   契约未全绿：run 本身失败，或契约断言未通过 ⇒ 不算 healed；
 * - `healUnverified` 无法判定：未声明 contract（无断言可判 ⇒ 闸空转），
 *                     或契约校验环节自身异常（原代码 fail-soft 按通过处理，
 *                     那是为了不淹没一次成功的 run；但裁决必须诚实说「未验证」）；
 * - `healVerified`   契约全绿 ⇒ 才算 healed。
 *
 * ⚠ 本函数**只出裁决，不做物理回退**（裁决：只报不滚）。当前存储模型下没有
 * 「上一版的图」可退 —— `save` 原地覆盖同一文件，`_meta.previousVersion` 只是
 * 个数字。故只给出 `rollbackTarget` 供调用方（AI / hq）决定。
 *
 * @param {object} input
 * @param {object|null} input.meta                流程的 `_meta`
 * @param {boolean} input.succeeded               重放是否正常完成
 * @param {boolean} input.contractFailed          契约断言是否未通过
 * @param {string|null} [input.contractCheckError] 契约校验环节自身的异常
 * @param {string} [input.flowName]               用于回退目标的流程名
 * @returns {object|null}  无 healedFrom 时返回 null；否则返回三态之一。绝不抛。
 */
function computeHealVerdict(input) {
  try {
    const i = input && typeof input === 'object' ? input : {};
    const meta = i.meta && typeof i.meta === 'object' ? i.meta : {};
    if (typeof meta.healedFrom !== 'string' || !meta.healedFrom) {
      return null;
    }
    const prevVersion = Number(meta.previousVersion);
    const verdict = {
      healedFrom: meta.healedFrom,
      healDepth: Number.isInteger(Number(meta.healDepth)) ? Number(meta.healDepth) : null,
      rollbackTarget:
        Number.isInteger(prevVersion) && prevVersion > 0
          ? { name: String(i.flowName == null ? '' : i.flowName), version: prevVersion }
          : null,
    };
    const hasContract = Array.isArray(meta.contract) && meta.contract.length > 0;
    if (i.succeeded !== true) {
      verdict.healRejected = true;
      verdict.healRejectReason = 'run-failed';
    } else if (i.contractFailed === true) {
      verdict.healRejected = true;
      verdict.healRejectReason = 'contract-failed';
    } else if (i.contractCheckError) {
      verdict.healUnverified = true;
      verdict.healUnverifiedReason = `契约校验环节异常 ⇒ 该自愈未被验证：${String(
        i.contractCheckError
      )}`;
    } else if (!hasContract) {
      verdict.healUnverified = true;
      verdict.healUnverifiedReason =
        '自愈版本未声明 contract ⇒ 无断言可判，闭环闸空转；该自愈未被验证';
    } else {
      verdict.healVerified = true;
    }
    return verdict;
  } catch (err) {
    return {
      healRejected: true,
      healRejectReason: 'verdict-error',
      healedFrom: null,
      healDepth: null,
      rollbackTarget: null,
      healRejectDetail: `自愈裁决环节异常：${(err && err.message) || String(err)}`,
    };
  }
}

module.exports = {
  checkHealClaim,
  computeHealVerdict,
  DEFAULT_MAX_HEAL_DEPTH,
};
