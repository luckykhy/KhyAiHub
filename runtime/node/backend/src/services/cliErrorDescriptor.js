// khy-canary: Khy-20261101-251-BVYQMY5A
'use strict';

/**
 * cliErrorDescriptor.js — 「真实原因 + 解决方案」结构化错误描述器（service 层单一真源）。
 *
 * 本模块是纯描述逻辑：输入任意错误（Error / 字符串 / {error,exitCode,stderr}），
 * 输出 { title, reason, exitCode, kind, suggestions, stack } 结构对象，不做任何终端渲染。
 *
 * 分层契约（REQ-2026-001 / DESIGN-ARCH-057）：原先该逻辑位于 cli/cliErrorReporter，
 * 却同时 (a) 依赖 service 层（errorClassifier / failsafe.errorCodes）且 (b) 被 service 层
 * （daemonEntry / crashRecovery）反向 require，构成 service→cli 分层违例。因 describeCliError
 * 本质是消费 service、又服务 service 的纯逻辑，正确归属是 service 层。下沉到此后：
 *   - cli/cliErrorReporter 改为从本模块取 describeCliError 并保留终端渲染包装（cli→service，合法）；
 *   - daemonEntry / crashRecovery 直接 require 本模块，反向边消失。
 *
 * 红线（来自 /goal「错误不要只出现 exit -1」）：
 *   1. 任何错误出口都必须显示真实原因（不止退出码、不止"命令执行失败"）。
 *   2. 必须给出怎么解决（至少一条可操作建议）。
 *   3. suggestions 永不为空——未知错误也回落到通用排查指引。
 *
 * 平台契约（P1-5，2026-10-12）：修复指引按 platform 分支——Windows 下给
 * netstat/taskkill/dir/$env:HTTPS_PROXY 这类真能执行的命令，POSIX 保持原样；
 * platform 由调用方注入（opts.platform / remediationText 第三参），分支可被表驱动
 * 单测直接覆盖。兜底建议统一指向 `khy doctor`（不自指 `khy os doctor`，P1-6b）。
 */

const {
  formatErrorMessage,
  detectErrorKindDeep,
  extractErrorCode, // eslint-disable-line no-unused-vars -- kept for parity with errorClassifier surface
  suggestRecoveryAction,
} = require('./errorClassifier');

let codes = null;
try {
  codes = require('./domain/security/failsafe/errorCodes');
} catch {
  /* failsafe 字典缺失时降级，不影响主流程 */
}

// 失败人话化叶子读门控真源。flagRegistry 零 require ⇒ 模块级加载无环。
let flagRegistry = null;
try {
  flagRegistry = require('./flagRegistry');
} catch {
  /* 注册表不可用 → humanTextEnabled 走本地 CANON */
}

// ── kind → 可操作中文修复指引（高于 suggestRecoveryAction 的动作令牌，给人看） ──
// 表驱动 + platform 注入：每条都是 `(platform) => string[]` 的纯函数，同一张表同时服务
// Windows（cmd / PowerShell）与 POSIX shell —— 旧文案里的 chmod / lsof / ulimit / df
// 在 Windows 下一条都执行不了，等于给用户指了条死路。平台无关的条目忽略该参数。
// POSIX 分支逐字保留原文：既有断言不许破。
const KIND_REMEDIATION = {
  network: (platform) =>
    platform === 'win32'
      ? [
          '检查网络连通性：PowerShell 运行 Test-NetConnection <主机> -Port 443（或 ping <主机>）。',
          '若处于受限网络，设置代理：set HTTPS_PROXY=http://127.0.0.1:7890（当前窗口，PowerShell 用 $env:HTTPS_PROXY=http://127.0.0.1:7890），或 setx HTTPS_PROXY http://127.0.0.1:7890（需重开终端）。',
        ]
      : [
          '检查网络连通性（curl/ping 目标地址）。',
          '若处于受限网络，设置代理：export HTTPS_PROXY=http://127.0.0.1:7890。',
        ],
  timeout: () => [
    '目标响应过慢或不可达：稍后重试，或提高超时阈值。',
    '检查网络/代理是否稳定；必要时切换模型通道或镜像源。',
  ],
  rate_limit: () => ['触发限流：稍候重试，或切换到其他账号/通道。', '降低并发与请求频率。'],
  context_length: () => [
    '上下文超长：运行 /compact 压缩，或 history clear 清理历史。',
    '改用更大上下文窗口的模型。',
  ],
  auth: () => [
    '凭证无效或过期：运行 khy login（或对应渠道的登录命令）重新认证。',
    '核对 settings.json / 环境变量中的 API Key 是否正确、未过期。',
  ],
  permission: (platform) =>
    platform === 'win32'
      ? [
          '权限不足：在资源管理器里右键目标 → 属性 → 安全，确认当前用户有读/写权限；必要时以管理员身份运行。',
          '受沙箱/审批网关拦截时，按提示确认授权或降低操作影响面。',
        ]
      : [
          '权限不足：检查文件/目录所有权与读写位（ls -l），必要时调整权限。',
          '受沙箱/审批网关拦截时，按提示确认授权或降低操作影响面。',
        ],
  billing: () => ['账户额度不足或欠费：检查计费状态并充值，或切换可用账号。'],
  model_not_found: () => [
    '模型不存在或不可用：运行 /model 查看可用模型并改选。',
    '核对模型 ID 拼写与该渠道是否支持该模型。',
  ],
  overloaded: () => ['上游服务过载：稍后重试；khyos 会自动降级到备用通道。'],
  server_error: () => ['上游服务端错误（5xx）：稍后重试；若持续，切换模型通道。'],
  refusal: () => ['内容被安全策略拦截：调整请求内容后重试。'],
  cancelled: () => ['操作已被取消（Ctrl+C / 超时中断）：如非预期，请重新执行。'],
  process: () => ['子进程异常退出或通道关闭：查看下方真实输出定位原因，修正后重跑。'],
};

