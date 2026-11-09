#!/usr/bin/env node
/**
 * check-aesthetics.js — FE-004 美学执行器（令牌 schema + 跨端必需项存在性 + WCAG 2.2 对比度）
 *
 * 服务既有规则 FE-004（[DESIGN-FE-004] 前端 CSS 与样式架构规范），不是新规则。
 * 语义真源是 [DESIGN-FE-012] khy-os 软件美学标准；本执行器做三件事：
 *
 *   1. schema —— 校验 docs/10_规范/registry/AESTHETICS-TOKENS.json 的分类、
 *      语义令牌与字段齐全（缺字段 / 类型错判 error）。
 *   2. 存在性 —— 每个 required=true 的语义令牌，在其已声明（surfaces.<end> 非 null）
 *      的端令牌文件里应能对上本地名。对不上（声明的名字在文件里找不到）判 warning
 *      （**漂移**）。null 是**已登记缺口**（registry 的 $meta.nullSemantics 逐端说明），
 *      不再逐条告警——只报漂移，不重复报已知缺口。
 *   3. 对比度（[DESIGN-FE-012] §3.2 规则③ / §7 Q5）—— 对 **web 与 khyquant** 的
 *      语义色按 WCAG 2.2 双阈值（正文 4.5:1 / 大字与 UI 3:1）与其 bg 令牌比对。
 *      var() 链**递归解析（带环检测）** + rgba()/hex **alpha 合成**后计算相对亮度比。
 *      TUI / 桌面 / 移动不做对比度断言（底色不可静态确定或表达不同，只做存在性）。
 *
 * 五端（tui/web/khyquant/desktop/mobile）各端本地名取法：
 *   tui      ccTheme.js 标识符（点路径按词边界）
 *   web      newapi-theme.css 的 --khy-*
 *   khyquant theme.css 的 --khy-*
 *   desktop  globals.css 的 --color-*
 *   mobile   app_colors.dart 的 AppColors.* / AppRadius.* / AppShadows.* / AppDuration.*
 *
 * 落地阶段（PROCESS-008 / [DESIGN-PROCESS-002]）：S1 观察者 —— error 降级为 warning、
 * 恒 exit 0、只记录不阻断（PP-3）。stage 权威是本文件的 STAGE 常量，
 * check-rollout-stage.js 会拿它跟 FEATURE-OWNERSHIP.json 的登记比对，漂移即报错。
 *
 * Usage: node scripts/ci/check-aesthetics.js [--changed]
 * Fixture root: KHY_AESTHETICS_ROOT=/path/to/repo node scripts/ci/check-aesthetics.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_AESTHETICS_ROOT
  ? path.resolve(process.env.KHY_AESTHETICS_ROOT)
  : path.resolve(__dirname, '..', '..');

const TOKENS_REL = 'docs/10_规范/registry/AESTHETICS-TOKENS.json';
const TUI_THEME_REL = 'runtime/node/backend/src/cli/tui/theme/ccTheme.js';
const WEB_THEME_REL = 'delivery/web/ai-frontend/src/styles/newapi-theme.css';
const KHYQUANT_THEME_REL = 'delivery/channel/khyquant/frontend/src/styles/theme.css';
const DESKTOP_THEME_REL = 'apps/khyos-desktop/src/renderer/theme/globals.css';
const MOBILE_THEME_REL = 'delivery/mobile/khy-os-client-app/lib/ui/theme/app_colors.dart';

// 五端 surfaces 名册，与 AESTHETICS-TOKENS.json 的 $meta.surfaces 对应。
const ENDS = ['tui', 'web', 'khyquant', 'desktop', 'mobile'];
// 存在性校验的端：五端全扫（desktop/mobile 为本轮新增，Q9）。
const CHECKED_ENDS = ENDS;
// 对比度断言的端：只有底色可静态确定的 web 与 khyquant（Q5）。
const CONTRAST_ENDS = ['web', 'khyquant'];
// 分类名册：缺失即 schema error（防分类被误删）。
const REQUIRED_CATEGORIES = ['color', 'typography', 'spacing', 'radius', 'shadow', 'motion', 'icon'];

// null 的处置口径，逐字对齐 AESTHETICS-TOKENS.json 的 $meta.nullSemantics：
//   tui / web —— 真源缺该令牌，留痕（info，不喊 warning）
//   desktop / mobile —— 该端尚未确立映射，"守卫跳过不报，避免噪声"
// 三类一律跳过存在性校验：null 是「取值未决」，不是「令牌缺失」，拿它当缺口去
// 查本地名只会产出一批对应不到任何真实问题的 warning —— 那种噪声教会读者忽略
// 本守卫，真缺口（对度不足、本地名漂移）跟着一起被忽略。
const NULL_UNDECIDED_ENDS = new Set(['tui', 'web']);
const NULL_UNMAPPED_ENDS = new Set(['desktop', 'mobile']);

const RULE = 'FE-004';

// 落地阶段权威（PROCESS-008 PP-3）：S1 ⇒ error 降级 warning、恒 exit 0。
const STAGE = 'S1';
const OBSERVER_STAGES = new Set(['S1', 'S2']);

const changedMode = process.argv.includes('--changed');

const findings = [];

function addFinding(severity, file, message, line) {
  findings.push({ severity, rule: RULE, file, line: line || 1, message });
}

/** S1/S2 只记录不阻断：error 一律降级为 warning（PP-3）。 */
function severityFor(severity) {
  return OBSERVER_STAGES.has(STAGE) && severity === 'error' ? 'warning' : severity;
}

