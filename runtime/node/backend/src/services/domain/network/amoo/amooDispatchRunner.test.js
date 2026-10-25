'use strict';

// Co-located unit test for amooDispatchRunner.js.
//
// This is the whole round trip, simulated: a scripted sequence of `uiautomator
// dump` files answers every screen read, and the bridge's HTTP port is a real
// loopback server. No phone, no network, no message ever sent.
//
// What that makes assertable — and what would otherwise only be discoverable by
// sending a message to someone's actual phone:
//   - `confirm !== true` executes NOTHING and returns the plan,
//   - the send button is tapped by coordinates resolved from the LIVE dump, so
//     the keyboard moving the input box cannot break it,
//   - an empty input after the fill aborts BEFORE the send tap (no empty message),
//   - the poll loop stops on the stability rule and reports which rule fired,
//   - a timeout is reported as a timeout, never as an answer.

const test = require('node:test').test;
const before = require('node:test').before;
const after = require('node:test').after;
const assert = require('node:assert/strict');
const http = require('node:http');
const cp = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TOKEN = '5500fae8db41cd054f45ea8834198d30';
const SERIAL = '192.168.2.46:33743';
const TASK = '帮我查一下今天的日程';

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-run-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

const sandbox = pinSandbox();

const IDS = {
  chatListId: 'com.stepos.ailauncher:id/chat_list',
  inputId: 'com.stepos.ailauncher:id/et_input_bar',
  sendId: 'com.stepos.ailauncher:id/btn_text_send',
};

function node(resourceId, text, bounds, extra = {}) {
  return `<node resource-id="${resourceId}" class="android.widget.TextView" text="${text}" content-desc="" clickable="${extra.clickable === true ? 'true' : 'false'}" scrollable="false" enabled="true" bounds="${bounds}" />`;
}

