'use strict';

// 门面（B4，[DESIGN-ARCH-219] §10）：eventLog 本体已迁入
// packages/core/src/server/events/eventLog.js。此处注入宿主侧的 events 目录
// （后端 dataHome.js 的 getDataDir('events')）——core 不回引 backend，
// 路径由宿主下发；7 个写者的调用面零改动。
//
// @khy/core 的 require 故意做成**懒加载**：判据 #3 要求「入口冷闭包内不得出现
// packages/core」（bin/khy.js 与三个 L1 根的顶层 require 预算零余量），顶层 require
// 会把 core 拖进 aiGateway 的冷闭包；放进 _log() 后，只有真写事件时才加载。
let _impl = null;
let _busModule = null;

function _bus() {
  if (!_busModule) {
    _busModule = require('@khy/core/server/events');
  }
  return _busModule;
}

function _getEventsDir() {
  // 懒加载：避免门面被 require 时就拉起 dataHome 的指针文件解析。
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('events');
}

function _log() {
  if (!_impl) {
    _impl = _bus().createEventLog({ getEventsDir: _getEventsDir });
  }
  return _impl;
}

module.exports = {
  append: (event) => _log().append(event),
  read: (filter) => _log().read(filter),
  replay: (filter, onEvent) => _log().replay(filter, onEvent),
  snapshot: (taskId, fullState, opts) => _log().snapshot(taskId, fullState, opts),
  getEventsDir: () => _log().getEventsDir(),
  // re-export bus helpers so consumers can require a single module（惰性取值）
  get bus() {
    return _bus().eventBus;
  },
  get CHANNEL() {
    return _bus().CHANNEL;
  },
  subscribe: (channel, handler) => _log().subscribe(channel, handler),
  subscribeAll: (handler) => _log().subscribeAll(handler),
  publish: (event) => _log().publish(event),
};
