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

const fs = require('fs');
const path = require('path');
const os = require('os');

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
  // S1：信箱队列与 GC 事实。dropped 是设备侧 24h GC 丢掉的条数——它和
  // 「被消费」是两件事，分开报，别让「目录空了」读成「回执被取走了」。
  if (res.mailbox) {
    const mb = res.mailbox;
    const n = (v) => (Number.isFinite(v) ? String(v) : '?');
    const ageText = Number.isFinite(mb.oldest_result_age_ms)
      ? (mb.oldest_result_age_ms < 0
        ? '无回执'
        : `${(mb.oldest_result_age_ms / 3600000).toFixed(1)} 小时`)
      : '未上报';
    printInfo(
      `信箱：pending ${n(mb.pending)} / processing ${n(mb.processing)} / results ${n(mb.results)}`
      + ` / tmp ${n(mb.tmp)}；最老结果 ${ageText}；`
      + `GC 已丢 ${Number.isFinite(mb.dropped) ? `${mb.dropped} 条（不是消费）` : '未上报'}`
    );
  } else {
    printInfo('信箱：未上报（旧版桥没有 mailbox 块）');
  }
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

/**
 * 配对：换一张设备签发的证书（24 小时有效）。
 *
 * 这条命令以前**不存在**，而错误文案早就在让人跑它（phoneBridgeClient 的
 * 「先配对：khy phone pair」）——提示指向一条不存在的命令，等于把人引到死路。
 *
 * 码从哪来：设备侧刻意不回传码（它只显示在手机通知栏）。本机握着 adb 时，
 * 通知栏里的码可以被读回来；取码与取舍的边界写在 phonePairCodeReader.js。
 */