function dumpXml({ chat = [], input = '发消息或按住说话', inputBounds = '[241,2388][950,2505]', send = false }) {
  const chatNodes = chat.map((text, index) =>
    node('', text, `[120,${300 + index * 120}][1000,${380 + index * 120}]`)
  );
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
${node('', '', '[0,0][1200,2670]')}
${node(IDS.chatListId, '', '[52,0][1148,1054]')}
${chatNodes.join('\n')}
${node('', 'Amoo，你的全能伙伴', '[285,1267][915,1353]')}
${node(IDS.inputId, input, inputBounds, { clickable: true })}
${send ? node(IDS.sendId, '', '[960,1301][1103,1418]', { clickable: true }) : ''}
</hierarchy>`;
}

// ── scripted device ───────────────────────────────────────────────────────

// Every text-entry command is ONE device-shell string: `input tap ...`,
// `input keyevent ...`, `input text '...'`, and the bounded DEL loop
// `i=0; while [ $i -lt N ]; do input keyevent 67; ...`. Matching the token
// anywhere in the string is what makes this router robust to both shapes.
function isInputCommand(command) {
  return /(?:^|\s)input(?:\s|$)/.test(String(command || ''));
}

const REAL_SPAWN = cp.spawn;
const spawnLog = [];
let dumpScript = [];
let dumpIndex = 0;
let bridgeCalls = [];

function fakeSpawn(file, argv) {
  spawnLog.push(argv.slice());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => true;
  const joined = argv.join(' ');

  if (argv.includes('pair')) {
    setImmediate(() => {
      child.stderr.emit('data', 'protocol fault');
      child.emit('close', 1);
    });
    return child;
  }

  let out = '';
  let code = 0;
  if (argv[0] === 'devices') {
    out = `List of devices attached\n${SERIAL}\tdevice\n`;
  } else if (argv[0] === 'connect') {
    out = 'connected\n';
  } else if (argv[0] === '-s' && argv[2] === 'forward') {
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && isInputCommand(argv[3])) {
    // Covers `input tap`, `input keyevent`, `input text '...'` and the bounded
    // DEL loop — all of them arrive as ONE device-shell command string.
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && String(argv[3]).startsWith('cat')) {
    out = `${TOKEN}\n`;
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'monkey') {
    out = 'Events injected: 1\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'uiautomator') {
    out = 'UI hierchary dumped\n';
  } else if (argv[0] === '-s' && argv[2] === 'pull') {
    // Serve the next scripted screen.
    const local = argv[4];
    const xml = dumpScript[Math.min(dumpIndex, dumpScript.length - 1)];
    dumpIndex += 1;
    fs.writeFileSync(local, xml, 'utf8');
    out = '1 file pulled\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'rm') {
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'push') {
    out = '1 file pushed\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'am') {
    out = 'Starting: Intent { cmp=com.stepos.ailauncher/.chat.activity.ChatMainActivity }\n';
  } else {
    code = 127;
    out = `unhandled ${joined}`;
  }
  setImmediate(() => {
    if (out) {
      child.stdout.emit('data', out);
    }
    child.emit('close', code);
  });
  return child;
}

cp.spawn = fakeSpawn;
after(() => {
  cp.spawn = REAL_SPAWN;
});

const { resolveAmooConfig } = require('./amooBridgeConfig');
const { createAmooStack } = require('./index');

let server;
let basePort;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      bridgeCalls.push({ url: req.url, auth: req.headers.authorization, body });
      const send = (payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.url.startsWith('/ping')) {
        return send({ ok: true, pong: Date.now() });
      }
      if (req.url.startsWith('/status')) {
        return send({ ok: true, up: true, port: basePort, mode: 'lite', tools: 22 });
      }
      return send({ ok: true, tool: 'clipboard', op: 'set' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  basePort = server.address().port;
});

after(() => {
  server.close();
});

function makeStack(overrides = {}) {
  const env = {
    KHY_AMOO_ADB_PATH: 'C:/fake/adb.exe',
    KHY_AMOO_BRIDGE_PORT: String(basePort),
    KHY_AMOO_LAUNCH_WAIT_MS: '0',
    KHY_AMOO_INPUT_WAIT_MS: '0',
    KHY_AMOO_SEND_WAIT_MS: '0',
    KHY_AMOO_POLL_INTERVAL_MS: '250',
    KHY_AMOO_POLL_MAX_INTERVAL_MS: '250',
    KHY_AMOO_REPLY_STABLE_ROUNDS: '2',
    KHY_AMOO_POLL_MAX_ROUNDS: '20',
    ...(overrides.env || {}),
  };
  return createAmooStack({
    env,
    spawnImpl: fakeSpawn,
    sleep: async () => {},
    now: () => Date.now(),
    getAppDataDir: (...segments) => path.join(sandbox, ...segments),
  });
}

// A full, successful run: greeting → text in the box → send button → user
// bubble → reply growing → reply stable for 2 rounds.
function scriptHappyPath() {
  dumpIndex = 0;
  dumpScript = [
    dumpXml({}), // focus-input
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }), // verify-input
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }), // tap-send
    dumpXml({ chat: [TASK] }), // poll 1
    dumpXml({ chat: [TASK, '今天有 3 个日程：10:00 站会。'] }), // poll 2
    dumpXml({ chat: [TASK, '今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。'] }), // poll 3
    dumpXml({ chat: [TASK, '今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。'] }), // poll 4 (stable 1)
    dumpXml({ chat: [TASK, '今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。'] }), // poll 5 (stable 2)
  ];
}

test('a dispatch without confirm executes nothing and returns the plan', async () => {
  scriptHappyPath();
  spawnLog.length = 0;
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: TASK });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'confirm_required');
  assert.match(result.message, /confirm/);
  assert.ok(Array.isArray(result.planText));
  assert.match(result.planText.join('\n'), /等待策略/);
  // Not one adb command was issued.
  assert.equal(spawnLog.length, 0);
  assert.equal(result.steps.length, 0);
});

test('the layer gate short-circuits before anything is planned', async () => {
  const { runner } = makeStack({ env: { KHY_AMOO_BRIDGE_ENABLED: '0' } });
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.code, 'layer_disabled');
  assert.match(result.message, /KHY_AMOO_BRIDGE_ENABLED/);
});

test('an empty task is rejected before the phone is touched', async () => {
  spawnLog.length = 0;
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: '   ', confirm: true });
  assert.equal(result.code, 'task_empty');
  assert.equal(spawnLog.length, 0);
});

test('a happy-path dispatch sends the text and returns Amoo answer', async () => {
  scriptHappyPath();
  spawnLog.length = 0;
  bridgeCalls = [];
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true });

  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.code, 'ok');
  assert.equal(result.inputRoute, 'clipboard');
  assert.match(result.reply.text, /今天有 3 个日程/);
  assert.match(result.reply.text, /18:30 健身/);
  // The echoed user bubble is subtracted from the reply.
  assert.equal(result.reply.echoStripped, true);
  assert.equal(result.reply.text.includes(TASK), false);
  assert.equal(result.poll.stopReason, 'reply_stable_text_stable');
  // Polls 3 and 4 carry the identical full reply, so a 2-round stability rule is
  // satisfied at round 4 — not at the round cap.
  assert.equal(result.poll.rounds, 4);
  assert.equal(result.baselineChars, 0);
  assert.match(result.message, /已收到 Amoo 答复/);

  // Every step ran and every step is in the log.
  assert.deepEqual(
    result.steps.map((step) => step.id),
    [
      'ensure-device',
      'ensure-forward',
      'bridge-ping',
      'launch-amoo',
      'focus-input',
      'focus-input-tap',
      'fill-text',
      'verify-input',
      'tap-send',
      'poll-reply',
    ]
  );
  assert.equal(result.steps.every((step) => step.ok), true);

  // The clipboard is used exactly once, through the HTTP bridge, with the token.
  // (ensureBridge's /ping also reaches the server, so filter for the /call.)
  const callLog = bridgeCalls.filter((entry) => entry.url === '/call');
  assert.equal(callLog.length, 1);
  assert.equal(callLog[0].auth, `Bearer ${TOKEN}`);
  assert.match(callLog[0].body, /clipboard/);
  // The paste key is the CJK route.
  const pastes = spawnLog.filter((argv) => argv[3] === 'input' && argv[4] === 'keyevent' && argv[5] === '279');
  assert.equal(pastes.length, 1);
  // No `pair`, ever.
  assert.equal(spawnLog.some((argv) => argv.includes('pair')), false);
});

test('taps are resolved from the live dump, not from remembered coordinates', async () => {
  scriptHappyPath();
  spawnLog.length = 0;
  const { runner } = makeStack();
  await runner.dispatchTask({ taskText: TASK, confirm: true });
  const taps = spawnLog.filter((argv) => argv[3] === 'input' && argv[4] === 'tap');
  // focus tap (idle box) + send tap (keyboard-up box): two DIFFERENT centres,
  // which is the whole point of resolving them from the live dump.
  assert.equal(taps.length, 2);
  assert.deepEqual(taps[0].slice(5), ['596', '2447']);
  assert.deepEqual(taps[1].slice(5), ['1032', '1360']);
});

test('an empty input after the fill aborts before the send tap', async () => {
  dumpIndex = 0;
  // The fill reports success but the box still shows the IDLE HINT — that is
  // what a failed paste looks like on a real device, and the runner must not
  // mistake the hint for content.
  dumpScript = [
    dumpXml({}),
    dumpXml({ input: '发消息或按住说话', inputBounds: '[241,2388][950,2505]' }),
    dumpXml({ send: true }),
  ];
  spawnLog.length = 0;
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'input_empty_after_fill');
  assert.match(result.message, /不会发送空消息/);
  // The send button was never tapped.
  const taps = spawnLog.filter((argv) => argv[3] === 'input' && argv[4] === 'tap');
  assert.equal(taps.length, 1); // only the focus tap
  assert.equal(result.steps.find((step) => step.id === 'tap-send'), undefined);
});

test('a missing send button is reported instead of guessed at', async () => {
  dumpIndex = 0;
  dumpScript = [
    dumpXml({}),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: false }), // button gone
  ];
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'send_button_missing');
  assert.match(result.message, /btn_text_send/);
});

test('a reply that never stabilises ends as a timeout, not an answer', async () => {
  dumpIndex = 0;
  // The reply grows on every poll: the stability rule can never be satisfied.
  const growing = [];
  for (let i = 1; i <= 30; i += 1) {
    growing.push(dumpXml({ chat: [TASK, `第 ${i} 次更新，还在生成中…`.repeat(2)] }));
  }
  dumpScript = [dumpXml({}), dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }), dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }), ...growing];
  const { runner } = makeStack({ env: { KHY_AMOO_POLL_MAX_ROUNDS: '6' } });
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'reply_incomplete');
  assert.equal(result.poll.stopReason, 'round_cap_reached');
  assert.match(result.message, /round_cap_reached/);
  // Whatever was collected is still returned, so the caller is not left empty.
  assert.ok(result.reply.text.length > 0);
});

test('an unreadable screen aborts the dispatch with a reason', async () => {
  dumpIndex = 0;
  dumpScript = [dumpXml({})];
  spawnLog.length = 0;
  const { runner } = makeStack();
  // Make every uiautomator dump fail.
  const failing = (file, argv) => {
    if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'uiautomator') {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stderr.emit('data', 'ERROR: could not get idle state.');
        child.emit('close', 1);
      });
      return child;
    }
    return fakeSpawn(file, argv);
  };
  const stack = makeStack();
  stack.client._spawn = failing;
  const result = await stack.runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'screen_unreadable');
  assert.match(result.message, /读不到 Amoo 界面/);
});

test('a failed dump is retried inside the round instead of counting as no change', async () => {
  dumpIndex = 0;
  dumpScript = [
    dumpXml({}),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }),
    dumpXml({ chat: [TASK, '日程已查到：10:00 站会。'] }),
    dumpXml({ chat: [TASK, '日程已查到：10:00 站会。'] }),
  ];
  // The first two POLL dumps fail (uiautomator calls 4 and 5 — the three
  // pre-poll reads succeed). This is the measured live pattern: Amoo streams,
  // the window never goes idle, the dump fails, then generation ends and the
  // dump recovers on its own. Before the fix those two failures were filed as
  // "same as last round", which is how 20 rounds once read as a stable void.
  let dumps = 0;
  const flaky = (file, argv) => {
    if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'uiautomator') {
      dumps += 1;
      if (dumps === 4 || dumps === 5) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stderr.emit('data', 'ERROR: could not get idle state.');
          child.emit('close', 1);
        });
        return child;
      }
    }
    return fakeSpawn(file, argv);
  };
  const stack = makeStack();
  stack.client._spawn = flaky;
  const result = await stack.runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.match(result.reply.text, /日程已查到/);
  assert.equal(result.poll.stopReason, 'reply_stable_text_stable');
  // Two successful poll rounds were enough; the call count proves the two
  // failures were absorbed by in-round retries rather than dropped.
  assert.equal(result.poll.rounds, 2);
  assert.equal(dumps, 7); // 3 pre-poll + 2 failed + 2 successful
});

test('persistent dump failure stops as screen_unreadable, not a stable empty screen', async () => {
  dumpIndex = 0;
  dumpScript = [
    dumpXml({}),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }),
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]', send: true }),
    dumpXml({ chat: [TASK, '这条回复本来能读到。'] }),
  ];
  let dumps = 0;
  const dead = (file, argv) => {
    if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'uiautomator') {
      dumps += 1;
      if (dumps > 3) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stderr.emit('data', 'ERROR: could not get idle state.');
          child.emit('close', 1);
        });
        return child;
      }
    }
    return fakeSpawn(file, argv);
  };
  const stack = makeStack({ env: { KHY_AMOO_POLL_MAX_ROUNDS: '20' } });
  stack.client._spawn = dead;
  const result = await stack.runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'reply_incomplete');
  // The stop reason names the real failure instead of masquerading as stability.
  assert.equal(result.poll.stopReason, 'screen_unreadable');
  assert.match(result.message, /屏幕持续读不到/);
  assert.match(result.poll.screenError, /could not get idle state/);
  // It gave up after the unreadable-streak limit, far short of the round cap,
  // and no reply was fabricated out of a faked sample.
  assert.equal(result.poll.rounds, 3);
  assert.equal(result.reply.text, '');
  assert.equal(dumps, 15); // 3 pre-poll + 3 rounds x (1 + 3 retries)
});

test('a wedged bridge after the clipboard write is reported, not silently ignored', async () => {
  scriptHappyPath();
  const stack = makeStack();
  // The observed wedge: the clipboard /call returns ok, then the process stops
  // answering. The dispatch must still finish (paste/verify/send/poll are all
  // adb) but the step log has to say the bridge went quiet.
  stack.client.probeAfterClipboard = async () => ({ ok: false, latencyMs: 0, detail: 'bridge_request_timeout' });
  const result = await stack.runner.dispatchTask({ taskText: TASK, confirm: true });
  assert.equal(result.ok, true);
  assert.match(result.steps.find((step) => step.id === 'fill-text').detail, /桥自检无响应/);
});

test('the mailbox channel skips the forward and still dispatches', async () => {
  scriptHappyPath();
  bridgeCalls = [];
  spawnLog.length = 0;
  const { runner } = makeStack();
  const result = await runner.dispatchTask({ taskText: TASK, confirm: true, channel: 'mailbox' });
  // The clipboard goes through the mailbox, so no HTTP /call happens.
  assert.equal(bridgeCalls.length, 0);
  assert.equal(result.steps.find((step) => step.id === 'ensure-forward'), undefined);
  assert.match(result.steps.find((step) => step.id === 'bridge-ping').detail, /文件信箱/);
  // The push/pull pair for the mailbox command is present.
  assert.ok(spawnLog.some((argv) => argv[2] === 'push'));
  assert.equal(spawnLog.some((argv) => argv[2] === 'pull'), true);
});

test('collectStatus reports the honest boundary of the lite build', async () => {
  dumpIndex = 0;
  dumpScript = [dumpXml({})];
  const { runner } = makeStack();
  const status = await runner.collectStatus();
  assert.equal(status.ok, true);
  assert.equal(status.device.connected, true);
  assert.equal(status.device.serial, SERIAL);
  assert.equal(status.bridge.online, true);
  assert.equal(status.bridge.port, basePort);
  assert.equal(status.bridge.tools, 22);
  assert.equal(status.bridge.mode, 'lite');
  assert.equal(status.bridge.token, '5500…8d30');
  assert.equal(status.uiAutomation.bridgeUiTools, false);
  assert.match(status.uiAutomation.note, /lite 版不含/);
  assert.match(status.summary, /adb：已解析/);
  assert.match(status.summary, /桥服务：在线/);
  // The summary must never contain the raw token.
  assert.equal(status.summary.includes(TOKEN), false);
  assert.equal(JSON.stringify(status.bridge).includes(TOKEN), false);
});

test('clearInput empties the box without sending anything', async () => {
  dumpIndex = 0;
  dumpScript = [
    dumpXml({ input: TASK, inputBounds: '[98,1087][1109,1268]' }),
    // After the DEL presses the box shows the FOCUSED hint, i.e. it is empty.
    dumpXml({ input: '发消息', inputBounds: '[98,1087][1109,1268]' }),
  ];
  spawnLog.length = 0;
  const { runner } = makeStack();
  const result = await runner.clearInput();
  assert.equal(result.ok, true);
  assert.match(result.detail, /输入框已清空/);
  // The DEL presses are ONE bounded device-shell loop (payload length + 8, hard
  // capped at 200), not an unbounded one and not 200 separate adb round trips.
  const loops = spawnLog.filter((argv) => argv[3] === 'shell' || (typeof argv[3] === 'string' && argv[3].includes('keyevent 67')));
  const clearLoops = spawnLog.filter((argv) => String(argv[3] || '').includes('keyevent 67'));
  assert.equal(clearLoops.length, 1);
  const pressCount = Number(String(clearLoops[0][3]).match(/\[ \$i -lt (\d+) \]/)[1]);
  assert.equal(pressCount, TASK.length + 8);
  assert.ok(pressCount <= 200);
  assert.equal(loops.length >= 1, true);
  // The send button is never tapped by a cleanup.
  assert.equal(spawnLog.filter((argv) => argv[4] === 'tap').length, 1); // focus only
});

// ── optional progress hooks (onStep / onPoll) ──────────────────────────────
//
// These hooks exist so a panel can show what a dispatch is doing during the
// up-to-four-minute reply poll. The contract they must keep: omitting them
// changes nothing (old callers, CLI included, are untouched), and a hook that
// throws cannot abort a dispatch that is otherwise fine.

test('onStep observes every recorded step, in order, and changes nothing', async () => {
  scriptHappyPath();
  const { runner } = makeStack();
  const plain = await runner.dispatchTask({ taskText: TASK, confirm: true });

  scriptHappyPath();
  const seen = [];
  const watched = await runner.dispatchTask({
    taskText: TASK,
    confirm: true,
    onStep: (step) => seen.push(step),
  });

  assert.equal(watched.ok, plain.ok);
  assert.equal(watched.code, plain.code);
  // The hook saw exactly the step log the result carries — same ids, same order.
  assert.deepEqual(
    watched.steps.map((s) => s.id),
    seen.map((s) => s.id)
  );
  assert.deepEqual(watched.steps, seen);
  assert.equal(watched.reply.text, plain.reply.text);
  assert.ok(seen.length > 0);
});

test('onPoll reports the reply poll, throttled to at most one per second', async () => {
  scriptHappyPath();
  const { runner } = makeStack();
  const polls = [];
  const result = await runner.dispatchTask({
    taskText: TASK,
    confirm: true,
    onPoll: (p) => polls.push(p),
  });
  assert.equal(result.ok, true);
  assert.ok(polls.length >= 1, '轮询期必须有反馈，否则面板四分钟是死的');
  // The whole scripted poll finishes inside one second, so the throttle keeps
  // it to a single report — that is the point of the throttle.
  assert.ok(polls.length <= result.poll.rounds);
  assert.equal(polls[0].round, 1);
  assert.equal(polls[0].maxRounds, 20);
  assert.ok(Number.isFinite(polls[0].chatChars));
  assert.ok(polls[0].waitedMs >= 0);
});

test('a throwing progress hook cannot abort a dispatch', async () => {
  scriptHappyPath();
  const { runner } = makeStack();
  const plain = await runner.dispatchTask({ taskText: TASK, confirm: true });

  scriptHappyPath();
  const watched = await runner.dispatchTask({
    taskText: TASK,
    confirm: true,
    onStep: () => {
      throw new Error('listener boom');
    },
    onPoll: () => {
      throw new Error('listener boom');
    },
  });
  assert.equal(watched.ok, plain.ok);
  assert.deepEqual(watched.steps, plain.steps);
  assert.equal(watched.reply.text, plain.reply.text);
});
