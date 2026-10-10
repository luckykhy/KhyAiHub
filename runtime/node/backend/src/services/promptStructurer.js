'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 procedureCatalog.js / planModeDirective.js 的形状——
//   isEnabled 委托 flagRegistry(注册表关时 _off 逐字节回退);判定/构造全在叶子、绝不抛、门关返
//   null;接线(toolUseLoop.js currentMessage 赋值处)只做 IO、包一层 try/catch fail-soft。
//   别把结构化逻辑写进接线处、别漏 try/catch、别让叶子抛。

/**
 * promptStructurer.js
 *
 * 「把用户发给模型的提示词先做结构化处理」的**单一真源**(纯叶子)。
 *
 * 诉求(goal 2026-07-06「我希望以后我发给 ai 的提示词,都先做结构化处理后再发给模型,
 * 提示词 = 结构 + 内容」):用户的自由文本在送进模型前,统一包一层**确定性结构**——把请求
 * 解析成「任务类型 / 关键动作 / 约束 / 期望产出」几个槽位(= 结构),再原样附上用户原文
 * (= 内容)。让弱模型据结构快速抓住意图,据内容执行;结构是对内容的解析,**冲突时以原文为准**,
 * 因此绝不改写、绝不删减用户的一个字——只在其上叠加一层可解析的脚手架。
 *
 * 与既有件的关系(同「结构化输入 / 弱模型引导」族,正交):
 *  - inputSanitizer   —— 去噪(控制字符 / 标点洪水),不改语义、不加结构。
 *  - promptIntentRepair —— 乱码时提示模型宽容推断意图(产 [SYSTEM] 指令,不动用户消息)。
 *  - procedureCatalog —— 命中某类任务时注入整套编号 SOP(任务执行流程)。
 *  - 本件 promptStructurer —— 把**用户这一条消息**本身重排成「结构 + 内容」(输入形态)。
 *  四者可叠加:结构化后的用户消息之上,仍可再被 planning / procedure 等 [SYSTEM] 前言包裹。
 *
 * 纯叶子:无 I/O、无随机、无时钟、无副作用、确定性、绝不抛。只做文本分类与结构化拼装;
 * 「什么时候把结构化结果赋回 currentMessage」这类副作用留给上层(toolUseLoop 接线)。
 *
 * 门控 KHY_PROMPT_STRUCTURING(默认开):关 → buildStructuredPrompt 恒返 null,
 * 接线处逐字节回退(currentMessage 保持用户原文,等价于本引擎从未存在)。
 *
 * 成本感知(/goal 2026-07-08):结构块是纯附加 token(`## 内容` 已含完整原文,结果必为原文超集,
 * 单条提示词上不可能省 token)。仅当任务够实质、结构前缀能在**对话层**帮弱模型少走试错轮次、把这份
 * token 挣回来时才包裹;纯问候 / 极短 / 无结构信号的消息 → 保持原样(见 isWorthStructuring)。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 委托 flagRegistry 单一声明式真源;注册表自门控(KHY_FLAG_REGISTRY)关时,逐字节回退到本文件
// 私有 _off 手写判定(CANON 4 词 + 归一)。此模式照抄自 procedureCatalog.js / planModeDirective.js。
const flagRegistry = require('./flagRegistry');
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 结构化处理是否启用(默认开,仅显式 0/false/off/no 关闭)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_STRUCTURING', e);
    }
  } catch {
    /* 注册表异常 → 回退手写判定 */
  }
  return !_off(e.KHY_PROMPT_STRUCTURING);
}

// 结构化包裹的稳定标记:已带此前缀的消息不再二次结构化(幂等,避免循环/嵌套包裹)。
const STRUCTURE_MARKER = '[结构化提示词]';

