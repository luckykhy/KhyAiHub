'use strict';

/**
 * PreviewLayout — 对齐 layout-preview.html 的终端主体布局。
 *
 * 结构（严格对齐预览图）:
 *   <column height:100%>
 *     <Topbar />                          ← 标题栏
 *     <banner />                          ← 横幅 (固定)
 *     <row flex:1>                        ← 主分割区
 *       <column flex:1>                   ← 左侧 MAIN (对话+工具+任务)
 *         <Static />                      ← 对话历史 (scrollback)
 *         <live tools />                  ← 流式工具调用
 *         <task panel />                  ← 任务清单
 *       </column>
 *       <Sidebar />                       ← 右侧 SIDEBAR (看板)
 *     </row>
 *     <bottom-fixed>                      ← 底部固定层
 *       <streaming spinner />
 *       <prompt />
 *       <footer />
 *     </bottom-fixed>
 *   </column>
 *
 * 复用所有现有叶组件，零业务逻辑重写。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');
const { Static } = inkRuntime.get();

const Topbar = require('./Topbar');
const Transcript = require('./Transcript');
const ToolLines = require('./ToolLines');
const TaskListPanel = require('./TaskListPanel');
const CompletionMenu = require('./CompletionMenu');
const Spinner = require('./Spinner');
const CompactionProgress = require('./CompactionProgress');
const PromptFrame = require('./PromptFrame');
const FooterBar = require('./FooterBar');
const Viewport = require('./Viewport');
const MemoMessageBlock = Transcript.MessageBlock;

function PreviewLayout(props) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const {
    titleBar = {},
    banner = null,
    staticItems = [],
    bannerElement = null,
    expanded = false,
    streaming = null,
    status = 'idle',
    // 压缩过程显示（规则 2.6）：query.compaction 在场时，忙态块挂 CompactionProgress
    // 进度条替代 spinner（压缩进度有自己的 UI，不叠加）。App 的 chrome 账本在压缩期间
    // 按 3 行记账，与本组件的条块行数（paddingY 0 + 条 2 行 + marginTop 1）一致。
    compaction = null,
    onToolErrorClick,
    taskProps = {},
    tasksHidden = false,
    nowTick = 0,
    value = '',
    offset = 0,
    placeholder = '',
    accent = null,
    vimEnabled = false,
    vimMode = 'INSERT',
    mic = null,
    completion = { active: false, items: [] },
    selectedIndex = 0,
    completionPage = 0,
    completionMarginLeft = 0,
    // App 的 chrome 账本给补全框留的行数预算。0/undefined = 不受高度约束。
    completionMaxRows = 0,
    // 补全框可用列数 —— 与 legacy 区域⑤ 同一口径(`_overlayCols`):rail 激活时
    // 是收窄后的宽度,否则全宽。undefined → 组件走 legacy 不钳列。
    completionCols,
    hint = '',
    footer = {},
    sidebar = {},
    overlays = null,
    width = 80,
    viewportHeight = 10,
    viewportScroll = 0,
    onViewportScroll,
    sidebarScroll = 0,
    onSidebarScroll,
    // 转录行投影(门控 KHY_INLINE_TRANSCRIPT,默认开)。null → 回退旧的「转录走 <Static>」
    // 行为,Viewport 里只放 live 工具 + 任务面板。
    lines = null,
    // 与 `lines` 同长同序的角色数组(供逐行着色);null → 不着色(逐字节回退)。
    lineRoles = null,
    // 折叠行逐条点击的命中回调(与 lineRoles 同源同帧);null → 不挂任何 handler。
    lineClickAt = null,
    emptyText = '',
  } = props;

  const busy = status !== 'idle' && status !== 'done';

  // 补全框 props —— 与 legacy 区域⑤ 的 `_completionMenuProps` **同形**,直接交给
  // CompletionMenu。组件自己判定 `frameFits(maxRows)`:预算不够就整框让位(return
  // null),账本(menuRowCount)也返 0 —— 两边同一判据,不会各算一份。
  const completionMenuProps =
    completion && completion.active && completion.items && completion.items.length > 0
      ? {
          completion,
          selectedIndex,
          page: completionPage,
          marginLeft: completionMarginLeft,
          cols: completionCols,
          maxRows: completionMaxRows,
        }
      : null;

  // 自适应分隔线生成器(避免硬编码长度导致折行)。
  // `dim` = 走 dimColor 而非亮色 —— 分隔线是**结构线**不是内容,不该抢眼。
  const sep = (color, len, dim = false) =>
    h(Text, dim ? { dimColor: true } : { color }, '─'.repeat(Math.max(1, len)));

  // 底部固定层顶上的分隔线宽度 —— **就是全宽**(= ink 可用列数)。
  //
  // 曾经想把它收窄到和输入框同宽,但那是错的:这条线是**底部固定层的上边界**,
  // 它上方的区域(转录视口 + 右栏看板)本来就是全宽的,线跟着全宽才闭合。
  // 用户抱怨的不是"它比输入框宽",而是"它**亮蓝**、比周围都跳"(截图实证:
  // 整条 `#58a6ff`,而输入框边框是 cyan、页脚是 dim)。故只改颜色,不改宽度。
  // 收窄由**颜色统一**解决观感,而不是靠制造新的宽度分歧。
  const sepCols = (() => {
    const n = Math.floor(Number(width));
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  // 内联转录模式:转录进应用内 Viewport(可滚、不被 fullscreen 清屏擦掉)。
  // 关 → 逐字节回退:Viewport 只放 live 工具 + 任务面板,转录仍走 <Static>。
  const inlineTranscript = Array.isArray(lines);

  return h(
    Box,
    { flexDirection: 'column' },
    // ── 标题栏 ──
    h(Topbar, titleBar),
    // ── 主分割区 ──
    // 横幅作为 Static 第一个元素(scrollback 顶部固定)。内联转录模式下 staticItems 只含
    // 横幅(转录由下方 Viewport 承载),不再依赖终端回滚缓冲。
    h(
      Box,
      { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' },
      // 左侧 MAIN
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
        // 横幅 (Static → scrollback,只画一次)
        h(Static, { items: staticItems }, (item) =>
          item.kind === 'banner'
            ? bannerElement
            : h(MemoMessageBlock, { key: item.key, msg: item.msg, expanded })
        ),
        // 内容区:内联转录模式下是**整段对话**;回退模式下是 live 工具 + 任务面板。
        // 固定高度 = App 的 chrome 账本预算,内容在视口内滚动,输入框不动。
        inlineTranscript
          ? h(Viewport, {
              height: viewportHeight,
              lines,
              // 逐行角色(与 lines 同长同序),让用户自己那几行与 AI 答复在形态上分开。
              // 不传 → Viewport 逐字节回退(见 Viewport.js 的硬承诺)。
              lineRoles,
              // 折叠行逐条点击(与 lineRoles 同源同帧)。不传 → 一行 handler 都不挂。
              lineClickAt,
              scroll: viewportScroll,
              onScroll: onViewportScroll,
              autoScroll: true,
              showIndicator: true,
              emptyText,
            })
          : h(
              Viewport,
              {
                height: viewportHeight,
                scroll: viewportScroll,
                onScroll: onViewportScroll,
                showIndicator: true,
              },
              // 子元素:工具调用
              streaming
                ? h(ToolLines, {
                    key: 'live-tools',
                    tools: streaming.tools,
                    expanded,
                    live: true,
                    onErrorClick: onToolErrorClick,
                  })
                : null,
              // 任务面板
              h(TaskListPanel, {
                key: 'task-panel',
                tick: nowTick,
                ...taskProps,
                ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}),
              })
            ),
        // 任务面板:内联转录模式下移到视口**之外**(全宽常驻,与 legacy 布局同款)。
        // 高度已由 App 的 chrome 账本从 viewportHeight 里扣掉,不会把 live 区顶过 rows。
        inlineTranscript
          ? h(TaskListPanel, {
              key: 'task-panel',
              tick: nowTick,
              ...taskProps,
              ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}),
            })
          : null
      ),
      // 右侧 SIDEBAR (可滚动)
      h(Sidebar, {
        data: sidebar,
        height: viewportHeight,
        scroll: sidebarScroll,
        onScroll: onSidebarScroll,
      })
    ),
    // ── 底部固定层 ──
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      // 顶部分隔线 —— 宽度保持全宽(见 `sepCols` 的说明:它是底部固定层的上边界),
      // 只把配色从亮蓝 `#58a6ff` 降为 **dim**。用户报「输入框上多一条线」的直接
      // 成因就是这条线亮蓝且比周围任何元素都跳(输入框边框 cyan、页脚 dim)。
      // chrome 账本(App.js `sepH`)已按 1 行给它记账,行数不变。
      sep(null, sepCols, true),
      busy
        ? h(
            Box,
            { paddingX: 2, paddingY: compaction ? 0 : 1 },
            compaction
              ? h(CompactionProgress, { compaction })
              : h(Spinner, { label: '执行计划中…' })
          )
        : null,
      // ── 补全下拉(/命令 · @文件)────────────────────────────────────────────
      // 缺陷修复:此前 PreviewLayout 解构了 completion/completionPage/
      // completionMarginLeft 却**从不渲染** —— 宽终端(>=122 列,即最大化)走的就是
      // 这条 early-return 分支,于是 legacy 渲染树里的区域⑤连同整棵树一起被丢弃,
      // 用户侧表现是「最大化后 / 菜单失效」。补全逻辑(useCompletions /
      // computeSlash / 键盘导航)一直都在,只是没人消费这份 props。
      // 位置与 legacy 一致:在输入框**上方**。
      // maxRows 必须与 App 的 chrome 账本同源 —— 窄屏画不下时组件整框让位
      // (`frameFits`),`menuRowCount` 归零,不会把 live 区顶过 rows(触发 ink
      // fullscreen 清屏)。故这里由 App 传入 `completionMaxRows`,缺省 0 = 不受
      // 高度约束(逐字节保持组件今日形态)。
      completionMenuProps ? h(CompletionMenu, completionMenuProps) : null,
      hint ? h(Text, { dimColor: true }, hint) : null,
      h(PromptFrame, {
        value,
        offset,
        busy,
        placeholder,
        accent,
        vimMode: vimEnabled ? vimMode : null,
        mic,
      }),
      h(FooterBar, footer)
    ),
    // 覆盖层
    overlays || null
  );
}

/**
 * Sidebar — 右侧看板，对齐预览图 .right-col 内容。
 * 工作目录 / 待办 / MCP / LSP / 工具 / 队列 / 通知 / 输入回显。
 */
