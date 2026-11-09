'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 覆盖任务 #3 的三块纯逻辑:`#N`/accountId 解析、scope 校验分支、status 多账号遍历诊断。
// 经 require.cache 桩掉 wx.js 的全部惰性依赖(store/core/daemon/defaults/config)与 formatters,
// 绝不触真 IO。参考同目录 subscribePr.test.js 的桩法。

// wx allow 会真的往 ~/.khyos 写名单文件,而 ilinkPeerAllowlist 不在桩列表里(它就是被测的
// 真实薄 IO 层)。隔离数据家,免得测试往用户的真实名单里塞 u2/u9。
process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-wxallow-'));

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/wx.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const STORE = path.resolve(__dirname, '../../../src/services/domain/messaging/messaging/ilinkAccountStore.js');
const CORE = path.resolve(__dirname, '../../../src/services/domain/messaging/messaging/ilinkCore.js');
const DAEMON = path.resolve(__dirname, '../../../src/services/daemonManager.js');
const DEFAULTS = path.resolve(__dirname, '../../../src/constants/serviceDefaults.js');
const CONFIG = path.resolve(__dirname, '../../../src/cli/handlers/config.js');
const BINDING = path.resolve(__dirname, '../../../src/services/domain/messaging/messaging/ilinkBindingStore.js');

let infoLog, errLog, warnLog, successLog, tableLog, state;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// serviceDefaults 必须用**同一个可变对象**做桩:ilinkPeerAllowlist.allowMode() 与 wx.js 的
// 档位读取都发生在调用期,每次 _install 换一个新对象的话,已缓存 require 的引用会停在
// 旧对象上(同一进程里两种档位就串了)。
const DEFAULTS_STUB = {
  ILINK_SESSION_SCOPE: 'per-account-channel-peer',
  ILINK_SESSION_SCOPES: ['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer'],
  ILINK_HEARTBEAT_STALE_MS: 240000,
  // 默认档:严格(未配置即拒答)。桩里**必须**有这三个 ILINK_* 键,否则
  // wx.js 读到的会是 undefined,输出里静默渲染出 "undefined"(本组末尾有专门断言钉它)。
  // 观察期语义的那几条用例**各自显式**把它置成 true —— 默认档不再碰它。
  ILINK_ALLOW_UNLISTED: false,
  ILINK_ALLOWED_PEERS: '',
  ILINK_ALLOW_WARN_WINDOW_MS: 600000,
};

function _install({
  accounts = [],
  enabled = true,
  daemonRunning = true,
  sessions = {},
  heartbeats = {},
  staleMs = 240000,
  bindings = {},
} = {}) {
  state = { setActiveCalls: [], envPatches: [], bindCalls: [], unbindCalls: [] };
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
    printWarn: (m) => warnLog.push(String(m)),
    printSuccess: (m) => successLog.push(String(m)),
    printTable: (head, rows) => tableLog.push({ head, rows }),
    // Error panel maps to the same error collector: title/message/reason form the
    // error line, and suggestions surface as info hints (mirrors real UX split).
    printErrorPanel: (opts) => {
      const o = opts || {};
      errLog.push([o.title, o.message, o.reason].filter(Boolean).join(' '));
      for (const s of Array.isArray(o.suggestions) ? o.suggestions : []) infoLog.push(String(s));
    },
  });
  _stub(STORE, {
    listAccounts: () => accounts.slice(),
    getSessionState: (id) => sessions[id] || null,
    getHeartbeat: (id) => heartbeats[id] || null,
    setActiveAccount: (id) => {
      state.setActiveCalls.push(id);
      const hit = accounts.find((a) => a.accountId === id);
      return hit ? { ok: true, accountId: id } : { ok: false, error: '账号不存在' };
    },
  });
  _stub(CORE, { isEnabled: () => enabled });
  _stub(DAEMON, { daemonStatus: async () => ({ running: daemonRunning }) });
  _stub(DEFAULTS, DEFAULTS_STUB);
  DEFAULTS_STUB.ILINK_HEARTBEAT_STALE_MS = staleMs;
  _stub(CONFIG, {
    _writeEnvPatch: (map) => { state.envPatches.push(map); return '/sandbox/.env'; },
  });
  // 绑定薄 IO 层桩:内存表 + 记录调用,复刻真 store 的 workspace 必填校验与幂等语义,绝不触盘。
  _stub(BINDING, {
    bindAccount: (id, data) => {
      state.bindCalls.push({ id, data });
      const d = data || {};
      if (typeof d.workspace !== 'string' || !d.workspace.trim()) return { ok: false, error: '缺少 workspace' };
      const binding = { workspace: String(d.workspace), agent: String(d.agent || '') };
      bindings[id] = binding;
      return { ok: true, accountId: id, binding };
    },
    unbindAccount: (id) => {
      state.unbindCalls.push(id);
      delete bindings[id];
      return { ok: true, accountId: id };
    },
    getBinding: (id) => bindings[id] || null,
    listBindings: () => Object.keys(bindings).map((id) => ({ accountId: id, ...bindings[id] })),
  });
}

