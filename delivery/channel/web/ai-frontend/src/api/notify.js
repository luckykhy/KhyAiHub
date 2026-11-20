// notify — 集中式错误通知层（结构化，薄封装，复用 Element Plus 的 ElMessage）。
//
// v2 改动（错误结构化）：
//   - 引入 KhyError 七件套模型，按 severity 选 toast 形态：
//       silent → 不弹
//       info   → ElMessage({ type: 'info' })
//       warn   → ElMessage({ type: 'warning' })
//       error  → ElMessage({ type: 'error' })  + 4s 自动关
//       fatal  → ElMessage({ type: 'error', duration: 0 }) 持久不关 + 跳转兜底页
//   - 不再依赖 Element Plus 内部 type 字段映射；调用方传 KhyError 实例即可，
//     旧调用方传 string 仍兼容（自动规整为 KhyError）。
//   - 保留去重逻辑：同 code 在 3s 窗口内只弹一次。
//   - 保留 fail-soft：ElMessage 不可用降级 console。
//   - ElMessage 不再从 'element-plus' 根 barrel 静态导入，改为首次弹窗时按 message
//     深路径懒加载：barrel 会把整库（本机实测 es 下 887 个模块）钉进入口静态图，
//     而入口只需要弹窗这一件。notifyError/_showToast 仍是同步返回（fire-and-forget）。
//
// 其它改动见：services/backend/src/cli/reportKhyError.js（CLI 同源）
//            platform/packages/shared/src/errorEnvelope.js（HTTP 序列化）
import { classifyKhyError } from '../utils/classifyKhyError.mjs';

// message 部件的懒加载单例。深路径的 style/css 内部引 theme-chalk/el-message.css，
// 与 main.js 入口保留的那条同源（同一文件路径 → 同一模块，不会重复进包）。
let _elMessageImport = null;

function _ensureElMessage() {
  if (!_elMessageImport) {
    _elMessageImport = Promise.all([
      import('element-plus/es/components/message/index.mjs'),
      import('element-plus/es/components/message/style/css'),
    ])
      .then(([mod]) => (mod && mod.ElMessage) || null)
      .catch((err) => {
        _elMessageImport = null; // 失败不缓存：下次调用还有机会重试。
        throw err;
      });
  }
  return _elMessageImport;
}

/**
 * Fire-and-forget 弹窗：同步返回，import 与 ElMessage 调用都在加载落地后才发生。
 * 慢网下这意味着首条提示会比「已加载」的后续条目晚一点点出现 —— 去重窗口在调用时
 * 就写入（见 shouldSuppress），窗口内的同类错误仍被抑制，语义与改动前一致。
 */
function _toast(options, fallbackText) {
  _ensureElMessage().then(
    (ElMessage) => {
      try {
        if (!ElMessage) throw new Error('element-plus message 未导出 ElMessage');
        ElMessage(options);
      } catch (err) {
        _logFailSoft(fallbackText, err);
      }
    },
    (err) => _logFailSoft(fallbackText, err)
  );
}

function _logFailSoft(text, err) {
  try {
    // eslint-disable-next-line no-console
    console.error('[notify]', text, (err && err.message) || '');
  } catch {
    /* noop */
  }
}

// 同一 code 的最近弹出时间戳。窗口内重复 code 被抑制。
const recent = new Map();
const DEDUPE_WINDOW_MS = 3000;

// severity → ElMessage.type 的映射。fatal 不在这里走 —— 它走单独的 modal 流。
const SEVERITY_TO_TOAST_TYPE = Object.freeze({
  silent: null,    // null = 不弹
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'error',  // fatal 仍走 ElMessage.error 但 duration:0 不自动关
});

function shouldSuppress(key) {
  const now = Date.now();
  const last = recent.get(key);
  // 顺带清理过期项，避免 Map 无限增长。
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
  }
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recent.set(key, now);
  return false;
}

/**
 * 弹出一条错误/警告/信息提示（去重、fail-soft、按 severity 分级）。
 * @param {string|Error|KhyErrorShape} input - 任意错误值
 * @param {{ dedupe?: boolean, duration?: number, action?: string, target?: string }} [opts]
 */
export function notifyError(input, opts = {}) {
  const env = _ensureKhy(input);
  if (!env) return;
  // silent：连去重 map 都不写，避免污染。
  if (env.severity === 'silent') return;

  const toastType = SEVERITY_TO_TOAST_TYPE[env.severity];
  if (toastType == null) return;

  const dedupeKey = `${env.code}|${env.severity}`;
  const { dedupe = true, duration = env.severity === 'fatal' ? 0 : 4000 } = opts;
  if (dedupe && shouldSuppress(dedupeKey)) return;

  // fatal 走 modal 持久化（duration:0 + showClose），其它走普通 toast。
  // 文案格式：[分类] 错误码 · 摘要（提示：下一步）
  const text = _formatToast(env);
  _toast({ message: text, type: toastType, duration, showClose: true, grouping: true }, text);
}

/**
 * 把任意输入规整成 KhyErrorShape —— 后端 envelope / 原生 Error / 字符串皆可。
 * 没匹配上任何已知 shape 的就走兜底 UNKNOWN。
 */
function _ensureKhy(input) {
  if (!input) return null;
  // 已是 KhyError
  if (input && input.isKhyError === true && typeof input.code === 'string') return input;
  // 后端 KhyErrorEnvelope（HTTP 响应里直接返回的）
  if (input && typeof input.code === 'string' && (input.category || input.severity)) return input;
  // 原生 Error / 字符串 / 任意 → 走分类器
  return classifyKhyError(input, { fallbackCode: 'UNKNOWN' });
}

/**
 * 把 KhyErrorShape 渲染成 toast 文案。
 * 形如：[warn] 上游服务 · RATE_LIMITED · 上游限流（提示：等几秒再试）
 */
function _formatToast(env) {
  const tag = env.severity === 'fatal' ? 'fatal' : (env.severity || 'error');
  const code = env.code || 'UNKNOWN';
  const msg = String(env.message || code).slice(0, 80);
  const hint = env.hint ? `（提示：${String(env.hint).slice(0, 60)}）` : '';
  return `[${tag}] ${code} · ${msg}${hint}`;
}

/**
 * 从任意 error/HTTP 响应里推导一句人话文案 —— 旧 API（向后兼容）。
 * 内部委托 notifyError，避免双实现。
 * @param {*} error
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function deriveErrorMessage(error, opts = {}) {
  const fallback = opts.fallback || '操作失败，请稍后重试。';
  if (!error) return fallback;
  // 拦截器已备好的文案优先。
  if (error.userMessage) return String(error.userMessage);
  const env = classifyKhyError(error, { fallbackCode: 'UNKNOWN' });
  // 从 KhyError 还原成老接口期望的纯文本。
  const hint = env.hint ? `（提示：${env.hint}）` : '';
  return `${env.message || env.code}${hint}`;
}

/**
 * Lightweight toast wrappers (FE-001 W9 — centralize ElMessage calls).
 * These bypass KhyError classification and directly wrap ElMessage.
 */
export function showSuccess(message, options = {}) {
  return _showToast('success', message, options);
}

export function showError(message, options = {}) {
  return _showToast('error', message, options);
}

export function showWarning(message, options = {}) {
  return _showToast('warning', message, options);
}

export function showInfo(message, options = {}) {
  return _showToast('info', message, options);
}

function _showToast(type, message, options = {}) {
  _toast({ message, type, showClose: true, ...options }, message);
}