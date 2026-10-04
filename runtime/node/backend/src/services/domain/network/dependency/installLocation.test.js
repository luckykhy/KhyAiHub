'use strict';

/**
 * Co-located tests for installLocation.js — decides where project-scope installs land
 * on a read-only backend root. All side effects (accessSync / dataDir) are injected,
 * so no real filesystem is touched; registerModulePath mutates process state and is
 * restored in after().
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const il = require('./installLocation');
const { isWritableDir, resolveInstallRoot, modulePathsFor, registerModulePath, _internal } = il;

function deps({ writable = true, code = 'EACCES', dataDir = () => path.join('D:', 'data', 'deps') } = {}) {
  return {
    accessSync: (p) => {
      if (!writable) {
        const err = new Error('nope');
        err.code = code;
        throw err;
      }
    },
    WOK: 2,
    dataDir,
    platform: 'linux',
  };
}

describe('isWritableDir', () => {
  test('空目录直接判不可写，不调用 accessSync', () => {
    for (const v of ['', null, undefined, 0]) {
      assert.strictEqual(isWritableDir(v, deps({})), false, String(v));
    }
  });

  test('accessSync 不抛 → 可写', () => {
    assert.strictEqual(isWritableDir('/a/b', deps({ writable: true })), true);
  });

  test('EACCES / EROFS 等异常 → 不可写（保守方向）', () => {
    assert.strictEqual(isWritableDir('/a/b', deps({ writable: false, code: 'EACCES' })), false);
    assert.strictEqual(isWritableDir('/a/b', deps({ writable: false, code: 'EROFS' })), false);
  });

  test('ENOENT 时回看父目录可写', () => {
    let calls = 0;
    const d = {
      accessSync: (p) => {
        calls += 1;
        if (p === '/a/b') {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
        // 父目录 /a 可写
      },
      WOK: 2,
    };
    assert.strictEqual(isWritableDir('/a/b', d), true);
    assert.strictEqual(calls, 2);
  });

  test('ENOENT 且父目录也不可写 → false', () => {
    const d = {
      accessSync: (p) => {
        if (p === '/a/b') {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
        const e2 = new Error('ro');
        e2.code = 'EROFS';
        throw e2;
      },
      WOK: 2,
    };
    assert.strictEqual(isWritableDir('/a/b', d), false);
  });

  test('根目录 ENOENT 无父可回看 → false（dirname(根)===根）', () => {
    const d = {
      accessSync: () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      },
      WOK: 2,
    };
    // path.dirname('/') === '/'，父等于自身 → 不再回看
    assert.strictEqual(isWritableDir(path.sep === '/' ? '/' : 'C:\\', d), false);
  });

  test('桩缺 WOK 字段（垃圾 deps）时 accessSync 抛错仍被 catch，保守判不可写', () => {
    // installLocation.js:50/65 用 deps.WOK；缺字段不会抛穿——accessSync 自身抛即落入
    // catch → false。固化「任何异常都按不可写处理」的保守语义。
    assert.strictEqual(isWritableDir('/a/b', { accessSync: () => { throw new Error('x'); } }), false);
  });
});

describe('resolveInstallRoot', () => {
  test('backend 根可写 → 原样使用，零重定位', () => {
    const out = resolveInstallRoot('/backend', deps({ writable: true }));
    assert.deepStrictEqual(out, {
      root: '/backend',
      relocated: false,
      writable: true,
      reason: 'backend-root-writable',
    });
  });

  test('只读底座 → 重定位到用户数据家 deps/ 目录', () => {
    const out = resolveInstallRoot('/backend', deps({ writable: false, dataDir: () => '/home/u/.khy/deps' }));
    assert.deepStrictEqual(out, {
      root: '/home/u/.khy/deps',
      relocated: true,
      writable: true,
      reason: 'backend-root-readonly',
    });
  });

  test('数据家也取不到 → 退回原根、writable=false，不抛', () => {
    const out = resolveInstallRoot('/backend', deps({ writable: false, dataDir: () => { throw new Error('no datadir'); } }));
    assert.deepStrictEqual(out, {
      root: '/backend',
      relocated: false,
      writable: false,
      reason: 'datadir-unavailable',
    });
  });
});

describe('modulePathsFor', () => {
  test('空 installRoot 返回空数组', () => {
    assert.deepStrictEqual(modulePathsFor(''), []);
    assert.deepStrictEqual(modulePathsFor(null), []);
    assert.deepStrictEqual(modulePathsFor(undefined), []);
  });

  test('非空返回 <root>/node_modules 单元素数组', () => {
    assert.deepStrictEqual(modulePathsFor('/root'), [path.join('/root', 'node_modules')]);
  });
});

describe('registerModulePath', () => {
  const originalNodePath = process.env.NODE_PATH;
  const Module = require('module');
  const globalPathsBackup = Module.globalPaths.slice();

  after(() => {
    if (originalNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = originalNodePath;
    Module.globalPaths.length = 0;
    Module.globalPaths.push(...globalPathsBackup);
    _internal._resetRegistered();
  });

  test('空 installRoot 是 no-op：不改 NODE_PATH', () => {
    const before = process.env.NODE_PATH;
    registerModulePath('');
    registerModulePath(null);
    registerModulePath(undefined);
    assert.strictEqual(process.env.NODE_PATH, before);
  });

  test('注册后把 node_modules 置于 NODE_PATH 与 globalPaths 前部', () => {
    _internal._resetRegistered();
    const root = path.join('D:', 'tmp', 'khy-b45d-reg');
    const nm = path.join(root, 'node_modules');
    registerModulePath(root);
    assert.ok(String(process.env.NODE_PATH).split(path.sep === '\\' ? ';' : ':').includes(nm));
    assert.ok(Module.globalPaths.includes(nm));
  });

  test('同一路径重复注册幂等，不二次前插', () => {
    const root = path.join('D:', 'tmp', 'khy-b45d-reg');
    const nm = path.join(root, 'node_modules');
    const npBefore = process.env.NODE_PATH;
    registerModulePath(root); // 已在去重表里 → 直接返回
    assert.strictEqual(process.env.NODE_PATH, npBefore);
    assert.strictEqual(Module.globalPaths.filter((p) => p === nm).length, 1);
  });
});

describe('defaultDeps', () => {
  test('返回带 accessSync/WOK/dataDir/platform 的绑定对象', () => {
    const d = il.defaultDeps();
    assert.strictEqual(typeof d.accessSync, 'function');
    assert.strictEqual(typeof d.dataDir, 'function');
    assert.strictEqual(d.WOK, require('fs').constants.W_OK);
    assert.strictEqual(d.platform, process.platform);
  });
});
