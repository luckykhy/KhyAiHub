'use strict';

/**
 * amooPanelViewModel.test.js — co-located suite for the Amoo panel view model.
 *
 * IO: none. Every case feeds a snapshot shape (the real collectStatus() output
 * shape, captured live) into the pure leaf and asserts the rows a 30-column
 * panel would draw. What is pinned here is the honesty of the mapping:
 *   - "not measured" is never drawn as a measurement (screen null ≠ 0 chars,
 *     tools null ≠ 0 tools),
 *   - the earliest broken link decides the headline tone, so the red sits at the
 *     root of the chain and not at the symptom,
 *   - the multi-line `adb forward --list` detail never reaches a row value,
 *   - stop reasons keep the single Chinese mapping shared with the runner,
 *   - garbage input degrades to idle rows instead of throwing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./amooPanelViewModel');
const { describeStopReason } = require('./amooDispatchPlan');

const SERIAL = '192.168.2.46:33743';

function happyStatus(overrides = {}) {
  const base = {
    ok: true,
    adb: { resolved: true, source: 'env', path: 'D:/fake/adb.exe', message: '' },
    device: { connected: true, serial: SERIAL, detail: '设备在线', reason: null },
    forwards: {
      ok: true,
      ports: ['tcp:8896', 'tcp:8898'],
      detail: `192.168.2.46:33743 tcp:8898 tcp:8896\r\n192.168.2.46:33743 tcp:8896 tcp:8896`,
    },
    bridge: {
      online: true,
      latencyMs: 21,
      detail: '桥服务在线',
      port: 8896,
      transport: 'forward',
      baseUrl: 'http://127.0.0.1:8896',
      token: '5500…8d30',
      tokenDetail: '已从设备读取',
      tools: 22,
      mode: 'lite',
    },
    screen: {
      nodes: 18,
      chatChars: 0,
      chatLines: 0,
      inputChars: 0,
      sendVisible: false,
      inputBounds: null,
      sendBounds: null,
      summary: '节点 18 个，聊天列表未出现，聊天文本 0 字 / 0 行，输入框 0 字，发送按钮不可见',
    },
    uiAutomation: {
      bridgeUiTools: false,
      screenReadPath: 'PC 侧 adb shell uiautomator dump',
      note: 'StepBridge lite 版不含无障碍与任何 UI 工具；读屏与点击全部走 PC 侧 adb。',
    },
    summary: 'adb：已解析（env）',
  };
  return { ...base, ...overrides };
}

function row(model, key) {
  const found = model.rows.find((r) => r.key === key);
  assert.ok(found, `行模型应包含 ${key} 行`);
  return found;
}

function dispatchRow(model, key) {
  assert.ok(model.dispatch, '应有 dispatch 段');
  const found = model.dispatch.rows.find((r) => r.key === key);
  assert.ok(found, `dispatch 段应包含 ${key} 行`);
  return found;
}

test('行模型是固定 7 项、固定顺序、固定 key', () => {
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), now: 1000 });
  assert.deepEqual(model.rows.map((r) => r.key), [...leaf.ROW_KEYS]);
  for (const r of model.rows) {
    assert.ok(leaf.TONES.includes(r.tone), `未知 tone：${r.tone}`);
    assert.equal(typeof r.value, 'string');
    assert.ok(r.value.length > 0);
    assert.ok(r.hint === null || typeof r.hint === 'string');
  }
});

test('全绿快照给「协作链正常」，每行都是已测字段', () => {
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), now: 1000 });
  assert.equal(model.tone, 'ok');
  assert.equal(model.headline, '协作链正常');
  assert.equal(row(model, 'adb').value, '已解析（env）');
  assert.equal(row(model, 'adb').tone, 'ok');
  assert.equal(row(model, 'device').value, SERIAL);
  // 转发行优先 ports，绝不用 detail——detail 是 `adb forward --list` 的原文多行。
  assert.equal(row(model, 'forward').value, 'tcp:8896 + tcp:8898');
  assert.equal(row(model, 'bridge').value, '在线 21ms');
  assert.equal(row(model, 'tools').value, '22 个（lite）');
  // 令牌只以掩码形态出现
  assert.equal(row(model, 'token').value, '5500…8d30');
  assert.equal(row(model, 'screen').value, '18 节点');
  assert.equal(model.badges.length, 0);
  assert.equal(model.details.length, 0);
  assert.equal(model.truncated, false);
});

test('多行 detail 绝不进行值：每一行的 value 都是单行', () => {
  const status = happyStatus({
    ok: false,
    forwards: { ok: false, ports: [], detail: 'a\r\nb\r\nc' },
    device: { connected: false, serial: SERIAL, detail: 'line1\nline2', reason: 'device_unreachable' },
  });
  const model = leaf.buildAmooPanelModel({ status });
  for (const r of model.rows) {
    assert.doesNotMatch(r.value, /[\r\n]/);
    assert.doesNotMatch(r.hint || '', /[\r\n]/);
  }
  for (const d of model.details) {
    assert.doesNotMatch(d, /[\r\n]/);
  }
});

test('adb 未解析时红在最根上，并把 message 带进 hint 与 details', () => {
  const status = happyStatus({
    ok: false,
    adb: { resolved: false, source: 'unresolved', path: null, message: '找不到 adb，请设置 KHY_AMOO_ADB_PATH' },
    device: { connected: false, serial: SERIAL, detail: 'adb 未解析', reason: 'adb_unresolved' },
  });
  const model = leaf.buildAmooPanelModel({ status });
  assert.equal(model.tone, 'error');
  assert.match(model.headline, /adb 未解析/);
  assert.equal(row(model, 'adb').tone, 'error');
  assert.match(row(model, 'adb').hint, /KHY_AMOO_ADB_PATH/);
  assert.ok(model.details.some((d) => d.includes('adb')));
});

test('设备未连接时 headline 说设备，hint 带 reason', () => {
  const status = happyStatus({
    ok: false,
    device: { connected: false, serial: SERIAL, detail: 'error: device offline', reason: 'device_unreachable' },
    forwards: { ok: false, ports: [], detail: '设备未连接，未建立 forward' },
    bridge: { online: false, latencyMs: 0, detail: 'forward 未就绪，未探活' },
  });
  const model = leaf.buildAmooPanelModel({ status });
  assert.equal(model.tone, 'error');
  assert.equal(model.headline, '设备未连接（device_unreachable）');
  assert.equal(row(model, 'device').tone, 'error');
  assert.equal(row(model, 'device').hint, 'device_unreachable');
  assert.equal(row(model, 'forward').value, '未建立');
  assert.equal(row(model, 'bridge').value, '不在线');
});

test('桥不在线时带 detail，并给出 revive 提示', () => {
  const status = happyStatus({
    ok: false,
    bridge: {
      online: false,
      latencyMs: 0,
      detail: 'bridge_request_timeout',
      port: 8896,
      transport: 'forward',
      baseUrl: 'http://127.0.0.1:8896',
      token: null,
      tokenDetail: '不可用：读取超时',
      tools: null,
      mode: null,
    },
  });
  const model = leaf.buildAmooPanelModel({ status });
  assert.equal(model.tone, 'error');
  assert.equal(model.headline, '桥服务不在线');
  assert.equal(row(model, 'bridge').hint, 'bridge_request_timeout');
  // 恢复提示是 details 的第一条：这是面板上唯一可执行的下一步。
  assert.equal(model.details[0], leaf.REVIVE_HINT);
  assert.match(model.details[0], /revive/);
  // 桥没探活 ⇒ 工具数是「没问」而不是 0
  assert.equal(row(model, 'tools').value, '—');
  assert.equal(row(model, 'tools').tone, 'idle');
  // 令牌不可用要留痕
  assert.equal(row(model, 'token').value, '不可用');
  assert.equal(row(model, 'token').hint, '不可用：读取超时');
});

test('screen 为 null 时显示「读不到」而不是 0 字', () => {
  const status = happyStatus({ ok: true, screen: null });
  const model = leaf.buildAmooPanelModel({ status });
  // 链路本身是好的，所以只是 warn，不是 error
  assert.equal(model.tone, 'warn');
  assert.equal(model.headline, '链路正常，但读不到当前界面');
  assert.equal(row(model, 'screen').value, '读不到');
  assert.equal(row(model, 'screen').tone, 'warn');
  assert.doesNotMatch(row(model, 'screen').value, /0/);
  // lite 边界提示要出现：读屏走 PC 侧 adb 是这台安装的既成事实
  assert.ok(model.notes.some((n) => n.includes('lite')));
});

test('设备没连接时界面行是 idle（没测过），不是 warn', () => {
  const status = happyStatus({
    ok: false,
    device: { connected: false, serial: SERIAL, detail: 'offline', reason: 'device_unreachable' },
    screen: null,
  });
  const model = leaf.buildAmooPanelModel({ status });
  assert.equal(row(model, 'screen').tone, 'idle');
  assert.equal(row(model, 'screen').value, '读不到');
});

test('null / 非对象 / 字段缺失全部走 idle，不抛', () => {
  for (const bad of [null, undefined, 42, 'nope', [], { adb: 1 }, { bridge: 'x' }]) {
    const model = leaf.buildAmooPanelModel({ status: bad, now: 1 });
    assert.equal(model.tone, 'idle');
    // 「没有快照」和「快照里没有可读字段」都算没信息，但说法必须能区分，
    // 否则排查时会去找一个并不存在的读取动作。
    assert.ok(['尚未读取手机状态', '快照没有可读字段'].includes(model.headline), model.headline);
    assert.equal(model.rows.length, leaf.ROW_KEYS.length);
    for (const r of model.rows) {
      assert.equal(r.tone, 'idle');
      assert.equal(r.value, '—');
    }
  }
  // 带了 screen 键但值畸形：这是「读了没读到」，不是「没测」——值必须区分开
  const malformed = leaf.buildAmooPanelModel({ status: { screen: [] }, now: 1 });
  assert.equal(malformed.tone, 'idle');
  assert.equal(row(malformed, 'screen').value, '读不到');
  assert.equal(row(malformed, 'screen').tone, 'idle');
  assert.equal(row(malformed, 'device').value, '—');
  // 整个 input 都是垃圾时同样不抛
  const model = leaf.buildAmooPanelModel(null);
  assert.equal(model.tone, 'idle');
  assert.equal(leaf.buildAmooPanelModel('x').headline, '尚未读取手机状态');
});

test('maxValueChars 截断带省略号并置 truncated', () => {
  const status = happyStatus({
    device: { connected: true, serial: '192.168.100.200:33743', detail: '', reason: null },
  });
  const model = leaf.buildAmooPanelModel({ status, maxValueChars: 10 });
  assert.equal(row(model, 'device').value, '192.168.1…');
  assert.equal(model.truncated, true);
});

test('clipValue 对空值与超长值的处理', () => {
  assert.equal(leaf.clipValue('', 24).value, '—');
  assert.equal(leaf.clipValue(null, 24).value, '—');
  assert.equal(leaf.clipValue('abc', 24).value, 'abc');
  assert.equal(leaf.clipValue('abc', 24).truncated, false);
  // 截断后总长（含省略号）不超过上限——面板按列宽预算，多一个字就溢框
  assert.equal(leaf.clipValue('一二三四五', 4).value, '一二三…');
  assert.ok(leaf.clipValue('一二三四五', 4).value.length <= 4);
  // 非数字 / 0 / 负数都回落到默认上限，而不是「不截断」
  assert.equal(leaf.clipValue('x'.repeat(40), 'abc').value, `${'x'.repeat(23)}…`);
  assert.equal(leaf.clipValue('x'.repeat(40), 0).value, `${'x'.repeat(23)}…`);
});

test('busy 时 headline 与徽章都说明正在下发', () => {
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), busy: true, now: 5 });
  assert.equal(model.tone, 'busy');
  assert.equal(model.headline, '正在向 Amoo 下发任务…');
  assert.deepEqual(model.badges.map((b) => b.key), ['busy']);
});

test('stale 徽章带停更秒数', () => {
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), stale: true, ageMs: 12000, now: 5 });
  const badge = model.badges.find((b) => b.key === 'stale');
  assert.ok(badge);
  assert.equal(badge.text, '数据停更 12s');
  assert.equal(badge.tone, 'warn');
});

test('心跳快照（partial）只画测到的东西，并说明为什么少', () => {
  const partial = {
    ok: false,
    partial: true,
    adb: null,
    device: null,
    forwards: null,
    bridge: {
      online: true,
      latencyMs: null,
      detail: '下发期间只读心跳（status.json），未发 HTTP 探活',
      port: 8896,
      transport: 'forward',
      baseUrl: 'http://127.0.0.1:8896',
      token: null,
      tokenDetail: '下发期间未读令牌',
      tools: 22,
      mode: 'lite',
    },
    screen: null,
    uiAutomation: null,
    summary: '',
  };
  const model = leaf.buildAmooPanelModel({ status: partial, busy: true, now: 5 });
  // 忙位优先：headline 是下发中，不是链路结论
  assert.equal(model.tone, 'busy');
  assert.equal(row(model, 'adb').value, '—');
  assert.equal(row(model, 'device').value, '—');
  assert.equal(row(model, 'forward').value, '—');
  // 桥心跳是在线的，但这是更弱的断言，降一档
  assert.equal(row(model, 'bridge').value, '心跳正常');
  assert.equal(row(model, 'bridge').tone, 'warn');
  assert.equal(row(model, 'tools').value, '22 个（lite）');
  assert.ok(model.notes.some((n) => n.includes('只保留桥心跳')));
});

test('忙位撤掉后只剩心跳快照时，headline 如实说没有巡检', () => {
  const partial = {
    ok: false,
    partial: true,
    bridge: { online: true, detail: '心跳', tools: 22, mode: 'lite' },
  };
  const model = leaf.buildAmooPanelModel({ status: partial, busy: false, now: 5 });
  assert.equal(model.tone, 'warn');
  assert.equal(model.headline, '只有桥心跳快照（未巡检设备）');
});

// ── dispatch 段 ────────────────────────────────────────────────────────────

function happyDispatch(overrides = {}) {
  const replyText = '今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。';
  return {
    ok: true,
    code: 'ok',
    message: `已收到 Amoo 答复（${replyText.length} 字，5 轮轮询后判定稳定）。`,
    channel: 'http',
    inputRoute: 'clipboard',
    taskChars: 10,
    baselineChars: 0,
    reply: { text: replyText, full: '…', truncated: false, originalChars: replyText.length, echoStripped: false },
    poll: { rounds: 5, waitedMs: 21000, deadlineMs: 600000, stopReason: 'reply_stable_text_stable', screenError: null, stableRounds: 3 },
    bridge: { online: true, revived: false, detail: '桥服务在线' },
    steps: [
      { id: 'ensure-device', ok: true, detail: '设备在线' },
      { id: 'ensure-forward', ok: true, detail: '已建立' },
      { id: 'bridge-ping', ok: true, detail: '桥服务在线' },
      { id: 'launch-amoo', ok: true, detail: '已打开' },
      { id: 'focus-input', ok: true, detail: '18 节点' },
      { id: 'fill-text', ok: true, detail: '已写入剪贴板并按下粘贴键' },
      { id: 'tap-send', ok: true, detail: '已点击 (1031, 1359)' },
      { id: 'poll-reply', ok: true, detail: '轮次 5，停止原因 reply_stable_text_stable' },
    ],
    ...overrides,
  };
}

test('成功下发：dispatch 段给结果/停止/答复/耗时四行', () => {
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: happyDispatch(), now: 1 });
  assert.ok(model.dispatch);
  assert.equal(model.dispatch.tone, 'ok');
  assert.equal(model.dispatch.headline, `已收到 Amoo 答复（${happyDispatch().reply.text.length} 字，5 轮轮询后判定稳定）。`);
  const keys = model.dispatch.rows.map((r) => r.key);
  assert.deepEqual(keys, ['result', 'stop', 'reply', 'elapsed']);
  assert.equal(dispatchRow(model, 'result').value, '已收到答复');
  assert.equal(model.dispatch.rows[1].value, describeStopReason('reply_stable_text_stable'));
  assert.equal(model.dispatch.rows[2].value, `${happyDispatch().reply.text.length} 字`);
  assert.equal(model.dispatch.rows[3].value, '21s');
  assert.equal(model.dispatch.replyChars, happyDispatch().reply.text.length);
  assert.equal(model.dispatch.truncated, false);
  assert.equal(model.dispatch.steps.length, 8);
});

test('失败下发的 stopReason 用与 runner 同一份中文映射', () => {
  const res = happyDispatch({
    ok: false,
    code: 'reply_incomplete',
    message: '未拿到完整答复：屏幕持续读不到（uiautomator 重试后仍失败，Amoo 可能还在流式生成）。已收到的内容 12 字，见 reply.text。',
    reply: { text: '前半段', full: '…', truncated: false, originalChars: 12, echoStripped: false },
    poll: { rounds: 40, waitedMs: 300000, deadlineMs: 600000, stopReason: 'screen_unreadable', screenError: 'could not get idle state', stableRounds: 3 },
  });
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: res, now: 1 });
  assert.equal(model.dispatch.tone, 'error');
  assert.equal(dispatchRow(model, 'result').value, '失败（reply_incomplete）');
  const stopRow = model.dispatch.rows.find((r) => r.key === 'stop');
  // 值是中文映射按上限截断后的形态；完整句子没丢——dispatch.headline 就是 runner 的
  // 整条 message（含这句），hint 则保留原始 code。
  assert.ok(stopRow.value.startsWith('屏幕持续读不到'), stopRow.value);
  assert.equal(stopRow.value, leaf.clipValue(describeStopReason('screen_unreadable'), 24).value);
  assert.equal(stopRow.hint, 'screen_unreadable');
  assert.equal(stopRow.tone, 'warn');
  assert.match(model.dispatch.headline, /屏幕持续读不到（uiautomator 重试后仍失败/);
  // 被截过就要标记，面板才知道该给「更多」的入口
  assert.equal(model.truncated, true);
});

test('答复被截断时标注原文字数', () => {
  const res = happyDispatch({
    reply: { text: 'x'.repeat(30), full: '…', truncated: true, originalChars: 40000, echoStripped: false },
  });
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: res, now: 1 });
  const replyRow = model.dispatch.rows.find((r) => r.key === 'reply');
  assert.equal(replyRow.hint, '原文 40000 字，已截断');
  assert.equal(model.dispatch.truncated, true);
});

test('答复预览截到 120 字并带省略号', () => {
  const res = happyDispatch({ reply: { text: '啊'.repeat(200), truncated: true, originalChars: 200 } });
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: res, now: 1 });
  assert.equal(model.dispatch.replyChars, 200);
  assert.equal(model.dispatch.replyPreview.length, 121);
  assert.ok(model.dispatch.replyPreview.endsWith('…'));
});

test('桥在执行中被重启过时打 revived 徽章', () => {
  const res = happyDispatch({ bridge: { online: true, revived: true, detail: '已用 monkey 重新拉起桥服务' } });
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: res, now: 1 });
  const badge = model.badges.find((b) => b.key === 'revived');
  assert.ok(badge);
  assert.equal(badge.tone, 'warn');
  const bridgeRow = model.dispatch.rows.find((r) => r.key === 'bridge');
  assert.equal(bridgeRow.value, '执行中被重启');
});

test('confirm 未通过时只有结果行，没有 poll 行', () => {
  const res = happyDispatch({
    ok: false,
    code: 'confirm_required',
    message: '这一步会在你的手机上操作 Amoo 界面并发送消息。确认后加 --confirm 再执行。',
    reply: null,
    poll: null,
    steps: [],
  });
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: res, now: 1 });
  assert.deepEqual(model.dispatch.rows.map((r) => r.key), ['result']);
  assert.equal(dispatchRow(model, 'result').value, '失败（confirm_required）');
  assert.equal(model.dispatch.steps.length, 0);
  assert.equal(model.dispatch.replyChars, 0);
  assert.equal(model.dispatch.replyPreview, '');
});

test('实时进度覆盖最终结果：busy + 步骤 + 轮询', () => {
  const progress = {
    steps: [
      { id: 'ensure-device', ok: true, detail: '设备在线' },
      { id: 'fill-text', ok: false, detail: '剪贴板写入失败：http_401' },
    ],
    poll: { round: 3, maxRounds: 40, waitedMs: 9000, chatChars: 12 },
    elapsedMs: 4200,
  };
  const model = leaf.buildAmooPanelModel({
    status: happyStatus(),
    dispatch: happyDispatch(),
    progress,
    busy: true,
    now: 9,
  });
  assert.equal(model.dispatch.tone, 'busy');
  const keys = model.dispatch.rows.map((r) => r.key);
  assert.deepEqual(keys, ['step', 'poll', 'elapsed']);
  assert.equal(model.dispatch.rows[0].value, '2 步');
  assert.match(model.dispatch.rows[0].hint, /fill-text（失败）/);
  assert.equal(model.dispatch.rows[1].value, '第 3/40 轮');
  assert.equal(model.dispatch.rows[2].value, '4s');
  assert.equal(model.progress.steps.length, 2);
});

test('进度步骤超过上限时只留最近若干条', () => {
  const steps = [];
  for (let i = 0; i < 40; i += 1) {
    steps.push({ id: `s${i}`, ok: true, detail: 'ok' });
  }
  const model = leaf.buildAmooPanelModel({ status: happyStatus(), progress: { steps }, busy: true, now: 1 });
  assert.equal(model.dispatch.steps.length, 12);
  assert.equal(model.dispatch.steps[0].id, 's28');
  assert.equal(model.dispatch.steps[11].id, 's39');
});

test('dispatch / progress 是垃圾时 dispatch 段为 null', () => {
  for (const bad of [null, undefined, 7, 'x', []]) {
    const model = leaf.buildAmooPanelModel({ status: happyStatus(), dispatch: bad, progress: bad, now: 1 });
    assert.equal(model.dispatch, null);
    assert.equal(model.progress, null);
  }
});

test('details 有上限，绝不无限长', () => {
  const status = happyStatus({
    ok: false,
    adb: { resolved: false, source: 'unresolved', path: null, message: 'm'.repeat(400) },
    device: { connected: false, serial: SERIAL, detail: 'd'.repeat(400), reason: 'device_unreachable' },
    forwards: { ok: false, ports: [], detail: 'f'.repeat(400) },
    bridge: { online: false, detail: 'b'.repeat(400), token: null, tokenDetail: 't'.repeat(400), tools: null, mode: null },
  });
  const model = leaf.buildAmooPanelModel({ status });
  assert.ok(model.details.length <= 8);
  for (const d of model.details) {
    assert.ok(d.length <= 121, `detail 超长：${d.length}`);
  }
  // 每条都被截出省略号
  assert.ok(model.details.some((d) => d.endsWith('…')));
});
