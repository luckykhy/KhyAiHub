#!/usr/bin/env node
/**
 * check-board-lane-map.js — 任务看板「泳道/列」映射的实证守卫
 *
 * 用途：`[DESIGN-ARCH-126] 跨端 AI 编程任务看板` 方案里断言「11 个运行时状态可以无损折叠成
 * 6 个看板列」以及「每个状态都可从 queued 抵达」。散文断言不算证据 —— 本守卫把这两条
 * 判据变成可复现的机器判读，并会在上游新增第 12 个状态时立刻变红（防止方案静默失真）。
 * （2026-09-27 由 _产物/ 一次性探针迁入版本控制，先例：touch-cost 探针。）
 *
 * 纪律：零外部依赖 / 只读 / 确定性 / 可离线跑 / 绝不抛。
 * 真源：services/backend/src/tasks/largeTaskRuntimeStore.js（正则抽常量，不 require，
 *       避免拉起运行时存储的副作用）。
 *
 * 用法：
 *   node scripts/ci/check-board-lane-map.js                 # 人类可读
 *   node scripts/ci/check-board-lane-map.js --json          # 机器可读
 *   node scripts/ci/check-board-lane-map.js --scenario=drop # 反例：漏掉一个状态的映射
 *   node scripts/ci/check-board-lane-map.js --scenario=dup  # 反例：一个状态映射到两列
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STORE_REL = path.join('services', 'backend', 'src', 'tasks', 'largeTaskRuntimeStore.js');
const STORE_ABS = path.join(REPO_ROOT, STORE_REL);

// ── 方案主张：11 态 → 6 列 的折叠表（本表就是「设计决策」的可执行形态） ──
// terminal: 'all'   = 本列全部状态都是终态
//           'none'  = 本列没有任何终态
//           'mixed' = 本列同时含终态与非终态（必须显式声明，不允许含混）
// ⚠ 卡片级的「能否流转」必须由**卡片自身 status** 决定，不得读列级 terminal ——
//   列级只用于列头着色与计数。`closed` 就是 mixed 的实例：cancelling（取消中，可继续流转）
//   与 cancelled（已取消，终态）同列。
const LANE_MAP = Object.freeze({
  backlog: { title: '待办/排队', statuses: ['queued', 'claimed', 'retry_wait'], terminal: 'none' },
  active: { title: '执行中', statuses: ['running'], terminal: 'none' },
  paused: { title: '已暂停', statuses: ['pausing', 'paused'], terminal: 'none' },
  done: { title: '已完成', statuses: ['succeeded'], terminal: 'all' },
  failed: { title: '失败/死信', statuses: ['failed', 'dead_letter'], terminal: 'all' },
  closed: { title: '已取消', statuses: ['cancelling', 'cancelled'], terminal: 'mixed' },
});

const EXPECTED_STATUS_COUNT = 11;
const EXPECTED_LANE_COUNT = 6;

// ── 泳道维度（§4.4）：泳道 = payload_json.source 的取值 ──
// 为什么抽文本而不是 require：agentLauncherRegistry 是纯叶子（可 require），
// 但一旦迁进 scripts/lib/ 就多一条指向 L2 的 cross-layer-require 边（会被计入基线）。
// 沿用本仓既有做法：源码文本抽取。
const LAUNCHER_REL = path.join('services', 'backend', 'src', 'services', 'agentLauncherRegistry.js');
const LAUNCHER_ABS = path.join(REPO_ROOT, LAUNCHER_REL);

// 平台自身派发的 source（非外部编码 agent）。取值来自实际代码里出现的常量。
const SYSTEM_SOURCES = Object.freeze(['background_task_manager', 'cli-learning-curriculum']);

// 兜底泳道：source 为空 / 未登记时卡片落这里，**绝不丢弃**（F8）
const FALLBACK_SWIMLANE = Object.freeze({ id: '_unassigned', title: '未归属', kind: 'system', source: '__unassigned__' });

// 执行体泳道的中文名（仅展示用；id 一律用 source 原值，不做转换）
const AGENT_TITLES = Object.freeze({
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  warp: 'Warp', cursor: 'Cursor', kiro: 'Kiro', trae: 'Trae',
  vscode: 'VS Code', windsurf: 'Windsurf',
});

// ── 计划层 ↔ 执行层的连接键（方案 §3.4） ──
// 实测：两套任务体系之间**零连接代码**（git grep 全空），且 id 格式不兼容
// （HQ 是 `T-001`；运行时是 `_newTaskId` 生成的 `<scope>-<hex4>-<seq>`）。
// 连接键 = 运行时 id 取 `<hq_id>.<attempt>`，由 createTask 的 input.id 显式传入；
// 反查用 listTasks({ id_prefix: '<hq_id>.' })（该过滤维度已存在）。
const HQ_PROGRESS_REL = path.join('.ai', 'hq', 'PROGRESS.json');
const HQ_PROGRESS_ABS = path.join(REPO_ROOT, HQ_PROGRESS_REL);

const RUNTIME_ID_SEP = '.';

/** 运行时任务 id：`<hq_id>.<attempt>`。attempt 必须是 ≥1 的整数，否则返回 null（拒绝而非拼出脏 id）。 */
function deriveRuntimeId(hqId, attempt) {
  if (typeof hqId !== 'string' || hqId.length === 0) return null;
  const n = Number(attempt);
  if (!Number.isInteger(n) || n < 1) return null;
  return `${hqId}${RUNTIME_ID_SEP}${n}`;
}

