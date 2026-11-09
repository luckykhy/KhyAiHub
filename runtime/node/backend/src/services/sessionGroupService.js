'use strict';

/**
 * sessionGroupService.js — 会话分组的唯一所有者（[DESIGN-ARCH-183]）。
 *
 * 设计要点（逐条对应设计稿）：
 *
 * 1. **单一所有者**：分组与成员关系只存在后端 SQLite（sessions.db）里。UI / TUI /
 *    网页端都经本服务读写，不存在「内存缓存另有一份真源再回写」的路径 —— 这正是
 *    ZCode 运行时把旧状态回写、覆盖外部成员关系的根因，这里结构上不可能发生。
 * 2. **创建时打标记，不做事后识别**：会话来源（定时任务 / 闲时任务 / 手动）在落库
 *    那一刻写进 metadata.source，读分组时直接用，不靠标题猜。
 * 3. **系统组用固定 ID**：ensure 幂等，组名走常量映射（改文案不用迁移数据）。
 * 4. **服务层守卫**：kind='system' 的组在**服务层**拒绝改名 / 改色 / 删除 ——
 *    多端一致，UI 只是同步禁用。
 * 5. **回填幂等**：ensureMembership 用 upsert，重复执行不产生重复成员。
 *
 * 自动分组规则（用户 2026-10-26 定：来源 + 时间衰减）：
 *
 *   优先级 1：显式归属（用户把会话拖进自己建的组）→ 该用户组
 *   优先级 2：会话带来源标记 → 对应系统组（定时任务 / 闲时任务 / 手动会话）
 *   优先级 3：没有来源标记（历史会话）→ 时间桶（今天 / 本周 / 更早）
 *   兜底：以上都不命中 → 未分组
 *
 * 时间桶按会话 updatedAt 判定：今天 = 当天；本周 = 近 7 天（不含今天）；更早 = 其余。
 */

const sessionSearchIndex = require('./sessionSearchIndex');

/** 固定系统组：ID 固定、组名走常量、不可改名/删除/改色。 */
const SYSTEM_GROUPS = [
  { id: 'khyos-default-group-automation', title: '定时任务', color: 'blue', rule: 'source:automation' },
  { id: 'khyos-default-group-offpeak', title: '闲时任务', color: 'purple', rule: 'source:offpeak' },
  { id: 'khyos-default-group-manual', title: '手动会话', color: 'gray', rule: 'source:manual' },
  { id: 'khyos-default-group-today', title: '今天', color: 'green', rule: 'time:today' },
  { id: 'khyos-default-group-week', title: '本周', color: 'yellow', rule: 'time:week' },
  { id: 'khyos-default-group-older', title: '更早', color: 'gray', rule: 'time:older' },
];

/** 来源标记 → 系统组 ID。未知来源一律当「手动会话」。 */
const SOURCE_GROUP = {
  automation: 'khyos-default-group-automation',
  offpeak: 'khyos-default-group-offpeak',
  off_peak: 'khyos-default-group-offpeak',
  manual: 'khyos-default-group-manual',
};

/** 合法颜色（与前端 PROJECT_COLOR_CHOICES 对齐）。 */
const GROUP_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const TIME_GROUP_TODAY = 'khyos-default-group-today';
const TIME_GROUP_WEEK = 'khyos-default-group-week';
const TIME_GROUP_OLDER = 'khyos-default-group-older';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_BUCKET_DAYS = 7;

const SYSTEM_GROUP_IDS = new Set(SYSTEM_GROUPS.map((g) => g.id));
const SYSTEM_GROUP_BY_ID = new Map(SYSTEM_GROUPS.map((g) => [g.id, g]));

// ── 语句缓存（跟随 sessionSearchIndex 的连接；连接重建时缓存作废）────────
let _stmts = null;
let _stmtsDb = null;

