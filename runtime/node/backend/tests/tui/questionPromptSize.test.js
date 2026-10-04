'use strict';

/**
 * questionPromptSize.test.js — AskUserQuestion 浮层的「帧高随屏幕收敛」守卫(BUG-57)。
 *
 * 与 BUG-54/55/56 同族：`QuestionPrompt` 此前只接 `{request, onResolve}`，
 * 选项行 = `   ❯ 1. 标签  — 一整句中文说明`，**行宽与整框高度都不受终端约束**。
 * AskUserQuestion 的 description 是模型写的一整句话（中文一字两列），在 40×12
 * 这种又窄又矮的终端上，实测整框 19 行 > 屏幕 12 行，掉出去的最后 7 行里就含
 * 「Esc 取消」——用户看不见退出键（AL/repro-before.txt Q4）。
 *
 * 处方是三档退化阶梯，且**只在装不下时才动**：
 *   full → clip（按显示列截断补 …）→ labels（省掉说明，页脚明说「已省略选项说明」）
 * 计费口径全部走 wrapCell 的 `visualRows` / `pickerRowBudget` / `clipCell`，
 * 与另两个选择器共用同一真源。labels 档还顺手把页脚换成最小集：附加的提示文字
 * 若拼在完整页脚后面会把 2 行撑成 3 行，降档反而多占一行（实测 13 → 12）。
 *
 * 因此本文件锁两件事：装得下时**逐字节不变**（负对照），装不下时**帧高不超屏 +
 * 退化痕迹可见**。不传 cols/rows 必须与改前形态一致。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { visWidth } = require('../../src/cli/tui/wrapCell');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

/**
 * ink v6 的输入管线是 `readable` + `stdin.read()`，不是 'data'（见 modelPickerSize.test.js）。
 */
function pressableStdin() {
  const stream = new EventEmitter();
  const queue = [];
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => (queue.length ? queue.shift() : null);
  stream.push = (s) => {
    queue.push(Buffer.from(String(s)));
    stream.emit('readable');
  };
  return stream;
}

