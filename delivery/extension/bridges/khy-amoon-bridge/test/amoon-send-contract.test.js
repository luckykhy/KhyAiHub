'use strict';

/**
 * amoon-send-contract.test.js — 把「裁决后的 amoon 投递契约」钉成钉子。
 *
 * 背景（本轮裁决）：
 *   - `lib/contracts.js` 的 description 是**喂给模型**的契约，必须与实现的状态机
 *     一致。裁决结论：实现 `lib/bridge-tools.js:485` 是
 *     `state: pushed ? 'pushed' : intentSent ? 'sent' : 'queued'`，纯 intent 且
 *     am start 成功时给 'sent'；桌面端类型（apps/khyos-desktop/src/main/amoon/index.ts）
 *     就是这三态。所以改 description 去迁就旧措辞，而不是改状态机去迁就 description。
 *   - `verified:false`（bridge-tools.js:491）是承重的那条诚实字段：ack 之前不承诺送达。
 *
 * 因此本文件**两头都钉**，防止
 *   (a) 有人照旧 description 改实现（把 state 收窄成「ack 前最多 pushed」）；
 *   (b) 有人照实现把 description 再吹成「已送达」。
 *
 * 钉的条目：
 *   1. amoon_send 任何模式下 verified 恒为 false            （bridge-tools.js:491）
 *   2. state==='sent' 当且仅当 intent_sent===true 且文件未 push（:485）
 *   3. mode=intent 且 sendIntent 抛错（am start 超时 / transport 不可用）时
 *      抛 adb_unavailable 且 details.state='failed'          （:464-466）
 *      —— 注意这条是 catch 块里的收口；am start **非零退出**不走它，
 *      而是回落 state='queued' + intent_error（:459-461），本文件把两边都钉住。
 *   4. amoon_inbox 恒 unverified:true                        （:601/:611）
 *   5. description 与实现同口径，且旧措辞不得复活；scopes/side/inputSchema 不动
 *
 * 不碰真 adb、不碰网络：transport 是进程内假 adb（shell + push）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const { createBridgeTools } = require('../lib/bridge-tools');
const { loadConfig, ensureStateDirs } = require('../lib/config');

/** 桌面端 src/main/amoon/index.ts 认的三态；实现不得长出第四态。 */
const DESKTOP_STATES = ['pushed', 'sent', 'queued'];

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/**
 * 进程内假 adb。am start 的退出码 / 超时 / push 是否抛错都可逐用例切换。
 *
 * @param {{amStartExit?: number, amStartTimedOut?: boolean, amStartThrows?: string|null,
 *          pushThrows?: string|null, mkdirExit?: number, mvExit?: number}} [options]
 */
function fakeAdb(options = {}) {
  const state = {
    amStartExit: 0,
    amStartTimedOut: false,
    amStartThrows: null,
    pushThrows: null,
    mkdirExit: 0,
    mvExit: 0,
    ...options,
  };
  const calls = { shell: [], push: [] };
  return {
    state,
    calls,
    async shell(command) {
      calls.shell.push(command);
      if (/^mkdir -p /.test(command)) {
        return { exit: state.mkdirExit, stdout: '', stderr: state.mkdirExit ? 'mkdir failed' : '' };
      }
      if (/^mv -f /.test(command)) {
        return { exit: state.mvExit, stdout: '', stderr: state.mvExit ? 'mv failed' : '' };
      }
      if (/^am start/.test(command)) {
        if (state.amStartThrows) throw new Error(state.amStartThrows);
        if (state.amStartTimedOut) {
          return { exit: -1, stdout: '', stderr: '', timedOut: true };
        }
        return {
          exit: state.amStartExit,
          stdout: state.amStartExit === 0 ? 'Starting: Intent { }\nStatus: ok\n' : '',
          stderr: state.amStartExit === 0 ? '' : 'Error: Activity not started, unable to find ResolveInfo',
        };
      }
      return { exit: 0, stdout: '', stderr: '' };
    },
    async push(local, remote) {
      calls.push.push({ local, remote });
      if (state.pushThrows) throw new Error(state.pushThrows);
      return { bytes: 1 };
    },
  };
}