function readText(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

/** 需要重跑的相关文件是否在本轮改动集内（--changed 用）。 */
function changedTouchesRelevant() {
  const { execSync } = require('child_process');
  let out = '';
  try {
    // `-c core.quotePath=false`：不加时 git 把非 ASCII 路径渲染成带引号的八进制转义串
    // （"docs/10_\350\247\204..."），与 rel 字面量比不上 → 唯一的中文命名真源
    // （docs/10_规范/registry/AESTHETICS-TOKENS.json）永远不在改动集里，守卫静默跳过。
    // 含未跟踪的新文件（令牌真源可能尚未 commit，如首次落地时）。
    out = execSync('git -c core.quotePath=false diff --name-only HEAD', { encoding: 'utf8', cwd: REPO_ROOT })
      + execSync('git -c core.quotePath=false ls-files --others --exclude-standard', { encoding: 'utf8', cwd: REPO_ROOT });
  } catch (error) {
    // git 不可用 ≠ 「相关文件没改」。原来这里返回 false，外层就打印
    // 「checked=0 findings=0 exit=0」——跑不起来被报成了通过（红着的门等于没有门）。
    const err = new Error(
      'check-aesthetics: --changed 取不到改动集 —— git 不可用或不在工作树内。\n' +
      '  本次未检查任何文件 ⇒ 不得读作通过。请把 git 加入 PATH 后重跑，或不带 --changed 做全量检查。'
    );
    err.gitUnavailable = true;
    throw err;
  }
  const changed = new Set(out.split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/')));
  return [TOKENS_REL, TUI_THEME_REL, WEB_THEME_REL, KHYQUANT_THEME_REL, DESKTOP_THEME_REL, MOBILE_THEME_REL]
    .some((rel) => changed.has(rel));
}

/** 声明的本地名是否像可机判的标识符（否则视为散文约定，不作存在性判定）。 */
function isIdentifier(name) {
  return /^[A-Za-z][A-Za-z0-9_.]*$/.test(name);
}

function isWebToken(name) {
  return /^--khy-[\w-]+$/.test(name);
}

function isColorToken(name) {
  return /^--color-[\w-]+$/.test(name);
}

/** 从 Web / khyquant 令牌文件抽已定义的 --khy-* 名集合。 */
function collectWebTokens(css) {
  const set = new Set();
  for (const match of css.matchAll(/(--khy-[\w-]+)\s*:/g)) set.add(match[1]);
  return set;
}

/** 从桌面令牌文件抽已定义的 --color-* 名集合。 */
function collectColorTokens(css) {
  const set = new Set();
  for (const match of css.matchAll(/(--color-[\w-]+)\s*:/g)) set.add(match[1]);
  return set;
}

/** 标识符存在性：点路径逐段按词边界查（tui 与 mobile 共用）。 */
function hasIdentifier(text, name) {
  return name.split('.').every((seg) => new RegExp(`\\b${seg}\\b`).test(text));
}

function checkSchema(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    addFinding('error', TOKENS_REL, '顶层必须是对象。');
    return 0;
  }

  const meta = data.$meta;
  if (!meta || typeof meta !== 'object') {
    addFinding('error', TOKENS_REL, '缺少 $meta 对象。');
  } else {
    for (const field of ['standard', 'version']) {
      if (typeof meta[field] !== 'string' || !meta[field].trim()) {
        addFinding('error', TOKENS_REL, `$meta.${field} 缺失或非字符串。`);
      }
    }
  }

  let tokenCount = 0;
  for (const category of REQUIRED_CATEGORIES) {
    const group = data[category];
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      addFinding('error', TOKENS_REL, `缺少分类 ${category}（或不是对象）。`);
      continue;
    }
    const names = Object.keys(group);
    if (names.length === 0) {
      addFinding('error', TOKENS_REL, `分类 ${category} 为空，至少需一个语义令牌。`);
      continue;
    }
    for (const name of names) {
      tokenCount++;
      const token = group[name];
      const where = `${category}.${name}`;
      if (!token || typeof token !== 'object' || Array.isArray(token)) {
        addFinding('error', TOKENS_REL, `${where} 必须是对象。`);
        continue;
      }
      if (typeof token.required !== 'boolean') {
        addFinding('error', TOKENS_REL, `${where}.required 必须是布尔值。`);
      }
      if (typeof token.rationale !== 'string' || !token.rationale.trim()) {
        addFinding('error', TOKENS_REL, `${where}.rationale 缺失或为空。`);
      }
      if (typeof token.source !== 'string' || !token.source.trim()) {
        addFinding('error', TOKENS_REL, `${where}.source 缺失或为空。`);
      }
      if ('value' in token && token.value !== null && typeof token.value !== 'string') {
        addFinding('error', TOKENS_REL, `${where}.value 只允许字符串或 null（三态见 $meta.valueSemantics）。`);
      }
      const surfaces = token.surfaces;
      if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces)) {
        addFinding('error', TOKENS_REL, `${where}.surfaces 缺失或不是对象。`);
        continue;
      }
      for (const end of ENDS) {
        if (!(end in surfaces)) {
          addFinding('error', TOKENS_REL, `${where}.surfaces 缺端 ${end}。`);
        } else {
          const v = surfaces[end];
          if (v !== null && typeof v !== 'string') {
            addFinding('error', TOKENS_REL, `${where}.surfaces.${end} 只允许字符串或 null。`);
          }
        }
      }
    }
  }
  return tokenCount;
}

