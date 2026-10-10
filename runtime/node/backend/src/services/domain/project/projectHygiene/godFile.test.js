'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessGodFile, countLines, ASSESSABLE_EXTS } = require('./godFile.js');

const PROJECT_ENV = 'KHY_PROJECT_GOD_FILE_LOC';
const ARCH_ENV = 'KHY_ARCH_GOD_FILE_LOC';

function withEnv(name, value, fn) {
  const saved = { [name]: process.env[name] };
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('countLines 空内容一律记 0 行', () => {
  assert.equal(countLines(undefined), 0);
  assert.equal(countLines(null), 0);
  assert.equal(countLines(''), 0);
});

test('countLines 按换行数加一计数，含末尾空行', () => {
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 3);
  assert.equal(countLines('\n'), 2);
  assert.equal(countLines('\n\n'), 3);
  assert.equal(countLines('x\r\ny'), 2);
});

test('countLines 对非字符串先 String() 再数', () => {
  assert.equal(countLines(123), 1);
  assert.equal(countLines(['x', 'y']), 1);
  assert.equal(countLines({}), 1);
});

test('KNOWN-DEFECT: countLines 的 falsy 早退把合法的数字 0 当空内容', () => {
  // input 0 -> measured 0; input '0' (same content as a string) -> measured 1
  assert.equal(countLines(0), 0);
  assert.equal(countLines('0'), 1);
});

test('assessGodFile 无参调用返回不可评估的空壳', () => {
  assert.deepEqual(assessGodFile(), {
    violation: false,
    loc: 0,
    threshold: 2500,
    assessable: false,
  });
  assert.deepEqual(assessGodFile({}), {
    violation: false,
    loc: 0,
    threshold: 2500,
    assessable: false,
  });
});

test('assessGodFile 源码扩展名参与评估且未超限时不违规', () => {
  assert.deepEqual(assessGodFile({ path: 'a.js', content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: true,
  });
  assert.deepEqual(assessGodFile({ path: 'src/deep/mod.vue', content: '1\n2\n3', threshold: 4 }), {
    violation: false,
    loc: 3,
    threshold: 4,
    assessable: true,
  });
});

test('assessGodFile 超过阈值判违规，等于阈值不违规（严格大于）', () => {
  assert.deepEqual(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: 1 }), {
    violation: true,
    loc: 2,
    threshold: 1,
    assessable: true,
  });
  assert.equal(assessGodFile({ path: 'a.py', content: 'x\ny', threshold: 2 }).violation, false);
});

test('assessGodFile 非源码扩展名不评估但仍如实数出 loc', () => {
  assert.deepEqual(assessGodFile({ path: 'a.json', content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: false,
  });
  assert.deepEqual(assessGodFile({ path: 'a.MYAPP', content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: false,
  });
  assert.deepEqual(assessGodFile({ path: 'noext', content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: false,
  });
});

test('assessGodFile 天生很长的路径被豁免（锁文件/min/bundle/generated）', () => {
  for (const p of [
    'package-lock.json',
    'src/package-lock.json',
    'a.min.js',
    'a.bundle.js',
    'a.generated.ts',
    'x.lock',
    'yarn.lock',
    'pnpm-lock.yaml',
  ]) {
    assert.deepEqual(
      assessGodFile({ path: p, content: '1\n2', threshold: 1 }),
      { violation: false, loc: 2, threshold: 1, assessable: false },
      `expected exempt: ${p}`
    );
  }
});

test('assessGodFile 扩展名判定不区分大小写', () => {
  assert.deepEqual(assessGodFile({ path: 'A.JS', content: '1\n2', threshold: 9 }), {
    violation: false,
    loc: 2,
    threshold: 9,
    assessable: true,
  });
  assert.deepEqual(assessGodFile({ path: '.js', content: '1\n2', threshold: 9 }), {
    violation: false,
    loc: 2,
    threshold: 9,
    assessable: true,
  });
});

test('assessGodFile path 为 null 时不抛错且不可评估', () => {
  assert.deepEqual(assessGodFile({ path: null, content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: false,
  });
  assert.deepEqual(assessGodFile({ path: 123, content: 'x\ny' }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: false,
  });
});

test('KNOWN-DEFECT: 合法 threshold 0 与非整数被静默回落到默认 2500', () => {
  // Number.isInteger(threshold) && threshold > 0 -> a deliberate ceiling of 0
  // (block every assessable write) is swallowed and reads back as 2500.
  assert.deepEqual(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: 0 }), {
    violation: false,
    loc: 2,
    threshold: 2500,
    assessable: true,
  });
  assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: 2.5 }).threshold, 2500);
  assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: -3 }).threshold, 2500);
  assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: '10' }).threshold, 2500);
  assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny', threshold: NaN }).threshold, 2500);
});

test('阈值 env 覆盖：project 优先于 arch，二者皆未设回落 2500', () => {
  withEnv(PROJECT_ENV, undefined, () => {
    withEnv(ARCH_ENV, undefined, () => {
      assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny' }).threshold, 2500);
    });
    withEnv(ARCH_ENV, '7', () => {
      assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny' }).threshold, 7);
    });
    withEnv(ARCH_ENV, '7', () => {
      withEnv(PROJECT_ENV, '5', () => {
        assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny' }).threshold, 5);
      });
    });
    // intEnv also requires > 0, so a zero-valued env knob is swallowed too
    withEnv(PROJECT_ENV, '0', () => {
      assert.equal(assessGodFile({ path: 'a.js', content: 'x\ny' }).threshold, 2500);
    });
  });
});

test('ASSESSABLE_EXTS 是 25 项源码扩展名集合且不含数据/锁文件后缀', () => {
  assert.equal(ASSESSABLE_EXTS.size, 25);
  assert.equal(ASSESSABLE_EXTS.has('js'), true);
  assert.equal(ASSESSABLE_EXTS.has('vue'), true);
  assert.equal(ASSESSABLE_EXTS.has('svelte'), true);
  assert.equal(ASSESSABLE_EXTS.has('json'), false);
  assert.equal(ASSESSABLE_EXTS.has(''), false);
  assert.equal(ASSESSABLE_EXTS.has('JS'), false);
  assert.equal([...ASSESSABLE_EXTS].slice(0, 3).join(','), 'js,jsx,mjs');
});
