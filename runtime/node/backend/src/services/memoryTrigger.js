'use strict';

/**
 * memoryTrigger.js — 记忆「捕获侧」分类器(纯叶子,单一真源)。
 *
 * memoryTier 拥有**保留模型**(short_term/cross_session/permanent + 更新/遗忘);
 * memoryEngine.addStructuredMemory 拥有**写入**(落盘/会话存储/decideUpdate);
 * 本模块只回答一个问题:**这条用户消息要不要捕获成记忆,落到哪一层?** 三种结果:
 *
 *   - explicit  用户明确要求记住(「记住…」「请记住」「remember this」)。
 *               **必须捕获**——这是用户的直接指令,权威,不打折扣(诉求点:客户明确
 *               提出请记住时需要记住)。
 *   - proactive 用户没明说要记,但这是一条**稳定的个人事实/偏好**,值得主动留存
 *               (诉求点:什么时候触发主动记忆)。**极度保守、零假阳性偏向**——只在
 *               一条很窄的高精度白名单上触发(身份声明、稳定偏好声明),绝不去猜
 *               一次性的任务陈述。
 *   - none      无需捕获。
 *
 * 第四个入口 classifyReflection() 与上面三类**正交**:它不分类用户消息,分类 harness
 * 的结构化复盘(crossModelVerify 的 issues/suggestedFixes)——复盘此前只活在回合内,
 * 修完即丢。默认关(KHY_MEMORY_REFLECTION),详见该函数上方注释。
 *
 * 保留层推断(单源自 memoryTier.TIERS):
 *   - 含「永久/永远/别忘/forever/permanently」或稳定身份事实 ⇒ permanent
 *   - 含「临时/暂时/这次/本次会话/just for now/temporarily」 ⇒ short_term(只活本会话)
 *   - 其余明确记忆                                            ⇒ cross_session
 *
 * 稳定 topic key(主动更新的关键):身份这类「同一主题、值会变」的记忆返回固定 name
 * (`user-name`),于是再次声明会经 addStructuredMemory 的 decideUpdate **原地 supersede
 * 而非堆叠**(诉求点:主动更新)。其余记忆 name 留 null,由调用方从正文派生 slug。
 *
 * 纯函数:零 IO、零状态、不读时钟。两道独立门控(均默认开,∈{0,false,off,no} 关):
 *   KHY_MEMORY_TRIGGER     —— 捕获侧总开关(关 ⇒ 一律 none,回退到「模型自行写记忆」)。
 *   KHY_PROACTIVE_CAPTURE  —— 仅主动子层开关(关 ⇒ 只保留显式「记住」路径,最保守)。
 */

const memoryTier = require('./memoryTier');

const OFF = new Set(['0', 'false', 'off', 'no']);
const NONE = Object.freeze({ kind: 'none' });

/** 捕获侧总开关。默认开,KHY_MEMORY_TRIGGER∈{0,false,off,no} 关。 */
function isEnabled() {
  return !OFF.has(
    String(process.env.KHY_MEMORY_TRIGGER || '')
      .trim()
      .toLowerCase()
  );
}