beforeEach(() => {
  infoLog = []; errLog = []; warnLog = []; successLog = []; tableLog = [];
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = false;
  delete require.cache[HANDLER];
});
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, STORE, CORE, DAEMON, DEFAULTS, CONFIG, BINDING]) delete require.cache[p];
});

// ── A. accountId 解析 ──────────────────────────────────────────────

test('_resolveAccountId: #N 按顺序取第 N 个(1-based)', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }, { accountId: 'bot-c' }];
  assert.deepStrictEqual(_resolveAccountId(list, '#2'), { ok: true, accountId: 'bot-b' });
});

test('_resolveAccountId: 纯数字等价于 #N', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }];
  assert.deepStrictEqual(_resolveAccountId(list, '1'), { ok: true, accountId: 'bot-a' });
});

test('_resolveAccountId: 非数字当作 accountId 直接匹配', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }];
  assert.deepStrictEqual(_resolveAccountId(list, 'bot-b'), { ok: true, accountId: 'bot-b' });
});

test('_resolveAccountId: 序号越界 → 明确报错', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const r = _resolveAccountId([{ accountId: 'bot-a' }], '#5');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /超出范围/);
});

test('_resolveAccountId: 未知 accountId → 明确报错', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const r = _resolveAccountId([{ accountId: 'bot-a' }], 'nope');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /未找到账号/);
});

// ── A. wx use 切换 ─────────────────────────────────────────────────

test('wx use #2 → setActiveAccount(第2个) 并给出成功与提示', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('use', ['#2'], {});
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(state.setActiveCalls, ['bot-b']);
  assert.match(successLog.join('\n'), /切换为 bot-b/);
  assert.match(infoLog.join('\n'), /各账号仍在各自轮询/);
});

test('wx use 无参 → 用法提示且不切换', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('use', [], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.setActiveCalls.length, 0);
  assert.match(errLog.join('\n'), /用法/);
});

test('wx use 账号列表为空 → 清晰提示先绑定', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('select', ['#1'], {});
  assert.strictEqual(rc, 1);
  assert.match(errLog.join('\n'), /尚未绑定/);
});

// ── B. wx scope 校验分支 ───────────────────────────────────────────

test('wx scope 无参 → 展示当前策略与全部可选值表', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 1);
  assert.strictEqual(tableLog[0].rows.length, 4, '应列出 4 种策略');
  assert.strictEqual(state.envPatches.length, 0, '无参不应写盘');
});

test('wx scope <合法> → 持久化 KHY_ILINK_SESSION_SCOPE 并提示重启', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', ['per-peer'], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.envPatches.length, 1);
  assert.strictEqual(state.envPatches[0].KHY_ILINK_SESSION_SCOPE, 'per-peer');
  assert.match(infoLog.join('\n'), /重启守护进程/);
});

test('wx scope <非法> → 报错并列出可选值,不写盘', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', ['bogus'], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.envPatches.length, 0);
  assert.match(errLog.join('\n'), /非法的会话隔离策略/);
  assert.match(infoLog.join('\n'), /per-account-channel-peer/);
});

// ── C. status 多账号遍历诊断 ───────────────────────────────────────

test('status: 逐账号诊断,某账号会话过期 → 返回非 0 且各账号各一行', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }, { accountId: 'bot-b' }],
    daemonRunning: true,
    sessions: { 'bot-b': { expired: true, at: '2026-01-01' } },
    heartbeats: { 'bot-a': { ageMs: 1000 } },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 1, '有账号过期应返回非 0');
  assert.match(errLog.join('\n'), /bot-b 的会话已过期/);
  assert.match(successLog.join('\n'), /bot-a 正在长轮询/);
});

test('status: 某账号心跳陈旧 → 返回非 0', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }],
    daemonRunning: true,
    heartbeats: { 'bot-a': { ageMs: 999999 } },
    staleMs: 240000,
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 1);
  assert.match(errLog.join('\n'), /bot-a[\s\S]*已 \d+ 秒没有心跳/);
});