// ── 确定性任务分类(单一真源)─────────────────────────────────────────────
// 每类:key(稳定键) / label(中文短标签) / output(该类期望产出) / patterns(命中正则,双语)。
// 按数组顺序**首个命中**判类(顺序即优先级);都不中 → general。刻意用词面正则、无 LLM,确定性可测。
const TASK_TYPES = Object.freeze([
  Object.freeze({
    key: 'debug',
    label: '调试 / 修复',
    output: '根因定位 + 最小修复(含验证方式)',
    patterns: [
      /修复|修一下|报错|错误|异常|崩溃|失败|不工作|无法|bug|debug|error|crash|broken|not work|fix\b|失效/i,
    ],
  }),
  Object.freeze({
    key: 'code',
    label: '编码 / 实现',
    output: '可运行的代码 / 补丁(必要时含用法说明)',
    patterns: [
      /实现|编写|写(一?个|段|个)?(函数|方法|组件|接口|类|脚本|程序|代码)|生成代码|开发|重构|加(一?个)?功能|implement|refactor|\bcode\b|\bfunction\b|component|\bclass\b|\bAPI\b|build (a|an|the)/i,
    ],
  }),
  Object.freeze({
    key: 'research',
    label: '调研 / 检索',
    output: '结论 + 依据来源(注明不确定处)',
    patterns: [
      /调研|查一?下|搜索|检索|了解一?下|最新|find out|search|research|investigate|look up|latest|current/i,
    ],
  }),
  Object.freeze({
    key: 'plan',
    label: '规划 / 设计',
    output: '编号的结构化计划 / 方案(步骤 + 关键点)',
    patterns: [
      /计划|规划|设计(一?个|方案)?|方案|架构|策略|如何着手|怎么做|\bplan\b|design (a|an|the)|architecture|strategy|roadmap/i,
    ],
  }),
  Object.freeze({
    key: 'explain',
    label: '解释 / 说明',
    output: '分层解释(先结论,再要点,必要时举例)',
    patterns: [
      /解释|说明|讲(一?下|讲)|是什么|为什么|为何|原理|区别|explain|what is|what are|why (is|do|does)|how does|difference/i,
    ],
  }),
  Object.freeze({
    key: 'write',
    label: '写作 / 文案',
    output: '成稿文本(结构清晰,契合用途)',
    patterns: [
      /写(一?篇)?(文档|文章|说明|readme|邮件|文案|总结|摘要)|翻译|润色|总结一?下|draft|summariz|translate|rewrite/i,
    ],
  }),
]);

// 约束线索标记(命中的从句作为「约束」抽出)。双语,尽量覆盖高频硬性要求措辞。
const CONSTRAINT_MARKERS =
  /(必须|务必|一定要|不要|不能|不得|禁止|请勿|只(能|需|要)|仅(限|需)?|保证|确保|注意|限制|不许|must\b|should not|shouldn'?t|do ?n'?t|never\b|only\b|always\b|avoid\b|ensure\b|require|not allowed)/i;

// 疑问线索:命中 → 期望产出偏向「问题的直接答复」。
const QUESTION_MARKERS =
  /[?？]|如何|怎么|怎样|是否|能不能|可不可以|what|why|how|which|when|where|whether|can (i|you|we)/i;

// 抽象层级线索(提示词资产化 · 可复用性判断:「处理这只猫」vs「搞定猫科动物」)。
//   category = 面向可复用/成类的请求(所有/每个/凡是/通用/批量/以后都…、all/every/any/reusable…);
//   instance = 面向具体一次性的请求(这个/这只/当前/此/该…、this specific);缺省取 instance
//   (多数请求本就是一次性的,不为通用而通用——只有显式成类线索才升级为 category)。
const CATEGORY_MARKERS =
  /所有|每(个|一个|次|类)|凡是|任何|一类|一批|批量|统一|通用|规范化?|模板化?|可复用|复用|以后(都|均|一律)?|今后|一律|generic|reusable|template|every\b|each\b|\ball\b|whenever|going forward/i;
const INSTANCE_MARKERS =
  /这(个|只|条|段|里|次|份)?|此(处|文件|问题|次)?|当前|该(文件|问题|函数|条)?|我这|眼前|我的|this (specific|one|particular)|just this|right here/i;

