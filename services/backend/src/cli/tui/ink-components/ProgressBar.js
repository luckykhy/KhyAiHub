'use strict';

/**
 * ProgressBar — differentiated progress indicator for the live region.
 *
 * Five visual modes, chosen by the `kind` prop:
 *
 *   kind: 'bytes'   → File download: ████░░░░ 12.4/56.8 MB · 2.1 MB/s
 *   kind: 'stage'   → Multi-phase:   ●●●○○ Step 3/5: Initializing database 42%
 *   kind: 'count'   → Item-based:    ████████░░ 8/18 adapters probed
 *   kind: 'time'    → AI wait:       ████░░░░░░ 42% ⏳ 12s 等待模型响应
 *   kind: 'pulse'   → Indeterminate: ████░░░░░░ 42% Preparing...
 *
 * Props (common):
 *   kind:    'bytes' | 'stage' | 'count' | 'time' | 'pulse'
 *   label:   string — human-readable description
 *   color:   optional override (default per kind)
 *   startedAt: number — 这一段等待**真实开始**的时刻（epoch ms）。给了它，节拍从那一刻起算，
 *            组件中途挂载时条不会从 0 重来（见 progressiveProgress.createPacer 的 startedAt）。
 *
 * Props (bytes):
 *   current: number — bytes downloaded
 *   total:   number — total bytes
 *   speed:   number — bytes/sec (optional, shows transfer rate)
 *
 * Props (stage):
 *   current: number — current stage (1-based)
 *   total:   number — total stages
 *
 * Props (count):
 *   current: number — items completed
 *   total:   number — total items
 *   percent: number — **可选**，0..100 的实时百分比。给了它，条形与百分比文案都用它，
 *            并且不再显示 `current/total`（那一对数说不了「进度」，六拍耗时极不均衡时
 *            它一出场就是 67% —— 见 startupBeats 的 PERCENT_* 注释）。
 *            **给了它就由调用方负责平滑**：本组件原样采信（只取整），不再叠加节拍追赶
 *            —— 例如启动屏传的是 startupBeats 已经按真实时间平滑推进过的实时百分比。
 *            不给 → 由本组件接管：分母已知走「1% 1% 追赶真实值」，分母未知走「1% 1% 逼近天花板」。
 *
 * Props (time):
 *   elapsed: number — milliseconds elapsed
 *   detail:   string — optional extra info (e.g. "↓ 3.2k tokens")
 *
 * Props (pulse):
 *   (none — just label + animation)
 *
 * ── 渐进节拍（用户目标：「宁可慢一些，1% 1% 地加载」）────────────────────────────
 * 修的两个病灶：① `pulse` / `time` 此前**没有百分比**，只有一枚走马灯或一个秒表 ——
 * 用户盯着它几十秒不动一个数，体感就是卡死；② `count` / `stage` 的分母很粗（5 拍、
 * 18 个适配器），一出场就是 20% / 67%，然后长时间静止。
 *
 * 现在每一条**没有调用方百分比**的进度都由 `services/progressiveProgress` 的节拍器驱动：
 * 整数百分比按 1% 的步长单调推进，分母已知时追赶真实值（永不越过），分母未知时逼近 96%
 * 天花板（永不谎报完成），`finish` 只来自真实完成。组件自持一个 `RENDER_MS` 的渲染节拍
 * （= progressiveProgress.STEP_MS），于是每一帧恰好 +1% —— 字面意义的「1% 1% 地加载」。
 *
 * 门控 KHY_PROGRESS_PACED（default-on·off=CANON）：关 → 逐字节回退今日观感
 * （`pulse` 回到走马灯、`time` 回到秒表、`count` 回到阶梯百分比）。减少动效
 * （`KHY_REDUCED_MOTION`）→ 只用真实值，不叠加节拍（假动效也是一种欺骗）。
 */
const React = require('react');
const h = React.createElement;
const inkRuntime = require('../inkRuntime');

let _progressive = null;
try {
  _progressive = require('../../../services/progressiveProgress');
} catch {
  _progressive = null;
}

const BAR_WIDTH = 20;

