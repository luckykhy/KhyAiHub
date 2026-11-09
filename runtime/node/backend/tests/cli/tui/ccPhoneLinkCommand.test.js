'use strict';

/**
 * ccPhoneLinkCommand.test.js — CC 侧收集式命令桥的断言（node:test）。
 *
 * 锁四件事：
 *   ① **只放行 phone / amoo**。CcApp 头注明写「完整 CC 复刻未获授权裁决 ⇒ 保持预览」，
 *      所以本桥不接其它命令，它们照旧走回声桩；
 *   ② handler 的多次 print（`  ✓ ` / `  i `）**真的被收成一段 notice 文本** ——
 *      这是「复用 commandOutputSink 既有范式」而不是另写一套收集逻辑的证据；
 *   ③ 门控关 / route 抛错 / 无输出 → 一律 null，调用方逐字节回退，**不假执行**；
 *   ④ 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const TUI = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui');
const SINK_PATH = path.join(TUI, 'commandOutputSink.js');
const ROUTER_PATH = path.join(TUI, '..', 'router.js');
const CMD_PATH = path.join(TUI, 'ccPhoneLinkCommand.js');

// ── 假 sink：真的 patch console.log，证明桥走的是收集范式而不是另写一套 ──────

function makeFakeSink({ enabled = true } = {}) {
  const calls = { sinks: 0, routes: [] };
  const mod = {
    calls,
    captureEnabled: (env) => enabled,
    createSink() {
      calls.sinks += 1;
      const orig = console.log;
      let buf = '';
      console.log = (...args) => {
        buf += args.map((a) => String(a)).join(' ') + '\n';
      };
      return {
        restore() {
          console.log = orig;
        },
        text() {
          return buf.replace(/\n+$/, '');
        },
      };
    },
  };
  return mod;
}

function makeFakeRouter({ throwInRoute = false, parsed = { command: 'phone', sub: 'status' } } = {}) {
  const calls = { routes: [] };
  const mod = {
    calls,
    parseInput: (line) => ({ ...parsed, raw: String(line) }),
    async route(p, ctx) {
      calls.routes.push({ parsed: p, ctx });
      if (throwInRoute) {
        throw new Error('handler exploded');
      }
      // 复刻 handlers/phone.js 的多次 print 形状。
      console.log('  ✓ 手机桥接在线');
      console.log('  i 设备：192.168.2.46:33743');
      return undefined;
    },
  };
  return mod;
}

function install(fakes) {
  const saved = new Map();
  for (const [p, mod] of Object.entries(fakes)) {
    const resolved = require.resolve(p);
    saved.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: mod,
    };
  }
  delete require.cache[require.resolve(CMD_PATH)];
  return () => {
    delete require.cache[require.resolve(CMD_PATH)];
    for (const [k, v] of saved) {
      if (v === undefined) delete require.cache[k];
      else require.cache[k] = v;
    }
  };
}

// ── isPhoneLinkCommand（纯函数，不需要桩）────────────────────────────────────

test('isPhoneLinkCommand：只认 phone / amoo，三种前缀都归一', () => {
  const { isPhoneLinkCommand } = require(CMD_PATH);
  for (const line of [
    'khy phone status',
    '/phone status',
    'phone status',
    '  KHY phone tools  ',
    'khy amoo plan 打开微信',
    'amoo send 你好 --confirm',
    'khyquant amoo status',
  ]) {
    assert.equal(isPhoneLinkCommand(line), true, line);
  }
  // 裸命令（无子命令）也放行：handler 会打自己的用法，那正是用户想看的。
  for (const line of ['khy amoo', 'amoo', 'khy phone', 'phone']) {
    assert.equal(isPhoneLinkCommand(line), true, line);
  }
  for (const line of [
    'khyphone status',
    'hello',
    '/help',
    'khy doctor',
    'amooish status',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isPhoneLinkCommand(line), false, String(line));
  }
});

// ── runPhoneLinkCommand ─────────────────────────────────────────────────────

test('不放行的命令：不建 sink、不调 route，返回 null', async () => {
  const sink = makeFakeSink();
  const router = makeFakeRouter();
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy doctor'), null);
    assert.equal(sink.calls.sinks, 0);
    assert.equal(router.calls.routes.length, 0);
  } finally {
    restore();
  }
});

test('放行：handler 的多次 print 被收成一段 notice 文本', async () => {
  const sink = makeFakeSink();
  const router = makeFakeRouter();
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    const res = await runPhoneLinkCommand('khy phone status');
    assert.ok(res, '应有输出');
    assert.equal(sink.calls.sinks, 1, '该走收集路径');
    assert.equal(router.calls.routes.length, 1);
    // 多行、含 printSuccess/printInfo 的前缀（`  ✓ ` / `  i `），且首尾无空行
    // （sink.text() 的职责）。
    assert.ok(res.content.includes('  ✓ 手机桥接在线'));
    assert.ok(res.content.includes('  i 设备：192.168.2.46:33743'));
    assert.equal(res.content.split('\n').length, 2);
    // 首尾无空行（sink.text() 的职责）。注意**不是** trim()：printSuccess 的前缀
    // `  ✓ ` 自带两格前导，那是有意义的缩进，不能掉。
    assert.equal(res.content, res.content.replace(/^\n+/, '').replace(/\n+$/, ''));
  } finally {
    restore();
  }
});

test('收集期结束后 console.log 已还原（sink.restore 一定被调用）', async () => {
  const sink = makeFakeSink();
  const router = makeFakeRouter();
  const orig = console.log;
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    await runPhoneLinkCommand('khy phone status');
    assert.equal(console.log, orig, '收集必须收尾，否则整进程的日志全进 buffer');
  } finally {
    restore();
    console.log = orig;
  }
});

test('收集门控关 → null（不回落到「让出终端」：CC 表面没有那条路）', async () => {
  const sink = makeFakeSink({ enabled: false });
  const router = makeFakeRouter();
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy phone status'), null);
    assert.equal(sink.calls.sinks, 0);
    assert.equal(router.calls.routes.length, 0);
  } finally {
    restore();
  }
});

test('route 抛错 → null，且 console.log 已还原', async () => {
  const sink = makeFakeSink();
  const router = makeFakeRouter({ throwInRoute: true });
  const orig = console.log;
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy amoo status'), null);
    assert.equal(console.log, orig);
  } finally {
    restore();
    console.log = orig;
  }
});

test('handler 一声不响 → null（不落一条空 notice）', async () => {
  const sink = makeFakeSink();
  const router = makeFakeRouter();
  router.route = async () => undefined; // 什么都不 print
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: router });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy phone tools'), null);
  } finally {
    restore();
  }
});

test('router 模块本身不可用 → null（绝不抛）', async () => {
  const sink = makeFakeSink();
  const restore = install({ [SINK_PATH]: sink, [ROUTER_PATH]: { get parseInput() { throw new Error('no router'); } } });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy phone status'), null);
  } finally {
    restore();
  }
});

test('sink 模块不可用 → null（绝不抛）', async () => {
  const restore = install({ [SINK_PATH]: { get captureEnabled() { throw new Error('no sink'); } }, [ROUTER_PATH]: makeFakeRouter() });
  try {
    const { runPhoneLinkCommand } = require(CMD_PATH);
    assert.equal(await runPhoneLinkCommand('khy phone status'), null);
  } finally {
    restore();
  }
});