async function _pair(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  const res = await client.pair({ force: parsed.force === true });
  if (!res.ok) {
    _printFailure(res, '配对没成功。');
    if (res.code === 'pairing_code_missing') {
      printInfo('码只显示在手机通知栏（本机有 adb 时会自动去读；读不到就把码填进 KHY_PAIR_CODE 再跑一次）。');
    }
    return true;
  }
  const hours = Number.isFinite(res.expiresInMs) ? (res.expiresInMs / 3600000).toFixed(1) : '?';
  printSuccess(`已配对：设备 ${res.deviceId || '（未报设备号）'}，证书约 ${hours} 小时后过期`);
  printInfo('之后 khy phone status / ping / call 不用再配对，直到证书过期。');
  // 出向链路登记的结论（S0）：名额满只有这一处能告诉操作员「去哪腾位」，
  // 所以结论必须落在人看得见的这一行上，而不是只留在 getState() 里。
  const enroll = res.enroll;
  if (enroll && enroll.ok === true) {
    printInfo(enroll.alreadyEnrolled
      ? `出向链路：设备已在册（${enroll.deviceId || '?'}）`
      : `出向链路：新身份已登记（${enroll.deviceId || '?'}，来源 ${enroll.regSource || 'auto'}）`);
  } else if (enroll && enroll.code === 'device_slots_full') {
    const used = Number.isFinite(enroll.used) ? enroll.used : '?';
    const max = Number.isFinite(enroll.max) ? enroll.max : '?';
    printWarn(`出向链路名额已满（${used}/${max}）：本次登记被拒，既有设备未被顶掉。`
      + '腾位：对 127.0.0.1 的 admin 口 DELETE /devices/<deviceId> 删掉旧设备后再试。');
  } else if (enroll && enroll.code === 'admin_unreachable') {
    printInfo('本机没起出向链路服务，跳过登记（不影响桥的配对与调用）。');
  } else if (enroll && enroll.code === 'public_key_missing') {
    printInfo('设备状态里没有公钥（旧版桥），跳过出向链路登记。');
  } else if (enroll && enroll.code) {
    printInfo(`出向链路登记未完成（${enroll.code}），不影响桥的配对与调用。`);
  }
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
 * 一页体检：这台手机现在能不能当开发机。
 * @returns {Promise<boolean>}
 */
/**
 * 录一段手机麦克风的声音并拉回主机：一次调用完成「录 → 取」，不用手工拼两条命令。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _record(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  const seconds = Number(parsed.seconds) > 0 ? Number(parsed.seconds) : 10;
  const localDir = parsed.localDir || path.join(os.tmpdir(), 'khy-phone-record');
  printInfo(`录音 ${seconds}s（手机麦克风）→ 主机 ${localDir}`);
  // 录音是写操作（要开麦克风、要在设备上落文件）：遵守本仓「写操作默认只回计划」的约定，
  // 必须由调用方显式 --confirm。子命令本身不等于确认。
  const rec = await client.call('record_audio', { seconds }, { confirm: parsed.confirm === true });
  if (rec.requiresConfirm === true) {
    printWarn('录音会打开麦克风并在设备上写文件：确认后重跑，加 --confirm。');
    printInfo('例：khy phone record 10 out/audio --confirm');
    return true;
  }
  if (rec.success !== true) {
    _printFailure(rec, '录音失败。');
    return true;
  }
  if (!rec.path) {
    printWarn('桥回了成功但没给文件路径，无法拉取。');
    return true;
  }
  const localPath = path.join(localDir, path.basename(String(rec.path)));
  // adb pull 不会替我们建目录；record 的目标目录是自动选的，必须自己建。
  try {
    fs.mkdirSync(localDir, { recursive: true });
  } catch (err) {
    printError(`主机侧目录建不出来：${localDir}（${err && err.message ? err.message : '未知错误'}）`);
    return true;
  }
  const pulled = await client.pullFile({ remotePath: String(rec.path), localPath });
  if (!pulled.ok) {
    _printFailure(pulled, '拉取录音失败。');
    return true;
  }
  printSuccess(
    `已录音并拉回：${localPath}`
    + `（${(pulled.bytes / 1024).toFixed(1)} KB，${seconds}s，通道 ${rec.channel || '未知'}）`,
  );
  return true;
}
async function _doctor() {
  const client = _facade().getPhoneBridgeClient(process.env);
  const res = await client.doctor();
  if (!res.ok) {
    _printFailure(res, '体检失败。');
    return true;
  }
  printSuccess(res.ready ? '这台手机现在可以作为开发机使用' : '这台手机暂时还不能当开发机用');
  for (const check of res.checks) {
    printInfo(`  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
  }
  if (res.next.length > 0) {
    printWarn('下一步：');
    for (const step of res.next) {
      printInfo(`  · ${step}`);
    }
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
/**
 * 采集的默认落点：works/data/khy/phone-collect/<类型>/<日期>/。
 * 机器本地运行时数据（gitignored），按类型与日期分桶，方便按批取用与清理。
 */
function _defaultCollectDir(types, now = Date.now()) {
  const typeLabel = Array.isArray(types) && types.length > 0 ? types.join('-') : 'all';
  const day = new Date(now).toISOString().slice(0, 10);
  return path.join(process.cwd(), 'works', 'data', 'khy', 'phone-collect', typeLabel, day);
}

/**
 * 采集手机上的媒体目录（图片/音频/视频/文本/其它），按类型分桶落盘。
 * 媒体根目录来自单一真源（KHY_PHONE_BRIDGE_MEDIA_ROOTS 可覆盖）；设备上没有的目录
 * 会被跳过并在清单里说明——不同机型目录本来就不同。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
/**
 * 开相机拍一张，落盘后拉回主机。快门要一次点击——相机界面是别人的 App，
 * 我们只负责「开、等、拉、报」，不假装能替用户按下快门。
 * @param {object} parsed parsePhoneArgv 的结果
 * @returns {Promise<boolean>}
 */
async function _capture(parsed) {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const mode = String(parsed.mode || 'photo');
  const waitSeconds = Number(parsed.seconds) > 0 ? Number(parsed.seconds) : 30;
  const localDir = !parsed.localDir || parsed.localDir === '-'
    ? path.join(process.cwd(), 'works', 'data', 'khy', 'phone-collect', 'camera', new Date().toISOString().slice(0, 10))
    : parsed.localDir;
  printInfo(`开相机拍一张（${mode}），落盘后拉回 ${localDir}`);
  const opened = await client.call(
    'camera_open',
    mode === "video" ? { mode: "video" } : {},
    { confirm: true }
  );
  if (opened.success !== true) {
    _printFailure(opened, '相机没打开。');
    // 真机踩过：StepOS 相机校验调用方的 CAMERA 权限，缺了整条链路在第一步就死。
    // 手机侧已改成中文报错，这里再把「去哪补」说到命令级。
    if (/相机权限/.test(String(opened.error || ''))) {
      printInfo('补授权：khy phone setup 里的「相机权限」一条（adb pm grant）。');
    }
    return true;
  }
  const remotePath = opened.path;
  printInfo(
    `相机已打开，目标 ${remotePath}。请在手机上按一次快门；或按 Ctrl+C 放弃。`
  );
  const deadline = Date.now() + waitSeconds * 1000;
  let bytes = null;
  while (Date.now() < deadline) {
    const st = await client.call(
      'stat',
      { path: remotePath },
      { confirm: true }
    );
    if (st.success === true && st.size > 0) {
      bytes = st.size;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (bytes === null) {
    // 按可能性排：没按快门 / 按的姿势厂商相机不认 / 落到了别处。
    // 2026-11-19 实测（PZ261A/StepOS，无障碍开着用 ui_tap）：快门与「完成」都点了，
    // 照片正常落在 EXTRA_OUTPUT 路径 → 整条链通。
    // 2026-11-17 同机但无障碍关闭、改用 adb shell input tap 代按：照片哪儿都没有。
    // 所以第二条要摆在前面：厂商相机多半只认无障碍注入的触摸事件。
    printWarn(`等了 ${waitSeconds}s 没有等到照片（${remotePath}）。`);
    printInfo('可能是：① 相机没被点开/快门没按；② 用了 adb shell input tap 之类'
      + '非无障碍注入的点击——StepOS 实测这样点了也不落盘，要用 ui_tap（或人工点）；'
      + '③ 落到了别的目录，可用 khy phone scan /sdcard/DCIM 查。');
    return true;
  }
  const localPath = path.join(localDir, path.basename(remotePath));
  const pulled = await client.pullFile({ remotePath, localPath });
  if (!pulled.ok) {
    _printFailure(pulled, '照片拉不下来。');
    return true;
  }
  printSuccess(`已拍并拉回：${localPath}（${(pulled.bytes / 1024).toFixed(1)} KB）`);
  return true;
}
async function _collectMedia(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  const { PHONE_BRIDGE_MEDIA_ROOTS } = require('../../constants/serviceDefaults');
  const since = String(parsed.since || '');
  const localDir = !parsed.localDir || parsed.localDir === '-'
    ? path.join(process.cwd(), 'works', 'data', 'khy', 'phone-collect', new Date().toISOString().slice(0, 10))
    : parsed.localDir;
  printInfo(
    `采集手机媒体目录（${PHONE_BRIDGE_MEDIA_ROOTS.length} 个根）→ ${localDir}`
      + (since ? `（时间窗：${since}）` : ''),
  );
  const res = await client.collectFiles({
    remoteDirs: PHONE_BRIDGE_MEDIA_ROOTS,
    localDir,
    types: [],
    bucketByType: true,
    includeUnknown: true,
    sinceMs: _facade().parseSince(since),
  });
  if (!res.ok) {
    _printFailure(res, '采集失败。');
    return true;
  }
  const manifest = res.manifest;
  const counts = Object.entries(manifest.counts || {})
    .map(([type, n]) => `${type} ${n}`).join('，') || '无';
  const missing = (manifest.roots || []).filter((r) => !r.ok).length;
  printSuccess(
    `已采集 ${manifest.files.length} 个文件（${counts}），共 ${(res.totalBytes / 1048576).toFixed(1)} MB`
    + `，清单：${path.join(localDir, 'manifest.json')}`
  );
  if (missing > 0) {
    printWarn(`${missing} 个媒体根目录在设备上不存在（清单 roots 字段有原因）`);
  }
  return true;
}
async function _collect(parsed) {
  const bridge = _facade();
  const client = bridge.getPhoneBridgeClient(process.env);
  const types = Array.isArray(parsed.types) ? parsed.types : [];
  const since = String(parsed.since || '');
  // 主机目录省略（或写 -）→ 落默认位置
  const localDir = !parsed.localDir || parsed.localDir === '-'
    ? _defaultCollectDir(types)
    : parsed.localDir;
  printInfo(
    `采集 ${parsed.remoteDir} → ${localDir}`
    + (types.length ? `（类型：${types.join('/')}）` : '（类型：全部）')
    + (since ? `（时间窗：${since}）` : ''),
  );
  const res = await client.collectFiles({
    remoteDir: parsed.remoteDir,
    localDir,
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
    + `，清单：${path.join(localDir, 'manifest.json')}`,
  );
  if (manifest.skipped.length > 0) {
    printWarn(`跳过 ${manifest.skipped.length} 个（原因见清单 skipped 字段）`);
  }
  return true;
}
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
 * 信箱清理（S1）：result_<id>.json 的唯一消费方是发起方客户端；这里给它一条
 * 人能调用的入口。默认 dry-run（本仓「写操作默认只回计划」的既有约定），
 * 加 --confirm 才真删；每条被删的 result 都必须先被读到并在 harvested 里报出来
 * ——「删了 N 个」等于「读到了 N 份回执」，不是清空目录。
 */
async function _mailboxClean(parsed) {
  const client = _facade().getPhoneBridgeClient(process.env);
  // 先解析真实 serial：adb 里同一台手机可能以 IP 与 mDNS 两条 transport 出现，
  // 信箱需要确定的 -s；默认占位值不能直接拿去用。失败不阻断——sweep 会把
  // adb 的错误原样报出来。
  await client.detectSerial();
  const dryRun = parsed.confirm !== true;
  const res = await client.mailboxSweep({ dryRun });
  if (!res.ok) {
    _printFailure(res, '信箱清理没跑完。');
    return true;
  }
  const wouldDelete = res.kept.filter((k) => k.reason === 'dry_run_would_delete').length;
  if (dryRun) {
    printWarn(
      `信箱清理计划（未删任何文件）：扫描 ${res.scanned}，可消费回执 ${res.harvested.length}，`
      + `将删除 ${wouldDelete} 个文件。确认后加 --confirm 才真删。`
    );
  } else {
    printSuccess(
      `信箱清理完成：扫描 ${res.scanned}，消费回执 ${res.harvested.length}，`
      + `删除 ${res.deleted.length} 个文件，失败 ${res.failed.length}。`
    );
  }
  for (const h of res.harvested.slice(0, 20)) {
    printInfo(
      `  ${h.id} ${h.tool || '?'} ok=${h.ok}${h.state ? ` state=${h.state}` : ''}`
      + `${h.ms !== null ? ` ms=${h.ms}` : ''}${h.preview ? ` — ${h.preview}` : ''}`
    );
  }
  if (res.harvested.length > 20) {
    printInfo(`  …另有 ${res.harvested.length - 20} 条已消费回执未逐条列出`);
  }
  for (const kept of res.kept.slice(0, 10)) {
    printInfo(`  保留 ${kept.name}：${kept.reason}`);
  }
  for (const failed of res.failed.slice(0, 10)) {
    printWarn(`  删除失败 ${failed.name}：${failed.error}`);
  }
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
    case 'collect-media':
      return _collectMedia(parsed);
    case 'capture':
      return _capture(parsed);
    case 'scan':
      return _scan(parsed);
    case 'doctor':
      return _doctor();
    case 'mailbox-clean':
      return _mailboxClean(parsed);
    case 'record':
      return _record(parsed);
    case 'pair':
      return _pair(parsed);
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
    usage: 'phone [status|ping|probe|tools|call <工具> [json]|doctor|mailbox-clean [--confirm]|record [秒数] [主机目录]|pair|pull <设备路径> [主机路径]|push <主机文件> <设备路径>|collect <设备目录> <主机目录> [类型]|collect-media [主机目录|-] [时间窗]|scan <设备目录> [类型] [时间窗]|setup|revive|connect|devices|help]',
    subCommands: plan.ACTIONS,
    category: 'system',
    handler: async (parsed) => handlePhone(parsed.subCommand, parsed.args, parsed.options),
  },
};
