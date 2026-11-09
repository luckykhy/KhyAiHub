import request from '@/api/request';

/**
 * 任务监控只读快照。
 *
 * 后端有两个挂载点：AI 守护进程（裸 http，聊天/工具事件就在它的进程里）与
 * web 后端（Express）。开发代理把 `/api/task-monitor` 优先给守护进程——挂到
 * web 后端会让「会话在跑」永远是空的。两端返回同一信封。
 */
const BASE = '/api/task-monitor';

export const taskMonitorApi = {
  /** @returns {Promise<{success: boolean, data?: object}>} */
  snapshot() {
    return request.get(`${BASE}/snapshot`).then((r) => r.data);
  },
};
