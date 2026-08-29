'use strict';

/**
 * cardClick.js — 卡片点击的**门控与命中纯逻辑**单一真源。
 *
 * 背景（[DESIGN-ARCH-146] TUI 卡片点击交互-选项命中与展开方案）：
 *   ink 的 `collectLayout` 只把**挂了 onClick/onMouseUp/onMouseOver/onMouseOut 的节点**纳入
 *   命中区，因此「点某一行」的前提就是给那一行挂 handler。而 App.js 顶层 keyHandler 的
 *   鼠标段**早于**让键给浮层的分支约 106 行并无条件 return，所以卡片自己的 useInput
 *   收不到 SGR 序列 —— 命中判定只能靠这里提供的「行下标 ↔ 屏幕行」映射。
 *
 * 为什么单独成文件：这些判定必须能**离线单测**（不渲染 ink、不起终端）。因此本模块
 * **零依赖**、无副作用、不 require 任何带 IO/单例的模块（`mouseButtons` 由调用方注入
 * 档位结论；缺省时才走惰性 require，且异常一律 fail-soft 关掉点击）。
 *
 * 门控族口径与仓内一致：**显式 falsy 关，其余（含 unset）开**；但要真开点击还须
 * 鼠标档位本身可用（备屏 → click；主屏 → off）。两条都要满足。
 */

// 与 questionCardModel / mouseButtons 同源语义：显式 falsy 关，其余开。
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _flagOn(raw) {
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 卡片点击总闸。**两条同时成立**才为真：
 *   1. `KHY_CARD_CLICK` 未被显式设为 falsy（默认开）；
 *   2. 鼠标档位允许按键（`mouseButtonsEnabled`）—— 主屏/未识别终端下点击本就收不到。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {boolean} [buttonsEnabled] 调用方算好的档位结论；省略则惰性向 mouseButtons 求值。
 *        显式传入除了省一次求值，也让单测不必碰真环境。
 * @returns {boolean}
 */
function cardClickEnabled(env = process.env, buttonsEnabled) {
  if (!_flagOn(env && env.KHY_CARD_CLICK)) return false;
  if (typeof buttonsEnabled === 'boolean') return buttonsEnabled;
  try {
    const m = require('../mouseButtons');
    return typeof m.mouseButtonsEnabled === 'function' ? m.mouseButtonsEnabled(env) : false;
  } catch {
    // 鼠标模块不可用 → 点击能力静默关闭（fail-soft：不因缺依赖让整张开卡崩掉）。
    return false;
  }
}

/**
 * 命中行下标 → 语义行下标。
 *
 * `hitTest` 的 `row` 是**屏幕绝对行**，而卡片只有渲染出来的那几行。卡片自身不掌握自己在
 * 屏幕上的 y 偏移（那是 App 的 chrome 账本的事），所以正确做法是：**不用绝对行**，而是把
 * 每一行**各自挂一个 `onClick`**，由 ink 在命中该行时回调 —— 回调闭包里携带的行下标
 * 天然就是语义行下标，无需任何坐标换算。本函数因此只做**边界收束**：把可能的越界/非整数
 * 下标判为「无命中」，避免把 undefined 行当成第 0 行。
 *
 * @param {number} idx 闭包携带的行下标（渲染顺序，非键盘光标）
 * @param {number} rowCount 该卡当前的行总数
 * @returns {number|null} 合法下标，或 null 表示无命中
 */
function normalizeRowIndex(idx, rowCount) {
  // 只认真正的整数，不做隐式转换：字符串 '2' / 布尔 / null 一律判无命中。
  // 若这里用 Number(idx) 松转，传字符串下标会被静默接受 —— 而「静默接受一个来路不明的
  // 下标」正是本函数要防的事（见 expandable/toggle 的同类判据）。
  if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
  if (!Number.isInteger(rowCount) || rowCount <= 0) return null;
  if (idx < 0 || idx >= rowCount) return null;
  return idx;
}

/**
 * 展开态切换。点击同一行是**切换**（展开↔收起），点击另一行则**改为展开那一行**
 * （同时收起原来的）—— 保证任一时刻至多一行处于展开态，卡片高度因而有上界。
 *
 * @param {number|null} current 当前展开的行下标（null = 无）
 * @param {number} target 本次点击的行下标
 * @returns {number|null} 新的展开行下标（null = 全部收起）
 */
function toggleExpandedRow(current, target) {
  if (current === target) return null;
  return Number.isInteger(target) ? target : null;
}

/**
 * 展开态的**可展开性判据**：只有自带完整说明（desc 非空）的行才值得展开 —— 展开空说明
 * 会让整行凭空多出一对空白，用户以为卡坏了。`desc` 已是单行的行同样无需展开
 * （没有「被裁剪掉的另一半」）。
 *
 * @param {string} full 完整说明文本
 * @param {string} rendered 当前渲染出的说明文本（可能已被尺寸阶梯裁剪）
 * @returns {boolean}
 */
function expandable(full, rendered) {
  const f = String(full == null ? '' : full).trim();
  if (!f) return false;
  return f !== String(rendered == null ? '' : rendered).trim();
}

/**
 * 展开后的行文本：以「说明独占后续行」的形式拼接，前缀与标签原样保留。
 *
 * @param {string} head 该行的前缀 + 标签（如 `   ❯ 1. [x] 选项甲`）
 * @param {string} full 完整说明
 * @returns {string} 多行字符串（首行是 head，其后是说明全文）
 */
function expandLine(head, full) {
  const f = String(full == null ? '' : full).trim();
  if (!f) return String(head == null ? '' : head);
  return `${head}\n${f}`;
}

module.exports = {
  OFF_VALUES,
  cardClickEnabled,
  normalizeRowIndex,
  toggleExpandedRow,
  expandable,
  expandLine,
};
