'use strict';

/**
 * noticeInbox — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 会话期「宿主想让用户看见、但不能自己写屏」的一行话收件箱，是一套
 * **发布订阅机制**：逻辑侧投递（push），表现侧订阅并落成屏幕上的消息区。
 * 它本身零 IO、零依赖，与「怎么渲染」无关。
 *
 * 但它此前住在 src/cli/tui/ 下，于是逻辑层要投递一行通知时，只能去
 * require 视觉皮 —— 逻辑芯的可达闭包因此渗入 cli/tui/。
 *
 * 剥洋葱的切法是把机制下沉到通用层，皮只保留门面。
 *
 * 【本文件的作用】
 * 保留 `require('./noticeInbox')` 这条既有调用路径可用，字节等价。
 * 真源已移到 utils/terminal/noticeInbox.js。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/noticeInbox.js
 */

module.exports = require('../../utils/terminal/noticeInbox');