function Sidebar({ data = {}, height = 10, scroll = 0, onScroll }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const lines = buildSidebarLines(data);
  const width = data.width || 45;

  // 内容行 —— **不再**手工前缀 `│ `。
  //
  // 缺陷修复:旧实现把边框字符拼进每一条内容文本(`'│ ' + ln.text`),于是
  //   ① 折行续行由 ink 从第 0 列重排 → 续行**没有**竖线,断成台阶
  //      (用户截图实证:`… gateway.init` / `timed out after 8s` 第二行左边无竖线);
  //   ② 竖线继承**所在行**的 `color`(`#58a6ff`/`#3fb950`/`#f85149` …)⇒ 每条
  //      颜色都不同,正是用户说的「竖线不美观」;
  //   ③ 竖线只贴到最后一条内容行,下方空区没有线 ⇒ 看板框不闭合。
  //
  // 正解是用 ink 自己的边框:外层 Box 加 `borderLeft`,由 ink 画**贯穿整个盒子
  // 高度、单一颜色**的竖线,内容另外用 paddingX 让出内边距。这样折行、空行、
  // 内容不足都不断线,且颜色由 `borderColor` 一处决定(统一 dim 灰)。
  const contentLines = lines.map((ln, i) =>
    h(
      Text,
      {
        key: 'sb-' + i,
        color: ln.color,
        dimColor: ln.dim,
        bold: ln.bold,
      },
      ln.text
    )
  );

  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      flexShrink: 0,
      // 竖线由 ink 画:贯穿整个盒子高度、**单一颜色**、折行不断。
      // `borderColor: 'gray'` 让边框统一走灰,不再跟随每行内容的颜色。
      // 内容内侧用 paddingX:1 让出呼吸位(原来是 '│ ' 里的那个空格)。
      borderStyle: 'single',
      borderLeft: true,
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      borderColor: 'gray',
      paddingX: 1,
    },
    // Viewport 撑满盒高:内容不足时竖线也画到底,看板框闭合。
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      h(Viewport, {
        height,
        scroll,
        onScroll,
        showIndicator: true,
      }, ...contentLines)
    )
  );
}

