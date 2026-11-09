'use strict';

/**
 * terminalCapabilities — RE-EXPORT（洋葱下沉后的皮侧门面）。
 *
 * 【为什么它搬到了 utils/terminal/】
 * 这份文件自己写着「Single source of truth for terminal capability detection
 * across ALL surfaces (CLI, TUI)」——也就是说它服务的不止 TUI。
 * 但它此前住在 src/cli/tui/runtime/ 下，于是：
 *   核心 toolUseLoopCore → AgentTool → cli/ai.js → … → cli/palette.js
 *     → cli/tui/runtime/terminalCapabilities.js
 * 把一个「所有端都要用的终端能力探测」拖成了「视觉皮的私有物」，
 * 逻辑芯因此渗入视觉皮（实测：芯的可达闭包里有 8 个 cli/tui/ 文件）。
 *
 * 剥洋葱的正确切法不是「剪这条边」（cli/palette.js 还需要它），
 * 而是「把该下沉的东西下沉」：能力归位到通用层，皮只做门面。
 * 于是依赖方向从 芯→皮 变成 皮→芯，方向正确了，重量自然分开。
 *
 * 【本文件的作用】
 * 保留 `require('../runtime/terminalCapabilities')` 这条既有调用路径可用，
 * 字节等价、不改任何调用方。真源已移到 utils/terminal/terminalCapabilities.js。
 * 新代码请直接 require utils/terminal/terminalCapabilities。
 *
 * 【真源】runtime/node/backend/src/utils/terminal/terminalCapabilities.js
 *
 * 2026-11-02 修：原写法是 `require('../../utils/terminal/terminalCapabilities')`。
 * 从 src/cli/tui/runtime/ 出发 `../../` 只落到 src/cli/，解析成
 * src/cli/utils/terminal/terminalCapabilities —— 该路径不存在，真源在 src/utils/ 下，
 * 差一级 `..`。这是个潜伏崩溃：本文件整个就只有这一行 re-export，谁 require 它谁
 * MODULE_NOT_FOUND，而惰性 require 意味着只有加载该模块时才炸。
 * check-repo-layout 的 unresolved-require 判据（基线 0）报的就是这一条。
 */

module.exports = require('../../../utils/terminal/terminalCapabilities');