test('status: 守护进程未运行且无过期 → 返回 0,逐账号提示等待启动', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }, { accountId: 'bot-b' }],
    daemonRunning: false,
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(warnLog.join('\n'), /守护进程未运行/);
  assert.match(infoLog.join('\n'), /bot-a 会话有效,等待守护进程启动/);
  assert.match(infoLog.join('\n'), /bot-b 会话有效,等待守护进程启动/);
});

test('status: 未绑定账号 → info 提示并返回 0', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(infoLog.join('\n'), /尚未绑定微信账号/);
});

test('status: KHY_MSG=off → 警告并返回 0,不做逐账号诊断', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], enabled: false });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(warnLog.join('\n'), /KHY_MSG=off/);
});

// ── D. wx bind 路由绑定 ────────────────────────────────────────────

test('wx bind #1 --workspace <path> --agent <name> → bindAccount 成功并提示即时生效', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], { workspace: '/ws/alpha', agent: 'quant' });
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.bindCalls.length, 1);
  assert.deepStrictEqual(state.bindCalls[0], { id: 'bot-a', data: { workspace: '/ws/alpha', agent: 'quant' } });
  assert.match(successLog.join('\n'), /bot-a 绑定到工作空间 \/ws\/alpha/);
  assert.match(successLog.join('\n'), /Agent:quant/);
  assert.match(infoLog.join('\n'), /绑定已即时生效/);
  assert.match(infoLog.join('\n'), /khy wx start 才能开始收消息/);
});

test('wx bind 精确 accountId 无 --agent → agent 省略传 undefined,仍成功', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['bot-a'], { workspace: '/ws/beta' });
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.bindCalls.length, 1);
  assert.strictEqual(state.bindCalls[0].data.workspace, '/ws/beta');
  assert.strictEqual(state.bindCalls[0].data.agent, undefined);
});

test('wx bind 缺 --workspace → 用法报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /缺少 --workspace/);
});

test('wx bind 非法 id(未找到)→ 报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['nope'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /未找到账号/);
});

test('wx bind 序号越界 → 报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#9'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /超出范围/);
});

test('wx bind 账号列表为空 → 提示先绑定,不调 bindAccount', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /尚未绑定微信账号/);
});

// ── E. wx unbind 幂等 ──────────────────────────────────────────────

test('wx unbind #1 幂等:连调两次均返回 0 且都落 unbindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], bindings: { 'bot-a': { workspace: '/ws/x', agent: '' } } });
  const { handleWx } = require(HANDLER);
  const rc1 = await handleWx('unbind', ['#1'], {});
  const rc2 = await handleWx('unbind', ['#1'], {});
  assert.strictEqual(rc1, 0);
  assert.strictEqual(rc2, 0);
  assert.deepStrictEqual(state.unbindCalls, ['bot-a', 'bot-a']);
  assert.match(successLog.join('\n'), /已解除账号 bot-a 的路由绑定/);
});

test('wx unbind 无参 → 用法报错且不调 unbindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('unbind', [], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.unbindCalls.length, 0);
  assert.match(errLog.join('\n'), /用法/);
});

// ── F. wx bindings 路由视图(只读) ─────────────────────────────────

test('wx bindings 空列表 → info 提示如何绑定,不出表,返回 0', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], bindings: {} });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bindings', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 0, '空列表不应出表');
  assert.match(infoLog.join('\n'), /尚无路由绑定/);
  assert.match(infoLog.join('\n'), /khy wx bind/);
});

test('wx bindings 非空 → 打印账号→工作空间/Agent 路由表', async () => {
  _install({
    accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }],
    bindings: {
      'bot-a': { workspace: '/ws/alpha', agent: 'quant' },
      'bot-b': { workspace: '/ws/beta', agent: '' },
    },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bindings', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 1, '非空应出 1 张表');
  assert.deepStrictEqual(tableLog[0].head, ['账号ID', '绑定工作空间', '绑定Agent']);
  assert.strictEqual(tableLog[0].rows.length, 2);
  assert.deepStrictEqual(tableLog[0].rows[0], ['bot-a', '/ws/alpha', 'quant']);
  assert.deepStrictEqual(tableLog[0].rows[1], ['bot-b', '/ws/beta', '-'], '无 agent 应回退为 -');
});

// ── G. wx allow 允许名单 + 档位可见(规则 2 RUNTIME-002)────────────────────
//
// 默认档是严格档。观察期必须显式 KHY_ILINK_ALLOW_UNLISTED=1 才进,所以「配置成功 ≠
// 配置生效」那一组用例各自把桩置成 true 再跑 —— 默认档下它们根本到不了那段文案。
// 另外:若 `wx allow add` 只回一句「已加入」,用户拿到的就是一张「配置成功」的回执而
// 安全上什么都没变 —— 规则 2 明令禁止的形态。所以每条回执都必须带当前档位,且输出里
// 绝不许出现字符串 'undefined'(桩缺字段时的静默渲染)。

