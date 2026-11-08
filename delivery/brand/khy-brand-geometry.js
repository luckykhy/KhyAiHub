'use strict';

/**
 * khy-brand-geometry — Khy OS 品牌标记的**几何与配色单一真源**。
 *
 * 纯叶子：零 IO、零 env、确定性、绝不抛。构建脚本 `scripts/brand/build-brand-assets.js`
 * 读它生成 SVG / PNG / ICO；各端（Web / 桌面 / 移动 / TUI）消费生成物或等价格式。
 *
 * ── 设计说明（why，2026-10-25）────────────────────────────────────────────
 * 旧标记是「一个字母 K」：Web 排版 K、APK 排版 `Text('K')`、桌面端一个 icon.ico、
 * TUI 另有一枚像素四叶草。同一进程/同一产品里三种品牌样子，正是
 * [DESIGN-ARCH-134] §1.1 B3 登记的病灶。本模块把这三者收敛为**一枚**标记。
 *
 * 形态：「内核环」——四段弧叶围成的光圈（= 四条主张），中心一枚菱形内核
 * (= kernel / runtime)，内核上刻一道 K 形负槽（= 品牌字母，可发现但不主导读感）。
 * 选它而非「四叶草 + 印刷体 K」的原因有两条，都是实测得来的：
 *   1. 通用四叶草是 2020 年代 AI 产品的视觉通货膨胀区，且与仓内旧像素四叶草撞形；
 *   2. 任何**排版体 K**（无论装在什么容器里）读感都是「字母 K」，
 *      与「图标只有一个字母 k 太丑」这条原始诉求正面冲突。
 *
 * 配色：墨黑 + 琥珀橙。避开 2023 年后 AI 产品的通用「蓝→紫→品红渐变」；
 * 琥珀收拢自 TUI 既有的 CC/Khy 橙色品牌色 #C97557（ccTheme.js 的 `brand`），
 * 使新主色与仓内既有品牌资产同源，而不是另起一套外来色。
 */

/** 画布（viewBox）与圆心。四叶与内核共用同一圆心，保证旋转对称。 */
const CANVAS = 128;
const CENTER = 64;

/** 几何参数。全部为设计值（像素，基于 CANVAS=128）。 */
const GEOMETRY = Object.freeze({
  /** 四段弧叶的外/内半径 → 环宽 11。 */
  ringOuter: 38,
  ringInner: 27,
  /** 每段弧叶两端各让开的角度（度）：四段共 8 个缝口。 */
  ringGapDeg: 9,
  /** 内缘相对外缘的错切角（度）：让弧叶读作「光圈叶片」而非「被切的圆环」。 */
  ringSlantDeg: 14,
  /** 菱形内核半对角（正方形旋转 45°）→ 顶点 (64,45)/(83,64)/(64,83)/(45,64)。 */
  coreHalf: 19,
  /** 核心上 K 形负槽（局部坐标，相对 CANVAS 画布）。 */
  kSlot: Object.freeze({ x0: 56, x1: 60, xe: 70, y0: 54, y1: 74, cy: 64, arm: 5.5 }),
});

/**
 * 品牌色板。amber = 品牌主色族；ink = 墨黑底（负形/底板）；paper = 纸白（浅底反白）。
 * 亮/暗两端的文本安全值已在注释标注实测对比度（WCAG 2.2，底色见括号）。
 */
const PALETTE = Object.freeze({
  /** 品牌核心琥珀（图形用，不作文字色）。 */
  amber500: '#E2703A',
  /** 渐变亮端（图形左上）。 */
  amber300: '#FFC078',
  /** 暗色底上的文本安全琥珀（对 #14110E ≈ 9.4:1）。 */
  amber400: '#F0A868',
  /** 浅色底上的 UI 强调（对白底 4.55:1，够 3:1 的图形门槛）。 */
  amber600: '#C2551F',
  /** 浅色底上的文本安全琥珀（对 #FFFFFF ≈ 6.6:1）。 */
  amber700: '#9C4116',
  /** 墨黑：品牌底板与负形色（暖调近黑，不用纯黑以免死板）。 */
  ink: '#14110E',
  /** 墨黑的浅一档（分层底板）。 */
  inkSoft: '#1C1815',
  /** 纸白：浅底场景的反白用色。 */
  paper: '#F6F2EC',
});

