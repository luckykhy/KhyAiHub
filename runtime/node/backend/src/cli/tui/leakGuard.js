'use strict';

/**
 * leakGuard.js — TUI 内存泄漏检测（[MGMT-RPT-031] P1-5）。
 *
 * AGENTS.md 一直列着「定时器/监听器必须清理」，但只有清单没有检测器。这里给
 * 两条互补的探针，都来自开源同行的标准做法（@sinonjs/fake-timers 的资源记账、
 * Node 官方 `process.getActiveResourcesInfo()` diff、WeakRef sweep）：
 *
 *   1. 资源快照 diff —— `process.getActiveResourcesInfo()`（Node ≥17.3，无 flag）
 *      按类型分组计数，工作负载前后各拍一张，差值即「没清理的活动资源」。
 *      适合挂在 node:test 里断言「跑完 TUI 会话后 Timeout/Immediate 不涨」。
 *   2. WeakRef sweep —— 显式登记对象，丢引用后 `sweep()` 报「已被回收 / 仍被
 *      持有」。`global.gc` 只有 `--expose-gc` 下才存在：拿不到时如实报
 *      `gcUnavailable`（诚实跳过，绝不假装测过了）。
 *
 * 纯叶子：零 IO、绝不抛、无门控依赖（调用方决定何时用）。resource diff 的
 * 判读是**结构性**的（涨了就是涨了），不做绝对字节数断言——内存 <50MB 那种
 * 地板值靠绝对数守不住。
 */

/**
 * 活动资源按类型分组的快照。
 * @returns {{total: number, byType: Record<string, number>, at: string}}
 */
function snapshotResources() {
  let list = [];
  try {
    list = process.getActiveResourcesInfo() || [];
  } catch {
    list = [];
  }
  const byType = {};
  for (const t of list) {
    byType[t] = (byType[t] || 0) + 1;
  }
  return { total: list.length, byType, at: new Date().toISOString() };
}

/**
 * 两张快照的差集。delta > 0 = 该类型资源在工作负载后**净增**，即疑似泄漏。
 * @param {{byType: Record<string, number>}} before
 * @param {{byType: Record<string, number>}} after
 * @returns {{leaked: Array<{type: string, delta: number}>, released: Array<{type: string, delta: number}>, clean: boolean}}
 */
function diffResources(before, after) {
  const b = (before && before.byType) || {};
  const a = (after && after.byType) || {};
  const types = new Set([...Object.keys(b), ...Object.keys(a)]);
  const leaked = [];
  const released = [];
  for (const t of types) {
    const delta = (a[t] || 0) - (b[t] || 0);
    if (delta > 0) leaked.push({ type: t, delta });
    else if (delta < 0) released.push({ type: t, delta: -delta });
  }
  leaked.sort((x, y) => y.delta - x.delta);
  return { leaked, released, clean: leaked.length === 0 };
}

/**
 * WeakRef 登记表。`track(obj, label)` 后 `sweep()` 分拣「已回收 / 仍被持有」。
 * gc 不可用时 sweep 如实报 `gcUnavailable`，retained 列表照常给出（但此时
 * 「仍被持有」可能是「还没轮到 GC」而不是泄漏——调用方不得据此判死）。
 * @returns {{track(obj: object, label?: string): void, sweep(): {gcAvailable: boolean, gcUnavailable?: boolean, collected: number, retained: Array<{label: string, reason: string}>}}}
 */
function createSweep() {
  const refs = [];
  return {
    track(obj, label) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      try {
        refs.push({ ref: new WeakRef(obj), label: String(label || 'unnamed') });
      } catch { /* WeakRef 不可用的极老运行时 → 该探针静默不登记 */ }
    },
    sweep() {
      const gcAvailable = typeof global.gc === 'function';
      const retained = [];
      let collected = 0;
      if (gcAvailable) {
        try { global.gc(); } catch { /* gc 抛错按不可用处理 */ }
      }
      let i = refs.length;
      while (i-- > 0) {
        const entry = refs[i];
        let alive = true;
        try {
          alive = entry.ref.deref() !== undefined;
        } catch {
          alive = true; // deref 异常按存活计（诚实侧）
        }
        if (alive) {
          retained.push({
            label: entry.label,
            reason: gcAvailable
              ? '强制 GC 后仍被持有——真泄漏候选'
              : 'gc 不可用（--expose-gc）——无法区分「泄漏」与「尚未回收」',
          });
        } else {
          collected += 1;
          refs.splice(i, 1);
        }
      }
      const out = { gcAvailable, collected, retained };
      if (!gcAvailable) out.gcUnavailable = true;
      return out;
    },
  };
}

/** 人类可读摘要（调用方决定 sink；本模块不写）。 */
function renderDiff(d) {
  const lines = [];
  if (!d || (d.clean && !(d.released || []).length)) {
    return '泄漏检测：工作负载前后活动资源零净增（干净）';
  }
  if (d.leaked && d.leaked.length) {
    lines.push('疑似泄漏（净增活动资源）：');
    for (const l of d.leaked) lines.push(`  ${l.type} +${l.delta}`);
  }
  if (d.released && d.released.length) {
    lines.push('已释放（净减）：');
    for (const l of d.released) lines.push(`  ${l.type} -${l.delta}`);
  }
  return lines.join('\n');
}

module.exports = { snapshotResources, diffResources, createSweep, renderDiff };
