'use strict';

/**
 * TaskListPanel — 常驻任务清单面板(缺口②:TodoWrite 可见性 + 计划执行可见性)。
 *
 * 合并两源,渲染统一的 ✓/→/✗/○ 多行勾选列表(in_progress(→)行 cyan 高亮):
 *  - `tools/_taskStore.snapshot()`:模型主动调 TodoWrite/TaskCreate 的 V2 依赖图 + V1 清单;
 *  - `services/taskPanelState.getTasks()`:计划批准后 executePlan 逐步喂入的步骤进度
 *    (Ink 执行计划用 stub renderer,既不写 _taskStore 也不写 stdout,故计划进度此前
 *    只在 transcript 滚动、不进常驻面板——本合并把它接回输入框上方的面板)。
 * 面板挂在 App 的 live 区,靠现有 `nowTick` 1s heartbeat 自然重渲染。
 *
 * 视觉语言（2026-10-02 起，DESIGN-ARCH-176 §3.1「去线条、用底色分层」）：
 *  - **零线条**：无 round 外框、无 `— 标签 —` 分隔线。分组靠**中性底色块**表达。
 *  - **底色分层**：头行/分组 = 中性底色；进行中/错误 = 状态底色（无色与 unknown
 *    档自动退化为「不设底色」，见 ccThemeBg.js 的双维降级契约）。
 *  - **双重编码**：颜色失效时靠行首 `→ ✓ ✗ ○` 字形；`✗` 与 `○` 小字号易混，
 *    故 error 在无底色时由 taskSurface 追加 `!` 冗余标记。
 *  - 底色**不改字符数**（Ink 用空格逐行填充）⇒ 进度变化不触发 reflow ⇒ 零残影。
 *
 * 设计约束:
 *  - fault isolation:任何异常(store 未就绪/抛错/终端能力探测失败)一律 try/catch 吞掉,
 *    退回「无底色」安全档,清单是辅助显示,绝不能拖垮整个 TUI。
 *  - 空清单返 null(不占屏)。
 *  - 纯展示,无副作用,无订阅泄漏。
 *
 * 高度账本（改动本文件渲染时**必须**同步 App.js:6501 与 chromeRegistry.js 的
 * taskPanel 块 —— 三者是同一公式的两份实现 + 一处消费方）：
 *  头行(1) + 条目(N) + 尾切提示(0/1) = **1 + N + (hidden?1:0)**。
 *
 * 逃生阀 `KHY_TASK_PANEL`(默认 on,整个面板);`KHY_PLAN_TASK_PANEL`(默认 on,
 * 仅计划进度合并,关则字节回退为只读 _taskStore)。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

// 刀23:每行样式(含 completed ✓ 的 strikethrough,对齐 CC TaskListV2)由纯叶子 SSOT 收敛。
const { taskLineStyle } = require('./taskLineStyle');
// 刀28:头行按状态计数(total/完成/进行中/待办[/错误],对齐 CC TaskListV2 isStandalone 头行)。
const { buildTaskPanelHeader } = require('./taskPanelHeader');
// 2026-10-02(DESIGN-ARCH-176 §3.3):底色 token 层。**本组件是 App 层**,故在此解析
// 终端能力并把 tokens 算好传下去 —— 叶子(ccThemeBg/taskSurface)自己不读 env、不探测终端。
const ccThemeBg = require('../theme/ccThemeBg');
// 2026-10-02(§3.1):状态 → 底色 + 冗余标记。与 taskLineStyle(前景) 是通道分工。
const { surfaceForLine, surfaceForGroup } = require('./taskSurface');
const {
  mergeTaskLines,
  summarizeHiddenTaskLines,
  taskPriorityCapEnabled,
  splitTaskLinesBySource,
} = require('./taskPanelLines');

/**
 * 算本帧要用的底色 token。**故障隔离**：任何异常都退回「无底色」这一安全档
 * （面板是辅助显示，绝不能拖垮 TUI）。
 *
 * token 来源链：App 可显式传 `props.surfaceTokens`（测试/Storybook 可注入），
 * 否则按当前进程实测能力现算。`backgroundMode` 走 resolveBackgroundMode 的
 * **诚实判定**（判不出就是 unknown，不猜 dark —— 见 ccThemeBg.js §3.4.1）。
 */
