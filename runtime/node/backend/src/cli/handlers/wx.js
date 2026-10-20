'use strict';

/**
 * Wx Command Handler — `khy wx …` 微信(个人号)扫码接入。
 *
 * 走微信官方 ilink bot API(与 ClawBot 同一套后端),扫码后 khy 会作为一个联系人出现在
 * 你的微信里,发消息即可驱动完整 agent。协议在纯叶子 ilinkCore / ilinkCrypto,HTTP 在
 * ilinkApi,凭据落 ~/.khyos/ilink.json(0600)。
 *
 *   wx [status]        — 查看已绑定的账号(token 脱敏)与通道运行状态
 *   wx login           — 终端出二维码,用微信扫码绑定
 *   wx logout [账号]    — 解绑(省略则清空全部并删除轮询游标)
 *   wx start | stop    — 启动/停止承载轮询的守护进程
 *
 * 为什么绑定后还要「启动」:收消息靠 getupdates **主动长轮询**,得有个常驻进程去轮。
 * 那个进程是 AI 守护进程(daemonEntry),它启动时才会 bootstrap 本通道。所以扫完码
 * 必须让守护进程(重)启一次,否则绑定是绑上了、消息一条也不会来。
 *
 * 注意:能否扫码成功取决于你的微信客户端是否已灰度到 ClawBot(iOS 8.0.70+ /
 * Android 8.0.68+)。未灰度的客户端会拒绝这张码,这一环无法在本地绕过——故 login
 * 把服务端给的原话透出,不自己编错误。
 *
 * @module handlers/wx
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const {
  printInfo,
  printError,
  printErrorPanel,
  printTable,
  printSuccess,
  printWarn,
} = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');
const { formatStatusMessage } = require('../statusMessageFormatter');

function _core() {
  return require('../../services/domain/messaging/messaging/ilinkCore.js');
}

function _store() {
  return require('../../services/domain/messaging/messaging/ilinkAccountStore.js');
}

function _login() {
  return require('../../services/domain/messaging/messaging/ilinkLogin.js');
}

function _daemon() {
  return require('../../services/daemonManager');
}

function _defaults() {
  return require('../../constants/serviceDefaults');
}

function _binding() {
  return require('../../services/domain/messaging/messaging/ilinkBindingStore.js');
}

function _allowlist() {
  return require('../../services/domain/messaging/messaging/ilinkPeerAllowlist.js');
}

/**
 * 当前发送者准入档位。`khy wx status` / `wx allow list` / 微信内 `/wx` 三个展示面
 * 全部读它（真源在 ilinkPeerAllowlist.allowMode），不允许各写一份。
 * @returns {{strict:boolean, label:string}}
 */
function _allowMode() {
  return _allowlist().allowMode();
}

/**
 * 改完名单后必须附带的档位说明。
 *
 * 为什么不能只回「✓ 已加入」:观察期档下,名单写了也不参与放行判定 —— 用户拿到一张
 * 成功回执、安全上什么都没变,这正是规则 2 (RUNTIME-002 状态透明)禁止的形态。
 *
 * 非严格分支里 env 名只在这里出现一次。档位标签不写它(三个展示面 + 这里都会渲染它),
 * 两处都写会串成「…(手动 KHY_ILINK_ALLOW_UNLISTED=1)(观察期需手动 …=1);…」。
 * @returns {string}
 */
function _allowModeNotice() {
  const mode = _allowMode();
  return mode.strict
    ? `当前档位:${mode.label},名单里的 userId 立即参与放行判定。`
    : `当前档位:${mode.label};本条配置暂不生效,未列名者仍会被放行;要收紧:khy wx allow env off`;
}

/**
 * 出站草稿档位（每条回复先出预览、回「发」才外发）。
 *
 * undefined → true：**安全方向只有一个**（拿不准就不发）。常量缺失时按草稿态渲染，
 * 而不是把字符串 "undefined" 打到用户脸上。
 * @returns {{on:boolean, label:string}}
 */
function _draftMode() {
  const on = _defaults().ILINK_DRAFT_CONFIRM !== false;
  return {
    on,
    label: on
      ? '逐条批准(回复先出草稿,回「发」才发出)'
      : '直发(回复直接发出,KHY_ILINK_DRAFT_CONFIRM=0)',
  };
}

// 会话隔离策略的中文说明(键与 serviceDefaults.ILINK_SESSION_SCOPES 对齐,单一真源在那边)。
const SCOPE_LABELS = Object.freeze({
  main: '所有私信共享一个会话',
  'per-peer': '按发送者隔离',
  'per-channel-peer': '按渠道+发送者隔离',
  'per-account-channel-peer': '按账号+渠道+发送者隔离(多账号推荐)',
});

/**
 * 把 `khy wx use` 的参数解析成 accountId。`#N` 或纯数字按 listAccounts() 顺序取第 N 个
 * (1-based);否则当作 accountId 直接匹配。fail-soft:不合法时回明确中文原因,不抛。
 *
 * @param {Array<{accountId:string}>} list
 * @param {string} raw
 * @returns {{ok:true, accountId:string}|{ok:false, error:string}}
 */