/** 已声明（非 null）的本地名，在其端令牌文件里是否存在（找不到 = 漂移，判 warning）。 */
function checkCrossEnd(data) {
  const texts = {
    tui: readText(TUI_THEME_REL),
    web: readText(WEB_THEME_REL),
    khyquant: readText(KHYQUANT_THEME_REL),
    desktop: readText(DESKTOP_THEME_REL),
    mobile: readText(MOBILE_THEME_REL),
  };
  const files = {
    tui: TUI_THEME_REL,
    web: WEB_THEME_REL,
    khyquant: KHYQUANT_THEME_REL,
    desktop: DESKTOP_THEME_REL,
    mobile: MOBILE_THEME_REL,
  };
  for (const end of CHECKED_ENDS) {
    if (texts[end] === null) {
      addFinding('warning', files[end], `${end} 端令牌文件不存在，无法校验该端存在性。`);
    }
  }
  const webTokens = texts.web === null ? new Set() : collectWebTokens(texts.web);
  const khyTokens = texts.khyquant === null ? new Set() : collectWebTokens(texts.khyquant);
  const desktopTokens = texts.desktop === null ? new Set() : collectColorTokens(texts.desktop);

  for (const category of REQUIRED_CATEGORIES) {
    const group = data[category];
    if (!group || typeof group !== 'object') continue;
    for (const [name, token] of Object.entries(group)) {
      if (!token || typeof token !== 'object' || token.required !== true) continue;
      const surfaces = token.surfaces || {};
      for (const end of CHECKED_ENDS) {
        if (!(end in surfaces)) continue;
        const decl = surfaces[end];
        // null / 空 = 取值未决（$meta.valueSemantics: null = 未决，须人拍板）。跳过
        // 存在性校验，并按 $meta.nullSemantics 的逐端口径留痕：tui/web 记 info，
        // desktop/mobile 跳过不报。
        if (decl === null || decl === undefined || decl === '') {
          if (NULL_UNDECIDED_ENDS.has(end)) {
            addFinding('info', TOKENS_REL,
              `${category}.${name} 在 ${end} 端取值未决（surfaces.${end}=null），已跳过存在性校验。`);
          }
          continue;
        }

        if (end === 'web') {
          if (isWebToken(decl) && !webTokens.has(decl)) {
            addFinding('warning', WEB_THEME_REL,
              `${category}.${name} 声明 Web 本地名 ${decl}，但 newapi-theme.css 未定义该令牌。`);
          }
          continue;
        }
        if (end === 'khyquant') {
          if (isWebToken(decl) && !khyTokens.has(decl)) {
            addFinding('warning', KHYQUANT_THEME_REL,
              `${category}.${name} 声明 khyquant 本地名 ${decl}，但 theme.css 未定义该令牌。`);
          }
          continue;
        }
        if (end === 'desktop') {
          if (isColorToken(decl) && !desktopTokens.has(decl)) {
            addFinding('warning', DESKTOP_THEME_REL,
              `${category}.${name} 声明桌面本地名 ${decl}，但 globals.css 未定义该令牌。`);
          }
          continue;
        }
        // tui / mobile：标识符才校验，散文约定（如「●○⋅ 符号」）不作判定。
        if (isIdentifier(decl) && texts[end] !== null && !hasIdentifier(texts[end], decl)) {
          addFinding('warning', files[end],
            `${category}.${name} 声明 ${end} 本地名 ${decl}，但 ${path.basename(files[end])} 未定义该标识符。`);
        }
      }
    }
  }
}

