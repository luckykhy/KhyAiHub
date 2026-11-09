'use strict';

/**
 * commandParamSpecs — 斜杠命令「参数面板」的规格真源（2026-10-10）。
 *
 * 为什么要有它：212 条命令里一百多条带子命令/可调值（`/gateway status`、
 * `/color blue`、`/intent on`…），此前只能凭记忆手敲，敲错就被当普通文本发给模型。
 * 参数面板让「选命令 → 调参数 → 执行」变成可见的三步。
 *
 * 规格分两档，都只做**指针**不自造第二真源：
 *   ① CURATED —— 逐个核对过 handler/叶子的（颜色表、开关三态、自由文本参数），
 *      带中文标签与默认值；
 *   ② 派生 —— `commandSchema.getMenuSubCommands()[cmd]`，也就是**经典 REPL 二级
 *      菜单的同一份真源**，生成一个「子命令」选择参数。126 条命令零维护自动覆盖。
 *
 * 没有规格 → `specsFor()` 返 `[]` → 调用方按今天的样子直接执行，不弹面板
 * （逐字节回退）。门控 `KHY_SLASH_PARAM_PANEL` 默认开；显式 falsy → 恒 `[]`。
 *
 * 规格形状：
 *   { name, label, type: 'choice'|'text', choices?: [{name,value}],
 *     defaultValue?, optional?, hint? }
 *     optional —— 空值不出现在组装出的命令行里（如 `/color` 无参 = 列出全部）。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 面板总闸。默认开，仅显式 0/false/off/no 关闭。 */
function panelEnabled(env = process.env) {
  const raw = env && env.KHY_SLASH_PARAM_PANEL;
  return !(raw !== undefined && _OFF.has(String(raw).trim().toLowerCase()));
}

/** 颜色表真源：cli/sessionColor.js 的 AGENT_COLORS（与 agent 配色同一份）。 */
function _colorChoices() {
  try {
    const { AGENT_COLORS } = require('../sessionColor');
    const zh = {
      blue: '蓝', green: '绿', orange: '橙', purple: '紫',
      red: '红', cyan: '青', yellow: '黄', magenta: '品红',
    };
    const list = (AGENT_COLORS || []).map((c) => ({ name: `${zh[c] || c}（${c}）`, value: c }));
    list.push({ name: '重置为默认（default）', value: 'default' });
    return list;
  } catch {
    return [];
  }
}