function _db() {
  const db = sessionSearchIndex.getDb();
  if (!db) return null;
  if (db !== _stmtsDb) {
    _stmtsDb = db;
    _stmts = {
      insertGroup: db.prepare(
        `INSERT INTO session_groups (group_id, title, color, kind, sort_order, created_at, updated_at)
         VALUES (@groupId, @title, @color, @kind, @sortOrder, @now, @now)
         ON CONFLICT(group_id) DO UPDATE SET title = @title, color = @color, updated_at = @now`
      ),
      listGroups: db.prepare(
        `SELECT group_id AS id, title, color, kind, sort_order AS sortOrder FROM session_groups
         WHERE kind = 'user' ORDER BY sort_order ASC, created_at ASC`
      ),
      listMembers: db.prepare(
        `SELECT session_id AS sessionId, group_id AS groupId, project_key AS projectKey
         FROM session_group_members`
      ),
      upsertMember: db.prepare(
        `INSERT INTO session_group_members (session_id, group_id, project_key, created_at, updated_at)
         VALUES (@sessionId, @groupId, @projectKey, @now, @now)
         ON CONFLICT(session_id) DO UPDATE SET group_id = @groupId, project_key = @projectKey, updated_at = @now`
      ),
      deleteMember: db.prepare('DELETE FROM session_group_members WHERE session_id = ?'),
      deleteGroup: db.prepare('DELETE FROM session_groups WHERE group_id = ? AND kind = \'user\''),
      deleteMembersOfGroup: db.prepare('DELETE FROM session_group_members WHERE group_id = ?'),
      updateGroup: db.prepare(
        'UPDATE session_groups SET title = @title, color = @color, updated_at = @now WHERE group_id = @groupId AND kind = \'user\''
      ),
      updateSort: db.prepare(
        'UPDATE session_groups SET sort_order = @sortOrder, updated_at = @now WHERE group_id = @groupId AND kind = \'user\''
      ),
      getMeta: db.prepare('SELECT value FROM session_group_meta WHERE key = ?'),
      setMeta: db.prepare(
        `INSERT INTO session_group_meta (key, value, updated_at) VALUES (@key, @value, @now)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now`
      ),
    };
  }
  return db;
}

function _now() {
  return Date.now();
}

/**
 * 把系统组写进库（幂等）。组名/颜色以常量为真源 —— 库里那一份只是为了让
 * 「分组集合」在库里也完整可查，不参与显示。
 */
function ensureSystemGroups() {
  const db = _db();
  if (!db) return false;
  const now = _now();
  try {
    const txn = db.transaction(() => {
      SYSTEM_GROUPS.forEach((g, index) => {
        _stmts.insertGroup.run({
          groupId: g.id,
          title: g.title,
          color: g.color,
          kind: 'system',
          sortOrder: index,
          now,
        });
      });
    });
    txn();
    return true;
  } catch {
    return false;
  }
}

/** 用户组 + 系统组的完整列表（显示顺序：系统组在前，用户组按 sortOrder）。 */
function listGroups() {
  const db = _db();
  if (!db) return [];
  ensureSystemGroups();
  const system = SYSTEM_GROUPS.map((g, index) => ({
    id: g.id,
    title: g.title,
    color: g.color,
    kind: 'system',
    rule: g.rule,
    sortOrder: index,
  }));
  let user = [];
  try {
    user = _stmts.listGroups.all() || [];
  } catch {
    user = [];
  }
  return [...system, ...user];
}

/** 时间桶判定（纯函数，可测）。 */
function timeBucketGroupId(updatedAt, now = Date.now()) {
  const ts = Number(updatedAt) || 0;
  if (!ts) return TIME_GROUP_OLDER;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return TIME_GROUP_TODAY;
  if (ts >= todayStart - WEEK_BUCKET_DAYS * DAY_MS) return TIME_GROUP_WEEK;
  return TIME_GROUP_OLDER;
}

/** 来源标记 → 系统组 ID（未知来源 → 手动会话）。 */
function sourceGroupId(sourceType) {
  if (!sourceType) return null;
  return SOURCE_GROUP[String(sourceType)] || SOURCE_GROUP.manual;
}

/**
 * 侧栏分组视图的**唯一读入口**：一次返回分组树 + 每个会话的归属。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50] 会话条数上限
 * @returns {{ok: boolean, groups?: Array, assignment?: Object, counts?: Object, ungrouped?: Array, error?: string}}
 */
