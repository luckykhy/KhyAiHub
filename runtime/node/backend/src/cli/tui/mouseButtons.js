'use strict';

/**
 * mouseButtons — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 终端鼠标能力分级（mouseTier / autoDetectTerminal）是终端环境的通用探测，
 * 不是视觉皮专属。它此前住在 src/cli/tui/ 下，被 terminalCapabilities
 * 与渲染层引用；逻辑侧一旦需要终端能力探测，就会把整个视觉皮拖进闭包。
 *
 * 剥洋葱的切法是「把该下沉的东西下沉」——能力归位到通用层，皮只做门面。
 *
 * 【本文件的作用】
 * 保留 `require('./mouseButtons')` 这条既有调用路径可用，字节等价、
 * 不改任何调用方。真源已移到 utils/terminal/mouseButtons.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/mouseButtons.js
 */

module.exports = require('../../utils/terminal/mouseButtons');
