import request from '@/api/request';

/**
 * 开发环境盘点 API 客户端（/api/dev-env）。
 *
 * 后端落在 runtime/node/backend（web 后端），dev 代理走 '/api' 默认 catch-all，
 * 与 /api/large-tasks 同构 —— 不需要进 vite.config.js 的 DAEMON_ONLY_NAMESPACES。
 * 约定与其他 api 模块一致：每个方法 resolve 出后端信封 `{ success, data, metadata }`，
 * 调用方读 `res.data.<字段>`。
 *
 * 动作门控的**真源在后端**：manual 条目（如 MoonBit）后端以 409 DEV_ENV_MANUAL_ONLY
 * 拒绝安装，前端只置灰按钮 / 走「复制 installHint」，绝不 POST install ——
 * 前端再判一次「能不能装」就会出现两套规则，迟早漂移。
 *
 * 标了 `silent: true` 的方法，失败不弹全局 toast（request.js:171 的约定），
 * 由页面自带的可见降级 UI 承接：
 *   - catalog/inventory：页面渲染错误横幅 + 重试；
 *   - inventory 的 409（尚未盘点）是**引导态**而非错误，驱动「扫描盘点」空态；
 *   - export 的 409 同理，由页面引导先扫描；
 *   - job 轮询失败由轮询自身计数并诚实停下，不逐次弹 toast。
 */

const BASE = '/api/dev-env';

export const devEnvApi = {
  /** 静态工具链目录（depId/kind/可选版本/官方文档链接），不触发探测。 */
  catalog() {
    return request.get(`${BASE}/catalog`, { silent: true }).then((r) => r.data);
  },

  /**
   * 上次盘点快照（scan-latest.json）。无快照 → 409 DEV_ENV_NO_INVENTORY，
   * 页面据此显示「尚未盘点」空态而不是错误。
   */
  inventory() {
    return request.get(`${BASE}/inventory`, { silent: true }).then((r) => r.data);
  },

  /** 后台全量盘点（约 3-10s）→ 202 { jobId }，进度走 job()。 */
  scan() {
    return request.post(`${BASE}/scan`, {}).then((r) => r.data);
  },

  /** 长操作任务轮询（scan|install|import 通用）。 */
  job(jobId) {
    const id = String(jobId == null ? '' : jobId).trim();
    if (!id) return Promise.reject(new Error('jobId 不能为空'));
    return request.get(`${BASE}/jobs/${encodeURIComponent(id)}`, { silent: true }).then((r) => r.data);
  },

  /**
   * 单项安装 → 202 { jobId }。version 只在用户显式选择时下发，
   * 空值不下发，避免用空串覆盖后端的默认版本选择。
   */
  install(depId, version) {
    const body = { depId };
    if (version) body.version = version;
    return request.post(`${BASE}/install`, body).then((r) => r.data);
  },

  /**
   * 以最近快照构建随身清单 manifest。服务端不落盘（杜绝路径注入），
   * 落盘只发生在浏览器侧（Blob 下载）。无快照 → 409 引导先扫描。
   */
  export() {
    return request.post(`${BASE}/export`, {}, { silent: true }).then((r) => r.data);
  },

  /** 导入预览：toInstall / skipped / manual / unknown 四段计划，不安装。 */
  importPreview(manifest) {
    return request.post(`${BASE}/import/preview`, { manifest }).then((r) => r.data);
  },

  /** 导入执行 → 202 { jobId }；manual 条目由后端置 skipped(DEV_ENV_MANUAL_ONLY)。 */
  importApply(manifest) {
    return request.post(`${BASE}/import/apply`, { manifest }).then((r) => r.data);
  },
};

export default devEnvApi;