// ── errno / 系统码 → 具体修复（比 kind 更精确，优先采用） ──
// 与 KIND_REMEDIATION 同一契约：`(ctx, platform) => string[]`。Windows 分支凡有本仓命令
// 可指（khy doctor / khy server start）就优先指本仓命令，其次才是真实可执行的系统命令。
const ERRNO_REMEDIATION = {
  ENOENT: (ctx) => [
    `找不到文件或命令${ctx ? `：${ctx}` : ''}。请确认路径拼写与该可执行文件是否已安装、在 PATH 中。`,
  ],
  EACCES: (ctx, platform) =>
    platform === 'win32'
      ? [
          `权限被拒绝${ctx ? `（${ctx}）` : ''}：右键目标 → 属性 → 安全，确认当前用户有读写权限，或换用有权限的目录。`,
        ]
      : ['权限被拒绝：检查目标的读写/执行权限（chmod / chown），或换用有权限的目录。'],
  EPERM: (_ctx, platform) =>
    platform === 'win32'
      ? ['操作不被允许：可能需要管理员权限或受系统策略限制；核对所有权与运行身份。']
      : ['操作不被允许：可能需要更高权限或受系统策略限制；核对所有权与运行身份。'],
  EADDRINUSE: (ctx, platform) => {
    const at = ctx ? `：${ctx}` : '';
    return platform === 'win32'
      ? [
          `端口已被占用${at}。换一个端口（--port N），或结束占用该端口的进程：` +
            'netstat -ano | findstr :PORT 查到 PID 后执行 taskkill /PID <PID> /F。',
        ]
      : [`端口已被占用${at}。换一个端口（--port N），或结束占用该端口的进程（lsof -i:PORT）。`];
  },
  ECONNREFUSED: () => [
    '目标服务未在监听：确认服务已启动且地址/端口正确（如先运行 khy server start）。',
  ],
  ENOTFOUND: () => ['域名解析失败：检查网络/DNS 与目标地址拼写；受限网络下配置代理。'],
  ETIMEDOUT: () => ['连接超时：检查网络/代理与目标可达性，稍后重试。'],
  ENOSPC: (_ctx, platform) =>
    platform === 'win32'
      ? ['磁盘空间不足：清理空间后重试（dir 查看当前目录占用，或在资源管理器里查看磁盘属性）。']
      : ['磁盘空间不足：清理空间后重试（df -h 查看占用）。'],
  EMFILE: (_ctx, platform) =>
    platform === 'win32'
      ? ['打开文件句柄过多：排查句柄泄漏，或降低并发/批量大小后重试。']
      : ['打开文件句柄过多：提高 ulimit -n，或排查句柄泄漏。'],
  MODULE_NOT_FOUND: (ctx) => [
    `缺少 Node 依赖${ctx ? `：${ctx}` : ''}。在 ${process.env.KHYQUANT_ROOT || '后端目录（含 package.json 的 backend 目录）'} 下运行 npm install 后重试；或运行 khy doctor 检查依赖环境。`,
  ],
  ELOOP: () => ['符号链接成环：检查目标路径的软链接是否自引用。'],
};

const GENERIC_REMEDIATION = [
  '需要更多线索：请附上本错误的完整输出与所用命令后重试或反馈。',
  '运行 khy doctor 进行环境自检；问题可复现时附上上方真实原因反馈。',
];

// 失败协议字典按 action 间接给建议（suggestRecoveryAction 的动作令牌 → 人话）。
const BY_ACTION_REMEDIATION = {
  compress: '上下文过长：先压缩历史再重试。',
  credential_rotate: '切换账号/通道或检查额度后重试。',
  fallback_model: '改用其他可用模型（/model）。',
  reauth: '重新登录认证（khy login）。',
  retry: '这是可重试错误：稍后重试。',
};

