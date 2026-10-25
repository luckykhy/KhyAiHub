'use strict';

/**
 * confidenceCalibration.js — 「确信度校准」:开口前先判「我到底知不知道」(纯叶子:
 * 零 IO、确定性、绝不抛、可单测、数组与条目都 Object.freeze)。
 *
 * 问题(被承认的行为缺陷,本仓自评「最危险的缺陷」):生成机制天然倾向「接上一个通顺的
 * 回答」,而不是先判断自己知不知道 —— 只有一知半解时,说得和真确定时一样笃定。错误但
 * 自信的输出,比「我不知道」伤害大得多。仓库既有的诚实条款(prompts.js 677「Be honest
 * about uncertainty…」/ 2363「Separate what you KNOW, what you ASSUME…」)是**每轮静态
 * 注入的文本**,无运行时判定,也无可计量的校准样本。
 *
 * 与既有「自称 vs 工具日志」机制的分工(复核裁定,不重复计量):
 *   - claimReconciler(answerVerifier;接线 toolUseLoopCore.js:6627-6642 与
 *     aiGatewayGenerateMethod.js:1733-1756)已在**同一收尾接缝**对每一轮(含零工具轮,
 *     toolCallLog 为空仍 actions:true)把正文动作声称与工具日志对账,并把纠错追加进
 *     用户可见答复;
 *   - 但其版本化词库 CLAIM_FAMILIES 只有 delete/write/edit/test/commit/deploy 六族,
 *     「我查了/读了/核对过/I verified/read/ran」这类 **read/check 系**自称不在词库内;
 *     工具循环的两道证据门又都以「已经发生过工具调用」为前提(编辑门要求
 *     `_allModifiedFiles.size > 0`(tool/toolUseLoopCore.js:4698)、非编辑证据门要求
 *     `substantiveCalls >= threshold`(toolUseLoopCore.js:4800-4817))。零工具轮里的
 *     read/check 系自称,正是既有机制覆盖不到的那一格。
 *   - 故本叶子:①否定判定直接**复用** claimNegation._isNegatedClaim(纯叶子,不重建);
 *     ②自称扫描只收 CLAIM_FAMILIES 覆盖不到的命中,命中点落在既有族对账范围内的按
 *     「已对账」跳过 —— 同一文本不与既有机制重复计量。
 *
 * 本叶子做两件事(对应两半接线):
 *   1) 提示侧(A 层,经 selfProfile.formatForSystemPrompt 注入):一段 token 高效的
 *      「确信度自检」协议 —— 断言先分三档(本轮已验证 / 训练知识 / 未验证),未验证必须
 *      明说并给验证路径;禁用笃定措辞包装猜测;纯问答同样适用。
 *   2) 运行侧(harness 收尾 S1 观察器,见 agenticHarnessService 接线):对最终回复做
 *      **确定性**扫描,两个 finding 类:
 *        - unbacked_certainty:零工具调用的轮次里出现笃定措辞(一定/绝对/definitely…)。
 *          启发式,不作「模型错了」的断言,只落样待人复核。
 *        - unbacked_verification_claim:零工具调用**且会话历史中无工具活动记录**的轮次里,
 *          自称「我查了/我读了/我跑过/I verified…」。两条同时成立时该自称必为假(确定性,
 *          非启发式);跨轮真实引用(前几轮确实查过)由传入的 conversationMessages 排除
 *          —— 判定要求「本地无任何工具活动可背书」,不是「本轮日志为空」。
 *      S1 阶段只记录不阻断(PROCESS-008):样本旁路落账(confidenceCalibrationLedger),
 *      绝不改写回复、绝不阻止交付。
 *
 * 契约:env 门控 KHY_CONFIDENCE_CALIBRATION(默认开,仅显式 0/false/off/no 关;关闭后
 * isEnabled 返 false、formatForSystemPrompt 返 ''、observe 返 null → 两处接缝逐字节
 * 回退)。父门控经 flagRegistry 集中判定(CANON 词表),不可用时回退本地 CANON。
 * 阶段常量 KHY_CONFIDENCE_CALIBRATION_STAGE 为字面量 S1(env 同名可覆盖,只认 S2/S3,
 * 其余一律回落 S1 —— 绝不 fail-open 到更高阶段;当前**不存在**任何按阶段改变行为的
 * 路径,升档时再实现)。check-rollout-stage.js 按该常量比对登记表,漂移即报。
 *
 * 零假阳性纪律(沿用 errorEnumerationGuard 的口径):扫描器只做**记录**,不做断言
 * 「模型错了」;笃定措辞在普通推理里也常见,故记录行只带命中词与计数,由人复核 ——
 * 这正是 S1 观察期的样本定义。但否定语境(不一定/不能肯定/绝对路径)与反问式收尾
 * (在向用户澄清,不是在下结论)一律不记。
 *
 * 样本敏感性(复核实测后收紧):实质长度下限对**中文主导**回复用 40(去空白字符数),
 * 其余用 120 —— 120 对中文等于长文,61 字中文典型过度自信短答会在 120 门槛下系统性
 * 不入样,样本攒不动。中文单字信息密度高,40 是「够成一段断言」的下限;仍靠强措辞
 * 词表 + 零工具 + 非反问式收尾兜底假阳性。台账行带 replyChars,复核时可随时改口径。
 *
 * @module services/confidenceCalibration
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 落地阶段真源(PROCESS-008):字面常量,守卫可比对(先例 autoModelRouting)。
 * S1=观察者:只记录,不阻断。
 */
