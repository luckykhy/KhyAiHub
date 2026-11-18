'use strict';

// 可被第三方复用的最小断言集（[DESIGN-ARCH-220] §14.5）：仓内 packages/core/test 与
// 仓外终端的接入自测都调用同一份，避免「仓内一套、第三方另一套」。
const { CORE_ERROR_CODES, CoreError } = require('../src/contracts/errors');
const { CORE_PROTOCOL_VERSION, healthMatchesLocator } = require('../src/contracts/health');
const { CoreHealthResponseSchema } = require('../src/contracts/health');

function assertContractSurface() {
  if (CORE_ERROR_CODES.length !== 13) {
    throw new Error(`错误码应登记 13 个，实得 ${CORE_ERROR_CODES.length}`);
  }
  if (typeof CoreError !== 'function' || typeof healthMatchesLocator !== 'function') {
    throw new Error('契约面缺少 CoreError 或 healthMatchesLocator');
  }
  if (!Number.isInteger(CORE_PROTOCOL_VERSION) || CORE_PROTOCOL_VERSION < 1) {
    throw new Error('protocolVersion 必须是不小于 1 的整数');
  }
  return { errorCodes: CORE_ERROR_CODES.length, protocolVersion: CORE_PROTOCOL_VERSION };
}

function assertHealthFrame(health) {
  const parsed = CoreHealthResponseSchema.safeParse(health);
  if (!parsed.success) {
    throw new Error(`健康帧不合法：${parsed.error.issues.map((i) => i.path.join('.')).join(',')}`);
  }
  return parsed.data;
}

module.exports = { assertContractSurface, assertHealthFrame };