/** 把注入的 platform 归一成 'win32' | 'posix'（缺省取当前进程平台）。 */
function _normalizePlatform(platform) {
  return String(platform || process.platform || '')
    .trim()
    .toLowerCase() === 'win32'
    ? 'win32'
    : 'posix';
}

/**
 * 纯叶子：给一对 (kind, errno) 产出修复指引。
 *
 * `platform` 由调用方**注入**（表内绝不读环境进程），Windows / POSIX 两条分支因此可被
 * 表驱动单测直接覆盖，无需桩 process。永不为空数组——红线是「suggestions 永不为空」。
 *
 * @param {string} [kind]   detectErrorKindDeep 的归类
 * @param {string} [errno]  errno 风格码（ENOENT / EADDRINUSE…），比 kind 精确，优先
 * @param {string} [platform] 'win32' 走 Windows 分支，其余走 POSIX（缺省 process.platform）
 * @param {string} [ctx]    命令/路径上下文，用于丰富 errno 专属文案
 * @returns {string[]}
 */
function remediationText(kind, errno, platform, ctx) {
  const p = _normalizePlatform(platform);
  const out = [];
  if (errno && typeof ERRNO_REMEDIATION[errno] === 'function') {
    out.push(...ERRNO_REMEDIATION[errno](ctx, p));
  } else if (kind && typeof KIND_REMEDIATION[kind] === 'function') {
    out.push(...KIND_REMEDIATION[kind](p));
  } else if (kind && codes) {
    const byAction = BY_ACTION_REMEDIATION[suggestRecoveryAction(kind)];
    if (byAction) {
      out.push(byAction);
    }
  }
  if (!out.length) {
    out.push(...GENERIC_REMEDIATION);
  } else if (!out.includes(GENERIC_REMEDIATION[0])) {
    // 总是附一条「如何看更多」的兜底，确保用户有下一步
    out.push(GENERIC_REMEDIATION[0]);
  }
  return out;
}

