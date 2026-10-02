/**
 * mcpStdioServer.test.js — 钉死 stdio 传输的 stdout 红线与行循环语义。
 *
 * 为什么这支套件必须存在：Claude Desktop/CC 把 stdout 当纯 JSON-RPC 流——任何
 * 杂质（横幅/日志）都会破坏协议。这个薄 IO 层承诺：①哨兵 env.KHY_MCP_SERVE_STDIO='1'；
 * ②横幅与诊断全部走 errOutput；③空行忽略、单条坏消息不杀循环、rl close 报关闭。
 * 通过注入三条流可完全离线驱动（不起真 stdin）。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. startStdioServer 会把 KHY_MCP_SERVE_STDIO='1' 写进它拿到的 env 对象——
 *    opts.env 缺省时就是 process.env 本体（进程级状态泄漏，实测钉住）。
 * 2. startStdioServer 不转发 opts.registry 给 createServerCore：即便调用方传
 *    registry 也永远加载真工具注册表 — 偏差注册（横幅数字来自真 registry）。
 * 3. resp 为 null（通知/无回包）时 stdout 一个字节都不写；坏 JSON 行则写 -32700 回包。
 * 4. close() 只关 readline 接口；'closed' 提示出现在 errOutput 而非 stdout。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { startStdioServer } = require('./mcpStdioServer');

function mkStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const err = new PassThrough();
  const outBuf = [];
  const errBuf = [];
  output.on('data', (c) => outBuf.push(String(c)));
  err.on('data', (c) => errBuf.push(String(c)));
  return { input, output, err, outBuf, errBuf, outText: () => outBuf.join(''), errText: () => errBuf.join('') };
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('stdioServer: 导出面唯一', () => {
  assert.deepStrictEqual(Object.keys(require('./mcpStdioServer')), ['startStdioServer']);
});

test('stdioServer: 哨兵写进注入 env 对象（进程 env 不受染指当且仅当显式传 env）', () => {
  const s = mkStreams();
  const env = {};
  const h = startStdioServer({ env, input: s.input, output: s.output, errOutput: s.err });
  assert.equal(env.KHY_MCP_SERVE_STDIO, '1');
  assert.equal(typeof process.env.KHY_MCP_SERVE_STDIO, 'undefined');
  assert.equal(typeof h.close, 'function');
  assert.equal(typeof h.core.handleMessage, 'function');
  assert.ok(h.rl);
  h.close();
  s.input.destroy();
});

test('stdioServer: 横幅在 stderr、stdout 全净；ping 往返一行 JSON', async () => {
  const s = mkStreams();
  const env = {};
  const h = startStdioServer({ env, input: s.input, output: s.output, errOutput: s.err, version: 'stdio-test' });
  // 横幅格式实测钉住（工具数来自真 registry——本模块不转发假 registry，偏差注册）
  await waitFor(() => s.errText().length > 0);
  assert.match(s.errText(), /^khy MCP server \(stdio\) ready — 暴露 \d+ 个工具\(含破坏性: (yes|no)\)\n/);
  assert.equal(s.outText(), ''); // stdout 零字节红线
  s.input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  assert.ok(await waitFor(() => s.outText().includes('\n')), 'ping 回包超时');
  const lines = s.outText().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  h.close();
  s.input.destroy();
});

test('stdioServer: 空行忽略、通知零回包、坏 JSON 回 -32700 不杀循环', async () => {
  const s = mkStreams();
  const h = startStdioServer({ env: {}, input: s.input, output: s.output, errOutput: s.err });
  s.input.write('\n   \n');                      // 空/空白行 → 无输出
  s.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); // 通知 → 无输出
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.outText(), '');
  s.input.write('}{oops\n');                      // 坏行 → -32700 回包
  assert.ok(await waitFor(() => s.outText().includes('-32700')));
  const resp = JSON.parse(s.outText().split('\n').filter(Boolean)[0]);
  assert.equal(resp.error.code, -32700);
  assert.equal(resp.id, null);
  // 循环存活：坏行之后再发 ping 仍有回包
  s.input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  assert.ok(await waitFor(() => (s.outText().match(/\n/g) || []).length >= 2), '循环存活：坏行后 ping 仍应有回包');
  h.close();
  assert.ok(await waitFor(() => s.errText().includes('khy MCP server (stdio) closed\n')));
  s.input.destroy();
});

test('stdioServer: initialize 经真链路返回 serverInfo（注入 version）', async () => {
  const s = mkStreams();
  const h = startStdioServer({ env: {}, version: '9.9.9-stdio', input: s.input, output: s.output, errOutput: s.err });
  s.input.write('{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n');
  assert.ok(await waitFor(() => s.outText().includes('serverInfo')));
  const resp = JSON.parse(s.outText().split('\n').filter(Boolean).pop());
  assert.equal(resp.result.protocolVersion, '2025-03-26');
  assert.equal(resp.result.serverInfo.version, '9.9.9-stdio');
  h.close();
  s.input.destroy();
});
