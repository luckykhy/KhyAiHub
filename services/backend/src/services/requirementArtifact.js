'use strict';

/**
 * requirementArtifact.js — 需求固化制品（[DESIGN-ARCH-164] §4.2-4.3）。
 *
 * 需求五问判据（source 出处）此前只活在 CI 存证层（check-agent-feedback.js 校验
 * .khy/feedback/），运行时对话从不产出可回看、可编辑、执行时可引用的需求制品。
 * 本模块补上运行时侧：澄清答案回来后，由**后端确定性组装**成用户可编辑的
 * markdown 制品（模型只产字段内容，不产文件），执行中回灌、收尾对账。
 *
 * 落点：.khy/requirements/（应用层运行态数据，经 utils/dataHome 解析，绝不字面
 * 拼接 .khy —— L-3 绕表检查）。制品生命周期：created → confirmed → amended →
 * superseded；状态只进制品头注释，无独立状态机（制品即真相，CH-1 只读豁免）。
 *
 * 全程 fail-soft：任何读写失败返回 {ok:false}，绝不阻断会话。
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../utils/dataHome');

/** 需求单目录名（.khy/requirements/，dataHome 相对）。 */
const DIR_NAME = 'requirements';

/** 同一会话在制品上的最大条目数（防失控膨胀）。 */
const MAX_ITEMS = 20;

function isEnabled(options = {}) {
  if (options && options.requirementArtifact !== undefined) {
    const raw = String(options.requirementArtifact).trim().toLowerCase();
    return ['1', 'true', 'on', 'yes'].includes(raw);
  }
  const raw = String(process.env.KHY_REQUIREMENT_ARTIFACT || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

function _dir() {
  return getDataDir(DIR_NAME);
}

/** 制品 id：YYYYMMDD-HHMMss-<4位随机>，同秒并发不撞。 */
function _newId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    '-' +
    rand
  );
}

/**
 * 从 AskUserQuestion 的问答对组装需求条目（确定性，无模型参与）。
 * @param {object} input
 * @param {Array<{question:string, answers?:object}>} input.qaTurns
 *        每轮问询 {question 或 questions, answers}；answers 形如 {问题文本: 答案}
 * @param {string} input.originalMessage  用户本轮原始消息（作为首条 source）
 * @returns {Array<{id:string,text:string,source:string,acceptance:string}>}
 */
function buildItemsFromQa(input = {}) {
  const items = [];
  const original = String(input.originalMessage || '').trim();
  if (original) {
    items.push({
      id: 'R1',
      text: original,
      source: `用户原话「${original.slice(0, 80)}」`,
      acceptance: '',
    });
  }
  const turns = Array.isArray(input.qaTurns) ? input.qaTurns : [];
  for (const turn of turns) {
    const answers = turn && turn.answers && typeof turn.answers === 'object' ? turn.answers : null;
    if (!answers) {
      continue;
    }
    for (const [q, a] of Object.entries(answers)) {
      if (items.length >= MAX_ITEMS) {
        return items;
      }
      items.push({
        id: `R${items.length + 1}`,
        text: `${String(q || '').slice(0, 120)}`,
        source: `澄清答案「${String(a || '').slice(0, 80)}」`,
        acceptance: '',
      });
    }
  }
  return items;
}

/**
 * 组装制品 markdown（纯函数，不落盘）。
 * @param {object} input
 * @param {string} input.id            制品 id
 * @param {string} input.sessionId     会话 id
 * @param {Array<{id,text,source,acceptance}>} input.items
 * @param {string} [input.status]      created|confirmed|amended|superseded
 * @returns {string}
 */
function renderArtifact(input = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const status = ['created', 'confirmed', 'amended', 'superseded'].includes(input.status)
    ? input.status
    : 'created';
  const lines = [];
  lines.push(`# 需求单 ${input.id || 'unknown'}`);
  lines.push('');
  lines.push(
    `> 会话: ${input.sessionId || 'unknown'} · 状态: ${status} · 更新: ${ts}`
  );
  lines.push('> 本文件用户可直接编辑；编辑后下一轮对话生效。每条需求必须带 source（用户原话或澄清答案）。');
  lines.push('');
  lines.push('## 需求条目');
  lines.push('');
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) {
    lines.push('- （暂无条目）');
  }
  for (const it of items) {
    lines.push(`- ${it.id}. ${it.text}`);
    lines.push(`  - source: ${it.source || '⚠ 无出处（待用户确认）'}`);
    if (it.acceptance) {
      lines.push(`  - 验收: ${it.acceptance}`);
    }
  }
  lines.push('');
  lines.push('## 收尾对账（执行完成后由系统追加）');
  lines.push('');
  return lines.join('\n');
}

/**
 * 落盘新制品。fail-soft。
 * @returns {{ok:boolean, id?:string, path?:string, error?:string}}
 */
