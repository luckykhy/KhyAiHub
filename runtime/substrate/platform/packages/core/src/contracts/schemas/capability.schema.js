'use strict';

const { z } = require('zod');

// 能力三态（[DESIGN-ARCH-220] §3.2 CoreCapabilities）：missing = 装配期已报缺谁；
// degraded = optional 能力缺失被注销入口（D2 语义，子档 C 只判静态引用）。
const CapabilitySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  state: z.enum(['available', 'degraded', 'missing']),
  requiredBy: z.array(z.string().min(1)).optional(),
  reason: z.string().optional(),
});

const CapabilityRefSchema = z.object({
  capability: z.string().min(1),
  title: z.string().optional(),
  required: z.boolean().optional(),
});

module.exports = { CapabilitySchema, CapabilityRefSchema };
