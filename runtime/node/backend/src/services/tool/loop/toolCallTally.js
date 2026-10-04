'use strict';

/**
 * toolCallTally.js — 工具日志计数纯叶子（单一口径）。
 *
 * 背景（IMPL-RPT-063 阶段 3 / P7）：toolUseLoopCore 的 18 个 `toolCallLog.push` 落点里
 * 16 个只写 `result.success`、不写 entry 级 `success` 字段，而「任务未完成」小结旧代码只认
 * `entry.success === true/false` → 真实会话出现「已执行 4 次工具调用（0 成功, 0 失败）」
 * 的计数失真（2026-09-26 磁盘清理会话、09-26 顺网云下载会话两处独立复现）。
 *
 * 口径（与 codeChangeStats._isSuccessfulReal 同源）：
 *   - `entry.success === false` 或 `result.success === false` → 失败；
 *   - 缺省视为成功；
 *   - `result._deduped` / `result._loopDetected` → 跳过/拦截（既非成功也非失败）；
 *   - `entry.denied === true` → 被拒绝。
 * 四桶互斥，`succeeded+failed+skipped+denied` 恒等于 `toolCallLog.length`。
 *
 * @module services/tool/loop/toolCallTally
 */

function _isFailed(t) {
  return !!t && (t.success === false || !!(t.result && t.result.success === false));
}

function _isSkipped(t) {
  return !!(t && t.result && (t.result._deduped || t.result._loopDetected));
}

/**
 * @param {Array<object>} toolCallLog toolUseLoop 的工具日志
 * @returns {{succeeded: object[], failed: object[], skipped: object[], denied: object[], total: number}}
 */
function tallyToolCallLog(toolCallLog) {
  const log = Array.isArray(toolCallLog) ? toolCallLog : [];
  const denied = log.filter((t) => t && t.denied === true);
  const rest = log.filter((t) => !(t && t.denied === true));
  const failed = rest.filter((t) => !_isSkipped(t) && _isFailed(t));
  const skipped = rest.filter(_isSkipped);
  const succeeded = rest.filter((t) => !_isSkipped(t) && !_isFailed(t));
  return { succeeded, failed, skipped, denied, total: log.length };
}

module.exports = { tallyToolCallLog };
