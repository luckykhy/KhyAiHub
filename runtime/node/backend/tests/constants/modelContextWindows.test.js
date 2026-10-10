'use strict';

/**
 * modelContextWindows.test.js — 已知模型上下文窗口单一真源的契约单测(node:test,零 IO)。
 *
 * 全部断言显式传 `env = {}`（或指定的假 env），不读 process.env —— 解析器第三参
 * 默认是 process.env，单测若跟着机器上的 KHY_MODEL_CONTEXT_WINDOW_MAP 走就不是
 * 单测了（与 contextWindowDefaults.resolveFallbackWindow(env = {}) 同一注入惯例）。
 *
 * 锁定四件事，每一件都对应一个曾经真实发生过的错：
 *   1. **偏小不得发生**：agnes / gemini / glm-5 / qwen-plus / kimi-k3 是 512K~1M 级，
 *      128000 会让首屏分母虚高到只剩 0.1%，用户看不见逼近边界，发请求时直接 400。
 *   2. **偏大不得发生**：deepseek-chat 官方 API 只有 64K、moonshot-v1-8k 只有 8K、
 *      qwen-turbo 只有 32K。写成 128000 会让自动压缩算晚 —— 这是「宁可写小不可写大」
 *      被违反的那一侧，且不可恢复。
 *   3. **前缀表顺序即优先级**：写反会让新代型号继承旧代的窄窗口（gpt-4.1 曾被 TUI
 *      的 `startsWith('gpt-4')` 抢走变成 8192；qwen-turbo 若被 `qwen` 抢走会从
 *      32768 虚高到 131072）。
 *   4. **env map 是新模型的活路**：KHY_MODEL_CONTEXT_WINDOW_MAP 能零代码覆盖，
 *      且畸形 JSON / 非对象 / 超天花板都不得把分母变成 0 或离谱值。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MODEL_CONTEXT_WINDOWS,
  MODEL_CONTEXT_PREFIXES,
  resolveModelContextWindow,
  pinModelContextWindow,
} = require('../../src/constants/modelContextWindows');

const {
  LIGHTWEIGHT_AGENT_MODELS,
  FREE_GOOGLE_MODELS,
  ZHIPU_DIRECT_MODELS,
  CODEX_AGENT_MODELS,
  QWEN_DIRECT_MODELS,
} = require('../../src/constants/models');

/** 与进程环境解耦的纯取值。 */
const pure = (id) => resolveModelContextWindow(id, undefined, {});

// Build reference ids from models.js to avoid hardcoding model names
const LIGHTWEIGHT_AGENT_PRIMARY = LIGHTWEIGHT_AGENT_MODELS[0];
const LIGHTWEIGHT_AGENT_GEMINI = LIGHTWEIGHT_AGENT_MODELS.find((m) => m.startsWith('gemini'));
const FREE_GOOGLE_PRIMARY = FREE_GOOGLE_MODELS[0];
const ZHIPU_DIRECT_PRIMARY = ZHIPU_DIRECT_MODELS[0];
const CODEX_AGENT_PRIMARY = CODEX_AGENT_MODELS[0];
const QWEN_DIRECT_PRIMARY = QWEN_DIRECT_MODELS[0];

describe('已知模型取值（官方文档 + models.dev live 实测）', () => {
  test('Agnes：厂商自报 512000，与规格表一致', () => {
    assert.strictEqual(pure('agnes-2.0-flash'), 512000);
    assert.strictEqual(pure('agnes-2.5-flash'), 512000);
  });

  test('Gemini 2.x/3.x：1,048,576 输入上限', () => {
    assert.strictEqual(pure(LIGHTWEIGHT_AGENT_GEMINI), 1048576);
    assert.strictEqual(pure(FREE_GOOGLE_PRIMARY), 1048576);
    assert.strictEqual(pure('gemini-2.5-pro'), 1048576);
  });

  test('GLM-5.x：厂商自报（zhipuai / zai）1,000,000', () => {
    assert.strictEqual(pure('glm-5.2'), 1000000);
    assert.strictEqual(pure('glm-5.3'), 1000000);
    // 带不带 [1m] 后缀都落 1M —— 后缀是 Coding Plan 客户端的设置，不是裸 API 上限
    assert.strictEqual(pure('glm-5.2[1m]'), 1000000);
  });

  test('GLM-4.x：4.6/4.7 是 200K；文本线 glm-4 是 131072', () => {
    assert.strictEqual(pure('glm-4.7-flash'), 200000);
    assert.strictEqual(pure('glm-4.6'), 200000);
    assert.strictEqual(pure(ZHIPU_DIRECT_PRIMARY), 131072);
  });

  test('OpenAI：gpt-5 系 400K / gpt-4.1 系 1047576 / gpt-4o 系 128000', () => {
    assert.strictEqual(pure('gpt-5'), 400000);
    assert.strictEqual(pure(CODEX_AGENT_PRIMARY), 400000);
    assert.strictEqual(pure('gpt-4.1'), 1047576);
    assert.strictEqual(pure('gpt-4o-mini'), 128000);
  });

  test('Anthropic：Opus/Sonnet 5 与 Opus 4.6-4.8 = 1M；其余 Claude = 200K', () => {
    assert.strictEqual(pure('claude-opus-5'), 1000000);
    assert.strictEqual(pure('claude-sonnet-5'), 1000000);
    assert.strictEqual(pure('claude-opus-4-6'), 1000000);
    assert.strictEqual(pure('claude-haiku-4-5'), 200000);
    assert.strictEqual(pure('claude-3-5-sonnet'), 200000);
  });

  test('Qwen 逐档：qwen-turbo 32768 不得被 qwen 的 131072 抢走', () => {
    assert.strictEqual(pure(QWEN_DIRECT_PRIMARY), 32768);
    assert.strictEqual(pure('qwen-plus'), 1000000);
    assert.strictEqual(pure('qwen3-max'), 262144);
    assert.strictEqual(pure('qwen3.7-plus'), 1000000);
  });

  test('Kimi 逐代：k3 已到 1M，k2.5 是 262144，k2 是 131072', () => {
    assert.strictEqual(pure('kimi-k3'), 1048576);
    assert.strictEqual(pure('kimi-k2.5'), 262144);
    assert.strictEqual(pure('kimi-k2'), 131072);
  });
});

