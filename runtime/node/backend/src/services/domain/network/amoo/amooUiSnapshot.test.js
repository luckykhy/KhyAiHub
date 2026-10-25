'use strict';

// Co-located unit test for amooUiSnapshot.js.
//
// The fixtures below are trimmed copies of REAL `uiautomator dump` output from
// the target device (1200x2670, density 520), including the two facts that
// break naive automation:
//   - the input box MOVES ~1300px when the soft keyboard opens, so a remembered
//     coordinate is wrong half the time,
//   - the send button only exists while the input is non-empty.
// Pinning those two shapes is what stops a future edit from hardcoding (595,2446).

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-ui-'));
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

pinSandbox();

const {
  parseUiDump,
  parseBounds,
  centerOf,
  findByResourceId,
  isInside,
  extractChatListText,
  lastChatBlock,
  looksBusy,
  judgeReplyStability,
  sliceReply,
  describeScreen,
} = require('./amooUiSnapshot');

const IDS = {
  chatListId: 'com.stepos.ailauncher:id/chat_list',
  inputId: 'com.stepos.ailauncher:id/et_input_bar',
  sendId: 'com.stepos.ailauncher:id/btn_text_send',
};

function node(resourceId, text, bounds, extra = {}) {
  const attrs = [
    `resource-id="${resourceId}"`,
    `class="android.widget.TextView"`,
    `text="${text}"`,
    `content-desc=""`,
    `clickable="${extra.clickable === true ? 'true' : 'false'}"`,
    `scrollable="false"`,
    `enabled="true"`,
    `bounds="${bounds}"`,
  ].join(' ');
  return `<node ${attrs} />`;
}

// Greeting screen: keyboard down, no send button.
const GREETING_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
${node('', '', '[0,0][1200,2670]')}
${node(IDS.chatListId, '', '[52,0][1148,1054]')}
${node('com.stepos.ailauncher:id/tv_greeting', 'Amoo，你的全能伙伴', '[285,1267][915,1353]')}
${node(IDS.inputId, '发消息或按住说话', '[241,2388][950,2505]', { clickable: true })}
</hierarchy>`;

// Keyboard-up screen with text in the input and the send button present.
const READY_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
${node('', '', '[0,0][1200,2670]')}
${node(IDS.chatListId, '', '[52,0][1148,1054]')}
${node('com.stepos.ailauncher:id/tv_greeting', 'Amoo，你的全能伙伴', '[285,942][915,1028]')}
${node(IDS.inputId, '帮我查一下今天的日程', '[98,1087][1109,1268]', { clickable: true })}
${node(IDS.sendId, '', '[960,1301][1103,1418]', { clickable: true })}
</hierarchy>`;

// After the turn: user bubble + reply inside the chat list.
const ANSWERED_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
${node('', '', '[0,0][1200,2670]')}
${node(IDS.chatListId, '', '[52,0][1148,1054]')}
${node('', '帮我查一下今天的日程', '[120,300][1000,380]')}
${node('', '今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。', '[120,400][1000,520]')}
${node(IDS.inputId, '发消息', '[98,1087][1109,1268]', { clickable: true })}
${node(IDS.sendId, '', '[960,1301][1103,1418]', { clickable: true })}
</hierarchy>`;

// On an EMPTY conversation the chat list spans the whole content area
// (measured [0,196][1200,2660]), so the input box and the send button are
// geometrically INSIDE it. This is the shape that made the input hint leak into
// the chat text before the exclusion was added.
const EMPTY_CHAT_WIDE_LIST_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
${node('', '', '[0,0][1200,2670]')}
${node(IDS.chatListId, '', '[0,196][1200,2660]')}
${node('com.stepos.ailauncher:id/tv_greeting', 'Amoo，你的全能伙伴', '[285,1267][915,1353]')}
${node(IDS.inputId, '发消息或按住说话', '[241,2391][950,2508]', { clickable: true })}
${node(IDS.sendId, '', '[960,1301][1103,1418]', { clickable: true })}
</hierarchy>`;

test('parseUiDump reads the real attribute shape', () => {
  const nodes = parseUiDump(GREETING_XML);
  assert.equal(nodes.length, 4);
  const input = findByResourceId(nodes, IDS.inputId);
  assert.equal(input.text, '发消息或按住说话');
  assert.equal(input.clickable, true);
  assert.deepEqual(input.rect, { x1: 241, y1: 2388, x2: 950, y2: 2505 });
  assert.equal(parseUiDump('not xml at all').length, 0);
  assert.equal(parseUiDump(undefined).length, 0);
});