// ── 对比度（[DESIGN-FE-012] §3.2 规则③ / §7 Q5）─────────────────────────────
//
// 断言面：web 与 khyquant。每对给出前景令牌 / 背景令牌 / 阈值（正文 4.5，大字与 UI 3）。
// 取值经 var() 链递归解析（带环检测）+ alpha 合成后，按 WCAG 2.2 相对亮度比计算。
// 不达标判 warning（advisory / S1）。

const WEB_CONTRAST_PAIRS = [
  { fg: '--khy-text-main', bg: '--khy-bg-main', min: 4.5, kind: 'body' },
  { fg: '--khy-text-strong', bg: '--khy-bg-main', min: 4.5, kind: 'body' },
  { fg: '--khy-text-secondary', bg: '--khy-bg-main', min: 4.5, kind: 'body' },
  { fg: '--khy-text-muted', bg: '--khy-bg-main', min: 4.5, kind: 'body' },
  { fg: '--khy-success', bg: '--khy-bg-main', min: 3, kind: 'ui' },
  { fg: '--khy-warning', bg: '--khy-bg-main', min: 3, kind: 'ui' },
  { fg: '--khy-danger', bg: '--khy-bg-main', min: 3, kind: 'ui' },
  { fg: '--khy-border', bg: '--khy-bg-main', min: 3, kind: 'ui' },
  { fg: '--khy-on-primary', bg: '--khy-primary', min: 3, kind: 'ui' },
  // 状态 chip 配对：语义色文字压在它自己的 soft 浅底上（TaskCard/TaskBoard 的
  // data-tone、以及经 --el-color-*-light-9 重映射后的 el-tag / el-alert）。
  // 上面那组只查了「文字压页面底色」，漏掉这组等于放过 UI 里最常见的配色。
  { fg: '--khy-success', bg: '--khy-success-soft', min: 3, kind: 'ui' },
  { fg: '--khy-warning', bg: '--khy-warning-soft', min: 3, kind: 'ui' },
  { fg: '--khy-danger', bg: '--khy-danger-soft', min: 3, kind: 'ui' },
  { fg: '--khy-primary', bg: '--khy-primary-soft', min: 3, kind: 'ui' },
  { fg: '--khy-text-secondary', bg: '--khy-bg-soft', min: 4.5, kind: 'body' },
];

const KHYQUANT_CONTRAST_PAIRS = [
  { fg: '--text-primary', bg: '--bg-primary', min: 4.5, kind: 'body' },
  { fg: '--text-secondary', bg: '--bg-primary', min: 4.5, kind: 'body' },
  { fg: '--text-tertiary', bg: '--bg-primary', min: 4.5, kind: 'body' },
  { fg: '--khy-success', bg: '--bg-primary', min: 3, kind: 'ui' },
  { fg: '--khy-warning', bg: '--bg-primary', min: 3, kind: 'ui' },
  { fg: '--khy-danger', bg: '--bg-primary', min: 3, kind: 'ui' },
  { fg: '--khy-primary', bg: '--bg-primary', min: 3, kind: 'ui' },
];

/** 定位选择器块（如 :root / html.dark）的 body，用花括号配对，可含嵌套。 */
function blockBody(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const open = css.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** 从块体抽 --name: value 声明（去注释）。 */
function declarations(body) {
  const map = new Map();
  if (!body) return map;
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

/** var() 链递归解析（带环检测），返回字面值或 null。 */
function resolveToken(name, map, seen) {
  if (!map.has(name)) return null;
  const raw = String(map.get(name)).trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw);
  if (!m) return raw;
  if (seen.has(name)) return null; // 环
  seen.add(name);
  const resolved = resolveToken(m[1], map, seen);
  if (resolved !== null) return resolved;
  return m[2] ? m[2].trim() : null;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** 解析 hex / rgb(a) / transparent 为 {r,g,b,a}（0..1）。 */
function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r, g, b, a };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)) / 255;
    const alpha = (p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const r = chan(parts[0]);
    const g = chan(parts[1]);
    const b = chan(parts[2]);
    const a = parts.length >= 4 ? alpha(parts[3]) : 1;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) };
  }
  return null;
}

