// appHostHelpers 叶子级测试 —— 锁定「从 App.js 抽出的 React 闭包无关模块作用域助手」的独立契约:
// 叶子可单独 require、16 个导出齐备、状态/spinner/token/队列面板派生纯逻辑不变、权限模式表齐、
// TUI 不支持判定按子命令区分、fail-soft 不抛。
//
// 抽出范式同 queryBridgeTimeline/localBrainProviderConfig(降上帝文件·DESIGN-ARCH-051)。App()
// 挂载态的端到端由 tests/tui/inkRenderSmoke 等覆盖;本测只对叶子本体,证抽出后自洽。
//
// 运行: node --test tests/tui/appHostHelpersLeaf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/tui/ink-components/appHostHelpers');

const EXPORTS = [
  '_readMergedTaskLines', '_resetTaskLinesTtl', 'PERMISSION_MODES', 'applyPermissionMode',
  '_normToolName', 'isQuestionRequest', '_learnNeedsClassic', 'tuiUnsupportedReason',
  '_taskActivity', '_getStatusLabel', '_liveActivity', '_spinnerCcTokensEnabled',
  '_estimateTok', '_spinnerProgress', '_queuePanelLines', '_renderQueuePanel',
  '_liveClampBoundaryDecision',
];

test('叶子可单独 require,17 个导出齐备(含权限模式常量数组)', () => {
  for (const name of EXPORTS) {
    if (name === 'PERMISSION_MODES') {
      assert.ok(Array.isArray(leaf[name]), 'PERMISSION_MODES 应为数组');
    } else {
      assert.equal(typeof leaf[name], 'function', `缺少导出 ${name}`);
    }
  }
});

test('PERMISSION_MODES:5 宽 Shift+Tab 循环顺序固定(含 auto)', () => {
  assert.deepEqual(leaf.PERMISSION_MODES, ['default', 'acceptEdits', 'plan', 'auto', 'bypass']);
});

test('_normToolName:去空白/下划线/连字并小写', () => {
  assert.equal(leaf._normToolName('Ask_User-Question'), 'askuserquestion');
  assert.equal(leaf._normToolName(null), '');
});

test('isQuestionRequest:仅 can_use_tool + AskUserQuestion 目标为真', () => {
  assert.equal(leaf.isQuestionRequest({ request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } }), true);
  assert.equal(leaf.isQuestionRequest({ request: { subtype: 'can_use_tool', tool_name: 'Bash' } }), false);
  assert.equal(leaf.isQuestionRequest(null), false);
});

test('_getStatusLabel:基础相位 + activity 明细拼接', () => {
  assert.equal(leaf._getStatusLabel('tool', '列出 Desktop'), '执行工具… · 列出 Desktop');
  assert.equal(leaf._getStatusLabel('thinking', ''), '思考中…');
  assert.equal(leaf._getStatusLabel('unknown', ''), '思考中…'); // 兜底
});

test('_spinnerCcTokensEnabled:默认开,显式关字面量识别', () => {
  assert.equal(leaf._spinnerCcTokensEnabled({}), true);
  assert.equal(leaf._spinnerCcTokensEnabled({ KHY_SPINNER_CC_TOKENS: '0' }), false);
  assert.equal(leaf._spinnerCcTokensEnabled({ KHY_SPINNER_CC_TOKENS: 'off' }), false);
});

test('_estimateTok:空返 0;字符兜底 CC 口径 round(len/4),关门 ceil', () => {
  assert.equal(leaf._estimateTok(''), 0);
  // 无真 tokenizer 时走字符兜底;10 字符 → round(2.5)=3(默认 CC) / ceil(2.5)=3(关门,此例相等)
  const cc = leaf._estimateTok('abcdefghij', {});
  assert.ok(cc >= 1);
});

