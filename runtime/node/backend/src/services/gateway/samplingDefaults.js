'use strict';

/**
 * samplingDefaults.js — 采样参数默认表（temperature / top_p / maxTokens）单一真源。
 *
 * 为什么存在：这些默认值原本散在 10 处字面量里（codexAdapter / cursor2apiAdapter /
 * traeAdapter 两处 / relayApiAdapter / localLLMService 四个后端各一处 /
 * 视觉描述通道），改一个数要翻遍适配器树，且没有任何测试钉住过它们。本叶把它们收成
 * 一张表。
 * 条目数值是各通道改前的逐项搬迁，本项不做数值调整 —— 调默认值就是调对外行为，
 * 须单独立项。
 *
 * 与强制锁的关系：仓内共有 4 处锁落点，都把 samplingPolicy.lockTemperature(userMessage) /
 * lockTopP() 当显式值传下来、覆盖用户自填的 temperature —— cli/aiMessageBuilder.js（CLI
 * 主路径）、cli/aiGatewayGenerateHelpers.js（ai-direct 的 multiFree 直连路径）、
 * gateway/adapters/localLLMAdapter.js 与 gateway/adapters/ollamaAdapter.js（后两处先算成
 * forcedTemperature/forcedTopP 再下发）。本表只在调用方没传值（无锁）时兜底。优先级是
 * 显式传入 > 强制锁 > 本表 —— 锁在网关上游先落地，表不与它互相覆盖。四处锁点由
 * samplingDefaults.test.js 的「强制锁未被顶替」逐点钉住。
 *
 * 形状仿 maxTokensPolicy：纯决策叶、零依赖、零 IO。消费方懒加载 require ——
 * 顶层 require 会进 aiGateway 冷闭包（CORE-LAYERS.json 的 L1 预算已顶格），并
 * fail-soft 回退到各自改前的字面量，与 visionDirectTurnPolicy 的消费先例一致。
 *
 * 条目只登记该通道当前确实会默认的字段；没登记的字段消费方不得凭空补（补了即改行为）。
 */

// 参数→效果语义（动表前先读）：
//   temperature — 采样随机性。越低输出越确定、可复现，越高越发散；同一提示重复运行
//     的稳定性由它决定，工具调用参数与代码片段吃低端。
//   top_p — 核采样：只在累积概率前 top_p 的候选里取样。与 temperature 同向收紧或
//     放宽，但作用在分布尾部，通常只动一个。
//   maxTokens — 单次回复的输出预算，只决定「能不能说完」，不改变内容分布；网关主路径
//     另有 maxTokensPolicy 按上下文窗口动态解析，本表只是通道侧兜底。

// 尚未收敛的范围外字面量（本项不碰；列出来免得「单一真源」被读成「已完备」）。
// 行号为本次改动时实测，只供定位，以 rg 为准：
//   adapters/claudeAdapter.js        max_tokens 兜底 16384（direct-fast-path 三元另带
//                                   DIRECT_SIMPLE_MAX_TOKENS 上限）
//   adapters/kiroAdapter.js          max_tokens 兜底 8192
//   services/googleGenAI/index.js    temperature 兜底 0.7、maxOutputTokens 兜底 8192
//   services/multiFreeService.js     temperature 兜底 0.4 两处、maxTokens 兜底 1500/1024
//                                   （另有一处 temperature:0 / maxTokens:64 的探针请求）
//   adapters/localLLMAdapter.js      maxTokens 兜底 1024
//   adapters/relayApiAdapter.js      max_tokens 兜底 4096/8192/8192/1024，全部包在
//                                   clampMaxTokensForGlmVision 里（表内 relayApi 条目
//                                   因此不登记 maxTokens）
//   aiGatewayGenerateMethod.js       视觉描述第二处嵌套调用的 maxTokens:2048（该处没有
//                                   temperature 默认）

const SAMPLING_DEFAULTS = Object.freeze({
  // 精确档（0.1–0.2）：要可复现、忠实的输出 —— 工具参数、代码、贴图描述。
  precise: Object.freeze({
    // 视觉描述通道（aiGatewayGenerateMethod 的 _visionDescribePass 嵌套调用）：
    // 描述要贴图，低温压臆造。
    visionDescribe: Object.freeze({ temperature: 0.2, maxTokens: 2048 }),
    // localLLMService 的 ollama /api/chat：think 关时直接作答。
    generateOllamaDirect: Object.freeze({ temperature: 0.1, top_p: 0.85, maxTokens: 2048 }),
    generateNodeLlama: Object.freeze({ temperature: 0.1, top_p: 0.85, maxTokens: 2048 }),
    generatePython: Object.freeze({ temperature: 0.1, top_p: 0.85, maxTokens: 2048 }),
  }),
  // 工具调用档（0.3–0.4）：工具调用链与结构化产出，允许少量措辞多样。
  toolCall: Object.freeze({
    cursor2api: Object.freeze({ temperature: 0.3, maxTokens: 4096 }),
    // maxTokens 未登记：relayApi 三处协议分支 + 一处输出预留的预算都包在
    // clampMaxTokensForGlmVision 里且取值不同（4096/8192/8192/1024），收敛需按协议
    // 拆条目，留待后续。
    relayApi: Object.freeze({ temperature: 0.3 }),
    trae: Object.freeze({ temperature: 0.4, maxTokens: 2048 }),
  }),
  // 创意档（0.6–0.7）：开放式生成，容忍发散。
  creative: Object.freeze({
    codexDirect: Object.freeze({ temperature: 0.7, maxTokens: 4096 }),
    // localLLMService 的 ollama-runner /completion：本地 brain 的原始补全路径。
    generateRunner: Object.freeze({ temperature: 0.6, top_p: 0.85, maxTokens: 1024 }),
    // 与 generateOllamaDirect 同一函数（generateOllama）的 think 开模式：思考轮要发散。
    generateOllamaThink: Object.freeze({ temperature: 0.6, top_p: 0.85, maxTokens: 2048 }),
  }),
});

function getDefaults(tier, channel) {
  const byChannel = SAMPLING_DEFAULTS[tier];
  if (!byChannel || !Object.prototype.hasOwnProperty.call(byChannel, channel)) {
    return null;
  }
  return byChannel[channel];
}

module.exports = { SAMPLING_DEFAULTS, getDefaults };
