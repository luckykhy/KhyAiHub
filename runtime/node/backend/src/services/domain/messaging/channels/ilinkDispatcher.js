'use strict';

/**
 * ilinkDispatcher.js — 微信入站消息的编排层。
 *
 * 职责:拿到一条已归一的入站消息 → 决定怎么处理 → 把回答发回微信。
 *
 * 为什么需要**串行队列**(而不是并发跑 agent):
 *   chat() 不可重入。即使会话历史已按 sessionId 隔离(见 _chatWithWatchdog 中的
 *   scopeSession),仍有一批进程级全局态会互相污染:
 *   cancelActiveRequest() 会 abort 所有在飞请求、aiLocalState.liveSessionId 让所有人的
 *   消息写进同一份转写本、以及进程级的权限模式与 cwd。所以一次只跑一个查询。
 *
 * 为什么**权限回复要插队**:
 *   `y`/`n` 是对「正在跑的那个查询」的应答。若让它排在队列里等,它要等的正是它要放行的
 *   那个查询——必然死锁到超时。故权限回复不进队列,直接交给等待中的 resolver。
 *
 * 与参考实现的关键差异:「忙」状态只放内存,绝不落盘。参考实现把 state='processing'
 * 持久化,进程崩在查询中途后重启即永久死锁(每条消息都回「正在处理上一条」,而唯一的
 * 逃生口 /clear 又被显式挡住,只能手删 JSON)。
 *
 * 契约:fail-soft。任何异常都要变成一句发得出去的中文,绝不让微信那头没有下文。
 *
 * @module services/channels/ilinkDispatcher
 */

const fs = require('fs');
const path = require('path');

const defaults = require('../../../../constants/serviceDefaults');
const log = require('../../../../utils/logger');
const core = require('../messaging/ilinkCore');
// 「描述/自述」职责簇（连接健康 / 路由 / 通道列表）—— 纯读 + 拼串，单独成文件。
const _diag = require('./ilinkDispatchDiagnostics');
// 「按账号绑定路由」职责簇 —— 全文件唯一改进程级 cwd/env/agent 指针的地方，单独成文件。
const _routing = require('./ilinkWorkspaceRouting');
// 「文件投递」职责簇 —— 失败矩阵密集 + 铁律「绝不影响后续文本回复」，单独成文件。
const _delivery = require('./ilinkFileDelivery');
// 「待批出站草稿」职责簇 —— 按发送者分桶的队列（作者绑定与过期语义都在那里）。
const { ReplyDraftQueue } = require('./ilinkReplyDraft');

/**
 * 取 chat 内核。
 *
 * **显式注入是权威的**:deps.getChat 一旦给出,它的结果(含 null)即为最终答案,绝不再往下
 * 回落。否则测试注入一个空 chat 后,会静默把整个 CLI ai 模块拉起来打真模型——既让「离线单测」
 * 名不副实,也让「AI 内核缺失」这条分支永远测不到。
 *
 * 未注入时才走生产回落链:aiChatPort → 惰性加载 CLI ai(headless 守护进程正是这样接的,
 * 此时 cli/ai.js 可能还没被 require 过,aiChatPort 就是空的)。
 *
 * @param {object} deps
 * @returns {Function|null}
 */
function _resolveChat(deps = {}) {
  if (typeof deps.getChat === 'function') {
    try {
      const c = deps.getChat();
      return typeof c === 'function' ? c : null;
    } catch {
      return null;
    }
  }
  try {
    const c = require('../../../aiChatPort').getAiChat();
    if (typeof c === 'function') {
      return c;
    }
  } catch {
    /* 落到下一档 */
  }
  try {
    // 惰性加载:cli/ai.js 在加载时会把 chat 注册进 aiChatPort。
    _ensureCliRegistered();
    const c = require('../../../aiChatPort').getAiChat();
    if (typeof c === 'function') {
      return c;
    }
  } catch {
    /* 仍无 → 返回 null,上层回一句诚实的话 */
  }
  return null;
}

/**
 * 惰性加载 CLI ai 模块,触发它在 aiChatPort 上的自注册(chat + 会话控制操作)。
 *
 * 这是本文件**唯一**一处保留的 `cli/` 引用,且方向是「拉起来」而非「取实现」:
 * 模块加载即自注册,取用一律经 aiChatPort。进程内只生效一次(Node require 缓存),
 * 重复调用零成本。CLI 不可用(纯后端/单测)时静默——调用方各自的 fail-soft 兜底。
 */
function _ensureCliRegistered() {
  try {
    require('../../../../cli/ai');
  } catch {
    /* CLI 不可用:port 保持空,调用方降级 */
  }
}

/**
 * 取 CLI 会话控制操作(clearHistory / cancelActiveRequest / scopeSession /
 * maybeAutoCheckpointProgress),与 _resolveChat 同一条两档回落链:
 * aiChatPort IoC seam → 惰性加载 CLI ai 触发自注册 → 再取一次。
 *
 * 这样 services 层只在「自举」意义下碰 cli/(单一引用点),实现一律经 port 取,
 * 打破 _resolveChat 之外的散点 R1 分层倒置。
 *
 * @param {string} getter  aiChatPort 上的 getter 名
 * @returns {Function} 取到的函数;两档都失败时抛错,由调用方的 catch 兜底。
 */
function _resolveSessionControl(getter) {
  const port = require('../../../aiChatPort');
  const first = port[getter];
  if (typeof first === 'function') {
    const fn = first();
    if (typeof fn === 'function') return fn;
  }
  _ensureCliRegistered();
  const late = require('../../../aiChatPort')[getter]();
  if (typeof late !== 'function') {
    throw new Error(`CLI 会话内核未加载(${getter} 不可用)`);
  }
  return late;
}

/** 看门狗的哨兵值。用独占 Symbol,避免与 chat() 的任何合法返回值撞上。 */
const _TIMED_OUT = Symbol('ilink-query-timeout');

/**
 * 判定一条自然语言文本是否在请求「发绑定二维码」。**纯诊断用途，不接任何发送路径。**
 *
 * 为什么留着：它仍是对外导出的（module.exports.isBindQrIntent），诊断与排障
 * 「用户是不是在要码」要靠它。但它**不再**构成发码入口 —— 原来 handle() 里
 * `isBindQrIntent(msg.text)` 命中即 `_sendBindQrCode`，那一步在任何 agent 判断
 * 之前就把码发出去，是整个洞的全部。现在自然语言里的「发我二维码」只当普通 prompt
 * 进 agent，由模型按系统提示回答「去终端跑 khy wx login」。
 *
 * 纯函数。
 * @param {string} text
 * @returns {boolean}
 */
function isBindQrIntent(text) {
  const t = String(text == null ? '' : text)
    .trim()
    .toLowerCase();
  if (!t) {
    return false;
  }
  const patterns = [
    '绑定二维码',
    '二维码发给我',
    '发绑定码',
    '把二维码',
    '绑定码',
    '发我二维码',
    '给我二维码',
    '发个二维码',
    '要二维码',
    '二维码给我',
    '发个绑定码',
    'qrcode',
  ];
  return patterns.some((p) => t.includes(p));
}

/**
 * 取结构化工具循环(runToolUseLoop),不可用/未启用时返回 null。
 *
 * 为什么微信这条路**必须**走它:模型有两种发起工具调用的方式 ——
 *   1. 自然语言语法写在回复正文里 → chat() 内部的循环会处理;
 *   2. 原生 tool_calls(结构化 toolUseBlocks) → chat() **只把它原样返回给调用方**,
 *      自己不执行。执行者是 runToolUseLoop,历来只有 REPL / TUI 在驱动。
 * 现在的云端模型(agnes / sensenova / stepfun 都是)走的是第 2 种。只调 chat() 的话,
 * 「我的桌面上有什么」这类请求会拿到一句合成的占位符 `[模型请求执行工具: Glob]`,
 * 工具一个都没跑 —— 于是微信里只有纯闲聊能通,凡是要动手的一律哑火,而这恰恰是
 * 接微信的全部意义。
 *
 * @returns {object|null} toolUseLoop 模块,或 null
 */
function _resolveToolLoop() {
  if (String(process.env.KHY_ILINK_DISABLE_TOOL_LOOP || '').toLowerCase() === '1') {
    return null;
  }
  try {
    const loop = require('../../../toolUseLoop');
    if (!loop || typeof loop.runToolUseLoop !== 'function') {
      return null;
    }
    if (typeof loop.isEnabled === 'function' && !loop.isEnabled()) {
      return null;
    }
    return loop;
  } catch {
    return null;
  }
}

/**
 * 微信这条路是否也遵循全局的「首选通道严格模式」。
 * 默认 false(允许回落)——见 _runQuery 里 preferredStrict 处的说明。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function _ilinkStrictRoute(env = process.env) {
  const raw = env && env.KHY_ILINK_STRICT_ROUTE;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * 取入站发送者允许名单模块（惰性 require：它会读 store 与 serviceDefaults，
 * 不该在通道模块的加载期就被拽进来）。取不到返回 null，调用方各自 fail-soft。
 * @returns {object|null}
 */
function _allowlist() {
  try {
    return require('../messaging/ilinkPeerAllowlist');
  } catch {
    return null;
  }
}

/**
 * 微信通道单轮追加的 khy-os 身份 / 绑定说明系统提示。
 *
 * 为什么必须有:底层云端大模型的训练语料里带着 OpenClaw/ClawBot 官方产品套路
 * (khy-os 从 OpenClaw 衍生,ilink 通道用同套 bot_type=3 后端)。不告诉模型
 * 「你现在是 khy-os」,用户在微信问「你是谁 / 怎么绑定 / 发绑定二维码」时,模型
 * 就会按 OpenClaw 老剧本乱答(让用户装 WorkBuddy、去 openclaws.io),与 khy-os
 * 真实流程(khy wx login)完全对不上。
 *
 * 作用域:只通过 chatOpts.appendSystemPrompt 追加到「本轮」已装配好的系统提示尾部
 * (见 aiChatCore 的 --append-system-prompt 对齐点),不改全局人设/静态基座,
 * 不碰 .env。这段只补「khy-os 身份 + 微信绑定事实」,不改变任何其他行为。
 */