// 纯问候句:整句仅由问候词(可带语气助词/标点)构成,无实质请求。用于「关键动作」跳过开场白——
// 「你好,那么我要做 X」的首句「你好」不该被当成关键动作。要求整句锚定匹配(^…$),避免误吞
// 「你好吗?能不能…」这类问句里的实质诉求。
const GREETING_ONLY =
  /^(你好|您好|哈啰|哈喽|嗨|嘿|hi|hello|hey|hiya|greetings)[\s,，.。!!?？~～、]*$/i;

function _clip(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= n) {
    return t;
  }
  // Guard against splitting a surrogate pair: if the cut point lands on a high surrogate,
  // back off one code unit so the pair (or at least the high surrogate alone) stays intact.
  const cut = n - 1;
  const ch = t.charCodeAt(cut);
  if (ch >= 0xd800 && ch <= 0xdbff) {
    return t.slice(0, cut) + '…';
  }
  return t.slice(0, cut) + '…';
}

/**
 * 对一段用户文本做确定性结构化分类。纯函数,绝不抛。
 * @param {string} text
 * @returns {{taskType:string, label:string, action:string, constraints:string[], expectedOutput:string, isQuestion:boolean, hasCode:boolean, scope:string, scopeLabel:string}}
 */
function classify(text) {
  const raw = typeof text === 'string' ? text : String(text == null ? '' : text);
  const hasCode = /```|~~~|\n\s{4,}\S/.test(raw);
  const isQuestion = QUESTION_MARKERS.test(raw);

  // 任务类型:首个命中即取(数组顺序=优先级);都不中 → general。
  let matched = null;
  for (const t of TASK_TYPES) {
    if (t.patterns.some((re) => re.test(raw))) {
      matched = t;
      break;
    }
  }
  const taskType = matched ? matched.key : 'general';
  const label = matched ? matched.label : '通用请求';

  // 关键动作:取首个**实质句**,截断展示。刻意只按句末标点(。.!?!?/换行)切句——**绝不含逗号/顿号**,
  // 否则「你好,那么我要做 X」会被首个逗号截成「你好」,让关键动作沦为一句问候、看着像原文被丢弃
  //(其实 ## 内容 原文一字未动)。再跳过纯问候开场句,取首个带实质内容者;都无则退回首句兜底。
  const sentences = raw
    .split(/[。.!?！？\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const firstSentence = sentences.find((s) => !GREETING_ONLY.test(s)) || sentences[0] || '';
  const action = _clip(firstSentence, 80) || '(见内容)';

  // 约束:逐从句(中英文标点 / 逗号 / 顿号 / 换行切分)抽出含约束标记者,去重、限量、截断。
  const clauses = raw
    .split(/[。;；，,、\n]|(?<=[.!?])\s/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const constraints = [];
  for (const c of clauses) {
    if (!CONSTRAINT_MARKERS.test(c)) {
      continue;
    }
    const clipped = _clip(c, 90);
    if (!clipped || seen.has(clipped)) {
      continue;
    }
    seen.add(clipped);
    constraints.push(clipped);
    if (constraints.length >= 5) {
      break;
    }
  }

  // 期望产出:任务类型给基线;纯疑问且未命中具体类型 → 偏「问题的直接答复」。
  let expectedOutput = matched
    ? matched.output
    : isQuestion
      ? '问题的直接、准确答复'
      : '直接完成请求并给出结果';
  if (!matched && isQuestion) {
    expectedOutput = '问题的直接、准确答复';
  }

  // 抽象层级(可复用性判断):显式成类线索且无一次性线索 → category(猫科动物);否则 instance(这只猫)。
  const scope = CATEGORY_MARKERS.test(raw) && !INSTANCE_MARKERS.test(raw) ? 'category' : 'instance';
  const scopeLabel = scope === 'category' ? '可复用类别(猫科动物)' : '具体实例(这只猫)';

  return {
    taskType,
    label,
    action,
    constraints,
    expectedOutput,
    isQuestion,
    hasCode,
    scope,
    scopeLabel,
  };
}

// ── 提示词资产化判断透镜(单一真源)──────────────────────────────────────────
// /goal 追加的三条判断标准,附在结构块后,引导模型把请求往「可复用资产」形态取舍。子门控
// KHY_PROMPT_STRUCTURING_ASSET_LENS(parent KHY_PROMPT_STRUCTURING)关时不追加(逐字节回退到无透镜)。
const ASSET_LENS = [
  '## 复用性判断 / Asset Lens',
  '以「提示词资产化」标准审视本次请求(据任务性质取舍,不为通用而通用,与原文冲突仍以原文为准):',
  '- 可复用性:是在处理「这只猫」,还是搞定「猫科动物」?能沉淀成可复用方案/规则的,别只解这一次。',
  '- 场景性:是在「调教演员」(把这一次演出做好),还是「搭建舞台」(建可复用的环境/脚手架)?优先搭台。',
  '- 工作流:是在「加速试错」,还是「消灭试错」?能一次做对 / 根治的,别用更快的反复试错代替。',
].join('\n');

/**
 * 资产化判断透镜是否启用(子门控,parent=KHY_PROMPT_STRUCTURING;父关→子必关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function assetLensEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_STRUCTURING_ASSET_LENS', e);
    }
  } catch {
    /* 注册表异常 → 回退手写判定 */
  }
  // 注册表关:父子任一被显式关闭即关(手写复现父→子优先级)。
  return !_off(e.KHY_PROMPT_STRUCTURING) && !_off(e.KHY_PROMPT_STRUCTURING_ASSET_LENS);
}

/**
 * 构造资产化判断透镜段。门关 / 异常 → 空串(caller 不追加)。
 * @param {object} [env]
 * @returns {string}
 */
function buildAssetLens(env) {
  try {
    return assetLensEnabled(env) ? ASSET_LENS : '';
  } catch {
    return '';
  }
}

// ── 方法论规则(复杂任务时把反幻觉/取舍/收口三条硬规则注入结构块)───────────────
// [DESIGN-PROMPT-003] §4 的落点:复杂任务才有编造与跑偏空间,规则只随复杂任务注入(简单请求
// 靠 execution_discipline 全局段兜底,不加噪——与「禁止区不过度工程」自洽)。三条都是确定性
// 文字常量,零 LLM;冲突仍以原文为准。子门控 KHY_PROMPT_STRUCTURING_METHOD_RULES
// (parent KHY_PROMPT_STRUCTURING)关时不追加(逐字节回退到无方法论规则的结构块)。
const METHOD_RULES = [
  '## 方法论规则 / Method Rules',
  '执行本次请求时遵守以下三条(与 ## 内容 冲突时仍以内容为准):',
  '- 信息缺失/冲突:标「待确认」并提问补齐,不编造事实;以合理假设推进时,显式说明假设前提。',
  '- 约束冲突:显式说明取舍(保留什么、放弃什么、为什么),不静默弃掉任何一条约束。',
  '- 交付收口:给出可执行的下一步(动作或命令),不留悬空结尾。',
].join('\n');

/**
 * 方法论规则是否启用(子门控,parent=KHY_PROMPT_STRUCTURING;父关→子必关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function methodRulesEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_STRUCTURING_METHOD_RULES', e);
    }
  } catch {
    /* 注册表异常 → 回退手写判定 */
  }
  return !_off(e.KHY_PROMPT_STRUCTURING) && !_off(e.KHY_PROMPT_STRUCTURING_METHOD_RULES);
}

/**
 * 构造方法论规则段。门关 / 异常 → 空串(caller 不追加)。
 * @param {object} [env]
 * @returns {string}
 */
function buildMethodRules(env) {
  try {
    return methodRulesEnabled(env) ? METHOD_RULES : '';
  } catch {
    return '';
  }
}

// ── 愿望词黑名单(单一真源,prompt normalize 体检与 check-ai-gateway 守卫共用)─────
// [DESIGN-PROMPT-003] §4.1:愿望词(作为质量指令的不可验证形容词)必须翻译成参数化指令。
// 词面正则、确定性可测;刻意保守——只收「形容词级质量指令」高频形态,避免把身份描述/
// 可验证指令误伤。命中是候选不是判决,LOW 级 advisory,人工评审兜底。
const WISHWORD_PATTERNS = Object.freeze([
  /更专业|更深度|更有逻辑|更高级|更智能/i,
  /(专业|幽默|高级|生动)点/,
  /像大厂/,
  /接地气/,
  /高水准/,
  /高级感/,
  /专业一点|震撼一点|好看一点|漂亮一点|写得(再)?好一点/,
  /\bhighly capable\b/i,
  /\bshort and concise\b/i,
  /\bbe extra concise\b/i,
  /\bdo not overdo it\b/i,
  /\bmore professional\b/i,
]);

// ── 代码化提示词(复杂任务时把请求写成逻辑精确的声明式规格)────────────────────────
// /goal(2026-07-06 追加):复杂任务下自然语言力不从心(歧义 / 冗余 / 非线性跳跃),而 AI 的核心
// 强项是逻辑推理,代码是所有表达里最求极致逻辑性的——故复杂请求值得再叠一层「代码化」表达:把已
// 解析出的结构(任务/范围/约束/期望)写成一段 ```spec 声明式规格,消歧、线性化、可被逻辑推理直接
// 消费。**仅复杂任务触发**(简单请求结构+内容已足够,不加噪);**仍是原文的逻辑重述,冲突以原文为准**。
// 子门控 KHY_PROMPT_STRUCTURING_CODE_SPEC(parent KHY_PROMPT_STRUCTURING)。

// 时序 / 并行连接词(复杂度信号之一,镜像 toolUseLoop._isComplexTask 的 connectives 维度精神)。
const SEQUENCE_MARKERS =
  /先.*(再|后)|然后|接着|之后|首先|其次|最后|同时|分别|再者|步骤|第[一二三四五六1-9]步|\b(then|first|next|finally|after that|also|as well as|in addition)\b/i;
// 动作动词(多动作 = 复杂,镜像 _isComplexTask 的 action-verb 维度)。
const ACTION_VERBS =
  /(修改|创建|删除|添加|新增|修复|重构|实现|集成|迁移|优化|部署|配置|fix|add|create|update|remove|refactor|implement|integrate|migrate|deploy|configure)/gi;

/**
 * 复杂度多维打分(确定性,纯函数,绝不抛)。维度:长度 / 从句数 / 约束数 / 时序连接词 /
 * 多动作动词 / 含代码,各命中 +1。isComplex(≥2·并触发代码化) 与 isWorthStructuring(≥1·结构化总门)
 * 共用此单一真源,避免两处启发式漂移。
 * @param {string} text
 * @returns {number} 0..6
 */
function _complexityScore(text) {
  const raw = typeof text === 'string' ? text : '';
  const info = classify(raw);
  let score = 0;
  if (raw.replace(/\s+/g, '').length >= 80) {
    score += 1;
  }
  const clauses = raw
    .split(/[。;；.!?！？\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length >= 3) {
    score += 1;
  }
  if (info.constraints.length >= 2) {
    score += 1;
  }
  if (SEQUENCE_MARKERS.test(raw)) {
    score += 1;
  }
  if ((raw.match(ACTION_VERBS) || []).length >= 2) {
    score += 1;
  }
  if (info.hasCode) {
    score += 1;
  }
  return score;
}

/**
 * 是否复杂任务(确定性启发式,纯函数,绝不抛)。多维打分 ≥2 判复杂——
 * 长度 / 从句数 / 约束数 / 时序连接词 / 多动作动词 / 含代码。对齐 toolUseLoop._isComplexTask 的精神
 * (那是循环里的私有函数,本叶子自带独立实现以保持零依赖、可单测)。
 * @param {string} text
 * @returns {boolean}
 */
function isComplex(text) {
  try {
    const raw = typeof text === 'string' ? text : '';
    const t = raw.trim();
    if (t.length < 24) {
      return false;
    } // 太短必不复杂,早退
    return _complexityScore(raw) >= 2;
  } catch {
    return false;
  }
}

// ── 结构化「值不值」的成本感知门(单一真源)────────────────────────────────
// /goal(2026-07-08「结构化的目的是省 token / 让 khy 更高效理解;没用就不如原样」):结构块是**纯附加
// token**——`## 内容` 已含完整原文,结构化结果永远是原文的**超集**,不可能在单条提示词上省 token。它唯一
// 能净省的场景是**对话层**:面对够复杂的任务,一段结构前缀帮弱模型一次抓住意图、少走几轮 2000-token 的
// 试错,前缀成本才挣得回来。对「你好」/清晰的一句话命令,没有试错可省 → 结构纯属 20~120x 的浪费。
// 故:只在任务够实质(打分 ≥1,比代码化的 ≥2 低一档——轻量结构比 ```spec 便宜)时才结构化;
// 纯问候 / 极短 / 无任何结构信号的消息 → 保持原样。此门不加新 flag:关掉它就等于恢复「给每条你好也套 240
// token」的浪费,正是本次要消除的反模式;主门 KHY_PROMPT_STRUCTURING 关仍是「全部原样」的总逃生口。
const MIN_STRUCTURE_CHARS = 12; // 去空白绝对下限:再有信号也不结构化极短消息(问候/确认/单命令)

/**
 * 这条消息是否**值得**结构化(成本感知,纯函数,绝不抛)。false → caller 逐字节回退到原文。
 * @param {string} text
 * @returns {boolean}
 */
function isWorthStructuring(text) {
  try {
    const raw = typeof text === 'string' ? text : '';
    const t = raw.trim();
    if (!t) {
      return false;
    } // 空:无可结构化
    if (GREETING_ONLY.test(t)) {
      return false;
    } // 纯问候:原样即最清晰
    if (t.replace(/\s+/g, '').length < MIN_STRUCTURE_CHARS) {
      return false;
    } // 极短:意图已原子,结构纯噪声
    return _complexityScore(raw) >= 1; // 有任一实质结构信号才值得付这份 token
  } catch {
    return false; // fail-soft:判定失败 → 保守取原样(不结构化)
  }
}

/** 代码化提示词是否启用(子门控,parent=KHY_PROMPT_STRUCTURING;父关→子必关)。 */
function codeSpecEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_STRUCTURING_CODE_SPEC', e);
    }
  } catch {
    /* 注册表异常 → 回退手写判定 */
  }
  return !_off(e.KHY_PROMPT_STRUCTURING) && !_off(e.KHY_PROMPT_STRUCTURING_CODE_SPEC);
}

