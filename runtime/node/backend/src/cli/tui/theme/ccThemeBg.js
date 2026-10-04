'use strict';

/**
 * ccThemeBg — 任务面板底色 token 层（DESIGN-ARCH-176 §3.3）。
 *
 * 为什么单独一层：`ccTheme.js` 的 SEMANTIC 七 token
 * （accent/muted/success/warn/danger/border/focus）**没有任何背景色 token**，
 * 且 `ccTheme.js:158` 的 16 色路径对背景色是**坏的**——
 * `ANSI16[k] + 'm' + SEMANTIC[k]` 里 `ANSI16[k]` 是 `'\x1B[36'`（:116，无尾 m），
 * 拼出来是 `'\x1B[36m#00B4B4'`：**一段带字面量 hex 的 SGR 串，不是颜色值**。
 * 当前景色用 chalk 会二次处理所以勉强能看；**当 backgroundColor 传入，chalk 会把整串
 * 再包一层 ⇒ 底色直接失效**。
 *
 * 所以本层**自己接收色深与明度、自己映射**，`resolvePalette` 一个字都不动
 * ⇒ 对既有 20+ 消费者零影响。
 *
 * ★ 铁律（纯叶子，与 `chatChords.js` 同规格）：
 *   - 零 IO：不读文件、不读终端、不发事件
 *   - **绝不读 env**：色深与明度一律由参数传入（env 由 App 层解析后传进来）
 *   - 确定性：同参数 ⇒ 同输出
 *   - 绝不抛：任何畸形输入一律回落到「无底色」这一安全档
 *   - 绝不改入参：返回新对象
 *
 * ★ 为什么底色是安全的（DESIGN-ARCH-176 §5 稳定性机制①）：
 *   Ink 的 `render-background.js:19` 用 `colorize(' '.repeat(contentWidth), bg, 'background')`
 *   —— **用空格逐行填充**。底色**不改字符数** ⇒ 不触发 Yoga reflow ⇒ 零残影。
 */

/**
 * 六档色深。`ansi256` 与 `truecolor` 共用 hex 取值（256 色能表示 24 位色），
 * 保留两档是为了让调用方表达「我测到的是多少」，不影响输出。
 */
const DEPTH = Object.freeze({
  NONE: 1, // 无色（NO_COLOR）
  ANSI16: 4,
  ANSI256: 8,
  TRUECOLOR: 24,
});

/**
 * 三档明度。`unknown` 不是「猜不到就用 dark」，而是**如实表达「没判出来」**——
 * 见 `resolveBackgroundMode` 的诚实边界说明。
 */
const MODE = Object.freeze({
  DARK: 'dark',
  LIGHT: 'light',
  UNKNOWN: 'unknown',
});

// ── 色值表 ────────────────────────────────────────────────────────────────
// 每一档都是**显式确定值**，不靠自动降级（借鉴 lipgloss CompleteColor /
// ratatui color_adapt 的分档纪律：每档都得有确定色值）。

// 真彩色取值。低饱和中间调——同一组 hex 在各自背景下都保持可读。
const HEX = Object.freeze({
  dark: Object.freeze({
    bgSubtle: '#1c1c1c',
    bgHead: '#232323',
    bgActive: '#0f2b33', // accent 淡蓝
    bgDanger: '#331418', // danger 淡红
    bgMuted: '#191919',
  }),
  light: Object.freeze({
    bgSubtle: '#f0f0f0',
    bgHead: '#e8e8e8',
    bgActive: '#dceef5', // accent 极浅
    bgDanger: '#fbe6e6', // danger 极浅
    bgMuted: '#f6f6f6',
  }),
});