const KHY_CONFIDENCE_CALIBRATION_STAGE = 'S1';

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_CONFIDENCE_CALIBRATION', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_CONFIDENCE_CALIBRATION;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 生效阶段。默认 S1(观察者);仅认 S2/S3,其余一律回落 S1(绝不 fail-open 到更高阶段)。
 * @param {object} [env]
 * @returns {'S1'|'S2'|'S3'}
 */
function getStage(env) {
  const e = env || process.env || {};
  const raw = String(e.KHY_CONFIDENCE_CALIBRATION_STAGE || KHY_CONFIDENCE_CALIBRATION_STAGE)
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return KHY_CONFIDENCE_CALIBRATION_STAGE;
}

// 系统提示块的定位标记(测试 / 接缝去重)。
const CALIBRATION_MARKER = '## 确信度自检';

// 回复实质长度的下限(去空白字符数)。中文主导回复用 CJK 档(见头注释「样本敏感性」)。
const MIN_SUBSTANTIVE_CHARS = 120;
const MIN_SUBSTANTIVE_CHARS_CJK = 40;
const _CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// 数组上限(台账单行可读、可复核)。
const MAX_MARKERS = 12;
const MAX_CLAIMS = 8;
const MAX_HEDGES = 12;

// ── 既有单一真源复用(不重建否定判定/词表)─────────────────────────────────
// claimNegation 是「声称前紧邻否定」判定的单一真源纯叶子(已有专属测试);claimReconciler
// 的 CLAIM_FAMILIES 是动作声称族的版本化词库。require 失败 → 保守降级(见 _isNegated /
// _inReconciledFamily),绝不抛、绝不影响门控。
let _claimNegationLeaf = null;
try {
  _claimNegationLeaf = require('./domain/trajectory/trajectoryProvenance/claimNegation');
} catch {
  _claimNegationLeaf = null;
}
let _claimFamilies = [];
try {
  const _cr = require('./domain/trajectory/trajectoryProvenance/claimReconciler');
  _claimFamilies = _cr && Array.isArray(_cr.CLAIM_FAMILIES) ? _cr.CLAIM_FAMILIES : [];
} catch {
  _claimFamilies = [];
}

