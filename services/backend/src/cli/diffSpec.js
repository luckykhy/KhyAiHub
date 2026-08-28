'use strict';

/**
 * diffSpec — 文件修改红绿 diff 的视觉规格单一真源（[DESIGN-ARCH-157]）。
 *
 * 管「画法」（颜色 token / 折叠账本 / 词级高亮开关），不管「算法」——
 * diff 计算真源仍是 diffRenderer.computeStructuredDiffHunks。
 *
 * 消费的四个面：TUI 工具卡片（ToolLines renderDiffRows）、经典 REPL 回显
 * （repl/toolOutputRender）、审批框（services/editDiffPreview → ToolLines）、
 * 全屏 diffViewer（cli/ui/diffViewer）。渲染器不得在内部另算折叠/另取色值。
 *
 * 颜色真源 = themeRegistry 活动主题的 colors.diff* 键；
 * 门控 KHY_DIFF_SPEC_V1 关 → 恒回退 CC 字面量（逐字节现状），绝不抛。
 */

// CC 暗色主题的 diff 色板。themes/default.json 与此逐字节相同，
// 故默认主题下门控开/关输出无差异；非默认主题只在门控开时生效（新能力）。
const CC_DIFF = Object.freeze({
  add: '#225C2B', // 新增行背景（深绿）
  del: '#7A2936', // 删除行背景（深红）
  addWord: '#38A660', // 词级高亮·新增词背景（亮绿）
  delWord: '#B3596B', // 词级高亮·删除词背景（亮红）
  text: '#FFFFFF', // ±行前景
});

const FALSY = new Set(['0', 'false', 'off', 'no']);
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function _flag(raw, dflt) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return dflt;
  if (FALSY.has(v)) return false;
  if (TRUTHY.has(v)) return true;
  return dflt;
}

/** 主门控：关 → A/B/C 三刀逐字节回退现状。默认开。 */
function diffSpecEnabled(env = process.env) {
  return _flag(env && env.KHY_DIFF_SPEC_V1, true);
}

/**
 * 当前活动主题的 diff 色板。主题缺键 / themeRegistry 异常 / 门控关
 * → 逐项回退 CC 字面量。纯查询、绝不抛。
 * @returns {{add:string, del:string, addWord:string, delWord:string, text:string}}
 */
function diffColors(env = process.env) {
  if (!diffSpecEnabled(env)) {
    return CC_DIFF;
  }
  try {
    const colors = require('./themeRegistry').getTheme().colors || {};
    return {
      add: colors.diffAdded || CC_DIFF.add,
      del: colors.diffRemoved || CC_DIFF.del,
      addWord: colors.diffAddedWord || CC_DIFF.addWord,
      delWord: colors.diffRemovedWord || CC_DIFF.delWord,
      text: CC_DIFF.text,
    };
  } catch {
    return CC_DIFF;
  }
}

// 折叠账本（[DESIGN-ARCH-157] §1 C 刀接线；先立真源，消费端逐刀迁移）。
// preview: 新建/删除文件整绿/整红预览的折叠行数上限；
// diffCollapsed: 结构化 diff 与 shell unified diff 折叠态的共同行上限
// （此前 REPL shell 路径为 120，收敛到 60 与 TUI 对齐）；
// expanded: 展开态不设数据截断上限（ink 仍负责终端换行）。
const FOLD = Object.freeze({
  previewCollapsed: 10,
  diffCollapsed: 60,
  expanded: Infinity,
});

/**
 * 词级高亮三端统一开关（D 刀接线）。解析顺序：
 * KHY_DIFF_WORD_HIGHLIGHT（新名，三端共用）> KHY_TUI_WORD_DIFF（旧名，兼容既有排障手册）> 默认开。
 */
function wordHighlightEnabled(env = process.env) {
  const v = env && env.KHY_DIFF_WORD_HIGHLIGHT;
  if (String(v == null ? '' : v).trim()) {
    return _flag(v, true);
  }
  const legacy = env && env.KHY_TUI_WORD_DIFF;
  if (String(legacy == null ? '' : legacy).trim()) {
    return _flag(legacy, true);
  }
  return true;
}

module.exports = {
  CC_DIFF,
  FOLD,
  diffSpecEnabled,
  diffColors,
  wordHighlightEnabled,
};
