'use strict';

/**
 * sidebarLayout — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 侧栏布局判定（stickyDim / fallbackCols / mainColumnCols / isFullscreen）
 * 是纯函数叶子：不读 IO、不碰渲染、被侧栏与右栏两个布局器共用。
 * 它此前住在 src/cli/tui/ 下，于是「被两侧布局共用的通用算法」被算成了
 * 「视觉皮私产」，逻辑侧一旦要用终端宽度就会把整个 cli/tui/ 拖进闭包。
 *
 * 剥洋葱的切法是把能力下沉到通用层，皮留门面。
 *
 * 【本文件的作用】
 * 保留 `require('../sidebarLayout')` 这条既有调用路径可用，字节等价。
 * 真源已移到 utils/terminal/sidebarLayout.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/sidebarLayout.js
 */

module.exports = require('../../utils/terminal/sidebarLayout');