const ILINK_IDENTITY_SYSTEM_PROMPT = [
  '【khy-os 身份与微信绑定事实 —— 仅本次微信对话生效,补充说明,不改变其他行为】',
  '你是 khy-os(一个 AI 平台操作系统)内置的助手,通过微信 ilink bot API(bot_type=3,',
  '与 ClawBot 同一套后端)接入用户微信。你不是 OpenClaw 官方产品,也不是 WorkBuddy 桌面端。',
  '',
  '关于「如何绑定微信 / 首次接入」的正确流程(务必据此回答,不要沿用旧产品套路):',
  '1. 在用户自己的电脑上运行 khy wx login —— 终端会显示一个二维码,用户用微信扫码登录。',
  '2. 扫码成功后运行 khy wx start,(重)启守护进程,微信这条通道才会持续在线。',
  '3. 会话过期时,重新运行 khy wx login 扫码即可恢复。',
  '',
  '绝对不要这样回答:不要建议用户去 openclaws io 下载 WorkBuddy。',
  '',
  '关于「发绑定二维码 / 发我二维码 / 把二维码发给我」这类请求:绑定码只在用户自己的',
  '终端申请**。二维码只显示在运行 khy wx login 的那台机器的终端里,不经过任何聊天转发,',
  '你无法生成、也无法代为转发它。请如实这样回答,不要说「已发送」「稍等」再让用户空等。',
  '',
  '保持简洁,只补充上述 khy-os 身份与微信绑定事实,不与既有全局人设冲突,不改变其他任何行为。',
].join('\n');

/**
 * Whether a normalized reply still carries raw tool-block JSON.
 *
 * finalResponse 可能来自「结构化 content blocks 被整体 JSON 化」的降级路径,
 * 直接外发就会把 tool_use / tool_result 原文推到微信用户眼前。
 * @param {string} text
 * @returns {boolean}
 */
function _looksLikeToolBlockJson(text) {
  if (!text) {
    return false;
  }
  return /"type"\s*:\s*"(tool_use|tool_result)"/.test(text);
}

/**
 * 把含 tool 块 JSON 的文本用 contentBlockUtils 二次清洗为纯文本(降级)。
 * fail-soft:解析不出结构化内容时原样返回,绝不因清洗失败丢掉整轮回复。
 * @param {string} text
 * @returns {string}
 */
function _stripToolBlocks(text) {
  try {
    const { contentToText, isStructuredContent } = require('../../../contentBlockUtils');
    const parsed = JSON.parse(text);
    // Only trust contentToText when parsed is a real content-block array.
    // A single object (e.g. {type:'text',...}) would otherwise stringify to
    // "[object Object]" and be sent to the WeChat user as a "cleaned" reply.
    if (isStructuredContent(parsed)) {
      const cleaned = contentToText(parsed);
      if (typeof cleaned === 'string' && cleaned.trim().length) {
        return cleaned;
      }
    }
  } catch {
    /* not a JSON payload — fall through to the line filter */
  }
  // Not a structured blocks array: drop the lines carrying tool-block markers.
  try {
    const kept = String(text)
      .split('\n')
      .filter((line) => !_looksLikeToolBlockJson(line));
    const cleaned = kept.join('\n').trim();
    if (cleaned.length) {
      return cleaned;
    }
  } catch {
    /* fail-soft */
  }
  return text;
}

/** 把 chat 的返回值归一成非空文本;形状与 msgReplyBridge._normalizeReply 一致。 */
function normalizeReply(out) {
  if (out == null) {
    return null;
  }
  let text = null;
  if (typeof out === 'string') {
    text = out;
  }
  // finalResponse 排在最前:走 runToolUseLoop 时,那才是工具执行完的最终答复;
  // 循环结果上没有 reply/content 字段,漏了它整轮就会被当成「没有可发送的回答」。
  else if (typeof out === 'object') {
    text =
      out.finalResponse ||
      out.text ||
      out.content ||
      out.reply ||
      out.message ||
      out.output ||
      null;
  }
  if (typeof text !== 'string') {
    return null;
  }
  // 防御层:提取出的文本仍带 tool 块 JSON 标记时降级清洗,不透传给微信用户。
  if (_looksLikeToolBlockJson(text)) {
    text = _stripToolBlocks(text);
  }
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

// 图片扩展名判定集。core.detectImageMime 存在,但它对非图片字节会回落到
// 'image/jpeg',不适作「是否图片」的闸门;故按扩展名确定投递方式。
const _IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

/**
 * 按扩展名判定是否图片(决定投递走 sendImage 还是 sendFile)。
 * @param {string} fileName
 * @returns {boolean}
 */
function _isImageFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return _IMAGE_EXTS.includes(ext);
}

/**
 * 清洗 image_generate 成功后最终回复中的临时文件路径行。仅微信 dispatcher 调用,
 * CLI 仍保留工具返回的本地路径。
 * @param {string|null} reply
 * @param {*} out
 * @param {{pendingLabel?:string}} [opts] pendingLabel 覆盖占位语。草稿态必须换词:
 *        图**还没发**,说「已发送」是当着人的面撒谎(规则 2)。
 * @returns {string|null}
 */