/** 反查前缀。带尾部分隔符 ⇒ 不会把 `T-0011` 误并进 `T-001` 的结果。 */
function joinPrefix(hqId) {
  return `${hqId}${RUNTIME_ID_SEP}`;
}

// 终态 → 计划层回写。**必须覆盖全部终态**（4 个），漏一个就是「跑完了但看板永远停在执行中」。
const WRITEBACK = Object.freeze({
  succeeded: { hqStatus: 'done', note: false },
  failed: { hqStatus: 'doing', note: true },
  dead_letter: { hqStatus: 'doing', note: true },
  cancelled: { hqStatus: 'todo', note: true },
});

// ── 契约字段可解析性（§4.2 的 cards[] 逐字段出处） ──
// 每张卡的字段必须归入四类之一 —— 否则就是「编出来的字段」。本方案初稿在
// `swimlane` / `title` / `checkpointAt` 上连犯三次，第四次是 `worktree`。四类都可自动复核：
//   task       真源任务对象字段 ⇒ 必须出现在 createTask() 的字面量里
//   payload    既有 payload 键   ⇒ 必须有代码真读它（payload_json.x / payload.x）
//   derived    由真源派生        ⇒ 必须给出派生源，且派生源本身可解析
//   convention 本方案新约定      ⇒ 必须写明写入方（没人写 ⇒ 卡片上永远是 undefined）
const CARD_CONTRACT = Object.freeze([
  { field: 'id', from: 'task' },
  { field: 'status', from: 'task' },
  { field: 'type', from: 'task' },
  { field: 'progress_pct', from: 'task' },
  { field: 'attempt_count', from: 'task' },
  { field: 'updated_at', from: 'task' },
  { field: 'created_at', from: 'task' },
  { field: 'lane', from: 'derived', source: 'LANE_MAP' },
  { field: 'swimlane', from: 'derived', source: 'payload:source' },
  { field: 'source', from: 'payload', key: 'source' },
  { field: 'worktree', from: 'payload', key: 'worktree' },
  { field: 'title', from: 'convention', key: 'title', writer: '任务创建方（khy task start / 启动器包装层）' },
  { field: 'no_worktree_reason', from: 'convention', key: 'no_worktree_reason', writer: '任务创建方（同上）' },
]);

// ── F4 的绑定可达性：字段存在 ≠ 有人写它 ──
// `payload_json.worktree` 由 tools/_taskStore.bindWorktree() 写入，但那条路径只被
// worktreeManager.createWorktree({taskId}) 触发 ⇒ 只要没人传 taskId，字段恒为 null。
const TASK_STORE_REL = path.join('services', 'backend', 'src', 'tools', '_taskStore.js');
const TASK_STORE_ABS = path.join(REPO_ROOT, TASK_STORE_REL);
const ROUTES_REL = path.join('services', 'backend', 'src', 'routes', 'largeTasks.js');
const ROUTES_ABS = path.join(REPO_ROOT, ROUTES_REL);
const WORKTREE_CALLER_RELS = [
  path.join('services', 'backend', 'src', 'tools', 'EnterWorktreeTool', 'index.js'),
  path.join('services', 'backend', 'src', 'cli', 'repl', 'worktreeCommand.js'),
];

// ── 真源抽取 ──

function readStoreSource() {
  return fs.readFileSync(STORE_ABS, 'utf8');
}

