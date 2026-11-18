'use strict';

const { z } = require('zod');

// DataRef：契约面不出现绝对路径，档位真源是 DATA-LOCATIONS.json（[DESIGN-ARCH-220] §3.2）。
const DataTierSchema = z.enum(['T0', 'T1', 'T2', 'T3', 'T4']);

const DataRefSchema = z.object({
  tier: DataTierSchema,
  name: z.string().min(1),
});

const DataRefInfoSchema = DataRefSchema.extend({
  version: z.string().min(1),
  size: z.number().nonnegative().optional(),
});

// ifVersion 不匹配时服务端抛 CORE_STORAGE_CONFLICT（§3.3 幂等清单 storage.write 行）。
const StorageWriteResultSchema = z.object({
  version: z.string().min(1),
});

module.exports = { DataTierSchema, DataRefSchema, DataRefInfoSchema, StorageWriteResultSchema };
