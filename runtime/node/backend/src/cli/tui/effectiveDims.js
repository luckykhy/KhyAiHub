'use strict';

/**
 * effectiveDims — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 终端尺寸真源（stickyCols / stickyRows / contentWidth / contentHeight /
 * bandCols）是**通用终端能力**，不是视觉皮专属 —— 经典 REPL、CLI handler、
 * TUI 渲染都要用。此前它住在 src/cli/tui/ 下，于是：
 *   核心 toolUseLoopCore → AgentTool → cli/ai.js → … → cli/handlers/gateway.js
 *     → cli/tui/effectiveCols.js → cli/tui/effectiveDims.js → …
 * 把一个「所有端都要算终端宽度」的纯算法拖成了「TUI 的私有物」，
 * 逻辑芯因此渗入视觉皮。
 *
 * 剥洋葱的正确切法不是剪边，而是把该下沉的东西下沉：
 * 能力归位到通用层（utils/terminal/），皮只做门面。
 * 依赖方向从 芯→皮 变成 皮→芯。
 *
 * 【本文件的作用】
 * 保留 `require('../effectiveDims')` 这条既有调用路径可用，字节等价、
 * 不改任何调用方。真源已移到 utils/terminal/effectiveDims.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/effectiveDims.js
 */

module.exports = require('../../utils/terminal/effectiveDims');