/** 抽出 `const NAME = Object.freeze([ ... ])` 里的字符串字面量数组。 */
function extractStringArray(src, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = src.match(re);
  if (!m) return null;
  const out = [];
  const lit = /'([^']+)'|"([^"]+)"/g;
  let hit;
  while ((hit = lit.exec(m[1])) !== null) out.push(hit[1] || hit[2]);
  return out;
}

/** 抽出 `const NAME = new Set([ 'a', 'b' ])`。 */
function extractSet(src, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*new\\s+Set\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = src.match(re);
  if (!m) return null;
  const out = [];
  const lit = /'([^']+)'|"([^"]+)"/g;
  let hit;
  while ((hit = lit.exec(m[1])) !== null) out.push(hit[1] || hit[2]);
  return out;
}

/** 抽出 STATUS_TRANSITIONS 的 { from: new Set([...]) } 映射。 */
function extractTransitions(src) {
  const start = src.indexOf('const STATUS_TRANSITIONS');
  if (start === -1) return null;
  const end = src.indexOf('});', start);
  if (end === -1) return null;
  const block = src.slice(start, end);
  const out = {};
  const re = /(\w+)\s*:\s*new\s+Set\(\[([^\]]*)\]\)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const tos = [];
    const lit = /'([^']+)'|"([^"]+)"/g;
    let h;
    while ((h = lit.exec(m[2])) !== null) tos.push(h[1] || h[2]);
    out[m[1]] = tos;
  }
  return out;
}

// ── 判定（纯函数，可单测） ──

/** 抽出 AGENT_LAUNCHERS 里每个条目的 command 值（文本抽取，不 require）。 */
function extractLauncherCommands(src) {
  const start = src.indexOf('const AGENT_LAUNCHERS');
  if (start === -1) return null;
  const arrStart = src.indexOf('Object.freeze([', start);
  if (arrStart === -1) return null;
  const end = src.indexOf('\n]);', arrStart);
  if (end === -1) return null;
  const block = src.slice(arrStart, end);
  const out = [];
  const re = /command:\s*'([^']+)'|command:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[1] || m[2]);
  return out;
}