// 渲染节拍（ms）—— 与 progressiveProgress.STEP_MS 同值，每帧恰好推进 1%。
// 语义真源是**进度步长**（progressiveProgress），不是 spinner 帧率：早先从
// perfTunables.spinnerFrameMs 派生是错的 —— 那样 KHY_TUI_LOW_POWER 会把重绘放宽到
// 320ms 而步长仍是 160ms，于是一跳 2%，恰好推翻本文件上面那句「1% 1% 地加载」。
// 失败软化到 160。
const RENDER_MS = (() => {
  try {
    const v = Number(_progressive && _progressive.STEP_MS);
    return Number.isFinite(v) && v > 0 ? v : 160;
  } catch {
    return 160;
  }
})();

const REDUCED_MOTION = (() => {
  try {
    return _progressive ? _progressive.isReducedMotion(process.env) : process.env.KHY_REDUCED_MOTION === '1';
  } catch {
    return process.env.KHY_REDUCED_MOTION === '1';
  }
})();

const KIND_DEFAULTS = {
  bytes: { icon: '↓', color: 'cyan' },
  stage: { icon: '●', color: 'yellow' },
  count: { icon: '◆', color: 'green' },
  time: { icon: '○', color: 'magenta' },
  pulse: { icon: '·', color: 'cyan' },
};

// Pulse frames for indeterminate progress (legacy marquee — 门关时逐字节回退用)。
const PULSE_FRAMES = [
  '░░░░░░░░░░░░░░░░░░░░',
  '▒░░░░░░░░░░░░░░░░░░░',
  '▒▒░░░░░░░░░░░░░░░░░░',
  '▒▒▒░░░░░░░░░░░░░░░░░',
  '░▒▒▒░░░░░░░░░░░░░░░░',
  '░░▒▒▒░░░░░░░░░░░░░░░',
  '░░░▒▒▒░░░░░░░░░░░░░░',
  '░░░░▒▒▒░░░░░░░░░░░░░',
  '░░░░░▒▒▒░░░░░░░░░░░░',
  '░░░░░░▒▒▒░░░░░░░░░░░',
  '░░░░░░░▒▒▒░░░░░░░░░░',
  '░░░░░░░░▒▒▒░░░░░░░░░',
  '░░░░░░░░░▒▒▒░░░░░░░░',
  '░░░░░░░░░░▒▒▒░░░░░░░',
  '░░░░░░░░░░░▒▒▒░░░░░░',
  '░░░░░░░░░░░░▒▒▒░░░░░',
  '░░░░░░░░░░░░░▒▒▒░░░░',
  '░░░░░░░░░░░░░░▒▒▒░░░',
  '░░░░░░░░░░░░░░░▒▒▒░░',
  '░░░░░░░░░░░░░░░░▒▒▒░',
  '░░░░░░░░░░░░░░░░░▒▒▒',
  '░░░░░░░░░░░░░░░░░░▒▒',
  '░░░░░░░░░░░░░░░░░░░▒',
  '░░░░░░░░░░░░░░░░░░░░',
];

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// 门关时用的历史渲染器（逐字节 = 今日从前的输出）。
function legacyRenderBar(ratio, width = BAR_WIDTH) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function renderBar(ratio, width = BAR_WIDTH) {
  if (_progressive && typeof _progressive.renderBar === 'function') {
    return _progressive.renderBar(ratio * 100, width);
  }
  return legacyRenderBar(ratio, width);
}

/**
 * 这一段进度该不该由本组件自己接管平滑（= 调用方没给权威百分比）。
 * @param {object} props
 * @returns {boolean}
 */
function _needsOwnPacing(props) {
  if (!_progressive || !_progressive.isPacedEnabled(process.env)) return false;
  if (props.percent !== undefined && props.percent !== null) return false; // 调用方权威
  return true;
}

/** 分母是否已知（决定节拍走「追赶真实值」还是「逼近天花板」）。 */
function _determinateFor(props) {
  if (props.kind === 'bytes') return Number(props.total) > 0;
  if (props.kind === 'count') return Number(props.total) > 0;
  if (props.kind === 'stage') return Number(props.total) > 0;
  return false; // time / pulse 确定是「不知道要等多久」
}

