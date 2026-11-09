'use strict';

// envUiContract.test.cjs — 开发环境页（#/environments）的通道契约。
//
// desktopUiContract 的 D6 只校验 preload invoke ↔ main handle 字面量配对，**不校验
// main↔host** —— host 侧 6 组消息漏登记任何一处，运行时表现为 IPC 挂死（诚实超时
// 文案）且不会红任何测试。本测试补上这层面：
//   E1: env:* 七通道 preload invoke ↔ main ipcMain.handle 配对（D6 同款，限定 env）
//   E2: 六组 main↔host 消息在 host/index.ts 协议头注释与 dispatch 双登记 + main 发送侧
//   E2b: 六组 env.*Result 在 main 有 pending 表认领
//   E3: 流事件 env.progress / env.jobDone 在 main 映射表、host 发射点、preload 订阅三侧登记
//   E4: preload 暴露 7 方法 + onEnvProgress/onEnvJobDone 订阅包装
//   E5: 页面挂进导航与路由（sidebar 按钮 + App lazy import + route 布尔）

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const mainSrc = readFileSync(join(projectRoot, 'src', 'main', 'index.ts'), 'utf-8');
const hostSrc = readFileSync(join(projectRoot, 'src', 'host', 'index.ts'), 'utf-8');
const preloadSrc = readFileSync(join(projectRoot, 'src', 'preload', 'index.ts'), 'utf-8');

const IPC_CHANNELS = [
  'env:catalog',
  'env:scan',
  'env:install',
  'env:importPreview',
  'env:importApply',
  'env:export',
  'env:lastScan',
];

// env:lastScan 不经 host（main 直读数据家快照），host 侧只登记其余六组。
const HOST_MSGS = [
  'env.catalog',
  'env.scan',
  'env.install',
  'env.importPreview',
  'env.importApply',
  'env.export',
];

test('E1: preload 对每个 env:* 通道都有 invoke，main 都有 ipcMain.handle', () => {
  for (const ch of IPC_CHANNELS) {
    assert.match(
      preloadSrc,
      new RegExp(`ipcRenderer\\.invoke\\(['"\`]${ch}['"\`]`),
      `preload 缺 ${ch} 的 invoke`
    );
    assert.match(
      mainSrc,
      new RegExp(`ipcMain\\.handle\\(['"\`]${ch}['"\`]`),
      `main 缺 ${ch} 的 ipcMain.handle`
    );
  }
});

test('E2: 六组 main↔host 消息在 host 协议头与 dispatch 双登记，main 有发送侧', () => {
  for (const msg of HOST_MSGS) {
    assert.ok(hostSrc.includes(`type: '${msg}'`), `host 协议头缺 ${msg} 登记`);
    assert.match(hostSrc, new RegExp(`msg\\.type === '${msg}'`), `host dispatch 缺 ${msg} 分支`);
    assert.match(mainSrc, new RegExp(`type: '${msg}'`), `main 发送侧缺 ${msg}`);
  }
});

test('E2b: 六组 env.*Result 在 main 有 pending 表认领', () => {
  for (const msg of HOST_MSGS) {
    assert.match(mainSrc, new RegExp(`'${msg}Result':`), `main 缺 ${msg}Result 的 pending 映射`);
  }
});

test('E3: env.progress / env.jobDone 三侧登记（main 映射表 + host 发射 + preload 订阅）', () => {
  for (const ev of ['env.progress', 'env.jobDone']) {
    const colon = ev.replace('.', ':');
    assert.match(
      mainSrc,
      new RegExp(`'${ev}'\\s*:\\s*'${colon}'`),
      `main HOST_EVENT_TO_RENDERER_CHANNEL 缺 ${ev}`
    );
    assert.ok(hostSrc.includes(`type: '${ev}'`), `host 缺 ${ev} 发射点`);
    assert.match(
      preloadSrc,
      new RegExp(`ipcRenderer\\.on\\(['"\`]${colon}['"\`]`),
      `preload 缺 ${colon} 订阅`
    );
  }
});

test('E4: preload 暴露 env 方法集与订阅包装', () => {
  const methods = [
    'envCatalog',
    'envScan',
    'envInstall',
    'envImportPreview',
    'envImportApply',
    'envExport',
    'envLastScan',
    'onEnvProgress',
    'onEnvJobDone',
  ];
  for (const m of methods) {
    assert.match(preloadSrc, new RegExp(`\\b${m}:`), `preload 缺 ${m}`);
  }
});

test('E5: 开发环境页挂进导航与路由（sidebar 按钮 + App lazy + route 布尔）', () => {
  const sidebarSrc = readFileSync(
    join(projectRoot, 'src', 'renderer', 'components', 'layout', 'WorkspaceSidebar.tsx'),
    'utf-8'
  );
  const appSrc = readFileSync(join(projectRoot, 'src', 'renderer', 'App.tsx'), 'utf-8');
  assert.match(sidebarSrc, /#\/environments/, '侧栏缺「开发环境」入口');
  assert.match(appSrc, /environments\/EnvironmentsPage/, 'App 缺 EnvironmentsPage lazy import');
  assert.match(appSrc, /route === 'environments'/, 'App 缺 environments 路由布尔');
});
