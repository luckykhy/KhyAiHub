'use strict';

/**
 * diskCleanup/index.js — 安全磁盘清理引擎门面（scan → plan → clean）。
 *
 * 教 khyos「怎么清理 C 盘/D 盘又不破坏用户所需要的数据」的对外单一入口。设计承诺：
 *   · 只从 junkCatalog 白名单选删除目标（名单外一律当用户数据，不碰）。
 *   · 两道否决（catalog 白名单 + protectedGuard 受保护根/用户数据信号），fail-closed。
 *   · dry-run 默认：scan/plan 纯只读；clean 不传 apply 也只演练。
 *   · 回收站/更新缓存等「涉及可恢复数据」归 review，必须显式 includeReview 才动。
 *   · 真正执行删除时由 DiskCleanupTool 声明 isDestructive→经 riskGate 不可绕人闸确认。
 *
 * 用法：
 *   const dc = require('services/diskCleanup');
 *   const plan = dc.plan({ roots: ['C:'], includeReview: false });   // 看会清什么
 *   const report = await dc.clean({ roots: ['C:'], apply: true });    // 真清（经人闸）
 */

const stringWidth = require('string-width');

const executor = require('./executor');
const catalog = require('./junkCatalog');
const planner = require('./planner');
const guard = require('./protectedGuard');
const scanner = require('./scanner');

/** 只读扫描：返回全部候选（含被跳过/否决的，便于透明）。 */
function scan(opts = {}) {
  return scanner.scan(opts);
}

/** 组装计划（只读）。 */
function plan(opts = {}) {
  const scanResult = scanner.scan(opts);
  return planner.buildPlan(scanResult, opts);
}

/**
 * 执行清理。apply 缺省 false → 仅演练。
 * @param {object} [opts] - {roots, includeReview, keepRecentHours, categories, apply, deps}
 * @returns {Promise<{plan, report}>}
 */
async function clean(opts = {}) {
  const p = plan(opts);
  const report = await executor.execute(p, opts);
  return { plan: p, report };
}

/** ASCII 报告（纯字符串，终端/Web 通用）。 */
// 框总显示宽度（含左右边界字符）。内容与边界一律按显示宽度对齐：全角 CJK
// 占 2 格却只算 1 个 code unit，用 .length/.padEnd/.slice 会把右边界撑歪。
const BOX_W = 54;

function renderPlanReport(plan) {
  const lines = [];
  const t = plan.totals;
  lines.push(_sep('khyos 安全磁盘清理 · 计划', '┌', '┐'));
  lines.push(
    _row(` 平台: ${_pad(plan.platform, 10)} 盘符: ${_pad(plan.driveRoots.join(' '), 16)}`)
  );
  lines.push(_sep(null, '├', '┤'));
  lines.push(
    _row(` 本次将清理: ${_pad(t.selectedCount + ' 项', 8)} 可回收 ${_pad(t.selectedHuman, 10)}`)
  );
  if (Object.keys(plan.byCategory).length) {
    for (const [cat, v] of Object.entries(plan.byCategory)) {
      lines.push(
        _row(`   · ${_pad(cat, 16)} ${_pad(String(v.count) + ' 项', 7)} ${planner._humanBytes(v.bytes)}`)
      );
    }
  } else {
    lines.push(_row('   (无可清理项，磁盘已很干净)'));
  }
  if (t.reviewCount) {
    lines.push(_sep('需确认 (review，默认不清)', '├', '┤'));
    lines.push(
      _row(
        ` ${_pad(t.reviewCount + ' 项', 8)} 约 ${_pad(t.reviewHuman, 10)}  含回收站/更新缓存等`
      )
    );
    lines.push(_row(' 想清这些请显式开启 includeReview'));
  }
  if (t.skippedCount) {
    lines.push(_sep('已保护跳过', '├', '┤'));
    for (const s of plan.skipped.slice(0, 6)) {
      lines.push(_row(` ⚠ ${_pad(s.label, 22)} ${s.skipReason}`));
    }
  }
  lines.push(_sep(null, '└', '┘'));
  return lines.join('\n');
}

// 内容行：左 `│` + 补齐/截断到 (BOX_W-2) 列 + 右 `│`。
function _row(inner) {
  return '│' + _fit(inner, BOX_W - 2) + '│';
}

// 分隔线：`l ─ label ───── r`，总显示宽度 BOX_W；label 为空则纯横线。
function _sep(label, l, r) {
  const body = label ? `─ ${label} ` : '─';
  const rest = Math.max(0, BOX_W - 2 - stringWidth(body));
  return l + body + '─'.repeat(rest) + r;
}

// 按显示宽度补齐；超宽则逐 code point 截断，绝不切半个全角字符。
function _fit(s, width) {
  const cur = stringWidth(s);
  if (cur <= width) return s + ' '.repeat(width - cur);
  let out = '';
  for (const ch of s) {
    if (stringWidth(out) + stringWidth(ch) > width - 1) break;
    out += ch;
  }
  return out + '…';
}

function _pad(v, width) {
  const s = String(v == null ? '' : v);
  const n = stringWidth(s);
  return n >= width ? s : s + ' '.repeat(width - n);
}

module.exports = {
  scan,
  plan,
  clean,
  renderPlanReport,
  // 透传子模块，便于直接单测/复用
  scanner,
  planner,
  executor,
  catalog,
  guard,
};
