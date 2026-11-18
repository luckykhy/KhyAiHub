'use strict';

const { z } = require('zod');

// 错误码枚举与 errors.js 的 CORE_ERROR_CODES 同源同长；两侧漂移由测试拦下。
const CoreErrorCodeSchema = z.enum([
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

// 线错误帧（4xx/5xx 响应体，[DESIGN-ARCH-220] §4.3 的 4xx 行）。
const CoreErrorPayloadSchema = z.object({
  code: CoreErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

module.exports = { CoreErrorCodeSchema, CoreErrorPayloadSchema };
