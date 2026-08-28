/**
 * Interactive command catalog (/menu) — inline categorized listing.
 *
 * Rule 4 compliance: this renderer emits plain inline output via console.log
 * only. It never uses ANSI scroll regions (\x1B[n;mr) nor switches to an
 * alternate screen buffer, so the REPL scrollback stays intact and users can
 * scroll up to review earlier output.
 *
 * All user-facing prose is in Chinese; identifiers and comments are English.
 *
 * Data source strategy (single source of truth):
 * - CATEGORY_MAP below is the ONLY place that decides which canonical commands
 *   appear under which top-level category, plus their Chinese one-line label.
 * - Per-command aliases are NOT duplicated here — they are derived at render
 *   time from aliases.js (getAliasesForCommand), so the alias table remains the
 *   single source for alias data and this catalog never drifts from it.
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;

const { getAliasesForCommand } = require('./aliases');
const { displayWidth, getTerminalColumns } = require('./formatters');

/**
 * Single source of truth for menu categorization.
 * Each entry: { name, icon, cmds: [[canonicalCommand, chineseLabel], ...] }.
 * The canonical command must match the `command` field used in aliases.js /
 * the router switch, so alias derivation and dispatch stay consistent.
 */
const CATEGORY_MAP = [
  {
    name: '量化交易',
    icon: '◐',
    color: chalk.red,
    cmds: [
      ['quote', '实时行情'],
      ['backtest', '策略回测'],
      ['data', '数据下载与列表'],
      ['strategy', '策略管理'],
      ['analyze', 'AI 行情分析'],
      ['search', '标的搜索'],
    ],
  },
  {
    name: 'AI 助手',
    icon: '◆',
    color: chalk.blue,
    cmds: [
      ['gateway', 'AI 网关状态与切换'],
      ['models', '本地模型管理'],
      ['ai', 'AI 配置与权限'],
      ['image2web', '截图还原网页'],
      ['arena', '模型竞技场对比'],
    ],
  },
  {
    name: '系统',
    icon: '▸',
    color: chalk.cyan,
    cmds: [
      ['doctor', '环境诊断'],
      ['server', '后端服务'],
      ['db', '数据库'],
      ['config', '配置管理'],
      ['monitor', '底座自检'],
      ['proxy', '代理与令牌'],
    ],
  },
  {
    name: '应用管理',
    icon: '+',
    color: chalk.green,
    cmds: [
      ['app', '应用安装与运行'],
      ['modules', '模块化打包'],
      ['skill', '技能管理'],
      ['learn', '学习课程'],
      ['workflow', '工作流录制与回放'],
    ],
  },
];

// Legacy Windows terminals lack the glyphs used above; fall back to ASCII icons
// (mirrors the detection printHelp already relies on).
const _ASCII_ICONS = { '◐': '#', '◆': '+', '▸': '*', '+': '+' };

/**
 * Pick a short, representative alias list for a canonical command.
 * Prefers Chinese aliases (most discoverable for local users), then fills with
 * pinyin/English, capped to keep each row compact. Pure function.
 * @param {string} command
 * @param {number} [limit=3]
 * @returns {string[]}
 */
function pickAliases(command, limit = 3) {
  let aliases = [];
  try {
    aliases = getAliasesForCommand(command) || [];
  } catch {
    aliases = [];
  }
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
  const chinese = aliases.filter(hasCjk);
  const others = aliases.filter((a) => !hasCjk(a));
  return [...chinese, ...others].slice(0, limit);
}

/**
 * Build the catalog data model (pure). Aliases are derived from aliases.js.
 * @returns {Array<{ name: string, icon: string, items: Array<{ command: string, label: string, aliases: string[] }> }>}
 */
function buildCommandCatalog() {
  return CATEGORY_MAP.map((group) => ({
    name: group.name,
    icon: group.icon,
    color: group.color,
    items: group.cmds.map(([command, label]) => ({
      command,
      label,
      aliases: pickAliases(command),
    })),
  }));
}

/**
 * Render the command catalog as an inline box, styled to match printHelp().
 * Emits plain console.log lines only (no scroll region, no alternate buffer).
 */
