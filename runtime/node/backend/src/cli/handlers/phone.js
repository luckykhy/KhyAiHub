'use strict';

/**
 * phone.js — `khy phone` 命令薄壳：从 PC 主动调用手机上 StepBridge 的桥接面。
 *
 * 背后逻辑全在 services/domain/network/phone/：解析与文案在纯叶子
 * phoneCliPlan.js，adb/HTTP/信箱的 IO 在 phoneBridgeClient.js。本文件只做四件事：
 * 门控、解析、委托、把结果交给 formatters 打印。绝不在这里写 host/port/路径
 * 字面量——它们全部来自 phoneBridgeConfig（env 可覆盖，KHY_PHONE_BRIDGE_*）。
 *
 * 与 `khy mobile`（手机连进来）是相反方向：那条是 INBOUND 的 LAN Web/随身 App，
 * 这条是 OUTBOUND 的 adb 隧道。两者互不替代。
 *
 * 用法（完整列表见 `khy phone help`）：
 *   khy phone                      读桥状态
 *   khy phone tools                列出可调用的桥工具
 *   khy phone call <工具> [json]   调用桥工具；写操作要 --confirm
 *   khy phone setup                列出装机后要做的授权
 *   khy phone revive               桥服务被杀后拉回来
 *
 * 门控 KHY_PHONE_BRIDGE（父，默认开）。关 → 命令仍接管并说明原因，不静默落到
 * 路由器的「未知命令」分支——那样用户只会看到一句未知命令，不知道该去哪开。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { printError, printInfo, printSuccess, printWarn } = require('../formatters');

const plan = require('../../services/domain/network/phone/phoneCliPlan');

/** 读父闸门。flagRegistry 是单一真源；读不到时按「缺值即开」回退，与工具面同口径。 */
function _gateEnabled(env = process.env) {
  try {
    return require('../../services/flagRegistry').isFlagEnabled('KHY_PHONE_BRIDGE', env);
  } catch {
    const raw = env && env.KHY_PHONE_BRIDGE;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function _facade() {
  return require('../../services/domain/network/phone');
}

function _config() {
  const { resolvePhoneBridgeConfig } = _facade();
  return resolvePhoneBridgeConfig(process.env);
}

/**
 * 只读探一眼同机另一条桥（KhyOS ↔ amoon，18765）。**绝不启动它、绝不影响本命令的
 * 成功与否**：读不到就是「未安装」，runtime.json 在但 /health 不通就是「未运行」。
 * 那段没跑，`khy phone` 的 8896 通道照样完整可用——这正是两段独立的意思。
 */
async function _probeAmoonSegment() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = process.env.KHY_AMOON_HOME || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'khy-amoon-bridge'
  );
  if (!fs.existsSync(home)) {
    return { installed: false, running: false, error: `状态目录不存在：${home}` };
  }
  let runtime = null;
  try {
    runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
  } catch {
    return { installed: true, running: false, error: '没有 runtime.json' };
  }
  const port = runtime && Number(runtime.port) > 0 ? Number(runtime.port) : 0;
  if (!port) {
    return { installed: true, running: false, error: 'runtime.json 里没有端口' };
  }
  let capability = 'unverified';
  try {
    const cap = JSON.parse(fs.readFileSync(path.join(home, 'capability.json'), 'utf8'));
    if (cap && typeof cap.status === 'string') {
      capability = cap.status;
    }
  } catch {
    /* 没有能力记录就是 unverified，不是错误 */
  }
  // runtime.json 只是「曾经启动过」的痕迹，不等于进程还活着。探一次 /health，
  // 否则会把一个已经死掉的 daemon 说成「运行中」——那正是这套桥一贯要避免的谎报。
  const health = await _probeLoopbackHealth(port);
  if (!health.ok) {
    return {
      installed: true,
      running: false,
      port,
      capability,
      error: `runtime.json 在，但 /health 不通（${health.error}）`,
    };
  }
  return { installed: true, running: true, port, capability };
}

/** 探一次 loopback /health；只认 200，其它（含连不上）一律算不通。 */
function _probeLoopbackHealth(port) {
  const http = require('node:http');
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
      (res) => {
        res.resume();
        done({ ok: res.statusCode === 200, error: `HTTP ${res.statusCode}` });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, error: '超时' });
    });
    req.on('error', (err) => done({ ok: false, error: err && err.message ? err.message : '连接失败' }));
    req.end();
  });
}

