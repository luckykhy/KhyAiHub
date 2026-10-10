import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';

/**
 * Per-user (multi-tenant) AI chat conversation history.
 *
 * Talks ONLY to `/api/ai/conversations[/:id]` (auth-only, scoped to the
 * authenticated user's id on the backend). Mirrors the `useWorkflow` composable
 * shape: shared `unwrap(res)` envelope handling (from `@/api/unwrap`),
 * `request.get/post/put/delete`, and ref-backed state. A user can only ever
 * read/write their own conversations.
 *
 * The list view holds lightweight summaries ({ id, title, updatedAt,
 * messageCount, preview }); the full transcript is fetched on demand when a
 * conversation is opened.
 */

export function useChatConversations() {
  const conversations = ref([]);
  const groups = ref([]);
  const activeId = ref(null);
  const listLoading = ref(false);
  let _fetchPending = 0;

  // Fetch the sidebar list. Pass a projectId to filter to one coding project's
  // conversations; omit (or pass null) for the full "全部" list. The query param
  // is only appended when a positive id is given, so the default call is unchanged.
  async function fetchList(projectId = null) {
    _fetchPending += 1;
    listLoading.value = true;
    try {
      const pid = Number(projectId);
      const url =
        Number.isInteger(pid) && pid > 0
          ? `/api/ai/conversations?projectId=${pid}`
          : '/api/ai/conversations';
      const res = await request.get(url);
      conversations.value = unwrap(res) || [];
      return conversations.value;
    } finally {
      _fetchPending = Math.max(0, _fetchPending - 1);
      if (_fetchPending === 0) listLoading.value = false;
    }
  }

  // Fetch the user's custom sidebar folders ("分组"). Best-effort: a failure leaves
  // the folder list empty so the flat conversation list still renders.
  async function fetchGroups() {
    try {
      const res = await request.get('/api/ai/conversation-groups');
      groups.value = unwrap(res) || [];
    } catch {
      groups.value = [];
    }
    return groups.value;
  }

  // Load conversations + folders in one call (used on mount / project switch).
  async function fetchAll(projectId = null) {
    await Promise.all([fetchList(projectId), fetchGroups()]);
    return conversations.value;
  }

  // Open a conversation: returns its full message array and marks it active.
  async function openConversation(id) {
    const res = await request.get(`/api/ai/conversations/${id}`);
    const data = unwrap(res) || {};
    activeId.value = id;
    return Array.isArray(data.messages) ? data.messages : [];
  }

  // Create a new conversation from the current transcript; the server derives a
  // title from the first user message. Prepends to the list and marks active.
  // Pass projectId to stamp the new conversation into a coding project (null =
  // ungrouped); the server normalizes blank/invalid ids to null.
  async function createConversation({ messages, title, projectId } = {}) {
    const body = { messages: messages || [], title };
    const pid = Number(projectId);
    if (Number.isInteger(pid) && pid > 0) body.projectId = pid;
    const res = await request.post('/api/ai/conversations', body);
    const data = unwrap(res) || {};
    if (data && data.id != null) {
      // Defensive: never list the same id twice (belt-and-suspenders alongside
      // the caller-side serialization of persistActive).
      if (!conversations.value.some((c) => c.id === data.id)) {
        conversations.value.unshift(summaryOf(data));
      }
      activeId.value = data.id;
    }
    return data;
  }

  // Persist a turn (or rename) into an existing conversation, then refresh its
  // summary row in place (title / updatedAt / preview / count).
  async function updateConversation(id, { messages, title } = {}) {
    const body = {};
    if (messages != null) body.messages = messages;
    if (title != null) body.title = title;
    const res = await request.put(`/api/ai/conversations/${id}`, body);
    const data = unwrap(res) || {};
    const idx = conversations.value.findIndex((c) => c.id === id);
    if (idx !== -1) {
      conversations.value[idx] = { ...conversations.value[idx], ...summaryOf(data) };
      // Bubble the just-touched conversation to the top (matches updatedAt sort).
      const [row] = conversations.value.splice(idx, 1);
      conversations.value.unshift(row);
    }
    return data;
  }

  async function removeConversation(id) {
    await request.delete(`/api/ai/conversations/${id}`);
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (activeId.value === id) activeId.value = null;
  }

  // ── Conversation groups (sidebar folders) ─────────────────────────────────
  // Custom folders the user creates in the sidebar. Conversations are filed in
  // via moveToGroup; deleting a group leaves its conversations intact (the
  // backend clears the dangling group_id) — reflected locally below.

  async function createGroup(name) {
    const res = await request.post('/api/ai/conversation-groups', { name });
    const g = unwrap(res);
    if (g) {
      // Avoid duplicates if the server echoes the created row.
      if (!groups.value.some((x) => x.id === g.id)) groups.value.push(g);
    }
    return g;
  }

  async function renameGroup(id, name) {
    const res = await request.put(`/api/ai/conversation-groups/${id}`, { name });
    const g = unwrap(res);
    const idx = groups.value.findIndex((x) => x.id === id);
    if (idx !== -1 && g) groups.value[idx] = { ...groups.value[idx], ...g };
    return g;
  }

  async function deleteGroup(id) {
    await request.delete(`/api/ai/conversation-groups/${id}`);
    groups.value = groups.value.filter((g) => g.id !== id);
    // The backend clears group_id on the member rows; mirror that locally so
    // they resurface in the project/未分组 buckets instead of vanishing.
    for (const c of conversations.value) {
      if (c.groupId === Number(id)) c.groupId = null;
    }
  }

  // File a conversation into (or out of, when groupId is null) a custom folder.
  // Optimistic: patch the local row immediately so the UI moves instantly, then
  // persist. A failure reverts via re-fetch.
  async function moveToGroup(id, groupId) {
    const norm = groupId == null || groupId === '' ? null : Number(groupId);
    const target = conversations.value.find((c) => c.id === id);
    const prev = target ? target.groupId : null;
    if (target) target.groupId = norm;
    try {
      await request.put(`/api/ai/conversations/${id}`, { groupId: norm });
    } catch (err) {
      if (target) target.groupId = prev;
      throw err;
    }
  }

  // Persist a manual drag-reorder. items: [{ id, sortOrder }] in display order.
  // Applies the new sort locally so the list doesn't re-fetch-flicker.
  async function reorder(items) {
    const payload = items.map((it, i) => ({ id: Number(it.id), sortOrder: i }));
    for (const it of payload) {
      const c = conversations.value.find((x) => x.id === it.id);
      if (c) c.sortOrder = it.sortOrder;
    }
    await request.post('/api/ai/conversations/reorder', { items: payload });
  }

  // Map a full/created record down to the lightweight summary shape used by the
  // sidebar list, so create/update can patch the list without an extra fetch.
  // Preserves projectId/groupId/sortOrder so the foldered sidebar view stays
  // correct after a create/update without a full re-fetch.
  function summaryOf(data) {
    const messages = Array.isArray(data.messages) ? data.messages : null;
    const lastUser = messages ? [...messages].reverse().find((m) => m && m.role === 'user') : null;
    return {
      id: data.id,
      title: data.title || '新对话',
      projectId: data.projectId ?? null,
      groupId: data.groupId ?? null,
      sortOrder: data.sortOrder ?? null,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      messageCount: data.messageCount != null ? data.messageCount : messages ? messages.length : 0,
      preview:
        data.preview != null
          ? data.preview
          : lastUser
            ? String(lastUser.content || '').slice(0, 60)
            : '',
    };
  }

  // Compact relative-time label for list rows ("刚刚 / 几分钟前 / 昨天 / 日期").
  function relativeTime(ts) {
    if (!ts) return '';
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 2 * day) return '昨天';
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return new Date(then).toLocaleDateString();
  }

  return {
    conversations,
    groups,
    activeId,
    listLoading,
    fetchList,
    fetchGroups,
    fetchAll,
    openConversation,
    createConversation,
    updateConversation,
    removeConversation,
    createGroup,
    renameGroup,
    deleteGroup,
    moveToGroup,
    reorder,
    relativeTime,
  };
}
