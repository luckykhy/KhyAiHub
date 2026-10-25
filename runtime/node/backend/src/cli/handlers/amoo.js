'use strict';

/**
 * amoo.js — `khy amoo` 命令薄壳：khy-os 与手机上 Amoo 的协作面。
 *
 * 背后逻辑全在 services/domain/network/amoo/：解析与文案在纯叶子 amooCliPlan.js，
 * adb/桥 HTTP/屏幕 dump 的 IO 在 amooBridgeClient.js 与 amooDispatchRunner.js。
 * 本文件只做：门控、解析、委托、打印。
 *
 * 方向（README 的三问里写明了为什么两个方向都要从这个命令面出去）：
 *   ① PC → Amoo：`khy amoo send` 在手机界面上输入、发送、轮询答复。
 *      这一步会真的动你的手机，所以默认只给计划，必须 --confirm。
 *   ② Amoo → PC ：`khy amoo client …` 转发给手机侧单文件客户端（amoo-khy-client.js）。
 *      这是日常路径：不依赖 UI 自动化、不需要无障碍权限。
 *
 * 门控 KHY_AMOO_BRIDGE_ENABLED（默认开）与 KHY_AMOO_MAILBOX_ENABLED（默认开），
 * 单一真源是 amooBridgeConfig 的 gates——本文件不另读一份 env，也不在
 * flagRegistry 里为同一个开关建第二条记录。
 */

const path = require('path');

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { printError, printInfo, printSuccess, printWarn } = require('../formatters');

const leaf = require('../../services/domain/network/amoo/amooCliPlan');
const workspacePlan = require('../../services/domain/network/amoo/amooWorkspacePlan');
const { createAmooWorkspaceClient } = require('../../services/domain/network/amoo/amooWorkspaceClient');

// 提示词包是给 Amoo 读的资产，路径由本文件位置推算，不写绝对路径。
const PROMPTS_FILE = path.join(
  __dirname,
  '..',
  '..',
  'services',
  'domain',
  'network',
  'amoo',
  'prompts',
  'amooPrompts.md'
);

function _stack() {
  return require('../../services/domain/network/amoo');
}

function _config() {
  return _stack().config;
}