function _resolveAccountId(list, raw) {
  const token = String(raw || '').trim();
  if (!token) {
    return { ok: false, error: '缺少账号参数。' };
  }
  const accounts = Array.isArray(list) ? list : [];
  const m = /^#?(\d+)$/.exec(token);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > accounts.length) {
      return {
        ok: false,
        error: `序号 #${n} 超出范围 —— 当前共 ${accounts.length} 个账号(可用 #1..#${accounts.length})。`,
      };
    }
    return { ok: true, accountId: accounts[n - 1].accountId };
  }
  const hit = accounts.find((a) => a.accountId === token);
  if (!hit) {
    return { ok: false, error: `未找到账号 ${token} —— 它不在已绑定列表里。` };
  }
  return { ok: true, accountId: hit.accountId };
}

/** 守护进程是否在跑。daemonStatus 是 async(会探活 + 打健康端点)。fail-soft。 */
async function _daemonRunning() {
  try {
    const st = await _daemon().daemonStatus();
    return !!(st && st.running);
  } catch {
    return false;
  }
}

async function _handleStatus() {
  const list = _store().listAccounts();
  if (!list.length) {
    printInfo('尚未绑定微信账号。跑 khy wx login 扫码绑定。');
    return 0;
  }
  printTable(
    ['账号 ID', '用户 ID', 'bot_token(掩码)', '当前', '绑定时间'],
    list.map((a) => [
      a.accountId,
      a.userId || '-',
      a.token,
      a.active ? '✓' : '',
      a.createdAt || '-',
    ])
  );
  // 准入档位与名单规模:紧跟在账号表之后,让「谁能驱动这个实例」和「账号是谁」同屏。
  try {
    const mode = _allowMode();
    printInfo(`发送者准入:${mode.label}`);
    printInfo(
      `允许名单:${_allowlist().peerCount()} 人` +
        `${mode.strict ? '' : '(当前档位下这份名单不参与放行判定)'}`
    );
  } catch {
    printWarn('允许名单读取失败,无法显示当前准入档位。');
  }
  printInfo(`出站草稿:${_draftMode().label}`);
  if (!_core().isEnabled()) {
    printWarn('消息能力当前已关闭(KHY_MSG=off),微信通道不会收发。开启:khy msg on。');
    return 0;
  }

  // 多账号现在各自轮询,故逐账号诊断会话过期(getSessionState)与心跳(getHeartbeat),各出一行结论。
  // 会话过期与守护进程是否在跑无关 —— 凭据已死,重启也没用,唯一出路是重新扫码,故过期优先于一切判断。
  const defaults = _defaults();
  const running = await _daemonRunning();
  if (!running) {
    printWarn('⚠ 守护进程未运行 —— 已绑定但收不到消息。启动:khy wx start。');
  }
  let bad = 0;
  for (const a of list) {
    const s = _store().getSessionState(a.accountId);
    if (s && s.expired) {
      printErrorPanel({
        title: '微信会话已过期',
        message: `账号 ${a.accountId} 的会话已过期${s.at ? `(失效时间:${s.at})` : ''},收不到消息。`,
        reason: '服务端会话凭据已失效,重启守护进程无法恢复。',
        suggestions: ['运行 khy wx login 重新扫码绑定', '运行 khy wx status 查看全部账号状态'],
      });
      bad += 1;
      continue;
    }
    if (!running) {
      printInfo(`账号 ${a.accountId} 会话有效,等待守护进程启动后开始轮询收消息。`);
      continue;
    }
    const hb = _store().getHeartbeat(a.accountId);
    if (!hb) {
      printWarn(
        `⚠ 账号 ${a.accountId} 通道尚未打过心跳 —— 可能刚启动(约 1 分钟后再看),也可能通道没起来。查日志:.khy/logs/daemon.log`
      );
      continue;
    }
    const ageSec = Math.round(hb.ageMs / 1000);
    if (hb.ageMs > defaults.ILINK_HEARTBEAT_STALE_MS) {
      printErrorPanel({
        title: '微信通道心跳异常',
        message: `账号 ${a.accountId} 的通道疑似停摆 —— 守护进程 PID 还在,但长轮询很可能已停止。`,
        reason: `已 ${ageSec} 秒没有心跳,超过健康阈值。`,
        suggestions: [
          '运行 khy daemon restart 重启守护进程恢复长轮询',
          '运行 khy wx status 复查各账号心跳状态',
        ],
      });
      bad += 1;
      continue;
    }
    printSuccess(`✓ 账号 ${a.accountId} 正在长轮询收消息(心跳 ${ageSec} 秒前)。`);
  }
  return bad ? 1 : 0;
}

/**
 * 把二维码字符画打到终端:窄了就不打,宽了就居中。
 *
 * 为什么要判宽度:终端列数不够时字符画会**折行**,折行后的码不是「难看」而是**根本扫不动**
 * —— 而它看起来又像个正常的二维码,用户只会以为是自己手机的问题,对着一堆乱码扫半天。
 * 与其打一个必然失败的码,不如直说放不下并给链接。
 *
 * @param {string} art
 * @returns {boolean} 是否打印了二维码
 */