/**
 * 构建右栏行列表（纯函数，对齐预览图内容顺序）。
 */
function buildSidebarLines(data = {}) {
  const lines = [];
  const t = (s) => String(s == null ? '' : s);
  // 自适应分隔线长度 = 栏宽 − 左边框(1) − paddingX(2) − 留 1 列余量,避免折行。
  // (旧式 −4 是按「无边框 + paddingX:1」算的;现在多了 borderLeft 的 1 列。)
  const sepLen = Math.max(1, (data.width || 45) - 5);
  const sep = () => ({ text: '─'.repeat(sepLen), color: '#21262d', dim: true });

  // 工作目录
  if (data.workDir) {
    lines.push({ text: '工作目录', color: '#58a6ff', bold: true });
    lines.push({ text: t(data.workDir), color: '#8b949e' });
    lines.push(sep());
  }

  // 待办
  const todos = Array.isArray(data.todos) ? data.todos : [];
  if (todos.length > 0 || data.todos !== undefined) {
    lines.push({ text: `待办 (${todos.length})`, color: '#58a6ff', bold: true });
    for (const todo of todos.slice(0, 8)) {
      const mark = todo.done ? '✓' : todo.running ? '→' : '○';
      const color = todo.done ? '#3fb950' : todo.running ? '#58a6ff' : '#484f58';
      lines.push({ text: `  ${mark} ${todo.text || todo}`, color });
    }
    lines.push(sep());
  }

  // MCP
  const mcp = Array.isArray(data.mcp) ? data.mcp : [];
  if (mcp.length > 0) {
    lines.push({ text: `MCP (${mcp.length})`, color: '#58a6ff', bold: true });
    for (const s of mcp) {
      lines.push({ text: `  ● ${s.name || s}`, color: '#3fb950' });
    }
    lines.push(sep());
  }

  // LSP
  const lsp = Array.isArray(data.lsp) ? data.lsp : [];
  if (lsp.length > 0) {
    lines.push({ text: `LSP (${lsp.length})`, color: '#58a6ff', bold: true });
    for (const s of lsp) {
      lines.push({ text: `  ● ${s.name || s}`, color: '#3fb950' });
    }
    lines.push(sep());
  }

  // 工具列表
  const tools = Array.isArray(data.tools) ? data.tools : [];
  if (tools.length > 0) {
    tools.forEach((tool, i) => {
      lines.push({ text: `工具 ${i + 1}/${tools.length}`, color: '#d29922' });
      const icon = tool.error ? '✗' : tool.running ? '●' : '✓';
      const color = tool.error ? '#f85149' : tool.running ? '#58a6ff' : '#3fb950';
      lines.push({ text: `  ${icon} ${tool.name || 'tool'}`, color });
      if (tool.summary) {
        lines.push({ text: `    ${tool.summary}`, color: '#8b949e' });
      }
    });
    lines.push(sep());
  }

  // 队列
  const queueLen = data.queueLen || 0;
  lines.push({ text: `队列 ${queueLen} 条`, color: '#8b949e' });
  lines.push(sep());

  // 通知
  const notifications = Array.isArray(data.notifications) ? data.notifications : [];
  if (notifications.length > 0) {
    lines.push({ text: `通知 ${notifications.length} 条`, color: '#8b949e' });
    for (const n of notifications.slice(0, 3)) {
      lines.push({ text: t(String(n.title || n)), color: '#8b949e' });
    }
    lines.push(sep());
  }

  // 输入回显
  if (data.inputEcho) {
    lines.push({ text: `▸ ${data.inputEcho}`, color: '#484f58' });
  }

  return lines;
}

module.exports = PreviewLayout;
module.exports.Sidebar = Sidebar;
module.exports.buildSidebarLines = buildSidebarLines;
