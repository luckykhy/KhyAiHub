'use strict';

const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BUS_PATH = path.resolve(__dirname, '../../../diagnosticEvents.js');
const { attachDebugLog, formatTime } = require('./debugLog.js');

// Preload the real bus so stubbing/restoring never drops the singleton instance
// the leaf itself would see.
const { diagnostics: GLOBAL_BUS } = require(BUS_PATH);

// HH:mm:ss built from *local* components, so the expected text holds on any machine.
const TS_0908 = new Date(2020, 0, 2, 9, 8, 7).getTime();

const SAVED_FLAG = process.env.KHY_STATE_DEBUG;
let flagRestored = false;
function restoreFlagOnce() {
  if (flagRestored) return;
  flagRestored = true;
  if (SAVED_FLAG === undefined) delete process.env.KHY_STATE_DEBUG;
  else process.env.KHY_STATE_DEBUG = SAVED_FLAG;
}

function setFlag(value) {
  restoreFlagOnce();
  if (value === undefined) delete process.env.KHY_STATE_DEBUG;
  else process.env.KHY_STATE_DEBUG = value;
}

function captureStderr(t, impl) {
  const real = process.stderr.write;
  process.stderr.write = impl;
  t.after(() => {
    process.stderr.write = real;
  });
}

function stubBus(exportsObj, t) {
  const key = require.resolve(BUS_PATH);
  const real = require.cache[key];
  require.cache[key] = {
    id: key,
    filename: key,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
  t.after(() => {
    require.cache[key] = real;
  });
}

function frozenNow(t, ts) {
  const real = Date.now;
  Date.now = () => ts;
  t.after(() => {
    Date.now = real;
  });
}

test('formatTime: 本地时分秒补零，24 小时制，毫秒被丢弃', () => {
  assert.equal(formatTime(TS_0908), '09:08:07');
  assert.equal(formatTime(new Date(2020, 0, 2, 3, 4, 5).getTime()), '03:04:05');
  assert.equal(formatTime(new Date(2020, 0, 2, 23, 59, 59).getTime()), '23:59:59');
  assert.equal(formatTime(new Date(2020, 0, 2, 0, 0, 0).getTime()), '00:00:00');
  assert.equal(formatTime(TS_0908 + 999), '09:08:07');
});

test('KNOWN-DEFECT: debugLog.js:30 formatTime 对非时间输入产出 "NaN:NaN:NaN" 而不抛错', () => {
  // undefined / NaN → Invalid Date；padStart(2,'0') 对 3 字符的 'NaN' 不起作用
  assert.equal(formatTime(undefined), 'NaN:NaN:NaN');
  assert.equal(formatTime(NaN), 'NaN:NaN:NaN');
  assert.equal(formatTime({}), 'NaN:NaN:NaN');
  assert.equal(formatTime('not a date'), 'NaN:NaN:NaN');
  // 可被 Date 解析的字符串照旧格式化（按本地时区），数字之外的入参并非一律报错
  assert.equal(formatTime(new Date(2020, 0, 2, 9, 8, 7).toISOString()), '09:08:07');
});

test('门控关（未设 / "" / "0" / "true" / "01"）时返回 false 且不写 onStateChange', (t) => {
  for (const off of [undefined, '', '0', 'true', 'yes', '01', '1 ']) {
    setFlag(off);
    const fsm = { state: 'idle' };
    assert.equal(attachDebugLog(fsm, 'shadow'), false, `flag=${JSON.stringify(off)}`);
    assert.equal('onStateChange' in fsm, false);
  }
  setFlag(undefined);
});

test('门控开（"1"）时挂上钩子，行格式为 [fsm:label] from → to (event, HH:mm:ss)', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  const lines = [];
  captureStderr(
    t,
    (s) => {
      lines.push(s);
      return true;
    }
  );
  const emitted = [];
  stubBus({ diagnostics: { emit: (type, data) => emitted.push([type, data]) } }, t);

  const fsm = {};
  assert.equal(attachDebugLog(fsm, 'shadow'), true);
  assert.equal(fsm.onStateChange.length, 3);
  assert.equal(fsm.onStateChange('idle', 'running', 'start'), undefined);
  assert.deepEqual(lines, ['[fsm:shadow] idle → running (start, 09:08:07)\n']);
  assert.deepEqual(emitted, [
    [
      'fsm.phase_transition',
      { fsm: 'shadow', from: 'idle', to: 'running', event: 'start', at: TS_0908 },
    ],
  ]);
});

test('标签回退链：label → fsm.name → "fsm"，非字符串 label 走 String()', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  const lines = [];
  captureStderr(
    t,
    (s) => {
      lines.push(s);
      return true;
    }
  );
  stubBus({ diagnostics: { emit: () => {} } }, t);

  const a = { name: 'fromFsmName' };
  attachDebugLog(a, '');
  a.onStateChange();
  const b = { name: 'ignored' };
  attachDebugLog(b, 'winning');
  b.onStateChange();
  const c = {};
  attachDebugLog(c);
  c.onStateChange('a', 'b', 'c');
  const d = {};
  attachDebugLog(d, { a: 1 });
  d.onStateChange('a', 'b', 'c');
  assert.deepEqual(lines, [
    '[fsm:fromFsmName] undefined → undefined (undefined, 09:08:07)\n',
    '[fsm:winning] undefined → undefined (undefined, 09:08:07)\n',
    '[fsm:fsm] a → b (c, 09:08:07)\n',
    '[fsm:[object Object]] a → b (c, 09:08:07)\n',
  ]);
});

