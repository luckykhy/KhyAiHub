'use strict';

/**
 * modelPickerSize.test.js — /model 选择器的「一行一视觉行 + 帧高随屏幕收敛」守卫(BUG-56)。
 *
 * 与 BUG-54/55 同族：`ModelPicker` 此前既不接 cols 也不接 rows，`PAGE_SIZE` 是写死的 12。
 * 网关返回的模型 ID 是外部字符串(40+ 字符很常见)，未封顶的行在窄终端上折成两行，
 * 整框从 16 行涨到 22 行；矮终端(12 行)上框高 16 行 > 屏幕，掉出去的那一行正是
 * 「Enter 选择 · ↑/↓ 导航 · 打字搜索 · Esc 取消」——用户看不见退出键。
 * 实测见 .khy/feedback/tui-ux-audit-20260919/AK/repro-before.txt。
 *
 * 处方与回溯选择器一致：行内容过 `clipCell`(显示列口径)，分页过 `pickerPageRows`
 * 按真实帧高计费；本组件额外把「搜索: xxx」这一行回声行也计入(它只有自己知道)。
 *
 * 不传 cols/rows 时必须与改前形态一致(组件不参与裁剪/收缩)。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

/**
 * jest 默认 5s/条对**本文件第一条真渲染测试**太紧：它独自承担 ink 的动态载入
 * （`rt.loadInk()`）+ 首次挂载，`mount()` 内部轮询预算本身就有 ~4s（160×25ms）。
 * 实测（2026-10-01）：机器空时整轮 5.7s 全绿；机器忙时同一条报
 * `Exceeded timeout of 5000 ms`（整轮 36s / 56s），而单独给它 120s 时 **12.6s 通过**
 * ⇒ 是「冷启动 + 负载」，不是死循环。
 * 只放宽、不收紧：单条内部预算仍 ≤ 6s，30s 仍能捕获真死循环。
 */
jest.setTimeout(30000);

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

/**
 * ink v6 的输入管线是 `stdin.on('readable')` + `while (chunk = stdin.read())`
 * （node_modules/ink/build/components/App.js:104），不是 'data'。所以这个假 stdin
 * 必须自带一个可读队列，`push()` 才把按键喂进 useInput。
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
  stream.rows = rows || 40;
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
  // slice 停在 ╰ 之前，末尾必然带一个换行 → split 多出一个空元素。只剔这一个。
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * 挂真组件渲染真帧，返回 { rows, raw }。
 * `rows` = 去色后的框内各行（不含下边框）；`raw` = 同一帧未去色的字节，用来看 SGR。
 * `keys` 是渲染后逐条写入 stdin 的按键（用来触发「搜索:」回声行）。
 * `ttyCols` 只在「终端宽但组件不知道」的负对照里用：它让 ink 按该宽度排版，
 * 而组件仍拿不到 cols，于是复现改前的撑行。
 */
