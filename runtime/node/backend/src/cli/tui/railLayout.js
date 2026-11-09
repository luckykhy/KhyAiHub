'use strict';

/**
 * railLayout — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 右栏布局判定（railGateOn / contentCols / railGeometry）是纯函数叶子，
 * 与 effectiveDims / sidebarLayout 同属一组终端几何真源。此前住在
 * src/cli/tui/ 下，使这组通用算法整体被算进「视觉皮」，逻辑侧引用终端
 * 尺寸时会连带把 cli/tui/ 拖进闭包。
 *
 * 剥洋葱的切法是把能力下沉到通用层，皮留门面。
 *
 * 【本文件的作用】
 * 保留 `require('../railLayout')` 这条既有调用路径可用，字节等价。
 * 真源已移到 utils/terminal/railLayout.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/railLayout.js
 */

module.exports = require('../../utils/terminal/railLayout');
