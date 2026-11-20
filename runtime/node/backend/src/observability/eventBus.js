'use strict';

// 门面（B4，[DESIGN-ARCH-219] §10）：eventBus 本体已迁入
// packages/core/src/server/events/eventBus.js，此处只做 re-export——
// 7 个写者（coordinator/processAgent、coordinator/taskBoard、observability/
// {cpuProfiler,eventLoopMonitor,slowRequest}、services/usageTracker、
// tasks/largeTaskRuntimeStore）的调用面零改动，它们仍 require 本路径。
//
// 与 eventLog 门面同样：@khy/core 的 require 放进 getter，不占顶层 require
// （判据 #3：入口冷闭包不得出现 packages/core）。
let _bus = null;

function _events() {
  if (!_bus) {
    _bus = require('@khy/core/server/events');
  }
  return _bus;
}

module.exports = {
  get bus() {
    return _events().eventBus;
  },
  get CHANNEL() {
    return _events().CHANNEL;
  },
  publish: (event) => _events().publish(event),
  subscribe: (channel, handler) => _events().subscribe(channel, handler),
  subscribeAll: (handler) => _events().subscribeAll(handler),
};
