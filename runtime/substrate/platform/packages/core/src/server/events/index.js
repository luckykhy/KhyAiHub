'use strict';

// 事件块出口（B4，[DESIGN-ARCH-219] §10）：eventBus + eventLog 本体在 core，
// 宿主（backend / desktop / 第三方）经 createEventLog 注入自己的 events 目录。
const { createEventBus, eventBus, CHANNEL } = require('./eventBus');
const { createEventLog, eventLog } = require('./eventLog');

module.exports = {
  createEventBus,
  eventBus,
  createEventLog,
  eventLog,
  CHANNEL,
  publish: (event) => eventLog.publish(event),
  subscribe: (channel, handler) => eventLog.subscribe(channel, handler),
  subscribeAll: (handler) => eventLog.subscribeAll(handler),
  append: (event) => eventLog.append(event),
  read: (filter) => eventLog.read(filter),
  replay: (filter, onEvent) => eventLog.replay(filter, onEvent),
  snapshot: (taskId, state, opts) => eventLog.snapshot(taskId, state, opts),
  getEventsDir: () => eventLog.getEventsDir(),
};
