'use strict';

/**
 * recap.js — `/recap` 命令薄壳:回顾当前会话「发生了什么」。对齐 Claude Code `/recap`
 * (CC 用一次 forked 单轮模型查询生成「离开期间」回顾)。
 *
 * **背后逻辑**(主题/决策/改动文件/命令/未决问题/洞见的抽取 + 渲染)全在既有 SSOT
 * `services/sessionRecapService.js`(`generateRecap` 确定性、零模型零网络;`formatRecap`
 * 渲染);本薄壳绝不另起炉灶,只做:门控、解析当前 sessionId(既有
 * `sessionForestService.getCurrentSessionId`)、读 chain(既有
 * `sessionPersistence.buildConversationChain`)、调用服务并打印。
 *
 * **诚实差异**:CC 的 /recap 是「离开期间」的模型生成回顾;khy 无「away 边界」追踪,故对
 * **整段当前会话**做**确定性**回顾(无模型也可用)。这与 turn-end consolidate 复用同一
 * `generateRecap` 底座;若环境有模型,本命令仍走确定性底座(模型升级只发生在后台
 * consolidate 路径,/recap 永远即时、离线、可复现,绝不阻塞等模型)。
 *
 * 门控 KHY_RECAP 默认开;关 → 命令不接管(返回 false 字节回退到既有路由兜底)。
 */

const { printInfo, printError } = require('../formatters');

function _recapEnabled(env) {
  const raw = env && env.KHY_RECAP;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function _narrativeEnabled(env) {
  const raw = env && env.KHY_NARRATIVE;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// narrative 子命令参数：[sessionId] [--mode process|result|both] [--focus task|reasoning]
// [--polish] [--out <file>]。与 hq.js 的 parseArgs 同形：--k v / --k=v 都收。
function _parseNarrativeArgs(args) {
  const out = { sessionId: null, mode: 'both', focus: 'task', polish: false, out: null };
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] || '');
    if (a === '--polish') {
      out.polish = true;
      continue;
    }
    const m = a.match(/^--?(mode|focus|out|m|f|o)(?:=(.+))?$/);
    if (m) {
      let val = m[2];
      if (val == null && i + 1 < list.length && !String(list[i + 1]).startsWith('-')) {
        val = list[++i];
      }
      const key = { m: 'mode', mode: 'mode', f: 'focus', focus: 'focus', o: 'out', out: 'out' }[m[1]];
      if (key === 'mode' && ['process', 'result', 'both'].includes(val)) {
        out.mode = val;
      } else if (key === 'focus' && ['task', 'reasoning'].includes(val)) {
        out.focus = val;
      } else if (key === 'out' && val) {
        out.out = val;
      }
      continue;
    }
    if (!a.startsWith('-') && !out.sessionId) {
      out.sessionId = a;
    }
  }
  return out;
}

/**
 * `/recap narrative` —— 任务叙事（DESIGN-ARCH-130，热奈特话语层）。
 * 故事层 collectStory → 话语层 buildNarrative → renderNarrative 成稿；
 * --polish 走 maybePolish（KHY_NARRATIVE_POLISH 默认关），润色失守锚点契约
 * 一律回退确定性骨架。全程只读 transcript，绝不写会话数据。
 */
async function _handleNarrative(args) {
  if (!_narrativeEnabled(process.env)) {
    printInfo('narrative 子命令未启用(KHY_NARRATIVE=off)。');
    return true;
  }
  const opts = _parseNarrativeArgs(args);

  let sessionId = opts.sessionId;
  if (!sessionId) {
    try {
      sessionId = require('../../services/domain/session/session/sessionForestService.js').getCurrentSessionId();
    } catch {
      /* best-effort */
    }
  }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话，或显式给出 sessionId：khy recap narrative <sessionId>。');
    return true;
  }

  let messages = [];
  try {
    messages = require('../../services/sessionPersistence').buildConversationChain(sessionId);
  } catch (e) {
    printError(`读取会话 ${sessionId} 的 transcript 失败:` + (e && e.message ? e.message : String(e)));
    return true;
  }
  if (!messages || messages.length === 0) {
    printInfo(`会话 ${sessionId} 没有可叙事的记录。`);
    return true;
  }

  const narrative = require('../../services/domain/trajectory/trajectoryNarrative');
  const { events } = narrative.collectStory(messages);
  if (events.length === 0) {
    printInfo(`会话 ${sessionId} 共 ${messages.length} 条消息，但无可叙事事件（全是元信息）。`);
    return true;
  }

  const plan = narrative.buildNarrative(events, { focus: opts.focus });
  let recap = null;
  if (opts.mode !== 'process') {
    recap = require('../../services/sessionRecapService').generateRecap(messages);
  }

  let { markdown } = narrative.renderNarrative({ plan, events, recap, sessionId, mode: opts.mode });

  if (opts.polish) {
    const polished = await narrative.maybePolish(markdown);
    if (polished.polished) {
      markdown = polished.text;
      printInfo('润色完成（模型仅改文风，证据锚点逐条校验通过）。');
    } else if (polished.reason !== 'gate-off') {
      printInfo(`润色未生效（${polished.reason}），已回退确定性骨架。`);
    }
  }

  console.log(markdown);

  if (opts.out) {
    try {
      require('fs').writeFileSync(opts.out, markdown, 'utf-8');
      printInfo(`叙事已写入 ${opts.out}（${markdown.length} 字符）。`);
    } catch (e) {
      printError(`写入 ${opts.out} 失败:` + (e && e.message ? e.message : String(e)));
    }
  }
  return true;
}

async function handleRecap(subCommand, _args = [], _options = {}) {
  if (!_recapEnabled(process.env)) {
    printInfo('recap 命令未启用(KHY_RECAP=off)。');
    return false;
  }

  if (subCommand === 'narrative') {
    return _handleNarrative(_args);
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/domain/session/session/sessionForestService.js').getCurrentSessionId();
  } catch {
    /* best-effort */
  }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /recap 回顾本次会话。');
    return true;
  }

  let messages = [];
  try {
    messages = require('../../services/sessionPersistence').buildConversationChain(sessionId);
  } catch (e) {
    printError('读取会话 transcript 失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  let recap;
  try {
    recap = require('../../services/sessionRecapService').generateRecap(messages);
  } catch (e) {
    printError('生成会话回顾失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  // 空会话:generateRecap 返回 { turns:0, sections:{} },直接走 formatRecap 会因
  // sections.topics 缺失而抛 —— 诚实降级为只打印 summary。
  if (!recap || !recap.sections || typeof recap.sections.topics === 'undefined') {
    printInfo('  ' + ((recap && recap.summary) || '空对话。'));
    return true;
  }

  let chalk = null;
  try {
    chalk = require('chalk');
  } catch {
    /* 无 chalk → formatRecap 用恒等回退 */
  }

  try {
    console.log(
      require('../../services/sessionRecapService').formatRecap(recap, chalk ? { chalk } : {})
    );
  } catch (e) {
    printError('渲染会话回顾失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }
  return true;
}

module.exports = { handleRecap };