/** 从错误对象/结果对象中尽力提取退出码（数字）。 */
function _extractExitCode(err) {
  if (err == null || typeof err !== 'object') {
    return undefined;
  }
  for (const key of ['exitCode', 'status', 'statusCode']) {
    const v = err[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  // err.code 可能是数字退出码，也可能是 errno 字符串；仅数字时当退出码
  if (typeof err.code === 'number' && Number.isFinite(err.code)) {
    return err.code;
  }
  return undefined;
}

/** 提取 errno 风格的字符串码（ENOENT / MODULE_NOT_FOUND…）。 */
function _extractErrno(err) {
  if (
    err &&
    typeof err === 'object' &&
    typeof err.code === 'string' &&
    /^[A-Z_]+$/.test(err.code)
  ) {
    return err.code;
  }
  return undefined;
}

/**
 * 把任意错误归一为「真实原因 + 解决方案」结构。
 *
 * @param {unknown} err  Error / 字符串 / {error|message, exitCode|status, stderr}
 * @param {object} [opts]
 * @param {string} [opts.title]    面板标题（默认按归类生成）
 * @param {string} [opts.context]  命令/操作上下文（如命令名、路径），用于丰富建议
 * @param {string} [opts.stderr]   子进程 stderr（作为真实原因补充）
 * @param {string} [opts.fallbackReason] 实在拿不到原因时的兜底文案
 * @param {string} [opts.platform] 修复指引的平台分支（'win32' | POSIX；缺省 process.platform），
 *   测试注入用；面向用户的命令必须在该平台上真能执行
 * @returns {{ title:string, reason:string, exitCode:(number|undefined), kind:(string|undefined), suggestions:string[], stack:(string|undefined) }}
 */
function describeCliError(err, opts = {}) {
  const exitCode = _extractExitCode(err);
  const errno = _extractErrno(err);
  const kind = detectErrorKindDeep(err);

  // 真实原因：优先错误消息链（脱敏），并入显式 stderr。绝不止退出码。
  // 仅从「真正承载文案」的来源取原因，避免把 {exitCode,stderr} 这类结果对象
  // JSON.stringify 成噪音（也会污染退出码判断）。
  let reason = '';
  if (err instanceof Error || typeof err === 'string') {
    reason = formatErrorMessage(err);
  } else if (err && typeof err === 'object') {
    const msg =
      typeof err.error === 'string' && err.error.trim()
        ? err.error
        : typeof err.message === 'string' && err.message.trim()
          ? err.message
          : '';
    if (msg) {
      reason = formatErrorMessage(msg);
    }
  }
  const stderrText = (opts.stderr || (err && typeof err === 'object' ? err.stderr : '') || '')
    .toString()
    .trim();
  if (stderrText) {
    const cleaned = formatErrorMessage(stderrText);
    reason = reason && reason !== cleaned ? `${reason} | ${cleaned}` : cleaned;
  }
  reason = (reason || '').trim();
  // 只剩退出码、无任何文案时，至少说明"进程以非零码退出"，并附兜底原因
  if (!reason || reason === '-1' || reason === String(exitCode)) {
    reason =
      opts.fallbackReason ||
      (exitCode != null
        ? `进程以退出码 ${exitCode} 结束，但未输出具体错误信息。`
        : '操作失败，但未捕获到具体错误信息。');
  }
  if (exitCode != null && !reason.includes(`退出码 ${exitCode}`) && !/exit\s*code/i.test(reason)) {
    reason = `${reason}（退出码 ${exitCode}）`;
  }

  // 解决方案：errno 最精确 > kind 映射 > 失败协议字典 > 通用兜底。永不为空。
  // platform 经 opts 注入，使 Windows / POSIX 两条分支都可被单测直接覆盖。
  const suggestions = remediationText(kind, errno, opts.platform, opts.context);

  const title = opts.title || (kind ? `命令失败（${_kindLabel(kind)}）` : '命令失败');

  const stack = err instanceof Error && err.stack ? err.stack : undefined;

  return { title, reason, exitCode, kind, suggestions, stack };
}

function _kindLabel(kind) {
  const labels = {
    network: '网络',
    timeout: '超时',
    rate_limit: '限流',
    context_length: '上下文超限',
    auth: '认证',
    permission: '权限',
    billing: '计费',
    model_not_found: '模型不存在',
    overloaded: '服务过载',
    server_error: '服务端错误',
    refusal: '安全拦截',
    cancelled: '已取消',
    process: '子进程',
  };
  return labels[kind] || kind;
}

// ── 失败人话化（渲染层翻译叶子，门控 KHY_FAILURE_HUMAN_TEXT）──────────────────
// 断桥（2026-11-01 用户截图实测）：上游 401 的 JSON 报文被**原样**贴到用户可见的
// 信封首屏与失败墙上（`通道: OpenCode Zen (401) [auth] — {"type":"error",…}`），
// 墙行同样只剩英文机器串（`Missing API key.` / `Kiro IDE unavailable`）——
// 用户看不出「哪家、为什么、下一步敲什么」。
//
// 与 upstreamTruthLabel 的分工（**不可合并**）：那个叶子只产**标签**，且它的规则表
// 经 `_isActionableCause` → `_resolveCode` 喂判码侧，扩它会静默翻机器码（探针实测
// 同一份 attempts 从 `code=RATE_LIMITED` 翻到 `code=NONE`）；本叶子只被**渲染层**
// 调用，产一整句「问题 + 原因 + 下一步」，判码侧一个字节都不碰。
// 两套 body 解析器因此**刻意不共享**——共享解析器会让两侧规则互相耦合。
//
// 铁律：人话句由**固定中文模板**拼装，绝不插值上游 message（上游 401 体常带明文 key）；
// 原文只走机器通道（attempts[].error / cause.detail），脱敏口径沿用既有单一真源。

// kind → 一句纯用户文案。实现纪律（识别码怎么取、私有 type 不进识别码槽）不在这里，
// 在 _pickRecognitionCode 与 _KIND_RULES。
const HUMAN_SENTENCES = Object.freeze({
  // ── 上游结构化错误体（21 族映射表）──
  missing_api_key: {
    label: '缺少 API Key',
    reason: '该通道尚未配置 API Key',
    fix: '请运行 ai config 配置该通道的 API Key，配好即可继续',
  },
  invalid_api_key: {
    label: 'API Key 无效或已过期',
    reason: '上游拒绝了本次请求携带的密钥',
    fix: '请运行 ai config 更新该通道的 API Key，并确认账号余额与权限',
  },
  // 与 invalid_api_key 分两族：上游用机器码 `invalid_api_key` 拒绝时，原因写「按密钥无效
  // 拒绝」更准（它不是「key 过期」那类时间性问题），且不必让用户去核对余额。
  invalid_api_key_code: {
    label: 'API Key 无效或已过期',
    reason: '上游按密钥无效拒绝了本次请求',
    fix: '请运行 ai config 更新该通道的 API Key',
  },
  free_tier: {
    label: '免费层客户端校验未通过',
    reason: '该免费通道只接受 OpenCode 客户端指纹',
    fix: '请运行 /model 改用其它通道，或为付费通道配置 API Key',
  },
  model_unsupported: {
    label: '该模型不被上游支持',
    reason: '该模型已在上游下线',
    fix: '请运行 /model 换一个上游仍支持的模型',
  },
  endpoint_unavailable: {
    label: '上游端点不可用',
    reason: '该通道的端点当前不可用，属瞬态故障',
    fix: '稍后重试即可自愈；仍失败请运行 /model 换一个更稳的通道',
  },
  free_usage_limit: {
    label: '上游免费额度用尽',
    reason: '额度按出口 IP 计算，重试无用',
    fix: '请等配额恢复后重试，或运行 /model 换用付费/其它通道',
  },
  region_error: {
    label: '该模型在当前地区不可用',
    reason: '上游按出口地区拒绝了该模型',
    fix: '请运行 /model 换用其它地区可用的模型',
  },
  bad_param: {
    label: '请求参数不被上游接受',
    reason: '上游点名了本次请求里不被接受的参数',
    fix: '请按上游原文调整该参数后重试；本仓已内置自适应剥离机制，会自动重试一次',
  },
  previous_response_not_found: {
    label: '会话续接标识已失效',
    reason: '上游找不到上一次响应的标识',
    fix: '请去掉 previous_response_id 重新发起请求，或新建会话',
  },
  auth_error_type: {
    label: '认证失败',
    reason: '上游以认证错误拒绝了本次请求',
    fix: '请运行 ai config 更新该通道的 API Key',
  },
  claude_code_stream: {
    label: 'Claude 通道返回错误',
    reason: '该次调用被上游拒绝',
    fix: '请运行 khy gateway status 看该通道实测状态；凭据问题请运行 khy login 重新认证，否则换通道重试',
  },
  empty_response: {
    label: '上游返回空内容',
    reason: '模型服务连上了但没有产出任何文字或工具调用',
    fix: '请直接重试；若反复空回，请运行 /model 换用更稳的模型',
  },
  http_404_bare: {
    label: '模型不存在',
    reason: '上游只回了状态码、没有说明原因',
    fix: '请运行 /model 查看可用模型并改选',
  },
  zhipu_1211: {
    label: '模型不存在',
    reason: '该账号尚未领取或开通这个模型',
    fix: '请运行 /model 换用已开通的模型，或到厂商控制台领取该免费模型后重试',
  },
  zhipu_1002: {
    label: '认证失败',
    reason: '智谱拒绝了该密钥（token 无效或鉴权校验未通过）',
    fix: '请运行 ai config 重新配置该通道的智谱 API Key 后重试',
  },
  econnrefused: {
    label: '网络连接失败',
    reason: '目标服务没有在监听',
    fix: '请运行 khy server start 启动服务，或改用其它模型通道',
  },
  enotfound: {
    label: '域名解析失败',
    reason: '主机名无法解析成地址',
    fix: '请核对目标地址拼写与 DNS 连通性；受限网络下先运行 /proxy 配置代理',
  },
  timeout: {
    label: '请求超时',
    reason: '上游在时限内没有返回结果',
    fix: '请稍后重试；若持续超时请检查 /proxy 代理配置并运行 khy gateway status 检查通道',
  },
  unavailable: {
    label: '通道不可用',
    reason: '该通道未注册、未启用或未安装',
    fix: '请运行 khy gateway status 查看各通道实测状态；或运行 /model 换用其它通道',
  },
  unrecognized: {
    label: '上游返回了无法识别的错误',
    reason: '本机无法判断该错误的真实含义',
    fix: '请运行 khy gateway status 查看各通道实测状态，并换一条通道重试；需要定位时输入 /err 查看原始报文',
  },
  // ── errorType 家族兜底（仅非 JSON 体走到）──
  // 上游只给了裸文本（`auth failed with …` / `bad gateway` / `too many requests`）时，
  // 没有结构化真因可判，但 errorType 本身已是路由层判定的具体事实。
  // 措辞对齐 AGENTS.md 规则 2.2 的常见错误类型表，命令全是本仓真实存在的。
  permission_denied: {
    label: '权限不足',
    reason: '上游拒绝了本次请求的权限',
    fix: '请检查该通道的账号订阅与权限，或运行 /model 换用其它通道',
  },
  rate_limited: {
    label: '请求被限流',
    reason: '上游单位时间内的请求数超限',
    fix: '请降低并发、稍后重试；持续限流请运行 /model 换一条通道',
  },
  upstream_error: {
    label: '上游服务异常',
    reason: '模型服务暂不可用',
    fix: '请稍后重试；持续失败请运行 khy gateway status 检查通道',
  },
  network_error: {
    label: '网络连接失败',
    reason: '请求没能送到模型服务',
    fix: '请检查网络与代理（/proxy），或运行 khy gateway status 看实测状态',
  },
  model_not_found: {
    label: '模型不存在',
    reason: '上游没有这个模型',
    fix: '请运行 /model 查看可用模型并改选',
  },
  context_too_long: {
    label: '上下文超限',
    reason: '本轮对话长度超过了模型上限',
    fix: '请运行 /compact 压缩上下文，或新建会话后重试',
  },
  process_error: {
    label: '服务进程异常',
    reason: '承载该通道的进程异常退出',
    fix: '请运行 khy gateway status 查看各通道实测状态，或运行 /model 换用其它通道',
  },
});

// 有序规则表：更具体的在前，命中即停。只认**已发生**的信号，不猜。
const _KIND_RULES = [
  // 会话续接标识失效：上游 code 机器可判，优先于 message 文本。
  { kind: 'previous_response_not_found', re: /previous[_\s-]?response[_\s-]?not[_\s-]?found|previous[_\s-]?response[\s\S]{0,200}(?:not found|expired)/i },
  // 智谱把可执行的错误码放 body（1211 模型未领取 / 1002 鉴权失败），HTTP 400·401 单独看没有信息量。
  { kind: 'zhipu_1211', code: '1211' },
  { kind: 'zhipu_1002', code: '1002' },
  // 密钥族：「完全没配」在「配了但无效」之前；上游机器码 invalid_api_key 在消息文本之前
  // （code 是机器可判的，message 措辞各厂商不一）。
  { kind: 'invalid_api_key_code', code: 'invalid_api_key' },
  { kind: 'missing_api_key', re: /missing api[_\s-]?key|no api[_\s-]?key|api[_\s-]?key not (?:found|provided|configured)/i },
  { kind: 'invalid_api_key', re: /invalid[_\s-]?api[_\s-]?key|incorrect api key|api key[\s\S]{0,40}(?:invalid|expired|revoked)/i },
  // 额度 / 客户端指纹 / 地区 / 模型下线。
  { kind: 'free_usage_limit', re: /freeusage limite?rror|free usage limit|usage limit reached|quota exceeded|insufficient[_\s-]?quota/i },
  { kind: 'free_tier', re: /freetiererror|free tier can only be used/i },
  { kind: 'region_error', re: /regionerror|not available in your (?:country|region)/i },
  { kind: 'model_unsupported', re: /modelerror|is not supported|unsupported model/i },
  { kind: 'endpoint_unavailable', re: /endpoint is unavailable|upstream request failed/i },
  // 上游私有 type 只进机器通道；这两个结构化族要转述成中文。
  { kind: 'bad_param', vendorType: 'invalidrequesterror', hasParam: true },
  { kind: 'auth_error_type', vendorType: 'autherror' },
  { kind: 'claude_code_stream', systemError: true },
  // 本机 / 传输层。
  { kind: 'econnrefused', re: /econnrefused/i },
  { kind: 'enotfound', re: /enotfound|getaddrinfo/i },
  { kind: 'timeout', re: /timeout|timed out|socket hang up|etimedout/i },
  // 上游只回状态码、没说原因。
  { kind: 'http_404_bare', statusCode: 404 },
  { kind: 'empty_response', re: /\bempty response\b/i },
  // 本机没装 / 没启用：errorType 是路由层判据，错误文本只是附和。
  { kind: 'unavailable', errorType: 'unavailable' },
];

// errorType → 家族 kind。刻意**不含** empty / no_provider：它们的原始文案已经是
// 具体中文可执行句（multiFreeService 的 empty 理由写明「max_tokens 过小」/「仅返回
// 工具调用」），二次转述只会丢信息。也不含 cancelled：取消不是要解释的错误。
const _ERRTYPE_KINDS = Object.freeze({
  auth: 'auth_error_type',
  permission: 'permission_denied',
  rate_limit: 'rate_limited',
  server_error: 'upstream_error',
  overloaded: 'upstream_error',
  network: 'network_error',
  timeout: 'timeout',
  model_not_found: 'model_not_found',
  context_length: 'context_too_long',
  unavailable: 'unavailable',
  process: 'process_error',
});

// 识别码不在 HTTP 状态码里的两个族，单独点名：
//   智谱把真码放 body（HTTP 400 与 code 1211 要一起给，用户才知去哪领模型）；
//   timeout 没有 HTTP 状态，补语义等价的 504，否则「请求超时」缺一个可引用的识别码。
const _COMPOSITE_CODE_KINDS = new Set(['zhipu_1211', 'zhipu_1002']);
const _INTRINSIC_CODE_KINDS = Object.freeze({ timeout: '504' });

/** 从正文文本里挖「code N」形态的厂商错误码（智谱 `HTTP 400 · code 1211`）。 */
function _codeFromText(text) {
  const m = /code[:\s]*([0-9]{3,6})/i.exec(text);
  return m ? m[1] : '';
}

/** 从正文文本里挖 HTTP 状态码（`status code 404` / `HTTP 400`）。 */
function _statusFromText(text) {
  const m = /(?:status code|http)\s*[:\s]*([0-9]{3})/i.exec(text);
  return m ? Number(m[1]) : 0;
}

/** 从正文文本里认 errno 形态的系统码（显式名册，避免把 ERROR 这类普通词误认成 errno）。 */
const _ERRNO_NAMES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EACCES',
  'EPERM',
  'ENOENT',
];

function _errnoFromText(text) {
  for (const name of _ERRNO_NAMES) {
    if (text.includes(name)) {
      return name;
    }
  }
  return '';
}

/**
 * 私有 body 解析器：认 OpenAI `{error:{type,message,code,param}}` /
 * OpenCode 嵌套 `{type:'error',error:{…}}` / OpenCode 扁平 `{type:'error',message}` /
 * 扁平 `{code,message}` / 智谱 `智谱AI: HTTP N · code N · …` 文本 / 非 JSON 纯文本。
 *
 * 刻意**不复用** upstreamTruthLabel._parseBody：共享解析器会让两侧规则互相耦合，
 * 那是上一轮阻断的根因。绝不抛；解析失败按纯文本处理。
 */
function _parseBody(raw) {
  const text = raw == null ? '' : String(raw).trim();
  const out = {
    vendorType: '',
    message: '',
    code: '',
    param: '',
    topType: '',
    subtype: '',
    codeFromText: '',
    statusFromText: 0,
    json: false,
    text,
  };
  if (!text) {
    return out;
  }
  out.codeFromText = _codeFromText(text);
  out.statusFromText = _statusFromText(text);
  if (text[0] !== '{') {
    return out;
  }
  let o = null;
  try {
    o = JSON.parse(text);
  } catch {
    return out;
  }
  if (!o || typeof o !== 'object') {
    return out;
  }
  out.json = true;
  out.topType = String(o.type || '');
  out.subtype = String(o.subtype || '');
  const e = o.error && typeof o.error === 'object' ? o.error : null;
  const src = e || o;
  out.vendorType = String(src.type || '');
  out.message = String(src.message || '');
  out.code = src.code == null ? '' : String(src.code);
  out.param = src.param == null ? '' : String(src.param);
  return out;
}

function _ruleHit(rule, ctx) {
  if (rule.code && rule.code !== ctx.body.code && rule.code !== ctx.body.codeFromText) {
    return false;
  }
  if (rule.vendorType && rule.vendorType !== ctx.vendor) {
    return false;
  }
  if (rule.systemError && !(ctx.body.topType === 'system' && ctx.body.subtype === 'error')) {
    return false;
  }
  if (rule.hasParam && !ctx.body.param) {
    return false;
  }
  if (rule.statusCode && Number(rule.statusCode) !== ctx.statusCode) {
    return false;
  }
  if (rule.errorType && rule.errorType !== ctx.errorType) {
    return false;
  }
  if (rule.re && !rule.re.test(ctx.hay)) {
    return false;
  }
  return true;
}

/**
 * 判定失败族。返回 null = 「本机不该转述这条」→ 调用方逐字节保留今日文案。
 *
 * 三段的边界：
 *   ① 结构化 / 文本规则（JSON 体与非 JSON 体都过）；
 *   ② JSON 体认不出 → unrecognized（JSON/HTML 错误页不得上用户桌面）；
 *   ③ 非 JSON 体 → errorType 家族兜底；连 errorType 都没有可用家族 → null（保留今日文案，
 *      例如已是具体中文可执行句的 empty 理由、`no_provider` 的配置指引）。
 */
function _classifyHumanKind({ body, text, errorType, statusCode }) {
  const vendor = String(body.vendorType || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, '');
  const t = String(errorType || '')
    .trim()
    .toLowerCase();
  const ctx = {
    body,
    hay: `${body.vendorType} ${body.message} ${body.code} ${body.param} ${text}`,
    vendor,
    errorType: t,
    statusCode,
  };
  for (const r of _KIND_RULES) {
    if (_ruleHit(r, ctx)) {
      return r.kind;
    }
  }
  // 空体：上游什么都没说，用户桌面上不该出现空串 / 'unknown error'。
  if (!text.trim()) {
    return 'unrecognized';
  }
  if (body.json) {
    return 'unrecognized';
  }
  if (t && Object.prototype.hasOwnProperty.call(_ERRTYPE_KINDS, t)) {
    return _ERRTYPE_KINDS[t];
  }
  return null;
}

/**
 * 识别码取用顺序（AGENTS.md 规则 2.2 的「识别码」位，硬规则）：
 *   ① 上游 body 的 `code` 字段（invalid_api_key / previous_response_not_found / 智谱 1211·1002）——
 *      上游自己写的机器码比通用 HTTP 桶更可执行（400 有十几种成因，`invalid_api_key` 只有一种）；
 *   ② HTTP 状态码（含正文嵌的 `status code N` / `HTTP N`）——200 是成功码，不得作失败识别码；
 *   ③ errno；
 *   ④ 我方 errorType——只有「没有 HTTP 码可依」的 empty / unavailable 两族；
 *   ⑤ 无（省略括号）。
 * 上游私有 `type`（AuthError / FreeTierError / api_error / WeirdError…）**一律不进识别码槽**，
 * 只在 reason 里中文转述。
 */
function _pickRecognitionCode({ body, statusCode, errno, errorType, kind }) {
  const http = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : body.statusFromText;
  if (_COMPOSITE_CODE_KINDS.has(kind)) {
    const vendorCode = body.code || body.codeFromText;
    if (http >= 400 && vendorCode) {
      return `${http} / code ${vendorCode}`;
    }
  }
  if (body.code) {
    return String(body.code);
  }
  if (http >= 400) {
    return String(http);
  }
  if (errno) {
    return String(errno);
  }
  const t = String(errorType || '')
    .trim()
    .toLowerCase();
  if (t === 'empty' || t === 'unavailable') {
    return t;
  }
  return _INTRINSIC_CODE_KINDS[kind] || '';
}

/** 门控 KHY_FAILURE_HUMAN_TEXT 是否启用。flagRegistry 优先，失败 → 本地 CANON。绝不抛。 */
function humanTextEnabled(env) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (
      flagRegistry &&
      typeof flagRegistry.isRegistryEnabled === 'function' &&
      flagRegistry.isRegistryEnabled(e) &&
      typeof flagRegistry.isFlagEnabled === 'function'
    ) {
      return flagRegistry.isFlagEnabled('KHY_FAILURE_HUMAN_TEXT', e);
    }
    const raw = e.KHY_FAILURE_HUMAN_TEXT;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return false;
  }
}