/** 该 kind 是否具备真实百分比来源（决定要不要自持渲染节拍）。 */
function _realPercentFor(props) {
  if (props.kind === 'bytes') {
    const total = Number(props.total) || 0;
    if (total <= 0) return null;
    return ((Number(props.current) || 0) / total) * 100;
  }
  if (props.kind === 'count') {
    const total = Number(props.total) || 0;
    if (total <= 0) return null;
    return ((Number(props.current) || 0) / total) * 100;
  }
  if (props.kind === 'stage') {
    const total = Math.max(1, Number(props.total) || 1);
    const current = Math.min(Math.max(1, Number(props.current) || 1), total);
    return (current / total) * 100;
  }
  return null;
}

/**
 * 自持渲染节拍：只要这一段进度还需要自己推进（分母未知，或分母已知但显示值还没追上
 * 真实值），就按 RENDER_MS 重画一次 —— 每帧 +1%。追上 / 完成 / 减少动效 / 门关时**不挂**
 * 定时器（零空转，对齐本仓「不常开定时器」的纪律）。
 *
 * @param {boolean} active 是否还需要推进
 * @returns {number} 每帧自增的重绘计数（只用于触发 re-render）
 */
function usePacingClock(active) {
  const [, bump] = React.useState(0);
  React.useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => bump((n) => (n + 1) % 1000000), RENDER_MS);
    if (id && typeof id.unref === 'function') id.unref();
    return () => clearInterval(id);
  }, [active]);
  return 0;
}

