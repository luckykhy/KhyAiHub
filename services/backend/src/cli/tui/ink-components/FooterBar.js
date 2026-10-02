'use strict';

/**
 * FooterBar — status bar showing model, effort, context usage, permission mode.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

// CC 后端口径对齐:页脚上下文段不只显示百分比,还显示「已用 / 窗口」两个 token 数。
// CC 的 BuiltinStatusLine(src/components/BuiltinStatusLine.tsx:88-90)渲的是
//   `Context {pct}% ({formatTokens(usedTokens)}/{formatTokens(window)})`,
// 其中 usedTokens 是输入侧占用之和(input+cache_creation+cache_read),与百分比同源
// (StatusLine.tsx:526-532)。Khy 原先只渲窗口大小 `(200k)`,把已经算出来的占用 token 数
// (query.contextTokens,即 useQueryBridge 的输入侧占用口径,见 project_cc_token_count_semantics)
// 丢弃了——百分比从它算出却从不显示这个数本身。
//   复用 ccFormat 的 ccFormatTokens(紧凑 token 格式 SSOT,CC formatTokens 的忠实移植)把
//   两个数都渲成 "24k"/"200k",与 CC 完全一致(0 占用渲 "0",对齐 CC 会话开局的 "0/200k")。
//   门控 KHY_CONTEXT_FILL_SHOW_USED(默认开)→ `{pct}% ctx ({used}/{window})`;
//   关 → 逐字节回退旧的「只显示窗口」`{pct}% ctx ({window}k)`。
//   ccFormat require 包在 try 里,任何异常静默回退窗口口径,绝不让页脚渲染抛错。
function buildContextStatus(contextPct, usedTokens, contextLimit, env = process.env) {
  if (!contextLimit) {
    return '';
  }
  const pct = contextPct || 0;
  const v = String((env && env.KHY_CONTEXT_FILL_SHOW_USED) || '')
    .trim()
    .toLowerCase();
  const showUsed = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (showUsed) {
    let fmt = null;
    try {
      fmt = require('../../ccFormat').ccFormatTokens;
    } catch {
      fmt = null;
    }
    if (typeof fmt === 'function') {
      const used = Math.max(0, Number(usedTokens) || 0);
      return `${pct}% ctx (${fmt(used)}/${fmt(contextLimit)})`;
    }
  }
  // byte fallback:旧的「只显示窗口」口径。
  return `${pct}% ctx (${Math.round(contextLimit / 1000)}k)`;
}

// CC 后端口径对齐:页脚显示的模型名走 CC 同款「模型 ID → 友好显示名」派生,而非裸 slug。
// 派生逻辑收敛到中性纯叶子 `cli/ccModelName.js`(镜像 CC 源 `utils/model/model.ts
// renderModelName`,正如 ccFormat.js 镜像 `utils/format.ts`)——页脚 / classic 启动横幅 /
// TUI welcome 横幅都委托到同一个 SSOT,杜绝各处各写一套近似解析。
//   门控 KHY_MODEL_DISPLAY_NAME(默认开)→ 友好名;关 → 逐字节回退裸 slug(旧行为)。
//   require 包在 try 里:任何异常静默回退裸 slug(对齐 CC 未命中 null→raw 兜底),
//   绝不让页脚渲染抛错。
function formatModelLabel(model, env = process.env) {
  try {
    const fn = require('../../ccModelName').formatModelLabel;
    if (typeof fn === 'function') {
      return fn(model, env);
    }
  } catch {
    /* fall through to raw */
  }
  return String(model == null ? '' : model).trim();
}

