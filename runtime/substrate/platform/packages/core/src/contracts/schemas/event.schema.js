'use strict';

const { z } = require('zod');

// 跨终端事件帧（[DESIGN-ARCH-220] §3.2 CoreEvents）：seq 由 core 单调分配，
// id 由发布方提供、重复 id 不重复入序（§3.3 幂等清单 events.publish 行）。
const CoreEventSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  type: z.string().min(1),
  payload: z.unknown().optional(),
  terminalId: z.string().min(1).optional(),
});

// publish 入参：seq/ts 由 core 补，客户端不提供。
const PublishEventSchema = CoreEventSchema.omit({ seq: true, ts: true });

const EventFilterSchema = z.object({
  type: z.string().min(1).optional(),
  terminalId: z.string().min(1).optional(),
});

const EventAckSchema = z.object({
  subscriberId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

module.exports = { CoreEventSchema, PublishEventSchema, EventFilterSchema, EventAckSchema };