async function renderFrame(choices, cols, termRows, keys, ttyCols, opts) {
  const o = opts || {};
  const ink = await rt.loadInk();
  const Comp = require(path.join('..', '..', 'src', 'cli', 'tui', 'ink-components', 'ModelPicker.js'));
  const stdout = frameStdout(ttyCols || cols || 80, termRows);
  const stdin = pressableStdin();
  // 记录选中值：只挂真帧看不出「按下选中了哪个模型」，而按下标错绑的缺陷恰好
  // 只在「选中的值」上显形（❯ 的位置看起来是对的 —— 高亮走 e.mi，而 e.mi 已在显示序）。
  const resolved = [];
  const instance = ink.render(
    React.createElement(Comp, {
      choices,
      defaultValue: o.defaultValue || null,
      recent: [],
      onResolve: (v) => resolved.push(v),
      cols,
      rows: termRows,
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false }
  );
  // 就绪闸超时记录（空数组 = 每一道闸都真等到了目标帧）。见下方 `cursorGates` 的说明。
  const gateTimeouts = [];
  let out = { rows: [], raw: '', resolved, gateTimeouts };
  try {
    let polled = '';
    for (let i = 0; i < 160; i += 1) {
      polled = stdout.getBuffer();
      const plain = stripAnsi(polled);
      if (plain.includes('╭') && plain.indexOf('╰', plain.lastIndexOf('╭')) !== -1) break;
      await wait(25);
    }
    if (keys && keys.length) {
      // ★ 就绪闸（`cursorGates`）：`[{at, cursor}]` = 「已发出 `at` 个键之后，等帧里的 ❯ 真到
      // `cursor` 那一行，再发下一个键」。
      // 为什么必须**逐键**设闸而不是只在提交键前设一道：↑/↓ 是「先重排、后提交」的两拍，
      // 固定 40ms 的按键间隔在**全量套件**跑时会让第二个 ↓ 与回车赛跑 —— 读到的成了
      // 「显示序第 2 个」（实测：期望 `A-2`，实得 `A-1`；单跑同一条 41/41 全绿）。
      // ⚠ 这只是**就绪闸**，不是断言：❯ 的位置**分辨不出**「光标绑错数组」
      // （高亮走 `e.mi === cursor`，而 `e.mi` 已在显示序）。断言一律挂 `onResolve` 的 value。
      // 闸超时会记进 `gateTimeouts` 并由用例断言为空 —— 不许「等不到也照样往下发」，
      // 否则失败会伪装成「选中了别的模型」而不是「这一帧没画出来」。
      const gates = (Array.isArray(o.cursorGates) ? o.cursorGates : [])
        .slice()
        .sort((a, b) => a.at - b.at);
      const gateAt = async (sent) => {
        const g = gates.find((x) => x.at === sent);
        if (!g) {
          return;
        }
        const want = String(g.cursor);
        for (let i = 0; i < 160; i += 1) {
          const cur = sliceFrame(stripAnsi(stdout.getBuffer())).find((r) => r.includes('❯'));
          if (cur && cur.includes(want)) {
            return;
          }
          await wait(25);
        }
        gateTimeouts.push(`at=${sent} want=${want}`);
      };
      await gateAt(0); // 允许「发第一个键之前」的闸（开局光标）
      let sent = 0;
      for (const k of keys) {
        stdin.push(k);
        sent += 1;
        await wait(o.keyGapMs || 40);
        await gateAt(sent);
      }
      if (o.settleMs) {
        // 非打印键（↑/↓/回车）不会产生「搜索:」回声行，等它等于白等 1.5s。
        // 但**不能只等固定时间**：机器忙时 ink 还没重排完就断言 ⇒ 假红
        // （实测同一命令单跑 2.1s 通过、全量跑 30s 时这条变红）。
        // 有 `expectResolved` 时轮询到「选中值到齐」为止（上限 4s）—— 判据确定化。
        const want = Number(o.expectResolved) || 0;
        if (want) {
          for (let i = 0; i < 160 && resolved.length < want; i += 1) {
            await wait(25);
          }
        } else {
          await wait(o.settleMs);
        }
      } else {
        for (let i = 0; i < 60; i += 1) {
          await wait(25);
          polled = stdout.getBuffer();
          if (stripAnsi(polled).includes('搜索:')) break;
        }
      }
    }
    const raw = polled.slice(polled.lastIndexOf('╭'));
    out = { rows: sliceFrame(stripAnsi(polled)), raw, resolved, gateTimeouts };
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  return out;
}

async function mount(choices, cols, termRows, keys, ttyCols) {
  return (await renderFrame(choices, cols, termRows, keys, ttyCols)).rows;
}


// mount 返回的行切片不含下边框那一行，所以整框高度要 +1。
const frameHeight = (rows) => rows.length + 1;
const widest = (rows) => rows.reduce((m, r) => Math.max(m, displayWidth(r)), 0);

/** 一行里还开着、但到行末没关的 SGR 组数（0 = 颜色不会漏到下一行）。 */
function sgrOffKey(c) {
  if (c === 39 || (c >= 30 && c <= 37) || c === 38 || (c >= 90 && c <= 97)) return c === 39 ? null : 39;
  if (c === 49 || (c >= 40 && c <= 47) || c === 48 || (c >= 100 && c <= 107)) return c === 49 ? null : 49;
  if (c === 1 || c === 2) return 22;
  if (c === 3) return 23;
  if (c === 4) return 24;
  if (c === 7) return 27;
  if (c === 9) return 29;
  return null;
}

function unclosedSgr(line) {
  const re = new RegExp(ESC + '\\[([0-9;]*)m', 'g');
  const open = new Set();
  let m;
  while ((m = re.exec(line)) !== null) {
    const codes = m[1] === '' ? [0] : m[1].split(';').map((p) => Number(p) || 0);
    for (const c of codes) {
      if (c === 0) { open.clear(); continue; }
      const off = sgrOffKey(c);
      if (off === null) open.delete(c);
      else { open.delete(off); open.add(off); }
    }
  }
  return open.size;
}

// 真实网关列表里的长 ID：长度由供应商决定，不由我们决定。
const LONG_IDS = [
  'claude-3-5-sonnet-20241022',
  'gemini-1.5-pro-exp-0827',
  'gpt-4o-mini-2024-07-18',
  'deepseek-chat-v3-20250324-preview',
  'qwen2.5-72b-instruct-128k',
  'kimi-k2-turbo-preview',
  'glm-4-plus-0111',
  'doubao-pro-128k-241211',
  'yi-lightning-latest',
  'minimax-abab6.5s-chat',
  'moonshot-v1-128k-vision-preview',
  'spark-large-3.5-plus',
];

function choicesOf(ids, everyFourthDisabled) {
  return ids.map((n, i) => ({
    name: n,
    value: { adapter: 'gateway', model: n },
    disabled: !!everyFourthDisabled && i % 4 === 3,
  }));
}

const LONG = choicesOf(LONG_IDS, true);

// ── 分组（[DESIGN-ARCH-167]）──────────────────────────────────────────────────
// 支点是四个纯函数：标题行只进渲染维度、不进 `filtered`，数字键与屏幕序号必须同源。
// 这些不变式从渲染出来的帧里看不出来，所以直调它们。
const Picker = require(path.join('..', '..', 'src', 'cli', 'tui', 'ink-components', 'ModelPicker.js'));

/** 造模型列表；`group` 是**数据层给的结构化字段**，不是从 name 反解出来的。 */
function grouped(spec) {
  const out = [];
  for (const [g, n] of spec) {
    for (let i = 0; i < n; i += 1) {
      out.push({
        name: `${g}-${i}`,
        group: g,
        value: { adapter: 'api', model: `${g}-${i}` },
        disabled: false,
      });
    }
  }
  return out;
}

// [DESIGN-ARCH-100] §158：`[未证实·内置]` 必须可见（黄色）。
const UNVERIFIED_TAG = '[未证实·内置]';
const withTag = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `m${i} ${UNVERIFIED_TAG}`,
    group: 'G',
    value: { adapter: 'api', model: `m${i}` },
    disabled: false,
  }));