function _printFailure(res, fallback) {
  printError(res.error || fallback);
  if (res.code) {
    printInfo(`错误码：${res.code}`);
  }
  if (res.requiresAccessibility === true && res.detail) {
    printInfo(res.detail);
  }
  if (res.warning) {
    printWarn(res.warning);
  }
}

async function _status() {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const res = await client.status();
  const token = await client.readToken();
  const resolved = await client.detectSerial();
  const config = _config();
  // 展示用探测后的 serial：_config() 在 client 写回之前解析，拿到的是旧默认值，
  // 实测就出现过「显示 192.168.2.46:33743、实际连的是 192.168.1.117」。
  const displayConfig = {
    ...config,
    serial: resolved.ok === true ? resolved.serial : config.serial,
    serialSource: resolved.ok === true ? resolved.serialSource : (config.serialSource || 'env'),
  };
  if (!res.ok) {
    _printFailure(res, '读不到桥状态。');
    printInfo('可用 khy phone probe 看服务心跳，用 khy phone revive 把桥拉回来。');
    // 8896 这段失败不代表整条链失败：amoon 那段可能仍然健康，如实分开报。
    printInfo(plan.renderChainText({ amoon: await _probeAmoonSegment() }));
    return true;
  }
  printSuccess('手机桥接在线');
  printInfo(
    plan.renderStatusText({
      config: displayConfig,
      status: res.status,
      state: client.getState(),
      tokenReady: token.ok === true,
      tokenError: token.error,
    })
  );
  printInfo(plan.renderChainText({ amoon: await _probeAmoonSegment() }));
  return true;
}

async function _ping() {
  const bridge = _facade();
  const res = await bridge.getPhoneBridgeClient(process.env).ping();
  if (!res.ok) {
    _printFailure(res, '桥没有回应。');
    return true;
  }
  printSuccess(`桥已回应（通道 ${res.channel || '未知'}）`);
  // /ping 当前只回 ok/pong，但这是唯一不过脱敏的回显出口：桥侧加字段就会原样上屏。
  printInfo(bridge.redactSecrets(JSON.stringify(res.body || {})));
  return true;
}

async function _probe() {
  const res = await _facade().getPhoneBridgeClient(process.env).probe();
  if (!res.ok) {
    _printFailure(res, '读不到桥心跳。');
    return true;
  }
  printSuccess('读到桥心跳（status.json）');
  printInfo(`HTTP 端口已绑定：${res.httpPortBound ? '是' : '否'}`);
  printInfo(`信箱目录可写：${res.canWrite ? '是' : '否'}`);
  printInfo(`UI 能力：${res.uiAvailable ? '有' : '无（手机无障碍服务未开启）'}`);
  printInfo(`令牌已落盘：${res.tokenPersisted === true
    ? '是'
    : res.tokenPersisted === false
      ? '否（写盘失败或未授权「所有文件访问」，PC 侧拿不到令牌）'
      : '未知（旧版桥未上报）'}`);
  printInfo(`手机自述 PC 可达：${res.pcReachable === true
    ? `是（${Math.round((res.pcIdleMs || 0) / 1000)}s 前有过请求）`
    : res.pcReachable === false
      ? '否（手机正在独立工作，等 PC 下次连入即可协作）'
      : '未知（旧版桥未上报）'}`);
  if (res.tokenPersisted === false) {
    printWarn('令牌只在内存：PC 侧读不到 token.txt 会一直 401。去手机授「所有文件访问」，'
      + '再跑 khy phone revive 重启桥后重试。');
  }
  if (!res.httpPortBound) {
    printWarn('HTTP 端口未绑定：桥进程可能活着但端口被占用，用 khy phone revive 重启后重试。');
  }
  return true;
}