describe('偏大不得发生（写大 = 运行时 400/413，不可恢复）', () => {
  test('deepseek-chat / deepseek-reasoner 官方 API 是 64K，不是 128K', () => {
    assert.strictEqual(pure('deepseek-chat'), 65536);
    assert.strictEqual(pure('deepseek-reasoner'), 65536);
    assert.ok(pure('deepseek-chat') < 128000);
  });

  test('deepseek-v4 系已到 1M', () => {
    assert.strictEqual(pure('deepseek-v4-pro'), 1000000);
    assert.strictEqual(pure('deepseek-v4-flash'), 1000000);
  });

  test('moonshot-v1 的窗口写在模型名里', () => {
    assert.strictEqual(pure('moonshot-v1-8k'), 8192);
    assert.strictEqual(pure('moonshot-v1-32k'), 32768);
    assert.strictEqual(pure('moonshot-v1-128k'), 131072);
  });

  test('GLM 视觉线 16384，与 glmVisionTextBudget 的截断阈值同值', () => {
    assert.strictEqual(pure('glm-4v-flash'), 16384);
    assert.strictEqual(pure('glm-4.6v-flash'), 16384);
    assert.strictEqual(pure('glm/glm-4.6v-flash'), 16384);
  });
});

describe('前缀表顺序即优先级（写反会让新代继承旧代的窄窗口）', () => {
  test('gpt-4.1 不被 gpt-4 抢走', () => {
    assert.strictEqual(pure('gpt-4.1'), 1047576);
    assert.strictEqual(pure('gpt-4.1-mini'), 1047576);
    assert.strictEqual(pure('gpt-4'), 8192);
    assert.strictEqual(pure('gpt-4-turbo'), 128000);
  });

  test('glm-5 不被 glm-4 抢走；glm-4.6v 归精确表不走家族', () => {
    assert.strictEqual(pure('glm-5.2'), 1000000);
    assert.strictEqual(pure('glm-4.7-flash'), 200000);
    assert.strictEqual(pure(ZHIPU_DIRECT_PRIMARY), 131072);
    assert.strictEqual(pure('glm-4.6v'), 16384);
  });

  test('llama3.2（Ollama 无连字符）与 llama-3.3（Groq/Together 带连字符）都命中', () => {
    assert.strictEqual(pure('llama3.2'), 131072);
    assert.strictEqual(pure('llama-3.3-70b-versatile'), 128000);
    assert.strictEqual(pure('meta-llama/Llama-3.3-70B-Instruct-Turbo'), 128000);
  });

  test('同前缀的更具体项排在更宽项之前', () => {
    const idx = (p) => MODEL_CONTEXT_PREFIXES.findIndex(([k]) => k === p);
    assert.ok(idx('gpt-4o') < idx('gpt-4'));
    assert.ok(idx('gpt-4.1') < idx('gpt-4'));
    assert.ok(idx('glm-5') < idx('glm-4'));
    assert.ok(idx('qwen3-max') < idx('qwen3'));
    assert.ok(idx('qwen-plus') < idx('qwen'));
    assert.ok(idx('qwen-turbo') < idx('qwen'));
    assert.ok(idx('kimi-k3') < idx('kimi'));
    assert.ok(idx('llama-4') < idx('llama-3'));
  });
});