test('转移参数不做任何转义：对象 / null / undefined 直接进文案', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  const lines = [];
  captureStderr(
    t,
    (s) => {
      lines.push(s);
      return true;
    }
  );
  stubBus({ diagnostics: { emit: () => {} } }, t);
  const fsm = {};
  attachDebugLog(fsm, 'obj');
  fsm.onStateChange({ s: 1 }, null, undefined);
  assert.deepEqual(lines, ['[fsm:obj] [object Object] → null (undefined, 09:08:07)\n']);
});

test('KNOWN-DEFECT: debugLog.js:58 静默覆盖既有 fsm.onStateChange，旧钩子从此不再触发', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  captureStderr(
    t,
    () => true
  );
  stubBus({ diagnostics: { emit: () => {} } }, t);
  let oldCalls = 0;
  const fsm = {
    onStateChange: () => {
      oldCalls += 1;
    },
  };
  assert.equal(attachDebugLog(fsm, 'chain'), true);
  fsm.onStateChange('a', 'b', 'c');
  assert.equal(oldCalls, 0); // 实测：既不链式调用也不报错，旧钩子被吃掉
});

test('KNOWN-DEFECT: debugLog.js:67 除 stderr 外还写进程级 diagnostics 单例缓冲', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  captureStderr(
    t,
    () => true
  );
  const before = GLOBAL_BUS.getBuffer().length;
  const fsm = {};
  attachDebugLog(fsm, 'leak');
  fsm.onStateChange('a', 'b', 'c');
  const buf = GLOBAL_BUS.getBuffer();
  assert.equal(buf.length, before + 1);
  const evt = buf[buf.length - 1];
  assert.equal(evt.type, 'fsm.phase_transition');
  assert.deepEqual(evt.data, { fsm: 'leak', from: 'a', to: 'b', event: 'c', at: TS_0908 });
  assert.equal(typeof evt.seq, 'number');
  assert.equal(evt.attention, null);
  // 单例没有 onFlush：攒到 500 条时 flush() 只是 splice 丢弃，事件哪也不去
  assert.equal(GLOBAL_BUS._onFlush, null);
  t.after(() => {
    GLOBAL_BUS.flush();
  });
});

test('总线缺失（exports 无 diagnostics）时 fail-soft，stderr 行照写', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  const lines = [];
  captureStderr(
    t,
    (s) => {
      lines.push(s);
      return true;
    }
  );
  const fsm = {};
  attachDebugLog(fsm, 'nobus');
  stubBus({}, t); // 解构 diagnostics → undefined，emit 抛 TypeError 被吞
  assert.doesNotThrow(() => fsm.onStateChange('a', 'b', 'c'));
  assert.deepEqual(lines, ['[fsm:nobus] a → b (c, 09:08:07)\n']);
});

test('总线 emit 自身抛错也不外抛，且不影响后续转移继续写', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  const lines = [];
  captureStderr(
    t,
    (s) => {
      lines.push(s);
      return true;
    }
  );
  stubBus(
    {
      diagnostics: {
        emit() {
          throw new Error('bus exploded');
        },
      },
    },
    t
  );
  const fsm = {};
  attachDebugLog(fsm, 'boom');
  assert.doesNotThrow(() => fsm.onStateChange('x', 'y', 'z'));
  assert.doesNotThrow(() => fsm.onStateChange('y', 'z', 'w'));
  assert.deepEqual(lines, [
    '[fsm:boom] x → y (z, 09:08:07)\n',
    '[fsm:boom] y → z (w, 09:08:07)\n',
  ]);
});

test('stderr.write 抛错时整行丢弃且不外抛，总线仍收到事件', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  captureStderr(
    t,
    () => {
      throw new Error('stderr closed');
    }
  );
  const emitted = [];
  stubBus({ diagnostics: { emit: (type, data) => emitted.push([type, data]) } }, t);
  const fsm = {};
  attachDebugLog(fsm, 'broken');
  assert.doesNotThrow(() => fsm.onStateChange('x', 'y', 'z'));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], [
    'fsm.phase_transition',
    { fsm: 'broken', from: 'x', to: 'y', event: 'z', at: TS_0908 },
  ]);
});

test('fsm 入参垃圾值：非对象一律 false；函数被拒而数组被接受', (t) => {
  setFlag('1');
  frozenNow(t, TS_0908);
  captureStderr(
    t,
    () => true
  );
  stubBus({ diagnostics: { emit: () => {} } }, t);
  for (const junk of [null, undefined, 0, '', 'fsm', NaN, function named() {}]) {
    assert.equal(attachDebugLog(junk, 'j'), false, String(junk));
  }
  // typeof [] === 'object' → 数组通过守卫，钩子真的挂了上去
  const arr = [];
  assert.equal(attachDebugLog(arr, 'arr'), true);
  assert.equal(typeof arr.onStateChange, 'function');
  setFlag(undefined);
});
