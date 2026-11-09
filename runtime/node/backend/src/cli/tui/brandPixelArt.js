'use strict';

// GENERATED FILE —— 由 scripts/brand/build-brand-assets.js 生成，请勿手改。
// 源：delivery/brand/khy-brand-geometry.js（几何单一真源）。
// 用途：TUI 终端里的品牌标记（字符点阵 + 三档明暗）。
// 网格：13 列 × 13 行。

const MARK_ART = [
  "    ██  █    ",
  "  █████ ███  ",
  " ███     ███ ",
  " ██   █   ██ ",
  "██   ███   ██",
  "    █ ███  ██",
  " █ ██  ███ █ ",
  "██  █ ███    ",
  "██   ███   ██",
  " ██   █   ██ ",
  " ███     ███ ",
  "  ███ █████  ",
  "    █  ██    ",
];

const MARK_SHADE = [
  "    DD  M    ",
  "  DMMMD BBD  ",
  " DMM     MMD ",
  " MM   D   MM ",
  "DM   DMD   MD",
  "    M DDD  DD",
  " D DM  MMD D ",
  "MB  D DDD    ",
  "DB   DMD   MD",
  " MM   D   MM ",
  " DMM     MMD ",
  "  DMD DMMMD  ",
  "    D  DD    ",
];

const MARK_COLS = 13;
const MARK_ROWS = 13;

module.exports = { MARK_ART, MARK_SHADE, MARK_COLS, MARK_ROWS };
