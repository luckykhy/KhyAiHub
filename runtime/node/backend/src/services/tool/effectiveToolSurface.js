'use strict';

/**
 * effectiveToolSurface.js — 「本次请求到底上线哪些工具」的**单一真源**（纯叶子）。
 *
 * 为什么存在（BUG 类：提示词与 wire 两份真源）：
 *   工具面治理原先整块内联在 `cli/aiMessageBuilder.js` 的 _gatewayGenerate 里，只有
 *   wire 一条消费者。于是系统提示词按**全注册表**（185 个名字）对模型下指令
 *   「用 Agent 派子代理 / 用 TodoWrite 维护清单」，而同一请求发到 wire 的可能是
 *   38 个（claude 直连旧池）、0 个（收尾轮 / 问候轮 / 中转剥离轮）或 curated 核心集
 *   （弱模型 / 轻量轮）。模型被指令驱动去调用线上并不存在的工具 → 执行器查无此工具 →
 *   重试/nudge → 「它说派了子代理、建了清单，其实一步没走」。
 *
 *   本模块把治理逻辑收成一处，让 wire 与提示词**调同一个函数**：
 *     - wire 侧：aiMessageBuilder 调 computeEffectiveToolDefs(opts)
 *     - 提示词侧：cli/aiChatCore 在构建系统提示词前调同一个函数，取 effectiveToolNames
 *   两侧输入相同（同一份 opts）→ 结果必然一致，不存在漂移空间。
 *
 * 契约：绝不抛（env 读取失败一律 fail-soft 回退「今日行为」）；除 computeEffectiveToolDefs
 * 内部依赖注册表/toolProfile 外零副作用。
 */

// ── 弱模型核心工具集(按需调用,非跳过)────────────────────────────
// 弱模型(实测缺原生工具调用 / flash-lite 类)注入过多工具会跑偏。仅保留日常按需最常用
// 的核心工具(搜索/读/写/改/内容搜索/文件搜索/命令/定位/提问/待办)+ mcp 视觉工具;
// 其余 160+ 工具不注入,需要时模型仍可调用这些核心工具(如「附近有什么好玩的」→ web_search)。
const _WEAK_CORE_TOOL_RE = [
  /^(websearch|web_search|webfetch|web_fetch|webbrowser)$/i,
  /^(read|readfile|read_file)$/i,
  /^(write|writefile|write_file)$/i,
  /^(edit|editfile|edit_file|multiedit)$/i,
  /^(glob|find_files)$/i,
  /^(grep|rg)$/i,
  /^(bash|shell|shellcommand|shell_command|powershell)$/i,
  /^(open_app|openapp|getlocation|get_location)$/i,
  /^(askuserquestion|todowrite|todo_write)$/i,
  /^mcp__/i,
];

function isWeakCoreTool(name) {
  const n = String(name || '').trim();
  if (!n) {
    return false;
  }
  return _WEAK_CORE_TOOL_RE.some((re) => re.test(n));
}

// ── 轻量对话工具集(「一句你好不该背 5.7 万 token 的工具表」)────────────
// 实测:一句「你好」也无条件注入 160 个工具定义 = 184KB ≈ 57784 token,冷进程构建耗时
// ~1s。这是打招呼最大的一笔确定性开销,且对招呼毫无用处。核心工具集(上面那套弱模型
// 已验证的按需集)只有 16 个 ≈ 12144 token,省下约 45k。额外放进 toolSearch(281 字节)
// 当逃生舱:轻量turn 里模型若真需要别的工具,仍可按关键词检索并在下一轮拿到全量。
// 只作用于「轻量对话」(招呼/笑话/自我介绍类,见 _isLightweightConversationInput),
// 且不作用于工具循环的后续轮(_isFollowUp)——那时已确证需要工具,全量注入。
function isLightweightConversationTool(name) {
  const n = String(name || '').trim();
  if (!n) {
    return false;
  }
  if (/^(toolsearch|tool_search)$/i.test(n)) {
    return true;
  }
  return isWeakCoreTool(n);
}

