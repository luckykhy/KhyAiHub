'use strict';

/**
 * amooUiSnapshot.js — pure leaf: parse a `uiautomator dump` XML into a screen
 * snapshot, and decide from that snapshot what Amoo is doing.
 *
 * WHY PC-side dumps: the installed StepBridge lite build has NO UI tools, so
 * there is no `ui_dump` to call. `adb shell uiautomator dump` runs as the shell
 * uid on the PC side and works (verified on the target device). Everything the
 * dispatch needs to know about the screen therefore comes from this parser.
 *
 * Measured Amoo geometry (1200x2670, density 520) — the reason coordinates are
 * NEVER hardcoded here:
 *   - `et_input_bar` empty state  [241,2388][950,2505] → centre (595,2446)
 *   - `et_input_bar` keyboard up   [98,1087][1109,1268] → the box MOVES ~1300px
 *   - `btn_text_send` keyboard up  [960,1301][1103,1418] → centre (1031,1360)
 *   - `chat_list`                  [52,0][1148,1054]
 * Tapping a remembered coordinate lands in the wrong place once the soft
 * keyboard opens, so every tap is resolved from the live snapshot.
 *
 * Contract: zero IO, deterministic, never throws.
 *
 * @module services/domain/network/amoo/amooUiSnapshot
 */