async function _tools() {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  // 可用性以桥自报的字段为准：probe 读 status.json，不碰 HTTP。读不到桥（未连/未起）
  // 时才回落为「未报告」——不再把「没探过」说成「没有」。
  const live = await client.probe();
  const uiAvailable = live.ok === true && live.uiAvailable === true;
  // 助手协同（Amoo 反代）组三态：true=桥报可用；false=桥报 withheld（缺对应 App）；
  // null=桥没报到（未连/未起/旧版）。null 与 false 必须分开——把「桥没报到」渲染成
  // 「缺 Amoo App」是另一种说谎，口径与上面 ui 字段对旧版桥的处理一致。
  const assistantAvailable = live.ok === true ? live.assistantAvailable : null;
  const relayNames = new Set(bridge.ASSISTANT_RELAY_TOOL_NAMES);
  const allDefs = bridge.listKhyToolDefinitions();
  const relayDefs = allDefs.filter((d) => relayNames.has(d.bridgeName));
  const assistantWithheld = assistantAvailable === false;
  printInfo(
    plan.renderToolListText({
      tools: assistantWithheld
        ? allDefs.filter((d) => !relayNames.has(d.bridgeName))
        : allDefs,
      unavailableUiTools: uiAvailable ? [] : bridge.getPhoneBridgeUiTools(),
      unavailableUiReason: uiAvailable ? '' : bridge.ACCESSIBILITY_GAP_REASON,
      unavailableAssistantTools: assistantWithheld ? relayDefs.map((d) => d.bridgeName) : [],
      unavailableAssistantReason: assistantWithheld ? bridge.ASSISTANT_GAP_REASON : '',
    })
  );
  if (live.ok === true && assistantAvailable === null) {
    // 桥在线但没报这组的状态：如实说「未知」，不据此判断 Amoo 装没装。
    printInfo(`桥未报告这 ${relayDefs.length} 项的状态（未连/未起），不据此判断 Amoo 装没装。`);
  }
  return true;
}

async function _setup() {
  const bridge = _facade();
  const resolved = await bridge.getPhoneBridgeClient(process.env).detectSerial();
  const fallback = _config();
  printInfo(plan.renderSetupText({
    grants: bridge.listGrants(),
    serial: resolved.ok === true ? resolved.serial : fallback.serial,
    serialSource: resolved.ok === true ? resolved.serialSource : (fallback.serialSource || 'env'),
  }));
  return true;
}

async function _revive() {
  const res = await _facade().getPhoneBridgeClient(process.env).revive();
  if (!res.ok) {
    _printFailure(res, '拉不起桥应用。');
    return true;
  }
  printSuccess(res.message || '已尝试拉起桥应用。');
  return true;
}

async function _connect() {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const res = await client.ensureConnected({ force: true });
  if (!res.ok) {
    _printFailure(res, '连不上设备。');
    return true;
  }
  const resolved = await client.detectSerial();
  printSuccess(`设备已连接：${resolved.ok === true ? resolved.serial : _config().serial}`);
  return true;
}

async function _devices() {
  const res = await _facade().getPhoneBridgeClient(process.env).listDevices();
  if (!res.ok) {
    _printFailure(res, 'adb 列不出设备。');
    return true;
  }
  const devices = Array.isArray(res.devices) ? res.devices : [];
  if (devices.length === 0) {
    printWarn('adb 看不到任何设备。先确认手机与电脑在同一局域网，再用 khy phone connect。');
    return true;
  }
  printSuccess(`adb 看到 ${devices.length} 个设备`);
  for (const device of devices) {
    printInfo(`  ${device.serial}（${device.state || '状态未知'}）`);
  }
  return true;
}