function _surfaceTokens(props) {
  try {
    if (props && props.surfaceTokens && typeof props.surfaceTokens === 'object') {
      return props.surfaceTokens;
    }
    let depth = 24;
    try {
      const caps = require('../runtime/terminalCapabilities');
      if (caps && typeof caps.detectCapabilities === 'function' && caps.detectCapabilities().colorDepth) {
        depth = caps.detectCapabilities().colorDepth;
      }
    } catch {
      /* 能力探测不可用 → 保留 24（真彩色最常见） */
    }
    const mode = ccThemeBg.resolveBackgroundMode({
      colorfgbg: process.env.COLORFGBG,
      termProgram: process.env.TERM_PROGRAM,
    });
    return ccThemeBg.backgroundTokens({ colorDepth: depth, backgroundMode: mode });
  } catch {
    return null; // → surfaceForLine / surfaceForGroup 一律返 null ⇒ 不设 backgroundColor
  }
}

/**
 * 单行 → 行节点。底色与前景两个通道合并：
 *   - 前景：taskLineStyle（既有 SSOT，不动）
 *   - 背景：taskSurface（新增）
 * 底色取不到时（无色/unknown 档）把 taskSurface 的冗余标记**追加**到行尾
 * —— 行首图标已由 taskPanelLines 写入，这里只补「✗ 与 ○ 易混」所需的 `!`。
 */
function _taskRow(h, Text, line, key, tokens, env) {
  const surf = surfaceForLine(line, tokens);
  const text = surf.mark ? `${line} ${surf.mark}` : line;
  return h(
    Text,
    { key, backgroundColor: surf.backgroundColor || undefined, ...taskLineStyle(line, env) },
    text
  );
}

