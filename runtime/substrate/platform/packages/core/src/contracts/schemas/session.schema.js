'use strict';

const { z } = require('zod');

// 会话面（[DESIGN-ARCH-220] §3.2 CoreSession）：append 按 clientMsgId 幂等去重，
// 是重连续传的基础（§3.3）。
const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  cwd: z.string().min(1),
  terminalId: z.string().min(1),
  createdAt: z.number(),
});

const SessionMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  clientMsgId: z.string().min(1),
  ts: z.number().optional(),
});

const AppendResultSchema = z.object({
  seq: z.number().int().nonnegative(),
  deduped: z.boolean(),
});

const SessionHitSchema = z.object({
  sessionId: z.string().min(1),
  snippet: z.string(),
});

const SessionGroupSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
});

module.exports = { SessionMetaSchema, SessionMessageSchema, AppendResultSchema, SessionHitSchema, SessionGroupSchema };
