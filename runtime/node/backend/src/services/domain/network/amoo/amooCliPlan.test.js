'use strict';

/**
 * amooCliPlan.test.js — co-located suite for the `khy amoo` parse/render leaf.
 *
 * IO: none. The dispatch plan text is produced by amooDispatchPlan (already
 * covered there); what is pinned here is the command-line contract: the default
 * action, that a task text is mandatory for plan/send, that the client
 * passthrough rebuilds flags, and that a reply is rendered verbatim.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./amooCliPlan');

test('空参数落到 status', () => {
  const parsed = leaf.parseAmooArgv([], {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'status');
  assert.equal(parsed.confirm, false);
});

test('plan / send 都必须要任务文本', () => {
  for (const action of ['plan', 'send']) {
    const empty = leaf.parseAmooArgv([action], {});
    assert.equal(empty.ok, false, `${action} 不该接受空任务`);
    assert.equal(empty.code, 'task_empty');

    const spaced = leaf.parseAmooArgv([action, '   '], {});
    assert.equal(spaced.ok, false);

    const ok = leaf.parseAmooArgv([action, '帮我看一下电量'], {});
    assert.equal(ok.ok, true);
    assert.equal(ok.taskText, '帮我看一下电量');
  }
});

test('多段任务文本按空格拼回一句', () => {
  const parsed = leaf.parseAmooArgv(['send', '把今晚', '的复盘', '写到备忘录'], {});
  assert.equal(parsed.taskText, '把今晚 的复盘 写到备忘录');
});

test('未知子命令被拒并列出可用子命令', () => {
  const parsed = leaf.parseAmooArgv(['teleport'], {});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'unknown_action');
  assert.match(parsed.error, /status/);
});

test('只读子命令不接受多余参数', () => {
  const parsed = leaf.parseAmooArgv(['status', 'now'], {});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'unexpected_args');
});

test('client 子命令把位置参数与选项原样转交', () => {
  const parsed = leaf.parseAmooArgv(['client', 'send', '你好'], { json: true, rounds: 3 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'client');
  assert.deepEqual(parsed.clientArgv, ['send', '你好', '--json', '--rounds=3']);
});

test('client help 换算成客户端认识的 --help（bin 的快速路径会吞掉 --help）', () => {
  assert.deepEqual(leaf.parseAmooArgv(['client', 'help'], {}).clientArgv, ['--help']);
  assert.deepEqual(leaf.parseAmooArgv(['client', '-h'], {}).clientArgv, ['--help']);
  // 首段不是 help 时不动它
  assert.deepEqual(leaf.parseAmooArgv(['client', 'task', 'abc'], {}).clientArgv, ['task', 'abc']);
});

test('选项还原跳过 false 与空值', () => {
  assert.deepEqual(leaf.optionsToArgv({ json: true, wait: false, key: undefined, base: 'http://x' }), [
    '--json',
    '--base=http://x',
  ]);
  assert.deepEqual(leaf.optionsToArgv(null), []);
});

test('--confirm 只在显式给出时为真', () => {
  assert.equal(leaf.parseAmooArgv(['send', 'x'], {}).confirm, false);
  assert.equal(leaf.parseAmooArgv(['send', 'x'], { confirm: true }).confirm, true);
});

test('状态渲染覆盖 adb / 设备 / 转发 / 桥 / 令牌', () => {
  const text = leaf.renderStatusText({
    ok: false,
    adb: { resolved: true, source: 'env' },
    device: { connected: true, serial: '192.168.2.46:33743' },
    forwards: { ok: true, ports: ['tcp:8896', 'tcp:8898'] },
    bridge: { online: true, port: 8896, transport: 'forward', token: '5500…8d30' },
    screen: { summary: '51 节点，输入框可见' },
  });
  assert.match(text, /env/);
  assert.match(text, /192\.168\.2\.46:33743/);
  assert.match(text, /tcp:8896 \+ tcp:8898/);
  assert.match(text, /8896/);
  // 令牌只以掩码形态出现
  assert.match(text, /5500…8d30/);
  assert.doesNotMatch(text, /[0-9a-f]{32}/);
});

test('桥不在线时渲染出原因，而不是光秃秃一句不在线', () => {
  // collectStatus 的实测形态：ping 超时，detail 是 bridge_request_timeout。
  // 渲染丢掉它，排查时就只能猜。
  const text = leaf.renderStatusText({
    adb: { resolved: true, source: 'env' },
    device: { connected: true, serial: '192.168.2.46:33743' },
    forwards: { ok: true, ports: ['tcp:8896'] },
    bridge: {
      online: false,
      detail: 'bridge_request_timeout',
      port: 8896,
      transport: 'forward',
      token: null,
      tokenDetail: '不可用：读取超时',
    },
    screen: null,
  });
  assert.match(text, /不在线（bridge_request_timeout）/);
});

test('下发结果渲染答复原文与计划', () => {
  const text = leaf.renderDispatchResultText({
    ok: true,
    message: '已收到 Amoo 答复（12 字）。',
    reply: { text: '电量 71%，未充电。', truncated: false },
    planText: '下发通道：HTTP（经 adb forward）',
  });
  assert.match(text, /已收到 Amoo 答复/);
  assert.match(text, /电量 71%，未充电。/);
  assert.match(text, /下发通道：HTTP/);
});

test('答复被截断时明确标注', () => {
  const text = leaf.renderDispatchResultText({
    ok: true,
    reply: { text: '前半段', truncated: true, originalChars: 40000 },
  });
  assert.match(text, /已截断，原文 40000 字/);
});

test('没有答复时不渲染空的答复段', () => {
  const text = leaf.renderDispatchResultText({ ok: false, message: '未拿到完整答复', code: 'reply_incomplete' });
  assert.match(text, /未拿到完整答复/);
  assert.doesNotMatch(text, /Amoo 答复/);
});

test('帮助文本写明两条方向与不能无人值守的边界', () => {
  const help = leaf.renderAmooHelp();
  assert.match(help, /--confirm/);
  assert.match(help, /client/);
  assert.match(help, /无人值守/);
});