/**
 * 独立的 state 目录 + 假 adb + 真实 handlers。
 *
 * @param {object} t node:test context
 * @param {object} [adbOptions]
 * @param {object|null} [transport] 显式指定 transport；传 null 即「adb 未装配」
 */
function harness(t, adbOptions, transport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ stateDir: dir, env: { KHY_AMOON_HOME: dir } });
  ensureStateDirs(config);
  const adb = transport === undefined ? fakeAdb(adbOptions) : transport;
  const tools = createBridgeTools({ config, adb, logger: silentLogger() });
  return {
    config,
    adb,
    send: tools.handlers.amoon_send,
    inbox: tools.handlers.amoon_inbox,
  };
}

test('contracts: amoon_send description matches the implemented state machine', () => {
  const descriptor = C.getTool('amoon_send');
  const text = descriptor.description;

  // 新措辞：三句都在（意图只报启动成功 / sent 的语义 / verified 恒 false）。
  assert.match(text, /mode=intent 只报告 am start 启动成功/);
  assert.match(text, /state=sent 仅表示分享 intent 已发出/);
  assert.match(text, /任何模式下 verified 恒为 false/);
  assert.match(text, /ack 前不承诺送达/);

  // 旧措辞不得复活：它把状态说成「ack 前最多 pushed」，与实现相反。
  assert.ok(
    !text.includes('ack 前状态最多是 pushed'),
    '旧措辞「ack 前状态最多是 pushed」不得复活：实现会给 sent'
  );

  // 不得出现「已送达/保证送达」这类承诺。
  assert.ok(!/已送达|保证送达|确认送达/.test(text), 'description 不得承诺送达');

  // 裁决「不动」的部分也必须保持不动。
  assert.equal(descriptor.side, C.SIDES.AMOON);
  assert.deepEqual(descriptor.scopes, [C.SCOPES.OPERATOR]);
  assert.deepEqual(descriptor.inputSchema.required, ['text']);
  assert.deepEqual(descriptor.inputSchema.properties.mode.enum, ['file', 'intent', 'both']);
  assert.equal(descriptor.inputSchema.properties.mode.default, 'file');
});

test('amoon_send: verified is always false, in every mode and every outcome', async (t) => {
  // mode=file，push 成功。
  const fileOk = harness(t);
  const pushed = await fileOk.send({ text: 'hello', mode: 'file' });
  assert.equal(pushed.verified, false, 'mode=file 成功也不得宣称 verified');

  // mode=intent，am start 成功。
  const intentOk = harness(t);
  const intented = await intentOk.send({ text: 'hello', mode: 'intent' });
  assert.equal(intented.verified, false, 'mode=intent 成功也不得宣称 verified');

  // mode=both，两路都成功。
  const bothOk = harness(t);
  const both = await bothOk.send({ text: 'hello', mode: 'both' });
  assert.equal(both.verified, false);

  // mode=both，push 失败但 intent 成功（ degraded 路径）。
  const degraded = harness(t, { pushThrows: 'device offline' });
  const half = await degraded.send({ text: 'hello', mode: 'both' });
  assert.equal(half.verified, false, '降级路径同样不得宣称 verified');

  // mode=both，两路都失败 → queued。
  const allFail = harness(t, { pushThrows: 'device offline', amStartExit: 1 });
  const queued = await allFail.send({ text: 'hello', mode: 'both' });
  assert.equal(queued.verified, false, 'queued 也不得宣称 verified');
});