/** 本轮全部输出拼成一段,供「不得出现 undefined」这类断言用。 */
function _allOutput() {
  return [infoLog, warnLog, successLog, errLog, tableLog].map((x) => JSON.stringify(x)).join('\n');
}

test('wx allow add → 观察期回执必须带当前档位与「暂不生效」提示', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = true;
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['add', 'u2'], {});
  assert.strictEqual(rc, 0);
  const warn = warnLog.join('\n');
  assert.match(warn, /观察期档\(未列名者放行\)/, '配置成功 ≠ 配置生效,必须报当前档位');
  assert.match(warn, /本条配置暂不生效/);
  assert.match(warn, /khy wx allow env off/);
  assert.match(successLog.join('\n'), /已加入允许名单:u2/);
  // env 名只该在 _allowModeNotice 里出现一次;标签再带一遍就会渲染成
  // 「…(手动 KHY_ILINK_ALLOW_UNLISTED=1)(观察期需手动 …=1);…」这样的串。
  assert.ok(
    !/KHY_ILINK_ALLOW_UNLISTED/.test(warn),
    `env 名重复出现了:${warn}`
  );
  assert.ok(!/undefined/.test(_allOutput()), '桩缺字段会静默渲染 undefined,输出里不许出现');
});

test('wx allow add 默认(严格)档 → 回执说明名单立即参与判定', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['add', 'u3'], {});
  assert.strictEqual(rc, 0);
  const warn = warnLog.join('\n');
  assert.match(warn, /仅允许名单内\(严格\)/);
  assert.match(warn, /立即参与放行判定/);
  assert.ok(!/暂不生效/.test(warn), '严格档下不该再报「暂不生效」');
});

test('wx allow rm → 同样带档位,不因「配置成功」而漏报', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = true;
  const { handleWx } = require(HANDLER);
  await handleWx('allow', ['add', 'u4'], {});
  const rc = await handleWx('allow', ['rm', 'u4'], {});
  assert.strictEqual(rc, 0);
  assert.match(successLog.join('\n'), /已移出允许名单:u4/);
  assert.match(warnLog.join('\n'), /观察期档\(未列名者放行\)/);
});

test('wx allow list → 报档位、名单内容与隐式允许 ID', async () => {
  _install({ accounts: [{ accountId: 'bot-a', userId: 'me' }] });
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = true;
  const { handleWx } = require(HANDLER);
  await handleWx('allow', ['add', 'u5'], {});
  infoLog = []; warnLog = []; successLog = []; errLog = []; tableLog = [];
  const rc = await handleWx('allow', ['list'], {});
  assert.strictEqual(rc, 0);
  assert.match(infoLog.join('\n'), /当前档位:观察期档\(未列名者放行\)/);
  assert.match(infoLog.join('\n'), /账号 bot-a 的隐式允许 ID:me/);
  const rows = tableLog.flatMap((t) => t.rows).map((r) => r.join('|'));
  assert.ok(rows.some((r) => r.includes('u5')), `名单表应含 u5:${JSON.stringify(rows)}`);
  assert.match(warnLog.join('\n'), /暂不参与放行判定/);
  assert.ok(!/undefined/.test(_allOutput()));
});

test('wx allow self → 把账号自身的 userId 写进名单(一次自愈)', async () => {
  _install({ accounts: [{ accountId: 'bot-a', userId: 'me2' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['self'], {});
  assert.strictEqual(rc, 0);
  assert.match(successLog.join('\n'), /已把账号自身的微信 ID 写入允许名单:bot-a:me2/);
  assert.match(warnLog.join('\n'), /当前档位/);
  const rows = tableLog.flatMap((t) => t.rows);
  assert.ok(!rows.some((r) => r.includes('me2')), 'self 只写入,不重打印表');
});

test('wx allow env off → 写 KHY_ILINK_ALLOW_UNLISTED=0 并提示重启与风险', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['env', 'off'], {});
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(state.envPatches[0], { KHY_ILINK_ALLOW_UNLISTED: '0' });
  assert.match(infoLog.join('\n'), /重启守护进程生效/);
  assert.match(warnLog.join('\n'), /没在名单里的发送者会被直接拒答/);
});

test('wx allow env <ids> → 写跨账号名单,不碰档位开关', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['env', 'u2,u3'], {});
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(state.envPatches[0], { KHY_ILINK_ALLOWED_PEERS: 'u2,u3' });
});

