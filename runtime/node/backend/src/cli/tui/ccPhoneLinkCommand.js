'use strict';

/**
 * ccPhoneLinkCommand.js — CC 表面跑 `khy phone` / `khy amoo` 的收集式命令桥。
 *
 * 为什么 CC 模式需要它：CC 根组件（CcApp）与 Legacy（ink-components/App.js）是两棵
 * **互斥**的树，Legacy 的 `runRouted → _runRoutedCaptured → commandOutputSink` 通路
 * 在 CC 模式下一个字节都不执行。而 `khy phone status` / `khy amoo status` 的输出恰恰
 * 只在 Legacy 侧被收成 notice。本文件把同一条既有范式（sink 收编 console + 直接
 * stdout 写 → 跑完拆行落成一条 notice）搬到 CC 侧，**不新写收集逻辑**：
 * commandOutputSink.createSink() 与 router.parseInput/route 都是现成出口。
 *
 * 三条边界：
 *   ① **只放行 phone / amoo**。CcApp 头注明确写着「完整 CC 复刻需要产品判断，
 *      未获授权裁决 ⇒ 保持预览」，所以本桥不接其它命令：它们照旧走回声桩。
 *      判据是纯函数 isPhoneLinkCommand，不 require router。
 *   ② **绝不抛**。任何一步失败都返回 null，调用方逐字节回退到既有回声桩。
 *   ③ **ink 帧必须透传**。sink 自己带 runInkWrite 闸（app.js 的 stdout Proxy 在
 *      代写期间置位），本文件不需要额外处理。
 */

// 与 router.js:745-794 的归一同族：行首 `khy`/`khyquant` token 被 shift，`/` 前缀被剥。
const HEAD_PREFIX_RE = /^\s*(?:\/|(?:khy|khyquant)\s+)/i;
const ALLOWED = Object.freeze(['phone', 'amoo']);

function _str(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * 这一行是不是「手机联动」命令。纯函数：不 require router（那棵模块图不轻），
 * 也不碰进程状态，所以门控关闭时把它 require 进来也是零成本。
 * @param {unknown} text
 * @returns {boolean}
 */
function isPhoneLinkCommand(text) {
  const line = _str(text).trim();
  if (!line) {
    return false;
  }
  const stripped = line.replace(HEAD_PREFIX_RE, '').trim();
  const head = stripped.split(/\s+/)[0] || '';
  return ALLOWED.includes(head.toLowerCase());
}

/**
 * 跑一条手机联动命令并把输出收成一段文本。
 * @param {unknown} text 用户原样输入（`khy phone status` / `/amoo status` / `phone tools`）
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<{content:string}|null>} 无输出 / 不放行 / 失败一律 null
 */
async function runPhoneLinkCommand(text, opts = {}) {
  try {
    if (!isPhoneLinkCommand(text)) {
      return null;
    }
    const env = (opts && opts.env) || process.env;
    const sink = require('./commandOutputSink');
    if (!sink.captureEnabled(env)) {
      // 门控关：不回落到「让出终端」——CC 表面没有那条路。宁可不接，也不假执行。
      return null;
    }
    const { parseInput, route } = require('../router');
    const parsed = parseInput(_str(text));
    if (!parsed || !ALLOWED.includes(String(parsed.command || '').toLowerCase())) {
      return null;
    }
    const collector = sink.createSink();
    let content = '';
    try {
      await route(parsed, {});
    } finally {
      collector.restore();
      content = collector.text();
    }
    if (!content || !content.trim()) {
      return null;
    }
    return { content };
  } catch {
    return null;
  }
}

module.exports = {
  isPhoneLinkCommand,
  runPhoneLinkCommand,
  PHONE_LINK_COMMANDS: ALLOWED,
};
