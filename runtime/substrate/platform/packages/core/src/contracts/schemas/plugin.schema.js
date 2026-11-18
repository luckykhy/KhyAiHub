'use strict';

const { z } = require('zod');

// 插件信息面（[DESIGN-ARCH-220] §3.2 CorePlugins）：enable/disable 幂等，
// error 态必须带 reason。契约真源仍是 @khy/plugin-sdk，本包不复制其 manifest 解析。
const PluginInfoSchema = z.object({
  namespace: z.string().min(1),
  version: z.string().min(1),
  state: z.enum(['enabled', 'disabled', 'error']),
  reason: z.string().optional(),
});

// plugin.changed 事件载荷：一次启用、所有终端立即可见（组合态体验 5）。
const PluginChangedPayloadSchema = z.object({
  namespace: z.string().min(1),
  state: z.enum(['enabled', 'disabled', 'error']),
  coreId: z.string().min(1),
});

module.exports = { PluginInfoSchema, PluginChangedPayloadSchema };
