'use strict';

/**
 * promptOptimizeService — `prompt optimize` 的 LLM 改写层([DESIGN-PROMPT-003] §7)。
 *
 * 职责:把一条用户提示词按四步法(框架化→内容化→结构化→评分)改写为资产级提示词,返回
 * 改写稿 + 改动理由 + 改前/改后评分。**不进热路径、不自动触发**——每次显式命令 = 一次 LLM
 * 调用。评分复用纯叶子 promptStructurer.inspectPrompt(单一真源),本层只做 IO 编排。
 *
 * 门控 KHY_PROMPT_OPTIMIZE(default-on):关 → { ok:false, reason:'disabled' },零网络面。
 * 失败 fail-soft:网关不可达/超时/解析失败都返回结构化 reason,绝不抛(内部 try/catch 兜底)。
 * 依赖(env / 网关对象 / 超时)均可注入 → 无需真实 LLM 即可单测(fail-soft 面全覆盖)。
 */

const flagRegistry = require('./flagRegistry');
const promptStructurer = require('./promptStructurer');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 优化门是否启用(默认开)。委托 flagRegistry('KHY_PROMPT_OPTIMIZE');注册表关时逐字节回退手写判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPromptOptimizeEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_OPTIMIZE', e);
    }
  } catch {
    /* 注册表异常 → 回退手写判定 */
  }
  return !_off(e.KHY_PROMPT_OPTIMIZE);
}

// 优化器 system prompt 本身按 AFP 写:常量=改写规则与四步法,变量=用户提示词(作为 prompt 传入),
// 算法=框架化→内容化→结构化→评分的执行顺序与输出契约。上限护栏见 MAX_OPTIMIZER_SYSTEM_CHARS。
const MAX_OPTIMIZER_SYSTEM_CHARS = 2000; // PROMPT-001 §2:提示词模板 ≤2000 字符
const MAX_INPUT_CHARS = 12000; // 单条待优化提示词上限:超长说明输入本身就是资产,应先拆分
const DEFAULT_TIMEOUT_MS = 45000; // 单次 LLM 调用截止(网络 I/O 超时,RUNTIME-003 合法例外)

const OPTIMIZER_SYSTEM = [
  '你是提示词优化器。按「超级提示词」方法论把用户的提示词改写为资产级提示词(目标:同一类任务可复用、产出可校验)。',
  '',
  '四步法(依次执行,不跳步):',
  '1. 框架化:判定任务类型与目标。一条提示词混装多个任务时,拆出主任务,其余列为「后续」。',
  '2. 内容化:区分常量(固定背景/规范)、变量(本次具体输入,写成 {{变量名}} 占位并列出)、算法(处理步骤,边界情形写成「如果…则…」)。',
  '3. 结构化:按段输出——角色/任务/输入/约束/步骤/输出格式;约束逐条编号,可执行可检查。',
  '4. 优化:删掉或翻译愿望词(更专业/更深度/高水准/幽默点/短小精悍等不可验证的形容词),每条换成可检查判据(数量/格式/示例);补齐反幻觉规则(信息缺失或冲突→标「待确认」并提问,不编造)与收口要求(期望产出的形式 + 可执行的下一步)。',
  '',
  '硬约束:',
  '- 只改写与重组,不改变用户的真实意图,不新增用户没要求的任务。',
  '- 不确定的信息不编造:保留原样或标「待确认」。',
  '- 改写稿语言与原文一致。',
  '',
  '输出格式(严格,不加任何额外解释):',
  '<<<OPTIMIZED',
  '改写后的完整提示词',
  'OPTIMIZED>>>',
  '<<<REASONS',
  '- 每行一条改动理由(最多 5 条,说明改了什么、为什么)',
  'REASONS>>>',
].join('\n');

/** 构造优化器 system prompt(带 PROMPT-001 §2 的上限护栏;常量远低于上限,此处防未来膨胀)。 */
function buildOptimizerSystem() {
  if (OPTIMIZER_SYSTEM.length <= MAX_OPTIMIZER_SYSTEM_CHARS) {
    return OPTIMIZER_SYSTEM;
  }
  return OPTIMIZER_SYSTEM.slice(0, MAX_OPTIMIZER_SYSTEM_CHARS - 3) + '...';
}

