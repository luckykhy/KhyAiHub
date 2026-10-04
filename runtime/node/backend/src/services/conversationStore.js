/**
 * Per-user AI chat conversation store (multi-tenant).
 *
 * Backs the `/api/ai/conversations` routes. Every query is scoped to a `userId`,
 * so a user can only ever read/write their own conversations. The full message
 * transcript is stored verbatim in `Conversation.messages` (JSON array) and is
 * the single source of truth; the sidebar list view reads only a lightweight
 * projection (title + timestamps + counts + preview), never the heavy transcript.
 *
 * Table creation: the daemon may boot before the global `sequelize.sync`. To stay
 * self-contained regardless of boot order, we lazily `Conversation.sync()` once on
 * first use — a model-level sync touches only `ai_conversations`, never other
 * tables. Mirrors workflowService.ensureTable / userGatewayConfigService boot-order
 * safety.
 *
 * @pattern Repository
 */
'use strict';

const { Conversation, ConversationGroup } = require('@khy/shared/models');

// Keep per-user history bounded so a long-lived account never grows without limit.
const MAX_PER_USER = 200;
const TITLE_MAX = 24;
const GROUP_NAME_MAX = 100;

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    // Model-level sync: creates only ai_conversations if missing; no-op otherwise.
    tableReady = Conversation.sync()
      .then(() => ensureConversationColumns())
      .catch((err) => {
        tableReady = null; // allow retry on transient failure
        throw err;
      });
  }
  return tableReady;
}

// Older databases predate group_id / sort_order (sequelize.sync only creates
// missing TABLES, never missing COLUMNS). Purely additive: add nullable columns
// when absent, never alter or drop. Fail-soft: a failure degrades to pre-column
// behaviour (groups disabled) rather than breaking the chat history routes.
async function ensureConversationColumns() {
  const qi = Conversation.sequelize.getQueryInterface();
  const schema = await qi.describeTable('ai_conversations');
  const addColumnIfMissing = async (column, definition) => {
    if (schema[column]) {
      return;
    }
    try {
      await qi.addColumn('ai_conversations', column, definition);
    } catch {
      /* already added by a racing worker, or migration unsupported → degrade */
    }
  };
  await addColumnIfMissing('group_id', { type: 'INTEGER', allowNull: true });
  await addColumnIfMissing('sort_order', { type: 'INTEGER', allowNull: true });
}

