'use strict';

/**
 * _anthropicToolWire.js — Anthropic 工具线上格式的单一真源（纯叶子：零 require、零 IO）。
 *
 * 收敛四处各自为政的形状转换：
 *   - claudeAdapter.buildDirectToolDefs（input_schema，但漏了别名形状）
 *   - multiFreeService.callAnthropic:1923（input_schema，只认 parameters）
 *   - relayApiAdapter → _protocolPipeline:385（**零转换**，khy 形状 parameters 直接上线）
 *   - _toolSchemaConverter:85（另一份）
 * 其中第三处是硬缺陷：Anthropic Messages API 要求 `input_schema`，khy 治理清单产出的是
 * `{name, description, parameters}`，原样上线即 400 → 上层只能删 tools 重试 → 这一轮
 * 模型手里没有任何工具，却仍被系统提示词告知「你有 Agent/Skill/TodoWrite」。
 *
 * 另外提供端点判别：Anthropic 私有 server tool（tool_search）与 `anthropic-beta:
 * tool-search-*` 头只对官方端点下发——中转端点既不认这个 type，也没有服务端按需加载
 * schema 的能力，收到就是 400（且 _maybeRetryWithoutBetas 的正则匹配不上、不会重试）。
 */

/** env 值是否为「开」（默认关的 opt-in 语义由调用方决定）。 */
function _envOn(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

/**
 * baseUrl 是否是官方 Anthropic 端点。
 *
 * 默认（未提供 / 解析不了 / 官方域）→ true，即**保持今日字节行为**；只有明确指向
 * 非 anthropic.com 的端点才判 false。`KHY_TOOL_SEARCH_ON_RELAY=1` 可显式 opt-in
 * （确实代理了私有 tool_search 的中转）。
 *
 * @param {string} baseUrl
 * @param {object} [env]
 * @returns {boolean}
 */
function isOfficialAnthropicBase(baseUrl, env = process.env) {
  if (_envOn(env && env.KHY_TOOL_SEARCH_ON_RELAY)) return true;
  const raw = String(baseUrl == null ? '' : baseUrl).trim();
  if (!raw) return true;
  let host = '';
  try {
    host = String(new URL(raw).hostname || '').toLowerCase();
  } catch {
    return true; // 解析不了 → 保守按官方（今日行为）
  }
  if (!host) return true;
  return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
}

/**
 * 把一种工具定义形状转成 Anthropic 的 `{name, description, input_schema}`。
 *
 * 认三种入形状：
 *   1. khy 治理形状      `{name, description, parameters:{type:'object',properties,required}}`
 *   2. Anthropic 原生    `{name, description, input_schema:{...}}`
 *   3. OpenAI function   `{type:'function', function:{name, description, parameters}}`
 * 服务端工具（`type` 为 `web_search_20250305` 这类非 'function'/'tool' 的串）保留 `type`。
 *
 * @returns {{name:string, description:string, input_schema:object, type?:string}|null}
 */
function toAnthropicToolDef(def) {
  if (!def || typeof def !== 'object') return null;
  const fn = def.function && typeof def.function === 'object' ? def.function : null;
  const name = String(def.name || (fn && fn.name) || '').trim();
  if (!name) return null;
  const description = String(def.description || (fn && fn.description) || '');
  const schema = def.input_schema || def.parameters || (fn && fn.parameters) || null;
  const hasShape =
    schema && typeof schema === 'object' && (schema.type === 'object' || schema.properties);
  const out = {
    name,
    description,
    input_schema: hasShape ? schema : { type: 'object', properties: {} },
  };
  if (typeof def.type === 'string' && def.type !== 'function' && def.type !== 'tool') {
    out.type = def.type;
  }
  return out;
}

/**
 * 批量归一。认不出的条目被丢弃（调用方按「转换后是否为空」决定是否回退），
 * 绝不抛、绝不返回 undefined。
 * @returns {Array<object>}
 */
function normalizeAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const out = [];
  for (const t of tools) {
    const one = toAnthropicToolDef(t);
    if (one) out.push(one);
  }
  return out;
}

module.exports = { isOfficialAnthropicBase, toAnthropicToolDef, normalizeAnthropicTools };
