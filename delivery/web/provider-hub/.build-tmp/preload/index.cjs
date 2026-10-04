"use strict";
const electron = require("electron");
const hub = {
  cards: {
    list: () => electron.ipcRenderer.invoke("cards:list"),
    add: (input) => electron.ipcRenderer.invoke("cards:add", input),
    update: (cardId, patch) => electron.ipcRenderer.invoke("cards:update", cardId, patch),
    duplicate: (cardId) => electron.ipcRenderer.invoke("cards:duplicate", cardId),
    remove: (cardId) => electron.ipcRenderer.invoke("cards:remove", cardId),
    reorder: (cardId, toIndex) => electron.ipcRenderer.invoke("cards:reorder", cardId, toIndex),
    setActive: (app, cardId) => electron.ipcRenderer.invoke("cards:set-active", app, cardId),
    clearActive: (app) => electron.ipcRenderer.invoke("cards:clear-active", app),
    setFailover: (app, cardIds) => electron.ipcRenderer.invoke("cards:failover-set", app, cardIds),
    rotateFailover: (app) => electron.ipcRenderer.invoke("cards:failover-rotate", app)
  },
  keys: {
    list: () => electron.ipcRenderer.invoke("keys:list"),
    add: (input) => electron.ipcRenderer.invoke("keys:add", input),
    reveal: (provider, keyId) => electron.ipcRenderer.invoke("keys:reveal", provider, keyId)
  },
  models: {
    fetch: (cardId) => electron.ipcRenderer.invoke("models:fetch", { cardId }),
    apply: (cardId, models, defaultModel) => electron.ipcRenderer.invoke("models:apply", { cardId, models, defaultModel })
  },
  tools: {
    matrix: () => electron.ipcRenderer.invoke("tools:matrix"),
    detect: (apps) => electron.ipcRenderer.invoke("tools:detect", apps),
    importCard: (app, provider) => electron.ipcRenderer.invoke("tools:import", { app, provider }),
    // mode（DESIGN-ARCH-101 §6）：'proxy'（默认，写网关端点+令牌）| 'direct'（写 provider 真端点+真 key）
    apply: (app, cardId, mode) => electron.ipcRenderer.invoke("tools:apply", { app, cardId, mode })
  },
  proxy: {
    status: () => electron.ipcRenderer.invoke("proxy:status"),
    access: () => electron.ipcRenderer.invoke("proxy:access"),
    start: () => electron.ipcRenderer.invoke("proxy:start")
  },
  health: {
    probe: (cardId) => electron.ipcRenderer.invoke("health:probe", { cardId })
  },
  usage: {
    summary: (days) => electron.ipcRenderer.invoke("usage:summary", days)
  }
};
electron.contextBridge.exposeInMainWorld("khyHub", hub);