/**
 * 解析模型输出中的改写稿与理由(确定性,绝不抛)。模型没守格式时整段当改写稿
 * (degraded:true)——弱模型高频形态,丢弃比降级更糟;理由为空由调用方如实展示。
 * @param {string} content
 * @returns {{optimized:string, reasons:string[], degraded:boolean}}
 */
function parseOptimizerOutput(content) {
  const t = String(content || '');
  const om = t.match(/<<<OPTIMIZED\r?\n([\s\S]*?)\r?\n?\s*OPTIMIZED>>>/);
  const rm = t.match(/<<<REASONS\r?\n([\s\S]*?)\r?\n?\s*REASONS>>>/);
  const optimized = om ? om[1].trim() : '';
  const reasons = rm
    ? rm[1]
        .split('\n')
        .map((s) => s.replace(/^\s*[-*·]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  if (optimized) {
    return { optimized, reasons, degraded: false };
  }
  const fallback = t.trim();
  return { optimized: fallback, reasons, degraded: !!fallback };
}

/**
 * 按方法论优化一条提示词。绝不抛;各类失败返回结构化 reason。
 *
 * @param {object} [options]
 * @param {string} [options.text]      - 待优化的提示词原文
 * @param {object} [options.env]       - 环境变量源(默认 process.env)
 * @param {object} [options.gateway]   - 注入的网关对象(测试用;默认惰性 require aiGateway)
 * @param {number} [options.timeoutMs] - 单次调用截止(默认 KHY_PROMPT_OPTIMIZE_TIMEOUT_MS 或 45000)
 * @returns {Promise<{ok:boolean, optimized?:string, reasons?:string[], degraded?:boolean,
 *   before?:object, after?:object, model?:string, provider?:string,
 *   reason?:string, detail?:string}>}
 */
async function optimizePrompt(options = {}) {
  const e = options.env || process.env || {};
  try {
    if (!isPromptOptimizeEnabled(e)) {
      return { ok: false, reason: 'disabled' };
    }
    const raw = String(options.text || '').trim();
    if (!raw) {
      return { ok: false, reason: 'empty' };
    }
    if (raw.length > MAX_INPUT_CHARS) {
      return {
        ok: false,
        reason: 'too-long',
        detail: `${raw.length} 字符 > ${MAX_INPUT_CHARS}(超长输入本身即资产,先拆分为多条再逐条优化)`,
      };
    }

    const gw = options.gateway || require('./gateway/aiGateway');
    if (!gw.isInitialized()) {
      await gw.init();
    }

    const configured = parseInt(String(e.KHY_PROMPT_OPTIMIZE_TIMEOUT_MS || ''), 10);
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : Number.isFinite(configured) && configured > 0
          ? configured
          : DEFAULT_TIMEOUT_MS;

    let timedOut = false;
    const call = gw.generate(raw, {
      system: buildOptimizerSystem(),
      temperature: 0.2,
      maxTokens: 3000,
    });
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, timeoutMs);
    });
    let res = null;
    try {
      res = await Promise.race([call, guard]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    // 超时后的迟到结果无人消费 → 挂个兜底 catch,避免 UnhandledPromiseRejection 冒泡到进程级。
    if (timedOut && call && typeof call.catch === 'function') {
      call.catch(() => {});
    }

    if (timedOut) {
      return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms 未返回` };
    }
    if (!res || res.success !== true || !res.content) {
      return {
        ok: false,
        reason: 'gateway-error',
        detail: String((res && (res.error || res.message)) || '模型无输出'),
      };
    }

    const parsed = parseOptimizerOutput(res.content);
    if (!parsed.optimized) {
      return { ok: false, reason: 'parse-failed' };
    }
    return {
      ok: true,
      optimized: parsed.optimized,
      reasons: parsed.reasons,
      degraded: parsed.degraded,
      before: promptStructurer.inspectPrompt(raw),
      after: promptStructurer.inspectPrompt(parsed.optimized),
      model: res.model || '',
      provider: res.provider || res.adapter || '',
    };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String((err && err.message) || err) };
  }
}

module.exports = {
  optimizePrompt,
  isPromptOptimizeEnabled,
  parseOptimizerOutput,
  buildOptimizerSystem,
  OPTIMIZER_SYSTEM,
  MAX_OPTIMIZER_SYSTEM_CHARS,
  MAX_INPUT_CHARS,
};