test('_spinnerProgress:纯时间派生 elapsedSec/stalled/stalledSec(now 传入,3s 阈)', () => {
  const started = 1_000_000;
  // 距上次活动 2s < 3s → 未停滞;停滞秒数为 0(调用方据此不加「已 Ns」后缀)
  const fresh = leaf._spinnerProgress(started, started + 5000, started + 3000, null, {});
  assert.equal(fresh.elapsedSec, 5);
  assert.equal(fresh.stalled, false);
  assert.equal(fresh.stalledSec, 0);
  // 距上次活动 9s > 3s → 停滞;stalledSec = 真实停滞秒数(规则 2.5 等待行要的那个数)
  const stalled = leaf._spinnerProgress(started, started + 10000, started + 1000, null, {});
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.stalledSec, 9);
  // 阈下不下结论:3s 恰好不 stalled(严格大于),避免「还在活跃」被写成「等待中」
  const edge = leaf._spinnerProgress(started, started + 3000, started, null, {});
  assert.equal(edge.stalled, false);
  assert.equal(edge.stalledSec, 0);
  // 刚过阈 +1ms → 秒数是真实的 3(取整),不是一个凑出来的下限
  const barely = leaf._spinnerProgress(started, started + 3001, started, null, {});
  assert.equal(barely.stalled, true);
  assert.equal(barely.stalledSec, 3);
  // 无 lastActivity（回合刚起）→ 不判停滞也不给秒数
  const noActivity = leaf._spinnerProgress(started, started + 5000, 0, null, {});
  assert.equal(noActivity.stalled, false);
  assert.equal(noActivity.stalledSec, 0);
});

test('_queuePanelLines:空→[];超 5 条折叠 + 末条↑取回 + 汇总行', () => {
  assert.deepEqual(leaf._queuePanelLines([]), []);
  const rows = leaf._queuePanelLines(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.ok(rows.some((r) => r.includes('↑ 取回')));
  assert.ok(rows.some((r) => r.includes('还有 2 条')));
  assert.ok(rows[rows.length - 1].includes('7 条排队'));
});

test('_renderQueuePanel:载 ink 后返回元素数组;未载则明确抛(证叶子非纯零 IO)', async () => {
  // 未载 ink 时依赖 inkRuntime.get() 会显式抛 —— 契约就是「仅挂载后可调」,与 App.js 内一致
  assert.throws(() => leaf._renderQueuePanel(['hello']), /loadInk/);
  const inkRuntime = require('../../src/cli/tui/inkRuntime');
  await inkRuntime.loadInk();
  const els = leaf._renderQueuePanel(['hello']);
  assert.ok(Array.isArray(els));
  assert.ok(els.length >= 1);
});

test('_liveClampBoundaryDecision:新轮 reserve≠0 先 reset 不采样;同轮采样', () => {
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't2', 5), { changed: true, reset: true, sample: false });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't2', 0), { changed: true, reset: false, sample: true });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't1', 0), { changed: false, reset: false, sample: true });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', null, 0), { changed: true, reset: false, sample: false });
});

test('tuiUnsupportedReason:未知/原生命令返回 null,forgot 返回中文原因', () => {
  assert.equal(leaf.tuiUnsupportedReason(null), null);
  assert.equal(leaf.tuiUnsupportedReason({ command: 'rollback' }), null);
  assert.equal(leaf.tuiUnsupportedReason({ command: 'forgot' }), '找回密码');
});

