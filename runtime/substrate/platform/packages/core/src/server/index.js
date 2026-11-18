'use strict';

const { z } = require('zod');

const { CoreError } = require('../contracts/errors');
const { CORE_PROTOCOL_VERSION } = require('../contracts/health');
const { CoreLockRecordSchema } = require('../contracts/schemas/core-handle.schema');

// 零业务骨架（[DESIGN-ARCH-220] §12 的 S4 才承接 HTTP/WS 与六成员）。本刀只验证参数形状，
// 起服务这一步如实报未接线：调用方要么等 S4，要么经 bundledEntry 注入真实实现。
const CreateCoreServerOptionsSchema = z.object({
  dataHome: z.string().min(1).nullable(),
  bindHost: z.string().min(1).optional(),
  lock: CoreLockRecordSchema.optional(),
});

function createCoreServer(options) {
  let opts;
  try {
    opts = CreateCoreServerOptionsSchema.parse(options);
  } catch (err) {
    const issues = err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String(err)];
    throw new CoreError('CORE_INVALID_ARGUMENT', `createCoreServer 参数不合法：${issues.join('；')}，按 CreateCoreServerOptionsSchema 修正`, {
      retryable: false,
      details: { issues },
    });
  }

  return {
    coreId: opts.lock ? opts.lock.coreId : null,
    protocolVersion: CORE_PROTOCOL_VERSION,
    async start() {
      throw new CoreError(
        'CORE_UNAVAILABLE',
        'core server 未随本刀落地：HTTP/WS 与六成员通道在 S4/S5 实施，embedded 需宿主经 bundledEntry 注入真实实现或等待 S4；当前为零业务骨架',
        { retryable: false, details: { reason: 'skeleton' } },
      );
    },
    async close() {
      // 骨架没有可释放资源；保留接口供 S4 直接填充。
    },
  };
}

module.exports = { createCoreServer, CORE_PROTOCOL_VERSION };