/** 构建泳道表：agent 泳道（真源注册表）+ 系统泳道 + 兜底泳道。 */
/** 抽出 createTask() 字面量里的任务对象字段（含 `id,` 这类简写）。 */
function extractTaskFields(src) {
  const start = src.indexOf('const task = {');
  if (start === -1) return null;
  const end = src.indexOf('};', start);
  if (end === -1) return null;
  const body = src.slice(start, end);
  const out = [];
  const re = /^\s{4,8}([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/gm;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/** 抽出**被代码真正读过**的 payload 键（`payload_json.x` / `payload.x`）。 */
function extractPayloadKeys(srcs) {
  const keys = new Set();
  const re = /payload(?:_json)?\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const src of srcs) {
    if (!src) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
  }
  return keys;
}

/** 统计真正给 `createWorktree` 传了 `taskId` 的生产调用点（只看调用点，不看定义）。 */
function countWorktreeBindCallSites(srcs) {
  let n = 0;
  for (const src of srcs) {
    if (!src) continue;
    const re = /\.createWorktree\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (/\btaskId\s*:/.test(src.slice(m.index, m.index + 300))) n += 1;
    }
  }
  return n;
}

function buildSwimlanes(agentCommands) {
  const agent = (agentCommands || []).map((c) => ({
    id: c, title: AGENT_TITLES[c] || c, kind: 'agent', source: c,
  }));
  const sys = SYSTEM_SOURCES.map((s) => ({ id: s, title: s, kind: 'system', source: s }));
  return [...agent, ...sys, { ...FALLBACK_SWIMLANE }];
}

/** 卡片落哪条泳道：命中即用，未命中落兜底（不丢弃）。 */
function swimlaneForSource(swimlanes, source) {
  const hit = swimlanes.find((s) => s.source === source);
  return hit ? hit.id : FALLBACK_SWIMLANE.id;
}

function assess(input) {
  const { statuses, terminal, transitions, laneMap, scenario, agentCommands, hqIds, hqStates, writeback,
    taskFields, payloadKeys, worktreeFacts, cardContract } = input;
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });

  if (!Array.isArray(statuses) || statuses.length === 0) {
    add('error', 'L0-source', `无法从 ${STORE_REL} 抽出 TASK_STATUSES —— 真源结构已变，本探针失效（不是仓库坏了）`);
    return findings;
  }

  // 反例注入：让「应拦」的场景可复现
  let map = laneMap;
  if (scenario === 'drop') {
    map = JSON.parse(JSON.stringify(laneMap));
    map.closed.statuses = map.closed.statuses.filter((s) => s !== 'cancelling');
  } else if (scenario === 'dup') {
    map = JSON.parse(JSON.stringify(laneMap));
    map.active.statuses = ['running', 'queued'];
  }

  // R1 划分性：每个状态恰好落一列
  const seen = new Map();
  for (const [lane, spec] of Object.entries(map)) {
    for (const s of spec.statuses) {
      if (seen.has(s)) {
        add('error', 'L1-partition', `状态 '${s}' 同时落在 '${seen.get(s)}' 与 '${lane}' 两列 —— 划分不互斥，卡片会重复出现`);
      } else {
        seen.set(s, lane);
      }
    }
  }
  for (const s of statuses) {
    if (!seen.has(s)) {
      add('error', 'L1-partition', `状态 '${s}' 没有任何看板列承接 —— 该状态的卡片在看板上不可见（静默丢单）`);
    }
  }
  for (const s of seen.keys()) {
    if (!statuses.includes(s)) {
      add('error', 'L1-partition', `看板列映射了 '${s}'，但它不在真源 TASK_STATUSES 里 —— 幽灵列`);
    }
  }

  // R2 计数与方案主张一致（上游新增状态时这里会红，提醒回来复核方案）
  if (statuses.length !== EXPECTED_STATUS_COUNT) {
    add('warning', 'L2-drift', `真源状态数 ${statuses.length} ≠ 方案记录 ${EXPECTED_STATUS_COUNT} —— 上游已漂移，请复核本文 §三 折叠表`);
  }
  if (Object.keys(map).length !== EXPECTED_LANE_COUNT) {
    add('warning', 'L2-drift', `看板列数 ${Object.keys(map).length} ≠ 方案记录 ${EXPECTED_LANE_COUNT}`);
  }

  // R3 终态一致性：列的 terminal 声明必须与其承接状态的实际终态性吻合（三态，双向可查）
  const termSet = new Set(terminal || []);
  for (const [lane, spec] of Object.entries(map)) {
    const inLane = spec.statuses.filter((s) => statuses.includes(s));
    if (inLane.length === 0) continue;
    const termInLane = inLane.filter((s) => termSet.has(s));
    const kind = termInLane.length === 0 ? 'none' : termInLane.length === inLane.length ? 'all' : 'mixed';
    if (spec.terminal !== kind) {
      const nonTerm = inLane.filter((s) => !termSet.has(s));
      let detail;
      if (spec.terminal === 'all') {
        detail = `但 '${nonTerm.join("', '")}' 在真源里不是终态（仍可继续流转）`;
      } else if (spec.terminal === 'none') {
        detail = `但 '${termInLane.join("', '")}' 在真源里已是终态`;
      } else {
        detail = kind === 'all'
          ? '但本列实际全为终态（无混合），应声明为 \'all\''
          : '但本列实际全为非终态（无混合），应声明为 \'none\'';
      }
      add('error', 'L3-terminal', `列 '${lane}' 声明为 '${spec.terminal}'，${detail} —— 列语义与状态机冲突`);
    }
  }

  // R4 终态不可流出（真源断言：终态列的 statuses 不得出现在任何 transitions 的 key 里带非空集合）
  for (const s of terminal || []) {
    const outs = (transitions || {})[s];
    if (outs && outs.length > 0) {
      add('error', 'L4-terminal-out', `终态 '${s}' 仍有出边 -> [${outs.join(', ')}] —— 状态机与「终态」语义矛盾`);
    }
  }

  // R5 可达性：每个状态都能从 queued 抵达（否则是孤儿态，看板上永远看不到它出现）
  if (transitions && transitions.queued) {
    const reach = new Set(['queued']);
    const queue = ['queued'];
    while (queue.length) {
      const cur = queue.shift();
      for (const nxt of transitions[cur] || []) {
        if (!reach.has(nxt)) {
          reach.add(nxt);
          queue.push(nxt);
        }
      }
    }
    for (const s of statuses) {
      if (!reach.has(s)) {
        add('error', 'L5-reachable', `状态 '${s}' 从 'queued' 不可达 —— 孤儿态，看板上永不会出现`);
      }
    }
    for (const s of reach) {
      if (!statuses.includes(s)) {
        add('error', 'L5-reachable', `转移表引用了未登记状态 '${s}'`);
      }
    }
  } else {
    add('warning', 'L5-reachable', '未能抽出 STATUS_TRANSITIONS，跳过可达性校验');
  }

  // ── 泳道维度（S1–S4）：泳道 = payload_json.source（方案 §4.4）──

  if (!Array.isArray(agentCommands) || agentCommands.length === 0) {
    add('warning', 'S0-source', `未能从 ${LAUNCHER_REL} 抽出 AGENT_LAUNCHERS —— 执行体泳道清单无法核对，本组降级`);
  }

  let swimlanes = buildSwimlanes(agentCommands);
  if (scenario === 'orphan-source') {
    swimlanes = [...swimlanes, { id: 'ghost', title: '幽灵执行体', kind: 'agent', source: 'ghost-agent' }];
  } else if (scenario === 'no-fallback') {
    swimlanes = swimlanes.filter((s) => s.source !== FALLBACK_SWIMLANE.source);
  }

  // S1 兜底泳道必须存在且唯一（F8：未归属不得丢弃）
  const fallbacks = swimlanes.filter((s) => s.source === FALLBACK_SWIMLANE.source);
  if (fallbacks.length === 0) {
    add('error', 'S1-fallback', '泳道表缺少兜底泳道 —— source 为空/未登记的任务会被静默丢弃');
  } else if (fallbacks.length > 1) {
    add('error', 'S1-fallback', `兜底泳道有 ${fallbacks.length} 条，必须唯一`);
  }

  // S2 泳道 id 与 source 均不得重复
  for (const field of ['id', 'source']) {
    const seenSl = new Map();
    for (const s of swimlanes) {
      if (seenSl.has(s[field])) {
        add('error', 'S2-unique', `泳道 ${field} '${s[field]}' 重复（'${seenSl.get(s[field])}' 与 '${s.id}'）—— 卡片落哪条不确定`);
      } else {
        seenSl.set(s[field], s.id);
      }
    }
  }

  // S3 kind='agent' 的 source 必须在真源注册表内，且真源每个执行体都要有泳道（F9，双向）
  if (Array.isArray(agentCommands) && agentCommands.length > 0) {
    const cmdSet = new Set(agentCommands);
    for (const s of swimlanes) {
      if (s.kind !== 'agent' || s.source === FALLBACK_SWIMLANE.source) continue;
      if (!cmdSet.has(s.source)) {
        add('error', 'S3-launcher', `泳道 '${s.id}' 声明 kind='agent'，但 source '${s.source}' 不在 AGENT_LAUNCHERS（${LAUNCHER_REL}）里 —— 幽灵执行体`);
      }
    }
    const slSources = new Set(swimlanes.map((s) => s.source));
    for (const c of agentCommands) {
      if (!slSources.has(c)) {
        add('error', 'S3-launcher', `真源注册表里的执行体 '${c}' 没有对应泳道 —— 它的任务只能落「未归属」，泳道维度失真`);
      }
    }
  }

  // S4 未登记 source 解析出的泳道必须真的在表里（否则渲染时无处可放）
  for (const probe of ['ghost-agent', '', null, undefined, '__nope__']) {
    const got = swimlaneForSource(swimlanes, probe);
    if (!swimlanes.some((s) => s.id === got)) {
      add('error', 'S4-fallback', `source=${JSON.stringify(probe)} 解析到泳道 '${got}'，但它不在泳道表里 —— 卡片渲染时无处可放`);
    }
  }

  // ── 计划层 ↔ 执行层的连接键（J1–J5）：方案 §3.4 ──

  const ids0 = Array.isArray(hqIds) ? hqIds : [];
  const states = Array.isArray(hqStates) ? hqStates : [];
  // 反例：注入一个会与既有 id 形成连接前缀歧义的计划任务 id
  const ids = scenario === 'collide' && ids0.length > 0
    ? [...ids0, `${ids0[0]}${RUNTIME_ID_SEP}2`]
    : ids0;

  if (ids.length === 0) {
    add('warning', 'J0-source', `未能从 ${HQ_PROGRESS_REL} 读出计划层任务 id —— 连接键校验降级`);
  }

  // J1 派生 id 唯一：同一 (hq_id, attempt) 必须给出同一个 id，不同对必须不同
  const seenRt = new Map();
  for (const hq of ids) {
    for (const attempt of [1, 2, 3]) {
      const rt = deriveRuntimeId(hq, attempt);
      if (rt === null) {
        add('error', 'J1-unique', `合法输入 ('${hq}', ${attempt}) 竟被 deriveRuntimeId 拒绝`);
        continue;
      }
      if (seenRt.has(rt)) {
        add('error', 'J1-unique', `运行时 id '${rt}' 由多个 (hq_id, attempt) 派生 —— 会撞 createTask 的「Task already exists」`);
      } else {
        seenRt.set(rt, `${hq}#${attempt}`);
      }
    }
  }

  // J2 连接前缀不得歧义：任一 hq id 都不能是另一条的 `<id>.` 前缀
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      if (joinPrefix(a) === joinPrefix(b).slice(0, joinPrefix(a).length)) {
        add('error', 'J2-ambiguous', `'${a}' 是 '${b}' 的连接前缀 —— 反查会把两个计划任务的尝试混在一起`);
      }
    }
  }

  // J3 非法 attempt 必须被**拒绝**（返回 null），合法 attempt 必须**通过**。
  // ⚠ 两个方向都要测：只测拒绝 ⇒ 把函数改成恒返回 null 也能过（空转断言）。
  for (const bad of [0, -1, 1.5, NaN, null, undefined, 'x', '']) {
    const rt = deriveRuntimeId('T-001', bad);
    if (rt !== null) {
      add('error', 'J3-attempt', `attempt=${JSON.stringify(bad)} 未被拒绝，派生出 '${rt}' —— 非法 attempt 会污染运行时 id 空间`);
    }
  }
  if (deriveRuntimeId('T-001', 1) !== 'T-001.1') {
    add('error', 'J3-attempt', 'deriveRuntimeId 对合法输入 ("T-001", 1) 未返回 "T-001.1" —— 拒绝逻辑收得过头，把合法值也挡了');
  }
  if (deriveRuntimeId('', 1) !== null) {
    add('error', 'J3-attempt', '空 hq_id 未被拒绝');
  }

  // J4 回写映射必须**完备**（覆盖全部终态）且**可靠**（不为非终态回写）
  const wb = scenario === 'no-writeback'
    ? Object.fromEntries(Object.entries(writeback).filter(([k]) => k !== 'cancelled'))
    : writeback;
  for (const t of terminal || []) {
    if (!wb[t]) {
      add('error', 'J4-writeback', `终态 '${t}' 没有回写目标 —— 任务跑完了，计划层会永远停在 doing`);
    }
  }
  for (const k of Object.keys(wb)) {
    if (statuses.includes(k) && !(terminal || []).includes(k)) {
      add('error', 'J4-writeback', `非终态 '${k}' 配了回写目标 —— 中途回写会让计划层状态来回跳`);
    }
  }
  if (states.length > 0) {
    for (const [k, v] of Object.entries(wb)) {
      if (!states.includes(v.hqStatus)) {
        add('error', 'J4-writeback', `终态 '${k}' 的回写目标是 '${v.hqStatus}'，但它不在计划层状态集 [${states.join(', ')}] 里`);
      }
    }
  }

  // J5 反查前缀必须能唯一圈定该计划任务的全部尝试
  for (const hq of ids) {
    const p = joinPrefix(hq);
    const others = ids.filter((o) => o !== hq && joinPrefix(o).startsWith(p));
    if (others.length > 0) {
      add('error', 'J5-prefix', `反查前缀 '${p}' 会同时命中 [${others.join(', ')}] 的尝试`);
    }
  }

  // ── K1 契约字段可解析性 ──
  // 反例注入：`ghost-field` 模拟「初稿把 swimlane 当成凭空字段」的历史缺陷
  // —— 抽掉 payload 里的 'source'，看契约能不能自己发现字段取不到值。
  let pk = payloadKeys || new Set();
  if (scenario === 'ghost-field') pk = new Set([...pk].filter((k) => k !== 'source'));

  const contract = cardContract || CARD_CONTRACT;
  const tf = new Set(taskFields || []);
  for (const spec of contract) {
    if (spec.from === 'task') {
      if (!tf.has(spec.field)) {
        add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 标注为真源任务字段，但 createTask() 字面量里没有它 —— 编出来的字段`);
      }
    } else if (spec.from === 'payload') {
      if (!pk.has(spec.key)) {
        add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 依赖 payload 键 '${spec.key}'，但没有任何代码读它 —— 契约好看但取不到值`);
      }
    } else if (spec.from === 'derived') {
      if (spec.source === 'LANE_MAP') {
        if (Object.keys(laneMap).length === 0) {
          add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 派生自 LANE_MAP，但该表为空`);
        }
      } else if (String(spec.source).startsWith('payload:')) {
        const k = String(spec.source).slice('payload:'.length);
        if (!pk.has(k)) {
          add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 派生自 payload 键 '${k}'，但没有任何代码读它 —— 泳道维度会整列塌掉`);
        }
      } else {
        add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 的派生源 '${spec.source}' 无法校验 —— 请在 CARD_CONTRACT 里补可解析的派生源`);
      }
    } else if (spec.from === 'convention') {
      if (!spec.writer || !String(spec.writer).trim()) {
        add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 是本方案新约定，但没写明写入方 —— 没人写 ⇒ 卡片上永远是 undefined`);
      }
    } else {
      add('error', 'K1-ghost-field', `卡片字段 '${spec.field}' 的出处类型 '${spec.from}' 不是四类之一（task/payload/derived/convention）`);
    }
  }

  // ── K2 F4 的绑定可达性：字段存在 ≠ 有人写它 ──
  const wf = worktreeFacts || {};
  const bindSites = scenario === 'worktree-wired' ? 1 : (wf.bindCallSites || 0);
  if (wf.hasBindFn === false) {
    add('error', 'K2-unwired', 'tools/_taskStore 里找不到 bindWorktree —— F4 假设的绑定机制根本不存在');
  } else if (bindSites === 0) {
    add('warning', 'K2-unwired',
      `F4 依赖的 worktree 绑定在生产代码里**零调用点**（${(wf.callers || []).join(' / ') || '无调用方'} 调 createWorktree 时都不传 taskId）`
      + ` ⇒ payload_json.worktree 恒为 null ⇒ F4 只能走豁免分支（**空转**）。`
      + `步 1 必须新增接线（让启动器把自己的 task id 传给 createWorktree），否则 F4 应降级为 advisory。`);
  }

  return findings;
}