test('wx allow env on → 写 KHY_ILINK_ALLOW_UNLISTED=1 并提示这是临时逃生阀', async () => {
  // on 是翻档之后**唯一的 CLI 回退路径**:默认档已经拒答,现场要靠它临时放回观察期。
  // 零覆盖等于把闸门的唯一钥匙钉死在没人试过的路径上。
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('allow', ['env', 'on'], {});
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(state.envPatches[0], { KHY_ILINK_ALLOW_UNLISTED: '1' });
  assert.match(successLog.join('\n'), /KHY_ILINK_ALLOW_UNLISTED=1/);
  assert.match(infoLog.join('\n'), /重启守护进程生效/);
  const warn = warnLog.join('\n');
  assert.match(warn, /观察期已开/, '必须说清这一步放开了什么');
  assert.match(warn, /khy wx allow env off/, '并给出收回的办法');
});

test('wx allow 缺参/未知动词 → 用法提示且返回 1,不写盘', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  assert.strictEqual(await handleWx('allow', ['add'], {}), 1, 'add 不带 id → 用法');
  assert.strictEqual(await handleWx('allow', ['bogus'], {}), 1, '未知动词 → 用法');
  assert.strictEqual(state.envPatches.length, 0);
  assert.match(errLog.join('\n'), /用法:khy wx allow/);
});

test('wx help 报当前档位', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('help', [], {});
  assert.strictEqual(rc, 0);
  // 默认档即严格档:help 报出来的必须是严格,不能还是「观察期」。
  assert.match(infoLog.join('\n'), /准入档位:仅允许名单内\(严格\)/);
});

test('wx help 在观察期 → 档位标签换观察期,且不再出现旧的「未配置即放行」假文案', async () => {
  _install({ accounts: [] });
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = true;
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('help', [], {});
  assert.strictEqual(rc, 0);
  const info = infoLog.join('\n');
  assert.match(info, /准入档位:观察期档\(未列名者放行\)/);
  assert.ok(
    !/未配置即放行/.test(info),
    '默认档已翻成严格,「未配置即放行」是假话,任何展示面都不许再写它'
  );
});

// 出站草稿档位同样必须出现在 help/status 上:草稿默认开着,用户若不知道「回复要先批准」,
// 会以为 agent 没理他(规则 2 RUNTIME-002)。桩里没有这个键,顺带钉住「不得渲染 undefined」。
test('wx help 必须说明出站草稿档位,且不得出现 undefined', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('help', [], {});
  assert.strictEqual(rc, 0);
  const info = infoLog.join('\n');
  assert.match(info, /出站草稿:逐条批准/);
  assert.match(info, /\/draft off/, 'help 必须给出关掉草稿的办法');
  assert.ok(!/undefined/.test(_allOutput()), '桩缺字段会静默渲染 undefined,输出里不许出现');
});

test('wx status 必须报出站草稿档位', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }],
    daemonRunning: true,
    heartbeats: { 'bot-a': { ageMs: 1000 } },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(infoLog.join('\n'), /出站草稿:逐条批准/);
  assert.ok(!/undefined/.test(_allOutput()));
});

test('status: 观察期 → 输出必须含发送者准入档位与名单不生效说明', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }],
    daemonRunning: true,
    heartbeats: { 'bot-a': { ageMs: 1000 } },
  });
  DEFAULTS_STUB.ILINK_ALLOW_UNLISTED = true;
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  const info = infoLog.join('\n');
  assert.match(info, /发送者准入:观察期档\(未列名者放行\)/);
  assert.match(info, /允许名单:\d+ 人/);
  assert.match(info, /当前档位下这份名单不参与放行判定/);
  assert.ok(!/undefined/.test(_allOutput()), 'status 输出里不得出现 undefined(桩缺字段的静默渲染)');
});

test('status: 默认档即严格档 → 档位行换成仅允许名单内', async () => {
  // 不显式置档位:默认桩值就是严格档,这条断言验的是「默认已翻档」而不是「能渲染严格档」。
  _install({
    accounts: [{ accountId: 'bot-a', active: true }],
    daemonRunning: true,
    heartbeats: { 'bot-a': { ageMs: 1000 } },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  const info = infoLog.join('\n');
  assert.match(info, /发送者准入:仅允许名单内\(严格\)/);
  assert.ok(!/观察期档/.test(info), `默认档不许渲染观察期标签:${info}`);
  assert.ok(!/不参与放行判定/.test(info), '严格档下名单是生效的,不该再挂那句说明');
});