/** 主动子层开关(独立于总开关)。默认开,KHY_PROACTIVE_CAPTURE∈{0,false,off,no} 关。 */
function isProactiveEnabled() {
  return !OFF.has(
    String(process.env.KHY_PROACTIVE_CAPTURE || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * 指令文件候选子层开关(独立于上面两个)。默认开,KHY_INSTRUCTION_CANDIDATE∈{0,false,off,no} 关。
 * 关 ⇒ instruction 分支恒不触发(逐字节退化到「不把项目约定路由到指令文件」的今日行为)。
 */
function isInstructionCandidateEnabled() {
  return !OFF.has(
    String(process.env.KHY_INSTRUCTION_CANDIDATE || '')
      .trim()
      .toLowerCase()
  );
}

// ── 触发短语 ─────────────────────────────────────────────────────────
// 显式「请记住」意图。命中即必须捕获(用户直接指令)。
const EXPLICIT_RE =
  /(记住|记一下|记下来|帮我记|存一下|存下来|以后都|从现在起|别再|不要再|remember\s+(that|this)|my\s+(name|preference)\s+is|note\s+to\s+self|请记住)/i;

// ── 系统/工具注入文本护栏 ────────────────────────────────────────────
// 这些消息是**系统构造**的,不是用户说的话,但会被当作新一轮 userMessage 送进
// classify()(agentic 循环里工具结果/收尾保障就是这样回灌的)。它们的正文常含
// 「不要再 / 别再」这类字面指令:
//   · deliverableClosure.buildClosureMessage():「[SYSTEM 收尾保障] …不要再说「让我…」…」
//   · deliveryFormatter.buildToolResultMessage():「[Tool execution results] …」
// 而 EXPLICIT_RE 为了捕获真实用户意图(「以后不要再给我看这些日志」)必须保留
// 「不要再」,于是这些系统文本被判成 explicit ⇒ 以 type:'feedback' 当作**用户偏好**
// 写进记忆库(实测污染样本:.khy/memory/.archive/feedback_system------_dd1d67bf.md,
// 正文正是「[SYSTEM: 纪律回核] …请立即二选一,不要再空谈:」)。
//
// 故在**入口**拦截:命中系统/工具注入标记 ⇒ 一律不捕获。
// 取舍(对齐本模块「零假阳性偏向」):宁可漏捕一条记忆,也绝不把系统提示词存成
// 用户偏好 —— 后者会污染每一轮召回,且删了还会再生。
// ⚠ 标记一律出现在消息**开头**,故锚 `^\s*\[`,避免误伤正文中出现的方括号。
const SYSTEM_INJECT_RE =
  /^\s*\[(?:SYSTEM|Tool execution results|Tool results|Tool output|工具执行结果)[^\]]{0,80}\]/i;

// 显式触发里偏「协作偏好/纠偏」语气的,归 feedback 类(对齐既有 _MEMORY_FEEDBACK_RE)。
const FEEDBACK_RE = /(以后|别再|不要再|from\s+now\s+on|don'?t\s+(ever\s+)?)/i;

// 保留层提示词。
const PERMANENT_HINT_RE =
  /(永久|永远|一直记|始终记|别忘|永远别忘|forever|permanently|never\s+forget)/i;
const SHORT_TERM_HINT_RE =
  /(临时|暂时|这次|本次会话|just\s+(for\s+)?now|temporar(y|ily)|for\s+this\s+session)/i;

// 稳定身份事实(高精度):姓名声明。命中 ⇒ permanent + user + 固定 topic key。
const IDENTITY_RE = /(我叫|我的名字(是|叫)|my\s+name\s+is)\s*\S/i;

// 稳定偏好声明(主动子层白名单,高精度):长期习惯而非一次性任务陈述。
const PREFERENCE_RE =
  /(我(习惯|一般|通常|总是|一直|默认)(用|使用)|我(喜欢|偏好)(用|使用)|i\s+(prefer|usually\s+use|always\s+use|generally\s+use))\s*\S/i;

// 指令文件候选(instruction 分支白名单,高精度·零假阳性偏向):**项目级长期约定 / 规范 /
// 构建命令 / 协作方式**——这类应写进指令文件(khy.md/agent.md)让它注入每回合系统提示,而非
// 落个人记忆库。只认确定形态,绝不去猜一次性任务陈述。
//   命中样例:「这个项目统一用 pnpm」「本项目约定接口都走 REST」「构建命令是 npm run build」
//            「提交前必须跑测试」「代码风格遵循 airbnb」「测试框架用 vitest」「本仓禁止直接改 main」
const INSTRUCTION_RE = new RegExp(
  [
    // 项目/本仓 + 约定/规范/统一用/规定/一律
    '(这个?|本)(项目|仓库|仓|repo|工程)[^\\n]{0,12}(统一(用|使用)?|约定|规范|规定|一律|禁止|不(要|准|得)|必须|默认(用|使用))',
    // 构建/打包/部署命令
    '(构建|编译|打包|部署|启动|测试)\\s*(命令|脚本)?\\s*(是|用|为|:|：)',
    // 提交前/合并前 必须/要/需
    '(提交|commit|合并|merge|推送|push|发布|release)前[^\\n]{0,6}(必须|要|需要|得|应)',
    // 代码风格/规范 遵循/用/是
    '(代码|编码)(风格|规范|约定)[^\\n]{0,6}(遵循|用|使用|是|为|:|：)',
    // 测试框架 / 用什么框架
    '(测试|单测)\\s*(框架|库)?\\s*(用|使用|是|为)',
    // 依赖/包管理器 统一用
    '(依赖|包管理器?|包管理工具)[^\\n]{0,6}(统一)?(用|使用)',
    // 英文:this project uses / always / never / must (团队级约定)
    '\\bthis\\s+(project|repo|codebase)\\s+(uses|always|never|must|should|requires)\\b',
    '\\b(build|test|lint)\\s+(command|script)\\s+(is|:)\\b',
  ].join('|'),
  'i'
);

// 疑问句 / 请求句(否决 instruction 触发):用户在**问**或**要求一次性动作**而非**确立约定**。
const _QUESTION_RE =
  /(吗[?？]?\s*$|怎么|如何|为什么|是不是|能不能|可不可以|帮我|请(帮|你|问)|\?\s*$|？\s*$)/;

// 去掉句首的显式触发前缀,留下干净正文(对齐 ai.js 既有 strip)。
function _stripTrigger(raw) {
  return String(raw)
    .replace(
      /^\s*(请\s*)?(帮我\s*)?(记住|记一下|记下来|帮我记|存一下|存下来|note\s+to\s+self|remember\s+(that|this))[:：,，\s]*/i,
      ''
    )
    .trim();
}

/**
 * 推断显式记忆的保留层。短期提示优先(用户说「这次/临时」就别永久占盘),
 * 再看永久提示/身份,缺省落 cross_session。
 */
function _inferTier(raw) {
  if (SHORT_TERM_HINT_RE.test(raw)) {
    return memoryTier.TIERS.SHORT_TERM;
  }
  if (PERMANENT_HINT_RE.test(raw) || IDENTITY_RE.test(raw)) {
    return memoryTier.TIERS.PERMANENT;
  }
  return memoryTier.TIERS.CROSS_SESSION;
}

/** 推断语义种类:身份→user;纠偏/偏好语气→feedback;否则 user(用户想留的事实)。 */
function _inferType(raw) {
  if (IDENTITY_RE.test(raw)) {
    return 'user';
  }
  if (FEEDBACK_RE.test(raw)) {
    return 'feedback';
  }
  return 'user';
}

/**
 * 把一条用户消息分类成捕获决策。
 *
 * @param {string} message
 * @returns {{kind:'explicit'|'proactive'|'none', name?:string|null, note?:string, tier?:string, type?:string}}
 *   - name 非 null ⇒ 稳定 topic key,调用方应原样用作记忆名(令再次声明 supersede)。
 *   - name 为 null ⇒ 调用方自行从 note 派生 slug(每条独立,不合并)。
 */
function classify(message) {
  if (!isEnabled()) {
    return NONE;
  }
  const raw = String(message || '').trim();
  if (!raw || raw.length > 2000) {
    return NONE;
  }

  // ⓪ 系统/工具注入文本:不是用户说的话 ⇒ 一律不捕获(见 SYSTEM_INJECT_RE 注释)。
  //    放在①之前,否则「[SYSTEM 收尾保障] …不要再…」会先被判成显式用户偏好。
  if (SYSTEM_INJECT_RE.test(raw)) {
    return NONE;
  }

  // ① 显式「请记住」:必须捕获。身份声明用固定 topic key 以便后续 supersede。
  if (EXPLICIT_RE.test(raw)) {
    const note = _stripTrigger(raw) || raw;
    if (IDENTITY_RE.test(note) || IDENTITY_RE.test(raw)) {
      return {
        kind: 'explicit',
        name: 'user-name',
        note,
        tier: memoryTier.TIERS.PERMANENT,
        type: 'user',
      };
    }
    return { kind: 'explicit', name: null, note, tier: _inferTier(raw), type: _inferType(raw) };
  }

  // ② 主动子层:仅在高精度白名单上触发,零假阳性偏向。
  if (isProactiveEnabled()) {
    if (IDENTITY_RE.test(raw)) {
      // 身份是「同一主题、值会变」的典型 → 固定 topic key,再次声明则更新而非堆叠。
      return {
        kind: 'proactive',
        name: 'user-name',
        note: raw,
        tier: memoryTier.TIERS.PERMANENT,
        type: 'user',
      };
    }
    if (PREFERENCE_RE.test(raw)) {
      // 不同偏好应共存(tab/空格…),故 name 留 null 按正文独立成条;同条复述经 decideUpdate skip。
      return {
        kind: 'proactive',
        name: null,
        note: raw,
        tier: memoryTier.TIERS.CROSS_SESSION,
        type: 'feedback',
      };
    }
  }

  // ③ 指令文件候选:项目级长期约定/规范 → 建议写进指令文件(khy.md/agent.md),经待审核队列。
  //    与 identity/preference 正交(那两支是个人事实,这支是项目约定)。零假阳性:命中约定
  //    白名单 且 非疑问/请求句 才成立。最保守默认 target='khy'、scope='project'(不猜 agent/global)。
  if (isInstructionCandidateEnabled()) {
    if (INSTRUCTION_RE.test(raw) && !_QUESTION_RE.test(raw)) {
      return { kind: 'instruction', target: 'khy', scope: 'project', note: raw };
    }
  }

  return NONE;
}

// ── 复盘/教训捕获(reflection 分类)────────────────────────────────────
// crossModelVerify 的 issues/suggestedFixes 此前只活在回合内:组装进 remediationPrompt
// 喂回主模型,修完即丢,下次同类任务从零开始踩同一个坑。本分类把复盘摘要成一条
// ExpeL 式教训(情境 → 问题 → 修复方向),经 memoryEngine.addStructuredMemory 落
// cross_session 层,之后由既有召回链跨会话消费——写入/原子写/内容查重/tier 全部
// 走 memoryEngine 现有公共 API,本模块仍是纯叶子(零 IO)。
//
// 默认关(KHY_MEMORY_REFLECTION ∈ {1,true,on,yes} 才开):AI 生成内容直接进长期记忆库
// 正是「低质复盘污染召回」的风险面,按 PROCESS-008 取「默认关」这一档(比 S1 观察者
// 更保守)。开着也有 score 门槛把守:只有「有问题 + 有修复方向 + 内容具体」的复盘
// 才配落库,阈值思路复用 dreamPromote 的 score≥0.9。
//
// 为什么不并进 classify():classify 的入参是**用户消息**,复盘是 harness 的结构化产出;
// 若让 classify 靠文本模式识别复盘,正好落进 SYSTEM_INJECT_RE 护栏防的那个坑(系统
// 文本冒充用户输入被当成偏好写库)。分类决策仍收在本模块(单一真源),入口分开。
const REFLECTION_ON = new Set(['1', 'true', 'on', 'yes']);
const REFLECTION_DEFAULT_MIN_SCORE = 0.9; // 同 dreamPromote DEFAULT_MIN_SCORE
const REFLECTION_MAX_ITEMS = 5; // 单条教训最多带几个问题/修复方向,防上下文膨胀
const REFLECTION_TASK_PREVIEW = 80; // 情境预览截断
const REFLECTION_ISSUE_SPECIFIC_CHARS = 15; // 问题描述「具体」的长度基准(一句中文审查意见的量级)

/** KHY_MEMORY_REFLECTION — 默认关,显式 opt-in 才捕获复盘。 */
function isReflectionEnabled(env = process.env) {
  return REFLECTION_ON.has(
    String((env && env.KHY_MEMORY_REFLECTION) || '')
      .trim()
      .toLowerCase()
  );
}

/** 质量门槛。KHY_MEMORY_REFLECTION_MIN_SCORE 可覆盖,取值 [0,1],默认 0.9。 */
function reflectionMinScore(env = process.env) {
  const v = parseFloat((env && env.KHY_MEMORY_REFLECTION_MIN_SCORE) || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : REFLECTION_DEFAULT_MIN_SCORE;
}

function _cleanList(v) {
  return (Array.isArray(v) ? v : [])
    .map((s) => String(s == null ? '' : s).trim())
    .filter((s) => s.length > 0);
}

/**
 * 复盘质量分(确定性、纯函数,不读时钟/IO;不用模型自评信心分——那不可复现、不可单测):
 *   结构完整度 = 0.5 有问题(verdict≠pass 且 issues 非空;没问题的复盘没有可学的东西)
 *              + 0.3 有修复方向(光有问题没有下一步,教训不可执行)
 *              + 0.2 修复方向对问题的覆盖度 min(fixes/issues, 1)
 *   内容具体度 = min(问题平均长度 / REFLECTION_ISSUE_SPECIFIC_CHARS, 1)(太短的多是噪声)
 *   score = 结构完整度 × 内容具体度。
 * 乘性的理由:加法形状下「有问题 + 有修复 + 全覆盖」already=0.9,'bug'/'fix' 这种三字符
 * 噪声也能过线;乘性让空泛内容真正折分。默认门槛 0.9 ⇒ 大致要「问题 + 修复 + 内容具体」
 * 齐了才落库;没有修复方向的复盘在任何具体度下都过不了 0.9。
 * @param {{verdict?:string, issues?:string[], suggestedFixes?:string[]}} reflection
 * @returns {number} [0,1]
 */
function scoreReflection(reflection) {
  const verdict = String((reflection && reflection.verdict) || '')
    .trim()
    .toLowerCase();
  const issues = _cleanList(reflection && reflection.issues);
  const fixes = _cleanList(reflection && reflection.suggestedFixes);
  if (verdict === 'pass' || issues.length === 0) {
    return 0;
  }
  const avgIssueLen = issues.reduce((s, i) => s + i.length, 0) / issues.length;
  const completeness =
    0.5 +
    (fixes.length > 0 ? 0.3 : 0) +
    0.2 * Math.min(fixes.length / issues.length, 1);
  const specificity = Math.min(avgIssueLen / REFLECTION_ISSUE_SPECIFIC_CHARS, 1);
  return Math.round(completeness * specificity * 1000) / 1000;
}

/**
 * lesson schema(与 ExpeL insight 库合并设计):正文按「情境 → 问题 → 修复方向 → 教训」
 * 组织,对齐 ExpeL「情境 + 规则」的 insight 形态;字段形状对齐 dreamPromote 回流 schema
 * (name/description/content,类型 lesson→feedback)。name 取情境(任务)而非问题——
 * 情境才是这条教训的 topic key:同一任务再次复盘走 decideUpdate skip/supersede 而不
 * 堆叠,不同任务的同类问题各自成条(ExpeL 按任务类型迁移,不合并不同情境)。
 * @returns {{name:string, description:string, content:string}}
 */
function buildLesson(reflection) {
  const issues = _cleanList(reflection && reflection.issues).slice(0, REFLECTION_MAX_ITEMS);
  const fixes = _cleanList(reflection && reflection.suggestedFixes).slice(0, REFLECTION_MAX_ITEMS);
  const task = String((reflection && reflection.task) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REFLECTION_TASK_PREVIEW);
  const reviewModel = String((reflection && reflection.reviewModel) || '').trim();

  const topic = task || issues[0] || '';
  const sentence = topic.split(/(?<=[。.!?！？])/)[0] || topic;
  const name = `跨模型复盘: ${sentence.slice(0, 60).trim()}`;
  const description = `跨模型审查发现 ${issues.length} 个问题、${fixes.length} 个修复方向`;

  const lines = [
    task ? `适用情境: ${task}` : '适用情境: (未提供任务原文)',
    `跨模型审查(${reviewModel || 'unknown'})未通过,发现 ${issues.length} 个问题:`,
    ...issues.map((i) => `- ${i}`),
  ];
  if (fixes.length > 0) {
    lines.push('建议修复方向:', ...fixes.map((f) => `- ${f}`));
  }
  lines.push(`教训: ${fixes[0] || issues[0]}`);
  return { name, description, content: lines.join('\n') };
}

/**
 * 把一次跨模型复盘分类成捕获决策(classify 的平行入口:入参是结构化复盘,不是用户消息)。
 * 门控关 / 分数不达门槛 / 产出为空 ⇒ { kind:'none' },调用方不写。
 *
 * @param {{task?:string, verdict?:string, issues?:string[], suggestedFixes?:string[], reviewModel?:string}} reflection
 * @param {object} [env]
 * @returns {{kind:'reflection', name:string, note:string, description:string, tier:string, type:string, score:number}|{kind:'none'}}
 *   note 即 lesson 正文,调用方应原样喂给 memoryEngine.addStructuredMemory 的 content。
 */
function classifyReflection(reflection, env = process.env) {
  if (!isReflectionEnabled(env)) {
    return NONE;
  }
  const score = scoreReflection(reflection);
  if (!(score >= reflectionMinScore(env))) {
    return NONE;
  }
  const lesson = buildLesson(reflection);
  if (!lesson.name || !lesson.content) {
    return NONE;
  }
  return {
    kind: 'reflection',
    name: lesson.name,
    note: lesson.content,
    description: lesson.description,
    tier: memoryTier.TIERS.CROSS_SESSION,
    type: 'feedback', // dreamPromote TYPE_MAP: lesson → feedback → cross_session
    score,
  };
}

module.exports = {
  isEnabled,
  isProactiveEnabled,
  isInstructionCandidateEnabled,
  isReflectionEnabled,
  classify,
  classifyReflection,
  scoreReflection,
  buildLesson,
  reflectionMinScore,
  _stripTrigger,
  // 暴露正则供测试与单源复用(ai.js 旧 _MEMORY_TRIGGER_RE 可逐步收敛到此)。
  EXPLICIT_RE,
  SYSTEM_INJECT_RE,
  IDENTITY_RE,
  PREFERENCE_RE,
  INSTRUCTION_RE,
  PERMANENT_HINT_RE,
  SHORT_TERM_HINT_RE,
};
