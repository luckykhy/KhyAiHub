'use strict';

/**
 * PermissionsPrompt — arrow-key navigable overlay for tool approval/denial.
 *
 * Mirrors QuestionPrompt's interaction model (Claude Code style): it owns its own
 * keystrokes via ink's useInput (↑/↓ to navigate, Enter to choose, number keys to
 * jump, Esc to deny). App.js mounts it only while a permission control request is
 * pending and yields all keys to it, so there is no competing input handler.
 *
 * It adapts to the syscall gateway's risk level when the request carries one
 * (`input.level` = 'L1' | 'L2'):
 *   - L1 / classic (yellow): 允许本次 / 会话免审(或始终允许) / 拒绝 — default = allow.
 *   - L2 (red): 确认执行此高危操作 / 本会话内总是允许此类 / 拒绝 — allow-first, default =
 *     **确认执行** (用户知情决定，与普通框对齐；`KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off` 回退拒绝优先)。
 *     第三项「本会话内总是允许此类」仅当 `KHY_L2_SESSION_ALLOW`（默认开）启用时渲染，关闭即消失。
 *     选项排序由单一真源 permissionOptionOrder.orderOptions 决定；二者均经 env 门控可逆。
 *
 * ── 两种形态(门控 `KHY_PERMISSION_NOTICE`,默认开)───────────────────────────
 * 授权框与转录(输出区)的行预算零和 —— 框多一行,转录就少一行。被审对象的证据长度
 * 不由我们决定(一条 200 列的命令就是 200 列),所以框里只留**决定所需的最小充分集**,
 * 证据全文由 permissionNotice.buildRecord 推到输出区(请求到达时入转录,决定后仍在):
 *
 *   · 紧凑形态(默认)  框 = 标题/等级/动作·范围/资源一行预览/风险一句 + 选项 + footer。
 *                      行数只与**字段个数**有关,与字段长短无关 —— 框高因而可记账
 *                      (frameRowCount),App.js 的 chrome 账本据此为它留行,不再顶穿 live 区。
 *                      资源预览被裁时补「↑全文见上」,指路只在真的裁了的时候出现。
 *   · 旧形态(门控关)  证据全在框内(资源预折行 + 说明全文),框高随证据长度增长,
 *                      逐字节回到今天的渲染;frameRowCount 返回 null(= 不记账)。
 *
 * Resolution payloads (consumed by _decisionFromControl AND the gateway's
 * makeControlPrompter, both of which tolerate primitives and {behavior} objects):
 *   允许本次          → true            (allow once)
 *   会话免审/始终允许 → 'always'        (allow-always → gateway maps to session)
 *   一起讨论          → { behavior:'discuss' }  (dependency-install only; hands the
 *                       decision back to the AI⇄user conversation — installs nothing)
 *   拒绝              → false           (deny)
 *   确认执行(L2)      → { behavior:'allow', typed:<confirmWord> }  (typed confirm)
 *   本会话总是允许(L2)→ { behavior:'allow-always', typed:<confirmWord>, scope:'session' }
 *                       (typed confirm + 本会话同类 L2 免审；后端经 KHY_L2_SESSION_ALLOW 门控授予)
 */
const React = require('react');

// 「允许优先」排序的单一真源(纯叶子)。L1 选项本就允许在首位 → 无操作;L2 高危默认
// 保留「拒绝」首位的安全护栏(除非用户显式 opt-in),由 orderOptions 的 highRisk 分支处理。
const permissionOptionOrder = require('../../../services/permissionOptionOrder');
// L2 会话免审门控（默认开，可逆）的单一真源——决定是否渲染「本会话内总是允许此类」第三项。
const { isL2SessionAllowEnabled } = require('../../../services/syscallGateway').permissionCache;
const permissionFieldRows = require('../permissionFieldRows');
// 卡片排版语法(贴合内容宽 / 列对齐 / 右对齐尾注 / 一行一格)的单一真源 —— 与询问框同一套。
const cardLayout = require('../cardLayout');
// 「卡里说什么 / 输出区说什么」的单一真源(信息行 + 证据全文 + 门控 + 行宽口径)。
const permissionNotice = require('../permissionNotice');
// [DESIGN-ARCH-146] 点击门控（与 QuestionPrompt 同一叶子真源，保证两卡口径一致）。
const cardClick = require('./cardClick');
const inkRuntime = require('../inkRuntime');

