'use strict';

/**
 * commandOutputSink — 回归守卫：斜杠命令输出收集（2026-10-10「/ 命令一闪即过」修复）。
 *
 * 病史（repro 见 works/data/khy/feedback/slash-command-flash-20261010/）：TUI 里
 * 除了 /model（原生 ModelPicker 覆盖层，从不往终端打），其余 / 命令的输出全部
 * 「一闪即过」。两条取死路：
 *   ① ink 的 patchConsole 每拦一次 console.log 就重画整帧（writeToStdout →
 *      log.clear + 写行 + restoreLastOutput），一行输出花掉约 5 个屏幕行；
 *   ② 命令收尾那一帧以换行收尾，屏幕整体上滚把输出顶出视口，而 TUI 跑在备用
 *      缓冲区（KHY_ALT_SCREEN 默认开）里，滚出去即永久消失。
 * 修法：命令执行期收编 console 与直接 stdout 写，跑完作为一条 role:'notice'
 * 落进 transcript（与 tuiCommandReports.dispatchNativeCommand 同范式）。
 *
 * 本文件锁三件事：
 *   1. 收集叶本体：console 四件套 / 直接 stdout 写进 buffer，ink 的帧原样透传，
 *      restore() 逐字节还原，text() 剥净控制序列；
 *   2. App._runRoutedCaptured：route() 的产出变成一条 notice（门控关 → 不收集）；
 *   3. 接线：runRouted 的两条 route() 调用（通用路径 + /compact）都走收集管线，
 *      app.js 的 stdout Proxy 在代写期间置位透传闸。
 *
 * 可在 jest(describe/test/expect)与 `node --test` 双跑(下方 shim)。
 */

