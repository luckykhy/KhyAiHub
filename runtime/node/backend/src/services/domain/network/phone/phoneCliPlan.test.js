'use strict';

/**
 * phoneCliPlan.test.js — co-located suite for the `khy phone` parse/render leaf.
 *
 * IO: none. Every case feeds plain tokens/options and asserts on strings, so the
 * command line can be judged wrong without a phone attached. The confirm gate and
 * the UI-tool refusal are pinned here because they are the two places where a
 * regression would turn an honest refusal into a silent actuation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./phoneCliPlan');

test('空参数落到 status，不带 confirm', () => {
  const parsed = leaf.parsePhoneArgv([], {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'status');
  assert.equal(parsed.confirm, false);
  assert.equal(parsed.channel, 'http');
});

test('子命令大小写不敏感，其余参数原样保留', () => {
  const parsed = leaf.parsePhoneArgv(['CALL', 'exec', '{"cmd":"id"}'], {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'call');
  assert.equal(parsed.tool, 'exec');
  assert.deepEqual(parsed.args, { cmd: 'id' });
});

test('未知子命令被拒，并列出可用子命令', () => {
  const parsed = leaf.parsePhoneArgv(['fly'], {});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'unknown_action');
  assert.match(parsed.error, /status/);
});

test('只读子命令不接受多余参数', () => {
  const parsed = leaf.parsePhoneArgv(['ping', 'extra'], {});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'unexpected_args');
});

test('call 缺工具名时报错并指路 tools', () => {
  const parsed = leaf.parsePhoneArgv(['call'], {});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'tool_missing');
  assert.match(parsed.error, /khy phone tools/);
});

test('call 的参数必须是 JSON 对象', () => {
  const notJson = leaf.parsePhoneArgv(['call', 'ls', '/sdcard'], {});
  assert.equal(notJson.ok, false);
  assert.equal(notJson.code, 'args_not_json');

  const notObject = leaf.parsePhoneArgv(['call', 'ls', '["/sdcard"]'], {});
  assert.equal(notObject.ok, false);
  assert.equal(notObject.code, 'args_not_object');
});

test('通道只认 http / mailbox，别的值明确拒绝', () => {
  assert.equal(leaf.parsePhoneArgv([], { channel: 'MAILBOX' }).channel, 'mailbox');
  assert.equal(leaf.parsePhoneArgv([], { channel: 'http' }).channel, 'http');
  const bad = leaf.parsePhoneArgv([], { channel: 'carrier-pigeon' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unknown_channel');
});

test('--confirm 只在显式给出时为真', () => {
  assert.equal(leaf.parsePhoneArgv(['call', 'toast'], {}).confirm, false);
  assert.equal(leaf.parsePhoneArgv(['call', 'toast'], { confirm: true }).confirm, true);
  // 字符串 'true' 不算：router 对 --confirm 给的是布尔真值，别的地方给的都当没给。
  assert.equal(leaf.parsePhoneArgv(['call', 'toast'], { confirm: 'true' }).confirm, false);
});

test('状态渲染带上配置里的序列号与信箱目录', () => {
  const text = leaf.renderStatusText({
    config: {
      serial: '192.168.2.46:33743',
      baseUrl: 'http://127.0.0.1:8896',
      mailboxDir: '/sdcard/bridge-amoobridge',
    },
    status: { mode: 'lite', tools: 22 },
    state: { totalCalls: 3, lastChannel: 'http' },
    tokenReady: true,
  });
  assert.match(text, /192\.168\.2\.46:33743/);
  assert.match(text, /lite/);
  assert.match(text, /22/);
  // 令牌只报「已读取」，不回显
  assert.match(text, /已从设备读取/);
  assert.doesNotMatch(text, /[0-9a-f]{32}/);
});

test('授权清单渲染出可复制的 adb 命令与 lite 不适用项', () => {
  const text = leaf.renderSetupText({
    serial: 'SERIAL',
    grants: [
      {
        id: 'manage_external_storage',
        label: '所有文件访问',
        required: true,
        applicableToLiteBuild: true,
        argv: ['appops', 'set', 'com.khyos.khy_os_client', 'MANAGE_EXTERNAL_STORAGE', 'allow'],
        verifyArgv: ['appops', 'get', 'com.khyos.khy_os_client', 'MANAGE_EXTERNAL_STORAGE'],
        expectIncludes: 'allow',
        why: '不授权信箱目录不可写',
      },
      {
        id: 'accessibility_service',
        label: '无障碍服务',
        required: false,
        applicableToLiteBuild: false,
        argv: ['settings', 'put', 'secure', 'enabled_accessibility_services', 'x'],
        verifyArgv: ['settings', 'get', 'secure', 'enabled_accessibility_services'],
        expectIncludes: 'x',
        why: 'lite 构建没有声明无障碍服务',
      },
    ],
  });
  assert.match(text, /adb -s SERIAL shell appops set com.khyos.khy_os_client MANAGE_EXTERNAL_STORAGE allow/);
  assert.match(text, /lite 构建不适用/);
  assert.match(text, /必填/);
  assert.match(text, /可选/);
});

test('计划渲染不隐瞒危险工具告警', () => {
  const text = leaf.renderCallPlanText({
    plan: { bridgeName: 'rm', endpoint: 'http://127.0.0.1:8896/call', args: { path: '/sdcard/x' }, tier: 'critical', access: 'actuate' },
    message: '将在手机上执行 rm。',
    warning: 'rm 的 recursive 参数默认为 true',
  });
  assert.match(text, /rm/);
  assert.match(text, /critical/);
  assert.match(text, /recursive/);
});

test('结果回显会打掉桥返回体里的令牌原文', () => {
  const secret = 'a'.repeat(32);
  const text = leaf.renderCallResultText({
    tool: 'exec',
    channel: 'http',
    body: { success: true, tool: 'exec', out: `token=${secret}`, exit: 0 },
  });
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /redacted-token/);
  assert.match(text, /exec/);
  // success 是给调用方的判据，不回显
  assert.doesNotMatch(text, /"success"/);
});

test('空返回体明确说没有内容', () => {
  const text = leaf.renderCallResultText({ tool: 'ping', channel: 'http', body: {} });
  assert.match(text, /无返回体/);
  assert.match(text, /ping/);
});

test('帮助文本说明 UI 工具依赖手机无障碍服务的边界', () => {
  const help = leaf.renderPhoneHelp();
  assert.match(help, /--confirm/);
  assert.match(help, /ui_dump/);
  assert.match(help, /无障碍/);
});