const MARKER = '❯';

/** `borderStyle: 'round'` (1 col each side) + horizontal padding (1 col each side). */
const BOX_CHROME_COLS = permissionNotice.BOX_CHROME_COLS;
/**
 * 框内资源/命令行预览的显示列上限。封顶的理由是**卡宽**：资源行若按可用宽去裁，
 * 一条长命令就把整张卡撑到满宽，卡片又变回「左边几十列有字、右边一大片空白」。
 * 上限之外的部分由输出区记录承载（`↑全文见上` 指路）。
 */
const RESOURCE_PREVIEW_COLS = 56;
/**
 * 卡内 diff 预览的行数上限。超出部分不在卡里画（`hidden` 行由输出区记录的全文承载）。
 * 依据同 RESOURCE_PREVIEW_COLS：预览的作用是「认得出这是什么、有多大」，不是全文。
 */
const DIFF_PREVIEW_MAX_ROWS = 12;

function inputOf(request) {
  return request && request.input && typeof request.input === 'object' ? request.input : {};
}

function toolNameOf(request) {
  return (request && (request.tool_name || request.tool)) || '未知';
}

/**
 * 选项规划 —— 渲染与帧高记账(frameRowCount)**共用同一份**。
 *
 * 为什么必须共用:「有几项」直接决定框有几行,账本与画面各写一份公式就是
 * 「账本说 8 行、画面画 10 行」这类只有真实终端才现形的漂移(chromeBudget
 * 文件头记的正是这种三处各算一份的历史)。
 *
 * @param {object} input 控制请求的 input
 * @returns {{level:string,isL2:boolean,isGateway:boolean,confirmWord:string,
 *   wantsDiscuss:boolean,l2SessionAllowed:boolean,options:Array<object>}}
 */
function planOptions(input) {
  const level = String((input && input.level) || '').toUpperCase(); // 'L1' | 'L2' | '' (classic)
  const isL2 = level === 'L2';
  const isGateway = level === 'L1' || level === 'L2';
  const confirmWord = (typeof input.requireTyped === 'string' && input.requireTyped) || 'YES';

  // A request may advertise extra decisions via input.options (e.g. the
  // dependency-install heal prompt offers 'discuss' = 先一起讨论再决定). We only
  // render an advertised option we know how to resolve, so unknown UIs stay
  // binary-compatible and a request that omits options keeps the classic rows.
  const advertised = Array.isArray(input.options)
    ? input.options.map((o) => String(o).toLowerCase())
    : [];
  const wantsDiscuss = advertised.includes('discuss');
  // 第三项「本会话内总是允许此类高危操作」仅在 L2 会话免审门控开时渲染（关闭即字节回退为两项）。
  const l2SessionAllowed = isL2SessionAllowEnabled();

  const builtOptions = isL2
    ? [
        // 仍以「拒绝优先」授权，实际排序交给 permissionOptionOrder.orderOptions（允许优先默认开）。
        { key: 'deny', label: '拒绝', resolve: () => false, danger: false, tail: '3' },
        {
          key: 'confirm',
          label: `确认执行此高危操作（${confirmWord}）`,
          resolve: () => ({ behavior: 'allow', typed: confirmWord }),
          danger: true,
        },
        ...(l2SessionAllowed
          ? [
              {
                key: 'session',
                label: `本会话内总是允许此类高危操作（${confirmWord}）`,
                resolve: () => ({ behavior: 'allow-always', typed: confirmWord, scope: 'session' }),
                danger: true,
              },
            ]
          : []),
      ]
    : [
        { key: 'once', label: '允许本次', resolve: () => true, danger: false },
        {
          key: 'session',
          label: isGateway ? '本会话内同类免审' : '始终允许此工具',
          resolve: () => 'always',
          danger: false,
        },
        ...(wantsDiscuss
          ? [
              {
                key: 'discuss',
                label: '一起讨论（先不安装，让 AI 给方向）',
                resolve: () => ({ behavior: 'discuss' }),
                danger: false,
              },
            ]
          : []),
        { key: 'deny', label: '拒绝', resolve: () => false, danger: false },
      ];
  // 「允许优先」:把允许/中性类选项排前、拒绝类下沉到末尾(单一真源,门控默认开)。
  // L1 本就允许在首位故为无操作;L2 高危默认保留「拒绝」首位的护栏(highRisk 分支)。
  const options = permissionOptionOrder.orderOptions(builtOptions, { highRisk: isL2 });
  return { level, isL2, isGateway, confirmWord, wantsDiscuss, l2SessionAllowed, options };
}