// 16 色档：**显式给 ANSI 底色**，不把 hex 丢给 chalk 去猜。
// 暗底/亮底各一组；亮底组刻意不给状态色（见该组内注释）。
const ANSI16 = Object.freeze({
  dark: Object.freeze({
    bgSubtle: 'blue', // 16 色命名走 chalk.bg*，对比度由终端主题决定
    bgHead: 'blue',
    bgActive: 'cyan', // 暗底上 cyan/red 与默认浅色字对比度稳定
    bgDanger: 'red',
    bgMuted: 'blue',
  }),
  light: Object.freeze({
    bgSubtle: 'white',
    bgHead: 'white',
    // ★ 与 unknown 档同策：16 色 + 亮底**不铺状态色**。
    // 16 色命名色的实际 RGB 由终端主题决定，chalk 无法保证对比度 ——
    // cyan 底配深色字在亮底可能糊、配浅色字在暗底可能糊。
    // 「猜错」正是本层要根治的病 ⇒ 状态区分交给 taskSurface 的冗余标记。
    bgActive: null,
    bgDanger: null,
    bgMuted: 'white',
  }),
});

// `unknown` 档：**只保留中性分组底色，禁用彩色状态底色**。
// 理由（DESIGN-ARCH-176 §3.4.3 第③层）：判不出背景明度时若给「进行中」和
// 「错误」同一个底色，用户分不清 ⇒ 状态区分全部交给字形 + 文字色
// （k9s 的做法：面板用 bgColor，状态用文字色）。
// 且这两色是「双背景都安全」的一对，各自背景下对比度均 ≥ 12:1 ⇒ 判错也不可读。
const UNKNOWN = Object.freeze({
  bgSubtle: 'gray',
  bgHead: 'gray',
  bgActive: null, // ★ 状态交给字形
  bgDanger: null, // ★ 状态交给字形
  bgMuted: null,
});

// 键顺序即消费方期望的稳定次序（头行 → 分组 → 状态 → 辅助）。
const TOKEN_NAMES = Object.freeze(['bgHead', 'bgSubtle', 'bgActive', 'bgDanger', 'bgMuted']);

/**
 * 归一化色深。无法识别 ⇒ 视作 16 色（最保守：给出的是 ANSI 命名色，不会算错宽高）。
 * @param {*} depth
 * @returns {number} DEPTH.* 之一
 */
function normalizeDepth(depth) {
  // `Number(symbol)` / `Number(bigint)` 会抛 TypeError —— 本层铁律是「绝不抛」，
  // 所以先按类型挡掉，只让真正的数值/数字字符串进入 Number()。
  const t = typeof depth;
  if (depth == null || (t !== 'number' && t !== 'string')) return DEPTH.NONE;
  const n = Number(depth);
  if (!Number.isFinite(n) || n <= 1) return DEPTH.NONE;
  if (n < 8) return DEPTH.ANSI16;
  if (n < 24) return DEPTH.ANSI256;
  return DEPTH.TRUECOLOR;
}

/**
 * 归一化明度。**畸形值一律落 `unknown`，不猜 dark** ——
 * 猜错会让亮色终端拿到深色底（不可读），unknown 走中性安全色对。
 * @param {*} mode
 * @returns {'dark'|'light'|'unknown'}
 */
function normalizeMode(mode) {
  const t = typeof mode;
  if (mode == null || (t !== 'string' && t !== 'number' && t !== 'boolean')) return MODE.UNKNOWN;
  const s = String(mode).trim().toLowerCase();
  if (s === MODE.DARK) return MODE.DARK;
  if (s === MODE.LIGHT) return MODE.LIGHT;
  return MODE.UNKNOWN;
}

/**
 * 背景明度判定。**这是本层唯一「做判断」的地方，且判断失败是常态路径而非异常。**
 *
 * 诚实边界（本仓实测，DESIGN-ARCH-176 §3.4.1）：
 *  - `COLORFGBG` 是 rxvt/xterm 惯例，**Windows Terminal 并不设它**
 *  - `terminalCapabilities.js:79` 的兜底是 `let backgroundMode = 'dark'`
 *    ⇒ 缺 `COLORFGBG` 时**不判，直接假定暗色**
 *  - 实测本机 `COLORFGBG` 未定义、`where wt.exe` 有结果（Windows Terminal 已装）
 *    ⇒ **亮色 Windows Terminal 下必然判成 dark**
 *
 * ⇒ 本函数**不读 env**（铁律），只对调用方传入的 `colorfgbg` 做解析；
 * 解析不出来就返回 `'unknown'`，让 §3.4.3 第③层接住。
 *
 * @param {object} [opts]
 * @param {string} [opts.colorfgbg] - 形如 `fg;bg` 或 `fg;default;bg`（取最后一段）
 * @param {string} [opts.termProgram] - 用于识别 Apple_Terminal
 * @returns {'dark'|'light'|'unknown'}
 */