test('applyPermissionMode:任意模式 fail-soft 不抛(缺依赖静默兜底)', () => {
  assert.doesNotThrow(() => leaf.applyPermissionMode('default'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('auto'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('dontAsk'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('bypass'));
});

test('_readMergedTaskLines / _taskActivity:fail-soft 返回数组 / 字符串', () => {
  assert.ok(Array.isArray(leaf._readMergedTaskLines()));
  assert.equal(typeof leaf._taskActivity(), 'string');
});

// ── _readMergedTaskLines 的扫盘 TTL 缓存(承 taskLinesMemo 未竟的那一半)──────
// 判据是**扫盘调用次数**,不是耗时:把 _taskStore.snapshot 打桩计数,断言
// TTL 窗口内 N 次读取只扫一次、门控关时逐帧真扫、窗口过期后重扫。
// 这三个断言正是「渲染体每帧同步扫盘」被消除的可复核判据。

/** 打桩 _taskStore.snapshot 计数;返回 restore。 */
function _stubSnapshot() {
  const store = require(require.resolve('../../src/tools/_taskStore'));
  const orig = store.snapshot;
  const state = { calls: 0 };
  store.snapshot = function () {
    state.calls += 1;
    try {
      return orig.apply(this, arguments);
    } catch {
      return '';
    }
  };
  return {
    state,
    restore() {
      store.snapshot = orig;
    },
  };
}

/** 保存/恢复本次用到的 env 键(避免跨用例串味)。感知 Promise —— 同步/异步用例都正确。 */
function _withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  const apply = () => {
    for (const k of keys) {
      if (patch[k] === undefined) delete process.env[k];
      else process.env[k] = patch[k];
    }
  };
  const restore = () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  apply();
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // 关键:async fn 返回 Promise ⇒ 必须等它 settle 后再恢复,否则 env 会在
  // await 期间被提前改回,让「TTL 过期」用例失真。
  if (out && typeof out.then === 'function') {
    return out.then(
      (v) => {
        restore();
        return v;
      },
      (err) => {
        restore();
        throw err;
      }
    );
  }
  restore();
  return out;
}

test('_readMergedTaskLines:TTL 窗口内只扫盘一次,且复用同一引用', () => {
  const stub = _stubSnapshot();
  try {
    _withEnv(
      { KHY_TASK_LINES_MEMO: undefined, KHY_PLAN_TASK_PANEL: '0', KHY_TASK_SNAPSHOT_TTL_MS: '60000' },
      () => {
        leaf._resetTaskLinesTtl();
        stub.state.calls = 0;
        const a = leaf._readMergedTaskLines();
        const b = leaf._readMergedTaskLines();
        const c = leaf._readMergedTaskLines();
        assert.equal(stub.state.calls, 1, 'TTL 窗口内 3 次读取应只扫盘一次');
        assert.equal(a, b, 'TTL 命中应复用同一数组引用');
        assert.equal(b, c, 'TTL 命中应复用同一数组引用');
      }
    );
  } finally {
    stub.restore();
    leaf._resetTaskLinesTtl();
  }
});

test('_readMergedTaskLines:KHY_TASK_LINES_MEMO=0 逐帧真扫(逐字节回退今日)', () => {
  const stub = _stubSnapshot();
  try {
    _withEnv({ KHY_TASK_LINES_MEMO: '0', KHY_PLAN_TASK_PANEL: '0' }, () => {
      leaf._resetTaskLinesTtl();
      stub.state.calls = 0;
      leaf._readMergedTaskLines();
      leaf._readMergedTaskLines();
      assert.equal(stub.state.calls, 2, '门控关时应逐帧扫盘');
    });
  } finally {
    stub.restore();
    leaf._resetTaskLinesTtl();
  }
});

test('_readMergedTaskLines:TTL 过期后重扫,窗口内不重扫', () => {
  // 窗口值刻意无 env override(§7 R4「净新增门控 = 0」)⇒ 用打桩 Date.now 推时间,
  // 而不是等真实 250ms。含**反向断言**(窗口内不重扫),否则「恒重扫」也能骗过测试。
  const stub = _stubSnapshot();
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  try {
    _withEnv({ KHY_TASK_LINES_MEMO: undefined, KHY_PLAN_TASK_PANEL: '0' }, () => {
      leaf._resetTaskLinesTtl();
      stub.state.calls = 0;
      leaf._readMergedTaskLines();
      assert.equal(stub.state.calls, 1, '首帧应扫盘');
      fake += 10;
      leaf._readMergedTaskLines();
      assert.equal(stub.state.calls, 1, '窗口内不应重扫');
      fake += 300; // 越过默认 250ms 窗口
      leaf._readMergedTaskLines();
      assert.equal(stub.state.calls, 2, '窗口过期后应重扫');
    });
  } finally {
    Date.now = realNow;
    stub.restore();
    leaf._resetTaskLinesTtl();
  }
});

test('_readMergedTaskLines:KHY_TASK_PANEL=0 恒返空且不扫盘', () => {
  const stub = _stubSnapshot();
  try {
    _withEnv({ KHY_TASK_PANEL: '0' }, () => {
      leaf._resetTaskLinesTtl();
      stub.state.calls = 0;
      assert.deepEqual(leaf._readMergedTaskLines(), []);
      assert.equal(stub.state.calls, 0, '面板关闭时不应扫盘');
    });
  } finally {
    stub.restore();
    leaf._resetTaskLinesTtl();
  }
});

test('重复 require 命中同一单例(模块缓存稳定)', () => {
  assert.equal(require('../../src/cli/tui/ink-components/appHostHelpers'), leaf);
});