function renderCommandCatalog() {
  const catalog = buildCommandCatalog();

  let legacyWin = false;
  try {
    const { isLegacyWinTerminal } = require('../tools/platformUtils');
    legacyWin = isLegacyWinTerminal();
  } catch {
    /* assume modern terminal */
  }
  const iconOf = (icon) => (legacyWin ? _ASCII_ICONS[icon] || '*' : icon);

  const cols = getTerminalColumns();
  // Floor the box width so very narrow terminals (cols 1-3, e.g. test stubs)
  // cannot drive boxW/innerW negative and make '─'.repeat(...) throw RangeError.
  const boxW = Math.max(32, Math.min(cols - 4, 72));
  const innerW = Math.max(0, boxW - 4); // "│ " + content + " │"
  const dim = chalk.dim;
  const hr = '─'.repeat(Math.max(0, boxW - 2));

  // ANSI- and CJK-safe padding (double-width glyphs counted as 2 columns), so
  // right borders stay aligned for Chinese labels.
  const vis = (s) => displayWidth(s);
  const pad = (s, w) => {
    const g = Math.max(0, w - vis(s));
    return s + ' '.repeat(g);
  };
  const row = (s) => dim('  │ ') + pad(s, innerW) + dim(' │');
  const emptyRow = () => row('');

  console.log('');
  const titleText = ' khy OS — 命令菜单 ';
  const titleDashes = boxW - 2 - displayWidth(titleText);
  const tLeft = Math.floor(titleDashes / 2);
  const tRight = titleDashes - tLeft;
  console.log(
    dim(`  ╭${'─'.repeat(Math.max(1, tLeft))}`) +
      chalk.cyan.bold(titleText) +
      dim(`${'─'.repeat(Math.max(1, tRight))}╮`)
  );
  console.log(emptyRow());
  console.log(row(dim('输入命令或其别名即可执行，例如: khy hq 茅台 · /menu 重新打开本菜单')));
  console.log(emptyRow());

  // Two-column layout: left = command + aliases, right = Chinese label.
  const cmdColW = Math.min(Math.floor(innerW * 0.62), 44);

  catalog.forEach((group) => {
    const colorFn = group.color || chalk.cyan;
    console.log(row(`${colorFn(iconOf(group.icon))} ${colorFn.bold(group.name)}`));
    console.log(row(dim('─'.repeat(Math.max(0, innerW)))));
    group.items.forEach((item) => {
      const aliasText = item.aliases.length ? dim(` (${item.aliases.join(', ')})`) : '';
      const left = pad(chalk.white(item.command) + aliasText, cmdColW);
      console.log(row(`  ${left} ${dim(item.label)}`));
    });
    console.log(emptyRow());
  });

  console.log(
    row(dim('提示: khy help 速查 · khy help <gateway|quant|ops> 分主题帮助'))
  );
  console.log(row(dim('全量命令清单（250+ 动词）: khy commands --all')));
  console.log(dim(`  ╰${hr}╯`));
  console.log('');
}

// ── 全量枚举入口（#58:「查看全部命令」此前无真实入口）────────────────────
//
// renderCommandCatalog() 是 22 条精选速查；本函数枚举 commandSchema 的**全部**
// 可派发动词（静态 ROUTER_COMMANDS + manifest 自注册词），按 commandSchema 的
// category 分组。说明文案来源按优先级合并（全部 fail-soft，取不到 → 只列名）：
//   1. CATEGORY_MAP 精选中文标签（本文件，人工校对过的措辞）
//   2. commandAutoRegistry manifest description（自注册命令自带一行说明）
//   3. commands/registry.js 元数据 description
//   4. commandRegistry 斜杠条目 route 为单 token 时的 label
// 输出为普通回滚流内联行（Rule 4：无滚动区、无备用缓冲区）。

let _ALL_CATEGORIES = {};
try {
  _ALL_CATEGORIES = require('./commandRegistry').CATEGORIES || {};
} catch { /* fail-soft: 只用附加标签 + 原始 key */ }
const _EXTRA_CATEGORY_LABELS = { analysis: '分析', ai: 'AI', trading: '量化交易' };
// 展示顺序：高频域在前，未知域按字母序追加。
const _CATEGORY_ORDER = ['model', 'data', 'analysis', 'trading', 'system', 'security', 'dev', 'workflow', 'extension'];