const fs = require('fs');
const path = require('path');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const nodeTest = require('node:test');
  const assert = require('node:assert');
  _describe = nodeTest.describe;
  _test = nodeTest.test;
  _expect = (actual) => ({
    toBe: (exp) => assert.strictEqual(actual, exp),
    toEqual: (exp) => assert.deepStrictEqual(actual, exp),
    toContain: (sub) => assert.ok(String(actual).includes(sub), `expected to contain: ${sub}`),
    toMatch: (re) => assert.match(String(actual), re),
    toHaveLength: (n) => assert.strictEqual(actual.length, n),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const sink = require('../../src/cli/tui/commandOutputSink');
const stripAnsi = require('../../src/utils/stripAnsi');

/** 假 stdout：记录真实写出的字节（透传路径断言用）。 */
function fakeStdout() {
  const written = [];
  const stream = {
    write(chunk, enc, cb) {
      written.push(String(chunk));
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    },
  };
  stream.written = written;
  stream.joined = () => written.join('');
  return stream;
}

_describe('commandOutputSink 叶：收集/透传/还原', () => {
  _test('console 四件套按序进 buffer，restore() 后逐字节还原', () => {
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const stdout = fakeStdout();
    const s = sink.createSink({ stdout, stripAnsi });
    console.log('第一行');
    console.info('第二行');
    console.warn('第三行');
    console.error('第四行');
    s.restore();
    _expect(console.log).toBe(orig.log);
    _expect(console.info).toBe(orig.info);
    _expect(console.warn).toBe(orig.warn);
    _expect(console.error).toBe(orig.error);
    _expect(s.text()).toBe('第一行\n第二行\n第三行\n第四行');
    // 还原后再写不走收集器（回到 ink 的 patchConsole 版本）。
    console.log = orig.log;
  });

  _test('text() 剥 ANSI/OSC、去行尾空白与首尾空行；空 → 空串', () => {
    const stdout = fakeStdout();
    const s = sink.createSink({ stdout, stripAnsi });
    console.log('');
    console.log('\u001b[36m\u001b[1m  khy OS\u001b[m \u001b[2m命令速查\u001b[22m   ');
    console.log('\u001b]0;window title\u0007');
    console.log('用法: khy <命令>');
    console.log('');
    console.log('');
    const text = s.text();
    s.restore();
    _expect(text).toBe('  khy OS 命令速查\n用法: khy <命令>');
    // 空会话：一条不落。
    const empty = sink.createSink({ stdout: fakeStdout(), stripAnsi });
    _expect(empty.text()).toBe('');
    empty.restore();
    // 只产控制序列（topicBar 的 OSC 标题）也当空 —— 不留空行噪声。
    const noise = sink.createSink({ stdout: fakeStdout(), stripAnsi });
    noise.restore();
    _expect(noise.text()).toBe('');
  });

  _test('直接 stdout 写被收集；ink 闸内的写原样透传（逐字节）', () => {
    const stdout = fakeStdout();
    const s = sink.createSink({ stdout, stripAnsi });
    // handler 的直接写 → 进 buffer，不落终端。
    stdout.write('hello from handler\n');
    // ink 的帧（Proxy 代写期间置位闸）→ 原样透传。
    const FRAME = '\u001b[2J\u001b[Hframe-bytes\u001b[K';
    sink.runInkWrite(() => stdout.write(FRAME));
    s.restore();
    _expect(s.text()).toBe('hello from handler');
    _expect(stdout.joined()).toBe(FRAME);
  });

  _test('stdout.write 的回调契约不被收集破坏', () => {
    const stdout = fakeStdout();
    const s = sink.createSink({ stdout, stripAnsi });
    let called = 0;
    const ret = stdout.write('x\n', () => { called += 1; });
    s.restore();
    _expect(ret).toBe(true);
    _expect(called).toBe(1);
  });

  _test('runInkWrite 可嵌套，异常也归位', () => {
    _expect(sink.isInkWrite()).toBe(false);
    sink.runInkWrite(() => {
      _expect(sink.isInkWrite()).toBe(true);
      sink.runInkWrite(() => {
        _expect(sink.isInkWrite()).toBe(true);
      });
      _expect(sink.isInkWrite()).toBe(true);
    });
    _expect(sink.isInkWrite()).toBe(false);
    let threw = false;
    try {
      sink.runInkWrite(() => { throw new Error('boom'); });
    } catch {
      threw = true;
    }
    _expect(threw).toBe(true);
    _expect(sink.isInkWrite()).toBe(false);
  });

  _test('门控 captureEnabled：默认开，显式 falsy 关', () => {
    _expect(sink.captureEnabled({})).toBe(true);
    _expect(sink.captureEnabled({ KHY_TUI_COMMAND_CAPTURE: undefined })).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      _expect(sink.captureEnabled({ KHY_TUI_COMMAND_CAPTURE: v })).toBe(false);
    }
    for (const v of ['1', 'true', 'on']) {
      _expect(sink.captureEnabled({ KHY_TUI_COMMAND_CAPTURE: v })).toBe(true);
    }
  });
});

_describe('_runRoutedCaptured：route() 产出落成 notice', () => {
  // App.js 挂整棵服务图，require 成本高；这里只取导出的纯函数。
  const App = require('../../src/cli/tui/ink-components/App');
  const run = App._runRoutedCaptured;

  /** 收集 setMessages 落下的最后一条（生产形态是函数式更新）。 */
  function captureQuery() {
    const msgs = [];
    return { msgs, query: { setMessages: (fn) => { const next = fn(msgs); msgs.length = 0; msgs.push(...next); } } };
  }

  _test('命令输出作为一条 role:notice 落进 transcript，返回值透传', async () => {
    const { msgs, query } = captureQuery();
    const fakeRoute = async () => {
      console.log('  扫描完成: 未发现威胁 (1.2s)');
      console.log('  已隔离到 ~/.khyquant/quarantine/');
      return true;
    };
    const result = await run(fakeRoute, { command: 'scan' }, query);
    _expect(result).toBe(true);
    _expect(msgs).toHaveLength(1);
    _expect(msgs[0].role).toBe('notice');
    _expect(msgs[0].content).toBe('  扫描完成: 未发现威胁 (1.2s)\n  已隔离到 ~/.khyquant/quarantine/');
    _expect(typeof msgs[0].timestamp).toBe('number');
  });

  _test('无输出的命令不落 notice（不制造空行）', async () => {
    const { msgs, query } = captureQuery();
    const result = await run(async () => false, { command: 'silent' }, query);
    _expect(result).toBe(false);
    _expect(msgs).toHaveLength(0);
  });

  _test('route() 抛错时收集器仍还原，错向上抛（由调用方落 error 行）', async () => {
    const orig = console.log;
    const { msgs, query } = captureQuery();
    const fakeRoute = async () => {
      console.log('半行输出');
      throw new Error('命令炸了');
    };
    let threw = null;
    try {
      await run(fakeRoute, { command: 'boom' }, query);
    } catch (err) {
      threw = err;
    }
    _expect(threw && threw.message).toBe('命令炸了');
    _expect(console.log).toBe(orig); // finally 里还原，绝不漏 patch
    _expect(msgs).toHaveLength(0); // 抛错路径不落 notice（调用方落 error）
    console.log = orig;
  });

  _test('门控关（KHY_TUI_COMMAND_CAPTURE=0）→ 不收集、不落 notice、输出照旧打终端', async () => {
    const prev = process.env.KHY_TUI_COMMAND_CAPTURE;
    process.env.KHY_TUI_COMMAND_CAPTURE = '0';
    try {
      const orig = console.log;
      const { msgs, query } = captureQuery();
      const seen = [];
      // 门控关时 console.log 不被 patch：用替身验证「照旧打终端」。
      console.log = (...a) => seen.push(a.join(' '));
      const result = await run(async () => { console.log('旧路径输出'); return true; }, { command: 'x' }, query);
      console.log = orig;
      _expect(result).toBe(true);
      _expect(seen).toEqual(['旧路径输出']);
      _expect(msgs).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.KHY_TUI_COMMAND_CAPTURE;
      else process.env.KHY_TUI_COMMAND_CAPTURE = prev;
    }
  });
});

_describe('接线守卫（源码形状锁：叶子全绿也证明不了生效）', () => {
  const appSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/App.js'), 'utf8'
  );
  const tuiAppSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/app.js'), 'utf8'
  );

  _test('runRouted 的通用路径走 _runRoutedCaptured（让出终端旧路径只在门控关时保留）', () => {
    _expect(appSrc).toContain('result = await _runRoutedCaptured(route, parsed, query);');
    // 旧路径（app.clear 让屏）必须仍在，但被门控关的分支包着。
    _expect(appSrc).toMatch(/if \(!_captureOn\) \{[\s\S]*?app\.clear\(\)/);
    _expect(appSrc).toContain('const _captureOn = commandOutputSink.captureEnabled(process.env);');
  });

  _test('/compact 也走收集管线（它的 console 输出同样会被放大后滚光）', () => {
    _expect(appSrc).toContain('await _runRoutedCaptured(route, parsed, query);');
  });

  _test('app.js 的 stdout Proxy 在代写期间置位透传闸（否则整帧被收进 buffer，屏幕冻住）', () => {
    _expect(tuiAppSrc).toContain("const inkWriteGate = require('./commandOutputSink');");
    _expect(tuiAppSrc).toContain('inkWriteGate.runInkWrite(() => target.write(out, ...rest))');
  });
});