test("amoon_send: state==='sent' iff intent_sent===true and nothing was pushed", async (t) => {
  // intent 成功、未 push → sent。
  const intentOnly = harness(t);
  const sent = await intentOnly.send({ text: 'hi', mode: 'intent' });
  assert.equal(sent.state, 'sent');
  assert.equal(sent.intent_sent, true);
  assert.equal(sent.channel, 'intent');
  assert.equal(sent.remote_path, null, 'mode=intent 不得留下 remote_path');
  assert.equal(sent.local_path, null, 'mode=intent 不写本地 spool');
  assert.ok(intentOnly.adb.calls.push.length === 0, 'mode=intent 不得 push 文件');
  assert.ok(
    intentOnly.adb.calls.shell.some((cmd) => /^am start .*android\.intent\.action\.SEND/.test(cmd)),
    'mode=intent 必须走 am start 分享 intent'
  );

  // push 成功（intent 未参与）→ pushed，且 intent_sent 为 false。
  const fileOnly = harness(t);
  const pushed = await fileOnly.send({ text: 'hi', mode: 'file' });
  assert.equal(pushed.state, 'pushed');
  assert.equal(pushed.intent_sent, false);
  assert.ok(pushed.remote_path && pushed.remote_path.endsWith('.json'));

  // 两路都成功：文件已 push，**即使** intent_sent 也为 true，state 仍是 pushed。
  const both = harness(t);
  const bothResult = await both.send({ text: 'hi', mode: 'both' });
  assert.equal(bothResult.state, 'pushed', 'push 成功时 state 必须是 pushed，不能是 sent');
  assert.equal(bothResult.intent_sent, true);

  // push 失败 + intent 成功 → sent（这是 'sent' 的第二种来路）。
  const degraded = harness(t, { pushThrows: 'device offline' });
  const degradedResult = await degraded.send({ text: 'hi', mode: 'both' });
  assert.equal(degradedResult.state, 'sent');
  assert.equal(degradedResult.intent_sent, true);
  assert.equal(degradedResult.push_error, 'device offline');
  assert.equal(degradedResult.spool_retired, true, 'intent 已发出即视为 delivered，spool 退出重试集');

  // 两路都失败 → queued（第三态）。
  const allFail = harness(t, { pushThrows: 'device offline', amStartExit: 1 });
  const queued = await allFail.send({ text: 'hi', mode: 'both' });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.intent_sent, false);
  assert.ok(queued.push_error && queued.intent_error, 'queued 必须带上两路的失败原因');
  assert.equal(queued.spool_retired, false, '未送达的 spool 必须留在重试集里');
  assert.ok(fs.existsSync(queued.local_path), '未送达的信封不得被删');

  // 三态集合与桌面端类型一致：不得长出第四态。
  const observed = [sent.state, pushed.state, bothResult.state, degradedResult.state, queued.state];
  for (const value of observed) {
    assert.ok(DESKTOP_STATES.includes(value), `未预期的 state：${value}`);
  }
});

