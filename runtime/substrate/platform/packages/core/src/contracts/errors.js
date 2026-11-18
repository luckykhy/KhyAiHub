'use strict';

// 13 个 CORE_*/CAPABILITY_* 码：先登记进 API-SURFACE.json 再实现（[DESIGN-ARCH-220] §3.4，
// API-001 的「先登记后实现」）。新增或删减这个数组必须同批改登记件与 error.schema.js 的枚举。
const CORE_ERROR_CODES = Object.freeze([
  'CORE_UNAVAILABLE',
  'CORE_LOCKED',
  'CORE_TAKEN_OVER',
  'CORE_PROTOCOL_MISMATCH',
  'CORE_VERSION_MISMATCH',
  'CORE_AUTH_FAILED',
  'CORE_INVALID_ARGUMENT',
  'CORE_INTERNAL',
  'CORE_LOCATOR_FAILED',
  'CAPABILITY_UNAVAILABLE',
  'CORE_STORAGE_CONFLICT',
  'CORE_SESSION_NOT_FOUND',
  'CORE_EVENT_GAP',
]);

// 端点探活类失败重试有意义；定位失败（安装/打包问题）重试无意义（[DESIGN-ARCH-220] §3.4 分工）。
const RETRYABLE_CODES = new Set(['CORE_UNAVAILABLE', 'CORE_EVENT_GAP']);

const CORE_ERROR_HINTS = Object.freeze({
  CORE_LOCKED: '同一数据家只允许一个核心写者；运行 khy doctor 查看核心状态，或设置 KHY_CORE_ENDPOINT 连接它',
  CORE_LOCATOR_FAILED: '检查 @khy/core 是否随发行包安装，或由宿主经 bundledEntry 注入实现',
  CORE_PROTOCOL_MISMATCH: '升级客户端或核心到同一 protocolVersion 后重试，禁止对指纹不符的端口另起核心',
  CORE_VERSION_MISMATCH: '按 enginesKhy 区间升级 clientVersion',
  CORE_AUTH_FAILED: '重新配对或更新 token 后重试',
  CORE_UNAVAILABLE: '稍后重试；持续失败运行 khy doctor',
  CAPABILITY_UNAVAILABLE: '该能力由提供方声明，缺失时入口会被注销；检查对应终端/插件是否在装配面内',
  CORE_EVENT_GAP: '用 replay({ since: lastAck }) 补齐断线期间事件',
  CORE_STORAGE_CONFLICT: '重新读取该 ref 的最新 version 后重试写入',
  CORE_SESSION_NOT_FOUND: '确认 sessionId 来自本核心的 session.list',
  CORE_TAKEN_OVER: '本句柄已被新 epoch 接管；重新 obtainCore 获取句柄',
  CORE_INVALID_ARGUMENT: '按 details 里的字段说明修正参数',
  CORE_INTERNAL: '收集 details 与时间点后报告',
});

class CoreError extends Error {
  constructor(code, message, options = {}) {
    if (!CORE_ERROR_CODES.includes(code)) {
      throw new Error(`未登记的核心错误码：${code}（先入 API-SURFACE 再使用）`);
    }
    super(message || code);
    this.name = 'CoreError';
    this.code = code;
    this.retryable = options.retryable !== undefined ? options.retryable : RETRYABLE_CODES.has(code);
    if (options.details !== undefined) this.details = options.details;
  }
}

// RUNTIME-002 模板：{问题一句话}（{码}）：{原因}，{修复建议}
function formatCoreError(code, cause) {
  const hint = CORE_ERROR_HINTS[code];
  if (!hint) {
    throw new Error(`错误码 ${code} 缺少用户可见修复建议（CORE_ERROR_HINTS 必须逐码给全）`);
  }
  return cause ? `${code}：${cause}，${hint}` : `${code}：${hint}`;
}

module.exports = {
  CORE_ERROR_CODES,
  RETRYABLE_CODES,
  CORE_ERROR_HINTS,
  CoreError,
  formatCoreError,
};