/**
 * 把设备上的文件拉到主机。桥的 HTTP 面只回文本，二进制（图片/视频/音频）只能
 * 走 adb pull；这条通道是「把手机变成开发机 / 采集各类数据」的基础原语。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _pull(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  const remotePath = String(parsed.remotePath || '');
  const localPath = parsed.localPath
    ? String(parsed.localPath)
    : path.join(process.cwd(), path.basename(remotePath));
  printInfo(`拉取 ${remotePath} → ${localPath}`);
  const res = await client.pullFile({ remotePath, localPath });
  if (!res.ok) {
    _printFailure(res, '拉取失败。');
    return true;
  }
  const size = Number(res.bytes);
  printSuccess(
    `已拉取 ${remotePath} → ${localPath}`
    + (Number.isFinite(size) ? `（${(size / 1048576).toFixed(1)} MB）` : '')
  );
  return true;
}

/**
 * 只列清单不下载。视频动辄几百 MB，先看有什么再决定采不采。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _scan(parsed) {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const types = Array.isArray(parsed.types) ? parsed.types : [];
  const since = String(parsed.since || '');
  printInfo(
    `枚举 ${parsed.remoteDir}`
    + (types.length ? `（类型：${types.join('/')}）` : '（类型：全部）')
    + (since ? `（时间窗：${since}）` : ''),
  );
  const res = await client.scanFiles({
    remoteDir: parsed.remoteDir,
    types,
    sinceMs: bridge.parseSince(since),
  });
  if (!res.ok) {
    _printFailure(res, '枚举失败。');
    return true;
  }
  if (res.entries.length === 0) {
    printWarn('没有符合条件文件（清单为空，见 skipped 原因分类）。');
  }
  for (const item of res.entries) {
    const size = Number(item.bytes);
    printInfo(
      `  ${item.type.padEnd(5)} ${(Number.isFinite(size) ? `${(size / 1048576).toFixed(1)} MB` : '大小未知').padStart(10)}`
      + `  ${item.remotePath}`,
    );
  }
  const counts = Object.entries(res.counts || {}).map(([t, n]) => `${t} ${n}`).join('，') || '无';
  printSuccess(`可采 ${res.entries.length} 个（${counts}），跳过 ${res.skipped.length} 个`);
  if (res.sinceUnknown > 0) {
    printWarn(`${res.sinceUnknown} 个文件没有修改时间（设备无 stat），无法判定时间窗，已一并列入`);
  }
  return true;
}

/**
 * 把主机文件推到手机。pull 的对向——「手机当开发机」的另一半回路。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _push(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  const localPath = String(parsed.localPath || '');
  const remotePath = String(parsed.remotePath || '');
  printInfo(`推送 ${localPath} → ${remotePath}`);
  const res = await client.pushFile({ localPath, remotePath });
  if (!res.ok) {
    _printFailure(res, '推送失败。');
    return true;
  }
  printSuccess(`已推送 ${localPath} → ${remotePath}（${(res.bytes / 1048576).toFixed(1)} MB）`);
  return true;
}

/**
 * 按类型批量采集。枚举 → 筛类型 → 逐个拉 → 落清单；被跳过的也要报出来，
 * 否则「采完了」这句话是假的。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _collect(parsed) {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const types = Array.isArray(parsed.types) ? parsed.types : [];
  const since = String(parsed.since || '');
  printInfo(
    `采集 ${parsed.remoteDir} → ${parsed.localDir}`
    + (types.length ? `（类型：${types.join('/')}）` : '（类型：全部）')
    + (since ? `（时间窗：${since}）` : ''),
  );
  const res = await client.collectFiles({
    remoteDir: parsed.remoteDir,
    localDir: parsed.localDir,
    types,
    sinceMs: bridge.parseSince(since),
  });
  if (!res.ok) {
    _printFailure(res, '采集失败。');
    return true;
  }
  const manifest = res.manifest;
  const counts = Object.entries(manifest.counts || {})
    .map(([type, n]) => `${type} ${n}`).join('，') || '无';
  printSuccess(
    `已采集 ${manifest.files.length} 个文件（${counts}），共 ${(res.totalBytes / 1048576).toFixed(1)} MB`
    + `，清单：${path.join(parsed.localDir, 'manifest.json')}`,
  );
  if (manifest.skipped.length > 0) {
    printWarn(`跳过 ${manifest.skipped.length} 个（原因见清单 skipped 字段）`);
  }
  return true;
}

/**
 * 调用桥工具。两条通道都先过 policy 的允许清单与 confirm 门——信箱是兜底通道，
 * 不是绕过审批的后门；判定在同一处，通道只是传输方式。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _call(parsed) {
  const bridge = _facade();
  const config = _config();
  const client = bridge.getPhoneBridgeClient(process.env);

  // UI 工具的准入判据是桥的实时 ui 字段（v2.3.0 起桥自带无障碍服务）。
  // 非 UI 工具零开销；UI 工具多一次 /status 换一个诚实的准入判定。
  const uiAvailable = bridge.isPhoneBridgeUiToolName(parsed.tool)
    ? await _probeUiAvailable(client)
    : false;

  const classified = bridge.classifyBridgeCall(parsed.tool, parsed.args, { uiAvailable });
  if (!classified.ok) {
    _printFailure(classified, '调用被拒绝。');
    return true;
  }
  const planned = bridge.planBridgeCall({
    tool: classified.bridgeName,
    args: parsed.args,
    baseUrl: config.baseUrl,
    uiAvailable,
  });
  if (planned.requiresConfirm && parsed.confirm !== true) {
    printInfo(
      plan.renderCallPlanText({
        plan: planned.plan,
        message: planned.message,
        warning: planned.warning,
      })
    );
    return true;
  }

  if (parsed.channel === 'mailbox') {
    return _callOverMailbox(client, classified);
  }
  return _callOverHttp(client, parsed);
}

/**
 * 读一次桥的 /status 拿 ui 字段。失败（桥不在线等）一律 false——准入宁可误拒。
 * @param {object} client
 * @returns {Promise<boolean>}
 */
