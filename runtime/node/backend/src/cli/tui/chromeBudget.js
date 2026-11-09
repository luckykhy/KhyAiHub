'use strict';

/**
 * chromeBudget — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 固定 chrome 行数账本（chromeRows）是纯算术叶子，被 effectiveDims /
 * railLayout / ccLayout 共用。此前住在 src/cli/tui/ 下，使这组通用几何
 * 算法整体被算进「视觉皮」，逻辑侧引用终端尺寸时会连带把 cli/tui/ 拖进
 * 芯的可达闭包。
 *
 * 剥洋葱的切法是把能力下沉到通用层，皮留门面。
 *
 * 【本文件的作用】
 * 保留 `require('../chromeBudget')` 这条既有调用路径可用，字节等价。
 * 真源已移到 utils/terminal/chromeBudget.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/chromeBudget.js
 */

module.exports = require('../../utils/terminal/chromeBudget');