function _printQrArt(art) {
  if (!art) {
    return false;
  }
  // 「有没有可见内容」不能按空白判:terminal 模式用带背景色的空格作画,一整行纯色区块
  // 剥掉 ANSI 后就是一串空格。所以判据是「有非空格字符 **或** 有色彩转义」——
  // 二者皆无(如 '   \n  ')才是真的什么都没有。
  const ESC = String.fromCharCode(27);
  const hasColor = String(art).includes(`${ESC}[`);
  const hasGlyph =
    String(art)
      .replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
      .trim().length > 0;
  if (!hasColor && !hasGlyph) {
    return false;
  }

  const { measureQrArt } = _login();
  const { rows, cols } = measureQrArt(art);
  if (!rows || !cols) {
    return false;
  }

  // 列数拿不到(重定向到管道/文件)时按打得下处理 —— 那种场景本来也不是给人扫的。
  const term = Number(process.stdout.columns) || 0;
  if (term && cols > term) {
    printWarn(`⚠ 终端只有 ${term} 列,放不下这个 ${cols} 列的二维码 —— 打出来会折行、扫不动。`);
    printInfo(`把窗口拉宽到 ${cols} 列以上再试,或直接用下面的链接。`);
    return false;
  }

  // 居中:纯观感,放不下就不缩进(宁可贴左也不要因为缩进而溢出)。
  const pad = term && term > cols ? ' '.repeat(Math.floor((term - cols) / 2)) : '';
  const body = String(art)
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n');
  process.stdout.write(`\n${body}\n\n`);
  return true;
}

/**
 * Format an ISO timestamp into a human-readable local string for user prompts.
 * Falls back to the raw value when it cannot be parsed; never throws.
 * @param {string} iso
 * @returns {string}
 */
function _formatBoundAt(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return String(iso || '');
    }
    return d.toLocaleString('zh-CN');
  } catch {
    return String(iso || '');
  }
}

/**
 * Build the success line after a scan-login, branching on whether this account
 * was newly bound or an existing one re-logging in (isNew from the store).
 * @param {{isNew?:boolean, firstBoundAt?:string, account:{accountId:string, preview:string}}} res
 * @returns {string}
 */
function _loginSuccessLine(res) {
  const acc = (res && res.account) || {};
  if (res && res.isNew === false) {
    return `✓ 该微信账号 ${acc.accountId} 此前已绑定（首次绑定于 ${_formatBoundAt(res.firstBoundAt)}）,本次为重新登录并已刷新凭据。`;
  }
  return `✓ 已绑定微信账号 ${acc.accountId}(token ${acc.preview})。`;
}

async function _handleLogin() {
  if (!_core().isEnabled()) {
    printWarn('消息能力当前已关闭(KHY_MSG=off)。绑定仍会保存,但要先 khy msg on 才会真正收发。');
  }
  const qrTimeoutSec = Math.round(_defaults().ILINK_QR_POLL_TIMEOUT_MS / 1000);
  printInfo(formatStatusMessage('申请', '微信登录二维码', `单张二维码轮询超时 ${qrTimeoutSec} 秒`));

  const res = await _login().login({
    onQr: ({ qrcodeUrl, art, attempt }) => {
      if (attempt > 1) {
        printInfo(`这是第 ${attempt} 张二维码(上一张过期了)。`);
      }
      const shown = _printQrArt(art);
      if (!shown && art === null) {
        printWarn('无法在终端渲染二维码,请手动打开下面的链接:');
      }
      printInfo(`链接:${qrcodeUrl}`);
      printInfo('用微信扫码 → 在手机上确认。等待中(二维码过期会自动换一张)…');
    },
    onStatus: (line) => printInfo(line),
  });

  if (!res.ok) {
    printErrorPanel({
      title: '微信绑定失败',
      message: '扫码绑定微信账号失败,未能完成登录。',
      reason: res.error || '未知错误',
      suggestions: [
        '若提示不支持/版本问题:确认微信客户端已灰度到 ClawBot(iOS 8.0.70+ / Android 8.0.68+)后重跑 khy wx login',
        '运行 khy wx status 查看已绑定账号与通道状态',
      ],
    });
    return 1;
  }
  printSuccess(_loginSuccessLine(res));
  printInfo('凭据已落盘,不会回显完整 token。');

  // 绑定完还差一步:得有常驻进程去长轮询。这里直接把它拉起来,而不是丢一句提示让你自己猜。
  const running = await _daemonRunning();
  printInfo(
    formatStatusMessage(
      running ? '重启' : '启动',
      '守护进程以接管微信通道',
      `健康端口 ${_defaults().AI_BACKEND_DEFAULT_PORT}`
    )
  );
  try {
    const r = running ? await _daemon().daemonRestart() : await _daemon().daemonStart();
    if (r && r.ok === false) {
      throw new Error(r.error || '未知错误');
    }
    printSuccess('✓ 守护进程已就绪。现在可以在微信里直接给它发消息了。');
  } catch (e) {
    printWarn(`守护进程${running ? '重启' : '启动'}失败:${(e && e.message) || e}`);
    printInfo(
      `请手动执行:khy daemon ${running ? 'restart' : 'start'}(不启动的话绑定了也收不到消息)。`
    );
  }
  printInfo('查看状态:khy wx status。');
  return 0;
}

