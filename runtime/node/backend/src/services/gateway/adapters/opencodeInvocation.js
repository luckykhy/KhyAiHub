'use strict';

/**
 * opencodeInvocation.js — 纯叶子:把「让 khyos 指挥 opencode 代码编辑器」的调用参数
 * 构建为单一真源(零 IO、确定性、env 门控、绝不抛、可单测)。
 *
 * 背景(goal「我希望 Khyos 可以指挥 cc、opencode 等代码编辑器」):khyos 已能通过
 * cliToolAdapter / claudeAdapter / codexAdapter 指挥 Claude Code、Codex、Aider,但
 * **opencode 从未被接入为可调用的子代理**。opencode 的非交互入口是
 * `opencode run [message..]`(无位置参数时从 stdin 读 prompt;`-m provider/model`;
 * `--format default|json`;`-c/--continue`、`-s/--session` 续接会话)。本叶子只负责
 * 把这些开关规范化成参数数组 —— 真正的 spawn / 探测 / 输出捕获仍复用 cliToolAdapter
 * 既有的子进程机制(prompt 走 stdin,与 Claude Code / Codex 同一条通路)。
 *
 * 契约:零 IO(只做字符串/数组逻辑,不 require fs/net/子进程);确定性(同输入同输出);
 * 绝不抛(坏输入 → 安全回退)。
 *
 * 门控 KHY_OPENCODE(默认开,仅显式 0/false/off/no 关闭):关闭后 opencode 既不进入
 * cliToolAdapter 的探测清单,专用 opencodeAdapter 也表现为「不可用」—— 逐字节回退到
 * 「opencode 未被接入」的历史行为。
 *
 * @module services/gateway/adapters/opencodeInvocation
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_OPENCODE 默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_OPENCODE;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/**
 * opencode 的 `-m/--model` 形式为 `provider/model`(首段是 provider,其余是 model;
 * model 本身可含 `/`,如 `openrouter/z-ai/glm-5.2:free`)。故仅当首段非空且其后还有
 * 非空模型名才注入;否则让 opencode 用它自己配置的默认模型。
 */
function looksLikeProviderModel(model) {
  if (typeof model !== 'string') {
    return false;
  }
  const s = model.trim();
  const slash = s.indexOf('/');
  return slash > 0 && slash < s.length - 1;
}

/**
 * 构建 `opencode run` 的参数数组。首项固定为 `['run']` —— **prompt 不进 argv**,
 * 由 cliToolAdapter.invokeToolAsync 写入子进程 stdin(写完即 end)。
 *
 * 位置参数形态(`run <prompt>`)在 Windows 上撞死:cmd.exe /d /s /c 把整条命令行交给
 * CreateProcessW,上限 32767 字符,而 khy 递给 CLI 桥的扁平提示词带着完整系统提示
 * (人格 + 工具说明段 + 24K 预算的指令文件),第 2 句起就常态越过它。本机二分实测:
 * 32725 字符能 spawn,32763 抛 `spawn ENAMETOOLONG`。stdin 无此上限,且
 * `opencode run` 无位置参数时确实从 stdin 取词(空 stdin 报 "You must provide a
 * message or a command",写入并 end 后正常作答)—— 旧注释「读 stdin 必挂」量的
 * 是不写也不 end 的裸 pipe,不是这条通路。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]            provider/model(仅合法时注入 --model)
 * @param {('default'|'json')} [opts.format] 输出格式(default 省略;json 传 --format json)
 * @param {boolean} [opts.continueSession] 续接上一会话(--continue)
 * @param {string} [opts.sessionId]        指定会话 id(--session)
 * @param {string} [opts.agent]            指定 opencode agent(--agent)
 * @returns {string[]}
 */
function buildRunArgs(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = ['run'];
  if (o.format === 'json') {
    args.push('--format', 'json');
  }
  if (o.continueSession) {
    args.push('--continue');
  }
  if (typeof o.sessionId === 'string' && o.sessionId.trim()) {
    args.push('--session', o.sessionId.trim());
  }
  if (typeof o.agent === 'string' && o.agent.trim()) {
    args.push('--agent', o.agent.trim());
  }
  if (looksLikeProviderModel(o.model)) {
    args.push('--model', o.model.trim());
  }
  return args;
}

/**
 * 在既有参数数组上追加 `--model provider/model`(仅当模型合法)。供 cliToolAdapter 的
 * 通用 model 注入钩子调用。绝不改动入参:返回新数组;不合法 → 原样返回浅拷贝。
 */
function applyModelArg(args, model) {
  const base = Array.isArray(args) ? args.slice() : [];
  if (looksLikeProviderModel(model)) {
    base.push('--model', model.trim());
  }
  return base;
}

module.exports = {
  isEnabled,
  looksLikeProviderModel,
  buildRunArgs,
  applyModelArg,
};