// 行号标签只对窗口内前 9 行存在（`windowPos < 9`），所以数条目不能靠 `\d+.`。
const STEMS = LONG_IDS.map((id) => id.slice(0, 6));
const isItemRow = (r) => STEMS.some((s) => r.includes(s));

describeOrSkip('ModelPicker · 真实帧的行宽(BUG-56)', () => {
  test('传 cols：长模型 ID 每条只占一视觉行，40 列窄终端也不折行', async () => {
    const rows = await mount(LONG, 40, 24);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    // 改前同一批 ID 在 40 列下有 5 行折成两行，整框 22 行（AK/repro-before.txt M2）
    expect(frameHeight(rows)).toBeLessThanOrEqual(17);
    // 12 条一页没有被宽度收缩悄悄改掉
    expect(rows.filter(isItemRow).length).toBe(12);
  });

  test('带 SGR 的彩色长 ID：宽度按可见列计，且颜色不跨行', async () => {
    // 真实网关列表的 name 是 chalk 预着色过的字符串。这里手拼 SGR 而不是调 chalk：
    // 测试环境无色彩支持时 chalk 退化成原样字符串，那样这条守卫什么也没测到。
    const green = (s) => ESC + '[32m' + s + ESC + '[39m';
    const colored = choicesOf(LONG_IDS.map(green), false);
    const { rows, raw } = await renderFrame(colored, 40, 24);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(rows.filter(isItemRow).length).toBe(12);
    // 计量口径若按码元/字节算，带色行会被截得过短或仍被 ink 折行撑高：
    // 12 条一页 + 4 行框 chrome = 17，必须与无色时同高。
    expect(frameHeight(rows)).toBeLessThanOrEqual(17);
    // 实测证伪了一条假设（见 AK/differential.md）：截断处「不补 reset 就会把颜色漏到
    // 下一行」在 ink 路径上不成立 —— ink 6 会给每个 Text 节点末尾自动补 ESC[39m。
    // 所以 clipCell 不再追加 reset，这里改锁真正需要成立的不变量：每一行的 SGR 闭合。
    for (const l of raw.split('\n')) expect(unclosedSgr(l)).toBe(0);
  });

  test('不传 cols：与改前形态一致（ID 原样上屏，由 ink 自行折行撑高）', async () => {
    const capped = await mount(LONG, 40, 24);
    // 同一个 40 列屏幕，只是组件没被告知宽度 —— 即改前的真实处境
    const raw = await mount(LONG, undefined, undefined, null, 40);
    expect(widest(raw)).toBeLessThanOrEqual(40); // ink 会折，不会超宽
    expect(frameHeight(raw)).toBeGreaterThan(frameHeight(capped));
    expect(raw.join('\n')).toContain('deepseek-chat-v3-20250324-preview');
  });
});