function TaskListPanel(props = {}) {
  // Two render modes:
  //  • Coordinated (App passes `lines`): App is the SSOT — it reads both sources
  //    ONCE, merges, and caps height via liveRegionBudget so the panel and
  //    StreamingBlock's reserve agree (keeps the live region < rows → no scroll
  //    jump). `hidden` is how many lines were tail-capped away.
  //  • Standalone (no `lines` prop): legacy self-read path (byte-revert; also what
  //    the unit tests exercise by calling TaskListPanel() directly).
  const coordinated = Array.isArray(props.lines);

  let lines;
  let hidden = 0;
  if (coordinated) {
    if (process.env.KHY_TASK_PANEL === '0') {
      return null;
    }
    lines = props.lines;
    hidden = Math.max(0, Number(props.hidden) || 0);
  } else {
    // Fault isolation: 两源均拉取式消费,任何异常都不得冒泡到 ink 渲染树。
    let snap = '';
    let planTasks = null;
    try {
      if (process.env.KHY_TASK_PANEL === '0') {
        return null;
      }
      const taskStore = require('../../../tools/_taskStore');
      snap = typeof taskStore.snapshot === 'function' ? taskStore.snapshot() : '';
      if (process.env.KHY_PLAN_TASK_PANEL !== '0') {
        const panelState = require('../../../services/taskPanelState');
        planTasks = typeof panelState.getTasks === 'function' ? panelState.getTasks() : null;
      }
    } catch {
      return null;
    }
    lines = mergeTaskLines(snap, planTasks);
  }

  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!lines.length) {
    if (process.env.KHY_DEBUG_TASK_PANEL === '1') {
      try {
        process.stderr.write(
          `[task-debug] TaskListPanel: lines empty, returning null (coordinated=${coordinated})\n`
        );
      } catch {
        /* non-critical */
      }
    }
    return null;
  }

  // 刀28:头行从静态 `任务清单` 升级为 CC 对齐的按状态计数。计数覆盖全量(可见
  // lines + 隐藏 hiddenLines);无法诚实覆盖全量或门控关 → buildTaskPanelHeader 返
  // '' → 逐字节回退静态标题 `任务清单`。
  const header =
    buildTaskPanelHeader({ lines, hidden, hiddenLines: props.hiddenLines }, process.env) ||
    '任务清单';

  // 语义分区(缺口②):把「本会话清单」(计划步骤 + V1 TodoWrite)与「项目任务 · 跨会话」
  // (持久化 large-task store)拆成带标签的两段,不再当成一种任务混显示。分组只在展示层进行,
  // header/hidden 仍消费未分组的扁平 `lines`(计数不变)。门控关 / 仅单一来源 → splitTaskLinesBySource
  // 返 null → 逐字节回退今日扁平渲染(键 `task-${i}` 与 taskLineStyle 完全一致)。
  //
  // 2026-10-02(DESIGN-ARCH-176 §3.1「去线条、用底色分层」):
  // 分组标签从 `— 标签 —`(两侧横线 = 线条滥用)改为**中性底色块**。
  // 底色块高度仍是 1 行 ⇒ 帧高不变(账本 P2 已把边框的 2 行摘掉,此处不新增行)。
  const groups = splitTaskLinesBySource(lines, process.env);
  const surfaceTokens = _surfaceTokens(props);
  const body = [];
  if (groups) {
    let gi = 0;
    for (const g of groups) {
      body.push(
        h(
          Box,
          { key: `task-group-${g.key}`, backgroundColor: surfaceForGroup(surfaceTokens) || undefined },
          h(Text, { dimColor: true }, g.label)
        )
      );
      for (const line of g.lines) {
        body.push(_taskRow(h, Text, line, `task-${gi}`, surfaceTokens, process.env));
        gi += 1;
      }
    }
  } else {
    lines.forEach((line, i) => {
      body.push(_taskRow(h, Text, line, `task-${i}`, surfaceTokens, process.env));
    });
  }

  const children = [
    h(
      Box,
      { key: 'task-title', backgroundColor: surfaceForGroup(surfaceTokens, 'head') || undefined },
      h(Text, { dimColor: true }, header)
    ),
    ...body,
  ];
  if (hidden > 0) {
    // 尾切提示:与 StreamingBlock「实时仅显示末尾」同款诚实告知,完整清单在本轮历史可回看。
    // 刀19:隐藏项按状态分解(对齐 CC TaskListV2.hiddenSummary)。分解来自被丢弃行的行首
    // 图标(真实结构),任一行无法识别或门控关 → bd 为 '' → 逐字节回退原始计数标记。
    // 刀30:优先级保活开启后,留下的不再是「末尾 N 行」而是「优先级最高的 N 行」
    // (进行中/待办优先),故去掉「末尾」二字以免谎称尾切;门控关回退「末尾」措辞。
    const bd = summarizeHiddenTaskLines(props.hiddenLines, process.env);
    const _tail = taskPriorityCapEnabled(process.env) ? '' : '末尾';
    children.push(
      h(
        Text,
        { key: 'task-hidden', dimColor: true },
        bd
          ? `⋯ 仅显示${_tail} ${lines.length} 项（另有 ${bd}）`
          : `⋯ 仅显示${_tail} ${lines.length} 项（另有 ${hidden} 项未显示）`
      )
    );
  }

  if (process.env.KHY_DEBUG_TASK_PANEL === '1') {
    try {
      process.stderr.write(
        `[task-debug] TaskListPanel: rendering ${lines.length} lines, hidden=${hidden}\n`
      );
    } catch {
      /* non-critical */
    }
  }

  // No marginTop: the panel sits directly above the prompt and its height is
  // fed into liveRegionBudget's ledger as line counts only — an extra margin
  // row would be unaccounted for and squeeze the prompt.
  //
  // 2026-10-02(DESIGN-ARCH-176 §3.1「去线条、用底色分层」)：**移除 round 外框**。
  // 理由三条：
  //  ① 线条滥用 —— 面板边界改由头行/分组行的**底色块边界**表达，零线条。
  //  ② 底色不改字符数(Ink `render-background.js:19` 用空格逐行填充)⇒ 不触发 reflow，
  //     而边框是 2 个**独立字符行**，改动会推动整树重排。
  //  ③ 账本已同步摘掉这 2 行：`App.js:6501` 的 `taskH` 与 `chromeRegistry.js` 的
  //     `taskPanel` 块**两处并行真源**同时 3 → 1。改框不改账本 ⇒ reserve 虚高
  //     ⇒ StreamingBlock 每帧被压矮 ⇒ 长输出时「莫名少行」。
  // paddingX 保留 1：底色块自身不带内边距，靠它让底色与文字之间留出呼吸位。
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...children
  );
}

module.exports = TaskListPanel;
