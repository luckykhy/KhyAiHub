'use strict';

/**
 * nodeEol.js — Node.js 版本寿命表（离线常量，doctor 只读，运行时不联网）。
 *
 * 为什么需要这张表：技术基础设施会老化，但「从没检查过期」不会出现在任何通过率
 * 上。`khy doctor` 现在能回答「Node 够不够新」，却答不出「这个 Node 还能被维护
 * 多久」。本表补的就是后者。
 *
 * 数据来源：Node.js Release Working Group 的官方发布日程
 *   https://github.com/nodejs/Release#release-schedule
 * 核对日期：2026-11-18。本文件只是该日程的离线快照——不联网、不猜、不自动更新。
 * 官方日程变动时改本表并更新 NODE_EOL_UPDATED_AT；表外的版本如实返回 known:false，
 * 而不是假装「很新」或「已过期」。
 *
 * 字段：
 *   eol  —— 官方 EOL 日期（YYYY-MM-DD，含当日；当日结束即停止维护）。
 *   lts  —— 是否 LTS 线（奇数号是 Current 线，寿命只有约 8 个月）。
 *
 * 纯函数叶子：无 IO、无依赖、不抛。可被 doctor 与单测直接消费。
 */

const NODE_EOL_SOURCE = 'https://github.com/nodejs/Release#release-schedule';
const NODE_EOL_UPDATED_AT = '2026-11-18';

const NODE_EOL_TABLE = Object.freeze({
  14: { eol: '2023-04-30', lts: true },
  16: { eol: '2023-09-11', lts: true },
  18: { eol: '2025-04-30', lts: true },
  20: { eol: '2026-04-30', lts: true },
  22: { eol: '2027-04-30', lts: true },
  24: { eol: '2028-04-30', lts: true },
  26: { eol: '2029-04-30', lts: true },
  21: { eol: '2024-06-01', lts: false },
  23: { eol: '2025-06-01', lts: false },
  25: { eol: '2026-06-01', lts: false },
});

/**
 * 解析 `v22.18.0` / `22.18.0` / `22` 形式的版本。
 * @param {string|number} raw
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseNodeVersion(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const match = text.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  if (!Number.isFinite(major)) {
    return null;
  }
  return {
    major,
    minor: Number.parseInt(match[2] || '0', 10) || 0,
    patch: Number.parseInt(match[3] || '0', 10) || 0,
  };
}

/**
 * 从 engines 范围里取下限，例如 `>=20.18.1` / `>= 20.18.1` / `^22.0.0` / `20.x`。
 * 只取第一个数字串，不做完整 semver 解析——doctor 只需要一个可比较的下限。
 * @param {string} range
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseMinNodeVersion(range) {
  const text = String(range == null ? '' : range).trim();
  if (!text) {
    return null;
  }
  const match = text.match(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i);
  if (!match) {
    return null;
  }
  const toNum = (v) => (/^\d+$/.test(v || '') ? Number.parseInt(v, 10) : 0);
  const major = toNum(match[1]);
  if (!Number.isFinite(major)) {
    return null;
  }
  return { major, minor: toNum(match[2]), patch: toNum(match[3]) };
}

/** UTC 日界，避免本地时区把 N 天算出 ±1 的偏差。 */
function _utcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * 查一个 Node 版本的寿命。
 *
 * `daysLeft` 是按 UTC 日界算的整数天：>0 仍未到 EOL，0 是 EOL 当天，<0 已过期。
 * 表外版本返回 known:false（不判过期、不判安全），由调用方如实展示「表未收录」。
 *
 * @param {string} version - `process.version` 或 semver 字符串
 * @param {Date} [now] - 判定基准（默认当前时间；单测可注入）
 * @returns {{
 *   major: number|null,
 *   known: boolean,
 *   eol: string|null,
 *   lts: boolean|null,
 *   daysLeft: number|null,
 *   expired: boolean
 * }}
 */
function getNodeEolInfo(version, now = new Date()) {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return { major: null, known: false, eol: null, lts: null, daysLeft: null, expired: false };
  }
  const entry = NODE_EOL_TABLE[parsed.major];
  if (!entry) {
    return {
      major: parsed.major,
      known: false,
      eol: null,
      lts: null,
      daysLeft: null,
      expired: false,
    };
  }
  const eolDay = Date.parse(`${entry.eol}T00:00:00Z`);
  const nowDay = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(eolDay) || Number.isNaN(nowDay.getTime())) {
    return {
      major: parsed.major,
      known: false,
      eol: entry.eol,
      lts: entry.lts,
      daysLeft: null,
      expired: false,
    };
  }
  const daysLeft = Math.round((eolDay - _utcDay(nowDay)) / 86400000);
  return {
    major: parsed.major,
    known: true,
    eol: entry.eol,
    lts: entry.lts,
    daysLeft,
    // EOL 当天仍是维护期最后一天，次日才算过期。
    expired: daysLeft < 0,
  };
}

module.exports = {
  NODE_EOL_TABLE,
  NODE_EOL_SOURCE,
  NODE_EOL_UPDATED_AT,
  parseNodeVersion,
  parseMinNodeVersion,
  getNodeEolInfo,
};