/**
 * 写入前 diff 预览的行(editDiffPreview,「让 TUI 拥有 CC 一样的真 code 生产能力」)。
 * 渲染与记账共用:返回 `{rows, filePath, hidden}` 或 null。**绝不抛**(预览坏了不该挡住授权)。
 *
 * `rows` 已按 `DIFF_PREVIEW_MAX_ROWS` **封顶**,`hidden` 是被收起的行数：卡内只放预览，
 * 全文由 permissionNotice.buildRecord 落到输出区(`↑全文见上` 指的正是它)。这一手与
 * openCode 的 `maxHeight: 15` + fullscreen 开关同源 —— 长内容不该把决策卡撑爆。
 */
function writeDiffOf(request) {
  try {
    const dp = inputOf(request).diffPreview;
    if (
      !dp ||
      typeof dp !== 'object' ||
      typeof dp.beforeContent !== 'string' ||
      typeof dp.afterContent !== 'string'
    ) {
      return null;
    }
    const TL = require('./ToolLines');
    const all = TL.buildWriteDiffRows(dp, true);
    if (!all || !all.length) {
      return null;
    }
    const rows = all.slice(0, DIFF_PREVIEW_MAX_ROWS);
    return {
      rows,
      hidden: all.length - rows.length,
      filePath: dp.filePath ? String(dp.filePath) : '',
    };
  } catch {
    return null;
  }
}

/**
 * 页脚文案 —— 组件渲染与 frameRowCount **共用同一份**（折行行数进账本，两处必须同源）。
 *
 * L2 允许优先生效时默认行=确认执行；显式回退（门控关或高危 opt-out）时默认行=拒绝。
 *
 * BUG-36(2026-09-21):footer 必须列出 handler **实际接受**的全部键类。上面的 useInput 对
 * L1/L2 共用同一段数字键直选逻辑（`navCh >= '1' && navCh <= '9'` → 立即 resolve），
 * 而 L1 分支与仓内其余浮层(QuestionPrompt / FormFlow / RewindPicker)都写了「数字键直选」，
 * 唯独 L2 两支漏写——实测在 L2 框里按 `2` 会直接发出「本会话内总是允许此类高危操作」
 * （探针 AA/repro-permission-digit-out.txt），比默认行的单次回车后果更重却不提示。
 * 此处只补齐告知（不改行为）；数字键在 L2 上是否应当降格为「仅移动光标」是策略问题，
 * 已另立 BUG-36b 待裁决。
 *
 * BUG-36b 已裁决(2026-09-24, [DESIGN-ARCH-146]):L2 采**两段式** —— 数字键/鼠标点击
 * 只移动光标或选中，须再按 Enter 才授权。故 L2 的 footer 必须相应写成「选中」而非「直选」，
 * 否则文案与行为再次背离（正是 BUG-36 的同一类错误）。
 *
 * ⚠ **长度是契约的一部分，不要"顺手缩短"**：footer 超过可用宽时由 `cardLayout.splitFooter`
 * 按 ` · ` 折成两行；**只有折行才保证 `Esc 取消` 落在行内**。实测（`avail≈56`，即 60 列终端）：
 *   旧文案 63 列 → 折 2 行，`默认「确认执行」· Esc 取消` 完整 ✓
 *   初版新文案 55 列 → **恰好不折**成单行，渲染时被卡宽裁成 `… Esc …` ✗（BUG-57 复发）
 * 故这里刻意保留 5 段结构（≈69 列）以维持折行。改这段文案前请先量 `visWidth` +
 * `splitFooter(t, avail)` 的最坏情形（参见 `.khy/diag/` 的同类量测）。
 */
function footerTextOf(isL2) {
  const l2AllowFirst = permissionOptionOrder._enabled() && permissionOptionOrder._highRiskOptIn();
  return isL2
    ? l2AllowFirst
      ? '↑/↓ 导航 · Enter 确认执行 · 数字键/点击 选中 · 默认「确认执行」· Esc 取消'
      : '↑/↓ 导航 · Enter 确认 · 数字键/点击 选中 · 默认「拒绝」· Esc 取消'
    : '↑/↓ 导航 · Enter 选择 · 数字键直选 · Esc 取消';
}

