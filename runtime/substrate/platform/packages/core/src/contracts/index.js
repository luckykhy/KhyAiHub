'use strict';

// 契约面的运行时出口；TS 类型在 index.d.ts（手写，无编译步骤，[DESIGN-ARCH-220] §2.2）。
module.exports = {
  ...require('./errors'),
  ...require('./core-env'),
  ...require('./health'),
  ...require('./schemas/core-handle.schema'),
  ...require('./schemas/event.schema'),
  ...require('./schemas/data-ref.schema'),
  ...require('./schemas/session.schema'),
  ...require('./schemas/capability.schema'),
  ...require('./schemas/plugin.schema'),
  ...require('./schemas/error.schema'),
};
