'use strict';

/**
 * positioning.js — Product positioning single source of truth (INIT-PRD-004).
 *
 * The user-positioning decision (2026-09-23) lives in
 * docs/01_INIT_立项/INIT-PRD/[INIT-PRD-004] 用户定位与增长路线.md; this module is
 * its CODE embodiment so every product surface (startup banners, `khy about`,
 * brand copy) renders the same promise instead of drifting apart.
 *
 * Relationship to `cli/tui/utils/ccBrand.js`:
 *   ccBrand stays the consumption point for CC-mode UI text (its header promise:
 *   "修改品牌只需改此文件"), but `tagline`/`welcomeSubtitle` now derive from
 *   POSITIONING so there is exactly one place where the promise is worded.
 *
 * Pure leaf: zero IO, no env reads, no console writes. User-facing strings are
 * Chinese per repo style; comments stay English.
 */

const POSITIONING = Object.freeze({
  /** Banner one-liner: what you get in one breath. */
  tagline: '一个终端，吃遍你所有的 AI 订阅',

  /** Full promise used by `khy about` and README-level copy. */
  oneLiner:
    'khy OS：给中文 AI 重度用户的一台「AI 主机」——一个终端吃遍你所有的 AI 订阅，' +
    '自动省钱、自动容错；微信和手机上，随时使唤它。',

  /** Beachhead audience (S1 in INIT-PRD-004 §二). */
  audience: '中文 AI 重度用户：手里有 2~5 家 AI 订阅、成本敏感的超级个体',

  /** The four claims Claude Code structurally cannot match (INIT-PRD-004 §三). */
  claims: Object.freeze([
    Object.freeze({
      title: '订阅套利',
      body: '一个 CLI 接入多家订阅，熔断与故障转移自动兜底，用量按人民币计价、月度省钱报告算给你看',
    }),
    Object.freeze({
      title: '随身性',
      body: '微信、手机上随时使唤你的 agent，活干完回来汇报',
    }),
    Object.freeze({
      title: '本土化',
      body: '中文与拼音命令、中文错误消息、国内模型与镜像优先',
    }),
    Object.freeze({
      title: '私有与便携',
      body: '数据全在本地，便携版随身带，源码可见',
    }),
  ]),

  /** Why the product name carries "OS" (INIT-PRD-004 §七 / INIT-PRD-003 core stack). */
  os: Object.freeze({
    headline: '为什么叫 OS',
    body:
      '模型调用被当作系统调用统一收口：壳（CLI/TUI）→ 漏斗（工具唯一出口）→ 网关（多供应商路由）。' +
      '内核、应用、拓展都是挂在这套运行时上的可增删单元——这是「AI 主机」而不是「又一个 CLI」的原因。',
    layers: Object.freeze([
      'kernel      手写 C 内核（实验分支，QEMU 可引导，khy os）',
      'runtime     壳 → 漏斗 → 网关（不可卸载核）',
      'apps        ai-frontend / 桌面端 / 手机端 / khyquant（可增删）',
      'extensions  一个目录一个拓展，删目录即卸载',
    ]),
  }),

  /** Positioning doc pointer (repo-relative, forward slashes). */
  doc: 'docs/01_INIT_立项/INIT-PRD/[INIT-PRD-004] 用户定位与增长路线.md',
});

module.exports = { POSITIONING };
