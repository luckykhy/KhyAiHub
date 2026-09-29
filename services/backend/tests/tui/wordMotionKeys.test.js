// 2026-09-29 night section: does the REAL input hook honour Ctrl as a word
// modifier? Key objects are exactly what node_modules/ink/build/hooks/use-input.js
// builds (verified against node_modules/ink/build/parse-keypress.js:
//   \x1b[1;5D -> name=left ctrl=true | \x1b[1;5C -> name=right ctrl=true
//   \x1b[3;5~ -> name=delete ctrl=true | \x7f -> name=delete ctrl=false
//   \x08 -> name=backspace ctrl=false (ambiguous with legacy ^H Backspace)).
// Deterministic: no timers, no clock, no I/O — same harness pattern as
// tests/cli/tui/sidebarNav.test.js.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Keep submitted history writes off the real ~/.khyquant store.
const FAKE_HOME = path.join(require('os').tmpdir(), 'khy-fakehome-wordmotion');
fs.mkdirSync(FAKE_HOME, { recursive: true });
const REAL_HOME = process.env.HOME;
const REAL_UP = process.env.USERPROFILE;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
test.after(() => {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_UP;
});

let _slots = [];
let _idx = 0;
const fakeReact = {
  useState(init) {
    const i = _idx++;
    if (_slots[i] === undefined) _slots[i] = typeof init === 'function' ? init() : init;
    return [
      _slots[i],
      (fn) => {
        _slots[i] = typeof fn === 'function' ? fn(_slots[i]) : fn;
      },
    ];
  },
  useRef(init) {
    const i = _idx++;
    if (_slots[i] === undefined) _slots[i] = { current: init };
    return _slots[i];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
};

const HOOK = require.resolve('../../src/cli/tui/hooks/useTextInput');
function loadHook() {
  delete require.cache[HOOK];
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'react') return fakeReact;
    return origRequire.apply(this, arguments);
  };
  try {
    return require(HOOK);
  } finally {
    Module.prototype.require = origRequire;
  }
}

function fresh(text, offset) {
  _slots = [];
  _idx = 0;
  const { useTextInput } = loadHook();
  const h = useTextInput({ onSubmit: () => {}, onChange: () => {} });
  h.setText(text);
  if (typeof offset === 'number') h.setOffset(offset);
  return h;
}

const baseKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, home: false, end: false, return: false,
  escape: false, ctrl: false, shift: false, tab: false, backspace: false,
  delete: false, meta: false,
};
const arrow = (name, mods = {}) => ({ ...baseKey, ...mods, [name + 'Arrow']: true });
const delKey = (mods = {}) => ({ ...baseKey, ...mods, delete: true });

const dump = (h) => `text=${JSON.stringify(h.liveCursor.text)} offset=${h.liveCursor.offset}`;

test('Ctrl+Left moves one WORD (Windows: \\x1b[1;5D)', () => {
  const h = fresh('hello world foo', 15);
  h.onInput('\x1b[1;5D', arrow('left', { ctrl: true }));
  console.log('[Ctrl+Left]  ', dump(h));
  assert.strictEqual(h.liveCursor.offset, 12, '应停在 foo 词首(12)，改前停在 14');
});

test('Ctrl+Right moves one WORD (Windows: \\x1b[1;5C)', () => {
  const h = fresh('hello world foo', 0);
  h.onInput('\x1b[1;5C', arrow('right', { ctrl: true }));
  console.log('[Ctrl+Right] ', dump(h));
  // Parity with the pre-existing Alt+Right chord (same Cursor.wordRight): the
  // engine lands at the END of the word it skips, so the real bar is Alt+Right,
  // not a number I guessed.
  const ref = fresh('hello world foo', 0);
  ref.onInput('\x1b[1;5C', arrow('right', { meta: true }));
  console.log('[Alt+Right]  ', dump(ref));
  assert.strictEqual(h.liveCursor.offset, ref.liveCursor.offset);
  assert.ok(h.liveCursor.offset > 1, '至少要比单字符位移大');
});

test('Ctrl+Delete kills the word AFTER (Windows: \\x1b[3;5~)', () => {
  const h = fresh('hello world', 0);
  h.onInput('\x1b[3;5~', delKey({ ctrl: true }));
  console.log('[Ctrl+Del]   ', dump(h));
  assert.strictEqual(h.liveCursor.text, ' world', '应删掉 hello，改前删掉的是 h');
});

test('control: plain Backspace (\\x7f) still deletes ONE char', () => {
  const h = fresh('hello', 5);
  h.onInput('\x7f', delKey({}));
  console.log('[Del/BS]     ', dump(h));
  assert.strictEqual(h.liveCursor.text, 'hell');
});

test('control: Alt+Backspace still kills the word before', () => {
  const h = fresh('hello world', 11);
  h.onInput('\x1b\x7f', delKey({ meta: true }));
  console.log('[Alt+BS]     ', dump(h));
  assert.strictEqual(h.liveCursor.text, 'hello ');
});

test('control: Ctrl+H (\\x08) stays a single backspace — ambiguous chord, must not become word kill', () => {
  const h = fresh('hello world', 11);
  h.onInput('\x08', { ...delKey({}), backspace: true, delete: false });
  console.log('[Ctrl+H]     ', dump(h));
  assert.strictEqual(h.liveCursor.text, 'hello worl');
});

test('live sequence to replay in the pty: "hello world" + Ctrl+Left x2 + Ctrl+Delete', () => {
  const h = fresh('hello world', 11);
  h.onInput('\x1b[1;5D', arrow('left', { ctrl: true }));
  h.onInput('\x1b[1;5D', arrow('left', { ctrl: true }));
  console.log('[seq after 2x Ctrl+Left] ', dump(h));
  h.onInput('\x1b[3;5~', delKey({ ctrl: true }));
  console.log('[seq final]              ', dump(h));
});