/** 四舍五入到 3 位小数，避免路径里出现浮点尾巴。 */
function f(n) {
  return Number(Number(n).toFixed(3));
}

/** 极坐标取点。 */
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [CENTER + r * Math.cos(a), CENTER + r * Math.sin(a)];
}

/**
 * 多边形定向：按 shoelace 面积符号统一顺/逆时针。
 * SVG 的 nonzero 填充规则下，**外轮廓与洞必须绕向相反**才能挖出真洞。
 */
function orient(points, wantPositive) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  const positive = area > 0;
  return positive === wantPositive ? points : points.slice().reverse();
}

function toPath(points) {
  return 'M ' + points.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L ') + ' Z';
}

/**
 * 四段弧叶环。每段 = 外缘弧 + 斜切端头 + 内缘弧（回程）。
 * 端头斜切由 `ringSlantDeg` 控制：内缘两端相对外缘两端各偏移该角度。
 */
function ringBladePaths(g = GEOMETRY) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const o0 = polar(g.ringOuter, i * 90 + g.ringGapDeg);
    const o1 = polar(g.ringOuter, (i + 1) * 90 - g.ringGapDeg);
    const i1 = polar(g.ringInner, (i + 1) * 90 - g.ringGapDeg + g.ringSlantDeg);
    const i0 = polar(g.ringInner, i * 90 + g.ringGapDeg + g.ringSlantDeg);
    out.push(
      `M ${f(o0[0])} ${f(o0[1])} ` +
        `A ${g.ringOuter} ${g.ringOuter} 0 0 1 ${f(o1[0])} ${f(o1[1])} ` +
        `L ${f(i1[0])} ${f(i1[1])} ` +
        `A ${g.ringInner} ${g.ringInner} 0 0 0 ${f(i0[0])} ${f(i0[1])} Z`
    );
  }
  return out;
}

/**
 * K 形负槽的三笔：竖干 + 上下臂。绕向与菱形内核相反 → 在内核上挖出真槽。
 */
function kSlotPaths(slot = GEOMETRY.kSlot) {
  const stem = orient(
    [
      [slot.x0, slot.y0],
      [slot.x1, slot.y0],
      [slot.x1, slot.y1],
      [slot.x0, slot.y1],
    ],
    false
  );
  const upper = orient(
    [
      [slot.x1, slot.cy - slot.arm / 2],
      [slot.xe, slot.y0],
      [slot.xe, slot.y0 + slot.arm],
      [slot.x1, slot.cy + slot.arm / 2],
    ],
    false
  );
  const lower = orient(
    [
      [slot.x1, slot.cy - slot.arm / 2],
      [slot.xe, slot.y1 - slot.arm],
      [slot.xe, slot.y1],
      [slot.x1, slot.cy + slot.arm / 2],
    ],
    false
  );
  return [toPath(stem), toPath(upper), toPath(lower)];
}

/** 菱形内核（可带 K 负槽；用 evenodd 时槽是真洞）。 */
function corePath(g = GEOMETRY, withSlot = true) {
  const pts = orient(
    [
      [CENTER, CENTER - g.coreHalf],
      [CENTER + g.coreHalf, CENTER],
      [CENTER, CENTER + g.coreHalf],
      [CENTER - g.coreHalf, CENTER],
    ],
    true
  );
  return toPath(pts) + (withSlot ? ' ' + kSlotPaths(g.kSlot).join(' ') : '');
}

/** 标记的分组路径（供渲染与断言共用）。 */
function markParts(g = GEOMETRY) {
  return {
    blades: ringBladePaths(g),
    core: corePath(g, true),
    corePlain: corePath(g, false),
  };
}

module.exports = {
  CANVAS,
  CENTER,
  GEOMETRY,
  PALETTE,
  f,
  polar,
  orient,
  toPath,
  ringBladePaths,
  kSlotPaths,
  corePath,
  markParts,
};
