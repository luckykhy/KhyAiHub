'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const th = require('./thresholds.js');

// Snapshot every env var this module reads so cases can't leak state.
const WATCHED = [
  'KHY_PROJECT_GOD_FILE_LOC',
  'KHY_ARCH_GOD_FILE_LOC',
  'KHY_PROJECT_DUP_SYMBOL_OVERLAP',
  'KHY_PROJECT_DUP_CONTENT_JACCARD',
  'KHY_PROJECT_DUP_MIN_SYMBOLS',
  'KHY_PROJECT_DUP_MAX_SCAN_FILES',
  'KHY_PROJECT_DUP_MAX_FILE_BYTES',
  'KHY_PROJECT_HYGIENE',
];
const snapshot = {};
for (const k of WATCHED) snapshot[k] = process.env[k];

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('无任何 env 时的默认阈值逐字节钉死', () => {
  assert.equal(th.godFileLoc(), 2500);
  assert.equal(th.dupSymbolOverlap(), 0.6);
  assert.equal(th.dupContentJaccard(), 0.82);
  assert.equal(th.dupMinSymbols(), 3);
  assert.equal(th.dupMaxScanFiles(), 400);
  assert.equal(th.dupMaxFileBytes(), 524288);
  assert.equal(th.enabled(), true);
});

test('intEnv：合法整数接受，缺失/负数/零回退默认，无 def 参数返回 undefined', () => {
  assert.equal(withEnv('KHY_T_INT', '42', () => th.intEnv('KHY_T_INT', 7)), 42);
  assert.equal(withEnv('KHY_T_INT', '-3', () => th.intEnv('KHY_T_INT', 7)), 7);
  assert.equal(withEnv('KHY_T_INT', '0', () => th.intEnv('KHY_T_INT', 7)), 7);
  assert.equal(withEnv('KHY_T_INT', 'abc', () => th.intEnv('KHY_T_INT', 7)), 7);
  assert.equal(withEnv('KHY_T_INT', '', () => th.intEnv('KHY_T_INT', 7)), 7);
  assert.equal(th.intEnv('KHY_T_UNSET_XYZ', 7), 7);
  assert.equal(th.intEnv('KHY_T_UNSET_XYZ'), undefined);
});

test('KNOWN-DEFECT: intEnv 用 parseInt 静默截断——浮点 3.7 变 3，尾随垃圾 "12abc" 变 12', () => {
  // thresholds.js:14-17 → input '3.7' with default 9: measured 3 (not rejected).
  assert.equal(withEnv('KHY_T_FLOAT', '3.7', () => th.intEnv('KHY_T_FLOAT', 9)), 3);
  // input '12abc': parseInt stops at 'a' → 12, silently accepted as a valid int.
  assert.equal(withEnv('KHY_T_JUNK', '12abc', () => th.intEnv('KHY_T_JUNK', 9)), 12);
  // Same truncation reaches the public knob: dupMinSymbols reads the env as int.
  assert.equal(withEnv('KHY_PROJECT_DUP_MIN_SYMBOLS', '9.9', () => th.dupMinSymbols()), 9);
});

test('ratioEnv：(0,1] 接受，1 合法，0/1.5/NaN/垃圾全部回退默认', () => {
  assert.equal(withEnv('KHY_T_RATIO', '1', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 1);
  assert.equal(withEnv('KHY_T_RATIO', '0.5', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 0.5);
  assert.equal(withEnv('KHY_T_RATIO', '1.5', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 0.6);
  assert.equal(withEnv('KHY_T_RATIO', '0', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 0.6);
  assert.equal(withEnv('KHY_T_RATIO', '-0.5', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 0.6);
  assert.equal(withEnv('KHY_T_RATIO', 'junk', () => th.ratioEnv('KHY_T_RATIO', 0.6)), 0.6);
  assert.equal(th.ratioEnv('KHY_T_UNSET_RATIO', 0.42), 0.42);
});

test('godFileLoc 优先级：项目级覆盖 > arch 级继承 > 默认 2500', () => {
  withEnv('KHY_ARCH_GOD_FILE_LOC', '111', () => {
    assert.equal(th.godFileLoc(), 111);
    withEnv('KHY_PROJECT_GOD_FILE_LOC', '222', () => {
      assert.equal(th.godFileLoc(), 222);
    });
    // Invalid project override falls back to the arch value, not the literal default.
    withEnv('KHY_PROJECT_GOD_FILE_LOC', '0', () => {
      assert.equal(th.godFileLoc(), 111);
    });
  });
  withEnv('KHY_ARCH_GOD_FILE_LOC', '0', () => {
    assert.equal(th.godFileLoc(), 2500);
  });
});

test('各 dup 阈值 env 覆盖生效且惰性读取（不重新 require）', () => {
  withEnv('KHY_PROJECT_DUP_SYMBOL_OVERLAP', '0.9', () => {
    assert.equal(th.dupSymbolOverlap(), 0.9);
  });
  withEnv('KHY_PROJECT_DUP_CONTENT_JACCARD', '0.5', () => {
    assert.equal(th.dupContentJaccard(), 0.5);
  });
  withEnv('KHY_PROJECT_DUP_MIN_SYMBOLS', '8', () => {
    assert.equal(th.dupMinSymbols(), 8);
  });
  withEnv('KHY_PROJECT_DUP_MAX_SCAN_FILES', '10', () => {
    assert.equal(th.dupMaxScanFiles(), 10);
  });
  withEnv('KHY_PROJECT_DUP_MAX_FILE_BYTES', '1024', () => {
    assert.equal(th.dupMaxFileBytes(), 1024);
  });
});

test('enabled 总闸：off 大小写与首尾空格均命中，其余值不关', () => {
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', 'off', () => th.enabled()), false);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', ' OFF ', () => th.enabled()), false);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', 'Off', () => th.enabled()), false);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', 'OFF', () => th.enabled()), false);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', 'disable', () => th.enabled()), true);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', '', () => th.enabled()), true);
  assert.equal(withEnv('KHY_PROJECT_HYGIENE', undefined, () => th.enabled()), true);
});

test('导出面即全部公共 API（9 个函数，无隐藏入口）', () => {
  assert.deepEqual(Object.keys(th), [
    'intEnv',
    'ratioEnv',
    'godFileLoc',
    'dupSymbolOverlap',
    'dupContentJaccard',
    'dupMinSymbols',
    'dupMaxScanFiles',
    'dupMaxFileBytes',
    'enabled',
  ]);
});