async function _handleStart() {
  if (!_store().isConfigured()) {
    printErrorPanel({
      title: '尚未绑定微信账号',
      message: '无法启动微信通道,没有可用的账号凭据。',
      reason: '已绑定账号列表为空。',
      suggestions: ['运行 khy wx login 扫码绑定微信账号', '运行 khy wx status 查看绑定状态'],
    });
    return 1;
  }
  if (!_core().isEnabled()) {
    printWarn('消息能力已关闭(KHY_MSG=off),启动后微信通道仍不会收发。先跑 khy msg on。');
  }
  const running = await _daemonRunning();
  try {
    const r = running ? await _daemon().daemonRestart() : await _daemon().daemonStart();
    if (r && r.ok === false) {
      throw new Error(r.error || '未知错误');
    }
    printSuccess(`✓ 守护进程已${running ? '重启' : '启动'},微信通道开始长轮询。`);
    return 0;
  } catch (e) {
    printErrorPanel({
      title: '微信通道启动失败',
      message: `${running ? '重启' : '启动'}守护进程失败,微信通道未能开始长轮询。`,
      reason: (e && e.message) || String(e),
      suggestions: [
        `手动执行 khy daemon ${running ? 'restart' : 'start'} 重试`,
        '查看守护进程日志:.khy/logs/daemon.log',
      ],
    });
    return 1;
  }
}

async function _handleStop() {
  if (!(await _daemonRunning())) {
    printInfo('守护进程本来就没在跑,微信通道已是停止状态。');
    return 0;
  }
  try {
    await _daemon().daemonStop();
    printSuccess('✓ 守护进程已停止,微信通道已停收。绑定仍然保留(解绑用 khy wx logout)。');
    return 0;
  } catch (e) {
    printErrorPanel({
      title: '微信通道停止失败',
      message: '停止守护进程失败,微信通道可能仍在长轮询。',
      reason: (e && e.message) || String(e),
      suggestions: ['运行 khy wx status 查看通道运行状态', '查看守护进程日志:.khy/logs/daemon.log'],
    });
    return 1;
  }
}

function _handleLogout(args) {
  const accountId = (Array.isArray(args) ? args[0] : '') || '';
  const res = _store().clearAccount(accountId || undefined);
  if (!res.ok) {
    printErrorPanel({
      title: '微信解绑失败',
      message: accountId ? `解绑微信账号 ${accountId} 失败。` : '解绑全部微信账号失败。',
      reason: res.error || '未知错误',
      suggestions: ['运行 khy wx status 确认账号 ID 与绑定状态'],
    });
    return 1;
  }
  printSuccess(
    accountId ? `✓ 已解绑 ${res.accountId}。` : '✓ 已解绑全部微信账号并清除轮询游标。'
  );
  return 0;
}

/**
 * `khy wx use <accountId | #N>` —— 切换活动账号(也叫 select)。
 * @param {string[]} args
 * @returns {number}
 */
function _handleUse(args) {
  const raw = (Array.isArray(args) ? args[0] : '') || '';
  const list = _store().listAccounts();
  if (!list.length) {
    printErrorPanel({
      title: '尚未绑定微信账号',
      message: '无法切换活动账号,没有可切换的对象。',
      reason: '已绑定账号列表为空。',
      suggestions: ['运行 khy wx login 扫码绑定微信账号', '运行 khy wx status 查看绑定状态'],
    });
    return 1;
  }
  if (!String(raw).trim()) {
    printError('用法:khy wx use <账号ID | #序号>。未指定要切换到哪个账号。');
    printInfo('查看全部账号与序号:khy wx status。');
    return 1;
  }
  const resolved = _resolveAccountId(list, raw);
  if (!resolved.ok) {
    printErrorPanel({
      title: '账号解析失败',
      message: `无法把 ${raw} 解析为已绑定的微信账号。`,
      reason: resolved.error,
      suggestions: ['运行 khy wx status 查看全部账号与序号后重试'],
    });
    return 1;
  }
  const res = _store().setActiveAccount(resolved.accountId);
  if (!res.ok) {
    printErrorPanel({
      title: '切换活动账号失败',
      message: `把活动账号切换为 ${resolved.accountId} 失败。`,
      reason: res.error || '未知错误',
      suggestions: ['运行 khy wx status 查看全部账号与序号后重试'],
    });
    return 1;
  }
  printSuccess(`✓ 已把活动账号切换为 ${res.accountId}。`);
  printInfo('切换只影响 CLI 主动外发的目标账号;各账号仍在各自轮询收消息,不受影响。');
  printInfo('若要让某些外发逻辑生效,重启守护进程:khy wx start。');
  return 0;
}