// ── 词表(强信号;全部冻结,调用方只读)────────────────────────────────────
// 笃定措辞:与「未验证内容」同现才是缺陷,故这里只收**强**措辞,不收「显然/clearly」这类
// 高频推理词(会被假阳性淹没)。中文侧靠上下文排除否定与词内混淆(不一定 / 绝对路径)。
// ⚠ 词形层的 lookbehind(绝对路径 / 未必一定 / 不敢肯定)与否定判定分工:紧邻否定(不/没/未/
// 无法/没有…)由复用的 claimNegation 判;但它的窗口(1 字紧邻 + 4 字近邻)不含**情态动词后的
// 否定**(不能/不敢/未必/没法) —— 这里按词形排除,守住「否定语境不记」的既有语义,
// 不因此去改共享叶子的判定。
const CERTAINTY_PATTERNS = Object.freeze([
  Object.freeze({ re: /(?<!未必)一定(?!程度|范围)/g, label: '一定' }),
  Object.freeze({ re: /(?<!不能|不敢|未必|没法)肯定/g, label: '肯定' }),
  Object.freeze({ re: /绝对(?!路径|值)/g, label: '绝对' }),
  Object.freeze({ re: /必然/g, label: '必然' }),
  Object.freeze({ re: /毫无疑问|毋庸置疑/g, label: '毫无疑问' }),
  Object.freeze({ re: /百分之百|100\s*%/g, label: '100%' }),
  Object.freeze({ re: /铁定|板上钉钉/g, label: '铁定' }),
  Object.freeze({ re: /\bdefinitely\b|\bcertainly\b|\bundoubtedly\b/gi, label: 'definitely' }),
  Object.freeze({ re: /\babsolutely\b|\bwithout a doubt\b/gi, label: 'absolutely' }),
  Object.freeze({ re: /\bguaranteed\b|\bfor sure\b/gi, label: 'guaranteed' }),
]);

// read/check 系第一人称自称 —— CLAIM_FAMILIES 六族(delete/write/edit/test/commit/deploy)
// 覆盖不到的盲区。命中点若同时落在既有族正则的对账窗口内,由 _inReconciledFamily 跳过
// (那份文本已由 claimReconciler/answerVerifier 对账并可能已向用户追加纠错,不重复计量)。
const VERIFICATION_CLAIM_PATTERNS = Object.freeze([
  Object.freeze({ re: /我(?:已经|已|刚才|刚)?(?:查过|查了|检查过|检查了|看过|看了|读过|读了|核对过|核对了|核实过|核实了|验证过|验证了|确认过|确认了|跑过|跑了|运行过|运行了|测试过|测试了)/g, label: 'zh:我查了/读了/验证了' }),
  Object.freeze({ re: /\bI(?:\s+have)?\s+(?:checked|verified|read|ran|tested|inspected|reviewed|confirmed)\b/gi, label: 'en:I verified/checked/ran' }),
]);

// 对冲措辞(仅作台账上下文,不参与 finding 判定)。
const HEDGE_PATTERNS = Object.freeze([
  Object.freeze({ re: /可能|也许|大概|估计|似乎|不一定|不确定|未验证|待验证|据我所知|推测|不敢肯定/g, label: 'zh:hedge' }),
  Object.freeze({ re: /\bprobably\b|\bpossibly\b|\bmaybe\b|\bmight\b|\bnot sure\b|\bunsure\b|\bunverified\b/gi, label: 'en:hedge' }),
]);

/**
 * 若匹配处前文是否定语境(不/没/未/不能/无法…),该命中不算。复用 claimNegation 纯叶子
 * —— 判定语义单一真源,不重建。复用目标不可用时保守返 true(整条跳过:少记,不误记)。
 */
function _isNegated(text, index) {
  try {
    if (_claimNegationLeaf && typeof _claimNegationLeaf._isNegatedClaim === 'function') {
      return _claimNegationLeaf._isNegatedClaim(text, index);
    }
  } catch {
    /* 复用失败 → 保守跳过 */
  }
  return true;
}

/**
 * 命中点是否落在既有 claimReconciler 动作族的对账范围内(±40 字窗口)。是 → 同一文本已由
 * answerVerifier 用户可见地纠错,本观察器跳过(不重复计量)。词库不可用 → 一律不排除
 * (此时宁可由观察器多记一条,也不静默丢掉盲区样本)。
 */