let groupsTableReady = null;
async function ensureGroupsTable() {
  if (!groupsTableReady) {
    groupsTableReady = ConversationGroup.sync().catch((err) => {
      groupsTableReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return groupsTableReady;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../utils/httpError');

function normMessages(value) {
  return Array.isArray(value) ? value : [];
}

// Normalize an optional project id to a positive integer or null (ungrouped).
// Any blank / non-numeric / non-positive value collapses to null so a
// conversation without a project stays in the always-visible "全部" bucket.
function normProjectId(value) {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Same contract as normProjectId, applied to custom-group ids.
const normGroupId = normProjectId;

// Manual sidebar position: an integer, or null (= fall back to updatedAt sort).
function normSortOrder(value) {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// Extract a plain-text snippet from a message's content. Web messages carry
// `content` as a string; tolerate array/object shapes (multimodal) by pulling
// the first text-ish field so the title/preview never renders "[object Object]".
function messageText(msg) {
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  const c = msg.content;
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    for (const part of c) {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return part.text;
      }
    }
    return '';
  }
  if (typeof msg.text === 'string') {
    return msg.text;
  }
  return '';
}

// Derive a human-friendly title from the first user message, else a default.
function deriveTitle(messages) {
  const list = normMessages(messages);
  const firstUser = list.find((m) => m && m.role === 'user');
  const text = messageText(firstUser).trim().replace(/\s+/g, ' ');
  if (!text) {
    return '新对话';
  }
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// Lightweight list projection — no heavy transcript payload.
function toSummary(row) {
  const messages = row.messages || [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  return {
    id: row.id,
    title: row.title || '新对话',
    projectId: row.projectId ?? null,
    groupId: row.groupId ?? null,
    sortOrder: row.sortOrder ?? null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    messageCount: messages.length,
    preview: messageText(lastUser).trim().slice(0, 60),
  };
}

// Full row including the transcript.
function toFull(row) {
  return {
    id: row.id,
    title: row.title || '新对话',
    projectId: row.projectId ?? null,
    groupId: row.groupId ?? null,
    sortOrder: row.sortOrder ?? null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    messages: row.messages || [],
  };
}

// Lightweight group projection for the sidebar folder list.
function groupToSummary(row) {
  return {
    id: row.id,
    name: row.name || '新建分组',
    sortOrder: row.sortOrder ?? null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

// List a user's conversations. Backward-compatible: called with just (userId)
// it returns every conversation (today's behavior). Pass { projectId } to filter
// to one coding project's conversations; a null/absent projectId keeps the full
// list. The second arg is optional so existing callers are unaffected.
async function list(userId, options = {}) {
  await ensureTable();
  const where = { userId };
  const projectId = normProjectId(options && options.projectId);
  if (projectId != null) {
    where.projectId = projectId;
  }
  const rows = await Conversation.findAll({
    where,
    order: [
      ['updatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return rows.map(toSummary);
}

async function get(userId, id) {
  await ensureTable();
  const row = await Conversation.findOne({ where: { userId, id } });
  if (!row) {
    throw httpError(404, 'Conversation not found');
  }
  return toFull(row);
}

async function create(userId, body = {}) {
  await ensureTable();
  const messages = normMessages(body.messages);
  const title = (body.title && String(body.title).trim()) || deriveTitle(messages);
  const row = await Conversation.create({
    userId,
    title: title.slice(0, 200),
    projectId: normProjectId(body.projectId),
    groupId: normGroupId(body.groupId),
    sortOrder: normSortOrder(body.sortOrder),
    messages,
  });
  await pruneOld(userId);
  return toFull(row);
}

async function update(userId, id, body = {}) {
  await ensureTable();
  const row = await Conversation.findOne({ where: { userId, id } });
  if (!row) {
    throw httpError(404, 'Conversation not found');
  }

  const patch = {};
  if (body.messages != null) {
    patch.messages = normMessages(body.messages);
  }
  if (body.projectId !== undefined) {
    patch.projectId = normProjectId(body.projectId);
  }
  if (body.groupId !== undefined) {
    patch.groupId = normGroupId(body.groupId);
  }
  if (body.sortOrder !== undefined) {
    patch.sortOrder = normSortOrder(body.sortOrder);
  }
  if (body.title != null) {
    patch.title = String(body.title).trim().slice(0, 200) || '新对话';
  } else if (body.messages != null && (!row.title || row.title === '新对话')) {
    // First persisted turn: backfill a derived title if it was still the default.
    patch.title = deriveTitle(patch.messages).slice(0, 200);
  }

  await row.update(patch);
  return toFull(row);
}

async function remove(userId, id) {
  await ensureTable();
  const deleted = await Conversation.destroy({ where: { userId, id } });
  if (!deleted) {
    throw httpError(404, 'Conversation not found');
  }
  return { deleted: true, id: Number(id) };
}

// ── Conversation groups (sidebar folders) ───────────────────────────────────

// List the user's custom groups. Frontend re-sorts (sortOrder asc, then id).
async function listGroups(userId) {
  await ensureGroupsTable();
  const rows = await ConversationGroup.findAll({
    where: { userId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.map(groupToSummary);
}

async function createGroup(userId, body = {}) {
  await ensureGroupsTable();
  const name = String(body.name || '').trim().slice(0, GROUP_NAME_MAX) || '新建分组';
  const row = await ConversationGroup.create({
    userId,
    name,
    sortOrder: normSortOrder(body.sortOrder),
  });
  return groupToSummary(row);
}

async function updateGroup(userId, id, body = {}) {
  await ensureGroupsTable();
  const row = await ConversationGroup.findOne({ where: { userId, id } });
  if (!row) {
    throw httpError(404, 'Conversation group not found');
  }
  const patch = {};
  if (body.name != null) {
    patch.name = String(body.name).trim().slice(0, GROUP_NAME_MAX) || '新建分组';
  }
  if (body.sortOrder !== undefined) {
    patch.sortOrder = normSortOrder(body.sortOrder);
  }
  await row.update(patch);
  return groupToSummary(row);
}

// Delete a group WITHOUT deleting its conversations: clear the dangling
// group_id references first, so chats resurface as ungrouped, never vanish.
async function removeGroup(userId, id) {
  await ensureGroupsTable();
  const deleted = await ConversationGroup.destroy({ where: { userId, id } });
  if (!deleted) {
    throw httpError(404, 'Conversation group not found');
  }
  await Conversation.update({ groupId: null }, { where: { userId, groupId: Number(id) } });
  return { deleted: true, id: Number(id) };
}

// Persist a manual drag-reorder: [{ id, sortOrder }, ...]. Only the calling
// user's own rows are touched (ownership enforced by the where clause); unknown
// ids are silently skipped so a stale client cannot 404 the whole batch.
async function reorder(userId, items) {
  await ensureTable();
  if (!Array.isArray(items)) {
    throw httpError(400, 'items must be an array of { id, sortOrder }');
  }
  let updated = 0;
  for (const item of items) {
    const id = normProjectId(item && item.id);
    if (id == null) {
      continue;
    }
    const rows = await Conversation.update(
      { sortOrder: normSortOrder(item.sortOrder) },
      { where: { userId, id } }
    );
    updated += rows[0] || 0;
  }
  return { updated };
}

// Drop the oldest rows beyond the per-user cap so history stays bounded.
async function pruneOld(userId) {
  const count = await Conversation.count({ where: { userId } });
  if (count <= MAX_PER_USER) {
    return;
  }
  const stale = await Conversation.findAll({
    where: { userId },
    order: [
      ['updatedAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: count - MAX_PER_USER,
    attributes: ['id'],
  });
  const ids = stale.map((r) => r.id);
  if (ids.length) {
    await Conversation.destroy({ where: { userId, id: ids } });
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  listGroups,
  createGroup,
  updateGroup,
  removeGroup,
  reorder,
  // exported for reuse / tests
  deriveTitle,
  ensureTable,
  ensureGroupsTable,
  httpError,
  MAX_PER_USER,
};