/**
 * `khy wx scope [mode]` —— 查看/设置会话隔离策略(dmScope)。
 * 无参显示当前策略与全部可选值;有参则校验后持久化 KHY_ILINK_SESSION_SCOPE。
 * 持久化复用 config.js 已导出的通用 env 写入器 _writeEnvPatch(内部用项目现有
 * resolveGatewayEnvPaths 定位 .env,无硬编码路径),并同步更新 process.env。
 * @param {string[]} args
 * @returns {number}
 */
function _handleScope(args) {
  const defaults = _defaults();
  const scopes = Array.isArray(defaults.ILINK_SESSION_SCOPES) ? defaults.ILINK_SESSION_SCOPES : [];
  const mode = (Array.isArray(args) ? args[0] : '') || '';
  if (!String(mode).trim()) {
    const current = defaults.ILINK_SESSION_SCOPE;
    printInfo(`当前会话隔离策略:${current}`);
    printTable(
      ['策略', '含义', '当前'],
      scopes.map((s) => [s, SCOPE_LABELS[s] || '-', s === current ? '✓' : ''])
    );
    printInfo('设置:khy wx scope <策略>。修改后需重启守护进程(khy wx start)生效。');
    return 0;
  }
  const normalized = String(mode).trim();
  if (!scopes.includes(normalized)) {
    printErrorPanel({
      title: '非法的会话隔离策略',
      message: '会话隔离策略未修改,配置保持原样。',
      reason: `收到的值 ${normalized} 不在可选策略之内。`,
      suggestions: [
        `可选值:${scopes.join(' / ')}`,
        '用法:khy wx scope <策略>,不带参数可查看当前策略',
      ],
    });
    return 1;
  }
  try {
    const { _writeEnvPatch } = require('./config');
    const envPath = _writeEnvPatch({ KHY_ILINK_SESSION_SCOPE: normalized });
    printSuccess(`✓ 已把会话隔离策略设为 ${normalized}(${SCOPE_LABELS[normalized] || ''})。`);
    printInfo(`已写入:${envPath}`);
    printInfo('新策略需重启守护进程生效:khy wx start。');
    return 0;
  } catch (e) {
    printErrorPanel({
      title: '设置会话隔离策略失败',
      message: `把会话隔离策略写入为 ${normalized} 失败,配置未生效。`,
      reason: (e && e.message) || String(e),
      suggestions: [
        '检查 .env 配置文件是否存在且可写,然后重跑 khy wx scope ' + normalized,
        '运行 khy wx scope 查看当前生效的策略',
      ],
    });
    return 1;
  }
}

/**
 * `khy wx bind <accountId | #N> --workspace <路径> [--agent <名称>]` —— 策略二 Agent 级隔离:
 * 把某账号的收信路由绑定到指定工作空间(可选专属 Agent)。绑定关系落 ilinkBindingStore,
 * 收消息时由 dispatcher 查表决定路由。workspace 必填;fail-soft 只依据 store 返回的 ok。
 * @param {string[]} args
 * @param {object} options
 * @returns {number}
 */
function _handleBind(args, options = {}) {
  const raw = (Array.isArray(args) ? args[0] : '') || '';
  const list = _store().listAccounts();
  if (!list.length) {
    printErrorPanel({
      title: '尚未绑定微信账号',
      message: '无法配置路由,没有可绑定的账号。',
      reason: '已绑定账号列表为空。',
      suggestions: ['运行 khy wx login 扫码绑定微信账号', '运行 khy wx status 查看绑定状态'],
    });
    return 1;
  }
  if (!String(raw).trim()) {
    printError(
      '用法:khy wx bind <账号ID | #序号> --workspace <路径> [--agent <名称>]。未指定账号。'
    );
    printInfo('查看全部账号与序号:khy wx status。');
    return 1;
  }
  const resolved = _resolveAccountId(list, raw);
  if (!resolved.ok) {
    printErrorPanel({
      title: '账号解析失败',
      message: `无法把 ${raw} 解析为已绑定的微信账号。`,
      reason: resolved.error,
      suggestions: ['运行 khy wx status 查看全部账号与序号后重试'],
    });
    return 1;
  }
  // options 由 router 解析:`--workspace <路径>` → options.workspace,`--agent <名称>` → options.agent。
  const opts = options || {};
  const workspace = typeof opts.workspace === 'string' ? opts.workspace.trim() : '';
  if (!workspace) {
    printError('缺少 --workspace <路径>。必须指定该账号的消息路由到哪个工作空间。');
    printInfo('用法:khy wx bind <账号ID | #序号> --workspace <路径> [--agent <名称>]。');
    return 1;
  }
  const agent = typeof opts.agent === 'string' ? opts.agent.trim() : '';
  const res = _binding().bindAccount(resolved.accountId, { workspace, agent: agent || undefined });
  if (!res.ok) {
    printErrorPanel({
      title: '路由绑定失败',
      message: `把账号 ${resolved.accountId} 绑定到工作空间 ${workspace} 失败。`,
      reason: res.error || '未知错误',
      suggestions: ['确认工作空间路径存在且可访问后重试', '运行 khy wx bindings 查看现有路由绑定'],
    });
    return 1;
  }
  const boundAgent = res.binding && res.binding.agent ? res.binding.agent : '';
  printSuccess(
    `✓ 已把账号 ${res.accountId} 绑定到工作空间 ${res.binding.workspace}${boundAgent ? `(Agent:${boundAgent})` : ''}。`
  );
  printInfo('绑定已即时生效:新收到的消息会按该工作空间/Agent 路由。');
  printInfo('若守护进程当前未运行,需先 khy wx start 才能开始收消息。');
  return 0;
}