/** fg 合成到 bg 之上（bg 视为不透明）。 */
function composite(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function relativeLuminance(c) {
  const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function runContrast(cssRel, pairs, themeBlocks) {
  for (const { label, map } of themeBlocks) {
    for (const pair of pairs) {
      const fgRaw = resolveToken(pair.fg, map, new Set());
      const bgRaw = resolveToken(pair.bg, map, new Set());
      if (fgRaw === null || bgRaw === null) continue; // 令牌缺失由存在性检查负责
      const fgColor = parseColor(fgRaw);
      let bgColor = parseColor(bgRaw);
      if (!fgColor || !bgColor) continue; // 非静态可解析颜色（渐变/color-mix 等）不判
      // bg 若带 alpha，先合成到页面白底；fg 若带 alpha，合成到 bg 之上。
      const bgEff = bgColor.a < 1 ? composite(bgColor, { r: 1, g: 1, b: 1, a: 1 }) : bgColor;
      const fgEff = fgColor.a < 1 ? composite(fgColor, bgEff) : fgColor;
      const ratio = contrastRatio(fgEff, bgEff);
      if (ratio + 1e-9 < pair.min) {
        addFinding('warning', cssRel,
          `对比度不足（${label}，${pair.kind === 'body' ? '正文' : '大字/UI'}）：`
          + `${pair.fg} 对 ${pair.bg} = ${ratio.toFixed(2)}:1 < ${pair.min}:1（WCAG 2.2）。`);
      }
    }
  }
}

function checkContrast() {
  const webText = readText(WEB_THEME_REL);
  if (webText) {
    runContrast(WEB_THEME_REL, WEB_CONTRAST_PAIRS, [
      // Web 主题表的两个令牌块写作 `html:root` / `html.dark:root`（见 newapi-theme.css
      // 顶部的注释：EP 的样式按需注入且特异性更高，本表必须抬过它）。
      // 正则要同时接受 `:root` 与 `html:root` 两种写法 —— 守卫认不出块 = 静默不检查，
      // 比检查失败更危险（实测：改成 html:root 后 Web 的 3 条对比度告警整组消失）。
      { label: 'Web 亮色 :root', map: declarations(blockBody(webText, /^\s*(?:html:)?root\s*\{/m)) },
      { label: 'Web 暗色 html.dark', map: declarations(blockBody(webText, /^\s*html\.dark(?::root)?\s*\{/m)) },
    ]);
  }
  const khyText = readText(KHYQUANT_THEME_REL);
  if (khyText) {
    runContrast(KHYQUANT_THEME_REL, KHYQUANT_CONTRAST_PAIRS, [
      { label: 'khyquant :root', map: declarations(blockBody(khyText, /^\s*:root\s*\{/m)) },
    ]);
  }
}

function main() {
  if (changedMode) {
    let touches = false;
    try {
      touches = changedTouchesRelevant();
    } catch (error) {
      if (error && error.gitUnavailable) {
        process.stderr.write(`${error.message}\n`);
        process.exit(2);
      }
      throw error;
    }
    if (!touches) {
      process.stdout.write(`\n[aesthetics] checked=0 findings=0 exit=0 (--changed: 相关文件未改动)\n`);
      process.exit(0);
    }
  }

  const raw = readText(TOKENS_REL);
  if (raw === null) {
    addFinding('error', TOKENS_REL, `令牌真源不存在：${TOKENS_REL}。`);
  }

  let data = null;
  let checked = 0;
  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      addFinding('error', TOKENS_REL, `JSON 解析失败：${error.message}。`);
    }
    if (data !== null) {
      checked = checkSchema(data);
      checkCrossEnd(data);
      checkContrast();
    }
  }

  let exitCode = 0;
  let warnCount = 0;
  let infoCount = 0;
  for (const item of findings) {
    const effective = severityFor(item.severity);
    if (effective === 'error') exitCode = 1;
    if (effective === 'warning') warnCount += 1;
    if (effective === 'info') infoCount += 1;
    const label = effective === 'error' ? 'ERROR' : effective === 'info' ? 'INFO' : 'WARN ';
    process.stdout.write(`  ${label} ${item.file}:${item.line} — ${item.message}\n`);
  }

  process.stdout.write(
    `\n[aesthetics] checked=${checked} findings=${findings.length} ` +
      `(warn=${warnCount} info=${infoCount}) stage=${STAGE} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