function listSessionsWithGroups(opts = {}) {
  const db = _db();
  if (!db) {
    return { ok: false, error: '会话分组存储不可用：本机没有可用的 SQLite 驱动，请安装 Node 22.5+ 或重新编译 better-sqlite3' };
  }
  const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 500) : 50;

  let sessions = [];
  try {
    // 会话清单的真源仍是 sessionPersistence（磁盘上的 JSON 快照），
    // 搜索索引只是加速结构，可能落后于真实会话数。
    const sp = require('./sessionPersistence');
    sessions = sp.listPersistedSessions({ limit }) || [];
  } catch (err) {
    return { ok: false, error: `读取会话清单失败：${err && err.message ? err.message : String(err)}，请检查数据目录是否可读` };
  }

  const groups = listGroups();
  const userGroupIds = new Set(groups.filter((g) => g.kind === 'user').map((g) => g.id));

  // 显式归属（用户手动归组）—— 优先级最高，覆盖自动规则。
  const explicit = new Map();
  try {
    for (const row of _stmts.listMembers.all() || []) {
      if (!row || !row.sessionId) continue;
      if (!userGroupIds.has(row.groupId)) continue; // 组已删 → 忽略这条归属
      explicit.set(row.sessionId, row.groupId);
    }
  } catch {
    /* 读不到成员关系就退化为纯自动规则 */
  }

  const assignment = {};
  const counts = {};
  for (const g of groups) counts[g.id] = 0;
  const ungrouped = [];

  for (const s of sessions) {
    const id = s && s.sessionId;
    if (!id) continue;
    let groupId = explicit.get(id) || null;
    if (!groupId) {
      groupId = sourceGroupId(s.sourceType) || timeBucketGroupId(s.updatedAt);
    }
    if (groupId && counts[groupId] !== undefined) {
      assignment[id] = groupId;
      counts[groupId] += 1;
    } else {
      ungrouped.push(id);
    }
  }

  return { ok: true, groups, assignment, counts, ungrouped };
}

function _fail(error) {
  return { ok: false, error };
}