// ── IO 壳 ──

/** 按显示宽度补空格（CJK 记 2 列），让中文列头对齐。 */
function padW(s, width) {
  const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
  let w = 0;
  for (const ch of s) w += CJK.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const scenario = (argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || '';

  let src;
  try {
    src = readStoreSource();
  } catch (e) {
    console.error(`无法读取真源 ${STORE_REL}: ${e.message}`);
    process.exit(2);
  }

  const tryRead = (abs) => {
    try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return ''; }
  };
  const launcherSrc = tryRead(LAUNCHER_ABS);
  const taskStoreSrc = tryRead(TASK_STORE_ABS);
  const routesSrc = tryRead(ROUTES_ABS);
  const callerSrcs = WORKTREE_CALLER_RELS.map(tryRead);

  let hqIds = [];
  let hqStates = [];
  try {
    const hq = JSON.parse(fs.readFileSync(HQ_PROGRESS_ABS, 'utf8'));
    hqIds = (hq.tasks || []).map((t) => t.id).filter(Boolean);
    hqStates = hq.task_states || [];
  } catch (e) {
    hqIds = [];
    hqStates = [];
  }

  const statuses = extractStringArray(src, 'TASK_STATUSES');
  const terminal = extractSet(src, 'TERMINAL_STATUSES');
  const transitions = extractTransitions(src);
  const agentCommands = extractLauncherCommands(launcherSrc);
  const taskFields = extractTaskFields(src);
  const payloadKeys = extractPayloadKeys([src, taskStoreSrc, routesSrc]);
  const worktreeFacts = {
    hasBindFn: /function\s+bindWorktree\s*\(/.test(taskStoreSrc),
    bindCallSites: countWorktreeBindCallSites(callerSrcs),
    callers: WORKTREE_CALLER_RELS.map((p) => path.basename(path.dirname(p)) + '/' + path.basename(p)),
  };

  const findings = assess({
    statuses, terminal, transitions, laneMap: LANE_MAP, scenario,
    agentCommands, hqIds, hqStates, writeback: WRITEBACK,
    taskFields, payloadKeys, worktreeFacts, cardContract: CARD_CONTRACT,
  });

  if (asJson) {
    console.log(JSON.stringify({
      source: STORE_REL,
      launcherSource: LAUNCHER_REL,
      hqSource: HQ_PROGRESS_REL,
      scenario: scenario || 'default',
      statusCount: (statuses || []).length,
      laneCount: Object.keys(LANE_MAP).length,
      laneMap: LANE_MAP,
      agentCommands: agentCommands || [],
      swimlanes: buildSwimlanes(agentCommands),
      hqTaskCount: hqIds.length,
      hqTaskStates: hqStates,
      writeback: WRITEBACK,
      taskFields: taskFields || [],
      payloadKeys: [...(payloadKeys || [])].sort(),
      worktreeFacts,
      cardContract: CARD_CONTRACT,
      findings,
    }, null, 2));
  } else {
    console.log(`状态真源: ${STORE_REL}`);
    console.log(`执行体真源: ${LAUNCHER_REL}`);
    console.log(`计划层真源: ${HQ_PROGRESS_REL}`);
    console.log(`抽出: ${(statuses || []).length} 个状态 / ${Object.keys(LANE_MAP).length} 个看板列 / ${(agentCommands || []).length} 个执行体 / ${hqIds.length} 个计划任务${scenario ? ` / 场景=${scenario}` : ''}`);
    console.log('');
    console.log('  ── 列（状态） ──');
    const TAG = { all: '[终态]', mixed: '[混合]', none: '' };
    for (const [lane, spec] of Object.entries(LANE_MAP)) {
      const tag = TAG[spec.terminal] ? ` ${TAG[spec.terminal]}` : '';
      console.log(`  ${padW(spec.title, 12)}  ${spec.statuses.join(', ')}${tag}`);
    }
    console.log('');
    console.log('  ── 泳道（执行体） ──');
    for (const s of buildSwimlanes(agentCommands)) {
      console.log(`  ${padW(s.title, 14)}  kind=${s.kind}  source=${s.source}`);
    }
    console.log('');
    console.log('  ── 终态回写计划层 ──');
    for (const [k, v] of Object.entries(WRITEBACK)) {
      console.log(`  ${padW(k, 14)}  -> ${padW(v.hqStatus, 8)}${v.note ? ' + 追加 note' : ''}`);
    }
    console.log('');
    console.log('  ── 契约字段出处（cards[] 逐字段） ──');
    const FROM_TAG = { task: '真源字段', payload: 'payload 键', derived: '派生', convention: '新增约定' };
    for (const spec of CARD_CONTRACT) {
      const origin = spec.from === 'task' ? spec.field
        : spec.from === 'payload' ? `payload_json.${spec.key}`
          : spec.from === 'derived' ? spec.source
            : `payload_json.${spec.key}（写入方：${spec.writer}）`;
      console.log(`  ${padW(spec.field, 22)}  ${padW(FROM_TAG[spec.from] || spec.from, 10)}  ${origin}`);
    }
    console.log('');
    console.log('  ── F4 的 worktree 绑定可达性 ──');
    console.log(`  bindWorktree 存在: ${worktreeFacts.hasBindFn ? '是' : '否'}`);
    console.log(`  传 taskId 的 createWorktree 调用点: ${worktreeFacts.bindCallSites} 处`
      + `（扫描 ${worktreeFacts.callers.join(' / ')}）`);
    console.log(`  ⇒ payload_json.worktree ${worktreeFacts.bindCallSites > 0 ? '可能被写入' : '恒为 null（F4 空转）'}`);
    console.log('');
    if (findings.length === 0) {
      console.log('看板列 / 泳道 / 连接键 / 回写映射 / 契约字段出处 五项均自洽。');
    } else {
      for (const f of findings) {
        const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
        console.log(`[${prefix}] ${f.rule} ${STORE_REL}`);
        console.log(`  ${f.message}`);
      }
    }
    const errorCount = findings.filter((f) => f.severity === 'error').length;
    const warnCount = findings.filter((f) => f.severity === 'warning').length;
    console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);
  }

  process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  assess, extractStringArray, extractSet, extractTransitions, extractLauncherCommands,
  extractTaskFields, extractPayloadKeys, countWorktreeBindCallSites,
  buildSwimlanes, swimlaneForSource, deriveRuntimeId, joinPrefix,
  LANE_MAP, FALLBACK_SWIMLANE, SYSTEM_SOURCES, WRITEBACK, RUNTIME_ID_SEP, CARD_CONTRACT,
};
