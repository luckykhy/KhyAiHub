'use strict';

/**
 * permissionsPromptDigitFooter.test.js — 授权框 footer 与 handler 能力一致性守卫(BUG-36)。
 *
 * 缺陷本体:PermissionsPrompt 的 useInput 对 L1/L2 共用同一段数字键直选逻辑
 * (`navCh >= '1' && navCh <= '9'` -> 立即 resolve,不看光标),但 footer 的 L2 两个分支
 * 唯独不写「数字键直选」——仓内其余浮层(QuestionPrompt / FormFlow / RewindPicker)以及
 * 本组件的 L1 分支都写了。用户照 footer 以为只能 ↑/↓+Enter,实际按一个数字键就定了。
 *
 * 这里挂**真实 ink + 真实组件**,喂真字节,锁两件事:
 *   1) footer 三种变体(L1 / L2 允许优先 / L2 高危 opt-out)都列全 handler 实际接受的键类;
 *   2) 数字键在 L2 上的真实后果——若将来改变该策略,本用例必须同步改,好让那次改变是
 *      显式的而非顺手发生(BUG-36b 的裁决点)。
 *
 * ── BUG-36b 已裁决(2026-09-24, [DESIGN-ARCH-146])：L2 改为**两段式** ──────────────
 * 裁决内容：L2 高危卡上，数字键与鼠标点击**只把光标移到该选项**，须再按 Enter 才真正授权。
 * 动机：原「一键直选」下按 `2` 会直接发出「本会话内总是允许此类高危操作」——比默认行的
 * 单次回车后果更重却无二次确认；加鼠标点击后同一问题会在误触上重演。
 * L1 不受影响（仍是数字键直选）。
 *
 * 因此本文件的两个「真实后果」用例已按新契约改写：**数字键不再 resolve**，
 * 而是 `resolved === null`（只移动了光标）；随后按 Enter 才产生原后果。
 * footer 断言同步为「数字键/点击 选中 · Enter 确认执行」。
 *
 * 跑法同 inkRenderSmoke:需 --experimental-vm-modules(见 scripts/run-ink-tui-tests.js)。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[permissionsPromptDigitFooter] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(/[\u2502\u2500\u250c\u2510\u2514\u2518]/g, '');

/** ink 的 stdin 契约:components/App.js 只 addListener('readable') + read(),不 resume。 */
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

function collectingStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = 100;
  stream.rows = 30;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const L2_REQ = {
  tool_name: 'Bash',
  input: { command: 'rm -rf /var/data', level: 'L2', action: 'delete', scope: 'filesystem', requireTyped: 'YES' },
};
const L1_REQ = {
  tool_name: 'Write',
  input: { command: '', level: 'L1', action: 'write', scope: 'workspace', description: '写一个文件' },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function mount(request, envOverride) {
  const saved = process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
  if (envOverride === undefined) delete process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
  else process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK = envOverride;
  const ink = await rt.loadInk();
  const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');
  const stdin = pressableStdin();
  const stdout = collectingStdout();
  let resolved = '<<none>>';
  let hit = false;
  const instance = ink.render(
    React.createElement(Comp, { request, onResolve: (v) => { hit = true; resolved = v; } }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );
  await wait(60);
  return {
    frame: stripAnsi(stdout.getBuffer()),
    press: async (bytes) => { stdin.press(bytes); await wait(60); },
    got: () => ({ hit, resolved }),
    unmount: () => instance.unmount(),
    restore: () => {
      if (saved === undefined) delete process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
      else process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK = saved;
    },
  };
}

const footerOf = (frame) => (frame.split('\n').find((l) => /Enter/.test(l)) || '').trim();

describeOrSkip('PermissionsPrompt footer 与实际接受的键类一致(BUG-36)', () => {
  test('L2 允许优先变体:footer 必须写明「数字键/点击 选中」与「Enter 确认执行」', async () => {
    const m = await mount(L2_REQ);
    try {
      const f = m.frame;
      // [DESIGN-ARCH-146 / BUG-36b] L2 已改两段式:数字键不再直选 ⇒ footer 相应改为「选中」。
      expect(f).toContain('数字键/点击 选中');
      expect(f).toContain('Enter 确认执行');
      expect(f).toContain('默认「确认执行」');
    } finally { m.unmount(); m.restore(); }
  });

  test('L2 高危 opt-out 变体(默认拒绝):footer 同样写明「选中」与 Enter', async () => {
    const m = await mount(L2_REQ, 'off');
    try {
      const f = m.frame;
      expect(f).toContain('数字键/点击 选中');
      expect(f).toContain('Enter 确认');
      expect(f).toContain('默认「拒绝」');
    } finally { m.unmount(); m.restore(); }
  });

  test('L1 变体:footer 三个键类齐全(回归对照,行为未变)', async () => {
    const m = await mount(L1_REQ);
    try {
      const f = footerOf(m.frame);
      expect(f).toContain('数字键');
      expect(f).toContain('Enter');
      expect(f).toContain('Esc');
    } finally { m.unmount(); m.restore(); }
  });

  // ── BUG-36b 裁决后的新契约:L2 数字键**只选中**,需 Enter 才授权 ──────────────

  test('L2 两段式:按数字键**只移动光标**,不产生任何授权结果(BUG-36b)', async () => {
    const m = await mount(L2_REQ);
    try {
      await m.press('2');
      // 数字键只选中 —— 未调用 onResolve（`'<<none>>'` 是 mount 里的初值哨兵）。
      expect(m.got().hit).toBe(false);
      expect(m.got().resolved).toBe('<<none>>');
    } finally { m.unmount(); m.restore(); }
  });

  test('L2 两段式:数字键 2 后再按 Enter ⇒ 才发出「本会话总是允许此类」', async () => {
    const m = await mount(L2_REQ);
    try {
      await m.press('2');
      expect(m.got().hit).toBe(false); // 第一步：仅选中
      await m.press('\r');
      expect(m.got().hit).toBe(true);
      expect(m.got().resolved).toEqual({ behavior: 'allow-always', typed: 'YES', scope: 'session' });
    } finally { m.unmount(); m.restore(); }
  });

  test('L2 两段式:数字键 1 后按 Enter ⇒ 确认执行(单次)', async () => {
    const m = await mount(L2_REQ);
    try {
      await m.press('1');
      expect(m.got().hit).toBe(false);
      await m.press('\r');
      expect(m.got().hit).toBe(true);
      expect(m.got().resolved).toEqual({ behavior: 'allow', typed: 'YES' });
    } finally { m.unmount(); m.restore(); }
  });

  test('L2 两段式:高危 opt-out 态下按 1 再 Enter ⇒ 拒绝(数字键跟随排序,仅选中)', async () => {
    const m = await mount(L2_REQ, 'off');
    try {
      await m.press('1');
      expect(m.got().hit).toBe(false);
      await m.press('\r');
      expect(m.got().hit).toBe(true);
      expect(m.got().resolved).toBe(false);
    } finally { m.unmount(); m.restore(); }
  });

  test('L1 回归对照:数字键**仍然**一键直选(未受 L2 两段式影响)', async () => {
    const m = await mount(L1_REQ);
    try {
      await m.press('1');
      // L1 不两段式 ⇒ 数字键立即 resolve（与改前一致）。
      expect(m.got().hit).toBe(true);
    } finally { m.unmount(); m.restore(); }
  });
});