/**
 * 构造代码化提示词(```spec 声明式规格)。门关 / 非复杂任务 / 异常 → 空串(caller 不追加)。
 * 内容全部取自 classify 已解析的确定性字段;是原文的逻辑重述,不替代原文。
 * @param {string} text
 * @param {object} [env]
 * @returns {string}
 */
function buildCodeSpec(text, env) {
  try {
    if (!codeSpecEnabled(env)) {
      return '';
    }
    if (typeof text !== 'string' || !text.trim()) {
      return '';
    }
    if (!isComplex(text)) {
      return '';
    } // 仅复杂任务代码化,简单请求不加噪
    const info = classify(text);
    // 「冲突以原文为准」在表头已声明一次,spec 内只在末尾 RULE 再声明一次即止——不要满屏重复。
    const lines = [
      '```spec',
      '# 代码化:请求的逻辑精确重述,供推理直接消费。',
      `TASK        ${info.label}`,
      `SCOPE       ${info.scopeLabel}`,
      `GOAL        ${info.action}`,
    ];
    if (info.constraints.length) {
      lines.push('CONSTRAINTS');
      for (const c of info.constraints) {
        lines.push(`  - ${c}`);
      }
    } // 无约束不发占位:「(无显式约束)」是缺省噪声(与 bullet 一致)
    lines.push(`EXPECT      ${info.expectedOutput}`);
    if (info.hasCode) {
      lines.push('HAS_CODE    true');
    } // 仅在含代码时发;false 是缺省噪声,省之
    lines.push('RULE        原文的逻辑重述,不新增/不删减语义;冲突以 ## 内容 为准。');
    lines.push('```');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 把一段用户文本包裹成「结构 + 内容」的结构化提示词。
 * 门关 / 空输入 / 已结构化 / 异常 → 返 null(接线处不改写,逐字节回退)。
 * @param {string} text 用户原始消息
 * @param {object} [env]
 * @returns {string|null} 结构化后的消息,或 null(表示不做处理)
 */
function buildStructuredPrompt(text, env) {
  try {
    if (!isEnabled(env)) {
      return null;
    }
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    } // 空输入:无可结构化
    if (trimmed.startsWith(STRUCTURE_MARKER)) {
      return null;
    } // 幂等:已结构化不再包裹(首字前可有空白)
    if (!isWorthStructuring(text)) {
      return null;
    } // 成本感知:不值得结构化 → 原样(省 token)

    const info = classify(text);
    return _structureParts(text, info, env);
  } catch {
    return null; // fail-soft:结构化绝不反噬,失败即等价于未处理
  }
}

/** 结构块正文的组装(spec 与 bullet 二选一 + 方法论规则 + 资产透镜)。 */
function _structureParts(text, info, env) {
  // 表头压缩为单行:两个不可省语义——①这是对请求的结构解析(供快速抓意图)②冲突以「## 内容」原文为准。
  const parts = [
    `${STRUCTURE_MARKER} 下面是对你请求的结构解析(帮你快速抓意图);任何冲突以「## 内容」原文为准。`,
    '',
    '## 结构 / Structure',
  ];
  // 结构只出**一种**表示,绝不重复:复杂任务用声明式 ```spec(已含 任务/范围/动作/约束/期望,更紧、更精确),
  // 其余用轻量 bullet。两种表示字段完全重合,同时出即冗余——故 spec 在则不再出 bullet;spec 不在(简单任务
  // 或代码化子门控关)才回退 bullet。bullet 亦只发带正信号的行:「关键动作」对短请求 = 下方内容的逐字复述
  //(内容一眼可见)纯冗余,故不发——需要「主诉一句话」指针的长/复杂任务由 spec 的 GOAL 承担。约束仅有时发、
  // 含代码仅含时发、抽象层级仅成类时发;任务类型/期望产出恒发(派生信号,原文里本没有)。
  const spec = buildCodeSpec(text, env);
  if (spec) {
    parts.push(spec);
  } else {
    parts.push(..._bulletStructure(info));
  }
  // 方法论规则:仅复杂任务(spec 在)时追加——反幻觉/取舍/收口三条,简单请求不注入。
  const methodRules = spec ? buildMethodRules(env) : '';
  if (methodRules) {
    parts.push('', methodRules);
  }
  // 资产化判断透镜:仅 category 作用域 + 子门控开时追加(与透镜「不为通用而通用」自洽;instance 纯噪声)。
  const lens = info.scope === 'category' ? buildAssetLens(env) : '';
  if (lens) {
    parts.push('', lens);
  }
  parts.push('', '## 内容 / Content', text);
  return parts.join('\n');
}

/** spec 不适用时的轻量 bullet 结构行。 */
function _bulletStructure(info) {
  const bullets = [`- 任务类型: ${info.label}`];
  if (info.constraints.length) {
    bullets.push(`- 约束: ${info.constraints.join(' / ')}`);
  }
  if (info.hasCode) {
    bullets.push('- 含代码/引用: 是');
  }
  if (info.scope === 'category') {
    bullets.push(`- 抽象层级: ${info.scopeLabel}`);
  }
  bullets.push(`- 期望产出: ${info.expectedOutput}`);
  return bullets;
}

// ── 静态体检(§4.1 机器化,prompt normalize 的判定内核)──────────────────────────────
// 确定性四查:愿望词 / 条件分支 / 反幻觉规则 / 收口声明。只报不改(报告含建议,改动由人决定);
// 命中与漏检都是候选不是判决——advisory 级,人工评审兜底。词面取自书 B1–B3 与本仓 prompts.js 盘点。
const IFTHEN_RE =
  /(如果|若|当|一旦|万一|倘若|假如).{0,40}?(则|就|请|应|需)|否则|不然|\bif\b[\s\S]{0,60}?\bthen\b|\botherwise\b/i;
const ANTIHALLUCINATION_RE =
  /(不(要|得|许|可)?(编造|虚构|捏造|臆测|杜撰|猜测)|没有(依据|来源|出处).{0,10}(说明|标注|不要|不得|不能)|标(注)?[「『"]?待确认|不确定.{0,12}(提问|追问|标注|说明|如实)|do not (make up|fabricate|invent|guess)|don'?t (make up|fabricate|invent|guess)|(if|when) (unsure|uncertain|unclear).{0,24}(ask|say so|state))/i;
const CLOSING_RE =
  /(期望产出|输出(格式|要求|形式|结构)|输出.{0,12}(清单|表格|报告|列表|文件|代码|命令|步骤|方案|文档|json|markdown)|交付(物|格式|形式)|格式(如下|要求|为)|以.{0,12}(json|markdown|表格|列表|代码|报告|清单)形式|返回.{0,12}(格式|字段|结构|示例|清单|表格|列表|json)|给出.{0,12}(清单|表格|报告|步骤|命令)|分点|逐条列出|report\s+format|output\s+format|deliverable)/i;

/**
 * 列出文本命中的愿望词(去重,确定性,绝不抛)。与 WISHWORD_PATTERNS 同源——
 * prompt normalize 体检与 check-ai-gateway 守卫共用,避免两份黑名单漂移。
 * @param {string} text
 * @returns {string[]}
 */
function findWishwords(text) {
  const t = String(text || '');
  const hits = [];
  for (const re of WISHWORD_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const m = t.match(new RegExp(re.source, flags));
    if (m) hits.push(...m.map((s) => s.trim()));
  }
  return Array.from(new Set(hits));
}

/**
 * 提示词静态体检(确定性,零 LLM,绝不抛):愿望词/条件分支/反幻觉/收口四项。
 * 返回 { score, grade, complex, findings, wishwords };只报不改——原文一字不动。
 * @param {string} text
 * @returns {{score:number, grade:string, complex:boolean, findings:Array, wishwords:string[]}}
 */
function inspectPrompt(text) {
  const t = String(text || '');
  const findings = [];
  let score = 100;
  const wishwords = findWishwords(t);
  if (wishwords.length) {
    const deduction = Math.min(30, wishwords.length * 15);
    score -= deduction;
    findings.push({
      id: 'wishword',
      deduction,
      message: `愿望词 ${wishwords.length} 处: ${wishwords.join(' / ')}`,
      advice: '形容词不可验证——换成可检查判据(数量/格式/示例),或直接删除',
    });
  }
  const complex = isComplex(t);
  if (complex && !IFTHEN_RE.test(t)) {
    score -= 15;
    findings.push({
      id: 'no-branch',
      deduction: 15,
      message: '复杂任务无条件分支',
      advice: '把边界情形写成 If-Then(条件→动作),让模型不靠猜',
    });
  }
  if (complex && !ANTIHALLUCINATION_RE.test(t)) {
    score -= 15;
    findings.push({
      id: 'no-antihallucination',
      deduction: 15,
      message: '复杂任务无反幻觉规则',
      advice: '加一条:信息缺失/冲突→标「待确认」并提问,不编造事实',
    });
  }
  if (!CLOSING_RE.test(t)) {
    score -= 20;
    findings.push({
      id: 'no-closing',
      deduction: 20,
      message: '未声明期望产出/收口形式',
      advice: '写明交付物与格式(如「以表格返回」「给出可执行的下一步」)',
    });
  }
  score = Math.max(0, score);
  const grade = score >= 85 ? '良好' : score >= 70 ? '可用' : '待改进';
  return { score, grade, complex, findings, wishwords };
}

module.exports = {
  isEnabled,
  assetLensEnabled,
  codeSpecEnabled,
  methodRulesEnabled,
  classify,
  isComplex,
  isWorthStructuring,
  buildStructuredPrompt,
  buildAssetLens,
  buildCodeSpec,
  buildMethodRules,
  findWishwords,
  inspectPrompt,
  STRUCTURE_MARKER,
  TASK_TYPES,
  ASSET_LENS,
  METHOD_RULES,
  WISHWORD_PATTERNS,
};