// ── 轻量对话禁用改状态工具(KHY_LIGHT_NO_MUTATING_TOOLS·默认开)──────────────
// 轻量轮(招呼/笑话/故事/自我介绍)的正确形态是直接文本回复;核心集里的
// Write/Edit/Bash 会诱导弱模型把「讲个故事」执行成「把故事写进文件」(2026-09
// 会话 2deaa521:模型把故事写向 Temp 下虚构路径,被路径守卫拒绝后又连带写出
// 无关文件并虚构任务清单)。轻量轮只保留只读/检索/搜索类工具。真正的写文件
// 任务不会命中轻量判定(_isLightweightConversationInput 排除编码/执行类输入),
// 不受影响;门关 → 回到今日核心集(逐字节等价)。
const _MUTATING_TOOL_RE =
  /^(write|writefile|write_file|edit|editfile|edit_file|multiedit|bash|shell|shellcommand|shell_command|powershell|cmd|terminal|open_app|openapp|computeruse|desktopcontrol)$/i;

function isNonMutatingLightTool(name) {
  const n = String(name || '').trim();
  if (!n) {
    return false;
  }
  return !_MUTATING_TOOL_RE.test(n);
}

function _gateOff(envName) {
  return ['0', 'false', 'off', 'no'].includes(
    String(process.env[envName] || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * 轻量对话裁剪的事前判定。判定必须**在构建之前**做:留到构建之后再 filter,160 个工具的
 * isEnabled() 已经跑完了(python --version×6 / where ffmpeg / where pwsh / git
 * rev-parse…实测 ~1.4s 阻塞子进程),而其中约 145 个马上就要被丢掉——正是
 * 「简单打个招呼却做一堆无用的事」。把名字过滤器下推到注册表,这些探测根本不发生。
 *
 * @returns {{lightCurate:boolean, lightNoMutatingOn:boolean, lightNameFilter:(function|null)}}
 */
function resolveLightCuration(opts = {}) {
  let lightCurate = false;
  try {
    const lightOff = _gateOff('KHY_LIGHT_TOOL_CURATION');
    lightCurate = Boolean(
      !lightOff && opts._lightweightConversation && !opts._isFollowUp && !opts._agentContext
    );
  } catch {
    lightCurate = false; /* fail-soft: 判定失败 → 全量注入(今日行为) */
  }
  // 轻量轮额外剥离改状态工具(Write/Edit/Bash/ComputerUse…);只在轻量裁剪生效时
  // 参与,门 KHY_LIGHT_NO_MUTATING_TOOLS 默认开,关 → 回到今日核心集。
  const lightNoMutatingOn = !_gateOff('KHY_LIGHT_NO_MUTATING_TOOLS');
  const lightNameFilter = lightCurate
    ? (name) => isLightweightConversationTool(name) && (!lightNoMutatingOn || isNonMutatingLightTool(name))
    : null;
  return { lightCurate, lightNoMutatingOn, lightNameFilter };
}

/**
 * 首轮纯问候:**一个工具都不注入**(判定在 aiChatCore 的 _pureFirstTurnGreeting 一处做完)。
 * 与轻量裁剪不是一回事:那是省 token 的优化,核心集里仍留着 Bash/Read/Glob/Grep/
 * WebSearch/toolSearch,而模型拿到这些就会把一句「你好」当成「先了解一下仓库」的开场,
 * 真的去跑命令(用户截图里的两个 Bash)。招呼要的只是一句自然回复。这里连注册表都不加载,
 * isEnabled() 探测不发生,toolSearch 也不在场——模型无从重新拿回工具。
 */
function isGreetingNoTools(opts = {}) {
  return Boolean(opts._pureFirstTurnGreeting && !opts._isFollowUp && !opts._agentContext);
}

/**
 * 治理后的工具定义数组。内部依赖注册表/toolProfile 失败时**抛给调用方**，
 * 由调用方保留既有的 authz 失败账本记录与「无工具」降级语义。
 *
 * @param {object} opts 与 _gatewayGenerate 同一份 opts（agent 上下文 / 模型名 / 轮次标志）。
 * @returns {Array<object>|undefined} undefined = 明确「本轮无工具」（问候轮）。
 */
function computeEffectiveToolDefs(opts = {}) {
  return computeToolSurface(opts).kept;
}

/**
 * computeEffectiveToolDefs 的完整形态：除了保留清单，还交出**被裁掉的清单**。
 *
 * 为什么需要 dropped：官方 Anthropic 端点可以把被预算裁剪掉的工具以 name-only
 * `defer_loading` 存根形态补回 wire，让模型仍能通过服务端 tool_search 发现它们
 * （见 _directToolSurface.resolveDirectToolSurface）。没有 dropped，适配器就不知道该补哪些。
 *
 * 注意代价（2026-11-05 实测，64K 窗口）：25 个全 schema + 167 个存根 + 私有 tool_search
 * = 15,825 token/轮，比只发 25 个全 schema + 本地 toolSearch（14,010）**贵 13%**。
 * 赢的地方在长会话——本地方案每揭示一个工具就往清单里永久加一个全 schema。
 * 故只在官方端点生效，且挂在既有 KHY_DEFER_TOOLS 门控下。
 *
 * @returns {{kept:Array<object>|undefined, dropped:Array<object>, tokensBefore:number, tokensAfter:number, budget:number}}
 */
function computeToolSurface(opts = {}) {
  const defs = _computeGovernedDefs(opts);
  if (!Array.isArray(defs)) {
    return { kept: defs, dropped: [], tokensBefore: 0, tokensAfter: 0, budget: 0 };
  }
  try {
    const { trimToBudget } = require('./toolTableBudget');
    const _r = trimToBudget(defs, {
      window: opts._contextWindow,
      isCore: isWeakCoreTool,
    });
    if (_r.dropped.length > 0 && process.env.KHY_DEBUG_TOOLS === '1') {
      // 不静默截断：丢掉的工具名必须可查（无声截断读起来像「全都覆盖到了」）。
      console.error(
        `[DEBUG-PROFILE] tool-table budget: ${_r.tokensBefore} → ${_r.tokensAfter} tokens ` +
          `(budget ${_r.budget}), dropped ${_r.dropped.length}: ` +
          `${_r.dropped.map((d) => d.name || (d.function && d.function.name)).join(',')}`
      );
    }
    return _r;
  } catch {
    /* fail-soft: 预算裁剪失败 → 全量注入(今日行为) */
    return {
      kept: defs,
      dropped: [],
      tokensBefore: 0,
      tokensAfter: 0,
      budget: 0,
    };
  }
}

/**
 * 治理链本体：问候轮清零 / agent profile / deny / 弱模型 curated / 轻量 curated。
 * **不含**预算裁剪——那一步在 computeToolSurface 里做，因为它要同时交出 dropped 清单。
 * 内部依赖注册表/toolProfile 失败时抛给调用方（由 aiMessageBuilder 记 authz 账本）。
 */
function _computeGovernedDefs(opts = {}) {
  const { lightNameFilter } = resolveLightCuration(opts);
  if (isGreetingNoTools(opts)) {
    return undefined;
  }
  const { getToolDefinitions } = require('../toolCalling');
  let toolDefs = getToolDefinitions(lightNameFilter ? { nameFilter: lightNameFilter } : {});
  if (process.env.KHY_DEBUG_TOOLS === '1') {
    console.error(
      `[DEBUG-PROFILE] BEFORE filter: ${toolDefs.length} defs, CU=${toolDefs.some((t) => (t.name || t.function?.name) === 'ComputerUse')}, DC=${toolDefs.some((t) => (t.name || t.function?.name) === 'DesktopControl')}, toolFilter=${opts._agentContext?.toolFilter || '(none)'}`
    );
  }
  // Apply tool profile filter from agent context (e.g. 'explore' → read-only tools)
  if (opts._agentContext?.toolFilter) {
    const { filterToolsByProfile } = require('../../tools/toolProfile');
    const toolsMap = new Map(toolDefs.map((t) => [t.name || t.function?.name, t]));
    const filtered = filterToolsByProfile(toolsMap, opts._agentContext.toolFilter);
    const before = toolDefs.length;
    toolDefs = [...filtered.values()];
    const after = toolDefs.length;
    if (process.env.KHY_DEBUG_TOOLS === '1') {
      console.error(
        `[DEBUG-PROFILE] _gw profileFilter=${opts._agentContext.toolFilter} ${before}->${after}`
      );
      const cu = toolDefs.find((t) => (t.name || t.function?.name) === 'ComputerUse');
      const dc = toolDefs.find((t) => (t.name || t.function?.name) === 'DesktopControl');
      console.error(`[DEBUG-PROFILE] After filter: CU=${!!cu}, DC=${!!dc}`);
    }
  }
  // Apply disallowedTools denylist as secondary safety layer
  if (opts._agentContext?.disallowedTools?.length > 0) {
    const deny = new Set(opts._agentContext.disallowedTools);
    toolDefs = toolDefs.filter((t) => !deny.has(t.name) && !deny.has(t.function?.name));
  }

  // 弱模型按需裁剪(「工具按需调用,而非跳过」):实测缺原生工具调用(text)或小名弱模型
  // (flash/lite/mini…)拿 172 个工具会跑偏——脑补「系统修复任务」去读 tool_capability.json、
  // 绕开用户的问题。这里只保留**核心按需工具集**(搜索/读/写/改/搜索/命令/定位/提问/待办 +
  // mcp 视觉),其余 160+ 不再注入:需要时(如「附近有什么好玩的」)web_search 仍在、按需调用;
  // 简单问题没有可用工具诱导 → 模型直接作答。原生工具模型不受影响(全量注入)。
  // 门 KHY_WEAK_TOOL_CURATION(默认开);关 → 字节回退今日全量注入。
  try {
    if (!_gateOff('KHY_WEAK_TOOL_CURATION') && Array.isArray(toolDefs) && toolDefs.length > 0) {
      const {
        modelLacksReliableToolCalling,
      } = require('../gateway/modelToolingCapability');
      let measured = null;
      try {
        measured = require('../gateway/toolCapabilityStore').getVerdict(opts.preferredModel || '');
      } catch {
        /* store 不可用 → 走名字启发 */
      }
      if (modelLacksReliableToolCalling(opts.preferredModel || '', { measured })) {
        toolDefs = toolDefs.filter((t) => isWeakCoreTool(t.name || (t.function && t.function.name)));
      }
    }
  } catch {
    /* fail-soft: 裁剪失败 → 全量注入(今日行为) */
  }

  // 轻量对话裁剪(「简单打个招呼不该做一堆无用的事」)。与上面的弱模型裁剪同理,但触发条件
  // 是**本轮输入**而非模型能力:招呼/笑话/自我介绍这类轻量turn(scale=small 且命中
  // _isLightweightConversationInput)注入 160 个工具纯属浪费——省 ~45k token/轮,并让
  // 模型不被一屏工具表诱导去「找活干」。工具循环的后续轮(_isFollowUp)不裁剪:那时模型
  // 已经在用工具,砍掉会截断正在进行的工作。门 KHY_LIGHT_TOOL_CURATION(默认开)。
  try {
    const { lightCurate, lightNoMutatingOn } = resolveLightCuration(opts);
    if (lightCurate && Array.isArray(toolDefs) && toolDefs.length > 0) {
      toolDefs = toolDefs.filter((t) => {
        const n = t.name || (t.function && t.function.name);
        return isLightweightConversationTool(n) && (!lightNoMutatingOn || isNonMutatingLightTool(n));
      });
    }
  } catch {
    /* fail-soft: 裁剪失败 → 全量注入 */
  }

  return toolDefs;
}

/**
 * 从工具定义数组取名字集合——**提示词侧的唯一输入**。
 * wire 与提示词因此永远描述同一批工具。
 *
 * @param {Array<object>|undefined} toolDefs
 * @returns {string[]} 空数组表示「本轮无工具」（提示词不得广告任何工具）。
 */
function effectiveToolNames(toolDefs) {
  if (!Array.isArray(toolDefs)) return [];
  const out = [];
  for (const t of toolDefs) {
    const n = t && (t.name || (t.function && t.function.name));
    if (n) out.push(String(n));
  }
  return out;
}

module.exports = {
  isWeakCoreTool,
  isLightweightConversationTool,
  isNonMutatingLightTool,
  resolveLightCuration,
  isGreetingNoTools,
  computeEffectiveToolDefs,
  computeToolSurface,
  effectiveToolNames,
};