test('amoon_send: mode=intent throws adb_unavailable with state=failed only on the :464-466 path', async (t) => {
  // :462-466 是 catch 块里的收口：只有 sendIntent **抛错**才走到这里。
  // 两条真实来路：am start 超时（runAm 抛 timeout）、transport 缺失/不可用。

  // (a) am start 超时。
  const timedOut = harness(t, { amStartTimedOut: true });
  await assert.rejects(
    () => timedOut.send({ text: 'hi', mode: 'intent' }),
    (err) => {
      assert.ok(C.isBridgeError(err), '必须是 BridgeError');
      assert.equal(err.code, 'adb_unavailable');
      assert.equal(err.details.state, 'failed');
      assert.equal(typeof err.details.id, 'string');
      assert.match(err.message, /Intent 发送失败/);
      return true;
    }
  );
  assert.equal(timedOut.adb.calls.push.length, 0, '失败路径不得 push 任何文件');

  // (b) adb 未装配（无线调试掉线 / TCP 拒绝时的真实形态）。
  const noTransport = harness(t, {}, null);
  await assert.rejects(
    () => noTransport.send({ text: 'hi', mode: 'intent' }),
    (err) => {
      assert.equal(err.code, 'adb_unavailable');
      assert.equal(err.details.state, 'failed');
      return true;
    }
  );

  // (c) transport 自己抛错（spawn 失败等）。
  const throwing = harness(t, { amStartThrows: 'adb: device offline' });
  await assert.rejects(
    () => throwing.send({ text: 'hi', mode: 'intent' }),
    (err) => {
      assert.equal(err.code, 'adb_unavailable');
      assert.equal(err.details.state, 'failed');
      return true;
    }
  );

  // 边界一：am start **非零退出**不走 :464-466 —— sendIntent 返回 sent:false
  // （:459-461），mode=intent 时不抛，落到 state='queued' + intent_error。
  // 这条一并钉住：否则「失败即抛」会被误读成覆盖非零退出，改实现时把
  // 状态机的第三态悄悄抹掉。
  const nonZero = harness(t, { amStartExit: 1 });
  const nonZeroResult = await nonZero.send({ text: 'hi', mode: 'intent' });
  assert.equal(nonZeroResult.state, 'queued');
  assert.equal(nonZeroResult.intent_sent, false);
  assert.equal(nonZeroResult.verified, false);
  assert.match(nonZeroResult.intent_error, /Activity not started/);

  // 边界二：mode=both 时同样的 am start 失败**不抛**。文件已 push → 仍是 'pushed'
  // （文件确实进了 outbox，intent_error 只是附告，不得把已送达说成没送达）；
  // 文件也没 push 成功 → 'queued'。
  const both = harness(t, { amStartExit: 1 });
  const result = await both.send({ text: 'hi', mode: 'both' });
  assert.equal(result.state, 'pushed', '文件已进 outbox 就必须报 pushed，不因 intent 失败降级');
  assert.equal(result.intent_sent, false);
  assert.equal(result.verified, false);
  assert.equal(result.intent_error, 'Error: Activity not started, unable to find ResolveInfo');

  const bothNoFile = harness(t, { amStartExit: 1, pushThrows: 'device offline' });
  const degraded = await bothNoFile.send({ text: 'hi', mode: 'both' });
  assert.equal(degraded.state, 'queued');
  assert.equal(degraded.intent_sent, false);
  assert.equal(degraded.push_error, 'device offline');
  assert.equal(degraded.spool_retired, false, '两路都没成，spool 必须留在重试集里');

  // 边界三：mode=file 的 push 失败抛 adb_unavailable，但 state 是 queued（信封还在）。
  const fileFail = harness(t, { pushThrows: 'device offline' });
  await assert.rejects(
    () => fileFail.send({ text: 'hi', mode: 'file' }),
    (err) => {
      assert.equal(err.code, 'adb_unavailable');
      assert.equal(err.details.state, 'queued');
      assert.ok(fs.existsSync(err.details.local_path), '失败时必须留下本地 spool 供 flush 重发');
      return true;
    }
  );
});

test('amoon_inbox: unverified is always true, even for a file that claims otherwise', async (t) => {
  const h = harness(t);
  const replies = h.config.paths.dirs.replies;

  // 一个**自称** unverified:false 的回复文件：桥不得采信。
  fs.writeFileSync(
    path.join(replies, 'reply_liar.json'),
    `${JSON.stringify({ v: 1, id: 'msg00001', kind: 'reply', text: 'pwn', ts: new Date().toISOString(), unverified: false })}\n`
  );
  fs.writeFileSync(
    path.join(replies, 'ack_00002.json'),
    `${JSON.stringify({ v: 1, id: 'msg00002', kind: 'ack', ts: new Date().toISOString() })}\n`
  );
  // 一个坏文件：被跳过，但不影响其余条目的判定。
  fs.writeFileSync(path.join(replies, 'broken.json'), '{ not json');

  const result = await h.inbox({ limit: 20 });
  assert.equal(result.unverified, true, '返回值顶层 unverified 恒为 true');
  assert.equal(result.total, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.messages.length, 2);
  for (const message of result.messages) {
    assert.equal(message.unverified, true, '每条消息的 unverified 恒为 true，与文件自述无关');
  }
  assert.equal(
    result.messages.find((m) => m.id === 'msg00001').unverified,
    true,
    '自称 unverified:false 的文件不得降低判定'
  );

  // 空目录：没有消息，判定不变。
  const empty = harness(t);
  const none = await empty.inbox({});
  assert.deepEqual(none.messages, []);
  assert.equal(none.unverified, true);
  assert.equal(none.total, 0);
});
