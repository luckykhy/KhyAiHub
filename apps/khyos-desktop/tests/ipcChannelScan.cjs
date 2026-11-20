// ipcChannelScan.cjs — 「preload invoke 的每个通道都在主进程有 handler」的共用扫描器。
// 由 keyManagerContract.test.cjs ⑯ 与 khyPet.test.cjs P7 两条守卫共用（同一条不变量，
// 两个消费方），也是 tests/ 下继 amooPanel.harness.tsx 之后的第二个非测试辅助件。
//
// 三条实现约束，每条都是踩过的：
//   1. 两侧都按目录枚举，不列文件清单。handler 注册点已经散在 index.ts、
//      keyManager/ipc.ts、editor/ipc.ts、agentbusBridge.ts 四处；列清单就意味着每加一个
//      注册点都要回来改一次，改漏了这条断言就被人为跳过——那正是它要防的事。
//   2. 注册有时走常量（agentbusBridge 就是 ipc.handle(CHANNEL_STATUS, ...)），字面量
//      grep 看不见，所以先把 `const X = 'y'` 收下来再解析 handle(X)。
//   3. 正则里的引号一律写 \x27。scripts/ci/check-file-ratchet.js 的括号扫描器不识别
//      正则字面量：源码里出现奇数个单引号，它就把后面的花括号当成字符串内容，
//      maxFuncLines 立刻虚高几十行（实测 13 → 40）。
'use strict';

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

// amooSecretary 那族注册在 host 进程（src/host/amooSecretaryIpc.ts），不在主进程，
// 主进程侧的守卫本来就管不到它们——显式豁免，而不是让正则漏掉（漏了会把「主进程侧
// 漂移」一起漏掉）。
const HOST_PROCESS_PREFIXES = ['amooSecretary:'];

function walkTsFiles(root, dir, out) {
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walkTsFiles(root, rel, out);
    else if (ent.name.endsWith('.ts')) out.push(readFileSync(join(root, rel), 'utf-8'));
  }
  return out;
}

/** preload 侧（index.ts 本体 + 同目录所有片段）invoke 的通道名。 */
function preloadInvokeChannels(root) {
  const channels = [];
  for (const src of walkTsFiles(root, 'src/preload', [])) {
    for (const m of src.matchAll(/invoke\(\s*\x27([^\x27]+)\x27/g)) channels.push(m[1]);
  }
  return channels.filter((ch) => !HOST_PROCESS_PREFIXES.some((p) => ch.startsWith(p)));
}

function handledChannelsOf(src) {
  const consts = new Map();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\x27([^\x27]+)\x27/g)) consts.set(m[1], m[2]);
  const out = [];
  for (const m of src.matchAll(/ipc(?:Main)?\.handle\(\s*(?:\x27([^\x27]+)\x27|([A-Za-z_$][\w$]*))\s*[,)]/g)) {
    const channel = m[1] || consts.get(m[2]);
    if (channel) out.push(channel);
  }
  return out;
}

/** 主进程侧（src/main 下所有 .ts）已注册的通道名。 */
function mainHandledChannels(root) {
  const out = [];
  for (const src of walkTsFiles(root, 'src/main', [])) out.push(...handledChannelsOf(src));
  return out;
}

/** 便捷入口：返回「preload 用了但主进程没注册」的通道名列表（空 = 对齐）。 */
function unregisteredChannels(root) {
  const handled = new Set(mainHandledChannels(root));
  return preloadInvokeChannels(root).filter((ch) => !handled.has(ch));
}

/**
 * 主进程侧**重复注册**的通道名列表（空 = 无撞名）。
 *
 * 为什么单独立这条：unregisteredChannels 问的是「有没有人 handle」，撞名时两边
 * 都有人 handle，它永远绿。而 Electron 的 ipcMain.handle 对已注册通道直接抛
 * 'Attempted to register a second handler' —— 真实事故形态是
 * registerKeyManagerIpc()（在 app.whenReady 里早于 createWindow 调用）与
 * createWindow 内部的 host 转发注册同一个 `models:list`，createWindow 抛错后
 * 其后约 44 个 handler 全丢、主窗永不显示。方案自带测试全绿然后炸，就是因为
 * 假 ipc 是 Map（重复注册静默覆盖）。
 */
function duplicateChannels(root) {
  const counts = new Map();
  for (const ch of mainHandledChannels(root)) counts.set(ch, (counts.get(ch) || 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([ch]) => ch);
}

module.exports = { preloadInvokeChannels, mainHandledChannels, unregisteredChannels, duplicateChannels };
