'use strict';

const { z } = require('zod');

// 锁记录（[DESIGN-ARCH-220] §4.2）：tokenHash 只存在锁文件，绝不出现在 /core/health。
const CoreLockRecordSchema = z.object({
  coreId: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string().min(1),
  tokenHash: z.string().min(1),
  protocolVersion: z.number().int(),
  coreVersion: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  startedAt: z.number(),
  heartbeatAt: z.number(),
});

// locator.json（发现面）：指纹字段 coreId/protocolVersion/pid 与 /core/health 全等才认（§4.5）。
const LocatorRecordSchema = z.object({
  coreId: z.string().min(1),
  protocolVersion: z.number().int(),
  pid: z.number().int().positive(),
  endpoint: z.string().min(1),
  tokenHash: z.string().min(1).optional(),
  epoch: z.number().int().nonnegative(),
  coreVersion: z.string().min(1),
  heartbeatAt: z.number().optional(),
});

const CoreVersionSchema = z.object({
  core: z.string().min(1),
  protocol: z.number().int(),
  enginesKhy: z.string().min(1),
});

// attach 握手帧（§4.3）：protocolVersion 必须相等，clientVersion 走 enginesKhy 区间。
const HelloRequestSchema = z.object({
  protocolVersion: z.number().int(),
  clientVersion: z.string().min(1),
  terminalId: z.string().min(1),
  required: z.array(z.string().min(1)).default([]),
});

const HelloResponseSchema = z.object({
  coreId: z.string().min(1),
  coreVersion: z.string().min(1),
  protocolVersion: z.number().int(),
  enginesKhy: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  capabilities: z.array(
    z.object({
      id: z.string().min(1),
      state: z.enum(['available', 'degraded', 'missing']),
      version: z.string().min(1),
    }),
  ),
  paths: z.record(z.string()),
  sessionToken: z.string().min(1),
  expiresAt: z.number(),
});

module.exports = {
  CoreLockRecordSchema,
  LocatorRecordSchema,
  CoreVersionSchema,
  HelloRequestSchema,
  HelloResponseSchema,
};