describeOrSkip('ModelPicker · 帧高随终端行数收敛(BUG-56)', () => {
  test('rows 未知时不改形态：仍是 12 条一页、整框 16 行', async () => {
    const rows = await mount(LONG, 80, undefined);
    expect(frameHeight(rows)).toBe(16);
  });

  test('80×12 矮终端：整框不超过屏幕，Esc 提示就在最后一行', async () => {
    const rows = await mount(LONG, 80, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
    expect(rows.join('\n')).toContain('更多');
  });

  test('40×12 又窄又矮：标题/页脚折行后仍在屏内，且没有一行超出 40 列', async () => {
    const rows = await mount(LONG, 40, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
  });

  test('24 行正常终端不因本修复缩水：仍排满 12 条', async () => {
    const rows = await mount(LONG, 80, 24);
    expect(rows.filter(isItemRow).length).toBe(12);
  });

  test('打字出「搜索:」回声行时，那一行也算进帧高', async () => {
    const rows = await mount(LONG, 80, 12, ['g', 'p', 't']);
    expect(rows.join('\n')).toContain('搜索:');
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
  });
});

// ── [DESIGN-ARCH-167] 分组纯函数的不变量 ──────────────────────────────────────
describeOrSkip('ModelPicker · 分组纯函数的不变量(R1/R3/R5/R6)', () => {
  test('R1：条目只有 model/section 两种；模型条目永远带 value.adapter；标题行不带 choice', () => {
    const models = grouped([['A', 3], ['B', 1], ['C', 2]]);
    const entries = Picker.buildEntries(models, '');
    expect(entries.every((e) => e.kind === 'model' || e.kind === 'section')).toBe(true);
    const asModels = entries.filter((e) => e.kind === 'model');
    // 一个模型都没丢 —— 标题行不得把任何模型挤掉
    expect(asModels.length).toBe(models.length);
    for (const e of asModels) {
      expect(e.choice.value && e.choice.value.adapter).toBeTruthy();
      expect(typeof e.mi).toBe('number');
    }
    // 标题行不得混进模型维度：它没有 choice，也就进不了 `filtered`
    expect(entries.filter((e) => e.kind === 'section').every((e) => e.choice === undefined)).toBe(true);
  });

  test('R3：数字键与屏幕序号同源（往返恒等，窗口起点为 0）', () => {
    const entries = Picker.buildEntries(grouped([['A', 3], ['B', 4], ['C', 5]]), '');
    const start = 0;
    const end = entries.length;
    const targets = Picker.digitTargets(entries, start, end);
    expect(targets.length).toBe(9); // 窗口内只有 1..9 有号
    targets.forEach((ei, k) => {
      expect(entries[ei].kind).toBe('model');
      expect(Picker.digitIndexOf(entries, start, end, ei)).toBe(k + 1);
      // 反向：按「k+1」命中的就是这一行
      expect(targets[Picker.digitIndexOf(entries, start, end, ei) - 1]).toBe(ei);
    });
    // 第 10 个模型起不编号；标题行一律不编号
    const modelEntryIdx = entries.map((e, i) => (e.kind === 'model' ? i : -1)).filter((i) => i >= 0);
    expect(modelEntryIdx.length).toBe(12);
    expect(Picker.digitIndexOf(entries, start, end, modelEntryIdx[9])).toBe(0);
    entries.forEach((e, i) => {
      if (e.kind === 'section') expect(Picker.digitIndexOf(entries, start, end, i)).toBe(0);
    });
  });

  test('R3：窗口起点不为 0 时仍同源（列表滚动后标签不脱节）', () => {
    const entries = Picker.buildEntries(grouped([['A', 20], ['B', 20]]), '');
    const start = 7;
    const end = 19;
    const targets = Picker.digitTargets(entries, start, end);
    expect(targets.length).toBe(9);
    targets.forEach((ei, k) => {
      expect(ei).toBeGreaterThanOrEqual(start);
      expect(ei).toBeLessThan(end);
      expect(entries[ei].kind).toBe('model');
      expect(Picker.digitIndexOf(entries, start, end, ei)).toBe(k + 1);
    });
    // 窗口外的条目一律不编号
    expect(Picker.digitIndexOf(entries, start, end, 0)).toBe(0);
    expect(Picker.digitIndexOf(entries, start, end, entries.length - 1)).toBe(0);
  });

  test('R3：模型下标 → 条目下标是唯一那座桥', () => {
    const models = grouped([['A', 2], ['B', 3]]);
    const entries = Picker.buildEntries(models, '');
    for (let mi = 0; mi < models.length; mi += 1) {
      const ei = Picker.entryIndexOfModel(entries, mi);
      expect(entries[ei].kind).toBe('model');
      expect(entries[ei].mi).toBe(mi);
    }
  });

  test('R6：单模型组不画标题（49 个单模型组 ⇒ 0 个标题行）', () => {
    const models = grouped(Array.from({ length: 49 }, (_, i) => [`G${i}`, 1]));
    const entries = Picker.buildEntries(models, '');
    expect(entries.filter((e) => e.kind === 'section').length).toBe(0);
    expect(entries.length).toBe(49);
  });

  test('R6：恰好 2 个才画标题（上界是「每个画标题的组 >= 2 个模型」）', () => {
    const two = Picker.buildEntries(grouped([['X', 2], ['Y', 1]]), '');
    expect(two.filter((e) => e.kind === 'section').map((e) => e.name)).toEqual(['X']);
    // 标题行数 ≤ 模型行数：否则 49 个单模型组能画出 49 行标题、0 个模型
    const many = Picker.buildEntries(grouped([['A', 2], ['B', 3], ['C', 4]]), '');
    const s = many.filter((e) => e.kind === 'section').length;
    const m = many.filter((e) => e.kind === 'model').length;
    expect(s).toBeLessThanOrEqual(m);
  });

  test('R5：搜索态零标题行', () => {
    const models = grouped([['A', 5], ['B', 5]]);
    const searched = Picker.buildEntries(models, 'a');
    expect(searched.filter((e) => e.kind === 'section').length).toBe(0);
    // 搜索态条目 == 传进来的（**已过滤**的）模型条目：buildEntries 不做过滤，
    // 它只决定「怎么画」；过滤是 filterChoices 的职责。
    expect(searched.length).toBe(models.length);
    expect(searched.every((e) => e.kind === 'model')).toBe(true);
  });

  test('P2 兜底：没有 group 字段时回退 value.adapter（同一处语义输入，不另立字段）', () => {
    const models = [
      { name: 'a', value: { adapter: 'api', model: 'a' } },
      { name: 'b', value: { adapter: 'api', model: 'b' } },
      { name: 'c', value: { adapter: 'ollama', model: 'c' } },
    ];
    const secs = Picker.buildEntries(models, '').filter((e) => e.kind === 'section');
    expect(secs.map((e) => e.name)).toEqual(['api']);
  });

  test('标题的 count 取连续段长度：标题写 N 个，下面就必须真有 N 个', () => {
    // A 被 B 隔断成两段 ⇒ 两段各自的计数，而不是 A 的全局计数 6
    const secs = Picker.buildEntries(grouped([['A', 2], ['B', 3], ['A', 4]]), '')
      .filter((e) => e.kind === 'section');
    expect(secs.map((s) => [s.name, s.count])).toEqual([['A', 2], ['B', 3], ['A', 4]]);
  });

  test('R6 单模型组不画标题：`── X · 1 个 ──` 是纯开销，还给标题行数封了顶', () => {
    const secs = Picker.buildEntries(grouped([['A', 1], ['B', 2], ['C', 1]]), '')
      .filter((e) => e.kind === 'section');
    expect(secs.map((s) => s.name)).toEqual(['B']);
  });

  // ── §12-Q8/Q9：真数据实测挖出的两个缺陷（不是推想的） ────────────────────────
  // Q8：真 apiAdapter.listModels() 里 `Anthropic` 与 `anthropic` 只差大小写却被算成两组。
  // Q9：同一供应商 `OpenCode Zen` 被配置路（opencode-zen:）与密钥池路（api:opencode-zen:）
  //     切成两个**不连续**段 ⇒ 屏幕上出现两个同名标题。
  test('Q8：只差大小写的组名合并成一个标题，显示取首现原拼写', () => {
    const models = [
      { name: 'a0', group: 'Anthropic', value: { adapter: 'api', model: 'a0' } },
      { name: 'a1', group: 'ANTHROPIC', value: { adapter: 'api', model: 'a1' } },
      { name: 'a2', group: 'anthropic', value: { adapter: 'api', model: 'a2' } },
      { name: 'b0', group: 'B', value: { adapter: 'api', model: 'b0' } },
      { name: 'b1', group: 'B', value: { adapter: 'api', model: 'b1' } },
    ];
    const secs = Picker.buildEntries(Picker.stableGroupOrder(models), '')
      .filter((e) => e.kind === 'section');
    expect(secs.map((e) => e.name)).toEqual(['Anthropic', 'B']);
    expect(secs[0].count).toBe(3);
  });

  test('Q8：大小写变体被别家隔开时，归并后仍只画一个标题', () => {
    // 归并前会切成 `Anthropic`(1) / `B`(2) / `anthropic`(2) 三段 ⇒ 两个近似名标题
    const models = [
      { name: 'a0', group: 'Anthropic', value: { adapter: 'api', model: 'a0' } },
      { name: 'b0', group: 'B', value: { adapter: 'api', model: 'b0' } },
      { name: 'b1', group: 'B', value: { adapter: 'api', model: 'b1' } },
      { name: 'a1', group: 'anthropic', value: { adapter: 'api', model: 'a1' } },
      { name: 'a2', group: 'anthropic', value: { adapter: 'api', model: 'a2' } },
    ];
    const secs = Picker.buildEntries(Picker.stableGroupOrder(models), '')
      .filter((e) => e.kind === 'section');
    expect(secs.map((e) => [e.name, e.count])).toEqual([['Anthropic', 3], ['B', 2]]);
  });

  test('Q9：同名组被别家隔开 ⇒ 归并成一个标题，计数是全局 7 而非分段 3/4', () => {
    const models = grouped([['OpenCode Zen', 3], ['X', 2], ['OpenCode Zen', 4]]);
    // 归并前：三段 ⇒ 两个同名标题（3 个 / 4 个），这正是真数据里的形态
    const before = Picker.buildEntries(models, '').filter((e) => e.kind === 'section');
    expect(before.map((e) => [e.name, e.count])).toEqual([
      ['OpenCode Zen', 3], ['X', 2], ['OpenCode Zen', 4],
    ]);
    const after = Picker.buildEntries(Picker.stableGroupOrder(models), '')
      .filter((e) => e.kind === 'section');
    expect(after.map((e) => [e.name, e.count])).toEqual([['OpenCode Zen', 7], ['X', 2]]);
  });

  test('Q9：归并是纯置换 —— 不丢、不重、组内保序、组间保持首现相对顺序', () => {
    // 不用 `grouped()` 造这段夹具：它每段都从 0 重新编号，同一组出现两次会造出
    // 重名模型（`A-0` 有两份），「不重」这条断言会测到夹具自己的洞上。
    const at = (g, i) => ({ name: `${g}-${i}`, group: g, value: { adapter: 'api', model: `${g}-${i}` } });
    const models = [at('A', 0), at('A', 1), at('B', 0), at('B', 1), at('B', 2), at('A', 2), at('A', 3), at('C', 0)];
    const out = Picker.stableGroupOrder(models);
    expect(out.length).toBe(models.length);
    expect(new Set(out.map((m) => m.value.model)).size).toBe(models.length);
    // 组间首现序 A→B→C 未被字母序或其他规则改动
    expect(out.map((m) => m.group)).toEqual(['A', 'A', 'A', 'A', 'B', 'B', 'B', 'C']);
    // 组内原序：A 的四个仍是 a-0,a-1,a-2,a-3（先来后到）
    expect(out.filter((m) => m.group === 'A').map((m) => m.value.model))
      .toEqual(['A-0', 'A-1', 'A-2', 'A-3']);
  });

  test('全表只有一组时不画标题（MIN_DISTINCT_GROUPS）：该标题零信息却吃一整行', () => {
    // 实测代价：标题吃掉条目额度 ⇒ 12 条模型挤成 11 条 ⇒ 滚动提示出现 ⇒
    // 页脚在 60 列折行 ⇒ 帧高 16→17（[DESIGN-ARCH-167] §4.1）。
    const es = Picker.buildEntries(grouped([['A', 12]]), '');
    expect(es.filter((e) => e.kind === 'section').length).toBe(0);
    // 不画标题 ⇒ 组级信息必须回落到行内，否则就是静默丢失。
    expect(es.every((e) => e.orphan === true)).toBe(true);
  });
});

// ── [DESIGN-ARCH-167] R7：分组不得吃掉来源标签 ────────────────────────────────
describeOrSkip('ModelPicker · 分组不得吃掉来源标签(R7)', () => {
  test('80 列：来源标签在行里可见', async () => {
    const rows = await mount(withTag(6), 80, 24);
    expect(rows.join('\n')).toContain(UNVERIFIED_TAG);
  });

  test('orphan：段没画标题时 groupMeta 回落到行内 ⇒ 组级信息至少出现一次', async () => {
    // 组级三件套（状态/延迟/执行方）已升格到标题行；段太短没画标题时若不回落，
    // 「某供应商只有 1 个模型」那三件套就整个消失 —— 静默丢失（§4.1）。
    const models = [
      { name: 'a', group: 'A', groupMeta: 'GM-A', value: { adapter: 'api', model: 'a' } },
      { name: 'b', group: 'B', groupMeta: 'GM-B', value: { adapter: 'api', model: 'b' } },
    ];
    const text = (await mount(models, 80, 24)).join('\n');
    expect(text).toContain('GM-A');
    expect(text).toContain('GM-B');
  });

  test('无静默丢失：每条带标签的行，要么含标签、要么带截断标记', async () => {
    // 判据不是「必须显示」（窄档显示不下是正常降级），而是
    // 「要么显示、要么留可见的截断标记；不许既不在、又无标记」。
    for (const [cols, termRows] of [[80, 24], [60, 24], [40, 24]]) {
      const rows = await mount(withTag(6), cols, termRows);
      const itemRows = rows.filter((r) => /m\d/.test(r));
      expect(itemRows.length).toBeGreaterThan(0);
      for (const r of itemRows) {
        const ok = r.includes(UNVERIFIED_TAG) || r.includes('…');
        if (!ok) {
          throw new Error(`${cols}×${termRows} 行既无来源标签也无截断标记: ${JSON.stringify(r)}`);
        }
      }
    }
  });
});

// ── [DESIGN-ARCH-167] 真帧里的组标题（Q8/Q9 端到端） ──────────────────────────
// 纯函数绿 ≠ 组件真用了它。这两条挂真组件渲染真帧，判据是**屏幕上出现了什么**。
describeOrSkip('ModelPicker · 真帧里的组标题(Q8/Q9)', () => {
  // 判据必须认「标题行的形状」而不是「含 `──`」：框的上边框 `╭────…──╮` 也含 `──`，
  // 按子串数会把边框算成一条标题（实测数出 3 条，实际只有 2 条）。
  // 也不能只按 `──` 区分模型行：模型名 `OpenCode Zen-0` 里就有组名。
  const sectionRows = (rows) => rows.filter((r) => /── .+ · \d+ 个 ──/.test(r));

  test('Q9 真帧：同名段归并后屏上只有一个「OpenCode Zen」标题，计数 7', async () => {
    const rows = await mount(grouped([['OpenCode Zen', 3], ['X', 2], ['OpenCode Zen', 4]]), 80, 24);
    const secs = sectionRows(rows);
    expect(secs.length).toBe(2);
    const oz = secs.filter((r) => r.includes('OpenCode Zen'));
    expect(oz.length).toBe(1);
    expect(oz[0]).toContain('7 个');
  });

  test('Q8 真帧：大小写变体只画一个标题，拼写取首现原样', async () => {
    const models = [
      { name: 'a0', group: 'Anthropic', value: { adapter: 'api', model: 'a0' } },
      { name: 'a1', group: 'ANTHROPIC', value: { adapter: 'api', model: 'a1' } },
      { name: 'b0', group: 'B', value: { adapter: 'api', model: 'b0' } },
      { name: 'b1', group: 'B', value: { adapter: 'api', model: 'b1' } },
      { name: 'a2', group: 'anthropic', value: { adapter: 'api', model: 'a2' } },
    ];
    const secs = sectionRows(await mount(models, 80, 24));
    expect(secs.length).toBe(2);
    const anth = secs.filter((r) => r.toLowerCase().includes('anthropic'));
    expect(anth.length).toBe(1);
    expect(anth[0]).toContain('Anthropic'); // 显示用首现大写拼写，不是 lower 后的
    expect(anth[0]).toContain('3 个');
  });
});

// ── [DESIGN-ARCH-167] Q10：归并后的下标一致性（端到端） ──────────────────────
// 归并（Q9）把 `shown` 的模型下标改了 ⇒ 光标 / 数字键 / `choose` / `initialCursor`
// 必须全部改绑。`R3` 系列测的是 `buildEntries` 的**纯函数往返**，它看不见
// 「组件里那 5 处到底绑在哪份数组上」—— 那正是本组存在的理由。
//
// ⚠ 判据必须挂在**选中的值**上，不能只看 ❯ 的位置：高亮走 `e.mi === cursor`，
// 而 `e.mi` 已经在显示序里，所以「光标绑错数组」时 ❯ 看起来照样对。
// 只有 `onResolve` 拿到的 value 能分辨「显示序第 3 个」与「输入序第 3 个」。
// ❯ 在本组里只有一种用途：当**就绪闸**（`cursorGates`）—— 判断「这一帧画完了没」，
// 不参与断言。
describeOrSkip('ModelPicker · 归并后的下标一致性(Q10)', () => {
  const at = (g, i) => ({
    name: `${g}-${i}`,
    group: g,
    value: { adapter: 'api', model: `${g}-${i}` },
    disabled: false,
  });
  // A 被 B 隔开 ⇒ 归并后 A 的 3 个从尾部挪到前面。**输入序 ≠ 显示序**是这组判据的前提，
  // 用已分好组的夹具会让断言恒真（stableGroupOrder 是恒等映射）。
  const MODELS = [at('A', 0), at('A', 1), at('B', 0), at('B', 1), at('B', 2), at('A', 2), at('A', 3), at('A', 4)];
  const INPUT_ORDER = MODELS.map((m) => m.value.model);
  const DISPLAY = ['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'B-0', 'B-1', 'B-2'];
  const SETTLE = { settleMs: 150 };
  const DOWN = `${ESC}[B`;

  test('前提：这条夹具真的被重排（否则整组断言恒真）', () => {
    const shown = Picker.stableGroupOrder(MODELS).map((m) => m.value.model);
    expect(shown).toEqual(DISPLAY);
    expect(shown).not.toEqual(INPUT_ORDER);
    // 差异点：下标 2 与 3（输入序是 B-0/B-1，显示序是 A-2/A-3）
    expect([INPUT_ORDER[2], DISPLAY[2]]).toEqual(['B-0', 'A-2']);
    expect([INPUT_ORDER[3], DISPLAY[3]]).toEqual(['B-1', 'A-3']);
  });

  test('数字键：按 n 选中的就是屏幕上「n.」那一行（归并后）', async () => {
    const { resolved, rows } = await renderFrame(MODELS, 80, 24, ['1', '3', '5', '8'], undefined, {
      ...SETTLE,
      expectResolved: 4,
    });
    expect(resolved.map((v) => v.model)).toEqual(['A-0', 'A-2', 'A-4', 'B-2']);
    // 屏幕上标注「3.」的那一行必须正是 A-2（不是输入序第 3 个 B-0）
    const row3 = rows.find((r) => /(^|\s)3\./.test(r));
    expect(row3).toBeTruthy();
    expect(row3).toContain('A-2');
    expect(row3).not.toContain('B-0');
  });

  test('↓×2 + Enter：选中显示序第 3 个，不是输入序第 3 个', async () => {
    // `cursorGates` 是**就绪闸**不是判据：每个 ↓ 之后都等 ❯ 真到位再发下一个键，
    // 否则两个 ↓ 与回车会赛跑，读到的会是「显示序第 2 个」—— 那是在测键投递时序，
    // 不是在测下标绑定（全量套件跑实测踩到：期望 `A-2`，实得 `A-1`）。
    // ⚠ 该竞态**不是 ModelPicker 独有**：同一次全量跑里 `permissionsPromptDigitFooter`
    // （数字键 2 的效果丢了 ⇒ 期望 `allow-always` 实得 `allow`）与 `keyHandlerFreshClosure`
    // 是同一个「多键序列里前一个键未生效」的类，跨组件 ⇒ 属测试脚手架/输入管线的独立问题。
    const { resolved, gateTimeouts } = await renderFrame(MODELS, 80, 24, [DOWN, DOWN, '\r'], undefined, {
      ...SETTLE,
      expectResolved: 1,
      cursorGates: [
        { at: 1, cursor: 'A-1' },
        { at: 2, cursor: 'A-2' },
      ],
    });
    // 闸本身也要断言：等不到目标帧时必须**显式失败**，不能静默往下发键
    // （否则失败会伪装成「选中了别的模型」而不是「这一帧没画出来」）。
    expect(gateTimeouts).toEqual([]);
    // 断言整个数组（不是 `resolved[0]`）：失败时能一眼看出是「选中了别的」还是「选了两次」。
    expect(resolved.map((v) => (v && v.model) || v)).toEqual(['A-2']);
    expect(resolved[0].model).not.toBe(INPUT_ORDER[2]);
  });

  test('defaultValue 落在显示序上：开局光标就在那个模型上（initialCursor 同源）', async () => {
    // A-4 输入序下标 7、显示序下标 4。绑错数组时开局光标会落在 B-2 上。
    const { resolved, rows, gateTimeouts } = await renderFrame(MODELS, 80, 24, ['\r'], undefined, {
      ...SETTLE,
      expectResolved: 1,
      cursorGates: [{ at: 0, cursor: 'A-4' }],
      defaultValue: { adapter: 'api', model: 'A-4' },
    });
    expect(gateTimeouts).toEqual([]);
    expect(resolved.map((v) => (v && v.model) || v)).toEqual(['A-4']);
    const cursorRow = rows.find((r) => r.includes('❯'));
    expect(cursorRow).toContain('A-4');
  });

  test('（n/N）分母数的是模型，不是条目（标题行不计入）', async () => {
    // 8 个模型 + 2 条标题 = 10 个条目 ⇒ 分母必须是 8。绑到 entries 上会写成 10。
    const rows = await mount(MODELS, 80, 6);
    const hint = rows.find((r) => /（\d+\/\d+/.test(r));
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/（1\/8/);
  });
});

// ── [DESIGN-ARCH-167] A1：帧高不回归 ──────────────────────────────────────────
describeOrSkip('ModelPicker · 帧高不回归（分组不得让帧变高）', () => {
  // 公理 A1：帧高 ≥ rows 会让 ink 走全屏分支写 ESC[2J（BUG-89/91/92/93 家族）。
  // 下表的数字是**加分组之前**的实测值，分组接线后必须逐个不变 ——
  // 这正是「标题行占 pageSize 额度、没有一行游离在账外」的可证形式。
  const PINNED = [
    [80, 24, 16],
    [80, 40, 16],
    [120, 40, 16],
    [120, 24, 16],
    [60, 24, 16],
    [40, 24, 17],
    [80, 12, 11],
    [40, 12, 11],
  ];
  for (const [cols, termRows, h] of PINNED) {
    test(`${cols}×${termRows}：帧高 ${h}（≤ rows-1 = ${termRows - 1}）`, async () => {
      const rows = await mount(LONG, cols, termRows);
      expect(frameHeight(rows)).toBe(h);
      expect(frameHeight(rows)).toBeLessThanOrEqual(termRows - 1);
      expect(rows[rows.length - 1]).toContain('Esc 取消');
    });
  }
});
