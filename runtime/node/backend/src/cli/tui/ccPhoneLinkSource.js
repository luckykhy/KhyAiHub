'use strict';

/**
 * ccPhoneLinkSource.js — CC 表面「手机联动」面板的供数器工厂（CC 模式专用）。
 *
 * 为什么单独一个文件而不是在 CcApp 里 new：模块装载期必须**零副作用**。这里只在
 * 第一次被调用时才 require amoo / phone 两棵栈（amoo/index.js 装载期不碰设备，
 * 但它的模块图不轻），并只 new 一次 provider。面板没打开过 ⇒ 这个文件被 require 过
 * 也没有任何 adb、没有任何定时器。
 *
 * provider 刻意**不做模块级单例**：门控 KHY_CC_TUI 未设时没有任何代码会 require 本文件；
 * 即使被 require 了，没有 getPhoneLinkProvider() 调用就没有 IO（构造器零副作用，
 * refresh() 才碰设备）。这一点由 tests/cli/tui/phoneLinkSource.test.js 的 spawn 陷阱断言。
 *
 * TTL 与轮询间隔同源：utils/ccTimers.js 的 TIMING.mcp.interval（5000ms，
 * 「后台低优先级轮询」档）。AGENTS.md §3.1 规定计时器常量唯一合法来源是 ccTimers，
 * 组件里硬编码 setInterval(…, 5000) 是明文禁止。
 */

const { TIMING } = require('./utils/ccTimers');

let _provider = null;
let _broken = false;

/**
 * 取（必要时建）手机联动状态供数器。
 * @param {object} [opts] 测试注入：{ amoo, phone }
 * @returns {{getSnapshot:Function, refresh:Function, invalidate:Function,
 *            setBusy:Function, onChange:Function, stats:Function}|null}
 *          不可用时返回 null（面板降级成「尚未读取手机状态」，绝不抛）
 */
function getPhoneLinkProvider(opts = {}) {
  if (_provider) {
    return _provider;
  }
  if (_broken) {
    return null;
  }
  try {
    const options = opts && typeof opts === 'object' ? opts : {};
    const amoo = options.amoo || require('../services/domain/network/amoo');
    const phone = options.phone || require('../services/domain/network/phone');
    if (!amoo || typeof amoo.AmooStatusProvider !== 'function') {
      _broken = true;
      return null;
    }
    // amoo/index.js 用 `...defaultStack` 展开导出 runner/client/config/mailbox，
    // 所以这里拿到的是与 CLI（khy amoo send）**同一个** runner —— 令牌缓存、
    // 桥连接、忙位全部共享，不会出现两套 adb 互相打。
    const runner = amoo.runner || null;
    const liveness = typeof phone.getPhoneBridgeClient === 'function'
      ? phone.getPhoneBridgeClient()
      : null;
    _provider = new amoo.AmooStatusProvider({
      runner,
      liveness,
      ttlMs: TIMING.mcp.interval,
    });
    return _provider;
  } catch {
    // fail-soft：面板少一块状态，绝不让 CC 模式启动失败。
    _broken = true;
    return null;
  }
}

/** 测试用：丢掉缓存的 provider。 */
function resetPhoneLinkProviderForTests() {
  _provider = null;
  _broken = false;
}

module.exports = {
  getPhoneLinkProvider,
  resetPhoneLinkProviderForTests,
  PHONE_LINK_INTERVAL_MS: TIMING.mcp.interval,
};
