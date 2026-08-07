'use strict';

/**
 * commandHelp.js — one-line help data for router commands that have no
 * self-registering manifest and no slash-menu entry.
 *
 * Resolution order used by helpCard (and any other consumer):
 *   1. commandAutoRegistry completions (handler-exported manifests)
 *   2. ROUTER_SUB_COMMANDS (constants/commandSchema)
 *   3. BUILTIN_SLASH_COMMANDS desc (indexed by bare name)
 *   4. EXTRA_HELP (this file)
 *
 * ALIAS_CANON maps no-hyphen / shorthand spellings to their canonical
 * command so `khy help adddir` resolves to the `add-dir` card.
 *
 * Pure data + lookups: zero IO, never throws, no side effects.
 *
 * @module constants/commandHelp
 */

// Canonical names this file describes (router cases without manifests/slash).
const EXTRA_HELP = {
  quote: {
    description: '查询实时行情',
    usage: 'quote <代码|名称>  (别名: hangqing / 行情 / price)',
  },
  menu: { description: '打开交互式命令菜单' },
  account: { description: '查看账户资金信息（在线走服务 API，离线读本地库）' },
  position: { description: '查看当前持仓' },
  order: {
    description: '下单（默认预览模式，需接入交易接口）',
    usage: 'order <代码> --side buy|sell --qty N --price P',
  },
  watch: {
    description: '自选股管理',
    usage: 'watch <代码|名称>  (加入) | watch list | watch remove <代码> | watch clear',
  },
  rank: { description: '查看行情排行榜' },
  analyze: {
    description: '个股分析',
    usage: 'analyze <代码|名称>  (别名: fx / fenxi)',
  },
  kiro: { description: '启动/查看 Kiro AI 代理（--list 列出可用模型）' },
  cursor: { description: '启动/查看 Cursor AI 代理（--list 列出可用模型）' },
  claude: {
    description: '启动/管理 Claude Code 代理（--list 查看模型；adopt-env / use-relay / export-env 凭据工具）',
  },
  codex: { description: '启动/管理 Codex 代理（--list 查看模型；支持凭据 adopt 动词）' },
  trae: { description: '启动/查看 Trae AI 代理（--list 列出可用模型）' },
  opencode: { description: '启动/查看 OpenCode 代理（--list 列出可用模型）' },
  warp: { description: '启动/查看 Warp 终端 AI（--list 列出可用模型）' },
  vscode: { description: '启动/查看 VS Code 集成（--list 列出可用模型）' },
  register: { description: '注册 CLI 账号（凭据写入 ~/.khyquant/credentials.json）' },
  whoami: { description: '查看当前登录用户' },
  passwd: { description: '修改当前账号密码' },
  forgot: { description: '账号密码找回（交互式选择找回方式）' },
  dream: {
    description: '记忆整理（深度梦境蒸馏：归档陈旧/重复记忆）',
    usage: 'dream [deep|status|health] [--force]',
  },
  web_search: {
    description: '联网搜索',
    usage: 'web_search <关键词>',
  },
  topology: { description: '查看多智能体会话树拓扑（别名: forest）' },
  server: { description: '后端服务启动与状态' },
  db: { description: '数据库初始化/造数/状态检查' },
  ai: { description: 'AI 助手配置与权限开关' },
  verify: { description: '跨平台交付验证（node/python/wasm/docker）' },
  backtest: { description: '策略回测（历史数据模拟）', usage: 'backtest <代码> [--strategy N]' },
  data: { description: '行情数据下载与管理' },
  search: { description: '按关键词搜索标的代码/名称', usage: 'search <关键词>' },
  strategy: { description: '策略列表与管理' },
};

// Shorthand / no-hyphen spellings → canonical command name.
const ALIAS_CANON = {
  adddir: 'add-dir',
  outputstyle: 'output-style',
  releasenotes: 'release-notes',
  terminalsetup: 'terminal-setup',
  keys: 'keybindings',
  shortcuts: 'keybindings',
  perfissue: 'perf-issue',
  sandboxtoggle: 'sandbox-toggle',
  initverifiers: 'init-verifiers',
  debugtoolcall: 'debug-tool-call',
  prcomments: 'pr-comments',
  webtools: 'web-tools',
  quit: 'exit',
  forest: 'topology',
};

// Lazily built index of slash-menu descs, keyed by bare name.
let _slashIndex = null;
function _getSlashIndex() {
  if (_slashIndex) return _slashIndex;
  _slashIndex = {};
  try {
    const { getBuiltinSlashCommands } = require('./commandSchema');
    for (const item of getBuiltinSlashCommands()) {
      const name = String(item.cmd || '').trim().replace(/^\/+/, '');
      if (name && !_slashIndex[name] && item.desc) _slashIndex[name] = item.desc;
    }
  } catch {
    /* fail-soft: schema unavailable → slash tier stays empty */
  }
  return _slashIndex;
}

/** Resolve a user-typed command spelling to its canonical card name. */
function canonicalize(name) {
  const t = String(name == null ? '' : name).trim().toLowerCase();
  return ALIAS_CANON[t] || t;
}

/** Best-effort one-line help for a router command name.
 * @param {string} name raw or canonical command name
 * @returns {{description: string, usage?: string}|null}
 */
function getHelp(name) {
  const t = String(name == null ? '' : name).trim().toLowerCase();
  if (!t) return null;
  const canonical = canonicalize(t);
  const extra = EXTRA_HELP[canonical];
  if (extra) return extra;
  const slashDesc = _getSlashIndex()[canonical];
  if (slashDesc) return { description: slashDesc };
  return null;
}

function _editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Nearest command names for a typo'd help topic (prefix hit ranks first).
 * @param {string} input user-typed topic
 * @param {string[]} candidates command names
 * @returns {string[]} up to 3 suggestions, most plausible first
 */
function suggest(input, candidates, { limit = 3, maxDistance = 3 } = {}) {
  const t = String(input == null ? '' : input).trim().toLowerCase();
  if (!t || !Array.isArray(candidates)) return [];
  const scored = [];
  for (const raw of candidates) {
    const name = String(raw || '').toLowerCase();
    if (!name) continue;
    if (name.startsWith(t)) { scored.push({ name, d: 0 }); continue; }
    const d = _editDistance(t, name);
    if (d <= maxDistance) scored.push({ name, d });
  }
  scored.sort((x, y) => x.d - y.d || x.name.length - y.name.length);
  return scored.slice(0, limit).map((s) => s.name);
}

module.exports = { EXTRA_HELP, ALIAS_CANON, canonicalize, getHelp, suggest };
