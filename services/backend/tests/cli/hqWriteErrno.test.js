'use strict';

// #79 Rule 2.2: `hq next --out <path>` wrote a raw Node errno straight to the
// user ("写入失败: ENOENT: no such file or directory, open '...'") — a verb
// prefix but no cause-mapping and no fix hint. _describeWriteError maps the
// dominant codes to Chinese cause + actionable next step and passes code-less
// Errors through unchanged. (The end-to-end wiring is proven by the live CLI
// repro; this suite pins the pure helper.)

let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = (name, fn) => nt.describe(name, fn);
  _test = (name, fn) => nt.test(name, fn);
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (s) => assert.ok(String(actual).includes(s), `expected to contain: ${s}`),
    notContain: (s) => assert.ok(!String(actual).includes(s), `expected NOT to contain: ${s}`),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
  });
}

const { _describeWriteError } = require('../../src/cli/handlers/hq.js');

function errno(code, message) {
  const e = new Error(message || `${code}: raw libuv message`);
  e.code = code;
  return e;
}

_describe('hq _describeWriteError (Rule 2.2 errno mapping)', () => {
  _test('ENOENT → Chinese cause + create-dir fix, no raw errno left', () => {
    const out = _describeWriteError(errno('ENOENT', "ENOENT: no such file or directory, open 'D:/x/p.txt'"));
    _expect(out).toContain('目标目录不存在');
    _expect(out).toContain('ENOENT');
    _expect(out).toContain('请先创建该目录');
    // the raw passthrough phrase that the old code leaked must be gone
    _expect(out).notContain('no such file or directory');
  });

  _test('EISDIR →补上文件名 fix', () => {
    const out = _describeWriteError(errno('EISDIR', 'EISDIR: illegal operation on a directory'));
    _expect(out).toContain('目录而非文件');
    _expect(out).toContain('补上文件名');
  });

  _test('EACCES / ENOSPC → cause + fix', () => {
    _expect(_describeWriteError(errno('EACCES'))).toContain('权限不足');
    _expect(_describeWriteError(errno('ENOSPC'))).toContain('磁盘空间不足');
  });

  _test('code-less Error passes through unchanged (already-readable)', () => {
    const out = _describeWriteError(new Error('序列化失败'));
    _expect(out).toBe('序列化失败');
  });

  _test('non-Error value coerced to string, no throw', () => {
    _expect(_describeWriteError('boom')).toBe('boom');
    _expect(_describeWriteError(undefined)).toBe('undefined');
  });
});
