'use strict';

/**
 * effectiveCols — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * effectiveCols 是 effectiveDims 的 legacy 别名，而 effectiveDims 是终端尺寸
 * 真源（通用能力，非视觉皮专属）。此前住在 src/cli/tui/ 下，导致逻辑芯
 * （核心 toolUseLoopCore 的可达闭包）渗入 cli/tui/ —— 实测 8 个文件。
 *
 * 剥洋葱的切法是把能力下沉到通用层，皮留门面。
 *
 * 【本文件的作用】
 * 保留 `require('../effectiveCols')` 这条既有调用路径可用，字节等价。
 * 真源已移到 utils/terminal/effectiveCols.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/effectiveCols.js
 */

module.exports = require('../../utils/terminal/effectiveCols');