function ProgressBar(props) {
  const { Text, Box } = inkRuntime.get();
  const kind = props.kind || 'pulse';
  const defaults = KIND_DEFAULTS[kind] || KIND_DEFAULTS.pulse;
  const label = String(props.label || '');
  const color = props.color || defaults.color;

  const ownPacing = _needsOwnPacing(props);
  const determinate = ownPacing ? _determinateFor(props) : false;
  const realPercent = ownPacing ? _realPercentFor(props) : null;

  // 节拍器：随 (kind,label,startedAt) 换代 —— 换标签即换了一段等待。
  // 确定进度的**起点播种为挂载那一刻的真实百分比**：挂载之后真实值若粗粒度跳变
  // （`done/total` 只有 5 拍），由节拍器 1% 1% 追赶；而挂载本身不该让条从 0 重来
  // （那会让「已经做了 40%」的活看起来刚起步）。播种值取整并受 cap 夹紧（不得谎报完成）。
  const pacerRef = React.useRef(null);
  const keyRef = React.useRef(null);
  const paceKey = `${kind}|${label}|${props.startedAt || ''}`;
  if (ownPacing && (pacerRef.current === null || keyRef.current !== paceKey)) {
    const seed =
      determinate && realPercent !== null && Number.isFinite(realPercent)
        ? Math.round(realPercent)
        : 0;
    pacerRef.current = _progressive.createPacer({
      determinate,
      static: REDUCED_MOTION,
      startedAt: props.startedAt,
      startPercent: seed,
    });
    keyRef.current = paceKey;
  }
  const pacer = ownPacing ? pacerRef.current : null;

  // 真实值每帧喂进去（确定进度据此追赶；真实值到 100 视同完成）。
  if (pacer && realPercent !== null) pacer.observe(realPercent);

  // 还需不需要推进？判据只有一个：这一车道**还有东西可动吗**（`settled()`）。
  // 分母未知 → 没到 TAIL_CAP(99) 就一直在动（`cap` 只是换档点）；分母已知 → 没追上真实值就继续走；
  // 已完成但显示值还在收尾路上（`done && shown < 100`）**也要继续重画** —— 旧实现在这里
  // 用 `isFinished()` 早停，于是收尾那几帧永远不画，条就停在 96% 然后由调用方直接跳满。
  const pacingActive = !!pacer && !REDUCED_MOTION && !pacer.settled();
  usePacingClock(pacingActive);

  if (kind === 'bytes') {
    const current = Number(props.current) || 0;
    const total = Number(props.total) || 0;
    const speed = Number(props.speed) || 0;
    const ratio = total > 0 ? current / total : 0;
    // 条与百分比读数**同源**：都由节拍器出（分母已知时它 1% 1% 追赶真实值，永不越过）。
    // 条与读数分家（一个走真实、一个走节拍）会自相矛盾，比粗粒度跳动更让人困惑。
    // `12.4/56.8 MB` 那一段仍是真实账本 —— 它不是进度条，是事实。
    const percent = pacer ? pacer.percent() : Math.round(ratio * 100);
    const barRatio = pacer ? percent / 100 : ratio;
    const speedStr = speed > 0 ? ` · ${formatSpeed(speed)}` : '';
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, renderBar(barRatio)),
      h(Text, { color }, ` ${formatBytes(current)}/${formatBytes(total)}`),
      h(Text, { dimColor: true }, ` (${percent}%${speedStr}) ${label}`),
    );
  }

  if (kind === 'stage') {
    const total = Math.max(1, Number(props.total) || 1);
    const current = Math.min(Math.max(1, Number(props.current) || 1), total);
    const filled = '●'.repeat(current);
    const empty = '○'.repeat(total - current);
    // 步子只有 3~6 拍 → 20% 一跳。补一个 1% 1% 走的百分比读数之后，用户才看得出
    // 「还在走」而不是「刚跳到 40% 就卡住了」。门关时不加（逐字节回退）。
    const paceSuffix = pacer ? ` ${pacer.percent()}%` : '';
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${filled}${empty} `),
      h(Text, { dimColor: true }, `Step ${current}/${total}: ${label}${paceSuffix}`),
    );
  }

  if (kind === 'count') {
    const current = Number(props.current) || 0;
    const total = Number(props.total) || 0;
    // 给了 percent 就用它（实时百分比，调用方权威），否则回退到 done/total 的阶梯值。
    const hasPercent = Number.isFinite(Number(props.percent));
    const ratio = hasPercent
      ? Math.max(0, Math.min(1, Number(props.percent) / 100))
      : total > 0
        ? current / total
        : 0;
    // 调用方给了 percent → 原样采信（它已经平滑过，且是权威）；没给 → 由节拍器把
    // 阶梯百分比摊成 1% 1% 走的曲线。条与读数同源，理由同 bytes 分支。
    const percent = hasPercent ? Math.round(ratio * 100) : pacer ? pacer.percent() : Math.round(ratio * 100);
    const barRatio = pacer && !hasPercent ? percent / 100 : ratio;
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, renderBar(barRatio)),
      hasPercent ? null : h(Text, { color }, ` ${current}/${total}`),
      h(Text, { dimColor: true }, ` ${label} (${percent}%)`),
    );
  }

  if (kind === 'time') {
    const elapsed = Number(props.elapsed) || 0;
    const detail = props.detail ? ` · ${props.detail}` : '';
    // 等待模型响应/工具返回时，此前只有一个秒表 —— 几十秒不动一个数，像卡死。
    // 门开时补一条 1% 1% 逼近天花板（恒不到 100）的条，让「还在干」可见。
    if (pacer) {
      const percent = pacer.percent();
      return h(
        Box,
        { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
        h(Text, { color }, `${defaults.icon} `),
        h(Text, { color }, renderBar(percent / 100)),
        h(Text, { color }, ` ${percent}% `),
        h(Text, { color }, formatTime(elapsed)),
        h(Text, { dimColor: true }, ` ${label}${detail}`),
      );
    }
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, `${formatTime(elapsed)}`),
      h(Text, { dimColor: true }, ` ${label}${detail}`),
    );
  }

  // kind === 'pulse' (indeterminate)
  if (pacer) {
    const percent = pacer.percent();
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, renderBar(percent / 100)),
      h(Text, { color }, ` ${percent}%`),
      h(Text, { dimColor: true }, ` ${label}`),
    );
  }
  const frameIdx = Math.floor(Date.now() / RENDER_MS) % PULSE_FRAMES.length;
  return h(
    Box,
    { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
    h(Text, { color }, `${defaults.icon} `),
    h(Text, { color }, PULSE_FRAMES[frameIdx]),
    h(Text, { dimColor: true }, ` ${label}`),
  );
}

module.exports = ProgressBar;
// 测试与布局计算用（bootLayout 依赖 BAR_WIDTH 的口径）。
module.exports.BAR_WIDTH = BAR_WIDTH;
module.exports.RENDER_MS = RENDER_MS;
module.exports.PULSE_FRAMES = PULSE_FRAMES;
module.exports._needsOwnPacing = _needsOwnPacing;
module.exports._determinateFor = _determinateFor;
module.exports._realPercentFor = _realPercentFor;