function _categoryLabel(key) {
  return _ALL_CATEGORIES[key] || _EXTRA_CATEGORY_LABELS[key] || key;
}

function _categoryRank(key) {
  const i = _CATEGORY_ORDER.indexOf(key);
  return i === -1 ? _CATEGORY_ORDER.length : i;
}

/**
 * 组装全量命令清单（纯函数，不打印）。每个动词恰好出现一次，
 * 分组顺序稳定（域按 _CATEGORY_ORDER，组内按名字母序）。
 * @returns {{ groups: Array<{ key: string, label: string, items: Array<{ command: string, description: string }> }>, total: number }}
 */
function buildAllCommands() {
  const descByName = new Map();
  const put = (name, desc) => {
    const key = String(name || '').toLowerCase();
    if (!key) return;
    const text = String(desc || '').trim();
    // 名字回显（label 与命令同名，如 slash /usage 的 "Usage"）不携带信息，丢弃。
    if (text && text.toLowerCase() !== key && !descByName.has(key)) {
      descByName.set(key, text);
    }
  };

  for (const group of CATEGORY_MAP) {
    for (const [cmd, label] of group.cmds || []) put(cmd, label);
  }
  try {
    const ar = require('./commandAutoRegistry');
    for (const c of ar.getCompletions()) put(c.name, c.description);
  } catch { /* fail-soft */ }
  try {
    for (const c of require('./commands/registry').getAllCommands()) put(c.name, c.description);
  } catch { /* fail-soft */ }
  try {
    for (const e of require('./commandRegistry').getAll()) {
      const route = String(e.route || '').trim().split(/\s+/);
      if (route.length === 1) put(route[0], e.label);
    }
  } catch { /* fail-soft */ }

  let verbs = [];
  const catByName = new Map();
  try {
    const schema = require('../constants/commandSchema');
    verbs = schema.getRouterCommandNames() || [];
    for (const e of schema.getCommandSchema() || []) {
      if (e && e.name) catByName.set(String(e.name).toLowerCase(), e.category || 'system');
    }
  } catch {
    return { groups: [], total: 0 };
  }

  const byCat = new Map();
  const seen = new Set();
  for (const raw of verbs) {
    const name = String(raw || '').toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let cat = catByName.get(name);
    if (!cat) {
      try {
        cat = require('../constants/commandSchema').inferCategory(name);
      } catch {
        cat = 'system';
      }
    }
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({ command: name, description: descByName.get(name) || '' });
  }

  const groups = [...byCat.entries()]
    .sort((a, b) => _categoryRank(a[0]) - _categoryRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, items]) => ({
      key,
      label: _categoryLabel(key),
      items: items.sort((a, b) => a.command.localeCompare(b.command)),
    }));

  return { groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}

/**
 * 打印全量命令清单（内联、无框，适合 250+ 行）。
 * 供 `khy commands --all` 消费；门控在 handler 层，本函数本身无条件渲染。
 */
function renderAllCommands() {
  const { groups, total } = buildAllCommands();
  const dim = chalk.dim;
  const vis = (s) => displayWidth(s);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - vis(s)));

  console.log('');
  const catN = groups.length;
  console.log('  ' + chalk.cyan.bold('khy OS — 全部命令') + dim(`（${total} 个动词 · ${catN} 类）`));
  console.log(dim('  命令名与其别名均可直接执行 · 精选速查菜单见 khy commands · 单条详情 khy help <命令>'));

  for (const group of groups) {
    console.log('');
    console.log('  ' + chalk.blue.bold(group.label) + dim(` · ${group.key} (${group.items.length})`));
    const nameW = Math.min(
      28,
      Math.max(...group.items.map((it) => vis(it.command)), 1) + 2
    );
    for (const it of group.items) {
      if (!it.description) {
        console.log('    ' + chalk.white(it.command));
        continue;
      }
      console.log('    ' + pad(chalk.white(it.command), nameW) + ' ' + dim(it.description));
    }
  }
  console.log('');
}

module.exports = {
  CATEGORY_MAP,
  buildCommandCatalog,
  renderCommandCatalog,
  buildAllCommands,
  renderAllCommands,
};