function _sanitizeGeneratedImageReply(reply, out, opts = {}) {
  if (!defaults.ILINK_SANITIZE_PATHS || typeof reply !== 'string') {
    return reply;
  }
  const done = String(opts.pendingLabel || '（图片已发送）');
  const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : [];
  const generatedPaths = [];
  const hasSuccessfulImage = logArr.some((entry) => {
    if (!entry || entry.tool !== 'image_generate' || !entry.result || entry.result.success !== true) {
      return false;
    }
    const paths = entry.result.meta && entry.result.meta.paths;
    if (Array.isArray(paths)) {
      generatedPaths.push(...paths.filter((value) => typeof value === 'string' && value.trim()));
    }
    return true;
  });
  if (!hasSuccessfulImage) {
    return reply;
  }

  const escapedPaths = generatedPaths.map((filePath) =>
    filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const knownPathPattern = escapedPaths.length ? new RegExp(escapedPaths.join('|'), 'i') : null;
  const tempPathPattern = /(?:^|\s)(?:\/tmp\/\S+|[a-z]:\\[^\r\n]*?\\temp\\\S+)/i;
  const cleaned = reply
    .split(/\r?\n/)
    .map((line) =>
      (knownPathPattern && knownPathPattern.test(line)) || tempPathPattern.test(line)
        ? done
        : line
    )
    .filter((line, index, lines) => line !== done || lines.indexOf(line) === index)
    .join('\n')
    .trim();
  return cleaned || done;
}

/**
 * Build the live-session scope key for an inbound message.
 *
 * Pure function: no side effects, never throws. An unknown/invalid scope
 * falls back to the per-account-channel-peer form (the safest isolation).
 * userId is trimmed to stay consistent with the historical
 * `ilink:${String(msg.userId||'').trim()}` cleansing.
 *
 *   'main'                     → 'ilink:shared'        (all peers share history)
 *   'per-peer'                 → 'ilink:<userId>'
 *   'per-channel-peer'         → 'ilink:<userId>'
 *   'per-account-channel-peer' → 'ilink:<accountId>:<userId>'  (default)
 *
 * @param {string} scope one of defaults.ILINK_SESSION_SCOPES
 * @param {string} accountId owning account id
 * @param {string} userId inbound peer user id
 * @returns {string} session scope key
 */
function buildSessionKey(scope, accountId, userId) {
  const uid = String(userId == null ? '' : userId).trim();
  const acc = String(accountId == null ? '' : accountId);
  switch (scope) {
    case 'main':
      return 'ilink:shared';
    case 'per-peer':
    case 'per-channel-peer':
      return `ilink:${uid}`;
    case 'per-account-channel-peer':
      return `ilink:${acc}:${uid}`;
    default:
      // Unknown/invalid scope: fall back to the strongest isolation form.
      return `ilink:${acc}:${uid}`;
  }
}

/**
 * One-time fallback migration for the Phase-1 dmScope change.
 *
 * Phase 1 flipped the default dmScope to `per-account-channel-peer`, moving the
 * live-session key from the historical single-account form `ilink:<userId>` to
 * `ilink:<accountId>:<userId>`. Without a migration, an existing single-account
 * user's next inbound message resumes the new (empty) key and their prior
 * history is silently orphaned on disk (the old session files still exist, they
 * are just no longer referenced).
 *
 * Chosen strategy vs. the real sessionPersistence API: there is NO id-rename /
 * alias primitive (renameSession only sets a title), so we copy — read the
 * legacy transcript via restoreSession and re-persist it under the new
 * account-scoped key via persistSession. persistSession appends only messages
 * beyond the current on-disk count, so a brand-new key receives the full legacy
 * transcript, and the metadata.cwd bucket is preserved. The subsequent
 * scopeSession(newKey) then resumes the migrated context seamlessly.
 *
 * Gates (all must hold, else no-op):
 *   - accountId is present;
 *   - the resolved scope produces an account-scoped key (i.e. it carries the
 *     accountId prefix — differs from the legacy per-peer key);
 *   - the new key has no persisted history yet (idempotent / one-time);
 *   - the legacy key DOES have persisted history.
 *
 * Fail-soft: throws nothing meaningful to the caller path; migration never
 * blocks chat and never weakens multi-account isolation — the target is the
 * account-scoped key, sourced only from THIS user's own single-account history.
 *
 * @param {object} persistence sessionPersistence-shaped module
 * @param {string} scope defaults.ILINK_SESSION_SCOPE
 * @param {string} accountId owning account id
 * @param {string} userId inbound peer user id
 * @returns {{migrated:boolean, reason:string}}
 */
function _migrateLegacyIlinkSession(persistence, scope, accountId, userId) {
  if (
    !persistence ||
    typeof persistence.loadSessionMeta !== 'function' ||
    typeof persistence.restoreSession !== 'function' ||
    typeof persistence.persistSession !== 'function'
  ) {
    return { migrated: false, reason: 'NO_PERSISTENCE' };
  }

  const acc = String(accountId == null ? '' : accountId).trim();
  if (!acc) {
    return { migrated: false, reason: 'NO_ACCOUNT' };
  }

  // Reuse buildSessionKey for BOTH keys — never re-derive key shapes here.
  const newKey = buildSessionKey(scope, accountId, userId);
  const legacyKey = buildSessionKey('per-peer', accountId, userId); // ilink:<userId>
  // Only account-scoped keys carry the accountId prefix. main / per-peer /
  // per-channel-peer either equal the legacy key or share nothing to migrate.
  if (newKey === legacyKey) {
    return { migrated: false, reason: 'NOT_ACCOUNT_SCOPED' };
  }
  if (newKey !== buildSessionKey('per-account-channel-peer', accountId, userId)) {
    return { migrated: false, reason: 'NOT_ACCOUNT_SCOPED' };
  }

  // New key already has history → already migrated or a native account user.
  // Cheap snapshot-only read (no chain rebuild); keeps the check O(1)/turn.
  const newMeta = persistence.loadSessionMeta(newKey);
  if (newMeta && Number(newMeta.messageCount) > 0) {
    return { migrated: false, reason: 'NEW_KEY_HAS_HISTORY' };
  }

  // Legacy single-account history present?
  const legacy = persistence.restoreSession(legacyKey);
  if (!legacy || !Array.isArray(legacy.messages) || legacy.messages.length === 0) {
    return { migrated: false, reason: 'NO_LEGACY_HISTORY' };
  }

  // Copy the legacy transcript under the new account-scoped key (one-time).
  persistence.persistSession(newKey, {
    messages: legacy.messages,
    title: legacy.title || '',
    model: legacy.model || '',
    metadata: legacy.metadata && typeof legacy.metadata === 'object' ? legacy.metadata : {},
  });
  return { migrated: true, reason: 'MIGRATED' };
}

/** 草稿到期回执。措辞必须说清「过期」且「没发」—— 静默作废会让人一直等。 */
const DRAFT_EXPIRED_NOTICE = '上一条草稿已过期(未发送)。请重新发一次你的指令。';

/**
 * 绑定码自助发放关闭时的唯一回执。
 *
 * 措辞纪律（RUNTIME-002）：必须说清**没做**什么 + **去哪儿做**。不能写「功能不可用」
 * 这种含糊话，也不能给替代路径的暗示 —— 这里给的就是本机终端。
 */
const QR_SELF_SERVE_OFF_NOTICE =
  '绑定码不在微信里发放：请在本机终端运行 khy wx login，二维码只显示在你的终端，不经过任何聊天转发。';

class IlinkDispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.channel IlinkChannel(用于发回复与 typing)
   * @param {Function} [opts.getChat] 注入 chat 解析器(测试用)
   * @param {Function} [opts.getPersistence] 注入 sessionPersistence 解析器(测试用)
   * @param {Function} [opts.getBindingStore] 注入 ilinkBindingStore 解析器(测试用)
   * @param {Function} [opts.getWorkspaceRouter] 注入工作空间路由器解析器(测试用)
   * @param {Function} [opts.getAccountStore] 注入 ilinkAccountStore 解析器(测试用,
   *        隐式允许层要读账号记录里的 userId)
   * @param {string} [opts.accountId] 归属账号 id,用于按 dmScope 构造会话键
   */
  constructor(opts = {}) {
    this.channel = opts.channel;
    this._getChat = opts.getChat;
    this._getPersistence = opts.getPersistence;
    this._getBindingStore = opts.getBindingStore;
    this._getWorkspaceRouter = opts.getWorkspaceRouter;
    this._getAccountStore = opts.getAccountStore;
    this.accountId = String(opts.accountId || '');
    /** @type {Array<{msg:object, resolve:Function}>} 串行队列 */
    this._queue = [];
    this._running = false;
    /** 正在等权限回复的 resolver(单槽:串行队列保证同时只有一个查询在跑)。 */
    this._pendingPermission = null;
    this._warnedNoChat = false;
    this._warnedNoToolLoop = false;
    /**
     * 未列名发送者的告警计数(按 accountId|userId)。
     * **只给模板串计数用**;阶段 2 的前置数据(带 loginUserId 的结构化元数据)每次都发,
     * 不受这个窗口影响 —— 降噪不能把观测数据一起降没了。
     * @type {Map<string,{count:number, since:number}>}
     */
    this._allowWarnCounts = new Map();
    /**
     * 待批出站草稿(按发送者分桶)。KHY_ILINK_DRAFT_CONFIRM=0 时整条通道不启用,
     * 队列保持 null,所有分支照旧直发 —— 逃生阀必须是「回到旧行为」而不是「近似直发」。
     * @type {ReplyDraftQueue|null}
     */
    this._draftQueue =
      defaults.ILINK_DRAFT_CONFIRM === false
        ? null
        : new ReplyDraftQueue({ ttlMs: defaults.ILINK_DRAFT_TTL_MS, max: defaults.ILINK_DRAFT_MAX });
    /**
     * 草稿过期后的迟到答复宽限期。**独立于 _graceUntil**:
     *   · 消费判据不同(_graceUntil 只认 y/n,迟到的「发」会一路穿过它被当新 prompt
     *     丢给模型 —— 那正是它注释要防的事);
     *   · 共用一个标量的话,草稿到期会踩掉权限的宽限窗口,反之亦然。
     * @type {number}
     */
    this._draftGraceUntil = 0;
    /**
     * 宽限窗口内「刚被清掉草稿」的发送者。迟到答复只对这些 id 生效 ——
     * 过期之后队列里已经没有条目,判定依据只能是清条目的那一刻记下的作者。
     * @type {Set<string>}
     */
    this._draftLateOwners = new Set();
    /**
     * 本实例内选了「直发」的发送者(/draft off 开的)。**只在本实例有效,重启即失效**
     * —— 逃生阀不该比它保护的东西活得更久。
     * @type {Set<string>}
     */
    this._draftDirectUsers = new Set();
  }

  /**
   * 把本实例的运行时状态打包给诊断簇。
   *
   * 显式传 state（而不是把 `this` 整个递过去）是有意的：诊断模块只应看到它真正
   * 需要读的东西。这样它在编译期就不可能写到本类的任何私有字段，职责边界由**参数形状**
   * 保证，而不是靠注释约定。
   *
   * `userId` 是**提问者**，不是「全体」。草稿读数只算他一个人（见 `_draftStatsFor`）：
   * state 会被 /wx、/status 原样渲染给当前发送者，全量 owners 等于把同 bot 其他人的
   * 标识符报给一个无权知道它的人（复核员实测 uA 从 /wx 看到「待批发送者:uB」）。
   * 少报是安全方向，故这里**不提供**全量路径 —— 要全量走 `toJSON`。
   *
   * @param {string} [userId] 提问者 id；缺省按「无此人」读，草稿位恒 0（fail-closed）
   * @returns {{channel:object, queueLength:number, running:boolean,
   *            allowMode:object, peerCount:number,
   *            pendingDrafts:number, draftOwners:string[], draftDirect:boolean}}
   */
  _diagState(userId) {
    let allowMode = { strict: false, label: '' };
    let peerCount = 0;
    try {
      allowMode = _allowlist().allowMode();
      peerCount = _allowlist().peerCount();
    } catch {
      /* fail-soft：诊断面绝不因为读不到名单就崩 */
    }
    const draft = this._draftStatsFor(userId);
    return {
      channel: this.channel,
      queueLength: this._queue.length,
      running: this._running,
      allowMode,
      peerCount,
      pendingDrafts: draft.total,
      draftOwners: draft.owners,
      // 直发档同样要报出来:「我没看到草稿」有两种可能——没有草稿,或根本没开草稿,
      // 只报前者会让人以为确认机制在工作。
      draftDirect: !this._draftQueue,
    };
  }

  /**
   * 草稿读数(**全量,进程内**)。**只给计数与发送者 id,永不含草稿正文** ——
   * 正文是用户的私有内容。
   *
   * 消费者只有 `toJSON()` 与进程内日志。**凡是会渲染成发给微信用户的文本,一律不许
   * 调这个**,走 `_draftStatsFor`。
   * @returns {{total:number, owners:string[]}}
   */
  _draftStats() {
    try {
      return this._draftQueue ? this._draftQueue.stats() : { total: 0, owners: [] };
    } catch {
      return { total: 0, owners: [] };
    }
  }

  /**
   * 草稿读数(**作者视角**)。形状与 `_draftStats()` 逐字相同,这样诊断模块一行都不用改 ——
   * 隔离责任全落在**生产点**,而不是渲染点过滤(后者最容易漏:新加一个渲染函数就绕过去了)。
   *
   * owners 只会是 `[userId]` 或 `[]`:草稿按作者分桶,别人的桶既不计数也不进 owners,
   * 所以收件人无从推断还有谁在用这个 bot。
   *
   * @param {string} userId 读者自己;null/undefined 归一成空键 = 「无此人」= 恒 0 条,
   *   这是 fail-closed:漏传调用点会安静地少报,而不是多报。
   * @returns {{total:number, owners:string[]}}
   */
  _draftStatsFor(userId) {
    try {
      if (!this._draftQueue) {
        return { total: 0, owners: [] };
      }
      const total = this._draftQueue.pendingCount(userId);
      return { total, owners: total ? [String(userId == null ? '' : userId)] : [] };
    } catch {
      return { total: 0, owners: [] };
    }
  }

  /**
   * 入站发送者是否放行。
   *
   * 返回 true = 继续处理；false = 调用方必须就此终止本条消息。
   *
   * 逃生层 ILINK_ALLOW_UNLISTED 默认**关**（严格档）：未列名者直接拒答。要临时放回
   * 观察期必须显式 KHY_ILINK_ALLOW_UNLISTED=1（或 khy wx allow env on）。
   *
   * 无论哪一档，**未列名者每次都记一条带 loginUserId 的结构化 warn**。这条不是阶段 1
   * 的遗留：它现在落在拒答路径上，是发现「主人被误关在门外」的唯一手段 —— 出了这种
   * 事故，日志里那对 loginUserId / userId 就是直接证据。删掉它等于把现场抹了。
   *
   * @param {object} msg
   * @returns {Promise<boolean>}
   */
  async _isAllowedSender(msg) {
    const allow = _allowlist();
    if (!allow) {
      // 名单模块取不到 → 按「未列名」处理，而不是默默放行。
      await this._say(msg, '发送者允许名单读取失败,这条没有交给 agent。请检查守护进程日志。');
      return false;
    }
    const userId = String(msg.userId || '');
    const accountStore = this._resolveAccountStore();
    const opts = accountStore ? { accountStore } : {};
    const loginUserId = allow.accountLoginUserId(this.accountId, opts);
    if (allow.isPeerAllowed(this.accountId, userId, opts)) {
      return true;
    }
    const mode = allow.allowMode();
    this._noteUnlistedSender(userId, loginUserId, msg.messageId, mode.strict);
    // 档位判定只走 allowMode() —— 与三个展示面读的是同一个函数。直接读
    // defaults.ILINK_ALLOW_UNLISTED 的真假值会在「常量缺失」时与档位标签分叉。
    if (!mode.strict) {
      return true;
    }
    await this._say(
      msg,
      `你的微信 ID ${userId} 不在本实例允许名单内,这条没有交给 agent。放行:khy wx allow add ${userId}`
    );
    return false;
  }

  /**
   * 记一条「未列名发送者」。**两条日志分开打**：
   *   · 结构化元数据(每次都发) —— 现在落在拒答路径上,是发现「主人被误关在门外」的
   *     唯一证据。少一条,那种事故就查不下去。
   *     必须传**单个对象**:winston 只把最后一个对象参数当 meta,字符串进 splat 后
   *     根本不会出现在 console/文件 transport 里(实测 `log.warn('m','a','b',1)` 三个
   *     标识符全部消失)。元数据里只有标识符、**没有正文** —— 正文是攻击者可控的,
   *     落盘即二次风险。
   *   · 模板串聚合计数(每窗口一条) —— 只为降噪,按 (accountId,userId) 计数。
   * @param {string} userId 入站发送者
   * @param {string} loginUserId 账号记录里的 userId(可能为空)
   * @param {number|null} messageId
   * @param {boolean} strict 当前是否为严格档(措辞要如实反映这一条到底放没放)
   */
  _noteUnlistedSender(userId, loginUserId, messageId, strict) {
    const key = `${this.accountId}|${userId}`;
    const now = Date.now();
    const windowMs = Number(defaults.ILINK_ALLOW_WARN_WINDOW_MS) || 600000;
    const prev = this._allowWarnCounts.get(key);
    if (!prev || now - prev.since >= windowMs) {
      // 发送者 id 来自入站报文(攻击者可控)。超量直接清空整表,不给「用假 id 撑爆内存」
      // 留口子;下一条自然会重新建表。
      if (this._allowWarnCounts.size > 256) {
        this._allowWarnCounts.clear();
      }
      this._allowWarnCounts.set(key, { count: 1, since: now });
      log.warn(
        `ilink: 账号 ${this.accountId} 出现未列名发送者 ${userId}` +
          `(登录 userId:${loginUserId || '(无记录)'},消息 ${messageId}),${strict ? '已拒答' : '观察期放行'}`
      );
    } else {
      prev.count += 1;
      log.warn(
        `ilink: 账号 ${this.accountId} 的未列名发送者 ${userId} 已连续触发 ${prev.count} 次` +
          (strict ? '(均已拒答)' : '(仍在放行,收紧:khy wx allow env off)')
      );
    }
    log.warn('ilink: 发送者未在允许名单内', {
      accountId: this.accountId,
      userId,
      loginUserId,
      messageId: messageId == null ? null : messageId,
    });
  }

  /**
   * messageRouter 的 per-channel handler 入口。
   * @param {object} msg 已由 ilinkCore.parseInboundMessage 归一
   * @returns {Promise<void>}
   */
  async handle(msg) {
    if (!msg || !msg.userId) {
      return;
    }

    // ⓪ 发送者准入。位置是硬约束：**必须在 context-token 落盘与权限回复插队之前**。
    //   上下文 token 落盘在前等于替未列名者开通了「主动向他发消息」的通道；
    //   权限回复插队在前则一条 "y" 就能放行正在跑的工具（那条 y 必须来自列名者）。
    if (!(await this._isAllowedSender(msg))) {
      return;
    }

    // 清掉已过期的草稿:回执作者 + 记下宽限窗口的作者集合。放在任何草稿判定之前,
    // 迟到的那条「发」才来得及被宽限分支吞掉而不是掉进普通流程。
    this._sweepDrafts();

    // 持久化本轮入站的 context-token(msg.threadId 即 context_token,见 parseInboundMessage),
    // 供后续主动发送(如发绑定二维码)在无 threadId 时 fallback 取用。
    // fail-soft:存不进去只是少一个 fallback,绝不影响入站处理。
    if (this.accountId && msg.threadId) {
      try {
        require('../messaging/ilinkAccountStore').setContextToken(
          this.accountId,
          msg.userId,
          msg.threadId
        );
      } catch {
        /* fail-soft */
      }
    }

    // ① 权限回复插队:必须在入队之前判,否则它会排在自己要放行的那个查询后面。
    if (this._pendingPermission) {
      const verdict = core.parsePermissionReply(msg.text);
      if (verdict) {
        const p = this._pendingPermission;
        this._pendingPermission = null;
        p.resolve(verdict);
        return;
      }
    }

    // ② 超时宽限期:审批已超时后才发来的 y/n 要吞掉,不能当成新 prompt 丢给模型
    //    (否则用户会看到 agent 认真回答「y」是什么意思)。
    if (this._graceUntil && Date.now() < this._graceUntil && core.parsePermissionReply(msg.text)) {
      this._graceUntil = 0;
      await this._say(msg, '上一个授权请求已超时(已自动拒绝)。请重新发一次你的指令。');
      return;
    }

    // ②½ 草稿:**先按发送者取本发送者的待批草稿**。
    //     作者绑定是硬约束:队列会积压、可来自同一账号下的多个 peer,拿 FIFO 队首
    //     就等于让 peer B 的一个「发」放行 peer A 从未批准的私有内容(或把 A 的正文发进
    //     B 的会话)。
    //     关键:不匹配时**必须 fall through 而不是丢弃** —— B 的「发」照常当普通 prompt
    //     进 agent(B 不会莫名少一条消息),A 的草稿纹丝不动。
    const mineDraft = this._draftQueue && this._draftQueue.pending(msg.userId);
    const draftVerdict = mineDraft ? core.parseDraftReply(msg.text) : null;
    if (mineDraft && draftVerdict) {
      await this._settleDraft(msg, mineDraft, draftVerdict);
      return;
    }

    // ②¾ 迟到的答复(草稿已过期)。**作者判定仍然是硬的**,而且要求此刻**没有**待批草稿:
    //     上一次草稿过期后的宽限窗口内,用户可能已经攒下了新草稿,那时的「发」是新草稿的
    //     批准,不能被旧窗口吞掉。作者集合与窗口都由 _sweepDrafts 在清条目那一刻写下。
    if (this._draftQueue && this._draftGraceUntil) {
      if (Date.now() >= this._draftGraceUntil) {
        this._draftGraceUntil = 0;
        this._draftLateOwners.clear();
      } else if (!mineDraft && this._draftLateOwners.has(String(msg.userId || ''))) {
        if (core.parseDraftReply(msg.text)) {
          this._draftGraceUntil = 0;
          this._draftLateOwners.clear();
          await this._say(msg, DRAFT_EXPIRED_NOTICE);
          return;
        }
      }
    }

    // ③ 空文本(纯图片/语音等)在阶段 4 之前先如实告知,不静默丢。
    if (!msg.text) {
      if (msg.unsupported && msg.unsupported.length) {
        await this._say(msg, `暂不支持${msg.unsupported.join('、')}消息,请改用文字。`);
      } else if (msg.images && msg.images.length) {
        await this._say(msg, '收到图片,但图片理解尚未接通(即将支持)。请先用文字描述。');
      }
      return;
    }

    // ④ 斜杠命令:在进 agent 之前拦截。不进队列(都是即时操作,不跑模型),
    //    /clear 与 /reset **永远可执行** —— 参考实现把它们在「忙」时挡掉,
    //    结果进程崩在查询中途后唯一的逃生口也没了,只能手删 JSON。
    const cmd = core.parseSlashCommand(msg.text);
    if (cmd) {
      await this._runSlash(msg, cmd);
      return;
    }

    // ⑤½ 「发我二维码」这类自然语言**不再有直达发码的分支**。
    //    原来这里在任何 agent 判断之前就把码发出去 —— 整个洞就是这一段。
    //    现在它与 /qr 一样统一收口到 _sendBindQrCode：默认关（ILINK_QR_SELF_SERVE），
    //    关时只回一句「去终端跑 khy wx login」。

    // ⑤ 排队(串行)。队列有上限,避免有人连发几十条把内存和 token 都撑爆。

    if (this._queue.length >= 10) {
      await this._say(msg, '排队的消息太多了,这条先丢掉。等我把前面的处理完再发。');
      return;
    }
    this._queue.push(msg);
    if (this._queue.length > 1 || this._running) {
      await this._say(msg, `正在处理前一条,你这条排在第 ${this._queue.length} 位。`);
    }
    await this._drain();
  }

  /**
   * 执行斜杠命令。全部 fail-soft:任何异常都变成一句发得出去的中文。
   * @param {object} msg
   * @param {{cmd:string, args:string}} cmd
   */
  async _runSlash(msg, cmd) {
    try {
      const out = await this._slashResult(msg, cmd);
      await this._say(msg, out);
    } catch (err) {
      await this._say(msg, `⚠ /${cmd.cmd} 执行出错:${(err && err.message) || err}`);
    }
  }

  /** @returns {Promise<string>} 要发回微信的文本 */
  async _slashResult(msg, cmd) {
    switch (cmd.cmd) {
      case 'help':
      case '?':
        return [
          '可用命令:',
          '/wx      — 连接健康(通道/心跳/会话/游标)',
          '/status  — 当前真实路由(通道/模型)与通道状态',
          '/model   — 当前实际在用的模型',
          '/models  — 列出已连通的通道',
          '/ping    — 看我还在不在',
          '/clear   — 清空对话历史(随时可用)',
          '/reset   — 同 /clear',
          '/queue   — 查看排队情况',
          '/draft   — 出站草稿档位(on=逐条批准 / off=直发)',
          '/version — khy 版本',
          '',
          '直接发文字即可对话;需要授权时回 y 允许、n 拒绝。',
          '草稿态下回复只出预览,回「发」发出、「撤」丢弃、「改 <新内容>」换一稿。',
          '绑定码只在终端申请:khy wx login。二维码不经过聊天转发。',
          'SendUserFile 在微信上会真的把文件发出去,凭据/密钥类路径一律拒发(含符号链接指向的)。',
        ].join('\n');

      case 'wx':
      case 'conn':
      case 'connection':
        return this._describeConnection(msg.userId);

      case 'ping':
        return '在。';

      case 'status':
        return this._describeRoute(true, msg.userId);

      case 'model':
        return this._describeRoute(false, msg.userId);

      case 'models':
        return this._listAdapters();

      case 'clear':
      case 'reset':
      case 'new': {
        // 永远可执行 —— 这是卡死时唯一的逃生口,绝不因为「忙」而挡掉。
        try {
          _resolveSessionControl('getClearHistory')();
          // 队列是**全账号共享**的串行队列,别人的入站消息同样在里面。收窄成按发送者
          // 过滤会给这个逃生口引入新的死锁面,所以保持整队清空 —— 但回执必须说清它对谁
          // 生效,并留一条结构化 warn:被丢的人收不到任何提示,事后只能靠日志查。
          const droppedMsgs = this._queue.splice(0, this._queue.length);
          const cleared = this._draftQueue ? this._draftQueue.clear(msg.userId) : 0;
          if (droppedMsgs.length) {
            log.warn(
              `ilink: 账号 ${this.accountId} 的 /clear 清空了共享排队队列,${droppedMsgs.length} 条入站消息未发送也未回复`,
              {
                accountId: this.accountId,
                count: droppedMsgs.length,
                clearedBy: String(msg.userId || ''),
                // 只有标识符,没有消息正文 —— 正文是用户的私有内容,不入日志。
                senders: Array.from(new Set(droppedMsgs.map((m) => String((m && m.userId) || '')))),
              }
            );
          }
          return [
            '已清空对话历史(只影响你与我的这一段对话)。',
            droppedMsgs.length
              ? `排队队列是全账号共享的,本次一并清空:其中 ${droppedMsgs.length} 条(含他人排队的消息)未发送也未回复。`
              : '排队队列本次一并清空,当时没有排队消息。',
            cleared ? `你的待批草稿清了 ${cleared} 条(未发送)。` : '你名下没有待批草稿。',
          ].join('');
        } catch (e) {
          return `⚠ 清空失败:${(e && e.message) || e}`;
        }
      }

      case 'queue':
        return this._describeQueue(msg.userId);

      case 'draft':
        return this._describeDraftMode(msg, cmd.args);

      case 'qr':
      case 'bind':
      case '二维码':
        // 闸门在 _sendBindQrCode 自己入口(默认关、且要求发送者在允许名单内),
        // 这里不重复判。多步异步自己发完,返回空串让 _runSlash 的 _say 不叠发。
        await this._sendBindQrCode(msg);
        return '';

      case 'version':
        try {
          return `khy ${require('../../../../../package.json').version}`;
        } catch {
          return 'khy(版本未知)';
        }

      default:
        return `未知命令:/${cmd.cmd}。发 /help 看可用命令。`;
    }
  }

  /**
   * 队列诊断。**必须报出待批草稿**:草稿会静默过期(每发送者上限 N 条),用户卡着等下一句
   * 话时如果 /queue 只显示「队列空闲」,他就无从判断自己的回复去了哪儿。
   * 0 条时**不加**那一段 —— 不制造噪音。
   *
   * 草稿段只算 `userId` 自己:「发送者:」那一行在作者视角下恒等于「你自己」,保留了
   * 是为了让人确认「这确实是等我批的那条」;若这里报全量 owners,uA 就能从 /queue 读出
   * 「还有 uB、uC 在用这个 bot」——与草稿正文无关的标识符泄露(复核员实测)。
   *
   * @param {string} [userId] 提问者;缺省按「无此人」= 0 条(fail-closed)
   * @returns {string}
   */
  _describeQueue(userId) {
    const draft = this._draftStatsFor(userId);
    return (
      `队列:${this._queue.length} 条等待中${this._running ? '(有一条正在处理)' : ''}` +
      `${this._pendingPermission ? ',正在等你的授权回复' : ''}` +
      `${draft.total ? `,${draft.total} 条草稿待你批准(发送者:${draft.owners.join('/')})` : ''}。`
    );
  }

  /**
   * `/draft [on|off|status]` —— 出站草稿档位。
   *
   * 档位必须在这里说出来(规则 2):「我没看到草稿」有三种可能——回复太短、已过期、
   * 或者档位是直发。不报档位,用户只能去猜第三条。
   * @param {object} msg
   * @param {string} args
   * @returns {string}
   */
  _describeDraftMode(msg, args) {
    const verb = String(args || '').trim().toLowerCase();
    if (!this._draftQueue) {
      return (
        '出站草稿确认已被 KHY_ILINK_DRAFT_CONFIRM=0 关掉(当前是直发:回复直接发出)。' +
        '改配置并重启守护进程:khy wx start。'
      );
    }
    const userId = String(msg.userId || '');
    if (verb === 'on' || verb === 'off') {
      const direct = verb === 'off';
      if (direct) {
        this._draftDirectUsers.add(userId);
      } else {
        this._draftDirectUsers.delete(userId);
      }
      return direct
        ? '✓ 你的回复改为直接发出(不再逐条等你批准)。只影响你自己,且重启守护进程后失效。发 /draft on 可恢复。'
        : '✓ 已恢复逐条批准:每轮回复只出预览,回「发」才发出。发 /draft off 可恢复直发。';
    }
    if (verb && verb !== 'status') {
      return `未知参数:/draft ${verb}。可用:/draft on、/draft off、/draft(不带参数看当前档位)。`;
    }
    return (
      `草稿档位:${this._draftActiveFor(userId) ? '逐条批准(草稿态)' : '直发(你已用 /draft off 关掉草稿)'}` +
      `。${defaults.ILINK_DRAFT_TTL_MS} 秒内没批准就作废,不会自动发。`
    );
  }

  /**
   * 连接健康。回答的是「这条链路本身好不好」,而不是「模型是谁」(那是 /status)。
   *
   * 注意能收到这条命令本身就说明入站是通的 —— 所以真正有信息量的是**出站以外**的东西:
   * 心跳有多新、会话有没有过期、游标在不在、连续失败了多少次。
   */
  /**
   * 「连接健康」自述。实现在 ilinkDispatchDiagnostics（纯文本渲染职责簇）。
   *
   * @param {string} [userId] 提问者;缺省草稿位恒 0(fail-closed)
   * @returns {string}
   */
  _describeConnection(userId) {
    return _diag.describeConnection(this._diagState(userId));
  }

  /**
   * 报告路由。**严格区分「已证实」与「只是配置」**（口径详解见诊断模块）。
   *
   * `userId` 目前不参与路由渲染,但 state 是同一个生产点 —— 透传它,是为了让「诊断 state
   * 一律按提问者视角生产」这条纪律没有例外分支可躲(漏传的代价见 `_diagState`)。
   *
   * @param {boolean} full 是否附带通道/队列状态
   * @param {string} [userId] 提问者;缺省草稿位恒 0(fail-closed)
   * @returns {string}
   */
  _describeRoute(full, userId) {
    return _diag.describeRoute(this._diagState(userId), full);
  }

  /** 列出已连通的通道。 */
  _listAdapters() {
    return _diag.listAdapters();
  }

  /** 串行消费队列。 */
  async _drain() {
    if (this._running) {
      return;
    }
    this._running = true;
    try {
      while (this._queue.length) {
        const msg = this._queue.shift();
        try {
          await this._runQuery(msg);
        } catch (err) {
          log.warn(`ilink dispatcher 处理失败:${(err && err.message) || err}`);
          await this._say(msg, `⚠ 处理出错了:${(err && err.message) || '未知错误'}`);
        }
      }
    } finally {
      this._running = false;
    }
  }

  /** 跑一次 agent 查询,期间维持「正在输入」并把权限审批引到微信。 */
  async _runQuery(msg) {
    const chat = _resolveChat({ getChat: this._getChat });
    if (!chat) {
      if (!this._warnedNoChat) {
        this._warnedNoChat = true;
        log.warn('ilink: AI 内核未就绪(headless?),入站消息已解析但无法回答');
      }
      await this._say(
        msg,
        '⚠ AI 内核未就绪,暂时无法回答。请确认守护进程已启动:khy daemon start。'
      );
      return;
    }

    const stopTyping = this._startTyping(msg);
    try {
      // 全局串行锁:进程内任一时刻只允许一个 agent 查询在跑,跨所有账号 dispatcher 共享
      // (见 ilinkExecutionLock)。scopeSession(在 _chatWithWatchdog 内)与权限 prompter 都是
      // 进程级单例态,故二者的读写都必须在锁内,才不会被并发账号互相污染。
      // 权限等待(等用户回 y/n)发生在锁内属预期:一次查询连同其审批是不可分割的执行单元;
      // y/n 回复经 handle() 直达 _pendingPermission.resolver —— 它不入队、也不抢这把锁(handle
      // 是 fire-and-forget 派发进来的),所以锁持有者 await 审批 promise 不会死锁。
      const out = await require('./ilinkExecutionLock').runExclusive(async () => {
        // 策略二——执行期工作空间路由:若本账号有绑定,在本次已全局串行的时间片内
        // 把进程级 cwd/agent 切到目标 workspace/agent。必须在锁内切、锁内恢复:
        // runExclusive 保证同一时刻只有一个查询在跑,故进程级状态不会与另一账号交叠
        // (与 chat() 不可重入约束一致,绝不引入并发独立 agent)。放在 scopeSession/迁移
        // 之前,确保本次查询确实在目标 workspace 下执行且会话元数据记对 cwd。
        const restoreWorkspace = this._applyBindingRouting();
        const restorePermission = this._installPermissionBridge(msg);
        try {
          return await this._chatWithWatchdog(chat, msg);
        } finally {
          restorePermission();
          // 即使 chat 抛错也要还原 cwd/agent——恢复与切换成对,都在锁内。
          restoreWorkspace();
        }
      });
      let reply = normalizeReply(out);
      // 草稿态必须换占位语:图**还没发**,说「已发送」是当着人的面撒谎(规则 2)。
      const drafting = this._draftActiveFor(msg.userId);
      reply = _sanitizeGeneratedImageReply(
        reply,
        out,
        drafting ? { pendingLabel: '（图片待你批准后发送）' } : {}
      );
      if (drafting) {
        // 草稿态:正文与文件都**不外发**,只登记等批准。登记不等待 —— turn 在这里就结束,
        // stopTyping 照常在 finally 跑,typing 不会因为等批准而长时间挂着。
        await this._offerDraft(msg, out, reply);
      } else {
        // 先投递本轮工具产出的文件,再发文本回复。内部 fail-soft,
        // 绝不因发文件失败而影响后面的文本回复。
        await this._deliverFiles(msg, out);
        await this._say(msg, reply || '(没有产生可发送的回答)');
      }
      // 断点续接「写」侧修复:微信路从不触发 clearHistory/eofExit,自动检查点
      // (maybeAutoCheckpointProgress)只在那些路径被调 → PROGRESS.md 永不落盘 →
      // 「学完记不住学到哪」。这里在每轮成功收尾后补一次(叶子自带三道门槛:
      // 门控/已手写跳过/实质轮次+学习信号,误触发率极低)。fail-soft。
      this._maybeAutoCheckpointTurn(msg);
    } finally {
      stopTyping();
    }
  }

  /**
   * 投递本轮工具链产出的文件到微信(SendUserFile 的结果)。
   *
   * 实现在 ilinkFileDelivery —— 那段代码的失败矩阵密集（超限 / 发送失败 / 读取异常 /
   * 顶层兜底），且铁律是「整体 fail-soft，绝不影响后续文本回复」，值得独立焦点。
   *
   * @param {object} msg 入站消息
   * @param {*} out _chatWithWatchdog 的返回
   */
  async _deliverFiles(msg, out) {
    return _delivery.deliverFiles({
      msg,
      out,
      channel: this.channel,
      say: (m, text) => this._say(m, text),
      isImageFile: _isImageFile,
      defaults,
      log,
    });
  }

  /**
   * 这条消息的回复要不要走草稿。三个档位,任何一个取不到都按「要草稿」处理 ——
   * 安全方向只有一个:拿不准就不发。
   * @param {string} userId
   * @returns {boolean}
   */
  _draftActiveFor(userId) {
    if (!this._draftQueue) {
      return false;
    }
    return !this._draftDirectUsers.has(String(userId == null ? '' : userId));
  }

  /**
   * 清掉已过期的草稿并逐条回执。**只清不送** —— 没人看过的东西不替他发出去。
   *
   * 顺带把「刚被清的作者」记进宽限窗口:过期之后队列里已无条目,迟到的「发」只能靠
   * 这个集合判定是不是答复;不带作者判定的话,别人一句「发」也会被吞掉。
   * @returns {number} 清掉几条
   */
  _sweepDrafts() {
    if (!this._draftQueue) {
      return 0;
    }
    const expired = this._draftQueue.expire();
    if (!expired.length) {
      return 0;
    }
    this._draftGraceUntil = Date.now() + defaults.ILINK_DRAFT_GRACE_MS;
    for (const d of expired) {
      this._draftLateOwners.add(String((d.msg && d.msg.userId) || ''));
      this._say(d.msg, DRAFT_EXPIRED_NOTICE).catch(() => {});
    }
    log.warn(
      `ilink: 账号 ${this.accountId} 有 ${expired.length} 条草稿过期(未发送),已通知作者`,
      {
        accountId: this.accountId,
        count: expired.length,
        // 只有标识符,没有草稿正文 —— 正文是用户的私有内容,不入日志。
        owners: Array.from(new Set(expired.map((d) => (d.msg && d.msg.userId) || ''))),
      }
    );
    return expired.length;
  }

  /**
   * 登记一条待批草稿并把预览发回给作者。**只登记不等待** —— turn 到此为止。
   *
   * @param {object} msg 本轮入站消息(作者本人)
   * @param {*} out _chatWithWatchdog 的返回(读 toolCallLog)
   * @param {string|null} reply 正文
   */
  async _offerDraft(msg, out, reply) {
    const body = reply || '(没有产生可发送的回答)';
    const fileItems = await this._draftFileItems(out);
    const preview = this._renderDraftPreview(body, fileItems);
    const { dropped } = this._draftQueue.push(msg.userId, {
      msg,
      text: body,
      files: out && Array.isArray(out.toolCallLog) ? out.toolCallLog : [],
      fileItems,
      preview,
    });
    if (dropped) {
      await this._say(
        dropped.msg,
        `你之前还有一条草稿没批,已达上限 ${defaults.ILINK_DRAFT_MAX} 条,最旧的那条已被丢弃(未发送)。`
      );
    }
    await this._say(msg, preview);
  }

  /**
   * 处理一条草稿裁决。
   *
   * 投递顺序:**先文件后正文** —— 草稿下文件必须跟着批准一起走;先发文件等于
   * 草稿没挡住(文件本身就是最敏感的那部分)。
   *
   * @param {object} msg 审批消息(与 draft 同属一个发送者,已在调用方判定过)
   * @param {object} draft 待批草稿
   * @param {'send'|'drop'|{edit:string}} verdict
   */
  async _settleDraft(msg, draft, verdict) {
    const userId = String(msg.userId || '');
    if (verdict === 'send') {
      this._draftQueue.resolve(userId);
      await this._deliverDraft(draft);
      await this._say(msg, '✓ 已发出。以后想直接发,在微信里发 /draft off。');
      return;
    }
    if (verdict === 'drop') {
      this._draftQueue.resolve(userId);
      await this._say(msg, '已丢弃,这条没有发出去。');
      return;
    }
    // 改:旧稿**绝不外发**,正文换掉重开一稿。先 resolve 再 push,否则新稿排到队尾,
    // 用户批的仍是那条旧的。
    this._draftQueue.resolve(userId);
    const preview = this._renderDraftPreview(verdict.edit, draft.fileItems);
    this._draftQueue.push(userId, {
      msg,
      text: verdict.edit,
      files: draft.files,
      fileItems: draft.fileItems,
      preview,
    });
    await this._say(msg, `已按你的新内容重开一稿,回「发」才发出。\n\n${preview}`);
  }

  /** 投递一条已批准的草稿:文件在前,正文在后。 */
  async _deliverDraft(draft) {
    await this._deliverFiles(draft.msg, { toolCallLog: draft.files });
    await this._say(draft.msg, draft.text);
  }

  /** @param {string} text @param {Array<{name:string,bytes?:number}>} fileItems */
  _renderDraftPreview(text, fileItems) {
    return core.formatDraftPreview(text, fileItems, {
      maxChars: defaults.ILINK_DRAFT_PREVIEW_CHARS,
      ttlMs: defaults.ILINK_DRAFT_TTL_MS,
      hintTurnOff: true,
    });
  }

  /**
   * 从 toolCallLog 里取出待发文件的展示项:{ name, bytes }。
   *
   * **只给 basename + 大小,永不给本地绝对路径** —— 多 peer 场景下「哪个发送者能拿到
   * 本机哪个文件」本身就是信息。stat 拿不到字节数就留空(预览里显示「大小未知」),
   * 绝不让一次 stat 失败把整条草稿吞掉。
   * @param {*} out
   * @returns {Promise<Array<{name:string, bytes:number|null}>>}
   */
  async _draftFileItems(out) {
    const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : [];
    const items = [];
    for (const entry of logArr) {
      if (!entry || entry.tool !== 'SendUserFile' || !entry.result || entry.result.success !== true) {
        continue;
      }
      const filePath = entry.result.file || entry.result.file_path;
      if (!filePath) {
        continue;
      }
      let bytes = null;
      try {
        const st = await fs.promises.stat(filePath);
        bytes = st.size;
      } catch {
        /* 取不到大小不影响草稿本身 */
      }
      items.push({ name: path.basename(String(filePath)), bytes });
    }
    return items;
  }

  /**
   * 微信通道的「会话结束自动检查点」安全网(断点续接写侧)。
   * 只在有实质回复后触发;主题锚点按用户隔离(微信无 cwd 概念,进程 cwd 是
   * 家目录,直接用它会把所有微信用户的学习进度混成一条)。绝不抛。
   * @param {object} msg
   */
  _maybeAutoCheckpointTurn(msg) {
    try {
      const maybeCheckpoint = _resolveSessionControl('getMaybeAutoCheckpointProgress');
      const userId = String((msg && msg.userId) || '').trim();
      // 主题锚点:微信-<userId 前 8 位>,避免多用户共用一条主题、也避免用家目录名。
      const anchor = userId ? `微信-${userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8)}` : '微信';
      maybeCheckpoint('ilinkTurn', anchor);
    } catch {
      /* best effort —— CLI 未加载或 hook 不可用都静默跳过 */
    }
  }

  /**
   * 取会话持久化模块。显式注入优先(测试桩);未注入时惰性加载真实模块。
   * 取不到返回 null,迁移路径自行降级为 no-op(fail-soft)。
   * @returns {object|null}
   */
  _resolvePersistence() {
    if (typeof this._getPersistence === 'function') {
      try {
        const p = this._getPersistence();
        return p || null;
      } catch {
        return null;
      }
    }
    try {
      return require('../../../sessionPersistence');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the ilink binding store. Injection wins (test stub); otherwise lazy
   * require the real module. Unresolvable → null (routing degrades to no-op).
   * @returns {object|null}
   */
  _resolveBindingStore() {
    if (typeof this._getBindingStore === 'function') {
      try {
        return this._getBindingStore() || null;
      } catch {
        return null;
      }
    }
    try {
      return require('../messaging/ilinkBindingStore');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the account store (implicit allow layer reads its userId). Injection
   * wins (test stub); otherwise lazy require. Unresolvable → null (the implicit
   * layer simply does not match, and the caller keeps its fail-soft behaviour).
   * @returns {object|null}
   */
  _resolveAccountStore() {
    if (typeof this._getAccountStore === 'function') {
      try {
        return this._getAccountStore() || null;
      } catch {
        return null;
      }
    }
    try {
      return require('../messaging/ilinkAccountStore');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the workspace router that performs the process-level cwd + agent
   * switch. Injection wins (test stub); otherwise a default router wrapping the
   * two real, verified primitives:
   *   - cwd:   worktreeSessionCwd.switchToolCwd(dir) — syncs BOTH the tools'
   *            authoritative KHYQUANT_CWD env source AND process.chdir. There is
   *            NO chatOpts cwd passthrough (tools read process.env.KHYQUANT_CWD
   *            || process.cwd()), so a process-level switch is the only faithful
   *            mechanism; it is safe here because the switch happens under the
   *            global exclusive lock and is reverted in finally.
   *   - agent: agentFsService.{getActiveAgentId,setActiveAgent,clearActiveAgent}
   *            — an .active.json companion pointer read by the chat system
   *            prompt. setActiveAgent throws for an unknown id (handled fail-soft).
   * Unresolvable → null (routing degrades to no-op).
   * @returns {object|null}
   */
  _resolveWorkspaceRouter() {
    if (typeof this._getWorkspaceRouter === 'function') {
      try {
        return this._getWorkspaceRouter() || null;
      } catch {
        return null;
      }
    }
    try {
      const cwdSwitcher = require('../../../worktreeSessionCwd');
      const agentSvc = require('../../agents/agentFs/agentFsService');
      return {
        switchCwd: (dir) => cwdSwitcher.switchToolCwd(dir),
        getActiveAgentId: () => agentSvc.getActiveAgentId(),
        setActiveAgent: (id) => agentSvc.setActiveAgent(id),
        clearActiveAgent: () => agentSvc.clearActiveAgent(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 按账号绑定把本轮查询路由进对应工作空间/agent，返回还原函数。
   *
   * 实现与全部不变量（全局锁内调用、进程级状态、LIFO 逆序还原、端到端 fail-soft）
   * 在 ilinkWorkspaceRouting —— 单独成文件是为了让「谁改了进程级 cwd/env/agent 指针」
   * 这条最危险的职责有一个可独立评审的焦点。
   *
   * @returns {Function} restore 函数（永远安全可调）
   */
  _applyBindingRouting() {
    return _routing.applyBindingRouting({
      accountId: this.accountId,
      resolveBindingStore: () => this._resolveBindingStore(),
      resolveWorkspaceRouter: () => this._resolveWorkspaceRouter(),
    });
  }
  /**
   * 跑 chat(),但给它一个墙钟上限。
   *
   * 为什么必须有:chat() **既不接受 abort signal,也没有整体超时**。一次卡死的查询
   * (工具在等一个永不返回的网络调用、模型流断在半路)会让串行队列永久阻塞 ——
   * 微信从此一条都不理,而且从外面完全看不出为什么,只能重启守护进程。
   *
   * 超时后调 cancelActiveRequest() 真正掐掉在飞的网关请求(守护进程里没有 REPL 争用,
   * 这个进程级操作是安全的),然后放行队列。
   *
   * 诚实边界:cancelActiveRequest 只能掐网关请求;若 chat 卡在别处(比如某个工具的
   * 阻塞调用),那个 promise 可能仍悬着。所以这里给它挂了 catch 防止变成
   * unhandledRejection,并且**不**等它 —— 队列的畅通优先于那次查询的收尾。
   */
  async _chatWithWatchdog(chat, msg) {
    const limit = Number(defaults.ILINK_QUERY_TIMEOUT_MS) || 0;
    // 会话隔离(阶段 3 起在通道层生效):chat() 内 _chatState.messages 是进程级单例,
    // 之前 opts.sessionId 只进 trace audit、从不影响历史 → 所有微信用户共用一条历史、
    // 守护进程重启后消息全失(「从头开始」)。这里在每轮 chat 前按 sessionId 把 live
    // 会话作用域切到该用户:同 id no-op;异 id 恢复该用户已持久化历史(新用户空历史
    // 起步);随后 _persistLiveSession 把本轮追加到该用户独立文件,跨重启存活、用户隔离。
    try {
      const scopeSession = _resolveSessionControl('getScopeSession');
      const scope = defaults.ILINK_SESSION_SCOPE;
      // Phase-1 向后兼容:默认 dmScope 翻到 per-account-channel-peer 后,会话键从
      // 旧的 `ilink:<userId>` 变成 `ilink:<accountId>:<userId>`。在 scopeSession 之前做
      // 一次性 fallback 迁移:新键无历史而旧单账号键有历史时,把旧会话拷到新键,
      // 使既有用户升级后上下文无缝续接。失败不阻断聊天(fail-soft)。
      try {
        _migrateLegacyIlinkSession(this._resolvePersistence(), scope, this.accountId, msg.userId);
      } catch {
        /* fail-soft:迁移任何异常都不得影响正常聊天 */
      }
      scopeSession(buildSessionKey(scope, this.accountId, msg.userId));
    } catch {
      /* fail-soft:作用域失败不回退本轮 */
    }
    const p = this._runAgentTurn(chat, msg);
    if (limit <= 0) {
      return p;
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(_TIMED_OUT), limit);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    let winner;
    try {
      winner = await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (winner !== _TIMED_OUT) {
      return winner;
    }

    // 超时:掐掉在飞请求,并确保被遗弃的 promise 不会变成 unhandledRejection。
    p.catch(() => {});
    const mins = Math.max(1, Math.round(limit / 60000));
    log.warn(`ilink: 单次查询超过 ${limit}ms,已放弃并放行队列(用户 ${msg.userId})`);
    try {
      _resolveSessionControl('getCancelActiveRequest')('微信端查询超时');
    } catch {
      /* 取不到就算了,放行队列本身才是关键 */
    }
    return (
      `⏱ 这条处理超过 ${mins} 分钟还没结果,我先放弃了(在飞的请求已取消),` +
      '免得后面的消息一直排队。你可以换个说法再试,或把任务拆小一点。'
    );
  }

  /**
   * 跑一轮 agent:优先结构化工具循环,取不到才退回裸 chat()。
   *
   * 回退只在**开跑之前**判定(模块缺失 / isEnabled() 为假 / 门控关闭)。循环一旦抛错就
   * 如实报错,绝不改用 chat() 重跑一遍 —— 那时工具很可能已经执行过副作用(写文件、
   * 发请求),再跑一遍就是静默重复执行,比多一条错误消息危险得多。
   *
   * @param {Function} chat
   * @param {object} msg
   * @returns {Promise<*>} 供 normalizeReply 归一的结果
   */
  async _runAgentTurn(chat, msg) {
    const chatOpts = {
      source: 'ilink',
      channelName: core.PLATFORM,
      userId: msg.userId,
      // 会话隔离:每用户独立历史由 scopeSession 保证;此处 sessionId 供 trace audit。
      sessionId: `ilink:${msg.userId}`,
      // 按次放开「首选通道严格模式」——**只影响微信这条路,不碰全局 .env**。
      // 理由:GATEWAY_PREFERRED_STRICT=true 的含义是「首选通道不可用就硬失败」,
      // 这在终端是合理的(你能看到报错并当场 khy gateway model 换一个);但在微信里
      // 没有任何交互式换通道的余地,硬失败只会让对面收到一段看不懂的诊断文本。
      // 允许回落到其他已连通的通道,是这条链路上唯一能真正答话的选择。
      // 想让微信也严格遵循全局设置:把 KHY_ILINK_STRICT_ROUTE 设为 1/true。
      preferredStrict: _ilinkStrictRoute(),
      // 仅微信这一轮追加 khy-os 身份/绑定说明——通过已支持的 appendSystemPrompt
      // 字段,被 aiChatCore 拼到「本轮」系统提示尾部(--append-system-prompt 对齐点),
      // 不覆盖全局人设/静态基座。两条路径都透传:裸 chat(msg.text, chatOpts) 直读
      // opts.appendSystemPrompt;runToolUseLoop 以 {...chatOpts} 展开到每轮 chat()。
      appendSystemPrompt: ILINK_IDENTITY_SYSTEM_PROMPT,
    };

    const loop = _resolveToolLoop();
    if (!loop) {
      if (!this._warnedNoToolLoop) {
        this._warnedNoToolLoop = true;
        log.warn('ilink: 结构化工具循环不可用,本通道只能做纯文本问答(需要动手的请求会答不了)');
      }
      return chat(msg.text, chatOpts);
    }

    return loop.runToolUseLoop(msg.text, {
      chat,
      chatOpts,
      // 权限审批已由 _installPermissionBridge 改道到微信,循环里的工具闸门会用它。
      onToolCall: (name) => {
        log.debug?.(`ilink: 工具 ${name}(用户 ${msg.userId})`);
      },
      // syscall 网关的 L1/L2 交互式确认与 exec 审批走的是**独立于 permissionPromptPort**
      // 的 onControlRequest 通道。不接它 → executeTool 里 onCtrl 为 null → 守护进程这种
      // 非交互环境下 L2 高危/破坏性工具被 fail-closed 直接拒绝(审计里就是那句「L2 高危且
      // 无交互器,fail-closed 拒绝」)。这里把确认改道到微信,复用 _askPermission 的
      // 单槽/超时/宽限机制,让用户在微信里真正批准工具执行。
      onControlRequest: (ctrl) => this._askControlPermission(msg, ctrl),
    });
  }

  /**
   * 把权限审批从「本地终端」改道到微信,查询结束后原样还原。
   *
   * 为什么必须做,而且不能只当增强:守护进程是 detached 的,stdin 不是 TTY。若不接这条桥,
   * toolCallingPermissions.askUser 会回落到 readline(process.stdin),那个 question 的回调
   * **永远不会被调用** —— agent 永久挂住、串行队列死锁、微信这头再无下文。
   *
   * 走 permissionPromptPort 而非 setReadlineProvider:后者只能拿到 '  > ' 这个裸提示符
   * (工具详情是 console.log 到 stdout 的,在守护进程里进日志、到不了微信);前者给的是
   * 结构化的 (toolName, params, riskInfo, reasoning),且返回值会被既有代码正确记账到
   * permissionStore。
   *
   * **不削弱任何闸门**:不可绕过的 critical 人闸门(rm -rf / .env 改动 / git reset --hard)
   * 依旧生效——本桥只是给它一条能触达人的通道,绝不代替人回答。
   *
   * @returns {Function} 还原函数
   */
  _installPermissionBridge(msg) {
    let port;
    try {
      port = require('../../../permissionPromptPort');
    } catch {
      return () => {};
    }
    const prev = port.getPermissionPrompter();
    try {
      port.registerPermissionPrompter({
        prompt: (toolName, params, riskInfo, reasoning) =>
          this._askPermission(msg, { toolName, params, riskInfo, reasoning }),
        // 批量预检不接:让它回落到既有的非交互路径,比在微信里渲染一屏批量对话框可靠。
        promptBatch: prev && prev.promptBatch ? prev.promptBatch : undefined,
      });
    } catch {
      return () => {};
    }
    return () => {
      try {
        port.registerPermissionPrompter(prev);
      } catch {
        /* best effort */
      }
    };
  }

  /**
   * 向微信发一次授权询问并等回复。
   * @returns {Promise<'allow'|'deny'>} 超时一律 deny —— **绝不能 resolve 成空串**:
   *   toolCallingPermissions 把空应答当作 allow(见其 switch 的 case ''),
   *   那会让「没人理」变成「默许执行」。
   */
  _askPermission(msg, info) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (verdict) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this._pendingPermission = null;
        resolve(verdict === 'allow' ? 'allow' : 'deny');
      };

      const timer = setTimeout(() => {
        // 进入宽限期:超时后才发来的 y/n 要被吞掉,不能当成新 prompt 丢给模型。
        this._graceUntil = Date.now() + defaults.ILINK_PERMISSION_GRACE_MS;
        this._say(
          msg,
          `等待授权超过 ${Math.round(defaults.ILINK_PERMISSION_TIMEOUT_MS / 1000)} 秒,已自动拒绝。`
        ).catch(() => {});
        finish('deny');
      }, defaults.ILINK_PERMISSION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      this._pendingPermission = {
        resolve: (verdict) => {
          // 给个回执,否则用户不知道那句 y 到底收到没有。
          this._say(msg, verdict === 'allow' ? '✓ 已授权,继续执行。' : '已拒绝。').catch(
            () => {}
          );
          finish(verdict);
        },
      };

      this._say(msg, core.formatPermissionPrompt(info)).catch(() => {});
    });
  }

  /**
   * onControlRequest 微信桥:把 syscall 网关(L1/L2)与 exec 审批的交互式确认改道
   * 到微信,复用 _askPermission 的单槽/超时/宽限机制(不另造定时器)。
   *
   * 与 permissionPromptPort 的关系:两条独立的审批通道。网关判 allow 后会盖一枚
   * EXEC_APPROVED 戳,既有 requestPermission 据此**免二次打断**——故同一次工具调用
   * 不会被问两次(网关先问 onControlRequest,放行即盖戳跳过 permissionPromptPort)。
   * 两者复用同一个 _askPermission 展示逻辑,且共享 _pendingPermission 单槽,天然串行。
   *
   * 调用契约(见 syscallGateway.makeControlPrompter 与 toolUseLoopCore._resolveExecApproval):
   *   入参 ctrl = { requestId, request: { subtype:'can_use_tool', tool_name, input } }
   *     · 网关 input = { tool, level:'L1'|'L2', action, scope, resource, requireTyped?, explanation? }
   *     · exec input = { command, risk, reason }
   *   返回值(被 makeControlPrompter.decode / _decisionFromControl / confirmL2 解读):
   *     · 允许 → { behavior:'allow', typed:<L2 确认串> }
   *       (behavior 供 L1 askL1 与 exec 审批;typed 供 L2 confirmL2 匹配确认串)
   *     · 拒绝 → { behavior:'deny' }
   *
   * fail-closed:任何无法识别/超时 → deny。
   * @param {object} msg 入站消息
   * @param {object} ctrl 控制请求
   * @returns {Promise<{behavior:string, typed?:string}>}
   */
  async _askControlPermission(msg, ctrl) {
    const req = (ctrl && ctrl.request) || {};
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const level = String(input.level || '').toUpperCase(); // '', 'L1', 'L2'
    const toolName = input.tool || req.tool_name || '未知工具';

    // 归一成 formatPermissionPrompt 期望的 info 形状,复用同一展示逻辑。
    // 网关 intent 携 action/scope/resource;exec 携 command。
    const params = {};
    if (input.command != null) {
      params.command = input.command;
    }
    if (input.resource != null) {
      params.resource = input.resource;
    }
    if (input.action != null) {
      params.action = input.action;
    }
    if (input.scope != null) {
      params.scope = input.scope;
    }

    const riskLabel =
      level === 'L2'
        ? 'L2 高危(破坏性/不可逆,需你确认)'
        : level === 'L1'
          ? 'L1 中危'
          : input.risk || '未知';
    const info = {
      toolName,
      params,
      riskInfo: { level: riskLabel },
      reasoning: input.reason || (typeof input.explanation === 'string' ? input.explanation : ''),
    };

    const verdict = await this._askPermission(msg, info);
    if (verdict !== 'allow') {
      return { behavior: 'deny' };
    }

    // L2 确认串取自网关协议常量(DEFAULT_L2_CONFIRM),不写死字面量;取不到时
    // 回落协议默认 'YES'。allow 同时给 behavior 与 typed,一次满足 L1(behavior)、
    // L2(typed 匹配确认串)、exec(behavior) 三个消费方。
    //
    // **这里自己伪造 typed 正是草稿批准不能借用这个形状的原因**:用户只回了一个 `y`,
    // 却由代码替他补出 L2 要求「必须键入」的确认串 —— ilink 上 L2 的「必须键入」本就空转。
    // 草稿批准不造这种凭证:它要求的是**内容本身**经本人过目(见 formatDraftPreview),
    // 批准即投递,不存在「代填确认串」这一步。
    let l2Word = 'YES';
    try {
      const w = require('../../system/syscallGateway').DEFAULT_L2_CONFIRM;
      if (typeof w === 'string' && w.trim()) {
        l2Word = w;
      }
    } catch {
      /* fall back to protocol default */
    }
    return { behavior: 'allow', typed: l2Word };
  }

  /**
   * 维持「正在输入」直到查询结束。返回停止函数。
   * 纯装饰:全程静默失败,绝不影响回答。
   */
  _startTyping(msg) {
    if (!this.channel || typeof this.channel.setTyping !== 'function') {
      return () => {};
    }
    let stopped = false;
    const tick = () => {
      if (stopped) {
        return;
      }
      this.channel.setTyping(msg.userId, true, msg.threadId).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, defaults.ILINK_TYPING_KEEPALIVE_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      this.channel.setTyping(msg.userId, false, msg.threadId).catch(() => {});
    };
  }

  /**
   * 申请并发送微信绑定二维码。fail-soft:全程不抛。
   *
   * **默认关**（`ILINK_QR_SELF_SERVE`，默认 false）。这是「不做这能力」而不是
   * 「给它加一道门」：绑定码 = 拿到码的人扫码就能用你的实例，而本仓没有
   * accountId→userId 的反查路径（`_resolveAccountId` 只解 accountId），做不到
   * 「只发给本人」——所以默认形态就是不提供这条路径，而不是提供一个判不准的路径。
   *
   * 显式打开后仍有两道硬约束：
   *   1. 发送对象必须**显式在允许名单里**（`isPeerAllowed`）。这里不能用
   *      `_isAllowedSender`：观察期档下未列名者本来就会放行，那等于没约束。
   *   2. 图片发不出去时**不再降级发链接** —— 那只是把 `qr.qrcodeUrl` 换个形式外发，
   *      「关掉降级」才真的关掉了外发。
   *
   * 流程:申请二维码 → 渲染 PNG → 发图。发图失败即如实失败。
   * @param {object} msg
   */
  async _sendBindQrCode(msg) {
    if (!defaults.ILINK_QR_SELF_SERVE) {
      await this._say(msg, QR_SELF_SERVE_OFF_NOTICE);
      return;
    }
    // 显式允许名单判定（不走 allowMode：观察期档下未列名者会放行，那不是约束）。
    const allow = _allowlist();
    const userId = String((msg && msg.userId) || '');
    if (!allow || !allow.isPeerAllowed(this.accountId, userId)) {
      log.warn('ilink: 绑定码自助发放 —— 发送者未在允许名单内', {
        accountId: this.accountId,
        userId,
        messageId: msg && msg.messageId != null ? msg.messageId : null,
      });
      await this._say(
        msg,
        `发送绑定码要求发送者在允许名单里。放行:khy wx allow add ${userId}`
      );
      return;
    }

    const login = require('../messaging/ilinkLogin');
    await this._say(msg, '正在申请微信绑定二维码…');

    let qr;
    try {
      qr = await login.requestQrCode();
    } catch (e) {
      qr = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!qr || !qr.ok) {
      await this._say(msg, `⚠ 申请绑定二维码失败:${(qr && qr.error) || '未知原因'}`);
      return;
    }

    // 安全提示（必须）:转发二维码 = 授权对方使用你的 khy 实例。
    const safety = [
      '⚠ 安全提示:这张二维码等同于你的 khy 授权入口。',
      '谁扫码绑定,谁就能用你的 khy 实例——可访问你的文件系统与工具。',
      '请只转发给你完全信任的人;二维码有时效,过期需重新申请。',
    ].join('\n');

    // 只发图。渲染或上传失败就如实失败,绝不把 qrcodeUrl 换成文字再发一遍 ——
    // 那条降级路是「关掉二维码外发」之后最容易漏掉的后门。
    let buf = null;
    try {
      const dataUrl = await login.renderQrToDataUrl(qr.qrcodeUrl);
      const base64 =
        dataUrl && dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
      buf = base64 ? Buffer.from(base64, 'base64') : null;
    } catch (e) {
      log.warn(`ilink: 绑定二维码渲染异常:${(e && e.message) || e}`);
    }

    let sent = false;
    if (buf && buf.length && this.channel && typeof this.channel.sendImage === 'function') {
      try {
        const r = await this.channel.sendImage(msg.channelId || msg.userId, buf, {
          threadId: msg.threadId || '',
          fileName: 'khy-bind-qr.png',
        });
        sent = !!(r && r.ok);
        if (!sent) {
          log.warn(`ilink: 绑定二维码图片发送失败(不降级发链接):${r && r.error}`);
        }
      } catch (e) {
        log.warn(`ilink: 绑定二维码发送异常(不降级发链接):${(e && e.message) || e}`);
      }
    }

    if (sent) {
      await this._say(msg, safety);
      return;
    }
    await this._say(
      msg,
      '⚠ 绑定二维码图片发送失败,没有改发链接（二维码链接同样等同授权入口）。' +
        '请在本机终端运行 khy wx login，二维码只显示在你的终端。'
    );
  }

  /** 发一句话回原会话。fail-soft:发不出去只记日志。 */
  async _say(msg, text) {
    if (!this.channel || typeof this.channel.sendReply !== 'function') {
      return;
    }
    try {
      const r = await this.channel.sendReply(msg.channelId || msg.userId, msg.threadId || '', text);
      if (r && r.ok === false) {
        log.warn(`ilink 回复未发全(已发 ${r.sent} 片):${r.error}`);
      }
    } catch (err) {
      log.warn(`ilink 回复发送失败:${(err && err.message) || err}`);
    }
  }

  /**
   * 诊断用。草稿位必须在这里:草稿**会静默过期**,只报队列长度的话,用户看到的是
   * 「队列空闲」而他的回复其实还没发出去。只报计数与发送者 id,不带任何草稿正文。
   *
   * **本形状是全量的,且只给进程内诊断**(日志、status 条)。任何要渲染成发给微信用户的
   * 文本的路径,都必须改走 `_draftStatsFor(userId)` —— 否则哪天把 toJSON 接到 /wx 上,
   * `draftOwners` 会把全 bot 的发送者 id 原样报给当前这一个发送者。
   */
  toJSON() {
    const draft = this._draftStats();
    return {
      queued: this._queue.length,
      running: this._running,
      awaitingPermission: !!this._pendingPermission,
      draftConfirm: !!this._draftQueue,
      pendingDrafts: draft.total,
      draftOwners: draft.owners,
    };
  }
}

module.exports = {
  IlinkDispatcher,
  normalizeReply,
  buildSessionKey,
  _migrateLegacyIlinkSession,
  _resolveChat,
  _resolveToolLoop,
  _ilinkStrictRoute,
  isBindQrIntent,
};
