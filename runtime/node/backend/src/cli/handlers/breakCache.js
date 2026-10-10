'use strict';

/**
 * breakCache.js — `/break-cache` 命令薄壳:调度/开启/关闭 Anthropic 前缀缓存击穿。
 * 对齐 Claude Code `/break-cache`。
 *
 * **背后逻辑**(scope 解析、措辞、统计聚合)全在纯叶子 `cli/breakCache.js`;
 * 文件副作用(marker/flag/事件日志)在薄壳 `services/gateway/breakCacheState.js`;
 * 真正的缓存击穿在网关消费侧 `claudeAdapter` 调用 `consumeCacheBreakNonce` 完成。
 *
 * 门控 KHY_BREAK_CACHE 默认开;关 → 命令不接管(返回 false 字节回退),
 * 且网关侧 consumeCacheBreakNonce 恒返回 ''(绝不注入 nonce)。
 */

const state = require('../../services/gateway/breakCacheState');
const leaf = require('../breakCache');
const { printInfo, printSuccess, printError } = require('../formatters');

async function handleBreakCache(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('break-cache 命令未启用(KHY_BREAK_CACHE=off)。');
    return false;
  }

  const tokens = [subCommand]
    .concat(Array.isArray(args) ? args : [])
    .filter((t) => t != null && t !== '');
  const scope = leaf.parseScope(tokens);

  switch (scope) {
    case 'status': {
      const { stats, onceActive, alwaysActive } = state.status();
      printInfo(leaf.formatStatus(stats, onceActive, alwaysActive));
      return true;
    }
    case 'off': {
      const { cleared, error } = state.disable();
      if (error) {
        const { marker, always } = state.getPaths();
        printError(
          `缓存击穿标记移除失败:${error} —— 标记仍在磁盘上,击穿仍会生效。` +
            `请检查这两个路径是否可删除:\n  ${marker}\n  ${always}`
        );
        return true;
      }
      printSuccess(leaf.formatOff(cleared));
      return true;
    }
    case 'clear': {
      const { hadMarker, marker, error } = state.clearOnce();
      if (error) {
        printError(
          `清除一次性缓存击穿 marker 失败:${error} —— marker 仍在,下一次请求仍会击穿。` +
            `请检查该路径是否可删除:\n  ${marker}`
        );
        return true;
      }
      printSuccess(leaf.formatClear(hadMarker, marker));
      return true;
    }
    case 'always': {
      const { always, error } = state.enableAlways();
      if (error) {
        printError(
          `缓存击穿持久 flag 写入失败:${error} —— 未落盘,后续请求不会击穿。` +
            `请检查该路径是否可写:\n  ${always}`
        );
        return true;
      }
      printSuccess(leaf.formatAlways(always));
      return true;
    }
    case 'once': {
      const { marker, stats, error } = state.scheduleOnce();
      if (error) {
        printError(
          `缓存击穿 marker 写入失败:${error} —— 未落盘,下一次请求不会击穿。` +
            `请检查该路径是否可写:\n  ${marker}`
        );
        return true;
      }
      printSuccess(leaf.formatOnce(stats, marker));
      return true;
    }
    default:
      printInfo(leaf.USAGE_TEXT);
      return true;
  }
}

module.exports = { handleBreakCache };
