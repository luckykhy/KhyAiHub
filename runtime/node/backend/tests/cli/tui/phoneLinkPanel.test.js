'use strict';

/**
 * phoneLinkPanel.test.js — 「手机联动」面板行模型的纯叶子断言（node:test，不渲染 ink）。
 *
 * 范式同 tests/cli/tui/sidebarPanel.test.js：把面板的行模型抽成纯叶子再断言，
 * 于是「没插手机也能把每一种状态判对」是可断言的。四种必测态（AGENTS.md §7.1 的
 * 「连接/断开/失败状态正确渲染」）：
 *   online / offline（设备未连）/ stale（数据停更）/ bridge-dead（桥不在线），
 * 另加 idle / loading / error / 无 model / 下发进度五态。
 *
 * 真机形状来自 services/domain/network/amoo/amooPanelViewModel.js 的产物；
 * 这里手写夹具而不 require 那个叶子，是为了让「行模型排布」与「判定逻辑」两处
 * 各自的回归都能单独指认——判定那侧的 25 条用例在
 * src/services/domain/network/amoo/amooPanelViewModel.test.js。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPhoneLinkLines,
  TONE_ICONS,
  KINDS,
  PANEL_TITLE,
  PANEL_FOOTER,
} = require('../../../src/cli/tui/ink-components/CcPhoneLinkPanel');

const { displayWidth } = require('../../../src/cli/formatters');

// ── 夹具 ────────────────────────────────────────────────────────────────────

function statusRow(key, label, value, tone, hint) {
  return { key, label, value, tone, hint: hint || null };
}

const ONLINE_MODEL = {
  at: 1000,
  tone: 'ok',
  headline: '协作链正常',
  rows: [
    statusRow('adb', 'adb', '已解析（env）', 'ok'),
    statusRow('device', '设备', '192.168.2.46:33743', 'ok'),
    statusRow('forward', '转发', 'tcp:8896 + tcp:8898', 'ok'),
    statusRow('bridge', '桥', '在线 21ms', 'ok'),
    statusRow('tools', '工具', '22 个（lite）', 'ok'),
    statusRow('token', '令牌', '5500…8d30', 'ok'),
    statusRow('screen', '界面', '15 节点', 'ok', '聊天 120 字 / 4 行，输入框 0 字'),
  ],
  badges: [],
  screen: { nodes: 15 },
  dispatch: null,
  progress: null,
  notes: ['lite 桥无 UI 工具：读屏与点击走 PC 侧 adb（uiautomator dump）'],
  details: [],
  truncated: false,
};

const OFFLINE_MODEL = {
  at: 1000,
  tone: 'error',
  headline: '设备未连接（device_unreachable）',
  rows: [
    statusRow('adb', 'adb', '已解析（env）', 'ok'),
    statusRow('device', '设备', '未连接', 'error', 'device_unreachable'),
    statusRow('forward', '转发', '未建立', 'error', 'adb forward --list 原文多行'),
    statusRow('bridge', '桥', '不在线', 'error', 'bridge_unreachable'),
    statusRow('tools', '工具', '—', 'idle'),
    statusRow('token', '令牌', '不可用', 'warn', '不可用：读取超时'),
    statusRow('screen', '界面', '读不到', 'idle'),
  ],
  badges: [],
  screen: null,
  dispatch: null,
  progress: null,
  notes: [],
  details: [
    '设备：未连接（device_unreachable） — device still connecting',
    '转发：未建立',
    '桥：bridge_unreachable',
    '令牌：不可用：读取超时',
  ],
  truncated: true,
};

const BRIDGE_DEAD_MODEL = {
  at: 1000,
  tone: 'error',
  headline: '桥服务不在线',
  rows: [
    statusRow('adb', 'adb', '已解析（env）', 'ok'),
    statusRow('device', '设备', '192.168.2.46:33743', 'ok'),
    statusRow('forward', '转发', 'tcp:8896 + tcp:8898', 'ok'),
    statusRow('bridge', '桥', '不在线', 'error', 'http_401'),
    statusRow('tools', '工具', '—', 'idle'),
    statusRow('token', '令牌', '不可用', 'warn', '不可用：401 未授权'),
    statusRow('screen', '界面', '读不到', 'warn', '设备在线但没读到界面（Amoo 可能不在前台）'),
  ],
  badges: [],
  screen: null,
  dispatch: null,
  progress: null,
  notes: ['lite 桥无 UI 工具：读屏与点击走 PC 侧 adb（uiautomator dump）'],
  details: [
    '桥不在线时可试 khy phone revive（monkey 拉起，实测唯一恢复路）',
    '桥：http_401',
  ],
  truncated: false,
};

const DISPATCH_MODEL = {
  at: 2000,
  tone: 'ok',
  headline: '协作链正常',
  rows: ONLINE_MODEL.rows,
  badges: [{ key: 'revived', text: '桥被重启过', tone: 'warn' }],
  screen: { nodes: 15 },
  dispatch: {
    tone: 'ok',
    headline: '已收到答复',
    rows: [
      { key: 'result', label: '结果', value: '已收到答复', tone: 'ok', hint: null },
      { key: 'stop', label: '停止', value: '回复稳定', tone: 'ok', hint: 'reply_stable_text_stable' },
      { key: 'reply', label: '答复', value: '86 字', tone: 'ok', hint: null },
      { key: 'elapsed', label: '用时', value: '12s', tone: 'idle', hint: null },
    ],
    steps: [
      { id: 'ensure-device', ok: true, detail: '设备已连接' },
      { id: 'bridge-ping', ok: true, detail: '在线 21ms' },
      { id: 'tap-send', ok: true, detail: '已点击发送' },
    ],
    replyPreview: '已经帮你打开微信了。\n还需要我做什么？',
    replyChars: 86,
    truncated: false,
  },
  progress: null,
  notes: [],
  details: [],
  truncated: false,
};

function snapshot(model, extra) {
  return Object.assign(
    { state: 'ready', model, stale: false, busy: false, degraded: false, lastError: null },
    extra || {}
  );
}

// ── 断言工具 ────────────────────────────────────────────────────────────────

function rowsOfKind(out, kind) {
  return out.rows.filter((r) => r.kind === kind);
}

function assertNoOverflow(out, width) {
  for (const r of out.rows) {
    assert.ok(
      displayWidth(r.text) <= width,
      `第 ${r.key} 行超宽（${displayWidth(r.text)} > ${width}）：${r.text}`
    );
  }
}

// ── 通用不变量 ──────────────────────────────────────────────────────────────

test('行模型结构不变量：key 唯一、tone 合法、text 是字符串', () => {
  for (const snap of [
    snapshot(ONLINE_MODEL),
    snapshot(OFFLINE_MODEL),
    snapshot(BRIDGE_DEAD_MODEL),
    snapshot(DISPATCH_MODEL),
    snapshot(null),
    null,
    {},
  ]) {
    const out = buildPhoneLinkLines(snap, { width: 40 });
    const keys = out.rows.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, '行 key 必须唯一（React.memo 按 key 比对）');
    for (const r of out.rows) {
      assert.equal(typeof r.text, 'string');
      assert.ok(Object.prototype.hasOwnProperty.call(TONE_ICONS, r.tone), `未知 tone：${r.tone}`);
      assert.ok(Object.prototype.hasOwnProperty.call(KINDS, r.kind.toUpperCase()) || Object.values(KINDS).includes(r.kind), `未知 kind：${r.kind}`);
    }
    // 标题永远在第一行（关得掉内容的面板关不掉自己的标题）。
    // 尾部的空行 + 页脚由**组件**追加，不进行模型（它们要跟行预算一起算）。
    assert.equal(out.rows[0].text.indexOf(PANEL_TITLE), 0);
    assert.equal(out.total, out.rows.length);
  }
});

test('四种必测态的行宽都不溢出（在线 / 离线 / 陈旧 / 桥死）', () => {
  for (const width of [40, 30, 24, 20]) {
    assertNoOverflow(buildPhoneLinkLines(snapshot(ONLINE_MODEL), { width }), width);
    assertNoOverflow(buildPhoneLinkLines(snapshot(OFFLINE_MODEL), { width }), width);
    assertNoOverflow(buildPhoneLinkLines(snapshot(BRIDGE_DEAD_MODEL), { width }), width);
    assertNoOverflow(buildPhoneLinkLines(snapshot(ONLINE_MODEL, { stale: true }), { width }), width);
    assertNoOverflow(buildPhoneLinkLines(snapshot(DISPATCH_MODEL), { width }), width);
  }
});

// ── 在线 ────────────────────────────────────────────────────────────────────

test('在线：headline 带 ✓，链路七行按固定顺序，界面行的 hint 单独一行', () => {
  const out = buildPhoneLinkLines(snapshot(ONLINE_MODEL), { width: 40 });
  const head = rowsOfKind(out, KINDS.HEADLINE)[0];
  assert.equal(head.text, '✓ 协作链正常');
  assert.equal(head.tone, 'ok');

  const rows = rowsOfKind(out, KINDS.ROW);
  const labels = rows.map((r) => r.text.trim().split(/\s+/)[0]);
  assert.deepEqual(labels, ['adb', '设备', '转发', '桥', '工具', '令牌', '界面']);

  // 界面行有 hint ⇒ 额外一行 ↳ 悬挂（不塞进同一行把 30 列看板撑爆）。
  const hints = rowsOfKind(out, KINDS.HINT);
  assert.equal(hints.length, 1);
  assert.ok(hints[0].text.includes('聊天 120 字 / 4 行'));

  assert.equal(rowsOfKind(out, KINDS.BADGES).length, 0);
  assert.equal(rowsOfKind(out, KINDS.NOTE).length, 1);
  assert.ok(rowsOfKind(out, KINDS.NOTE)[0].text.includes('lite 桥无 UI 工具'));
});

test('在线：设备序列号与端口转发原样上屏', () => {
  const out = buildPhoneLinkLines(snapshot(ONLINE_MODEL), { width: 60 });
  const text = out.rows.map((r) => r.text).join('\n');
  assert.ok(text.includes('192.168.2.46:33743'));
  assert.ok(text.includes('tcp:8896 + tcp:8898'));
  assert.ok(text.includes('22 个（lite）'));
  assert.ok(text.includes('5500…8d30'));
});

// ── 离线 ────────────────────────────────────────────────────────────────────

test('离线：headline 红在最根上，device.reason 进 hint 与 details', () => {
  const out = buildPhoneLinkLines(snapshot(OFFLINE_MODEL), { width: 40 });
  const head = rowsOfKind(out, KINDS.HEADLINE)[0];
  assert.equal(head.text, '✗ 设备未连接（device_unreachable）');
  assert.equal(head.tone, 'error');

  const rows = rowsOfKind(out, KINDS.ROW);
  const device = rows.find((r) => r.text.includes('设备'));
  assert.ok(device.text.includes('✗ 未连接'), device.text);
  assert.ok(rowsOfKind(out, KINDS.HINT).some((h) => h.text.includes('device_unreachable')));

  const details = rowsOfKind(out, KINDS.DETAIL);
  assert.ok(details.length >= 4);
  assert.ok(details.some((d) => d.text.includes('device_unreachable')));
  // 截断标记要说出来，不能静默丢字段。
  assert.ok(out.rows.some((r) => r.text.includes('部分字段已截断')));
});

test('离线：多行 detail（adb forward --list 原文）绝不进行模型', () => {
  const model = JSON.parse(JSON.stringify(OFFLINE_MODEL));
  model.rows[2].hint = '192.168.2.46:33743 tcp:8898 tcp:8896\r\n192.168.2.46:33743 tcp:8896 tcp:8896';
  const out = buildPhoneLinkLines(snapshot(model), { width: 40 });
  for (const r of out.rows) {
    assert.ok(!/[\r\n]/.test(r.text), `行模型里不允许出现换行：${JSON.stringify(r.text)}`);
  }
});

// ── 陈旧 ────────────────────────────────────────────────────────────────────

test('陈旧：标题打「数据停更」徽标，其余照旧画最后一份好快照', () => {
  const out = buildPhoneLinkLines(snapshot(ONLINE_MODEL, { stale: true }), { width: 40 });
  assert.ok(out.rows[0].text.includes('（数据停更）'));
  // 断网时「上次 3 秒前还在线」比空白有用：内容不清空。
  assert.ok(out.rows.some((r) => r.text.includes('192.168.2.46:33743')));
});

// ── 桥死 ────────────────────────────────────────────────────────────────────

test('桥死：revive 提示在 details 最前面，且它是唯一可执行的下一步', () => {
  const out = buildPhoneLinkLines(snapshot(BRIDGE_DEAD_MODEL), { width: 40 });
  const head = rowsOfKind(out, KINDS.HEADLINE)[0];
  assert.equal(head.text, '✗ 桥服务不在线');
  const details = rowsOfKind(out, KINDS.DETAIL);
  assert.ok(details.length >= 1);
  assert.ok(details[0].text.includes('khy phone revive'), `首条 detail 应是 revive 提示，实为：${details[0].text}`);
});

test('桥死：401 的 tokenDetail 留痕（「不可用」和「没读」不是一件事）', () => {
  const out = buildPhoneLinkLines(snapshot(BRIDGE_DEAD_MODEL), { width: 40 });
  assert.ok(rowsOfKind(out, KINDS.HINT).some((h) => h.text.includes('401')));
});

// ── 无快照 / 加载中 / 失败 ──────────────────────────────────────────────────

test('无 model：idle 说「尚未读取」，不猜任何字段', () => {
  const out = buildPhoneLinkLines(snapshot(null), { width: 40 });
  assert.ok(out.rows[1].text.includes('尚未读取手机状态'));
  assert.equal(rowsOfKind(out, KINDS.ROW).length, 0);
});

test('读失败（status_deadline）必须说原因，不许只给一屏 —', () => {
  // 实测复现：桥的 HTTP 线程卡死时 ping 要 10.25s，超过 provider 的 12s outer
  // deadline ⇒ 快照作废、model 是全 idle 行。此时 lastError 是唯一能说清
  // 「为什么没有数据」的字段；沉默的一屏 `—` 比错误更难排查。
  const out = buildPhoneLinkLines(
    snapshot(ONLINE_MODEL, { status: null, lastError: 'status_deadline' }),
    { width: 40 }
  );
  const text = out.rows.map((r) => r.text).join('\n');
  assert.ok(text.includes('读取失败：status_deadline'), text);
  assert.ok(text.includes('khy phone revive'), '该给出可执行的下一步');
  const details = rowsOfKind(out, KINDS.DETAIL);
  assert.ok(details.some((d) => d.tone === 'error'));
});

test('读失败但没有任何线索（lastError 为空）不加读取失败行', () => {
  const out = buildPhoneLinkLines(
    snapshot(ONLINE_MODEL, { status: null, lastError: null }),
    { width: 40 }
  );
  assert.equal(
    rowsOfKind(out, KINDS.DETAIL).filter((d) => d.text.includes('读取失败')).length,
    0
  );
});

test('loading：忙字形 + 「正在读取」，不画空链路', () => {
  const out = buildPhoneLinkLines(snapshot(null, { state: 'loading' }), { width: 40 });
  assert.ok(out.rows[1].text.startsWith('◐'));
  assert.ok(out.rows[1].text.includes('正在读取手机状态'));
  assert.equal(rowsOfKind(out, KINDS.ROW).length, 0);
});

test('error：带 lastError，并给出一条可操作的下一步', () => {
  const out = buildPhoneLinkLines(snapshot(null, { state: 'error', lastError: 'status_deadline' }), { width: 40 });
  assert.ok(out.rows[1].text.startsWith('✗'));
  assert.ok(out.rows[1].text.includes('status_deadline'));
  assert.ok(out.rows.some((r) => r.text.includes('khy phone status')));
});

test('畸形输入：null / {} / 非对象 / model 非对象全不抛', () => {
  for (const bad of [null, undefined, {}, 42, 'x', { model: 42 }, { model: null, state: 'ready' }]) {
    const out = buildPhoneLinkLines(bad, { width: 40 });
    assert.ok(Array.isArray(out.rows));
    // 至少要有标题 + 一行结论（组件会再补空行与页脚）。
    assert.ok(out.rows.length >= 2, `输入 ${JSON.stringify(bad)} 至少该有标题和结论行`);
    assert.equal(typeof out.headlineTone, 'string');
  }
});

// ── 最近任务 / 实时进度 ─────────────────────────────────────────────────────

test('最近任务：结果/停止/答复/用时四行 + 回复预览 + 执行步骤', () => {
  const out = buildPhoneLinkLines(snapshot(DISPATCH_MODEL), { width: 60 });
  const text = out.rows.map((r) => r.text).join('\n');
  assert.ok(text.includes('── 最近任务 ──'));
  assert.ok(text.includes('已收到答复'));
  assert.ok(text.includes('reply_stable_text_stable'));
  assert.ok(text.includes('86 字'));
  // 回复预览逐行上屏，第一行带 > 记号。
  const replies = rowsOfKind(out, KINDS.REPLY);
  assert.equal(replies.length, 2);
  assert.ok(replies[0].text.includes('已经帮你打开微信了。'));
  assert.ok(replies[1].text.startsWith('    '), replies[1].text);
  // 步骤段 + 徽章段。
  assert.ok(text.includes('── 执行步骤 ──'));
  assert.ok(rowsOfKind(out, KINDS.BADGES).some((b) => b.text.includes('桥被重启过')));
});

test('下发进度：段标题换成「下发进度」，步骤失败画 ✗', () => {
  const model = JSON.parse(JSON.stringify(DISPATCH_MODEL));
  const progressRows = [
    { key: 'step', label: '步骤', value: '2 步', tone: 'idle', hint: 'tap-send（失败）' },
    { key: 'poll', label: '轮询', value: '第 3/40 轮', tone: 'idle', hint: null },
  ];
  model.progress = {
    steps: [
      { id: 'ensure-device', ok: true, detail: '设备已连接' },
      { id: 'tap-send', ok: false, detail: '发送按钮不可见' },
    ],
    rows: progressRows,
  };
  // 视图模型在 progress 存在时把 dispatch.rows 覆盖成 progress.rows（结果优先被进度顶掉），
  // 夹具照抄这个形状。
  model.dispatch.headline = '正在向 Amoo 下发任务…';
  model.dispatch.rows = progressRows;
  model.dispatch.steps = model.progress.steps;
  const out = buildPhoneLinkLines(snapshot(model), { width: 60 });
  const text = out.rows.map((r) => r.text).join('\n');
  assert.ok(text.includes('── 下发进度 ──'));
  assert.ok(text.includes('第 3/40 轮'));
  const steps = rowsOfKind(out, KINDS.STEP);
  assert.equal(steps.length, 2);
  assert.ok(steps[0].text.includes('✓'));
  assert.ok(steps[1].text.includes('✗'));
  assert.ok(steps[1].text.includes('发送按钮不可见'));
});

test('长字段按显示宽度截断并带省略号（CJK 双宽感知）', () => {
  const model = JSON.parse(JSON.stringify(ONLINE_MODEL));
  model.rows[1].value = '一台手机会在 adb devices 里出现两条记录的超级长序列号 192.168.2.46:33743';
  const out = buildPhoneLinkLines(snapshot(model), { width: 30 });
  const device = rowsOfKind(out, KINDS.ROW).find((r) => r.text.includes('设备'));
  assert.ok(device.text.includes('…'), `应带省略号：${device.text}`);
  assert.ok(displayWidth(device.text) <= 30);
});

test('tone → 字形映射冻结且覆盖全部 tone', () => {
  assert.deepEqual({ ...TONE_ICONS }, {
    ok: '✓', warn: '⚠', error: '✗', idle: '○', busy: '◐',
  });
  assert.ok(Object.isFrozen(TONE_ICONS));
  assert.ok(Object.isFrozen(KINDS));
});