/**
 * `khy wx unbind <accountId | #N>` —— 解除某账号的路由绑定(幂等:未绑定也算成功)。
 * @param {string[]} args
 * @returns {number}
 */
function _handleUnbind(args) {
  const raw = (Array.isArray(args) ? args[0] : '') || '';
  const list = _store().listAccounts();
  if (!list.length) {
    printError('尚未绑定微信账号。先跑 khy wx login 扫码绑定。');
    return 1;
  }
  if (!String(raw).trim()) {
    printError('用法:khy wx unbind <账号ID | #序号>。未指定账号。');
    printInfo('查看全部账号与序号:khy wx status。');
    return 1;
  }
  const resolved = _resolveAccountId(list, raw);
  if (!resolved.ok) {
    printError(resolved.error);
    printInfo('查看全部账号与序号:khy wx status。');
    return 1;
  }
  const res = _binding().unbindAccount(resolved.accountId);
  if (!res.ok) {
    printErrorPanel({
      title: '解除路由绑定失败',
      message: `解除账号 ${resolved.accountId} 的路由绑定失败。`,
      reason: res.error || '未知错误',
      suggestions: ['运行 khy wx bindings 查看现有路由绑定后重试'],
    });
    return 1;
  }
  printSuccess(`✓ 已解除账号 ${res.accountId} 的路由绑定(未绑定则无变化)。`);
  printInfo('解绑已即时生效:新消息不再按该绑定路由。');
  printInfo('守护进程运行状态不变。');
  return 0;
}

/**
 * `khy wx bindings` —— 只读:列出全部「账号→工作空间/Agent」路由绑定。
 * 这是独立于 wx status 的路由视图(status 保持精简、不含绑定列),数据来自 ilinkBindingStore.listBindings()。
 * @returns {number}
 */
function _handleBindings() {
  const list = _binding().listBindings();
  if (!list.length) {
    printInfo('尚无路由绑定。用 khy wx bind <账号> <工作空间> 绑定。');
    return 0;
  }
  printTable(
    ['账号ID', '绑定工作空间', '绑定Agent'],
    list.map((b) => [b.accountId, b.workspace || '-', b.agent || '-'])
  );
  return 0;
}

/**
 * `khy wx allow <add|rm|list|self|env> …` —— 入站发送者允许名单（四层并集里可配的那两层）。
 *
 * 为什么要有 env 这一支:名单落盘（~/.khyos/ilink-peers.json）是本机态,换机器/多人运维
 * 时靠文件搬运太脆;KHY_ILINK_ALLOWED_PEERS 是跨账号、随 .env 走的配置面。
 *
 * **所有成功回执都带当前档位**——见 _allowModeNotice 的理由。
 *
 * @param {string[]} args
 * @returns {number}
 */
function _handleAllow(args) {
  let rest = Array.isArray(args) ? args.slice() : [];
  // 未知动词会被 parseInput 连同 args[0] 一起派过来（见 handleWx 顶部注释），
  // 两种形态（subCommand='allow' 且 args[0]='add' / args[0]='allow'）都要吃得下。
  const head = String(rest[0] || '').toLowerCase();
  if (head === 'allow' || head === 'allowlist') {
    rest = rest.slice(1);
  }
  const verb = String(rest[0] || 'list').toLowerCase();
  const ids = rest.slice(1).filter((s) => String(s).trim());

  if (verb === 'list') {
    return _allowList();
  }
  if (verb === 'self') {
    return _allowSelf();
  }
  if (verb === 'env') {
    return _allowEnv(ids);
  }
  if (verb === 'add' || verb === 'rm') {
    return ids.length ? _allowMutate(verb, ids) : _allowUsage();
  }
  return _allowUsage();
}

function _allowUsage() {
  printError('用法:khy wx allow <add|rm|list|self|env>。');
  printInfo('  add <userId...>  把这些微信 ID 加进允许名单（对全部已绑定账号生效）');
  printInfo('  rm  <userId...>  移出允许名单');
  printInfo('  self            把各账号自己的 ID 写进名单（一次自愈）');
  printInfo('  env <userId|off|on> 把名单/档位写进 .env；off = 收紧(默认档)，on = 观察期放行');
  printInfo('  list            列出当前名单与档位');
  return 1;
}