test('parseBounds rejects anything that is not a real bounds string', () => {
  assert.deepEqual(parseBounds('[960,1301][1103,1418]'), { x1: 960, y1: 1301, x2: 1103, y2: 1418 });
  assert.equal(parseBounds(''), null);
  assert.equal(parseBounds('[1,2][3]'), null);
  assert.equal(parseBounds('960,1301'), null);
  assert.equal(parseBounds(null), null);
});

test('centerOf rounds to integer device pixels', () => {
  assert.deepEqual(centerOf('[960,1301][1103,1418]'), { x: 1032, y: 1360 });
  assert.deepEqual(centerOf('[241,2388][950,2505]'), { x: 596, y: 2447 });
  assert.deepEqual(centerOf('[0,0][1201,2671]'), { x: 601, y: 1336 });
  assert.equal(centerOf('garbage'), null);
  assert.equal(centerOf(null), null);
});

test('the input box moves when the keyboard opens — coordinates must be re-read', () => {
  const before = centerOf(findByResourceId(parseUiDump(GREETING_XML), IDS.inputId).bounds);
  const after = centerOf(findByResourceId(parseUiDump(READY_XML), IDS.inputId).bounds);
  assert.deepEqual(before, { x: 596, y: 2447 });
  assert.deepEqual(after, { x: 604, y: 1178 });
  assert.notDeepEqual(before, after);
  // The send button exists only once there is text to send.
  assert.equal(findByResourceId(parseUiDump(GREETING_XML), IDS.sendId), null);
  assert.ok(findByResourceId(parseUiDump(READY_XML), IDS.sendId));
});

test('extractChatListText only reads nodes inside the chat list', () => {
  const nodes = parseUiDump(ANSWERED_XML);
  const text = extractChatListText(nodes, IDS.chatListId);
  assert.match(text, /帮我查一下今天的日程/);
  assert.match(text, /今天有 3 个日程/);
  // The input box and the send button are OUTSIDE the list and must not leak in.
  assert.doesNotMatch(text, /发消息/);
  assert.equal(extractChatListText(parseUiDump(GREETING_XML), IDS.chatListId), '');
  // A wrong id yields nothing rather than the whole screen.
  assert.equal(extractChatListText(nodes, 'nope'), '');
});

test('an empty chat list spans the whole screen, so chrome must be excluded', () => {
  // Regression: without [inputId, sendId] in excludeIds, the input HINT was read
  // as a chat bubble — measured on the target device with a fresh conversation.
  const nodes = parseUiDump(EMPTY_CHAT_WIDE_LIST_XML);
  assert.deepEqual(centerOf(findByResourceId(nodes, IDS.inputId).bounds), { x: 596, y: 2450 });
  const leaked = extractChatListText(nodes, IDS.chatListId);
  assert.match(leaked, /发消息或按住说话/); // the defect, reproduced
  const fixed = extractChatListText(nodes, IDS.chatListId, [IDS.inputId, IDS.sendId]);
  // The greeting is a REAL bubble and survives; only the chrome is dropped.
  assert.equal(fixed, 'Amoo，你的全能伙伴');
  assert.doesNotMatch(fixed, /发消息或按住说话/);
  // describeScreen must use the same exclusion: the greeting (a real bubble)
  // still counts, the hint does not.
  const info = describeScreen(nodes, IDS);
  assert.equal(info.chatChars, 'Amoo，你的全能伙伴'.length);
  assert.equal(info.chatLines, 1);
  assert.equal(info.inputChars, '发消息或按住说话'.length);
  assert.equal(info.sendVisible, true);
});

test('the exclusion does not drop real bubbles', () => {
  const nodes = parseUiDump(ANSWERED_XML);
  const withExclusion = extractChatListText(nodes, IDS.chatListId, [IDS.inputId, IDS.sendId]);
  const without = extractChatListText(nodes, IDS.chatListId);
  assert.equal(withExclusion, without);
  assert.match(withExclusion, /18:30 健身/);
});