function createArtifact(input = {}) {
  try {
    const id = input.id || _newId();
    const dir = _dir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.md`);
    const body = renderArtifact({ ...input, id, status: 'created' });
    fs.writeFileSync(file, body, 'utf8');
    return { ok: true, id, path: file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 读当前会话的需求单（回灌用）。fail-soft，读失败按无制品处理。
 * @param {string} sessionId
 * @param {string} [artifactId]  显式指定制品 id（缺省取目录内最新）
 * @returns {{ok:boolean, id?:string, path?:string, body?:string, error?:string}}
 */
function readLatestArtifact(sessionId) {
  try {
    const dir = _dir();
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();
    } catch {
      return { ok: false, error: 'requirements dir unreadable' };
    }
    if (files.length === 0) {
      return { ok: false, error: 'no artifact' };
    }
    let chosen = files[0];
    if (sessionId) {
      // 同会话优先：读头两行匹配「会话: <sessionId>」。
      const sid = String(sessionId);
      const hit = files.find((f) => {
        try {
          const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 200);
          return head.includes(`会话: ${sid} `) || head.includes(`会话: ${sid}·`);
        } catch {
          return false;
        }
      });
      if (hit) {
        chosen = hit;
      }
    }
    const file = path.join(dir, chosen);
    const body = fs.readFileSync(file, 'utf8');
    return {
      ok: true,
      id: chosen.replace(/\.md$/, ''),
      path: file,
      body,
      itemCount: (body.match(/^- R\d+\./gm) || []).length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 收尾对账：在制品尾部「收尾对账」段下追加逐条 ✓/✗/⏳ 记录（S1 只记录不阻断）。
 * 对账数据源是轮末工具日志的确定性统计（无模型参与），条目对不上号就标 ⏳。
 * @param {string} artifactId
 * @param {Array<{itemId:string, mark:'✓'|'✗'|'⏳', note:string}>} entries
 * @returns {{ok:boolean, error?:string}}
 */
function appendReconciliation(artifactId, entries) {
  try {
    if (!artifactId || !Array.isArray(entries) || entries.length === 0) {
      return { ok: false, error: 'nothing to append' };
    }
    const file = path.join(_dir(), `${String(artifactId).replace(/\.md$/, '')}.md`);
    let body;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, error: 'artifact not found' };
    }
    if (body.includes('<!-- reconciled -->')) {
      return { ok: true }; // 已对过账，不重复追加
    }
    const lines = entries.map(
      (e) => `- ${e.itemId} ${e.mark}${e.note ? `（${e.note}）` : ''}`
    );
    const stamped = `${body.replace(/\s*$/, '')}\n${lines.join('\n')}\n<!-- reconciled -->\n`;
    fs.writeFileSync(file, stamped, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  DIR_NAME,
  isEnabled,
  buildItemsFromQa,
  renderArtifact,
  createArtifact,
  readArtifact,
  readLatestArtifact,
  appendReconciliation,
  // QA 观察缓冲 + 会话级固化/对账（aiChatCore 轮末装配点专用）
  recordQaTurn,
  consumePendingQa,
  finalizeTurnArtifact,
  reconcileTurn,
  buildContextLine,
};

// ── QA 观察缓冲（[DESIGN-ARCH-164] §4.2）──────────────────────────────────────
// AskUserQuestion 的问答对在宿主控制通道（replSession.handleControlRequest）返回时
// 记入缓冲;本轮工具循环结束后由 aiChatCore 轮末装配点消费并固化为需求单。单用户
// CLI 场景只保留最近一轮的问询;consumePendingQa() 取走即清。

const _pendingQaTurns = [];
const _PENDING_CAP = 8;

/**
 * 记录一轮问答对（宿主控制通道调用,S1 只记录）。fail-soft,绝不抛。
 * @param {{questions?:Array, answers?:object}} qaTurn
 */
function recordQaTurn(qaTurn) {
  try {
    const answers = qaTurn && qaTurn.answers && typeof qaTurn.answers === 'object' ? qaTurn.answers : null;
    if (!answers || Object.keys(answers).length === 0) {
      return;
    }
    if (_pendingQaTurns.length >= _PENDING_CAP) {
      _pendingQaTurns.shift();
    }
    _pendingQaTurns.push({
      questions: Array.isArray(qaTurn.questions) ? qaTurn.questions : [],
      answers,
      at: Date.now(),
    });
  } catch {
    /* fail-soft */
  }
}

/** 取走并清空待固化问答对。 */
function consumePendingQa() {
  try {
    return _pendingQaTurns.splice(0);
  } catch {
    return [];
  }
}

/**
 * 轮末装配点：消费待固化问答对,把「最近一条用户原话 + 全部问答对」确定性组装成
 * 需求单并落盘。模型只产消息,文件由本模块拼装（防自答:每条带 source）。
 * @param {object} chatState  aiChatCore 的 _chatState（写 _requirementArtifactId 供回灌）
 * @returns {{ok:boolean, id?:string, relPath?:string, itemCount?:number, reason?:string}}
 */
function finalizeTurnArtifact(chatState) {
  try {
    const qaTurns = consumePendingQa();
    if (qaTurns.length === 0) {
      return { ok: false, reason: 'no-pending-qa' };
    }
    // 最近一条用户原话:从会话消息尾部向前找第一条非 [Tool Result] 的 user 消息。
    let originalMessage = '';
    const msgs = (chatState && Array.isArray(chatState.messages) ? chatState.messages : []).slice(
      -40
    );
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || m.role !== 'user') {
        continue;
      }
      const text = String(typeof m.content === 'string' ? m.content : '').trim();
      if (text && !text.startsWith('[Tool Result]') && !text.startsWith('[SYSTEM')) {
        originalMessage = text;
        break;
      }
    }
    const items = buildItemsFromQa({ originalMessage, qaTurns });
    const sessionId = String((chatState && chatState.liveSessionId) || '');
    const created = createArtifact({ sessionId, items, status: 'created' });
    if (!created.ok) {
      return created;
    }
    if (chatState) {
      try {
        chatState._requirementArtifactId = created.id;
      } catch {
        /* in-memory marker only */
      }
    }
    _lastArtifactId = created.id;
    return {
      ok: true,
      id: created.id,
      relPath: `${DIR_NAME}/${created.id}.md`,
      itemCount: items.length,
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

let _lastArtifactId = '';

/**
 * 读指定制品（回灌用）。fail-soft。
 * @param {string} artifactId
 * @returns {{ok:boolean, id?:string, path?:string, body?:string, itemCount?:number, error?:string}}
 */
function readArtifact(artifactId) {
  try {
    const clean = String(artifactId || '').replace(/\.md$/, '');
    if (!/^[\w-]+$/.test(clean)) {
      return { ok: false, error: 'invalid artifact id' };
    }
    const file = path.join(_dir(), `${clean}.md`);
    const body = fs.readFileSync(file, 'utf8');
    return {
      ok: true,
      id: clean,
      path: file,
      body,
      itemCount: (body.match(/^- R\d+\./gm) || []).length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 回灌引用行（[DESIGN-ARCH-164] §4.3）：要求执行中每阶段引用条目号、收尾对账、
 * 用户可编辑。读失败/空制品 → ''（不注入）。
 * @param {{ok:boolean, id?:string, itemCount?:number}} latest  readArtifact() 的返回值
 * @returns {string}
 */
function buildContextLine(latest) {
  try {
    if (!latest || !latest.ok || !latest.id) {
      return '';
    }
    const n = Math.max(0, Number.parseInt(String(latest.itemCount || 0), 10) || 0);
    if (n === 0) {
      return '';
    }
    const items = Array.from({ length: n }, (_, i) => `R${i + 1}`).join('/');
    return [
      '[SYSTEM: 需求单 requirements/',
      latest.id,
      '.md 已确认（条目 ',
      items,
      '）。执行中每个阶段的状态播报须引用条目号（如「步骤 2/5: R1 — …」）;与需求单不符时先说明差异再动手;任务收尾按条目逐项对账。该文件用户可编辑,以文件当前内容为准。',
      ']',
    ].join('');
  } catch {
    return '';
  }
}

/**
 * 轮末对账（S1 只记录,规则 2 诚实上报:不判 ✓/✗,只记证据统计,条目一律 ⏳）。
 * 同一制品只对账一次（文件内 <!-- reconciled --> 印戳幂等）。
 * @param {object} chatState
 * @param {{toolActivity?:number}} stats  本轮工具动作计数（自然循环 + 循环日志）
 * @returns {{ok:boolean, reason?:string}}
 */
function reconcileTurn(chatState, stats = {}) {
  try {
    const id =
      (chatState && chatState._requirementArtifactId) ||
      _lastArtifactId;
    if (!id) {
      return { ok: false, reason: 'no-artifact' };
    }
    const read = readArtifact(id);
    if (!read.ok) {
      return { ok: false, reason: 'artifact-missing' };
    }
    if (read.body.includes('<!-- reconciled -->')) {
      return { ok: false, reason: 'already-reconciled' };
    }
    const toolActivity = Math.max(
      0,
      Number.parseInt(String(stats.toolActivity || 0), 10) || 0
    );
    const lines = [];
    const pad = (x) => String(x).padStart(2, '0');
    const now = new Date();
    lines.push(
      `### ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} 轮末`
    );
    lines.push(
      `- 本轮检出工具动作 ${toolActivity} 次；S1 未做逐条验证比对，以下条目状态一律 ⏳ 待人工核销`
    );
    const ids = read.body.match(/^- (R\d+)\./gm) || [];
    for (const raw of ids) {
      lines.push(`- ${raw.replace(/^- /, '').replace(/\.\s*$/, '')} ⏳`);
    }
    const appended = appendReconciliation(id, [
      { itemId: lines[0], mark: '', note: '' },
      { itemId: lines[1], mark: '', note: '' },
      ...ids.map((raw) => ({
        itemId: raw.replace(/^- /, '').replace(/\.\s*$/, ''),
        mark: '⏳',
        note: '',
      })),
    ]);
    // 上面两行统计行直接借 appendReconciliation 的条目通道落盘（mark 置空）。
    return appended;
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
