'use strict';

const { z } = require('zod');

// 协议版本：相等才可连；升版 = MAJOR，走人批准（[DESIGN-ARCH-220] §14.5）。
const CORE_PROTOCOL_VERSION = 1;

// /core/health 是新增面（全仓原无 core/health 字符串）；tokenHash 只存在于锁文件，
// 绝不进这个只读探针面，避免把凭据散进无需鉴权的响应。
const CoreHealthResponseSchema = z.object({
  status: z.literal('ok'),
  coreId: z.string().min(1),
  protocolVersion: z.number().int(),
  pid: z.number().int(),
  port: z.number().int(),
  epoch: z.number().int(),
  coreVersion: z.string().min(1),
  uptimeMs: z.number().nonnegative(),
  capabilities: z.array(
    z.object({
      id: z.string().min(1),
      state: z.enum(['available', 'degraded', 'missing']),
      version: z.string().min(1),
    }),
  ),
});

// 指纹三字段（[DESIGN-ARCH-220] §4.5）：三者与 locator 全等才认，否则 CORE_PROTOCOL_MISMATCH。
function healthFingerprint(health) {
  return { coreId: health.coreId, protocolVersion: health.protocolVersion, pid: health.pid };
}

function healthMatchesLocator(health, locator) {
  const fp = healthFingerprint(health);
  return fp.coreId === locator.coreId && fp.protocolVersion === locator.protocolVersion && fp.pid === locator.pid;
}

module.exports = { CORE_PROTOCOL_VERSION, CoreHealthResponseSchema, healthFingerprint, healthMatchesLocator };
