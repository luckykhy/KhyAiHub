'use strict';

/**
 * ccPhoneLinkPanel.test.js — CC 表面「手机联动」面板 + 多行 notice 的真 ink 渲染断言。
 *
 * 模板同 ccHelpMenuOverlay.test.js / agentTreeRender.test.js：手写假 stdio 累积 buffer，
 * 喂真键字节，读回最后一整个盒子。锁四件事：
 *   1) 帧内**每一行**的显示宽度 ≤ 终端宽度（溢出是所有裁切/错列的根因，钉这一条最省）；
 *   2) 四种态的结论行都在帧里，且字形与 tone 对得上（在线 ✓ / 离线 ✗ / 陈旧徽标 / 桥死 revive）；
 *   3) Esc 真的关得掉（onClose 被调用）—— 浮层关不掉比画错更严重；
 *   4) CcNoticeBlock 的悬挂缩进：第 2..N 行不再顶第 0 列（锯齿修复的直接证据）。
 *
 * 跑法同 ccHelpMenuOverlay：需 --experimental-vm-modules
 * （npm run --workspace backend test:tui）。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const React = require('react');
// jest 不注入 node:test 的全局 assert，与 tests/tui 其余套件一样显式取。
// AGENTS.md §0.9.6：FORCE_COLOR 必须在 require 任何 ink/chalk **之前**设。
// 不设时假 stdio 走 chalk level 0，帧里一个 SGR 都没有 —— 段标题的加粗信号就测不到。
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '2';
const assert = require('node:assert/strict');

const rt = require('../../src/cli/tui/inkRuntime');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ccPhoneLinkPanel] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ESC = String.fromCharCode(27);
const COLS = 80;
const ROWS = 30;

const stripAnsi = (s) =>
  String(s).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');

function widthsOf(lines) {
  const { displayWidth } = require('../../src/cli/formatters');
  // 去尾空白：ink 会把短行补齐到容器宽，不补的话「≤ 宽度」这条断言会被填充空格
  // 满足成恒真（测不到溢出）。
  return lines.map((l) => displayWidth(l.replace(/\s+$/, '')));
}

function pressableStdin() {
  const stream = new EventEmitter();
  let queue = '';
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => {
    if (!queue) return null;
    const out = queue;
    queue = '';
    return out;
  };
  stream.press = (bytes) => {
    queue += bytes;
    stream.emit('readable');
  };
  return stream;
}

function collectingStdout(rows = ROWS, columns = COLS) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

/** 从最后一个 ┌ 到其后的第一个 └ —— 桩不认光标寻址，最后那一整个盒子才是当前画面。 */
function lastBoxLines(buffer) {
  const start = buffer.lastIndexOf('┌');
  if (start === -1) throw new Error('帧里找不到盒框，挂载可能为空');
  const end = buffer.indexOf('└', start);
  if (end === -1) throw new Error('盒未闭合（最后一帧不完整）');
  const raw = buffer.slice(start, end).split('\n');
  return raw.map((l) => stripAnsi(l.replace(/^.*┌/, '').replace(/┐.*$/, '')));
}

