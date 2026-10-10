'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO、确定性、绝不抛、可单测。
//   判定/词汇全在叶子里；呈现由各渲染点施加。env 门控 KHY_TOOL_SEVERITY_TIERS
//   （默认开，仅 0/false/off/no 关闭即逐字节回退「成功绿 / 失败红」两档）。
//
// toolOutcomeSeverity —— 工具结果「失败严重度」的单一真源。
//
// ── 根因（为什么失败不能只有一档）────────────────────────────────────────
// 此前全仓的显示判定都是一条四路布尔式
//   isError = result.isError || result.is_error || result.error || result.success === false
// 于是「工具真的坏了」与「命令如实地回答了一个非零」在 UI 上完全同形 —— 全是红色失败。
// 但有一大类**可预期的边界情况**根本不是失败:
//   - `ls <一个文件>`:路径存在、只是不是目录 —— 用户/模型要的信息就在这句话里;
//   - `grep -q` / `test -f` / `git diff --quiet` / `command -v foo` 探针:非零退出
//     就是「没有 / 不是 / 不存在」这个**答案本身**;
//   - `npm test` 之外的任何非零退出:模型会连着跑十几个探针命令,每条都刷一片红。
// 红色刷屏的代价是真实的:真正需要一眼看见的错误被淹没在红色里。
//
// ── 分层（确定性、无模型参与）─────────────────────────────────────────────
//   ok     : 成功                                → ✓ 绿（不变）
//   notice : 非成功，但属**可预期的边界情况**    → • 黄 + 如实说明原因（不是失败红）
//   error  : 真错误（工具坏了 / 调用非法 / 权限  → ✗ 红（不变）
//           拒绝 / 进程被信号杀死 / 依赖缺失）
//
// ── 零假阳性底线 ─────────────────────────────────────────────────────────
// 降档**只能由生产者显式声明** `severity: 'notice'` 触发。叶子绝不从错误文本里
// 猜「这看起来像可预期情况」—— 那会让真错误被静默降级成黄点，比红色刷屏更糟。
// 没有显式声明 → 一律 error。

/** 严重度枚举。稳定取值，调用方按此分支（勿新增同义项）。 */
const SEVERITY = Object.freeze({
  OK: 'ok',
  NOTICE: 'notice',
  ERROR: 'error',
});

/** notice 档的呈现词汇（单一真源，避免每个渲染点各写一份颜色/字形）。 */
const NOTICE_COLOR = 'yellow';
const NOTICE_GLYPH = '•';

/** env 门控（默认开，仅 0/false/off/no 关闭）。纯函数、绝不抛。 */
function isEnabled(env) {
  try {
    const v = String((env || process.env || {}).KHY_TOOL_SEVERITY_TIERS || '')
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true; // fail-soft：读不到 env 时保持默认开
  }
}

/**
 * 结果是否被生产者**显式**声明为「中性说明」。纯函数、绝不抛。
 * 只认 `severity: 'notice'` 这一个显式标记 —— 绝不从文本推断。
 */
function isNotice(result) {
  try {
    return !!(result && typeof result === 'object' && result.severity === SEVERITY.NOTICE);
  } catch {
    return false;
  }
}

/**
 * 显示档位。纯函数、绝不抛。
 * @param {object} result
 * @param {object} [env]
 * @returns {'ok'|'notice'|'error'}
 */
function displaySeverity(result, env) {
  try {
    if (!result || typeof result !== 'object') {
      // 「没有结果对象」≠ 成功。与投影层的既有契约一致（projectToolResultForView 对
      // null/undefined 判 isError:true），也避免「缺失」被静默当成绿。
      return SEVERITY.ERROR;
    }
    if (!isEnabled(env)) {
      return result.success ? SEVERITY.OK : SEVERITY.ERROR; // 门关 → 两档回退
    }
    if (result.success === true) {
      return SEVERITY.OK;
    }
    return isNotice(result) ? SEVERITY.NOTICE : SEVERITY.ERROR;
  } catch {
    return SEVERITY.ERROR; // fail-soft：判定异常按真错误处理（不静默降级）
  }
}

/**
 * 给结果打上 notice 档（生产者用）。不动 `success` —— 循环/恢复/统计仍按失败处理，
 * 本档只影响**呈现**。纯函数、绝不抛。
 * @param {object} result
 * @param {string} [reason] 供人/模型看的中性说明（可选；缺省时渲染点回退到 error 文本）
 */
function withNotice(result, reason) {
  try {
    if (!result || typeof result !== 'object') {
      return result;
    }
    const out = { ...result, severity: SEVERITY.NOTICE };
    const r = String(reason == null ? '' : reason).trim();
    if (r) {
      out.noticeReason = r;
    }
    return out;
  } catch {
    return result;
  }
}

/**
 * 渲染点使用的「中性说明」文本：优先 noticeReason，其次 error/reason/message，
 * 都取不到时返回 ''（渲染点自行决定不显示）。纯函数、绝不抛。
 */
function noticeText(result) {
  try {
    if (!result || typeof result !== 'object') {
      return '';
    }
    const pick = result.noticeReason != null ? result.noticeReason : result.error;
    const v = pick != null ? pick : result.reason != null ? result.reason : result.message;
    if (v == null) {
      return '';
    }
    if (typeof v === 'object') {
      return String(v.message || '').trim();
    }
    return String(v).trim();
  } catch {
    return '';
  }
}

/**
 * 呈现三元组(字号/颜色/是否红) —— 渲染点只消费，不各自重写一套。
 * 纯函数、绝不抛。
 * @param {'ok'|'notice'|'error'} severity
 * @returns {{icon:string, color:string, isError:boolean}}
 */
function present(severity) {
  if (severity === SEVERITY.NOTICE) {
    return { icon: NOTICE_GLYPH, color: NOTICE_COLOR, isError: false };
  }
  if (severity === SEVERITY.ERROR) {
    return { icon: '✗', color: 'red', isError: true };
  }
  return { icon: '✓', color: 'green', isError: false };
}

module.exports = {
  SEVERITY,
  NOTICE_COLOR,
  NOTICE_GLYPH,
  isEnabled,
  isNotice,
  displaySeverity,
  withNotice,
  noticeText,
  present,
};