function FooterBar({
  model,
  effort,
  permissionMode,
  contextPct,
  contextTokens,
  contextLimit,
  localMode,
  fastMode,
  voiceMode,
  autoRedPass,
  goalActive,
  contextPlan,
  cooldownUntilMs,
  modelStatus,
  pinnedSkip,
  cols,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // BUG-012 宽度预算:页脚是 height:1 的单行,任何一段超宽都会把行尾挤出终端列数,
  // 闭合括号折到下一行留残影(2026-09-20 实测 ~125 列窗口,windsurf 停用回退长警告两次复现)。
  // 修法:App 把 effectiveCols 解析出的列宽经 `cols` prop 传入(effectiveCols 契约禁止
  // 叶子自读 process.stdout.columns,故走 props),对唯一的可变长段——网关警告——
  // 按显示宽度预算截断;cols 未传(PreviewLayout 等旁路)时保持原样不预算。
  const _cols = Number(cols) > 0 ? Number(cols) : 0;
  const _displayWidth = (() => {
    try {
      const { displayWidth } = require('../../formatters');
      if (typeof displayWidth === 'function') return displayWidth;
    } catch {
      /* formatters unavailable → fall back to .length */
    }
    return (s) => String(s).length;
  })();

  // 语言偏好感知标签——对齐项目已有策略(renderTheme.js:64-68):默认中文,仅当 KHY_UI_LANG
  // 或 KHY_LANGUAGE 显式为 en/en-us/english 时走英文。Ink TUI 页脚此前硬编码英文标签,
  // 与全站中文默认策略(思维动词/阶段名/经典 REPL 均默认中文)不一致——此处补齐语言感知,
  // 既提升人机交互友好度(中文用户的母语足迹减少认知负担),又保留英文用户的选择逃生口。
  const uiLangPref = String(process.env.KHY_UI_LANG || process.env.KHY_LANGUAGE || '')
    .trim()
    .toLowerCase();
  const preferEnglishUi = /^(en|en-us|english)\b/.test(uiLangPref);

  const permLabels = preferEnglishUi
    ? {
        default: 'ask permissions',
        acceptEdits: 'accept edits',
        plan: 'plan mode (read-only)',
        bypass: 'bypass permissions on',
        RedPass: 'RedPass (adversarial)',
      }
    : {
        default: '询问权限',
        acceptEdits: '接受编辑',
        plan: '规划模式（只读）',
        bypass: '绕过权限',
        RedPass: '破甲测试（红队）',
      };
  const permColors = { acceptEdits: 'green', plan: 'cyan', bypass: 'yellow', RedPass: 'red' };
  const permLabel = permLabels[permissionMode] || permLabels.default;
  const permColor = permColors[permissionMode];

  // max/high/medium/low are KHY's own presets; xhigh/minimal come from codex
  // config.toml model_reasoning_effort (sourced via ai.getActiveEffort).
  const effortLabels = {
    max: '最大强度',
    xhigh: '超高强度',
    high: '高强度',
    medium: '中强度',
    low: '低强度',
    minimal: '最小强度',
  };
  const effortStr = effortLabels[effort] || effort || '';

  const ctxStr = buildContextStatus(contextPct, contextTokens, contextLimit);

  // 自动压缩倒计时。经典 REPL 早有这一段(_renderPermissionBar),Ink 页脚此前只渲
  // 「{pct}% ctx」,用户看不到「还有多久会压缩」。阈值取 contextPlan.autoCompactAt ——
  // 由 contextRouter.autoCompactTriggerTokens 从本轮真实预算推导(routeContextStrategy
  // 触发条件的代数逆),故倒计时归零与真实压缩同刻发生,不会像比例式那样提前十几个百分点。
  //   门控 KHY_CONTEXT_WARNING(默认开,与经典 REPL 同一个门);关/异常/首轮前 → 不渲该段
  //   (逐字节回退今日页脚)。CC 的「只在警告带内才提示」由 contextWarning 叶子负责。
  //   段以纯文本+色收集(BUG-012 宽度预算需要实测每段宽),转 JSX 在段表统一做。
  let compactSeg = null;
  try {
    const at = contextPlan && contextPlan.autoCompactAt;
    if (at > 0) {
      const cw = require('../../contextWarning');
      if (cw.isEnabled(process.env)) {
        const decision = cw.buildContextWarning({
          tokenUsage: Math.max(0, Number(contextTokens) || 0),
          contextWindow: contextLimit,
          autoCompactEnabled: true,
          autoCompactThresholdTokens: at,
        });
        if (decision.show) {
          const color =
            decision.style === 'error' ? 'red' : decision.style === 'warning' ? 'yellow' : null;
          compactSeg = { text: '  ' + decision.text, color, dim: !color };
        }
      }
    }
  } catch {
    /* fail-soft:不渲倒计时,页脚其余部分照常 */
  }

  // Model status: if backend reports the model is unavailable/error, show warning
  const modelWarning = modelStatus && modelStatus.status === 'error' ? '⚠ ' : '';
  const modelLabel = modelWarning + formatModelLabel(model);
  const leftParts = [modelLabel, effortStr].filter(Boolean).join(' · ');

  // 钉选通道被跳过（2026-09-17「页脚 agnes / 报错 windsurf」事故）：
  // 页脚原本只显示 getActiveAdapter() 给出的「能用」通道，于是出现「页脚说 agnes、
  // 报错说 windsurf」的上下矛盾。此处把「意图通道」也渲出来，形成
  // `windsurf→agnes-3.0-flash` 的双段标签 —— 两个名字同时在屏，用户一眼可对上报错。
  //   strict 时它是「下次请求必然失败」的硬预警（红）；非 strict 时只是「已回退」的
  //   中性提示（黄），语义不同故着色不同。
  //   截断保护（BUG-012 落地）：本段是页脚唯一可变长的段，App 传入 cols 时按
  //   「总宽 − 其余各段实测宽」的预算截断；预算不足以放下完整文案时降级为
  //   `⟲ <通道名>` 短标记（保住「哪个通道出事」这个最关键的信息），仍放不下才整段让位。
  const skipAdapter = pinnedSkip && pinnedSkip.active ? String(pinnedSkip.adapter || '') : '';
  const skipColor = pinnedSkip && pinnedSkip.strict ? 'red' : 'yellow';
  const skipTextFull = skipAdapter
    ? pinnedSkip.strict
      ? `⟲ ${skipAdapter} 通道已停用回退：请求失败将直接报错`
      : `⟲ ${skipAdapter} 通道不可用，已自动回退`
    : '';

  // CC 对齐:页脚左侧常驻一段「进程内存(RSS)· pid」,按阈值上色(512MB→warning,1GB→error)。
  // 判定在纯叶子 footerMemory 里;这里只读 process.memoryUsage().rss/pid(IO)并把 level 映射成
  // ink 颜色 props。门控关/异常 → seg 为 null → 不渲该段(逐字节回退今日「无内存段」页脚)。
  let memText = null;
  let memColor = null;
  try {
    const footerMemory = require('../footerMemory');
    const mem = footerMemory.buildFooterMemory({
      rssBytes: process.memoryUsage().rss,
      pid: process.pid,
    });
    if (mem) {
      memColor = mem.level === 'error' ? 'red' : mem.level === 'warning' ? 'yellow' : null;
      memText = mem.text;
    }
  } catch {
    /* footer memory segment is optional; never let it break footer render */
  }

  // 段表先行:所有段的纯文本先收集,宽度预算按实测显示宽度算,最后统一转 JSX。
  // (BUG-012:此前直接散写 JSX,没有任何一段知道自己占多少列,行尾溢出无人兜底。)
  const leftSegs = [{ text: '■ ' + permLabel, color: permColor }];
  if (localMode) leftSegs.push({ text: '  ◆ 本地模式 (/local)', color: 'green' });
  if (fastMode) leftSegs.push({ text: '  ◆ 快速模式 (/fast)', color: 'yellow' });
  if (voiceMode) leftSegs.push({ text: '  ◆ 语音模式 (/voice)', color: 'magenta' });
  if (autoRedPass) leftSegs.push({ text: '  ● 自动破甲 (拒绝时切换 RedPass)', color: 'red' });
  if (goalActive && goalActive.elapsedLabel != null) {
    leftSegs.push({
      text:
        '  ◎ /goal ' +
        (preferEnglishUi ? 'active' : '进行中') +
        ' (' +
        goalActive.elapsedLabel +
        ')',
      color: 'cyan',
    });
  }
  if (cooldownUntilMs > 0) {
    leftSegs.push({
      text: '  冷却 ' + Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000)) + 's',
      color: 'red',
    });
  }

  const rightSegs = [{ text: '[' + leftParts + ']', dim: true }];
  // 段间分隔:mem 文案以 `pid:<n>` 结尾、ctxStr 以 `<pct>%` 开头,直接相邻会
  // 拼成 `pid:305680% ctx`(2026-09-19 实测误读)。统一给每段 2 空格前缀。
  if (memText) {
    rightSegs.push({ text: '  ' + memText, dim: !memColor, color: memColor || undefined });
  }
  rightSegs.push({ text: '  ' + ctxStr, dim: true });
  if (compactSeg) rightSegs.push(compactSeg);

  // 网关警告段的预算:判定收敛在纯叶子 footerWidthBudget(BUG-012);这里只喂
  // 「其余各段实测宽 + 可用列数」并消费结果。cols 未传时叶子按 full 原样返回,
  // 与历史行为逐字节一致。
  let skipSeg = null;
  if (skipAdapter) {
    let skipText = skipTextFull;
    if (_cols > 0) {
      try {
        const otherWidth = leftSegs
          .concat(rightSegs)
          .reduce((acc, seg) => acc + _displayWidth(seg.text), 0);
        const budgeted = require('../footerWidthBudget').skipSegment({
          fullText: skipTextFull,
          shortMark: `⟲ ${skipAdapter}`,
          otherWidth,
          cols: _cols,
        });
        skipText = budgeted.text;
      } catch {
        /* fail-soft:预算叶子不可用 → 不截断,回退完整文案 */
      }
    }
    if (skipText) {
      skipSeg = { text: `  ${skipText}`, color: skipColor };
      rightSegs.splice(1, 0, skipSeg); // 紧跟 [model·effort] 之后,与其余右段同序
    }
  }

  // DESIGN-ARCH-102 C11:页脚恒 1 行(旧实现 2 行)。左侧:权限 + 模式徽标 +
  // goal/冷却;右侧:模型/强度 + 内存/pid + 上下文用量。空间不足时右侧段优先
  // 被 ink 裁切,左侧(权限决策)恒可见。
  // 单行页脚(102 C11):左侧=权限/模式徽标/goal/冷却,右侧=模型·内存·上下文。
  // 左侧各段前缀 `  ` 由 Text 自带(空格),ink 按显示宽度裁切(右侧先被裁,
  // 权限决策永远可见),段内文案不再加额外空格以省宽。
  const left = h(
    Box,
    null,
    leftSegs.map((seg, i) =>
      h(Text, { key: `L${i}`, dimColor: !seg.color, color: seg.color || undefined }, seg.text)
    )
  );
  const right = h(
    Box,
    null,
    rightSegs.map((seg, i) =>
      h(
        Text,
        { key: `R${i}`, dimColor: seg.dim && !seg.color, color: seg.color || undefined },
        seg.text
      )
    )
  );

  return h(
    Box,
    { justifyContent: 'space-between', height: 1 },
    left,
    right
  );
}

module.exports = FooterBar;
module.exports.buildContextStatus = buildContextStatus;
module.exports.formatModelLabel = formatModelLabel;
