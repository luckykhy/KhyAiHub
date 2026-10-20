'use strict';

/**
 * 微信内「绑定码自助发放」离线单测(node:test)。
 *
 * 这个套件钉的是一条**能力层面**的结论：绑定码**默认不在微信里发**。
 *
 * 为什么是「不做这能力」而不是「给它加一道门」：
 *   - `khy wx qr --send-to` 不成立 —— wx.js 的 login/qr/scan/扫描 都落到 `_handleLogin()`，
 *     CLI handler 里既没有 dispatcher 实例（`this.channel`），也没有 msg；
 *   - 目标校验所需的 accountId→userId 反查全仓不存在（`_resolveAccountId` 只解 accountId）；
 *   - 所以做不到「只发给本人」——那就干脆默认不提供这条路径。
 *
 * 另外钉住两条不得回退的性质：
 *   1. 图片发不出去时**不得降级发链接**（那只是把 qr.qrcodeUrl 换个形式外发）；
 *   2. 显式打开后，发送对象必须**在允许名单里**（不能用观察期档位的 allowMode）。
 *
 * 全部离线：假 login / 假 allowlist / 假通道，不触网络、不落真实配置。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkqr-'));
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
// 本文件用到的 peer 是 uA。这一行是**给默认严格档兜底**的，不是靠「未列名即放行」的
// 运气 —— 删掉它，未列名者会被直接拒答，整组用例会红一片。见 ilinkAllowlist.test.js。
process.env.KHY_ILINK_ALLOWED_PEERS = 'uA';
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '5000';
// 注意：**不设** KHY_ILINK_QR_SELF_SERVE —— 默认档必须是关。
// serviceDefaults 在模块加载时求值，所以「=1 的那一半」在用例里直接改
// defaults.ILINK_QR_SELF_SERVE（它不是 frozen 的导出对象），finally 里还原。

const defaults = require('../../../src/constants/serviceDefaults');
const login = require('../../../src/services/domain/messaging/messaging/ilinkLogin.js');
const allowlist = require('../../../src/services/domain/messaging/messaging/ilinkPeerAllowlist.js');
const { IlinkDispatcher, isBindQrIntent } =
  require('../../../src/services/domain/messaging/channels/ilinkDispatcher.js');



/** 假通道：出站按顺序记进 calls（图片用 image: 前缀，好与文本区分）。 */
function fakeChannel() {
  const calls = [];
  return {
    calls,
    async sendReply(_c, _t, x) { calls.push(`text:${x}`); return { ok: true, sent: 1 }; },
    async sendFile(_c, _b, meta) { calls.push(`file:${meta.fileName}`); return { ok: true }; },
    async sendImage(_c, _b, meta) { calls.push(`image:${meta.fileName}`); return { ok: true }; },
    async setTyping() { return true; },
    toJSON() { return { connected: true, accountId: 'botA', failures: 0 }; },
  };
}

function mkDispatcher(opts = {}) {
  const channel = opts.channel || fakeChannel();
  const d = new IlinkDispatcher({
    channel,
    accountId: 'botA',
    getChat: () => async () => opts.reply || 'ok',
  });
  return { d, channel };
}

const msg = (userId, text) => ({ userId, channelId: userId, threadId: '', text });

/**
 * 装一个假的 login 模块面，记录 requestQrCode / renderQrToDataUrl 的调用。返回 restore。
 * @param {{qrOk?:boolean, imageOk?:boolean}} [opts]
 */
function stubLogin(opts = {}) {
  const calls = { request: 0, render: 0 };
  const origReq = login.requestQrCode;
  const origRender = login.renderQrToDataUrl;
  login.requestQrCode = async () => {
    calls.request += 1;
    return opts.qrOk === false
      ? { ok: false, error: '取二维码失败' }
      : { ok: true, qrcodeId: 'Q1', qrcodeUrl: 'https://example.invalid/qr/abcdef' };
  };
  login.renderQrToDataUrl = async (url) => {
    calls.render += 1;
    const body = Buffer.from('fake-png-bytes').toString('base64');
    return `data:image/png;base64,${body}`;
  };
  return {
    calls,
    restore() { login.requestQrCode = origReq; login.renderQrToDataUrl = origRender; },
  };
}

/** 临时覆盖 ILINK_QR_SELF_SERVE，返回 restore。 */
function setQrSelfServe(value) {
  const prev = defaults.ILINK_QR_SELF_SERVE;
  defaults.ILINK_QR_SELF_SERVE = value;
  return () => { defaults.ILINK_QR_SELF_SERVE = prev; };
}

// ── 默认档:关 ──────────────────────────────────────────────────────────────

test('默认档:ILINK_QR_SELF_SERVE 为 false(未设 env 即关)', () => {
  assert.strictEqual(defaults.ILINK_QR_SELF_SERVE, false, '默认必须是关 —— 安全方向只有一边');
});

test('默认档:任意「发我二维码」文本 —— 零次申请,回复指向 khy wx login', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  try {
    for (const text of ['发我二维码', '把二维码发给我', '二维码给我', '发个绑定码']) {
      channel.calls.length = 0;
      await d._sendBindQrCode(msg('uA', text));
      assert.strictEqual(fake.calls.request, 0, `${text} 不得触发二维码申请`);
      const said = channel.calls.join('\n');
      assert.match(said, /khy wx login/, `${text} 的回复必须指向终端登录,实际:${said}`);
      assert.ok(!said.includes('example.invalid'), `${text} 的回复不得回显任何码/链接:${said}`);
    }
  } finally {
    fake.restore();
  }
});

