'use strict';

/**
 * permissionsPromptNoticeFrame.test.js — 紧凑形态的两条硬不变量(真实帧)。
 *
 * 1) **框高可记账**:`PermissionsPrompt.frameRowCount()` 必须等于实画行数。App.js 的
 *    chrome 账本用这个数给授权浮层扣行(浮层是 live 区的兄弟节点,不扣行就会把转录
 *    视口顶穿 → ink 走 fullscreen 清屏分支 → 备用缓冲下转录整片被抹掉)。账本与画面
 *    分叉过一次(见 chromeBudget 文件头记的三处各算一份),所以这里在多个列宽上钉住
 *    「账本 == 画面」,而不是只测一个宽度。
 *
 * 2) **证据离开框**:框内不再出现资源全文 / 说明正文(它们在输出区记录里,见
 *    permissionNotice.buildRecord);资源行被裁时补「↑全文见上」指路。这是用户
 *    2026-09-23 的诉求本体:资源挤占授权框。
 *
 * 跑法同 permissionsPromptDigitFooter:需 NODE_OPTIONS=--experimental-vm-modules。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
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

function pressableStdin() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => null;
  return stream;
}

function frameStdout(columns) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 40;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 挂一次真实组件,返回盒子里的行(从 ╭ 到 ╰)。 */
async function mount(request, cols) {
  const ink = await rt.loadInk();
  const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');
  const stdout = frameStdout(cols || 80);
  const instance = ink.render(
    React.createElement(Comp, { request, onResolve: () => {}, cols }),
    { stdin: pressableStdin(), stdout, exitOnCtrlC: false, patchConsole: false }
  );
  // 同 permissionsPromptHangingIndent:整套 suite 同进程串行跑时固定 200ms 会抖,
  // 等到盒子真正闭合再取帧。
  let buf = '';
  for (let i = 0; i < 120; i += 1) {
    buf = stripAnsi(stdout.getBuffer());
    if (buf.includes('╭') && buf.indexOf('╰', buf.lastIndexOf('╭')) !== -1) break;
    await wait(25);
  }
  const from = buf.lastIndexOf('╭');
  const to = buf.indexOf('╰', from);
  const rows = (from === -1 || to === -1 ? buf : buf.slice(from, to + 1)).split('\n');
  instance.unmount();
  return rows;
}

const LONG_RES =
  'del /F /Q C:\\Users\\25789\\Desktop\\khy_image.png && dir /b C:\\Users\\25789\\Desktop\\khy_image.png 2>NUL & echo done';

// 撤销句（whatToUndo 的**值**本身；旧夹具曾把 `撤销方式：` 前缀写进值里，那是夹具走样）
const UNDO = '删除通常不可逆；若文件曾被 git 跟踪，可尝试 `git restore <文件>`';
// 只有多行说明正文里才有的行 —— 卡里不该出现它们
const DETAIL_ONLY = ['为什么需要你确认', '可能的后果', '当前工作区'];

const L2_REQ = {
  tool_name: 'shellCommand',
  input: {
    level: 'L2',
    action: 'delete',
    scope: 'project',
    resource: LONG_RES,
    requireTyped: 'YES',
    explanation: {
      whatHappens: '删除或覆盖数据',
      headline: '⚠ 高风险操作：删除或覆盖数据',
      risks: ['被删除或覆盖的数据可能无法找回'],
      howToUndo: UNDO,
      text: [
        '⚠ 高风险操作：删除或覆盖数据',
        '',
        '为什么需要你确认：',
        '  · 动作 delete 属毁灭性/系统级，红灯',
        '',
        '可能的后果：',
        '  · 被删除或覆盖的数据可能无法找回',
        '',
        `撤销方式：${UNDO}`,
        '',
        '当前工作区：',
        '工作区：D:/Portable',
      ].join('\n'),
    },
  },
};