function _inReconciledFamily(text, index) {
  try {
    if (!_claimFamilies.length) {
      return false;
    }
    const win = text.slice(Math.max(0, index - 40), Math.min(text.length, index + 40));
    for (const fam of _claimFamilies) {
      const re = fam && fam.claim;
      if (!re) {
        continue;
      }
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      if (g.test(win)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 在文本上收集词表命中(应用否定排除 + 可选逐命中排除),返回去重后的标签数组(有上限)。 */
function _collect(text, patterns, cap, skipMatch) {
  const out = [];
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (_isNegated(text, m.index)) {
        continue;
      }
      if (skipMatch && skipMatch(text, m.index)) {
        continue;
      }
      if (!out.includes(p.label)) {
        out.push(p.label);
      }
      if (out.length >= cap) {
        return out;
      }
    }
  }
  return out;
}

// 回复像在向用户反问/澄清 —— 有意暂停而非下结论,绝不记录(沿用 intentCoverage /
// errorEnumerationGuard 的 _looksLikeClarification 口径)。
function _looksLikeClarification(reply) {
  const r = String(reply || '').trim();
  if (!r) {
    return false;
  }
  if (/[?？]\s*$/.test(r)) {
    return true;
  }
  return /(请问|请先确认|需要我先|你是想|是否需要|哪一个|澄清一下|which (one|of)|could you clarify|do you want me to|should i)\b/i.test(
    r
  );
}

function _replyCharsWithoutSpaces(reply) {
  return String(reply || '').replace(/\s/g, '').length;
}

/** 中文主导(非空白字符里 CJK 占一半以上)→ 用 CJK 档下限。 */
function _isCjkDominant(reply) {
  const s = String(reply || '').replace(/\s/g, '');
  if (!s) {
    return false;
  }
  let cjk = 0;
  for (const ch of s) {
    if (_CJK_CHAR_RE.test(ch)) {
      cjk++;
    }
  }
  return cjk * 2 >= s.length;
}

/** 单条消息里是否有工具活动痕迹(role:'tool' / tool_calls / 结构化 tool_result|tool_use 块)。 */
function _messageShowsToolActivity(message) {
  try {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (String(message.role || '').toLowerCase() === 'tool') {
      return true;
    }
    if (message.tool_calls || message.tool_call_id || message.toolCallId) {
      return true;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const t = block.type;
        if (t === 'tool_result' || t === 'tool_use' || t === 'tool_calls') {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 会话历史里是否已发生过工具活动(跨轮引用的排除依据)。 */
function _hasPriorToolActivity(messages) {
  try {
    if (!Array.isArray(messages)) {
      return false;
    }
    return messages.some(_messageShowsToolActivity);
  } catch {
    return false;
  }
}

/**
 * scanUnbackedClaims —— 确定性扫描最终回复:零工具调用的轮次里,找出
 * (a) 笃定措辞,(b) read/check 系自称已核验/读过/跑过。纯函数:零 IO、绝不抛。
 * @param {object} [input] {finalResponse, toolCallLog, conversationMessages, priorToolActivity}
 * @returns {{toolCalls:number, replyChars:number, floor:number, priorToolActivity:boolean, certaintyMarkers:string[], verificationClaims:string[], hedges:string[], findings:ReadonlyArray<object>}}
 */
function scanUnbackedClaims(input = {}) {
  const empty = {
    toolCalls: 0,
    replyChars: 0,
    floor: MIN_SUBSTANTIVE_CHARS,
    priorToolActivity: false,
    certaintyMarkers: [],
    verificationClaims: [],
    hedges: [],
    findings: [],
  };
  try {
    const reply = String((input && input.finalResponse) || '');
    const log = Array.isArray(input && input.toolCallLog) ? input.toolCallLog : [];
    const certaintyMarkers = _collect(reply, CERTAINTY_PATTERNS, MAX_MARKERS);
    const verificationClaims = _collect(
      reply,
      VERIFICATION_CLAIM_PATTERNS,
      MAX_CLAIMS,
      _inReconciledFamily
    );
    const hedges = _collect(reply, HEDGE_PATTERNS, MAX_HEDGES);
    const replyChars = _replyCharsWithoutSpaces(reply);
    const toolCalls = log.length;
    const priorToolActivity =
      (input && input.priorToolActivity === true) ||
      _hasPriorToolActivity(input && input.conversationMessages);
    const floor = _isCjkDominant(reply) ? MIN_SUBSTANTIVE_CHARS_CJK : MIN_SUBSTANTIVE_CHARS;

    const findings = [];
    // 只在「零工具调用」这一缺口场景下产出 finding —— 有工具调用的轮次另有既有证据门
    // (toolUseLoopCore 4671-4869)在管,不再叠报。
    if (toolCalls === 0 && replyChars >= floor && !_looksLikeClarification(reply)) {
      if (certaintyMarkers.length > 0) {
        findings.push(
          Object.freeze({
            kind: 'unbacked_certainty',
            evidence: Object.freeze(certaintyMarkers.slice(0, 6)),
          })
        );
      }
      // 自称核验的确定性前提是「本次运行**任何地方**都没有工具活动可背书」:本轮日志为空
      // 且会话历史无工具痕迹。跨轮真实引用(前几轮查过、这轮引用)不算假——历史里有工具
      // 活动即跳过本判定(仍保留 certainty 判定,它是启发式、不以「必为假」立论)。
      if (verificationClaims.length > 0 && !priorToolActivity) {
        findings.push(
          Object.freeze({
            kind: 'unbacked_verification_claim',
            evidence: Object.freeze(verificationClaims.slice(0, 6)),
          })
        );
      }
    }

    return Object.freeze({
      toolCalls,
      replyChars,
      floor,
      priorToolActivity,
      certaintyMarkers: Object.freeze(certaintyMarkers),
      verificationClaims: Object.freeze(verificationClaims),
      hedges: Object.freeze(hedges),
      findings: Object.freeze(findings),
    });
  } catch {
    return Object.freeze({
      ...empty,
      certaintyMarkers: Object.freeze([]),
      verificationClaims: Object.freeze([]),
      hedges: Object.freeze([]),
      findings: Object.freeze([]),
    });
  }
}

/**
 * observe —— harness 收尾观察器入口(纯):门控关 → null(调用方逐字节回退,不记任何
 * 东西);开 → 冻结的扫描报告 + 生效阶段。绝不抛。
 * @param {object} [input] {finalResponse, toolCallLog, conversationMessages, priorToolActivity, env}
 * @returns {object|null}
 */
function observe(input = {}) {
  try {
    const o = input || {};
    if (!isEnabled(o.env)) {
      return null;
    }
    const scan = scanUnbackedClaims(o);
    return Object.freeze({
      enabled: true,
      stage: getStage(o.env),
      toolCalls: scan.toolCalls,
      replyChars: scan.replyChars,
      floor: scan.floor,
      priorToolActivity: scan.priorToolActivity,
      certaintyMarkers: scan.certaintyMarkers,
      verificationClaims: scan.verificationClaims,
      hedges: scan.hedges,
      findings: scan.findings,
    });
  } catch {
    return null;
  }
}

/**
 * 系统提示注入块(A 层)。token 高效:协议六行。门控关 → ''(接缝逐字节回退)。
 * @param {object} [opts] {env}
 * @returns {string}
 */
function formatForSystemPrompt(opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) {
    return '';
  }
  return [
    CALIBRATION_MARKER + '(先判「我到底知不知道」,再落笔;这是纪律,不是建议)',
    '对事实性断言先分三档:',
    '- 本轮已验证(工具读过 file:line / 跑过命令)→ 直接断言,注明依据。',
    '- 训练知识(未验证但稳定)→ 一般语气陈述;不得暗示「刚查过 / 已确认」。',
    '- 未验证 / 一知半解 → 明说「未验证 / 不确定」,并给一条可执行的验证路径(要读的文件 / 要跑的命令)。',
    '禁用:不得用「一定 / 肯定 / 绝对 / 必然 / 毫无疑问 / 100%」或 definitely / obviously 之类笃定措辞包装未验证内容。',
    '零工具调用的纯问答同样适用:说「不知道」不扣分,把猜测说成确定才扣分。',
    '[SYSTEM: Confidence calibration — before committing to any factual claim, classify it: verified this session (cite the evidence) | stable training knowledge (never fake "just checked") | unverified (say so plainly + name the check that would settle it). Never dress an unverified guess in certainty wording.]',
  ].join('\n');
}

module.exports = {
  isEnabled,
  getStage,
  CALIBRATION_MARKER,
  KHY_CONFIDENCE_CALIBRATION_STAGE,
  MIN_SUBSTANTIVE_CHARS,
  MIN_SUBSTANTIVE_CHARS_CJK,
  scanUnbackedClaims,
  observe,
  formatForSystemPrompt,
  // 内部导出供测试。
  _looksLikeClarification,
  _isNegated,
  _hasPriorToolActivity,
  _claimNegationLeaf,
  _claimFamilies,
};
