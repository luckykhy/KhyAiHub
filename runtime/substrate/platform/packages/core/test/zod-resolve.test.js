'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// D9：zod 是 core 唯一的运行时依赖且精确锁版。本断言要求包根可解析——
// 必须在 pnpm install 之后运行（暂存态未装依赖会红，见 APPLY.md 步骤 4）。
test('zod 从包根可解析', () => {
  const resolved = require.resolve('zod', { paths: [path.join(__dirname, '..')] });
  assert.ok(resolved.toLowerCase().includes('zod'), resolved);
});
