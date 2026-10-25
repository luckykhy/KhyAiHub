'use strict';

/**
 * discourse.js — 话语层（discourse）：热奈特五范畴算子，StoryEvent[] → NarrativePlan。
 *
 * DESIGN-ARCH-130。故事层的事件按真实时序进入，本模块决定「怎么讲」：
 *
 *   时序 Order   —— 顺叙为主；同一文件被折返修改时标倒叙（analepsis，
 *                   「回到第 k 步」）；开篇的结果预告（预叙 prolepsis）由
 *                   render.js 在文档层承担。
 *   时距 Duration —— 场景 scene：失败、写入、长耗时、用户请求逐拍呈现；
 *                   概要 summary：常规只读步骤压缩成一句；
 *                   省略 ellipsis：无信息事件（turn 统计、空段）丢弃；
 *                   停顿 pause：thinking 段转成叙述性反思（仅内聚焦）。
 *   频率 Frequency —— 复数叙述：同一工具对同一目标的连续 N 次调用合并为
 *                   「N 次尝试 X（第 k 次成功）」。
 *   语式 Mood    —— 聚焦由 opts.focus 决定：'task' 外聚焦（只讲做了什么），
 *                   'reasoning' 内聚焦（thinking 进入叙事）。距离：场景=展示
 *                   （直接引用命令与错误一行），概要=叙述。
 *   语态 Voice   —— 固定：外叙述者、事后叙述、第三人称「KHY」。
 *
 * 纯函数：无 IO、无时钟、无模型。同一份 events ⇒ 同一份 plan。
 */

const { KIND } = require('./storyCollect');

const DEFAULT_SCENE_MS = 10000;

// 工具名 → 中文动词（语态层的人称叙述基底）。按小写前缀匹配，兼容 read2 之类变体。
const TOOL_VERBS = [
  ['read', '读取'],
  ['write', '写入'],
  ['createfile', '创建'],
  ['multiedit', '编辑'],
  ['edit', '编辑'],
  ['notebook', '编辑笔记本'],
  ['bash', '执行'],
  ['shell', '执行'],
  ['grep', '搜索'],
  ['glob', '查找'],
  ['websearch', '联网搜索'],
  ['webfetch', '抓取'],
  ['webrequest', '请求'],
  ['agent', '派发子任务'],
  ['task', '派发子任务'],
  ['todowrite', '更新任务清单'],
  ['skill', '调用技能'],
];

function _verb(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  for (const [prefix, verb] of TOOL_VERBS) {
    if (n.startsWith(prefix)) {
      return verb;
    }
  }
  return '调用 ' + String(name || 'tool');
}

// 写入类工具：改动作一律进场景（关键动作），与耗时无关。
function _isWriteTool(name) {
  return /^(edit|multiedit|write|createfile|notebook)/i.test(String(name || ''));
}