function frameStdout(columns, rows) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows || 24;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sliceFrame(buf) {
  const from = buf.lastIndexOf('╭');
  const to = buf.indexOf('╰', from);
  const out = (from === -1 || to === -1 ? buf : buf.slice(from, to))
    .split('\n')
    .map((r) => r.replace(/\s+$/, ''));
  // slice 停在 ╰ 之前 → 末尾多一个空元素，只剔这一个（中间的纯空白行是真实产物）。
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * 挂真组件渲染真帧，返回框内各行（不含下边框）。
 * `ttyCols` 只在「终端宽/高与组件所知不一致」的负对照里用。
 */
async function mount(request, cols, termRows, ttyCols) {
  const ink = await rt.loadInk();
  const Comp = require(path.join('..', '..', 'src', 'cli', 'tui', 'ink-components', 'QuestionPrompt.js'));
  const stdout = frameStdout(ttyCols || cols || 80, termRows);
  const instance = ink.render(
    React.createElement(Comp, { request, onResolve: () => {}, cols, rows: termRows }),
    { stdin: pressableStdin(), stdout, exitOnCtrlC: false, patchConsole: false }
  );
  let rows = [];
  try {
    let polled = '';
    for (let i = 0; i < 160; i += 1) {
      polled = stdout.getBuffer();
      const plain = stripAnsi(polled);
      if (plain.includes('╭') && plain.indexOf('╰', plain.lastIndexOf('╭')) !== -1) break;
      await wait(25);
    }
    rows = sliceFrame(stripAnsi(polled));
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  return rows;
}

// mount 的行切片不含下边框 ⇒ 整框高度 = rows.length + 1
const frameHeight = (rows) => rows.length + 1;
const widest = (rows) => rows.reduce((m, r) => Math.max(m, visWidth(r)), 0);
// 可见区：屏幕只有 termRows 行，最后一行留给下边框，所以「Esc 取消」要落在前 termRows-1 行内。
const escVisible = (rows, termRows) =>
  rows.slice(0, Math.max(0, termRows - 1)).some((r) => r.includes('Esc 取消'));
// 去掉边框再匹配：帧里每一行都以 │ 开头，选项行的「编号」不在行首。
const content = (rows) => rows.map((r) => r.replace(/[│╭╰─]/g, ''));
const optionRowCount = (rows) =>
  content(rows).filter((r) => /^\s*❯?\s*\d+\./.test(r)).length;
// 折行是 ink 按宽度切字符串，所以「整句是否还在」只能去空白后比对。
const flattened = (rows) => rows.join('').replace(/[\s│╭╰─]+/g, '');

function req(questions, multiSelect) {
  return {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: questions.map((q) => ({
        question: q.q,
        header: q.h,
        multiSelect: !!multiSelect,
        options: q.opts.map((o) => (Array.isArray(o) ? { label: o[0], description: o[1] } : { label: o })),
      })),
    },
  };
}

// 与真实 AskUserQuestion 载荷同形：标签几个字，说明是一整句（20-40 个汉字）。
const REAL = req([
  {
    q: '这个仓库的构建产物应该落在哪里？',
    h: '产物落盘',
    opts: [
      ['统一到 entries/', '所有可再生构建产物落 entries/<producer>，深度不超过两层，并在 BUILD-OUTPUTS.json 登记'],
      ['保持现状', '不动现有布局，只在文档里补一句说明，避免大面积改动带来的回归风险'],
      ['按模块分目录', '每个模块各自一个产物目录，便于单独清理，但需要在构建脚本里加参数解析逻辑'],
    ],
  },
]);

// 4 个选项是 AskUserQuestion 允许的上限，即最坏合法载荷。
const FOUR = req([
  {
    q: '这个仓库的构建产物应该落在哪里？',
    h: '产物落盘',
    opts: [
      ['统一到 entries/', '所有可再生构建产物落 entries/<producer>，深度不超过两层，并在 BUILD-OUTPUTS.json 登记'],
      ['保持现状', '不动现有布局，只在文档里补一句说明，避免大面积改动带来的回归风险'],
      ['按模块分目录', '每个模块各自一个产物目录，便于单独清理，但需要在构建脚本里加参数解析逻辑'],
      ['先只做文档', '把口径写进 DESIGN-LAY-004，等下一次大版本再动构建脚本，避免两件事互相牵连'],
    ],
  },
]);

const FULL_DESC = '所有可再生构建产物落 entries/<producer>，深度不超过两层，并在 BUILD-OUTPUTS.json 登记';

// 悬挂缩进的落点：值列 —— 断言里**不硬编码列号**，取选项标签实际出现的列（见下方用例）。
// ⚠ 宽度一律用 wrapCell 的 visWidth：Ink TUI 一侧的行计费单一真源是它；与
// cli/formatters 的 displayWidth 混用会让断言差 1 列（`❯` U+276F 在两者口径里不同）。

describeOrSkip('QuestionPrompt · 不传尺寸时逐字节保持改前形态(BUG-57 负对照)', () => {
  test('不传 cols/rows：组件完全不参与排版 —— 续行仍回左边界(= 改前形态)', async () => {
    const legacy = await mount(REAL, undefined, undefined, 80);
    const flat = content(legacy);
    // 改前形态的签名：说明折行后的续行从**卡片左边界**起（依赖 ink 自行软折），没有任何悬挂缩进
    const hung = flat.filter(
      (r) => /^\s{6,}\S/.test(r) && !/^\s*(❯\s*)?\d+\./.test(r)
    );
    expect(hung.length).toBe(0);
    expect(flattened(legacy)).toContain(FULL_DESC.replace(/\s+/g, ''));
    expect(legacy.join('\n')).not.toContain('已省略选项说明');
  });

  test('传了 cols：说明续行悬挂在**值列**之下(与权限卡的字段同一套口径)', async () => {
    const rows = await mount(REAL, 80, 24);
    const flat = content(rows);
    // 值列 = 选项标签实际出现的列(不硬编码缩进：框的左 padding 与 `❯` 的列宽都不必进断言)
    const labelCol = flat.find((r) => r.includes('统一到 entries/')).indexOf('统一到 entries/');
    expect(labelCol).toBeGreaterThan(0);
    // 至少有一条选项的说明折了行,且折出来的续行**与标签同列**(不是 0/左边界)
    const hung = flat.filter((r) => /^\s{6,}\S/.test(r) && !/^\s*(❯\s*)?\d+\./.test(r));
    expect(hung.length).toBeGreaterThan(0);
    for (const r of hung) expect((r.match(/^\s*/) || [''])[0].length).toBe(labelCol);
    // 说明一个字不丢
    expect(flattened(rows)).toContain(FULL_DESC.replace(/\s+/g, ''));
  });

  test('80×24：装得下就不降档(说明没被截、也没被省)', async () => {
    const rows = await mount(REAL, 80, 24);
    expect(flattened(rows)).toContain(FULL_DESC.replace(/\s+/g, ''));
    expect(rows.join('\n')).not.toContain('已省略选项说明');
    expect(escVisible(rows, 24)).toBe(true);
  });

  // 可读行宽上限：终端越宽,卡片越不该跟着变宽 —— 120 列表上说明铺满整行是「扫读困难」,
  // 页脚(约 62 列)也得整行放得下。上限取 76 内容列 ⇒ 卡片 ≤ 80 列。
  test('120×24：卡片按可读行宽收起(≤80 列),说明折行并悬挂,不铺满终端', async () => {
    const rows = await mount(REAL, 120, 24);
    expect(widest(rows)).toBeLessThanOrEqual(80);
    expect(rows.join('\n')).not.toContain('已省略选项说明');
    expect(flattened(rows)).toContain(FULL_DESC.replace(/\s+/g, ''));
    const flat = content(rows);
    const labelCol = flat.find((r) => r.includes('统一到 entries/')).indexOf('统一到 entries/');
    const hung = flat.filter((r) => /^\s{6,}\S/.test(r) && !/^\s*(❯\s*)?\d+\./.test(r));
    expect(hung.length).toBeGreaterThan(0);
    for (const r of hung) expect((r.match(/^\s*/) || [''])[0].length).toBe(labelCol);
    // 上限只在宽终端生效:80 列及以下的排版与「不设上限」逐字节相同(负对照在上一组用例)
    expect(escVisible(rows, 24)).toBe(true);
  });

  test('40×24：19 行的框仍装得下 24 行屏幕，说明一句没被截', async () => {
    const rows = await mount(REAL, 40, 24);
    expect(frameHeight(rows)).toBeLessThanOrEqual(24);
    expect(flattened(rows)).toContain(FULL_DESC.replace(/\s+/g, ''));
    expect(rows.join('\n')).not.toContain('已省略选项说明');
    expect(escVisible(rows, 24)).toBe(true);
  });
});

describeOrSkip('QuestionPrompt · 帧高随终端收敛(BUG-57)', () => {
  test('40×12 又窄又矮：改前 19 行的框现在 ≤12 行，Esc 提示在可见区里', async () => {
    const rows = await mount(REAL, 40, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(escVisible(rows, 12)).toBe(true);
    // 退化必须留痕：要么按列截断补了省略号，要么页脚明说省略了说明
    const flat = rows.join('\n');
    expect(flat.includes('…') || flat.includes('已省略选项说明')).toBe(true);
    // 三条选项 + 「可讨论」+ 「Other」都在，收缩不能靠吞掉可选项实现
    expect(optionRowCount(rows)).toBeGreaterThanOrEqual(3);
  });

  test('80×12：同一载荷本来就装得下，不因为本修复而变矮', async () => {
    const rows = await mount(REAL, 80, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    // 80 列下整句说明只折成两视觉行、仍在框内 —— 去空白比对，因为换行是 ink 按宽度切的
    expect(flattened(rows)).toContain(FULL_DESC.replace(/\s+/g, ''));
    expect(escVisible(rows, 12)).toBe(true);
  });

  test('最坏合法载荷(4 选项) · 40×12：仍在屏内，且每一项都还在列', async () => {
    const rows = await mount(FOUR, 40, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(escVisible(rows, 12)).toBe(true);
    for (const label of ['统一到 entries/', '保持现状', '按模块分目录', '先只做文档']) {
      expect(rows.some((r) => r.includes(label))).toBe(true);
    }
  });

  test('阶梯底部 · 40×8 矮到装不下任何一档：降到 labels 后停住，且不再多花一行', async () => {
    // 40 列下 labels 档的物理下限就是 12 行（上下边框 2 + 标题/问题 2 + 4 选项
    // + 可讨论 + Other + 页脚 2）。屏幕比它更矮时，收缩只能到此为止 —— 再往下
    // 就要吞掉选项本身，那是另一个契约（已作为 BUG-57b 登记，不在此偷偷做）。
    const rows = await mount(FOUR, 40, 8);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(rows.join('\n')).toContain('已省略选项说明');
    // 标签一个不少，省的是说明而不是选项
    for (const label of ['统一到 entries/', '保持现状', '按模块分目录', '先只做文档']) {
      expect(rows.some((r) => r.includes(label))).toBe(true);
    }
    // 页脚必须只占 2 视觉行：如果「已省略选项说明」拼在完整页脚后面，36 列内宽里
    // 是 74 列 = 3 行，降档反而比不降更占地方（实测 13 行 → 换紧凑页脚后 12 行）。
    expect(rows.slice(-2).join('\n')).toContain('Esc 取消');
    expect(rows.slice(-2).join('\n')).toContain('屏高不足');
  });
});