/**
 * 把一条原始失败报文翻成一句中文人话。**只被渲染层调用**。
 *
 * @param {object} a
 * @param {string} [a.raw]        原始错误报文（attempt.error / attempt.message）
 * @param {string} [a.errorType]  已归类的 errorType（内部类别，本函数绝不改它）
 * @param {number} [a.statusCode] HTTP 状态码（没有就传 0）
 * @param {string} [a.errno]      errno 风格码（缺省从 raw 里认）
 * @param {object} [a.env]        注入 env（可测）
 * @returns {{kind:string, label:string, code:string, reason:string, fix:string,
 *            sentence:string, raw:string, matched:boolean}|null}
 *          门关 / 本机不该转述 / 异常 → null（调用方逐字节保留今日文案）
 */
function humanizeFailure({ raw, errorType, statusCode, errno, env } = {}) {
  try {
    if (!humanTextEnabled(env)) {
      return null;
    }
    const text = raw == null ? '' : String(raw);
    const body = _parseBody(text);
    const sc = Number.isFinite(Number(statusCode)) && Number(statusCode) > 0
      ? Number(statusCode)
      : body.statusFromText;
    const kind = _classifyHumanKind({ body, text, errorType, statusCode: sc });
    if (!kind) {
      return null;
    }
    const entry = HUMAN_SENTENCES[kind] || HUMAN_SENTENCES.unrecognized;
    const eno = errno || _errnoFromText(text);
    const code = _pickRecognitionCode({ body, statusCode: sc, errno: eno, errorType, kind });
    const codeSeg = code ? ` (${code})` : '';
    return {
      kind,
      label: entry.label,
      code,
      reason: entry.reason,
      fix: entry.fix,
      sentence: `${entry.label}${codeSeg}：${entry.reason}，${entry.fix}`,
      // 仅作机器通道存证（与 attempts[].error / cause.detail 同源），**永不渲染**。
      raw: text,
      matched: kind !== 'unrecognized',
    };
  } catch {
    return null;
  }
}