const NODE_RE = /<node\s+([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const BOUNDS_RE = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/;

/**
 * @typedef {object} UiNode
 * @property {string} resourceId
 * @property {string} className
 * @property {string} text
 * @property {string} contentDesc
 * @property {string} bounds
 * @property {{x1:number,y1:number,x2:number,y2:number}|null} rect
 * @property {boolean} clickable
 * @property {boolean} scrollable
 * @property {boolean} enabled
 */

/**
 * Parse uiautomator XML into a flat node list.
 * @param {string} xml
 * @returns {UiNode[]}
 */
function parseUiDump(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const nodes = [];
  let match;
  NODE_RE.lastIndex = 0;
  while ((match = NODE_RE.exec(text)) !== null) {
    const attrs = {};
    let attr;
    ATTR_RE.lastIndex = 0;
    while ((attr = ATTR_RE.exec(match[1])) !== null) {
      attrs[attr[1]] = attr[2];
    }
    nodes.push({
      resourceId: attrs['resource-id'] || '',
      className: attrs.class || '',
      text: attrs.text || '',
      contentDesc: attrs['content-desc'] || '',
      bounds: attrs.bounds || '',
      rect: parseBounds(attrs.bounds || ''),
      clickable: attrs.clickable === 'true',
      scrollable: attrs.scrollable === 'true',
      enabled: attrs.enabled !== 'false',
    });
  }
  return nodes;
}

/**
 * @param {string} raw e.g. "[960,1301][1103,1418]"
 * @returns {{x1:number,y1:number,x2:number,y2:number}|null}
 */
function parseBounds(raw) {
  const match = BOUNDS_RE.exec(String(raw || '').trim());
  if (!match) {
    return null;
  }
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

/**
 * Tap centre of a bounds string, rounded to integers.
 * @param {string|{x1:number,y1:number,x2:number,y2:number}} bounds
 * @returns {{x:number,y:number}|null}
 */
function centerOf(bounds) {
  const rect = typeof bounds === 'string' ? parseBounds(bounds) : bounds;
  if (!rect) {
    return null;
  }
  return {
    x: Math.round((rect.x1 + rect.x2) / 2),
    y: Math.round((rect.y1 + rect.y2) / 2),
  };
}

/**
 * @param {UiNode} node
 * @param {string} resourceId
 * @returns {boolean}
 */
function hasResourceId(node, resourceId) {
  return Boolean(node) && node.resourceId === resourceId;
}

/**
 * First node carrying a resource id.
 * @param {UiNode[]} nodes
 * @param {string} resourceId
 * @returns {UiNode|null}
 */
function findByResourceId(nodes, resourceId) {
  if (!Array.isArray(nodes)) {
    return null;
  }
  return nodes.find((node) => node.resourceId === resourceId) || null;
}

/**
 * True when rect is inside container (with a small tolerance for clipping).
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {{x1:number,y1:number,x2:number,y2:number}} container
 * @returns {boolean}
 */
function isInside(rect, container, tolerance = 4) {
  if (!rect || !container) {
    return false;
  }
  return (
    rect.x1 >= container.x1 - tolerance &&
    rect.y1 >= container.y1 - tolerance &&
    rect.x2 <= container.x2 + tolerance &&
    rect.y2 <= container.y2 + tolerance
  );
}

/**
 * Text inside the chat list, in reading order (top-to-bottom, left-to-right).
 * This is where Amoo's replies appear; the greeting bubble is the only entry
 * before the first turn.
 *
 * `excludeIds` is NOT optional in practice: on an EMPTY conversation the chat
 * list spans the whole content area (`[0,196][1200,2660]` measured on the target
 * device), so the input box and the send button are geometrically "inside" it.
 * Without the exclusion the input hint leaks into the chat text and corrupts both
 * the reply extraction and the stability judgement.
 * @param {UiNode[]} nodes
 * @param {string} chatListId
 * @param {string[]} [excludeIds] resource ids to keep out of the chat text
 * @returns {string}
 */
function extractChatListText(nodes, chatListId, excludeIds = []) {
  const list = findByResourceId(nodes, chatListId);
  if (!list || !list.rect) {
    return '';
  }
  const excluded = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);
  const inside = nodes.filter(
    (node) =>
      node !== list &&
      !excluded.has(node.resourceId) &&
      node.rect &&
      isInside(node.rect, list.rect) &&
      (node.text || node.contentDesc)
  );
  inside.sort((a, b) => {
    if (a.rect.y1 !== b.rect.y1) {
      return a.rect.y1 - b.rect.y1;
    }
    return a.rect.x1 - b.rect.x1;
  });
  const seen = new Set();
  const lines = [];
  for (const node of inside) {
    const value = (node.text || node.contentDesc).trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    lines.push(value);
  }
  return lines.join('\n');
}

/**
 * Split the chat text into the last bubble (the newest reply).
 * Amoo renders one bubble per turn; the newest non-empty trailing block is the
 * reply we want.
 * @param {string} chatText
 * @returns {string}
 */
function lastChatBlock(chatText) {
  const blocks = String(chatText || '')
    .split(/\n{2,}|\s*\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) {
    return '';
  }
  return blocks[blocks.length - 1];
}

/**
 * Amoo shows a streaming/thinking affordance while it works; the reliable
 * "still busy" signal available in a plain dump is the SEND button still being
 * present while the input is empty, plus a chat text that keeps growing.
 * @param {{chatText:string, inputText:string, sendVisible:boolean}} sample
 * @returns {boolean}
 */
function looksBusy(sample) {
  const chatLength = String((sample && sample.chatText) || '').length;
  const inputLength = String((sample && sample.inputText) || '').length;
  return chatLength > 0 || inputLength > 0 || sample.sendVisible === true;
}

/**
 * Stability rule for "Amoo has finished answering": the chat text must be
 * byte-identical across `requiredStableRounds` consecutive samples.
 * @param {{chatText:string}[]} samples newest last
 * @param {number} [requiredStableRounds]
 * @returns {{stable:boolean, text:string, reason:string, rounds:number}}
 */
function judgeReplyStability(samples, requiredStableRounds = 2) {
  const list = Array.isArray(samples) ? samples.filter(Boolean) : [];
  const needed = Math.max(1, Number(requiredStableRounds) || 1);
  if (list.length < needed) {
    return {
      stable: false,
      text: list.length > 0 ? String(list[list.length - 1].chatText || '') : '',
      reason: 'samples_insufficient',
      rounds: list.length,
    };
  }
  const tail = list.slice(-needed);
  const first = String(tail[0].chatText || '');
  const allSame = tail.every((sample) => String(sample.chatText || '') === first);
  if (!allSame) {
    return { stable: false, text: first, reason: 'text_still_changing', rounds: tail.length };
  }
  if (!first.trim()) {
    return { stable: false, text: '', reason: 'chat_empty', rounds: tail.length };
  }
  return { stable: true, text: first, reason: 'text_stable', rounds: tail.length };
}

/**
 * Short Chinese screen summary with counts — every number is load-bearing so a
 * reader can tell "empty screen" from "3 bubbles, 412 chars".
 * @param {UiNode[]} nodes
 * @param {{chatListId:string, inputId:string, sendId:string}} ids
 * @returns {{nodes:number, chatChars:number, chatLines:number, inputChars:number,
 *            sendVisible:boolean, inputBounds:string|null, sendBounds:string|null,
 *            summary:string}}
 */
function describeScreen(nodes, ids) {
  const list = findByResourceId(nodes, ids.chatListId);
  const input = findByResourceId(nodes, ids.inputId);
  const send = findByResourceId(nodes, ids.sendId);
  const chatText = extractChatListText(nodes, ids.chatListId, [ids.inputId, ids.sendId]);
  const inputText = input ? input.text.trim() : '';
  const chatLines = chatText ? chatText.split('\n').length : 0;
  const summary = [
    `节点 ${nodes.length} 个`,
    list ? `聊天列表已出现` : '聊天列表未出现',
    `聊天文本 ${chatText.length} 字 / ${chatLines} 行`,
    `输入框 ${inputText.length} 字`,
    send ? '发送按钮可见' : '发送按钮不可见',
  ].join('，');
  return {
    nodes: nodes.length,
    chatChars: chatText.length,
    chatLines,
    inputChars: inputText.length,
    sendVisible: Boolean(send),
    inputBounds: input ? input.bounds : null,
    sendBounds: send ? send.bounds : null,
    summary,
  };
}

/**
 * Slice the reply out of a full chat dump.
 *
 * The chat list holds the greeting (baseline), the user's own bubble (an echo of
 * the task text) and then Amoo's answer. Both are subtracted so the caller gets
 * the answer, while `full` stays available for auditing — the echo assumption is
 * the one thing here that is not guaranteed, so it must be checkable.
 * @param {string} fullText
 * @param {string} baselineText chat text captured before the send
 * @param {string} taskText the text that was sent
 * @returns {{reply:string, full:string, baselineChars:number, echoStripped:boolean}}
 */
function sliceReply(fullText, baselineText, taskText) {
  const full = String(fullText || '');
  const baseline = String(baselineText || '');
  let rest = full;
  if (baseline && rest.startsWith(baseline)) {
    rest = rest.slice(baseline.length);
  }
  rest = rest.replace(/^\s+/, '');
  const task = String(taskText || '').trim();
  let echoStripped = false;
  if (task && rest.startsWith(task)) {
    rest = rest.slice(task.length);
    echoStripped = true;
  }
  return {
    reply: rest.replace(/^\s+/, '').replace(/\s+$/, ''),
    full,
    baselineChars: baseline.length,
    echoStripped,
  };
}

/**
 * A distinctive prefix of a payload, short enough to survive line wrapping in
 * the input box but long enough not to collide with a hint.
 * @param {string} payload
 * @param {number} [maxChars]
 * @returns {string}
 */
function payloadPrefix(payload, maxChars = 20) {
  const value = String(payload || '').trim();
  if (!value) {
    return '';
  }
  const size = Math.max(1, Math.min(maxChars, value.length));
  return value.slice(0, size);
}

/**
 * Did the payload actually land in the input box?
 *
 * An EMPTY EditText still reports `text` — it reports the HINT ("发消息或按住
 *说话" when idle, "发消息" once focused). So a length check reads a filled box
 * as empty and an empty box as filled. The only reliable test is whether the
 * box contains a distinctive slice of what we tried to put there.
 * @param {string} inputText
 * @param {string} payload
 * @returns {boolean}
 */
function inputHasPayload(inputText, payload) {
  const prefix = payloadPrefix(payload);
  if (!prefix) {
    return false;
  }
  return String(inputText || '').includes(prefix);
}

/**
 * Is the input box effectively empty?
 *
 * An empty EditText reports its HINT as `text` (and the hint changes between the
 * idle and the focused state), so "no characters" is not the same as "nothing
 * typed". Both the empty string and a known hint count as empty.
 * @param {string} inputText
 * @param {string[]} hints
 * @returns {boolean}
 */
function isInputEmpty(inputText, hints = []) {
  const value = String(inputText || '').trim();
  if (!value) {
    return true;
  }
  const list = Array.isArray(hints) ? hints : [];
  return list.some((hint) => String(hint).trim() === value);
}

module.exports = {
  parseUiDump,
  parseBounds,
  centerOf,
  hasResourceId,
  findByResourceId,
  isInside,
  extractChatListText,
  lastChatBlock,
  looksBusy,
  judgeReplyStability,
  sliceReply,
  payloadPrefix,
  inputHasPayload,
  isInputEmpty,
  describeScreen,
};