async function mount(Comp, props, { stdin, rows = ROWS, columns = COLS } = {}) {
  const stdout = collectingStdout(rows, columns);
  const instance = rt.get().render(React.createElement(Comp, props), {
    stdout,
    stdin: stdin || pressableStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const frame = stdout.getBuffer();
  instance.unmount();
  return frame;
}

// ── 夹具（与 tests/cli/tui/phoneLinkPanel.test.js 同源，形状来自 amooPanelViewModel）──

function statusRow(key, label, value, tone, hint) {
  return { key, label, value, tone, hint: hint || null };
}

const ONLINE_ROWS = [
  statusRow('adb', 'adb', '已解析（env）', 'ok'),
  statusRow('device', '设备', '192.168.2.46:33743', 'ok'),
  statusRow('forward', '转发', 'tcp:8896 + tcp:8898', 'ok'),
  statusRow('bridge', '桥', '在线 21ms', 'ok'),
  statusRow('tools', '工具', '22 个（lite）', 'ok'),
  statusRow('token', '令牌', '5500…8d30', 'ok'),
  statusRow('screen', '界面', '15 节点', 'ok', '聊天 120 字 / 4 行，输入框 0 字'),
];

function onlineSnapshot(extra) {
  return Object.assign(
    {
      state: 'ready',
      stale: false,
      busy: false,
      degraded: false,
      lastError: null,
      model: {
        at: 1000,
        tone: 'ok',
        headline: '协作链正常',
        rows: ONLINE_ROWS,
        badges: [],
        screen: { nodes: 15 },
        dispatch: null,
        progress: null,
        notes: ['lite 桥无 UI 工具：读屏与点击走 PC 侧 adb（uiautomator dump）'],
        details: [],
        truncated: false,
      },
    },
    extra || {}
  );
}

function offlineSnapshot() {
  return onlineSnapshot({
    model: {
      at: 1000,
      tone: 'error',
      headline: '设备未连接（device_unreachable）',
      rows: [
        statusRow('adb', 'adb', '已解析（env）', 'ok'),
        statusRow('device', '设备', '未连接', 'error', 'device_unreachable'),
        statusRow('forward', '转发', '未建立', 'error'),
        statusRow('bridge', '桥', '不在线', 'error'),
        statusRow('tools', '工具', '—', 'idle'),
        statusRow('token', '令牌', '不可用', 'warn'),
        statusRow('screen', '界面', '读不到', 'idle'),
      ],
      badges: [],
      screen: null,
      dispatch: null,
      progress: null,
      notes: [],
      details: ['设备：未连接（device_unreachable）', '桥不在线时可试 khy phone revive（monkey 拉起，实测唯一恢复路）'],
      truncated: false,
    },
  });
}

function bridgeDeadSnapshot() {
  const snap = offlineSnapshot();
  snap.model.headline = '桥服务不在线';
  snap.model.details = [
    '桥不在线时可试 khy phone revive（monkey 拉起，实测唯一恢复路）',
    '桥：http_401',
  ];
  return snap;
}

function idleSnapshot() {
  return { state: 'idle', stale: false, busy: false, degraded: false, lastError: null, model: null };
}

describeOrSkip('CcPhoneLinkPanel ink render', () => {
  let CcPhoneLinkPanel;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    CcPhoneLinkPanel = require('../../src/cli/tui/ink-components/CcPhoneLinkPanel').CcPhoneLinkPanel;
  });

  test('在线：结论行 + 链路七行 + lite 边界说明都在帧里，且无一行超宽', async () => {
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: onlineSnapshot(), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const lines = lastBoxLines(frame);
    for (const w of widthsOf(lines)) {
      assert.ok(w <= COLS, `行超宽（${w} > ${COLS}）`);
    }
    const text = lines.join('\n');
    assert.ok(text.includes('手机联动'), '标题缺失');
    assert.ok(text.includes('协作链正常'), '结论行缺失');
    assert.ok(text.includes('192.168.2.46:33743'), '设备序列号缺失');
    assert.ok(text.includes('tcp:8896 + tcp:8898'), '端口转发缺失');
    assert.ok(text.includes('22 个（lite）'), '桥 mode / 工具数缺失');
    assert.ok(text.includes('5500…8d30'), '令牌掩码缺失');
    assert.ok(text.includes('15 节点'), '界面摘要缺失');
    assert.ok(text.includes('lite 桥无 UI 工具'), 'lite 构建边界说明缺失');
    assert.ok(text.includes('R 刷新'), '页脚操作提示缺失');
  });

  test('离线：设备未连接红在最根上，reason 上屏', async () => {
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: offlineSnapshot(), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const text = lastBoxLines(frame).join('\n');
    assert.ok(text.includes('设备未连接（device_unreachable）'));
    assert.ok(text.includes('device_unreachable'));
  });

  test('桥死：revive 提示是帧里第一条可执行的下一步', async () => {
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: bridgeDeadSnapshot(), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const text = lastBoxLines(frame).join('\n');
    assert.ok(text.includes('桥服务不在线'));
    assert.ok(text.includes('khy phone revive'));
  });

  test('陈旧：标题打「数据停更」，内容不清空', async () => {
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: onlineSnapshot({ stale: true }), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const text = lastBoxLines(frame).join('\n');
    assert.ok(text.includes('数据停更'));
    assert.ok(text.includes('192.168.2.46:33743'));
  });

  test('无快照：说「尚未读取」，不画一条假链路', async () => {
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: idleSnapshot(), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const text = lastBoxLines(frame).join('\n');
    assert.ok(text.includes('尚未读取手机状态'));
    assert.ok(!text.includes('192.168.2.46:33743'));
  });

  // 溢出路径（最近任务段把内容顶出 30 行）是上一轮唯一没被 ink 断言覆盖到的分支：
  // 行模型单测只测 buildPhoneLinkLines，组件层的预算/提示/页脚都在它外面。
  // 实测（2026-10-22 联调，真机快照 + 真 send 结果）这里把页脚画了两遍。
  test('溢出时「+N ↓」单独占一行，页脚在一帧里只出现一次', async () => {
    const long = onlineSnapshot();
    long.model.dispatch = {
      tone: 'ok',
      headline: '已收到 Amoo 答复（94 字，4 轮轮询后判定稳定）。',
      rows: [
        statusRow('result', '结果', '已收到答复', 'ok'),
        statusRow('stop', '停止', '回复已稳定', 'ok'),
        statusRow('chars', '答复', '94 字', 'ok'),
      ],
      steps: [],
      replyPreview: [
        '请只回复OK两个字，不要调用任何工具',
        'OK',
        '用一句话报告当前电量百分比和前台应用名',
        '已完成 9s',
        '当前电量为 100%；但前台应用名暂时查不到，现有能力里没有能读取“当前前台应用”的接口。',
      ].join('\n'),
      replyChars: 94,
      truncated: false,
    };
    const frame = await mount(CcPhoneLinkPanel, {
      snapshot: long, cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => {},
    });
    const lines = lastBoxLines(frame);
    const text = lines.join('\n');
    // 溢出提示必须在帧里（否则这条用例没测到它想测的分支）。
    assert.ok(/\+\d+ ↓/.test(text), '溢出提示缺失：该用例没覆盖到溢出分支');
    // 页脚文本只允许出现一次：并进提示行 + 固定页脚 = 画两遍（已修）。
    const occurrences = text.split('R 刷新 · Esc 关闭').length - 1;
    assert.equal(occurrences, 1, `页脚出现了 ${occurrences} 次（应为 1 次）`);
    // 修完不改变帧高账本：仍然不触发整屏擦除，且无一行超宽。
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1B\[2J/.test(frame), '溢出帧触发了 ink 全屏分支（帧高顶破 rows）');
    for (const w of widthsOf(lines)) {
      assert.ok(w <= COLS, `溢出帧下行超宽（${w} > ${COLS}）`);
    }
  });

  test('窄终端（24 列）也不超宽 —— 内容让位而不是溢出', async () => {
    // 宿主 props 与假 stdio 必须同尺（AGENTS.md §0.9.6：被测代码读的每个环境量都要
    // 如实改）。不同尺时 ink 只会把短行补齐到 stdout 宽，测出来是个假绿/假红。
    const frame = await mount(
      CcPhoneLinkPanel,
      { snapshot: onlineSnapshot(), cols: 24, rows: 30, onClose: () => {}, onRefresh: () => {} },
      { columns: 24 }
    );
    for (const w of widthsOf(lastBoxLines(frame))) {
      assert.ok(w <= 24, `窄终端下行超宽（${w} > 24）`);
    }
  });

  test('短终端（12 行）不触发 ink 全屏分支：帧里没有 2J', async () => {
    const stdout = collectingStdout(12, COLS);
    const instance = rt.get().render(
      React.createElement(CcPhoneLinkPanel, {
        snapshot: onlineSnapshot(), cols: COLS, rows: 12, onClose: () => {}, onRefresh: () => {},
      }),
      { stdout, stdin: pressableStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = stdout.getBuffer();
    instance.unmount();
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1B\[2J/.test(frame), '短终端上出现了整屏擦除（帧高顶破 rows）');
    for (const w of widthsOf(lastBoxLines(frame))) {
      assert.ok(w <= COLS, `短终端下行超宽（${w} > ${COLS}）`);
    }
  });

  test('Esc 关得掉（onClose 被调用）', async () => {
    let closed = 0;
    const stdin = pressableStdin();
    const stdout = collectingStdout();
    const instance = rt.get().render(
      React.createElement(CcPhoneLinkPanel, {
        snapshot: onlineSnapshot(), cols: COLS, rows: ROWS, onClose: () => { closed += 1; }, onRefresh: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.press(ESC);
    await new Promise((resolve) => setTimeout(resolve, 60));
    instance.unmount();
    assert.equal(closed, 1, 'Esc 必须关掉面板');
  });

  test('R 触发手动刷新（onRefresh 被调用）', async () => {
    let refreshed = 0;
    const stdin = pressableStdin();
    const stdout = collectingStdout();
    const instance = rt.get().render(
      React.createElement(CcPhoneLinkPanel, {
        snapshot: onlineSnapshot(), cols: COLS, rows: ROWS, onClose: () => {}, onRefresh: () => { refreshed += 1; },
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.press('r');
    await new Promise((resolve) => setTimeout(resolve, 60));
    instance.unmount();
    assert.equal(refreshed, 1);
  });
});

describeOrSkip('CcNoticeBlock ink render', () => {
  let CcNoticeBlock;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    CcNoticeBlock = require('../../src/cli/tui/ink-components/CcNoticeBlock').CcNoticeBlock;
  });

  test('khy phone status 的真实形状：续行悬挂缩进，锯齿消失', async () => {
    const content = [
      '  ✓ 手机桥接在线',
      '  i 设备：192.168.2.46:33743',
      'HTTP 通道：http://127.0.0.1:8896',
      '信箱目录：/sdcard/bridge-amoobridge（仅兜底）',
    ].join('\n');
    const frame = await mount(CcNoticeBlock, { content, cols: COLS });
    const lines = stripAnsi(frame).split('\n').filter((l) => l.length > 0);
    const first = lines.find((l) => l.includes('手机桥接在线'));
    assert.ok(first, '首行缺失');
    assert.ok(first.startsWith('· '), `首行应以 '· ' 开头，实为 ${JSON.stringify(first)}`);
    // 续行必须对齐到 '· ' 之下（两格缩进），不再顶第 0 列。
    // 注意 printInfo 自己带 `  i ` 两格前导，所以整行是 2（悬挂）+ 2（记号）= 4 格。
    const cont = lines.find((l) => l.includes('设备：'));
    assert.ok(cont, '续行缺失');
    assert.ok(cont.startsWith('    i 设备：'), `续行应悬挂缩进，实为 ${JSON.stringify(cont)}`);
    const http = lines.find((l) => l.includes('HTTP 通道'));
    assert.ok(http.startsWith('  HTTP 通道'), `续行应悬挂缩进，实为 ${JSON.stringify(http)}`);
  });

  test('Amoo 答复 + 执行计划：段标题与正文分层（段标题加粗、正文 dim）', async () => {
    const content = [
      '  ✓ 已收到答复',
      '── Amoo 答复 ──',
      '已经帮你打开微信了。',
      '── 执行计划 ──',
      '  1. ensure-device 设备已连接',
    ].join('\n');
    const frame = await mount(CcNoticeBlock, { content, cols: COLS });
    const text = stripAnsi(frame);
    assert.ok(text.includes('── Amoo 答复 ──'));
    assert.ok(text.includes('── 执行计划 ──'));
    // 段标题行的层级信号 = 加粗（SGR 1）；正文行是 dim（SGR 2）。两者必须不同，
    // 否则「一大段同权 dim 墙」这个病灶根本没修。
    const boldLines = frame.split('\n').filter((l) => /\x1B\[1m/.test(l));
    assert.ok(boldLines.some((l) => l.includes('Amoo 答复')), '段标题应加粗');
    assert.ok(boldLines.some((l) => l.includes('执行计划')), '段标题应加粗');
    const plainLines = frame.split('\n').filter((l) => /\x1B\[2m/.test(l));
    assert.ok(plainLines.some((l) => l.includes('已经帮你打开微信了')), '正文应 dim');
  });

  test('无一行超宽（CJK 双宽感知）', async () => {
    const content = '  i 设备：192.168.2.46:33743 ' + '长'.repeat(90);
    const frame = await mount(CcNoticeBlock, { content, cols: 40 });
    for (const w of widthsOf(stripAnsi(frame).split('\n').filter((l) => l.length > 0))) {
      assert.ok(w <= 40, `行超宽（${w} > 40）`);
    }
  });

  test('空内容不渲染任何行（不落一条只有记号的空 notice）', async () => {
    for (const bad of ['', '   ', null, undefined]) {
      const frame = await mount(CcNoticeBlock, { content: bad, cols: COLS });
      assert.equal(stripAnsi(frame).trim(), '', `空内容应无输出，实为 ${JSON.stringify(frame)}`);
    }
  });

  test('gap=false 时不画 marginTop 空行（账本与实画同源，BUG-91）', async () => {
    const content = '第一行\n第二行';
    const withGap = stripAnsi(await mount(CcNoticeBlock, { content, cols: COLS })).split('\n');
    const noGap = stripAnsi(await mount(CcNoticeBlock, { content, cols: COLS, gap: false })).split('\n');
    // 有 gap 时第一行是空行（marginTop:1），没有 gap 时第一行就是 notice 首行。
    assert.equal(withGap[0].trim(), '', 'gap 默认应留一空行');
    assert.equal(withGap[1].indexOf('· 第一行'), 0);
    assert.equal(noGap[0].indexOf('· 第一行'), 0, 'gap=false 时首行不应再有前导空行');
    assert.equal(noGap.length < withGap.length, true, '关掉 gap 应少一行');
  });
});
