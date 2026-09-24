'use strict';

/**
 * busyRenderSpinTdz — 回归守卫：busy 渲染读 `_spin` 的 TDZ 崩溃（2026-09-23 用户截图）。
 *
 * 事故栈：`Ink TUI init failed: ReferenceError: Cannot access '_spin' before
 * initialization at App.js:6701:36`（updateFunctionComponent → beginWork →
 * workLoopSync → performWorkOnRoot），首个忙碌回合（提交消息后 setStatus('thinking')
 * 触发 busy 重渲染）必崩 → Ink TUI 降级经典命令行。
 *
 * 根因：`_liveRegionEl`（App.js 的 `const _liveRegionEl = inputActive ? h(...)`）
 * 在**初始化时就急切求值 h() 全部参数**，其 STREAMING_STATUS 分支读 `_spin.stalled`
 * 等字段；而 `const _spin = _spinnerProgress(...)` 曾声明在 6855（首个 return 之前）
 * —— 同一函数体内「先读后声明」，TDZ。修复 = 声明上移到 `_liveRegionEl` 之前。
 *
 * 两层防线：
 *   1. 源码序断言（零 IO，秒级）：声明偏移必须早于首个使用偏移——TDZ 不变量；
 *      谁把它再挪回使用点之后，谁先红。
 *   2. 子进程 live busy 渲染（altScreenRestore.test.js 的 spawn 先例）：headless 挂
 *      **真** App，键入 'hi'+回车 驱动一次真实提交（useQueryBridge._runSubmit →
 *      setStatus('thinking')），断言 (a) 不再出现 _spin ReferenceError、(b) spinner
 *      真正出帧（'推理中'/'思考中' 状态行）、(c) chatFn 确已进入（busy 路径被走到）。
 *      `ai().chat` 被 Proxy 换成永不 resolve 的 Promise：busy 态稳定保持、**零网络**；
 *      KHY_DATA_HOME / KHY_PROJECT_DATA_HOME 钉进一次性临时目录（同
 *      jest.taskStoreIsolation.setup 的口径），绝不读写真实用户数据。
 *
 * 谁改动它谁先红：移动 `_spin` 声明（或重命名 `_spin`/`_spinnerProgress`/`_liveRegionEl`）
 * 必须同步更新目标串，否则本守卫失明。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const assert = require('node:assert');
const test = require('node:test');
const path = require('path');

const APP_PATH = path.resolve(__dirname, '..', '..', 'src', 'cli', 'tui', 'ink-components', 'App.js');

test('源码序：_spin 声明必须先于首个使用点（TDZ 不变量，零 IO）', () => {
  const src = fs.readFileSync(APP_PATH, 'utf8');
  const declIdx = src.indexOf('const _spin = _spinnerProgress(');
  const useIdx = src.indexOf('_spin.stalled');
  assert.ok(declIdx > 0, '未找到 `const _spin = _spinnerProgress(` —— 重命名了就同步更新本守卫');
  assert.ok(useIdx > 0, '未找到 `_spin.stalled` 使用点 —— 重命名了就同步更新本守卫');
  assert.ok(
    declIdx < useIdx,
    `声明(偏移 ${declIdx}) 必须先于使用(偏移 ${useIdx})；晚于使用即 TDZ，` +
      '首个 busy 渲染必崩（ReferenceError: Cannot access \'_spin\' before initialization，2026-09-23 事故）'
  );
});

// ── 子进程 live busy 渲染（真实 App，零网络，隔离数据目录）──────────────────
const CHILD_SCRIPT = `
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Writable, Readable } = require('stream');

const BACKEND = ${JSON.stringify(path.resolve(__dirname, '..', '..'))};

// 数据目录隔离必须先于任何 service require（getDataHome 会把 KHY_DATA_HOME 记忆化）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-busyrender-'));
process.env.KHY_DATA_HOME = home;
process.env.KHY_PROJECT_DATA_HOME = path.join(home, 'project');
process.env.KHY_TUI_PREWARM = '0';

const errors = [];
const note = (tag, err) => {
  errors.push('[' + tag + '] ' + (err && err.stack ? err.name + ': ' + err.message : String(err)));
};

function fakeStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buffer += chunk.toString(); cb(); },
  });
  stream.columns = 120;
  stream.rows = 40;
  stream.isTTY = false;
  stream.getBuffer = () => buffer;
  return stream;
}

// ink 6.8 经 'readable' + stdin.read() 拉取键入（App.js handleReadable），
// 故必须是可 push 的 Readable，而非 EventEmitter + emit('data')。
function fakeStdin() {
  const stream = new Readable({ read() {} });
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ai 隔离：真模块整体加载（挂载期其余成员照常工作），仅 chat 被换成永不 resolve
  // 的 Promise —— busy 态稳定保持、零网络、零 token 消耗。
  const requestor = path.join(BACKEND, 'src', 'cli', 'tui', 'hooks', 'useQueryBridge.js');
  const aiFilename = Module._resolveFilename('../../ai', { filename: requestor, id: requestor });
  const realAi = require(aiFilename);
  let chatCalls = 0;
  const aiStub = new Proxy(realAi, {
    get(target, prop, recv) {
      if (prop === 'chat') {
        return function hungChat() {
          chatCalls += 1;
          return new Promise(() => {});
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const origLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    let fn = null;
    try { fn = Module._resolveFilename(request, parent); } catch { fn = null; }
    if (fn === aiFilename) return aiStub;
    return origLoad.call(Module, request, parent, isMain);
  };

  process.on('uncaughtException', (e) => note('uncaughtException', e));
  process.on('unhandledRejection', (e) => note('unhandledRejection', e));

  const rt = require(path.join(BACKEND, 'src', 'cli', 'tui', 'inkRuntime'));
  rt.registerJsx();
  await rt.loadInk();
  const React = require('react');
  const App = require(path.join(BACKEND, 'src', 'cli', 'tui', 'ink-components', 'App'));

  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = rt.get().render(React.createElement(App, { options: {} }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.waitUntilExit().catch((e) => note('waitUntilExit', e));

  // 就绪轮询而非固定 sleep:virgin 数据目录 + 冷 babel 缓存下,boot 与 toolUseLoop
  // 链的懒加载耗时波动可达数十秒(inkRenderSmoke 头注释同款实测)。固定窗口会把
  // 「慢」误判成「坏」——上一版 2.5s 固定窗口就是这么把 chatCalls 探空的。
  const readyDeadline = Date.now() + 30000;
  while (!stdout.getBuffer().includes('输入消息') && Date.now() < readyDeadline) {
    await sleep(200);
  }
  stdin.push(Buffer.from('hi', 'utf8'));
  await sleep(400);
  stdin.push(Buffer.from('\\r', 'utf8'));   // 回车提交（真实用户动作同一条 stdin 路径）

  // 等 chatFn 真正进入(TDZ 崩溃发生在 setStatus('thinking') 的渲染期,早于 chatFn;
  // 这里轮询只为证明 busy 路径全链路走到了,不是崩溃判据本身)。
  const chatDeadline = Date.now() + 30000;
  while (chatCalls < 1 && Date.now() < chatDeadline) {
    await sleep(200);
  }
  await sleep(800);           // 让 busy 帧落定

  const frame = stdout.getBuffer();
  try { instance.unmount(); } catch { /* best-effort */ }

  const spinError = errors.join('\\n').includes("Cannot access '_spin' before initialization");
  const spinnerVisible = frame.includes('推理中') || frame.includes('思考中');
  const pass = !spinError && spinnerVisible && chatCalls >= 1;
  console.log('VERDICT: ' + (pass ? 'PASS' : 'FAIL') +
    ' spinError=' + spinError + ' spinnerVisible=' + spinnerVisible + ' chatCalls=' + chatCalls);
  if (errors.length) console.log('ERRORS:\\n' + errors.join('\\n---\\n'));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.log('VERDICT: FAIL fatal=' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
`;

test('live：busy 渲染（submit 驱动）不再抛 _spin TDZ，spinner 正常出帧', () => {
  const r = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    encoding: 'utf8',
    timeout: 90000,
    env: process.env,
  });
  const out = String(r.stdout || '');
  const errTail = String(r.stderr || '').slice(-2500);
  assert.strictEqual(
    r.status,
    0,
    `child exit=${r.status}\n[stdout]\n${out.slice(-2500)}\n[stderr tail]\n${errTail}`
  );
  assert.ok(out.includes('VERDICT: PASS'), `expected PASS verdict, got: ${out.slice(-800)}`);
});
