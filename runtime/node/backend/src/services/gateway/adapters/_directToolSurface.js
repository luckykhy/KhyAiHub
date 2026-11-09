'use strict';

/**
 * _directToolSurface.js — Claude 直连路径工具面的**单一出口**（纯叶子：零 require、零 IO）。
 *
 * 为什么存在（BUG 类：提示词与 wire 两份真源）：
 *   `claudeAdapter.runClaudeDirect` 原先用 `buildDirectToolDefs()`（registry.assembleToolPool
 *   (undefined,'coding')）**自建**一份 38 工具的清单，从不读 `options.tools`。于是
 *   `aiMessageBuilder` 侧由 `getToolDefinitions()` 产出、并经过四道治理
 *   （agent toolProfile / disallowedTools deny / 弱模型 curated / 轻量轮 curated）的清单
 *   在 direct 分支被一个字节都不用；`_forceNoTools`（toolUseLoop 的强制收尾轮）也一并失效。
 *   后果是模型被系统提示词命令去调用线上并不存在的工具（Agent/Skill/TodoWrite/WebFetch …），
 *   只读子代理反而拿到完整写/执行池，readFile 与 Read 等五对重复名同时在场。
 *
 * 本模块把「本次请求到底上线哪些工具」收敛成一个函数：治理清单（options.tools）优先，
 * 只有在调用方没有提供清单时才回退到 legacy 自建池——与同仓 `codexAdapter.buildDirectToolDefs()`
 * （先 getToolDefinitions() 再套白名单）同一范式。
 *
 * 契约：
 *   - 绝不抛（任何异常都由调用方的 try 包裹；本函数自身只做形状判断）。
 *   - `_forceNoTools === true` → `[]`：收尾轮权威，与 aiMessageBuilder.js 的
 *     `toolDefs = undefined` 语义一致（那条路在本模块看不到，故显式判 true）。
 *   - `options.tools` 为数组 → 非空则转换后上线；空数组 → `[]`（治理方明确判定「无工具」）。
 *   - 非数组 / 转换后为空 → `fallback()`（今日字节行为，老调用方不受影响）。
 *
 * 线上形状转换（parameters → input_schema 等）与端点判别同在 ./_anthropicToolWire.js
 * ——那一处是四个适配器共用的单一真源，本模块不重复实现。
 */

const { toAnthropicToolDef, normalizeAnthropicTools, isOfficialAnthropicBase } = require('./_anthropicToolWire');

/** deferral 门控：与 claudeAdapter._deferralActive() 同语义（KHY_DEFER_TOOLS !== '0'）。 */
function _deferralOn(env = process.env) {
  return String((env && env.KHY_DEFER_TOOLS) ?? '') !== '0';
}

/** Anthropic 私有 server-side tool search（官方端点专属，严格中转会 400）。 */
const TOOL_SEARCH_PSEUDO = { type: 'tool_search_tool_regex_20251119', name: 'tool_search' };

/**
 * 解析本次请求应上线的 Claude 直连工具面。
 *
 * @param {object} options 适配器收到的 options（网关原样透传 aiMessageBuilder 的那份）。
 * @param {() => any[]} [fallback] 无治理清单时的兜底（= 旧 buildDirectToolDefs）。
 * @param {object} [ctx] { baseUrl } —— 官方端点判定用；缺省按「非官方」（保守，不发私有协议）。
 * @returns {any[]} Anthropic 形状的工具定义数组；调用方按 `length > 0` 决定是否写 body.tools。
 */
function resolveDirectToolSurface(options, fallback, ctx = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const _fallback = typeof fallback === 'function' ? fallback : () => [];

  // 1) 强制收尾轮：toolUseLoop 要求模型只能产出文本（弱模型否则会一直重调同一工具、
  //    永远写不出收尾答案）。此处权威判定——即使治理方忘了把 toolDefs 置空。
  if (opts._forceNoTools === true) return [];

  // 2) 治理清单：aiMessageBuilder → gw.generate(options.tools)。
  if (Array.isArray(opts.tools)) {
    if (opts.tools.length === 0) return []; // 治理方明确判定「本轮无工具」
    const converted = normalizeAnthropicTools(opts.tools);
    // 一个都没认出来 → 形状完全不认识，回退 legacy 池而不是发半份/空份。
    if (converted.length === 0) return _fallback();
    return _appendDeferralStubs(converted, opts, ctx);
  }

  // 3) 老调用方不传 tools → 今日行为（legacy 自建池），字节不变。
  return _fallback();
}

/**
 * 官方端点专属：把被工具表预算裁掉的工具以 name-only `defer_loading` 存根补回 wire，
 * 并附上 Anthropic 私有 server-side tool search，让模型仍能发现它们。
 *
 * **为什么只在官方端点**：`defer_loading` 存根依赖服务端按需回填完整 schema，
 * `tool_search_tool_regex_20251119` 是 Anthropic 私有 type。严格中转两者都不认
 * （收到即 400，而 claudeAdapter._maybeRetryWithoutBetas 的正则匹配不上、不会重试）。
 * 非官方端点走本地 `toolSearch`（khy 真工具，已被 toolTableBudget 提为永远保留）。
 *
 * **代价**（2026-11-05 实测，64K 窗口，167 个被裁）：+1,815 token/轮 ≈ +13%。
 * 换来长会话里「揭示不膨胀」——本地方案每揭示一个工具就往清单里永久加一个全 schema。
 * 短任务亏、长会话赚，盈亏平衡点约 3.3 个被揭示的工具。故默认只在官方端点开，
 * 并挂在既有 KHY_DEFER_TOOLS 门控下（置 '0' 即回到「只发全 schema」）。
 *
 * **对 prompt/wire 不变量的影响**：wire 会多于提示词广告的数量（25 全 schema +
 * N 个裸名存根）。不变量退化为「提示词广告的每个工具都在 wire 上且带完整 schema」——
 * 方向仍然安全（提示词不承诺线上没有的东西），但模型会看见提示词未提及的名字，
 * 弱模型可能盲调存根（Anthropic 会报错并指向 tool_search，可自纠但费一轮）。
 */
function _appendDeferralStubs(converted, opts, ctx) {
  const dropped = opts._droppedToolDefs;
  if (!Array.isArray(dropped) || dropped.length === 0) return converted;
  if (!_deferralOn(ctx.env || process.env)) return converted;
  // 私有协议要**显式**判定：baseUrl 必须真的给出来且落在 anthropic.com 域内。
  // （isOfficialAnthropicBase 对空值返回 true 是为兼容 legacy 路径的字节行为，
  //   但「往线上发 Anthropic 私有 type」不能靠默认值放行。）
  const baseUrl = String((ctx && ctx.baseUrl) || '').trim();
  if (!baseUrl) return converted;
  if (!isOfficialAnthropicBase(baseUrl, ctx.env || process.env)) return converted;

  const seen = new Set(converted.map((t) => t.name));
  const stubs = [];
  for (const d of dropped) {
    const name = d && (d.name || (d.function && d.function.name));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    stubs.push({ name: String(name), defer_loading: true });
  }
  if (stubs.length === 0) return converted;
  return [...converted, ...stubs, { ...TOOL_SEARCH_PSEUDO }];
}

module.exports = { resolveDirectToolSurface, toAnthropicToolDef };