/** 主题表真源：cli/themeRegistry（读 themes/*.json，随用户自定义增长）。 */
function _themeChoices() {
  try {
    const reg = require('../themeRegistry');
    const names = typeof reg.listThemes === 'function' ? reg.listThemes() : [];
    const arr = Array.isArray(names) ? names : [];
    if (!arr.length) return [];
    return arr.map((t) => {
      const id = typeof t === 'string' ? t : t && (t.name || t.id);
      const label = typeof t === 'string' ? t : t && (t.label || t.name || t.id);
      return id ? { name: String(label || id), value: String(id) } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const _choice = (label, choices, extra) => ({
  name: 'value',
  label,
  type: 'choice',
  choices,
  optional: true,
  ...extra,
});
const _text = (label, extra) => ({ name: 'text', label, type: 'text', ...extra });

/** 逐个核对过的规格表。值为函数：颜色/主题表是动态的，每次开面板时取真源。 */
const CURATED = {
  color: () => [_choice('会话强调色', _colorChoices(), { hint: '留空 = 列出全部颜色' })],
  theme: () => [_choice('配色主题', _themeChoices(), { hint: '留空 = 当前主题' })],
  lang: () => [
    _choice('界面语言', [
      { name: '中文', value: 'zh' },
      { name: 'English', value: 'en' },
      { name: '自动（跟随系统）', value: 'auto' },
    ]),
  ],
  effort: () => [
    _choice('推理强度', [
      { name: '低（快）', value: 'low' },
      { name: '中', value: 'medium' },
      { name: '高', value: 'high' },
      { name: '最高（慢）', value: 'max' },
      { name: '查看当前', value: 'status' },
    ]),
  ],
  intent: () => [
    _choice('意图保护调试', [
      { name: '开启', value: 'on' },
      { name: '关闭', value: 'off' },
      { name: '查看当前', value: 'show' },
    ]),
  ],
  study: () => [
    _choice('学习模式', [
      { name: '开启', value: 'on' },
      { name: '关闭', value: 'off' },
      { name: '查看状态', value: 'status' },
    ]),
  ],
  mind: () => [
    _choice('认知双图', [
      { name: '查看（渲染双图）', value: 'show' },
      { name: '开自动展示', value: 'on' },
      { name: '关自动展示', value: 'off' },
      { name: '重置', value: 'reset' },
    ]),
  ],
  usage: () => [
    _choice('统计口径', [
      { name: '今日', value: 'today' },
      { name: '近 14 天', value: 'history' },
      { name: '重置计数', value: 'reset' },
    ]),
  ],
  // 自由文本参数：这些命令吃的是原始串，面板给它一个带预览的输入行。
  shell: () => [_text('要执行的 shell 命令', { hint: '例如：ls -la' })],
  remember: () => [_text('要记住的内容', { hint: '追加到 khy.md 的 Memories' })],
  btw: () => [_text('补充提示', { hint: '下一轮与正式输入一起发出' })],
  rewind: () => [_text('回溯到第几条消息', { optional: true, hint: '留空 = 打开回溯选择器' })],
  // 两个参数的样本：子命令 + 条目 id（approve/discard 才用得上，optional 空着就不出
  // 现在组装行里）。routerDispatchTail.js 的 case 'instructions' 认这四个子命令。
  instructions: () => [
    _choice('动作', [
      { name: '列出待审核', value: 'list' },
      { name: '批准写入', value: 'approve' },
      { name: '丢弃', value: 'discard' },
      { name: '清空', value: 'clear' },
    ]),
    _text('条目 id（approve / discard 用）', { optional: true, hint: '留空 = 不适用' }),
  ],
};

// 规格缓存：菜单每帧都要问「这条命令有没有参数面板好挂徽标」，而
// getMenuSubCommands() 每次调用都重建整张表 —— 逐行逐帧问一遍太贵。
// 只缓存**有规格**的判定（正结果），门控关/无规格的路径本来就便宜。
const _hasCache = new Map();

/**
 * 快捷判定：这条命令有没有参数规格（菜单徽标用）。
 * @param {string} cmd
 * @param {object} [env]
 * @returns {boolean}
 */
function hasSpecs(cmd, env = process.env) {
  if (!panelEnabled(env)) return false;
  const key = String(cmd == null ? '' : cmd).replace(/^\//, '').trim().toLowerCase();
  if (!key) return false;
  const hit = _hasCache.get(key);
  if (hit !== undefined) return hit;
  const ok = specsFor(key, env).length > 0;
  _hasCache.set(key, ok);
  return ok;
}

/**
 * 取一条命令的参数规格。无规格 / 门控关 → `[]`。
 * @param {string} cmd 斜杠命令（可带或不带前导 /）
 * @param {object} [env]
 * @returns {Array<object>}
 */
function specsFor(cmd, env = process.env) {
  if (!panelEnabled(env)) return [];
  const key = String(cmd == null ? '' : cmd).replace(/^\//, '').trim().toLowerCase();
  if (!key) return [];
  const curated = CURATED[key];
  if (curated) {
    try {
      const list = curated();
      if (Array.isArray(list) && list.length) return list;
    } catch {
      /* 动态真源取不到 → 落到派生档，绝不抛 */
    }
  }
  // 派生档：经典 REPL 二级菜单的同一真源（getMenuSubCommands）。
  try {
    const subs = require('../../constants/commandSchema').getMenuSubCommands()[key];
    if (Array.isArray(subs) && subs.length) {
      return [
        _choice(
          '子命令',
          subs.map((s) => ({ name: String(s), value: String(s) })),
          { hint: '留空 = 命令默认行为' }
        ),
      ];
    }
  } catch {
    /* commandSchema 不可用 → 无规格，调用方直接执行 */
  }
  return [];
}

/**
 * 把面板上的值组装成可提交的命令行（交回既有 handleSubmit → route() 正门）。
 * 空值（optional 或未填的必填项）跳过；choice 用 value、text 用原文。
 * @param {string} cmd 斜杠命令
 * @param {Array<object>} specs specsFor 的产物
 * @param {Array<string>} values 与 specs 等长的值数组
 * @returns {string} 例如 `/gateway status` / `/color blue` / `/shell ls -la`
 */
function assemble(cmd, specs, values) {
  const key = String(cmd == null ? '' : cmd).replace(/^\//, '').trim();
  const parts = [`/${key}`];
  const list = Array.isArray(specs) ? specs : [];
  const vals = Array.isArray(values) ? values : [];
  for (let i = 0; i < list.length; i++) {
    const raw = vals[i];
    const v = raw == null ? '' : String(raw).trim();
    if (!v) continue;
    // 自由文本原样接上（不再拆词，路径/引号由 router 的 tokenizer 负责）；
    // 选择值同理。
    parts.push(v);
  }
  return parts.join(' ');
}

module.exports = { panelEnabled, specsFor, hasSpecs, assemble, CURATED };
