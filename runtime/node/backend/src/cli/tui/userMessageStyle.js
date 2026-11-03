'use strict';

/**
 * userMessageStyle — 「用户自己的话」在转录里的视觉待遇**单一真源**(纯叶子:零 IO、
 * 确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「输入与输出必须一眼分得开」):用户在转录里回显的那几行,必须与 AI
 * 的答复在**形态**上分开,而不是只差一个首行 `❯ ` 前缀。此前两条 TUI 路径口径不一:
 *   - `<Static>` 路径(Transcript.MessageBlock,`KHY_INLINE_TRANSCRIPT=0`)画**米白底盒**;
 *   - 默认的应用内 Viewport 路径(`KHY_INLINE_TRANSCRIPT` 默认开)把用户消息投影成
 *     `'❯ ' + text` 的**纯文本行**,Viewport 逐行 `h(Text, null, line)` —— 于是用户消息
 *     与 AI 答复在屏幕上完全同色同底,用户回报「和回显没有差别,不方便阅读」。
 * 本叶子把「底色 / 字色 / 总闸」收敛到一处,两条路径共用,避免再次分叉。
 *
 * 门控:KHY_USER_MSG_WHITE_BG(默认开)。=0/false/off/no → 关 → 两条路径都回退到
 * 改动前的透明回显(逐字节等价)。
 *
 * 为什么底色是米白而不是纯白:纯白对深色字在终端里对比过强、刺眼;米白(eggshell)
 * 既与默认背景的正文分开,又不晃眼。字色用 truecolor 近黑而非命名 `black`,因为
 * `black` + `bold` 在多数终端被提升到 BRIGHT-black 槽位(= 灰),在米白底上显得
 * 发灰发虚 —— 见下面 DEFAULT_USER_MSG_FG 的注释。
 */

// 米白色 (warm off-white / eggshell) rather than pure white: pure 'white' against
// dark text is too high-contrast / glaring in a terminal. This softer cream keeps
// the user-message box visually distinct from the default-background output while
// being easy on the eyes. Overridable with KHY_USER_MSG_BG (any chalk-accepted
// color: a hex like '#F0EAD6' or a named color) for users who want a different tint.
const DEFAULT_USER_MSG_BG = '#F0EAD6';

// Foreground for the user-message text on the cream box. The named color 'black'
// combined with `bold` gets promoted to the terminal's BRIGHT-black palette slot
// (= gray) on most emulators — which is exactly why the text read as washed-out,
// low-contrast gray on the off-white box instead of black. A truecolor hex is
// immune to the bold→bright promotion, so the text renders as true, high-contrast
// black against the cream. Overridable with KHY_USER_MSG_FG (any chalk-accepted
// color: a hex like '#000000' or a named color).
const DEFAULT_USER_MSG_FG = '#1A1A1A';

/** 读一个环境变量并 trim;未设 / 非字符串 → ''(与历史 `process.env.X == null ? '' : X` 同义)。 */
function _envStr(env, name) {
  const raw = env == null ? undefined : env[name];
  return String(raw == null ? '' : raw).trim();
}

/** `KHY_USER_MSG_BG` 覆写,缺省 / 全空白 → 米白。 */
function userMsgBgColor(env = process.env) {
  return _envStr(env, 'KHY_USER_MSG_BG') || DEFAULT_USER_MSG_BG;
}

/** `KHY_USER_MSG_FG` 覆写,缺省 / 全空白 → 近黑。 */
function userMsgFgColor(env = process.env) {
  return _envStr(env, 'KHY_USER_MSG_FG') || DEFAULT_USER_MSG_FG;
}

/**
 * 用户消息着色总闸(默认开)。=0/false/off/no → 关 → 两条路径都逐字节回退到
 * 改动前的透明回显。
 */
function userMsgWhiteBgEnabled(env = process.env) {
  const v = _envStr(env, 'KHY_USER_MSG_WHITE_BG').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 一行转录文本该带的 ink 样式。**单一真源**:`<Static>` 的米白底盒与默认
 * Viewport 路径的行样式都由它派生,免得两处各写一份颜色。
 *
 * @param {string} role 行的角色(`buildTranscriptLineRecords` 的 roles 元素)
 * @param {object} [env=process.env]
 * @returns {{backgroundColor:string,color:string,bold:boolean}|null}
 *   ink `<Text>` 的 props;`null` = 不加任何 prop(默认色,与改动前逐字节一致)。
 */
function userLineTextProps(role, env = process.env) {
  if (role !== 'user' || !userMsgWhiteBgEnabled(env)) {
    return null;
  }
  return { backgroundColor: userMsgBgColor(env), color: userMsgFgColor(env), bold: true };
}

// 思维链折叠块的底色(dark violet),与用户消息的米白盒**同一处真源、不同色**:
// 把「思维链被收成一坨可点开的小块」在视觉上钉出来,是用户回报「思维链没有单独用
// 一块底色整理起来」的直接缺口。刻意**只给底色**,不覆盖 color/bold —— 思维链正文
// 仍走既有的 dimColor / cyan 外观,免得与米白盒的近黑字色口径混在一起(两套底色
// 各自的字色由各自路径决定)。
//
// 为什么和用户消息底色分叉而不是复用:两者服务的对比方向相反 —— 米白盒要把用户的话
// 从深色背景里**提亮**,思维链块要把思考从正文里**压暗**(它是附属物,不该抢答复的
// 注意力)。共用一个常量会让其中一侧必然失衡。
const DEFAULT_THINKING_BG = '#241f38';

/**
 * 思维链块的底色。签名带 `env` 只为与 userMsgBgColor 对称;**刻意不读任何新的
 * `KHY_` 前缀思维链环境变量** —— TUI 的 env 门预算已透支(check-tui-gates 实测
 * 232 > 227),任何新门都不许再加;要改底色请直接改上面的常量。
 * @param {object} [env]
 * @returns {string} ink `<Text>` 可接受的 backgroundColor
 */
function thinkingLineBgColor(env = process.env) {
  return DEFAULT_THINKING_BG;
}

/**
 * 一行思维链行该带的 ink `<Text>` props。与 `userLineTextProps` 同源同职责,只是
 * 判据从「行的角色」换成「折叠锚点」(`transcriptLines` 的 folds 元素)。
 *
 * @param {{kind?:string}|null|undefined} anchor `folds[i]`
 * @param {object} [env]
 * @returns {{backgroundColor:string}|null} 非思维链行恒 `null`(不加任何 prop)
 */
function thinkingLineTextProps(anchor, env = process.env) {
  if (!anchor || typeof anchor !== 'object' || anchor.kind !== 'thinking') {
    return null;
  }
  return { backgroundColor: thinkingLineBgColor(env) };
}

module.exports = {
  DEFAULT_USER_MSG_BG,
  DEFAULT_USER_MSG_FG,
  DEFAULT_THINKING_BG,
  userMsgBgColor,
  userMsgFgColor,
  userMsgWhiteBgEnabled,
  userLineTextProps,
  thinkingLineBgColor,
  thinkingLineTextProps,
};