/** add/rm 共用:名单按账号分桶,这里对全部已绑定账号生效（入站 id 只在账号内有意义）。 */
function _allowMutate(verb, ids) {
  const accounts = _store().listAccounts();
  if (!accounts.length) {
    printErrorPanel({
      title: '尚未绑定微信账号',
      message: '无法维护允许名单,没有账号可以挂这份名单。',
      reason: '已绑定账号列表为空。',
      suggestions: ['运行 khy wx login 扫码绑定微信账号', '运行 khy wx status 查看已绑定账号'],
    });
    return 1;
  }
  const allow = _allowlist();
  const failed = [];
  for (const id of ids) {
    const userId = String(id).trim();
    for (const a of accounts) {
      const res = verb === 'add' ? allow.addPeer(a.accountId, userId) : allow.removePeer(a.accountId, userId);
      if (!res.ok) {
        failed.push(`${userId}@${a.accountId}:${res.error}`);
      }
    }
  }
  if (failed.length) {
    printErrorPanel({
      title: verb === 'add' ? '加入允许名单失败' : '移出允许名单失败',
      message: '名单未更新,配置保持原样。',
      reason: failed.join(';'),
      suggestions: ['检查 ~/.khyos 目录是否可写', '运行 khy wx allow list 查看当前名单'],
    });
    return 1;
  }
  printSuccess(
    `✓ 已${verb === 'add' ? '加入' : '移出'}允许名单:${ids.join('、')}(账号 ${accounts
      .map((a) => a.accountId)
      .join('、')})。`
  );
  printWarn(_allowModeNotice());
  return 0;
}

/** `khy wx allow self` —— 把账号记录里的 userId 显式写进名单。 */
function _allowSelf() {
  const accounts = _store().listAccounts();
  if (!accounts.length) {
    printErrorPanel({
      title: '尚未绑定微信账号',
      message: '无法写入自身 ID,没有账号记录可读。',
      reason: '已绑定账号列表为空。',
      suggestions: ['运行 khy wx login 扫码绑定微信账号'],
    });
    return 1;
  }
  const allow = _allowlist();
  const done = [];
  const missing = [];
  for (const a of accounts) {
    const userId = String(a.userId || '').trim();
    if (!userId) {
      missing.push(a.accountId);
      continue;
    }
    const res = allow.addPeer(a.accountId, userId, 'self');
    if (res.ok) {
      done.push(`${a.accountId}:${userId}`);
    } else {
      missing.push(`${a.accountId}:${res.error}`);
    }
  }
  if (!done.length) {
    printErrorPanel({
      title: '写入自身 ID 失败',
      message: '没有任何账号的自身 ID 被写入允许名单。',
      reason: missing.join(';') || '账号记录里没有 userId',
      suggestions: ['运行 khy wx login 重新扫码(登录报文里带 ilink_user_id)', '运行 khy wx status 查看账号用户 ID'],
    });
    return 1;
  }
  printSuccess(`✓ 已把账号自身的微信 ID 写入允许名单:${done.join('、')}。`);
  if (missing.length) {
    printWarn(`未写入:${missing.join('、')}。`);
  }
  printWarn(_allowModeNotice());
  return 0;
}

/** `khy wx allow env <ids|off|on>` —— 写 .env。ids 覆盖 KHY_ILINK_ALLOWED_PEERS，
 *  off/on 写档位开关（默认档是严格；on 是把默认临时翻回观察期的逃生阀）。 */
function _allowEnv(ids) {
  const token = String(ids[0] || '').trim();
  const lowered = token.toLowerCase();
  if (!token) {
    printError('用法:khy wx allow env <userId,userId|off|on>。未指定内容。');
    printInfo('  env u2,u3   把这两个 ID 作为跨账号允许名单写进 .env');
    printInfo('  env off     收紧档位:仅允许名单内的发送者可驱动本实例(默认档)');
    printInfo('  env on      临时放回观察期:未列名者放行但记 warn(用完记得收回)');
    return 1;
  }
  const isOff = lowered === 'off';
  const isOn = lowered === 'on';
  const patch = isOff || isOn
    ? { KHY_ILINK_ALLOW_UNLISTED: isOff ? '0' : '1' }
    : { KHY_ILINK_ALLOWED_PEERS: token };
  const written = isOff || isOn
    ? `KHY_ILINK_ALLOW_UNLISTED=${isOff ? '0' : '1'}(${isOff ? '仅名单内放行' : '观察期放行'})`
    : `KHY_ILINK_ALLOWED_PEERS=${token}`;
  try {
    const { _writeEnvPatch } = require('./config');
    const envPath = _writeEnvPatch(patch);
    printSuccess(`✓ 已写入 .env:${written}`);
    printInfo(`已写入:${envPath}`);
    printInfo('需重启守护进程生效:khy wx start。');
    if (isOff) {
      printWarn('收紧后,没在名单里的发送者会被直接拒答 —— 先确认自己与关键对话方都在名单里。');
    }
    if (isOn) {
      printWarn('观察期已开:没在名单里的发送者也能驱动本实例,只记一条 warn。窗口期结束请 khy wx allow env off 收回。');
    }
    return 0;
  } catch (e) {
    printErrorPanel({
      title: '写 .env 失败',
      message: '准入配置未更新,档位保持原样。',
      reason: (e && e.message) || String(e),
      suggestions: ['检查 .env 是否存在且可写后重试', '运行 khy wx allow list 查看当前档位'],
    });
    return 1;
  }
}