function _basename(target) {
  const s = String(target || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function _targetShort(target, max = 48) {
  const s = String(target || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function _fmtDuration(ms) {
  if (!Number(ms) || ms <= 0) {
    return '';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/**
 * 频率算子：把连续同名同目标的 tool.call 折成一组。
 * 返回单元流：非工具事件原样；工具事件变成 { group: [event...] }。
 */
function _groupIterative(events) {
  const units = [];
  for (const e of events) {
    if (e.kind !== KIND.TOOL_CALL) {
      units.push({ event: e });
      continue;
    }
    const last = units[units.length - 1];
    if (
      last &&
      last.group &&
      last.group[0].name === e.name &&
      last.group[0].target === e.target
    ) {
      last.group.push(e);
    } else {
      units.push({ group: [e] });
    }
  }
  return units;
}

/**
 * 时序算子：给写入类工具标倒叙。同一 target 被再次写入、且两次写入之间隔着
 * 其它事件（非连续重复——那种已被频率算子合并），视为一次「折返修订」，
 * 后来的段落挂 analepsis = { backTo: 首次写入的 seq }。
 */
function _markAnalepsis(units) {
  const seen = new Map(); // target → { seq, unitIndex }
  units.forEach((unit, idx) => {
    if (!unit.group || !_isWriteTool(unit.group[0].name)) {
      return;
    }
    const target = unit.group[0].target;
    if (!target) {
      return;
    }
    const prev = seen.get(target);
    if (prev && prev.unitIndex < idx - 1) {
      unit.analepsis = { backTo: prev.seq };
    } else if (!prev) {
      seen.set(target, { seq: unit.group[0].seq, unitIndex: idx });
    }
  });
}

/** 时距算子：一个单元归哪一档。 */
function _classifyDuration(unit, opts) {
  if (unit.group) {
    const g = unit.group;
    if (g.some((e) => e.outcome === 'error')) {
      return 'scene';
    }
    if (_isWriteTool(g[0].name)) {
      return 'scene';
    }
    if (g.some((e) => Number(e.durationMs) >= opts.sceneMs)) {
      return 'scene';
    }
    return 'summary';
  }
  switch (unit.event.kind) {
    case KIND.USER_REQUEST:
      return 'scene';
    case KIND.TURN_END:
      return 'ellipsis';
    case KIND.ASSISTANT_THINKING:
      return opts.focus === 'reasoning' ? 'pause' : 'ellipsis';
    case KIND.CONTEXT_COMPACT:
    case KIND.ASSISTANT_TEXT:
      return 'summary';
    default:
      return 'ellipsis';
  }
}

function _anchorsOf(unit) {
  return unit.group ? unit.group.map((e) => e.seq) : [unit.event.seq];
}

function _sceneText(unit) {
  if (unit.group) {
    const g = unit.group;
    const verb = _verb(g[0].name);
    const target = _targetShort(g[0].target);
    const errors = g.filter((e) => e.outcome === 'error').length;
    const dones = g.filter((e) => e.outcome === 'done').length;
    const firstDone = g.findIndex((e) => e.outcome === 'done');
    let text;
    if (g.length === 1) {
      text = `KHY ${verb} ${target}`;
    } else if (firstDone >= 0) {
      text = `KHY 先后 ${g.length} 次${verb} ${target}（第 ${firstDone + 1} 次成功）`;
    } else if (errors === g.length) {
      text = `KHY 先后 ${g.length} 次${verb} ${target}，均未成功`;
    } else if (errors > 0) {
      // 结局无记录（旧 transcript 只有 tool_use 块）：只说已知失败次数，不编结果
      text = `KHY 先后 ${g.length} 次${verb} ${target}（其中 ${errors} 次失败，其余结果无记录）`;
    } else {
      text = `KHY 先后 ${g.length} 次${verb} ${target}`;
    }
    // 重试后成功：中间错误被「第 k 次成功」吸收，不再引；全部失败或收尾仍失败，
    // 场景=展示，直接引用最后一行错误。
    const lastError = [...g].reverse().find((e) => e.outcome === 'error' && e.text);
    if (lastError && (dones === 0 || g[g.length - 1].outcome === 'error')) {
      text += `：${lastError.text}`;
    }
    const totalMs = g.reduce((sum, e) => sum + (Number(e.durationMs) || 0), 0);
    if (totalMs >= 1000) {
      text += `（耗时 ${_fmtDuration(totalMs)}）`;
    }
    return text;
  }
  const e = unit.event;
  if (e.kind === KIND.USER_REQUEST) {
    return `用户提出：${e.text}`;
  }
  return e.text || '';
}

function _summaryClause(unit) {
  if (unit.group) {
    const g = unit.group;
    const verb = _verb(g[0].name);
    const target = _targetShort(g[0].target, 32);
    return g.length > 1 ? `${verb} ${target} ×${g.length}` : `${verb} ${target}`;
  }
  const e = unit.event;
  if (e.kind === KIND.CONTEXT_COMPACT) {
    return e.text;
  }
  return e.text || '';
}

/**
 * @param {Array<object>} events storyCollect.collectStory 的 events
 * @param {object} [opts]
 * @param {'task'|'reasoning'} [opts.focus='task'] 聚焦（语式）
 * @param {number} [opts.sceneMs=10000] 场景耗时阈值（时距）
 * @returns {{voice:string, focus:string, paragraphs:Array, stats:object}}
 *   paragraph = { mode:'scene'|'summary'|'pause', text, anchors:number[], analepsis? }
 */
function buildNarrative(events, opts = {}) {
  const focus = opts.focus === 'reasoning' ? 'reasoning' : 'task';
  const sceneMs = Number(opts.sceneMs) > 0 ? Number(opts.sceneMs) : DEFAULT_SCENE_MS;
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.kind);

  const units = _groupIterative(list);
  _markAnalepsis(units);

  const stats = { total: list.length, scene: 0, summary: 0, pause: 0, ellipsis: 0, iterativeMerged: 0 };
  const paragraphs = [];
  let pendingSummary = null;

  const flushSummary = () => {
    if (pendingSummary) {
      paragraphs.push(pendingSummary);
      pendingSummary = null;
    }
  };

  for (const unit of units) {
    const mode = _classifyDuration(unit, { focus, sceneMs });
    stats[mode] += 1;
    if (unit.group && unit.group.length > 1) {
      stats.iterativeMerged += unit.group.length - 1;
    }

    if (mode === 'ellipsis') {
      continue;
    }
    if (mode === 'summary') {
      const clause = _summaryClause(unit);
      if (!clause) {
        continue;
      }
      if (!pendingSummary) {
        pendingSummary = { mode: 'summary', clauses: [], anchors: [] };
      }
      pendingSummary.clauses.push(clause);
      pendingSummary.anchors.push(..._anchorsOf(unit));
      continue;
    }

    flushSummary();
    if (mode === 'scene') {
      const para = { mode, text: _sceneText(unit), anchors: _anchorsOf(unit) };
      if (unit.analepsis) {
        para.analepsis = unit.analepsis;
        para.text = `回到第 ${unit.analepsis.backTo} 步：${para.text}`;
      }
      paragraphs.push(para);
    } else if (mode === 'pause') {
      paragraphs.push({
        mode,
        text: `KHY 分析：${unit.event.text}`,
        anchors: [unit.event.seq],
      });
    }
  }
  flushSummary();

  for (const p of paragraphs) {
    if (p.mode === 'summary') {
      // 分句自带句号的先剥掉，避免拼段时「。。」
      p.text = p.clauses.map((c) => c.replace(/。+$/, '')).join('；') + '。';
      delete p.clauses;
    }
  }

  return {
    voice: 'extradiegetic-past-third', // 外叙述者 · 事后叙述 · 第三人称
    focus,
    paragraphs,
    stats,
  };
}

module.exports = { buildNarrative, _verb, _isWriteTool, _fmtDuration };