async function _probeUiAvailable(client) {
  try {
    const status = await client.status();
    return Boolean(status.ok && status.status && status.status.ui === true);
  } catch {
    return false;
  }
}

/**
 * 信箱兜底。worker 单线程顺序处理 cmd_ 文件，一个卡死的 exec 会冻结整条队列，
 * 所以这条路只配显式 --channel mailbox 使用，HTTP 活着时不是默认选项。
 */
async function _callOverMailbox(client, classified) {
  const res = await client.mailboxCall(classified.bridgeName, classified.args, {});
  if (!res.ok) {
    _printFailure(res, '信箱调用失败。');
    return true;
  }
  printSuccess('调用完成（通道 mailbox）');
  printInfo(
    plan.renderCallResultText({
      tool: classified.bridgeName,
      channel: 'mailbox',
      body: res.result,
    })
  );
  return true;
}

async function _callOverHttp(client, parsed) {
  const res = await client.call(parsed.tool, parsed.args, { confirm: true });
  if (!res.success) {
    if (res.requiresConfirm === true) {
      printInfo(
        plan.renderCallPlanText({ plan: res.plan, message: res.message, warning: res.warning })
      );
      return true;
    }
    _printFailure(res, '调用失败。');
    return true;
  }
  printSuccess(`调用完成（通道 ${res.channel || '未知'}）`);
  printInfo(
    plan.renderCallResultText({
      tool: res.tool,
      channel: res.channel,
      truncated: res.truncated === true,
      body: res,
    })
  );
  return true;
}

/**
 * `khy phone` 入口。
 * @param {string} subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令（恒 true；本命令自己负责说明原因）
 */
async function handlePhone(subCommand, args = [], options = {}) {
  if (!_gateEnabled(process.env)) {
    printInfo('手机桥接未启用（KHY_PHONE_BRIDGE 为关）。开启后重试即可。');
    return true;
  }

  const parsed = plan.parsePhoneArgv([subCommand, ...(args || [])], options);
  if (!parsed.ok) {
    printError(parsed.error);
    printInfo(plan.renderPhoneHelp());
    return true;
  }

  switch (parsed.action) {
    case 'help':
      printInfo(plan.renderPhoneHelp());
      return true;
    case 'status':
      return _status();
    case 'ping':
      return _ping();
    case 'probe':
      return _probe();
    case 'tools':
      return _tools();
    case 'setup':
      return _setup();
    case 'revive':
      return _revive();
    case 'connect':
      return _connect();
    case 'devices':
      return _devices();
    case 'pull':
      return _pull(parsed);
    case 'push':
      return _push(parsed);
    case 'collect':
      return _collect(parsed);
    case 'scan':
      return _scan(parsed);
    default:
      return _call(parsed);
  }
}

module.exports = {
  handlePhone,
  [MANIFEST_EXPORT_KEY]: {
    name: 'phone',
    aliases: ['手机桥接'],
    description: '调用手机上 StepBridge 的桥接面（状态/工具/调用/授权/恢复）',
    usage: 'phone [status|ping|probe|tools|call <工具> [json]|pull <设备路径> [主机路径]|push <主机文件> <设备路径>|collect <设备目录> <主机目录> [类型]|scan <设备目录> [类型] [时间窗]|setup|revive|connect|devices|help]',
    subCommands: plan.ACTIONS,
    category: 'system',
    handler: async (parsed) => handlePhone(parsed.subCommand, parsed.args, parsed.options),
  },
};