/** `khy wx allow list` —— 只读:名单一览 + 当前档位 + 隐式层说明。 */
function _allowList() {
  const mode = _allowMode();
  printInfo(`当前档位:${mode.label}`);
  const rows = _allowlist().listPeers();
  if (!rows.length) {
    printInfo('允许名单为空（各账号自身的微信 ID 属于隐式允许,无需登记）。');
  } else {
    printTable(
      ['账号ID', '微信 ID', '来源', '加入时间'],
      rows.map((r) => [r.accountId, r.userId, r.source || '-', r.addedAt || '-'])
    );
    printInfo(`共 ${rows.length} 条。`);
  }
  for (const a of _store().listAccounts()) {
    printInfo(`账号 ${a.accountId} 的隐式允许 ID:${a.userId || '(登录记录里没有,需 khy wx allow self)'}`);
  }
  if (!mode.strict) {
    printWarn('当前为观察期档位,这份名单暂不参与放行判定;收紧:khy wx allow env off。');
  }
  return 0;
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @returns {number|Promise<number>}
 */
function handleWx(subCommand, args = [], options = {}) {
  // Unknown verbs are parked in args[0] by parseInput, not subCommand; without the
  // fallback `wx zqxtyvo` rendered exactly like bare `wx status`.
  const sub = String(subCommand || (args && args[0]) || 'status').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo(
      '用法: wx [status] | wx use(select) <账号|#N> | wx bind <账号|#N> --workspace <路径> [--agent <名>] | wx unbind <账号|#N> | wx scope [策略] | wx scan(login) | wx connect(start) | wx stop | wx logout [账号]'
    );
    printInfo('扫码后微信里会多出一个联系人,发消息即可驱动 khy。需微信已灰度到 ClawBot。');
    printInfo('收消息靠守护进程长轮询,故 scan 会自动把它拉起来;stop 只停收,不解绑。');
    printInfo('use 切换主动外发的活动账号;scope 查看/设置多账号会话隔离策略。');
    printInfo(
      'bind 把某账号收信绑定到工作空间/Agent(策略二);bindings 列出全部路由绑定;unbind 解除绑定。改绑定需 khy wx start 重启生效。'
    );
    printInfo(
      'allow 管理入站发送者允许名单:allow add/rm/list/self/env。当前档位用 allow list 或 wx status 查看;只有严格档下这份名单才参与放行判定(默认即严格)。'
    );
    printInfo('微信里可发 /wx 查连接健康、/help 看全部命令。');
    printInfo(
      '绑定码只在终端申请:khy wx login。二维码只显示在你的终端,不经过任何聊天转发。'
    );
    printInfo(
      'SendUserFile 在微信上会真的把文件发出去,凭据/密钥类路径一律拒发(含符号链接指向的)。'
    );
    printInfo(`准入档位:${_allowMode().label}。`);
    printInfo(
      `出站草稿:${_draftMode().label}。微信里发 /draft 看自己的档位,/draft off 可关掉自己那一份（仅本进程,重启失效）。`
    );
    return 0;
  }
  if (!sub || sub === 'status' || sub === 'show' || sub === 'list') {
    return _handleStatus();
  }
  if (sub === 'use' || sub === 'select' || sub === 'switch') {
    return _handleUse(args);
  }
  if (sub === 'scope' || sub === 'dmscope') {
    return _handleScope(args);
  }
  if (sub === 'bind') {
    return _handleBind(args, options);
  }
  if (sub === 'bindings') {
    return _handleBindings();
  }
  if (sub === 'allow' || sub === 'allowlist') {
    return _handleAllow(args);
  }
  if (sub === 'unbind') {
    return _handleUnbind(args);
  }
  if (sub === 'login' || sub === 'qr' || sub === 'scan' || sub === '扫描') {
    return _handleLogin();
  }
  if (sub === 'logout' || sub === 'clear' || sub === 'rm') {
    return _handleLogout(args);
  }
  if (sub === 'start' || sub === 'up' || sub === 'connect' || sub === '连接') {
    return _handleStart();
  }
  if (sub === 'stop' || sub === 'down' || sub === 'disconnect') {
    return _handleStop();
  }
  printError(
    `未知子命令:${sub}。可用:status / use(select) / bind / bindings / unbind / scope / allow / scan(login) / connect(start) / stop / logout。`
  );
  _markFailure();
  return 1;
}

module.exports = {
  handleWx,
  _printQrArt,
  _resolveAccountId,
  _loginSuccessLine,
  _formatBoundAt,
  [MANIFEST_EXPORT_KEY]: {
    name: 'wx',
    aliases: ['wechat', '微信'],
    description: '微信个人号扫码接入（ilink bot API）：登录/绑定/启动/停止',
    usage: 'wx <subcommand> [args]',
    category: 'workflow',
    handler: async (parsed) => handleWx(parsed.subCommand, parsed.args, parsed.options),
  },
};
