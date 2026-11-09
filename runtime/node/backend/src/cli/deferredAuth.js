'use strict';

/**
 * deferredAuth — 把「等登录」从界面挂载之前挪到之后（`KHY_DEFER_AUTH`，默认关）。
 *
 * 为什么需要：返回用户的会话校验只要 7.6ms（读本地会话文件），但**首启 / 会话过期 /
 * 后端不可用**时它会走网络与终端提示（bin/khy.js:925-945）——那 2-3 秒里屏幕是空的，
 * 用户必须先在一个纯终端提示里敲完账号密码，才看得见界面。这个模块把那段等待挪到
 * 首帧之后。
 *
 * 安全边界（写死在这里，改动须先改本节）：推迟期间**不授予任何新权力**。
 * 登录之后能做的一切，在 pending 期间仍然全部挂起；未通过则一条也不放行。
 * 本仓的登录是**订阅/凭据门槛**，不是工作区与工具执行的授权边界 —— 后者由
 * trustGate 与权限对话框各自守着（另见 works/data/khy/perf/README.md 登录一节）。
 *
 * 纪律：无 IO、绝不抛、无墙钟超时（挂起只靠 auth 落地，RUNTIME-003）。
 */

const PENDING = 'pending';
const OK = 'ok';
const FAILED = 'failed';

/**
 * pending 期间仍然可用的命令：只碰界面本身 —— 不读配置、不发请求、不执行工具。
 * 刻意不含 status / model / theme：它们要么读 provider 配置、要么写配置文件，
 * 每条都得单独审，而放行它们买不到任何东西（用户等的是登录，不是看列表）。
 */
const ALLOWED_WHILE_PENDING = Object.freeze(['help', 'exit', 'quit', 'clear']);

const ON_VALUES = ['1', 'true', 'on', 'yes'];

let _state = OK;
let _settled = null;

/** 只在「交互式 + 非 one-shot」时生效：`khy status` / `khy ai -p` 一律照旧同步认证。 */
function isEnabled(env = {}, opts = {}) {
  const v = String((env && env.KHY_DEFER_AUTH) || '').trim().toLowerCase();
  if (!ON_VALUES.includes(v)) return false;
  return opts.interactive === true && opts.oneShot !== true;
}

/** 接管一次认证：立刻进入 pending，落地后转 ok/failed。 */
function attach(promise) {
  _state = PENDING;
  _settled = Promise.resolve(promise)
    .then((ok) => {
      // 只认严格 true。这是鉴权闸门，truthy 不等于通过（fail-closed）。
      _state = ok === true ? OK : FAILED;
      return _state === OK;
    })
    .catch(() => {
      _state = FAILED;
      return false;
    });
  return _settled;
}

function state() {
  return _state;
}

function isPending() {
  return _state === PENDING;
}

function isFailed() {
  return _state === FAILED;
}

function isAllowedCommand(command) {
  return ALLOWED_WHILE_PENDING.includes(String(command || '').trim().toLowerCase());
}

/**
 * 挂起到认证落地为止。从未 attach 时立即返回 true —— 未启用时的常态，
 * 因此这个调用在被共享的 router 里是零成本 no-op。
 */
function whenSettled() {
  return _settled || Promise.resolve(true);
}

/** 测试用：回到未接管态。 */
function reset() {
  _state = OK;
  _settled = null;
}

module.exports = {
  PENDING,
  OK,
  FAILED,
  ALLOWED_WHILE_PENDING,
  isEnabled,
  attach,
  state,
  isPending,
  isFailed,
  isAllowedCommand,
  whenSettled,
  reset,
};
