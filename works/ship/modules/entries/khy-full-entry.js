#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for the full khy platform.
 * This is functionally equivalent to bin/khy.js but wrapped for pkg bundling.
 */

process.env.KHY_MODE = 'standalone';

// Keep this path static so esbuild includes the complete runtime dependency
// graph. Runtime resources are resolved separately from the emitted manifest.
// 方案 P 后 backend 在 runtime/node/backend：从 works/ship/modules/entries/ 出发
// 要四级才到仓库根（搬家前 packaging/modules/entries/ 只要三级）。
require('../../../../runtime/node/backend/bin/khy.js');
