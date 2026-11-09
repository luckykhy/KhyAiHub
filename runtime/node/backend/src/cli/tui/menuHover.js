'use strict';

/**
 * menuHover.js — 补全菜单/参数面板挂载期的悬停追踪开关（2026-10-10）。
 *
 * 背景（用户报「鼠标悬停，和点击对照不清晰，左键单击无法准确选择」）：
 * 默认鼠标档只开 1000/1002（点击 + 自绘选择的位移）。1003（any-motion）是
 * 60~120Hz 事件洪流，常开必然吞掉终端原生拖选，所以 `mouseHoverEnabled`
 * 默认关。可菜单开着的那几秒里，用户需要的是「悬停在哪一行」的实时预览 ——
 * 没有 1003，`onMouseOver` 一次都不触发，鼠标与界面之间没有任何对照，点击
 * 只能靠猜。
 *
 * 本叶子是那道闸的判定 + 字节真源：菜单/面板挂载时**追加** `1003h`，卸载时只撤
 * `1003l`（与 select 档正交，见 tui/AGENTS.md §0.9.4「重新接管追踪必须与初始
 * 开启同档」—— 这里只动 1003 一个 bit，1000/1002 原样保留）。
 *
 * 门控 `KHY_MENU_HOVER` 默认开；显式 0/false/off/no 关（关 = 逐字节回退旧行为：
 * 菜单期也没有悬停预览）。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** 开启/撤销 any-motion 追踪的字节（只此一处定义，App 与测试共用）。 */
const HOVER_ON = '\x1b[?1003h';
const HOVER_OFF = '\x1b[?1003l';

/**
 * 菜单悬停预览默认开；仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function menuHoverEnabled(env = process.env) {
  const raw = env && env.KHY_MENU_HOVER;
  return !(raw !== undefined && OFF_VALUES.includes(String(raw).trim().toLowerCase()));
}

module.exports = { menuHoverEnabled, HOVER_ON, HOVER_OFF };