/**
 * 授权框的**确定帧高**(含上下边框) —— 供 App.js 的 chrome 账本扣行。
 *
 * 只有在紧凑形态下帧高才是确定的(行数 = 字段/选项个数,与内容长短无关),故门控关时
 * 返回 null:调用方保持今天的行为(不记账),绝不拿一个会漂移的数去扣行。
 *
 * @param {{request?:object, cols?:number}} arg
 * @returns {number|null} 帧高;非紧凑形态 / 入参不可用 → null
 */
function frameRowCount(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  if (!permissionNotice.noticeEnabled(process.env)) {
    return null;
  }
  try {
    const input = inputOf(a.request);
    const { isL2, l2SessionAllowed, options } = planOptions(input);
    // 「记住」行只在「总是允许」类选项真的会渲染时给（L2 会话免审可被门控关掉）。
    const infoRows = permissionNotice.cardRows(input, toolNameOf(a.request), {
      sessionAllow: isL2 ? l2SessionAllowed : true,
    });
    const diff = writeDiffOf(a.request);
    // diff 的头行恒占 1 行（文件路径 + 溢出提示都并进这一行）；正文行已封顶。
    const diffRows = diff ? 1 /* marginTop */ + 1 /* 头行 */ + diff.rows.length : 0;
    // 页脚在窄屏会折成两行(splitFooter)；那两行都要记账,否则画面比账本多一行。
    const footRows = cardLayout.splitFooter(
      footerTextOf(isL2),
      permissionNotice.contentColsOf(a.cols)
    ).length;
    // 标题(1) + 信息行 + diff + 空行(1) + 选项 + 页脚 + 上下边框(2)。
    // 左右各 1 列 padding 与卡宽都不加行 —— 帧高只与字段/选项个数有关,与内容长短无关。
    return 1 + infoRows.length + diffRows + 1 + options.length + footRows + 2;
  } catch {
    return null;
  }
}