test('isInside uses a tolerance so clipped nodes still count', () => {
  const rect = { x1: 0, y1: 0, x2: 1200, y2: 2670 };
  const container = { x1: 52, y1: 0, x2: 1148, y2: 1054 };
  assert.equal(isInside(rect, container), false);
  assert.equal(isInside({ x1: 50, y1: 0, x2: 1146, y2: 1050 }, container), true);
  assert.equal(isInside(null, container), false);
});

test('lastChatBlock takes the newest block', () => {
  assert.equal(lastChatBlock('第一段\n\n第二段\n\n第三段'), '第三段');
  assert.equal(lastChatBlock(''), '');
  assert.equal(lastChatBlock('   '), '');
});

test('looksBusy is a conservative "something is happening" signal', () => {
  assert.equal(looksBusy({ chatText: '', inputText: '', sendVisible: false }), false);
  assert.equal(looksBusy({ chatText: 'x', inputText: '', sendVisible: false }), true);
  assert.equal(looksBusy({ chatText: '', inputText: 'x', sendVisible: false }), true);
  assert.equal(looksBusy({ chatText: '', inputText: '', sendVisible: true }), true);
});

test('judgeReplyStability needs N identical rounds and non-empty text', () => {
  assert.equal(judgeReplyStability([], 2).reason, 'samples_insufficient');
  assert.equal(judgeReplyStability([{ chatText: 'a' }], 2).reason, 'samples_insufficient');
  assert.equal(judgeReplyStability([{ chatText: 'a' }, { chatText: 'ab' }], 2).stable, false);
  assert.equal(judgeReplyStability([{ chatText: 'a' }, { chatText: 'ab' }], 2).reason, 'text_still_changing');
  assert.equal(judgeReplyStability([{ chatText: '' }, { chatText: '' }], 2).reason, 'chat_empty');
  const stable = judgeReplyStability([{ chatText: '答' }, { chatText: '答' }, { chatText: '答' }], 3);
  assert.equal(stable.stable, true);
  assert.equal(stable.reason, 'text_stable');
  assert.equal(stable.text, '答');
  // needed=1 degenerates safely instead of dividing by zero.
  assert.equal(judgeReplyStability([{ chatText: 'x' }], 0).stable, true);
});

test('sliceReply subtracts the baseline and the echoed task text', () => {
  const full = 'Amoo，你的全能伙伴\n帮我查一下今天的日程\n今天有 3 个日程。';
  const sliced = sliceReply(full, 'Amoo，你的全能伙伴', '帮我查一下今天的日程');
  assert.equal(sliced.reply, '今天有 3 个日程。');
  assert.equal(sliced.echoStripped, true);
  assert.equal(sliced.baselineChars, 'Amoo，你的全能伙伴'.length);
  assert.equal(sliced.full, full);

  // No baseline, no echo: the reply is everything.
  const plain = sliceReply('只有答复', '', '');
  assert.equal(plain.reply, '只有答复');
  assert.equal(plain.echoStripped, false);

  // The echo assumption is checkable: when it does not hold, say so.
  const odd = sliceReply('基线\n答复', '基线', '别的话题');
  assert.equal(odd.echoStripped, false);
  assert.equal(odd.reply, '答复');

  // Degenerate inputs must not throw.
  assert.deepEqual(sliceReply('', '', ''), { reply: '', full: '', baselineChars: 0, echoStripped: false });
});

test('describeScreen reports counts, not adjectives', () => {
  const ready = describeScreen(parseUiDump(READY_XML), IDS);
  assert.equal(ready.nodes, 5);
  assert.equal(ready.inputChars, '帮我查一下今天的日程'.length);
  assert.equal(ready.sendVisible, true);
  assert.equal(ready.sendBounds, '[960,1301][1103,1418]');
  assert.match(ready.summary, /节点 5 个/);
  assert.match(ready.summary, /发送按钮可见/);

  const greeting = describeScreen(parseUiDump(GREETING_XML), IDS);
  assert.equal(greeting.sendVisible, false);
  assert.equal(greeting.inputBounds, '[241,2388][950,2505]');
  assert.match(greeting.summary, /发送按钮不可见/);

  const answered = describeScreen(parseUiDump(ANSWERED_XML), IDS);
  assert.equal(answered.chatChars, '帮我查一下今天的日程\n今天有 3 个日程：10:00 站会、14:00 复盘、18:30 健身。'.length);
  assert.equal(answered.chatLines, 2);
});