function _gateEnabled() {
  try {
    return _config().gates.enabled === true;
  } catch {
    // 配置解析不出来时按「默认开」处理：这一层是业务开关，关它的正确方式是显式设 0。
    const raw = process.env.KHY_AMOO_BRIDGE_ENABLED;
    if (raw === undefined || raw === null || raw === '') {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

async function _status() {
  const status = await _stack().runner.collectStatus();
  if (!status.ok) {
    printWarn('协作链还没打通（下面是已经确认的部分与缺的部分）：');
  } else {
    printSuccess('协作链已打通');
  }
  printInfo(leaf.renderStatusText(status));
  if (!status.ok) {
    printInfo('排查顺序：先 khy phone status 看桥，再确认 adb 能看到设备。');
  }
  return true;
}

async function _dispatch(parsed) {
  const res = await _stack().runner.dispatchTask({
    taskText: parsed.taskText,
    confirm: parsed.confirm === true,
  });
  if (res.ok === false && res.code === 'confirm_required') {
    printInfo(leaf.renderDispatchResultText(res));
    printInfo('这一步会在你的手机上操作 Amoo 界面并发送消息。确认后加 --confirm 再执行。');
    return true;
  }
  if (res.ok === false) {
    printError(res.message || '下发失败。');
    if (res.code) {
      printInfo(`错误码：${res.code}`);
    }
    if (res.planText) {
      printInfo(res.planText);
    }
    return true;
  }
  printSuccess(res.message || '已收到 Amoo 答复。');
  printInfo(leaf.renderDispatchResultText(res));
  return true;
}

async function _client(parsed) {
  let mod;
  try {
    mod = require('../../services/domain/network/amoo/client/amooKhyClient');
  } catch (err) {
    printError(`载入手机侧客户端失败：${(err && err.message) || String(err)}`);
    return true;
  }
  // 客户端的输出走它自己的 emit()，这里不重复渲染；退出码交给进程。
  const code = await mod.main(parsed.clientArgv, process.env);
  if (typeof code === 'number' && code !== 0) {
    printWarn(`手机侧客户端返回退出码 ${code}。`);
  }
  return true;
}

function _prompts() {
  printInfo(`提示词包：${PROMPTS_FILE}`);
  printInfo('把这份文件的内容交给 Amoo（附件或粘贴），它就知道怎么反过来调用 khy-os。');
  return true;
}

/**
 * `khy amoo workspace …`——双向同步工作区。IO 全走 adb（桥卡死时同步照样
 * 能用），手机侧默认 /sdcard/amoo-dev；解析与文案在 amooWorkspacePlan，
 * 每个动作一个薄函数，壳里只剩门控/委托/打印。
 * @param {object} parsed parseAmooArgv 的结果（workspaceArgv 是剩余参数）
 * @returns {Promise<boolean>}
 */
async function _workspace(parsed) {
  const ws = workspacePlan.parseWorkspaceArgv(parsed.workspaceArgv || []);
  if (!ws.ok) {
    printError(ws.error);
    printInfo(workspacePlan.renderWorkspaceHelp());
    return true;
  }
  if (ws.action === 'help') {
    printInfo(workspacePlan.renderWorkspaceHelp());
    return true;
  }
  const client = _workspaceClient();
  if (ws.action === 'push') return _workspacePush(client, ws);
  if (ws.action === 'pull') return _workspacePull(client, ws);
  return _workspaceStatus(client);
}

function _workspaceClient() {
  const stack = _stack();
  return createAmooWorkspaceClient({
    config: _config(),
    env: process.env,
    runAdb: (argv) => stack.client.runAdb(argv, { timeoutMs: 120000 }),
  });
}

async function _workspacePush(client, ws) {
  const res = await client.push(ws.localDir);
  if (!res.ok) {
    printError(res.error || '上传失败。');
    for (const item of res.failed || []) printInfo(`  x ${item.name}：${item.error}`);
    return true;
  }
  printSuccess('工作区已同步到手机');
  printInfo(
    workspacePlan.renderPushResult({
      upload: res.pushed,
      skip: res.skipped,
      remove: res.remove,
      remoteDir: res.remoteDir,
    })
  );
  return true;
}

async function _workspacePull(client, ws) {
  const res = await client.pull(ws.localDir);
  if (res.code === 'remote_empty') {
    printWarn(`手机工作区 ${res.remoteDir} 是空的，没有可拉的文件。`);
    return true;
  }
  if (!res.ok) {
    printError(res.error || '拉取失败。');
    return true;
  }
  printSuccess('工作区已拉回本地');
  printInfo(workspacePlan.renderPullResult({ pulled: res.pulled, failed: res.failed, localDir: res.localDir }));
  return true;
}

async function _workspaceStatus(client) {
  const res = await client.status();
  if (!res.ok) {
    printWarn('手机工作区读不到（下面是本地侧与原因）：');
  }
  printInfo(
    workspacePlan.renderWorkspaceStatus({
      localDir: res.localDir,
      remoteDir: res.remoteDir,
      local: res.local,
      remote: res.remote,
      remoteSource: res.remoteSource,
      error: res.error,
    })
  );
  return true;
}

/**
 * `khy amoo` 入口。
 * @param {string} subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令（恒 true）
 */
async function handleAmoo(subCommand, args = [], options = {}) {
  if (!_gateEnabled()) {
    printInfo('Amoo 协作层未启用（KHY_AMOO_BRIDGE_ENABLED 为关）。开启后重试即可。');
    return true;
  }

  const parsed = leaf.parseAmooArgv([subCommand, ...(args || [])], options);
  if (!parsed.ok) {
    printError(parsed.error);
    printInfo(leaf.renderAmooHelp());
    return true;
  }

  switch (parsed.action) {
    case 'help':
      printInfo(leaf.renderAmooHelp());
      return true;
    case 'status':
      return _status();
    case 'plan':
    case 'send':
      return _dispatch(parsed);
    case 'client':
      return _client(parsed);
    case 'workspace':
      return _workspace(parsed);
    default:
      return _prompts();
  }
}

module.exports = {
  handleAmoo,
  PROMPTS_FILE,
  [MANIFEST_EXPORT_KEY]: {
    name: 'amoo',
    aliases: ['amoo协作'],
    description: '与手机上的 Amoo 协作（状态/下发计划/发送任务/手机侧客户端/工作区同步）',
    usage: 'amoo [status|plan <文本>|send <文本>|client [参数…]|workspace <push|pull|status>|prompts|help]',
    subCommands: leaf.ACTIONS,
    category: 'system',
    handler: async (parsed) => handleAmoo(parsed.subCommand, parsed.args, parsed.options),
  },
};