describe('真实 model 串的四种形态都要解析得到', () => {
  test('带日期后缀的完整型号', () => {
    assert.strictEqual(pure('gpt-4o-2024-11-20'), 128000);
    assert.strictEqual(pure('gemini-2.0-flash-001'), 1048576);
    assert.strictEqual(pure('claude-sonnet-4-5-20250929'), 1000000);
    assert.strictEqual(pure('glm-4-flash-250414'), 131072);
  });

  test('通道前缀 glm/<model>', () => {
    assert.strictEqual(pure('glm/glm-4.7-flash'), 200000);
  });

  test('三段式路由 id api:<pool>:<model>', () => {
    assert.strictEqual(pure('api:glm:glm-4.7-flash'), 200000);
    assert.strictEqual(pure('api:agnes:agnes-2.0-flash'), 512000);
  });

  test('聚合网关名（含 vendor 路径与 :free 后缀）', () => {
    assert.strictEqual(pure('openrouter/z-ai/glm-5.2:free'), 1000000);
  });
});

describe('未登记模型与入参健壮性', () => {
  test('未登记 → 128000 兜底', () => {
    assert.strictEqual(pure('some-unknown-model-xyz'), 128000);
    assert.strictEqual(pure(''), 128000);
    assert.strictEqual(resolveModelContextWindow(undefined, undefined, {}), 128000);
    assert.strictEqual(resolveModelContextWindow(null, undefined, {}), 128000);
  });

  test('fallback 入参生效，且非正/非有限时退回 128000', () => {
    assert.strictEqual(resolveModelContextWindow('nope-xyz', 200000, {}), 200000);
    assert.strictEqual(resolveModelContextWindow('nope-xyz', 0, {}), 128000);
    assert.strictEqual(resolveModelContextWindow('nope-xyz', -5, {}), 128000);
    assert.strictEqual(resolveModelContextWindow('nope-xyz', NaN, {}), 128000);
  });

  test('表值一律不超过谎报天花板 1048576', () => {
    const all = [
      ...Object.values(MODEL_CONTEXT_WINDOWS),
      ...MODEL_CONTEXT_PREFIXES.map(([, v]) => v),
    ];
    for (const v of all) {
      assert.ok(Number.isInteger(v) && v > 0, `表值必须是正整数：${v}`);
      assert.ok(v <= 1048576, `表值超过天花板：${v}`);
    }
  });
});

describe('KHY_MODEL_CONTEXT_WINDOW_MAP：新模型零代码的活路', () => {
  const env = (json) => ({ KHY_MODEL_CONTEXT_WINDOW_MAP: json });

  test('覆盖一个静态表里没有的全新型号', () => {
    const e = env('{"glm-6":1000000}');
    assert.strictEqual(resolveModelContextWindow('glm-6', undefined, e), 1000000);
  });

  test('覆盖已登记的型号（用户显式值优先于静态表）', () => {
    const e = env('{"agnes-2.0-flash":128000}');
    assert.strictEqual(resolveModelContextWindow('agnes-2.0-flash', undefined, e), 128000);
  });

  test('key 大小写不敏感，且认得带 vendor 路径的 id', () => {
    const e = env('{"my-proxy/new-model":262144}');
    assert.strictEqual(resolveModelContextWindow('MY-PROXY/NEW-MODEL', undefined, e), 262144);
  });

  test('畸形 JSON / 非对象 / 空串 → 静默退回静态表，绝不把分母变成 0', () => {
    assert.strictEqual(resolveModelContextWindow('agnes-2.0-flash', undefined, env('{not json')), 512000);
    assert.strictEqual(resolveModelContextWindow('agnes-2.0-flash', undefined, env('[1,2,3]')), 512000);
    assert.strictEqual(resolveModelContextWindow('agnes-2.0-flash', undefined, env('   ')), 512000);
    assert.strictEqual(resolveModelContextWindow('agnes-2.0-flash', undefined, {}), 512000);
  });

  test('值超天花板被钳回，非正值被丢弃', () => {
    assert.strictEqual(resolveModelContextWindow('huge', undefined, env('{"huge":99999999}')), 1048576);
    assert.strictEqual(resolveModelContextWindow('zero', undefined, env('{"zero":0}')), 128000);
    assert.strictEqual(resolveModelContextWindow('neg', undefined, env('{"neg":-1}')), 128000);
    assert.strictEqual(resolveModelContextWindow('str', undefined, env('{"str":"abc"}')), 128000);
  });

  test('未在 map 里的型号不受影响', () => {
    const e = env('{"glm-6":1000000}');
    assert.strictEqual(resolveModelContextWindow('kimi-k3', undefined, e), 1048576);
    assert.strictEqual(resolveModelContextWindow('unknown-xyz', undefined, e), 128000);
  });
});

describe('pinModelContextWindow：让散落的声明式表不可能与真源漂移', () => {
  test('真源已登记 → 真源值压过声明值', () => {
    assert.strictEqual(pinModelContextWindow('agnes-2.0-flash', 128000, {}), 512000);
    assert.strictEqual(pinModelContextWindow('gpt-4', 128000, {}), 8192);
  });

  test('真源未登记 → 原样保留声明值（不静默改成 128000）', () => {
    assert.strictEqual(pinModelContextWindow('my-private-proxy-model', 654321, {}), 654321);
    assert.strictEqual(pinModelContextWindow('my-private-proxy-model', undefined, {}), 128000);
  });
});