test('默认档:/qr —— 零次申请,不渲染不外发', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  try {
    const out = await d._slashResult(msg('uA', ''), { cmd: 'qr', args: '' });
    assert.strictEqual(fake.calls.request, 0, '/qr 不得触发二维码申请');
    assert.strictEqual(fake.calls.render, 0);
    const said = `${out}\n${channel.calls.join('\n')}`;
    assert.match(said, /khy wx login/);
    assert.ok(
      !channel.calls.some((c) => c.startsWith('image:')),
      `不得发图:${JSON.stringify(channel.calls)}`
    );
  } finally {
    fake.restore();
  }
});

test('默认档:handle() 走自然语言「发我二维码」也不发码(原直达分支已删)', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  try {
    await d.handle(msg('uA', '发我二维码'));
    assert.strictEqual(fake.calls.request, 0, '自然语言不得构成发码入口');
    assert.ok(
      !channel.calls.some((c) => c.startsWith('image:')),
      `不得发图:${JSON.stringify(channel.calls)}`
    );
  } finally {
    fake.restore();
  }
});

// ── 显式打开:仍然要过允许名单,且不降级发链接 ────────────────────────────────

test('opt-in=1 且发送者在允许名单里 —— 走发图', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  const restore = setQrSelfServe(true);
  try {
    await d._sendBindQrCode(msg('uA', '/qr'));
    assert.strictEqual(fake.calls.request, 1, 'opt-in 后应真的申请二维码');
    assert.ok(
      channel.calls.some((c) => c.startsWith('image:')),
      `应发图:${JSON.stringify(channel.calls)}`
    );
  } finally {
    restore();
    fake.restore();
  }
});

test('opt-in=1 但发送者不在允许名单 —— 零次申请(不能用观察期档位放行)', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  const restore = setQrSelfServe(true);
  try {
    await d._sendBindQrCode(msg('陌生人', '/qr'));
    assert.strictEqual(fake.calls.request, 0, '未列名者不得拿到绑定码');
    const said = channel.calls.join('\n');
    assert.match(said, /khy wx allow add/, `应告诉对方怎么放行,实际:${said}`);
  } finally {
    restore();
    fake.restore();
  }
});

test('opt-in=1 但申请失败 —— 如实失败,零次外发', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin({ qrOk: false });
  const restore = setQrSelfServe(true);
  try {
    await d._sendBindQrCode(msg('uA', '/qr'));
    assert.strictEqual(fake.calls.request, 1);
    assert.ok(
      !channel.calls.some((c) => c.startsWith('image:')),
      '申请失败不得外发任何东西'
    );
    assert.match(channel.calls.join('\n'), /申请绑定二维码失败/);
  } finally {
    restore();
    fake.restore();
  }
});

test('opt-in=1 且发图失败 —— 绝不降级发 qrcodeUrl 链接', async () => {
  const channel = fakeChannel();
  channel.sendImage = async () => ({ ok: false, error: 'CDN 拒绝' });
  const { d } = mkDispatcher({ channel });
  const fake = stubLogin();
  const restore = setQrSelfServe(true);
  try {
    await d._sendBindQrCode(msg('uA', '/qr'));
    const said = channel.calls.join('\n');
    assert.ok(
      !said.includes('example.invalid'),
      `图片发不出去时不得把码链接换个形式外发:${said}`
    );
    assert.match(said, /图片发送失败/);
    assert.match(said, /khy wx login/);
  } finally {
    restore();
    fake.restore();
  }
});

// ── 诊断面 ──────────────────────────────────────────────────────────────────

test('isBindQrIntent 仍是纯诊断函数:识别仍准,但已不接发送路径', () => {
  assert.strictEqual(typeof isBindQrIntent, 'function', '导出面不能删（有外部消费者）');
  assert.strictEqual(isBindQrIntent('发我二维码'), true);
  assert.strictEqual(isBindQrIntent('今天天气怎么样'), false);
});

// ── 系统提示不得说谎 ────────────────────────────────────────────────────────

test('身份系统提示不得宣称「支持在微信里直接发送绑定二维码」', async () => {
  // 文案与开关脱节就是对外说谎：关掉之后那句就是对用户的假承诺。
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/services/domain/messaging/channels/ilinkDispatcher.js'),
    'utf8'
  );
  assert.ok(
    !/支持在微信里直接发送/.test(src),
    '系统提示里不得保留「微信里可直接发绑定码」的宣称'
  );
  assert.match(src, /绑定码只在用户自己的/, '系统提示应改为「只在终端申请」的事实');
});

test('默认档:_sendBindQrCode 连 login 模块都不碰(零触网)', async () => {
  const { d, channel } = mkDispatcher();
  const fake = stubLogin();
  try {
    await d._sendBindQrCode(msg('uA', '/qr'));
    assert.strictEqual(fake.calls.request, 0, '默认档下不应走到申请那一步');
    assert.strictEqual(fake.calls.render, 0);
    assert.ok(
      !channel.calls.some((c) => c.startsWith('image:')),
      '默认档下无论如何不该发图'
    );
  } finally {
    fake.restore();
  }
});