/** 建一个用户组。 */
function createGroup(input = {}) {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const title = String(input.title || '').trim();
  if (!title) return _fail('分组名称不能为空：请输入一个能一眼看出用途的名字');
  if (title.length > 60) return _fail('分组名称过长：请控制在 60 字以内');
  const color = GROUP_COLORS.includes(input.color) ? input.color : 'gray';
  const groupId = String(input.groupId || `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  if (SYSTEM_GROUP_IDS.has(groupId)) return _fail('该分组 ID 是系统组，不能占用');
  const now = _now();
  try {
    const maxRow = db
      .prepare('SELECT MAX(sort_order) AS maxOrder FROM session_groups WHERE kind = \'user\'')
      .get();
    const sortOrder = Number(maxRow && maxRow.maxOrder) + 1 || 0;
    _stmts.insertGroup.run({ groupId, title, color, kind: 'user', sortOrder, now });
    return { ok: true, group: { id: groupId, title, color, kind: 'user', rule: null, sortOrder } };
  } catch (err) {
    return _fail(`创建分组失败：${err && err.message ? err.message : String(err)}`);
  }
}

/** 改名 / 改色（系统组一律拒绝）。 */
function updateGroup(groupId, patch = {}) {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const id = String(groupId || '');
  if (!id) return _fail('分组 ID 为空：请重新选择要修改的分组');
  if (SYSTEM_GROUP_IDS.has(id)) return _fail('系统分组不可改名或改色：它由自动规则维护');
  let current = null;
  try {
    current = _stmts.listGroups.all().find((g) => g.id === id) || null;
  } catch {
    current = null;
  }
  if (!current) return _fail('分组不存在：可能已被删除，请刷新后重试');
  const title = patch.title !== undefined ? String(patch.title || '').trim() : current.title;
  if (!title) return _fail('分组名称不能为空：请输入一个能一眼看出用途的名字');
  if (title.length > 60) return _fail('分组名称过长：请控制在 60 字以内');
  const color = patch.color !== undefined
    ? (GROUP_COLORS.includes(patch.color) ? patch.color : current.color)
    : current.color;
  try {
    _stmts.updateGroup.run({ groupId: id, title, color, now: _now() });
    return { ok: true, group: { id, title, color, kind: 'user', rule: null, sortOrder: current.sortOrder } };
  } catch (err) {
    return _fail(`修改分组失败：${err && err.message ? err.message : String(err)}`);
  }
}

/** 删组：组内会话回落自动规则（不是消失）。 */
function deleteGroup(groupId) {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const id = String(groupId || '');
  if (!id) return _fail('分组 ID 为空：请重新选择要删除的分组');
  if (SYSTEM_GROUP_IDS.has(id)) return _fail('系统分组不可删除：它由自动规则维护');
  try {
    const txn = db.transaction(() => {
      _stmts.deleteMembersOfGroup.run(id);
      _stmts.deleteGroup.run(id);
    });
    txn();
    return { ok: true };
  } catch (err) {
    return _fail(`删除分组失败：${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * 把会话移入分组（groupId 为 null = 移出，回到自动规则）。
 * 只允许用户组：系统组由规则维护，手动塞进去会让规则与事实打架。
 */
function moveSession(sessionId, groupId, projectKey = '') {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const sid = String(sessionId || '');
  if (!sid) return _fail('会话 ID 为空：请先选择要归组的会话');
  if (groupId === null || groupId === undefined || groupId === '') {
    try {
      _stmts.deleteMember.run(sid);
      return { ok: true, sessionId: sid, groupId: null };
    } catch (err) {
      return _fail(`移出分组失败：${err && err.message ? err.message : String(err)}`);
    }
  }
  const gid = String(groupId);
  if (SYSTEM_GROUP_IDS.has(gid)) return _fail('系统分组不可手动归入：它由自动规则维护');
  const known = listGroups().some((g) => g.id === gid && g.kind === 'user');
  if (!known) return _fail('分组不存在：可能已被删除，请刷新后重试');
  try {
    _stmts.upsertMember.run({
      sessionId: sid,
      groupId: gid,
      projectKey: String(projectKey || ''),
      now: _now(),
    });
    return { ok: true, sessionId: sid, groupId: gid };
  } catch (err) {
    return _fail(`归组失败：${err && err.message ? err.message : String(err)}`);
  }
}

/** 重排用户组顺序。 */
function reorderGroups(order = []) {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const ids = (Array.isArray(order) ? order : []).map((x) => String(x || '')).filter(Boolean);
  if (!ids.length) return _fail('分组顺序为空：请刷新后重试');
  try {
    const now = _now();
    const txn = db.transaction(() => {
      ids.forEach((id, index) => {
        if (SYSTEM_GROUP_IDS.has(id)) return;
        _stmts.updateSort.run({ groupId: id, sortOrder: index, now });
      });
    });
    txn();
    return { ok: true };
  } catch (err) {
    return _fail(`排序保存失败：${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * 一次性导入 renderer localStorage 里的旧分组（[DESIGN-ARCH-183] §8）。
 * 幂等：同一批数据重复导入不会产生重复组或重复成员。
 */
function importLegacyGroups(payload = {}) {
  const db = _db();
  if (!db) return _fail('会话分组存储不可用：本机没有可用的 SQLite 驱动');
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const assignments = payload.assignments && typeof payload.assignments === 'object' ? payload.assignments : {};
  if (!groups.length && !Object.keys(assignments).length) return { ok: true, imported: 0, groups: 0 };
  const created = [];
  try {
    const txn = db.transaction(() => {
      let order = groups.length;
      for (const g of groups) {
        const title = String((g && g.name) || '').trim();
        if (!title) continue;
        const groupId = String((g && g.id) || `g_${Date.now()}_${created.length}`);
        if (SYSTEM_GROUP_IDS.has(groupId)) continue;
        _stmts.insertGroup.run({
          groupId,
          title,
          color: GROUP_COLORS.includes(g && g.color) ? g.color : 'gray',
          kind: 'user',
          sortOrder: Number(g && g.sortOrder) || order++,
          now: _now(),
        });
        created.push(groupId);
      }
      const valid = new Set(created);
      for (const [sessionId, groupId] of Object.entries(assignments)) {
        if (!valid.has(String(groupId))) continue;
        _stmts.upsertMember.run({
          sessionId: String(sessionId),
          groupId: String(groupId),
          projectKey: '',
          now: _now(),
        });
      }
    });
    txn();
    return { ok: true, imported: created.length, groups: created.length };
  } catch (err) {
    return _fail(`导入旧分组失败：${err && err.message ? err.message : String(err)}`);
  }
}

/** 一次性标记：localStorage 迁移是否已完成。 */
function getMeta(key) {
  const db = _db();
  if (!db) return null;
  try {
    const row = _stmts.getMeta.get(String(key));
    return row && row.value !== undefined ? row.value : null;
  } catch {
    return null;
  }
}

function setMeta(key, value) {
  const db = _db();
  if (!db) return false;
  try {
    _stmts.setMeta.run({ key: String(key), value: value === undefined || value === null ? null : String(value), now: _now() });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SYSTEM_GROUPS,
  SYSTEM_GROUP_IDS,
  GROUP_COLORS,
  ensureSystemGroups,
  listGroups,
  listSessionsWithGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  moveSession,
  reorderGroups,
  importLegacyGroups,
  getMeta,
  setMeta,
  timeBucketGroupId,
  sourceGroupId,
};