function PermissionsPrompt({ request, onResolve, cols }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const input = inputOf(request);
  const toolName = toolNameOf(request);
  const command = input.command || input.cmd || input.script || '';
  const description = input.description || '';
  const { isL2, isGateway, l2SessionAllowed, options } = planOptions(input);
  // 紧凑形态(默认):证据去输出区,框内只留决定所需的最小充分集。
  const noticeOn = permissionNotice.noticeEnabled(process.env);

  // 允许优先（默认开）→ 排序后 index 0 = 确认执行，光标默认命中（回车=执行，与普通框对齐）。
  // KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off 时 L2 不重排 → index 0 = 拒绝（回退安全护栏）。
  const [cursor, setCursor] = React.useState(0);
  const count = options.length;

  const choose = (idx) => {
    const opt = options[idx];
    if (opt) {
      onResolve(opt.resolve());
    }
  };

  // [DESIGN-ARCH-146] 点击即可选中的总闸（与 QuestionPrompt 同一门控与同一叶子真源）。
  const clickEnabled = cardClick.cardClickEnabled(process.env);

  // [DESIGN-ARCH-146 / BUG-36b 裁决] L2 高危卡改**两段式**：数字键与鼠标点击只把光标
  // 移到该选项，必须再按 Enter 才真正授权。
  //
  // 动机（BUG-36 的后续）：数字键在 L2 上原本**一键直选**，按 `2` 会直接发出「本会话内
  // 总是允许此类高危操作」，比默认行的单次回车后果更重却无二次确认；加了鼠标点击后同一
  // 问题在点击上重演（误触即高危授权）。两段式让「选中」与「授权」成为两个动作。
  //
  // L1 不受影响（一键直选保留）：它是常规授权，多一次回车只会拖慢正当流程。
  // 这是策略变更，故与 footer 文案（footerTextOf）必须同步 —— 见 BUG-36 的教训：
  // 页脚必须列出 handler **实际接受**的全部键类。
  const twoStep = !!isL2;
  const moveOnly = (idx) => {
    if (idx >= 0 && idx < count) setCursor(idx);
  };

  useInput((ch, key) => {
    if (key.escape) {
      onResolve(false);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + count) % count);
      return;
    }
    if (key.downArrow || key.tab) {
      setCursor((c) => (c + 1) % count);
      return;
    }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (twoStep) {
        // 高危卡：数字键只移动光标（原为 choose(idx) 一键直选）。
        moveOnly(idx);
      } else if (idx >= 0 && idx < count) {
        choose(idx);
      }
      return;
    }
    if (key.return) {
      choose(cursor);
      return;
    }
  });

  const accent = isL2 ? 'red' : 'yellow';
  // 标题文案与紧凑卡同源(permissionNotice.cardTitle):两种形态说同一句话。
  const title = permissionNotice.cardTitle(input);

  // 写入前 diff 预览:当请求携带已算好的 {beforeContent, afterContent}(由 toolCalling 的
  // Ink 审批路径在批准前计算,门控 KHY_EDIT_DIFF_PREVIEW),复用工具结果视图同一套红/绿 ±
  // 渲染,把编辑画进授权框——让用户在写入前审阅改动,而非写入后才看到。expanded=true:在安全
  // 上限内尽量多显、且溢出文案诚实不承诺不存在的 Ctrl+O。缺预览 / 渲染异常 → 不显示。
  let diffBlock = null;
  const _diff = writeDiffOf(request);
  if (_diff) {
    const TL = require('./ToolLines');
    diffBlock = h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(
        Text,
        { dimColor: true },
        `± ${_diff.filePath ? `${_diff.filePath}  ` : ''}改动预览${_diff.hidden > 0 ? `（另有 ${_diff.hidden} 行见上方输出）` : ''}`
      ),
      TL.renderDiffRows(_diff.rows, h, Box, Text, true)
    );
  }

  // ── 紧凑形态(默认)─────────────────────────────────────────────────────────
  // 证据(资源全文 / 为什么 / 后果 / 撤销 / 工作区)由 permissionNotice.buildRecord 在请求
  // 到达时推进转录;卡里只留决定所需的最小充分集,并且按 cardLayout 的统一语法排:
  //   · **卡宽贴合内容**(`width = min(最宽行, 可用宽)`)—— 撑满终端只剩左边几十列有字、
  //     右边一大片空白,是「框又重又空」的头号来源;
  //   · **列对齐**—— 字段用 `标签 + 值`,标签列定宽,值从同一列起;
  //   · **右对齐尾注**—— 选项的快捷键(`1/2/3`)与标题的等级徽标/工具名贴右边界;
  //   · **一行一格**—— 每行裁成恰好一行,所以卡高只与字段/选项个数有关(可记账)。
  if (noticeOn) {
    const avail = permissionNotice.contentColsOf(cols);
    const rowSpecs = [
      {
        key: 'title',
        kind: 'title',
        head: permissionNotice.cardTitle(input),
        tail: permissionNotice.cardTitleTail(input, toolName),
      },
    ];
    const infoRows = permissionNotice.cardRows(input, toolName, {
      sessionAllow: isL2 ? l2SessionAllowed : true,
    });
    for (const r of infoRows) {
      // 资源/命令行**预览封顶**：让它按可用宽去裁的话，一行长命令就把整张卡撑到满宽
      // （「框又重又空」的老毛病）。卡里给一眼能认出「这是什么、多长」的预览，被裁时把
      // `↑全文见上` 作为**右对齐尾注**（与选项快捷键同一套），全文在输出区记录里。
      const budget = Math.min(RESOURCE_PREVIEW_COLS, Math.max(16, avail - 8));
      const clipped = r.pointer && cardLayout.visWidth(r.value) > budget;
      const value = r.pointer ? cardLayout.clipRow(r.value, budget) : r.value;
      rowSpecs.push({
        key: r.key,
        kind: r.kind,
        head: r.label ? `${r.label}${permissionNotice.LABEL_PAD}${value}` : value,
        tail: clipped ? cardLayout.POINTER : '',
      });
    }
    // 空行要占一行：ink 里 `<Text></Text>`（空串）**不画行**，账本会与画面差一行。
    rowSpecs.push({ key: 'gap', kind: 'blank', head: ' ' });
    options.forEach((opt, i) => {
      const active = i === cursor;
      rowSpecs.push({
        key: opt.key,
        kind: 'option',
        head: `${active ? MARKER : ' '} ${opt.label}`,
        // 尾注 = 数字键直选号(与 useInput 的 `navCh - 1 → idx` 同一口径,排序后才有意义,
        // 所以按**渲染下标**算,不能在 defs 里写死)。
        tail: String(i + 1),
        active,
        danger: !!opt.danger,
        // [DESIGN-ARCH-146] 点击命中用：选项在**排序后**数组里的下标（与光标口径一致）。
        optIndex: i,
      });
    });
    // 页脚一行放不下就折成两行(窄屏不许用 `…` 吃掉 `Esc 取消`)；行数与 frameRowCount 同源。
    cardLayout.splitFooter(footerTextOf(isL2), avail).forEach((ln, i) => {
      rowSpecs.push({ key: `footer${i}`, kind: 'footer', head: ln });
    });

    // diff 预览属于「这一步会改什么」，必须排在**选项之前**（与信息行同一区），
    // 不能落在页脚之后 —— 那是「已经画完卡片又补一段」的形态，读起来像两个面板。
    if (diffBlock) {
      const gapAt = rowSpecs.findIndex((r) => r.key === 'gap');
      rowSpecs.splice(gapAt < 0 ? rowSpecs.length : gapAt, 0, { key: 'diff', kind: 'diff', node: diffBlock });
    }

    // 只有「一行一格」的行进 cardLayout；diff 是自带多行版式的节点，按位插回去
    // （它在 rowSpecs 里的占位只用于保持顺序，宽度不参与卡宽计算 ⇒ head 为空）。
    const textSpecs = rowSpecs.filter((r) => r.kind !== 'diff');
    const laid = cardLayout.layoutCard(
      textSpecs.map((r) => ({ head: r.head, tail: r.tail, pointer: r.pointer })),
      avail
    );
    const colorOf = (r) => {
      if (r.kind === 'title' || r.kind === 'risk') return accent;
      if (r.kind === 'option') {
        return r.active ? (r.danger ? 'red' : 'cyan') : r.danger ? 'red' : undefined;
      }
      return undefined;
    };
    const dimOf = (r) => r.kind === 'field' || r.kind === 'footer';
    const children = [];
    let li = 0;
    for (const spec of rowSpecs) {
      if (spec.kind === 'diff') {
        children.push(spec.node);
        continue;
      }
      const ln = laid.lines[li];
      li += 1;
      const textProps = {
        key: spec.key,
        color: colorOf(spec),
        dimColor: dimOf(spec),
        bold: spec.kind === 'title' || !!spec.active,
      };
      // [DESIGN-ARCH-146] 选项行可点：命中即把光标移到该选项（两段式下**不**直接授权，
      // 与数字键同语义）。下标取 `optIndex`（排序后），保证点击落到用户看到的那一项 ——
      // 用原始 defs 下标会把授权决定反转（见方案 §6.3② 的实测）。
      //
      // ⚠ 必须包 `Box` 才能让 `onClick` 生效：ink 6 的 `Text` 是固定 props 白名单，
      // `onClick` 会被静默丢弃（落不到 `node.style`，而 `collectLayout` 只认它）。
      // 实证见 `.khy/feedback/DESIGN-ARCH-146-card-click/probe-box-vs-text.txt`。
      // 不可点时**原样**返回 `Text`，节点形态与改前一致（frameRowCount 账本不变）。
      const clickable =
        clickEnabled && spec.kind === 'option' && Number.isInteger(spec.optIndex);
      children.push(
        clickable
          ? h(
              Box,
              { key: spec.key, flexDirection: 'column', onClick: () => moveOnly(spec.optIndex) },
              h(Text, textProps, ln)
            )
          : h(Text, textProps, ln)
      );
    }
    return h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: accent,
        paddingLeft: 1,
        paddingRight: 1,
        // 卡宽 = 内容宽 + 边框/padding。explicit width 在 yoga 里是 border-box,所以加 chrome。
        // 带 diff 预览时**不设**显式宽度:预览由 ToolLines 自行排版(含行号/± 号,列宽不可预知),
        // 显式收窄会被 ink 二次折行、行数超出 frameRowCount(账本就假了)。行数仍然封顶,
        // 所以那一档最坏也只是「宽一点」,不会再无界变高。
        width: _diff ? undefined : laid.width + BOX_CHROME_COLS,
      },
      ...children
    );
  }

  // ── 旧形态(门控 KHY_PERMISSION_NOTICE=0)────────────────────────────────────
  // 证据全在框内。框高随证据长度增长(chrome 账本不为它扣行,frameRowCount → null),
  // 逐字节保持改前渲染。
  //
  // One `label + value` field, pre-wrapped so continuations hang under the value
  // (BUG-48). Without a `cols` budget the leaf refuses and we emit the historical
  // single Text node byte-for-byte, so every caller that has not threaded width
  // keeps its current output.
  const fieldNode = (key, label, value) => {
    const flat = `${label}${value}`;
    const cap = Math.floor(Number(cols));
    const width = Number.isFinite(cap) && cap > BOX_CHROME_COLS ? cap - BOX_CHROME_COLS : 0;
    const rows = permissionFieldRows.fieldRows({ label, value, width });
    if (!rows) return h(Text, { key, dimColor: true }, flat);
    if (rows.length === 1) return h(Text, { key, dimColor: true }, rows[0]);
    return h(
      Box,
      { key, flexDirection: 'column' },
      ...rows.map((ln, i) => h(Text, { key: `${key}r${i}`, dimColor: true }, ln))
    );
  };

  const meta = [];
  if (isGateway) {
    meta.push(h(Text, { key: 'lvl', color: accent, bold: true }, permissionNotice.riskTag(input.level)));
    const actionText = permissionNotice.meaningful(input.action);
    const scopeText = permissionNotice.meaningful(input.scope);
    if (actionText || scopeText) {
      meta.push(
        h(
          Text,
          { key: 'as', dimColor: true },
          `动作：${actionText || '未声明'}   范围：${scopeText || '未声明'}`
        )
      );
    } else {
      meta.push(h(Text, { key: 'as', dimColor: true }, '动作：未声明（该工具未提供动作与范围说明）'));
    }
    if (input.resource) {
      meta.push(fieldNode('res', '资源：', String(input.resource).slice(0, 200)));
    }
  }

  // 面向小白的执行前说明（Part D）：网关随 input 下发的、按难易/重要程度深浅
  // 不同的中文说明。仅渲染，缺失则不显示，保持原有布局。
  const explanationText =
    input.explanation && typeof input.explanation.text === 'string'
      ? input.explanation.text.trim()
      : '';
  const explanationBlock = explanationText
    ? h(
        Box,
        { flexDirection: 'column', marginTop: 1, marginBottom: 0 },
        ...explanationText.split('\n').map((ln, i) =>
          h(
            Text,
            {
              key: `ex${i}`,
              color: ln.startsWith('⚠') ? accent : undefined,
              dimColor: !ln.startsWith('⚠'),
            },
            ln
          )
        )
      )
    : null;

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: accent, padding: 1 },
    h(Text, { bold: true, color: accent }, title),
    h(Text, null, ''),
    h(Text, null, `工具：${toolName}`),
    ...meta,
    description ? h(Text, { dimColor: true }, description) : null,
    command ? fieldNode('cmd', '$ ', command) : null,
    explanationBlock,
    diffBlock,
    h(Text, null, ''),
    h(
      Box,
      { flexDirection: 'column' },
      ...options.map((opt, i) => {
        const active = i === cursor;
        const color = active ? (opt.danger ? 'red' : 'cyan') : opt.danger ? 'red' : undefined;
        const line = `   ${active ? MARKER : ' '} ${i + 1}. ${opt.label}`;
        // [DESIGN-ARCH-146] 旧形态（门控关）同样可点，否则两种形态行为不一致。
        // 同样必须包 `Box`（`Text` 的 `onClick` 不生效，理由见紧凑形态处的注）。
        return clickEnabled
          ? h(
              Box,
              { key: opt.key, flexDirection: 'column', onClick: () => moveOnly(i) },
              h(Text, { color, bold: active }, line)
            )
          : h(Text, { key: opt.key, color, bold: active }, line);
      })
    ),
    h(Text, null, ''),
    h(Text, { dimColor: true }, `  ${footerTextOf(isL2)}`)
  );
}

PermissionsPrompt.frameRowCount = frameRowCount;
PermissionsPrompt.planOptions = planOptions;

module.exports = PermissionsPrompt;
