'use strict';

/**
 * phonePairCodeReader.js — 从手机通知栏把配对码读回来。
 *
 * <h2>为什么需要它</h2>
 * 设备侧刻意不把配对码回传给 PC：`POST /pair/code` 的回执写得很直白——
 * 「码只显示在手机通知栏，不回传；这是刻意的——远端能要码，但看不到码」
 * （安卓侧 HttpBridge 的 /pair/code）。设计意图是「只有站在手机前的人才知道
 * 这个码」，用来挡住**能连到 8896 的网络侧攻击者**：任何进程都可以要码，但看到
 * 码需要有人看着手机屏幕。
 *
 * <h2>adb 读码为什么不削弱这道门</h2>
 * 因为能 adb 到这台手机的人，对这台手机已经拥有完全控制权：读 /sdcard、装应用、
 * pm grant 授权、跑 shell 都做得到。此时通知栏里的码不再增加任何防线——它挡住的是
 * 网络侧的攻击者，而 adb 权限比那高得多。所以这里的取码服务的是**运维方**
 * （已经握着设备控制权的那一方），不是给网络侧开后门。
 *
 * 真正的代价是另一件事：**原设计要求「站在手机前的人」在场**。这条自动取码路把
 * 那一步从流程里去掉了，于是「配对」不再是一个物理在场动作，而是一个技术动作。
 * 这是有意的取舍（凌晨三点的无人值守任务 otherwise 每天都卡在这一步），但它是
 * 取舍，不是「原来那套更安全」——原设计在「人在场」这一维上确实更强。
 *
 * <h2>边界</h2>
 *   * 没有 adb 就读不到：读不出来时如实说「没读到」，不猜码；
 *   * 只读 khy-os 自己那条通知：别的 App 也可能发「配对码 123456」，认错包会
 *     拿别人的码去换证书；
 *   * 取码与用码之间要快——设备侧每次签发都会替换掉上一个码（固定通知 id），
 *     所以读取必须发生在请求之后、使用之前；
 *   * 本模块只负责「拿到 6 位码」，私钥与证书全在 phoneBridgeCredential 里。
 */

const { BRIDGE_PACKAGE } = require('./phoneBridgePolicy');

/** 通知正文形如「配对码 030427（120 秒内有效，仅一次）。只在本人操作时填回 PC。」 */
const PAIR_CODE_PATTERN = /配对码\s*(\d{6})/;

/**
 * 从 `dumpsys notification --noredact` 的输出里挑出 khy-os 那条配对通知里的码。
 *
 * 纯函数：只认 khy-os 自己的通知块，避免别的 App 发的「配对码 123456」被当成
 * 我们的码（拿错码去 /pair 只会得到一次「不匹配」拒绝，但会浪费一个有效期
 * 120 秒的一次性码）。
 *
 * @param {string} dump dumpsys notification --noredact 的原文
 * @param {string} [pkg] 宿主包名
 * @returns {{ok: boolean, code?: string, whenMs?: number, error?: string}}
 */
function extractPairCode(dump, pkg = BRIDGE_PACKAGE) {
  const text = String(dump || '');
  if (!text.trim()) {
    return { ok: false, error: '通知 dump 是空的' };
  }
  // 通知记录以 "NotificationRecord(" 开头、缩进 4 空格；按它切块。
  const lines = text.split(/\r?\n/);
  let current = null;
  const blocks = [];
  for (const line of lines) {
    if (/^\s{4}NotificationRecord\(/.test(line)) {
      current = { header: line, body: [] };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  const mine = blocks.filter((b) => b.header.includes(`pkg=${pkg}`));
  if (mine.length === 0) {
    return { ok: false, error: `通知栏里没有 ${pkg} 的通知（码可能已被撤下，或手机通知被关了）` };
  }
  // 桥的配对通知用固定 id，重新签发会替换它而不是新增一条——所以正常只有一条。
  // 万一有多条，取最新那条（dump 里 when 最大的）。
  let best = null;
  for (const block of mine) {
    const body = block.body.join('\n');
    const m = body.match(PAIR_CODE_PATTERN) || block.header.match(PAIR_CODE_PATTERN);
    if (!m) {
      continue;
    }
    const whenMatch = body.match(/when=(\d{10,})/);
    const whenMs = whenMatch ? Number(whenMatch[1]) : 0;
    if (!best || whenMs > best.whenMs) {
      best = { code: m[1], whenMs };
    }
  }
  if (!best) {
    return { ok: false, error: `通知栏里有 ${pkg} 的通知，但里面没有配对码` };
  }
  return { ok: true, code: best.code, whenMs: best.whenMs };
}

/**
 * 用 adb 读一次通知栏并取出配对码。
 *
 * IO 叶子：`run` 由调用方注入（客户端传自己的 adb 传输），本模块不 spawn 任何
 * 东西，也不认识桥、不碰私钥。
 *
 * @param {object} options
 * @param {Function} options.run `(argv) => Promise<{ok, stdout, stderr}>` —— adb 传输
 * @param {string[]} options.argv 完整的 adb argv（必须带 -s <serial>）
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{ok: boolean, code?: string, whenMs?: number, error?: string}>}
 */
async function readPairCodeViaAdb(options = {}) {
  const run = options.run;
  if (typeof run !== 'function') {
    return { ok: false, error: '没有 adb 通道，读不到通知栏' };
  }
  const argv = Array.isArray(options.argv) ? options.argv : [];
  if (argv.length === 0) {
    return { ok: false, error: '缺少 adb argv' };
  }
  let res;
  try {
    res = await run(argv, options.timeoutMs);
  } catch (e) {
    return { ok: false, error: `读通知栏失败：${(e && e.message) || e}` };
  }
  if (!res || !res.ok) {
    return {
      ok: false,
      error: `读通知栏失败：${(res && (res.stderr || res.stdout || res.error)) || 'adb 没有回话'}`,
    };
  }
  return extractPairCode(res.stdout || '');
}

module.exports = {
  PAIR_CODE_PATTERN,
  extractPairCode,
  readPairCodeViaAdb,
};