/**
 * 墙行 / 信封行**共用**的去重合成器（不得各写一份，否则 label 与识别码的重复度会两处漂移）。
 *
 * @param {object} narrative humanizeFailure 的产出
 * @param {object} [opts]
 * @param {string} [opts.bracketToken]          同行 kind 槽当前显示的 token
 * @param {boolean} [opts.bracketIsTruthLabel]   kind 槽是否正显示中文真因标签（truth.label）
 * @returns {string} 空串 = 无人话可合成（调用方回回落文案）
 */
function composeHuman(narrative, opts = {}) {
  try {
    const n = narrative && typeof narrative === 'object' ? narrative : null;
    if (!n || !n.label) {
      return '';
    }
    const o = opts && typeof opts === 'object' ? opts : {};
    const bracket = String(o.bracketToken == null ? '' : o.bracketToken).trim();
    const code = n.code == null ? '' : String(n.code).trim();
    // 句子识别码与同行 kind 槽 token 相同 → 省括号段（墙行已显 `[unavailable]`，再写一遍是噪音）。
    const codeSeg = code && code !== bracket ? ` (${code})` : '';
    // kind 槽已显示中文真因标签 → 省 label 段，否则成 `[缺少 API Key]: 缺少 API Key (401)：…`。
    const labelSeg = o.bracketIsTruthLabel === true ? '' : `${n.label}${codeSeg}：`;
    const reason = n.reason == null ? '' : String(n.reason);
    const fix = n.fix == null ? '' : String(n.fix);
    const tail = [reason, fix].filter(Boolean).join('，');
    if (!tail) {
      return labelSeg ? `${n.label}${codeSeg}` : '';
    }
    return `${labelSeg}${tail}`;
  } catch {
    return '';
  }
}

module.exports = {
  describeCliError,
  remediationText,
  _kindLabel,
  _normalizePlatform,
  KIND_REMEDIATION,
  ERRNO_REMEDIATION,
  GENERIC_REMEDIATION,
  BY_ACTION_REMEDIATION,
  HUMAN_SENTENCES,
  humanizeFailure,
  composeHuman,
  humanTextEnabled,
};