function resolveBackgroundMode(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const raw = String(o.colorfgbg == null ? '' : o.colorfgbg).trim();
  if (raw) {
    const parts = raw.split(';').map((p) => p.trim());
    const bgSeg = parts[parts.length - 1];
    // 三段式 `fg;default;bg` 里中段出现 `default`，说明终端**自己都没报背景色**
    // （xterm 惯例：不可知时该位写 `default`）。此时末段的数字不可信 ⇒ unknown。
    // 不取它，否则 `15;default;0` 会被读成「暗色」——正是本层要根治的那类误判。
    if (parts.length >= 2 && parts.slice(0, -1).some((p) => p.toLowerCase() === 'default')) {
      return MODE.UNKNOWN;
    }
    const bg = Number(bgSeg);
    if (Number.isFinite(bg) && bg >= 0) return bg >= 7 ? MODE.LIGHT : MODE.DARK;
    // 畸形（如 'abc;xyz'）→ 落 unknown，不猜
    return MODE.UNKNOWN;
  }
  const tp = String(o.termProgram == null ? '' : o.termProgram).trim().toLowerCase();
  if (tp === 'apple_terminal') return MODE.LIGHT;
  // 其余一律 unknown：宁可走中性安全色对，不猜 dark。
  return MODE.UNKNOWN;
}

/**
 * 取全套底色 token。
 *
 * @param {object} [opts]
 * @param {number} [opts.colorDepth] - 1/4/8/24；缺省或不可用 ⇒ 无色档
 * @param {string} [opts.backgroundMode] - 'dark'|'light'|'unknown'；缺省 ⇒ unknown
 * @returns {Readonly<{bgHead:?string,bgSubtle:?string,bgActive:?string,bgDanger:?string,bgMuted:?string}>}
 *   每档固定 5 个键；`null` 表示**不设 backgroundColor**（不是缺键）。
 */
function backgroundTokens(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const depth = normalizeDepth(o.colorDepth);
  if (depth === DEPTH.NONE) {
    // 无色档：全 null ⇒ 消费方不设 backgroundColor，靠字形兜底。
    return Object.freeze({ bgHead: null, bgSubtle: null, bgActive: null, bgDanger: null, bgMuted: null });
  }
  const mode = normalizeMode(o.backgroundMode);
  const table = mode === MODE.DARK ? (depth === DEPTH.ANSI16 ? ANSI16.dark : HEX.dark)
    : mode === MODE.LIGHT ? (depth === DEPTH.ANSI16 ? ANSI16.light : HEX.light)
      : UNKNOWN;
  // 逐键拷贝成新对象：调用方改返回值不污染本模块的冻结表（不改入参的铁律延伸）。
  const out = {};
  for (const k of TOKEN_NAMES) out[k] = table[k];
  return Object.freeze(out);
}

/**
 * 单键取底色。未知键名 ⇒ `null`（不抛）。
 * 便于消费方 `backgroundColor={bg('bgActive')}` 一行接上。
 * @param {object} tokens - backgroundTokens 的返回值
 * @param {string} name - token 名
 * @returns {?string}
 */
function bg(tokens, name) {
  if (!tokens || typeof tokens !== 'object') return null;
  const k = TOKEN_NAMES.indexOf(String(name == null ? '' : name));
  return k >= 0 ? tokens[TOKEN_NAMES[k]] : null;
}

module.exports = {
  DEPTH,
  MODE,
  TOKEN_NAMES,
  normalizeDepth,
  normalizeMode,
  resolveBackgroundMode,
  backgroundTokens,
  bg,
};