describeOrSkip('PermissionsPrompt 紧凑形态:框高可记账、证据离开框', () => {
  const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');

  let _saved;
  beforeEach(() => {
    _saved = process.env.KHY_PERMISSION_NOTICE;
    delete process.env.KHY_PERMISSION_NOTICE; // 默认 = 紧凑形态
  });
  afterEach(() => {
    if (_saved === undefined) delete process.env.KHY_PERMISSION_NOTICE;
    else process.env.KHY_PERMISSION_NOTICE = _saved;
  });

  test.each([120, 100, 80, 60])('cols=%i:frameRowCount 与实画行数逐一相等', async (cols) => {
    const rows = await mount(L2_REQ, cols);
    const ledger = Comp.frameRowCount({ request: L2_REQ, cols });
    expect(ledger).toBe(rows.length);
    // 每一行都不许超出终端宽度(超宽即 ink 二次折行 ⇒ 实画行数大于账本)
    for (const r of rows) {
      expect(visWidth(r)).toBeLessThanOrEqual(cols);
    }
  });

  test('卡宽贴合内容:短内容不撑满终端', async () => {
    const rows = await mount(L2_REQ, 160);
    const widest = rows.reduce((m, r) => Math.max(m, visWidth(r)), 0);
    expect(widest).toBeLessThan(120);
    // 卡内每行等宽(右对齐尾注靠这个成立)。末行是切片截断的下边框,不计。
    const widths = new Set(rows.slice(0, -1).map((r) => visWidth(r)));
    expect(widths.size).toBe(1);
  });

  test('卡内不再出现多行说明正文(为什么/后果/工作区属于输出区)', async () => {
    const frame = (await mount(L2_REQ, 100)).join('\n');
    expect(frame).not.toContain('2>NUL & echo done'); // 资源预览封顶
    for (const only of DETAIL_ONLY) {
      expect(frame).not.toContain(only);
    }
    expect(frame).toContain('↑全文见上'); // 裁了就必须指路
  });

  test('决定所需的最小充分集仍在卡内:等级 / 动作·范围 / 资源预览 / 撤销 / 记住 / 风险 / 三个选项', async () => {
    const frame = (await mount(L2_REQ, 100)).join('\n');
    expect(frame).toContain('红灯 L2');
    expect(frame).toContain('动作  delete · 范围 project'); // 标签列定宽 → 两个空格
    expect(frame).toContain('资源  del /F /Q');
    expect(frame).toContain('撤销  删除通常不可逆');
    // 「记住」行:如实说明「总是允许」会记住什么(按工具名,不区分参数)
    expect(frame).toContain('记住  只按工具名 shellCommand，不区分本次参数');
    expect(frame).toContain('⚠ 删除或覆盖数据 · 被删除或覆盖的数据可能无法找回');
    expect(frame).toContain('确认执行此高危操作（YES）');
    expect(frame).toContain('本会话内总是允许此类高危操作（YES）');
    expect(frame).toContain('拒绝');
  });

  test('「总是允许」被门控关掉时,卡里不出现「记住」行(不描述不存在的按钮)', async () => {
    const saved = process.env.KHY_L2_SESSION_ALLOW;
    process.env.KHY_L2_SESSION_ALLOW = 'off';
    try {
      const frame = (await mount(L2_REQ, 100)).join('\n');
      expect(frame).not.toContain('记住');
      // 账本同步少一行(仍与画面相等)
      expect(Comp.frameRowCount({ request: L2_REQ, cols: 100 })).toBe(
        (await mount(L2_REQ, 100)).length
      );
    } finally {
      if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
      else process.env.KHY_L2_SESSION_ALLOW = saved;
    }
  });

  test('diff 预览在卡内封顶,且排在选项之前(属「会改什么」区,不是页脚后的补丁)', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 20', 'line 20 CHANGED');
    const req = {
      tool_name: 'Write',
      input: {
        level: 'L1',
        action: 'write',
        scope: 'project',
        resource: 'note.md',
        diffPreview: { filePath: 'note.md', beforeContent: before, afterContent: after },
      },
    };
    const rows = await mount(req, 100);
    const frame = rows.join('\n');
    const diffAt = rows.findIndex((r) => r.includes('改动预览'));
    const firstOption = rows.findIndex((r) => r.includes('允许本次'));
    expect(diffAt).toBeGreaterThan(-1);
    expect(firstOption).toBeGreaterThan(diffAt); // diff 在选项之前
    expect(Comp.frameRowCount({ request: req, cols: 100 })).toBe(rows.length);
  });

  test('窄屏页脚折行而不裁:两行都在,「Esc 取消」不许丢', async () => {
    const frame = (await mount(L2_REQ, 60)).join('\n');
    expect(frame).toContain('Esc 取消');
    // [DESIGN-ARCH-146 / BUG-36b] L2 已改两段式 ⇒ footer 从「数字键直选」改为
    // 「数字键/点击 选中」+「Enter 确认执行」。文案随行为同步（BUG-36 的纪律）；
    // 段数刻意保持不变以维持折行 —— 若这段变短到不再折行，`Esc 取消` 会被裁掉，
    // 本用例即会红（见 footerTextOf 的注）。
    expect(frame).toContain('数字键/点击 选中');
    expect(frame).toContain('Enter 确认执行');
    expect(frame).toContain('默认「确认执行」');
  });

  test('框高与证据长度无关(旧形态会跟着证据一起长)', async () => {
    const compact = (await mount(L2_REQ, 100)).length;
    expect(compact).toBeLessThanOrEqual(13);
    // 说明长 12 行 —— 紧凑形态的卡高不该动一分(这才是用户诉求:资源不再挤占授权框)
    const fat = {
      ...L2_REQ,
      input: {
        ...L2_REQ.input,
        explanation: {
          ...L2_REQ.input.explanation,
          text: `${L2_REQ.input.explanation.text}\n${'补充说明一行\n'.repeat(12)}`,
        },
      },
    };
    expect((await mount(fat, 100)).length).toBe(compact);
    process.env.KHY_PERMISSION_NOTICE = '0';
    try {
      expect((await mount(fat, 100)).length).toBeGreaterThan(compact + 8);
    } finally {
      delete process.env.KHY_PERMISSION_NOTICE;
    }
  });

  test('门控关 → 回到旧形态且不记账(frameRowCount 返回 null)', async () => {
    process.env.KHY_PERMISSION_NOTICE = '0';
    expect(Comp.frameRowCount({ request: L2_REQ, cols: 100 })).toBeNull();
    const frame = (await mount(L2_REQ, 100)).join('\n');
    expect(frame).toContain('撤销方式：');
    expect(frame).toContain('红灯 L2 · 毁灭性/系统级');
  });

  test('带 diff 预览的写入请求:账本把预览的每一行也算进去', async () => {
    const req = {
      tool_name: 'Write',
      input: {
        level: 'L1',
        action: 'write',
        scope: 'project',
        resource: 'note.md',
        diffPreview: {
          filePath: 'note.md',
          beforeContent: 'a\nb\nc\n',
          afterContent: 'a\nB\nc\n',
        },
      },
    };
    const rows = await mount(req, 100);
    expect(Comp.frameRowCount({ request: req, cols: 100 })).toBe(rows.length);
  });
});
