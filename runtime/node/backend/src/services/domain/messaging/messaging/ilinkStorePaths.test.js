'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataHomePath = require.resolve('../../../../utils/dataHome');
const baseModule = {
  id: dataHomePath,
  filename: dataHomePath,
  loaded: true,
  exports: null,
  children: [],
  paths: [],
};

let tmpRoot;
let calls;

function installStub(baseDir) {
  calls = [];
  baseModule.exports = {
    getBaseDataDir(...segments) {
      calls.push(segments);
      return path.join(baseDir(), ...segments);
    },
  };
  require.cache[dataHomePath] = baseModule;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ilinkStorePaths-'));
});

after(() => {
  delete require.cache[dataHomePath];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('ilinkStorePaths —— 路径与校验叶子', () => {
  it('导出面收齐 8 个成员', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    assert.deepStrictEqual(Object.keys(m).sort(), [
      'ACCOUNT_ID_RE',
      'FILE_MODE',
      '_credBak',
      '_credFile',
      '_ctxTokenFile',
      '_cursorFile',
      '_dir',
      '_isValidAccountId',
      '_stateFile',
    ]);
  });

  it('FILE_MODE 是 0o600（凭据文件权限位）', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    assert.equal(m.FILE_MODE, 0o600);
    assert.equal(m.FILE_MODE, 384);
  });

  it('_dir 走 getBaseDataDir(".")（每次调用实时解析）', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    const dir = m._dir();
    assert.equal(dir, tmpRoot);
    assert.deepStrictEqual(calls, [['.']]);
  });

  it('五个文件名各就其位并挂在 _dir 之下', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    assert.equal(m._credFile(), path.join(tmpRoot, 'ilink.json'));
    assert.equal(m._credBak(), path.join(tmpRoot, 'ilink.bak'));
    assert.equal(m._cursorFile(), path.join(tmpRoot, 'ilink-cursor.json'));
    assert.equal(m._stateFile(), path.join(tmpRoot, 'ilink-state.json'));
    assert.equal(m._ctxTokenFile(), path.join(tmpRoot, 'ilink-context-tokens.json'));
  });

  // Measured: _dir() re-reads the base on every call, so a store constructed once
  // keeps following a redirected home. Nothing is cached at load time — this is
  // the documented "测试可通过设置家目录 env 把整套路径改到临时目录" contract.
  it('改基目录后既有模块实例立即跟随（load 期不缓存）', () => {
    let base = path.join(tmpRoot, 'a');
    installStub(() => base);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    assert.equal(m._credFile(), path.join(base, 'ilink.json'));
    base = path.join(tmpRoot, 'b');
    assert.equal(m._credFile(), path.join(base, 'ilink.json'));
    assert.equal(m._cursorFile(), path.join(base, 'ilink-cursor.json'));
  });

  it('_isValidAccountId 放行合法字符集（含 _ . @ = -）', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    for (const id of ['a', 'A9', 'user_1', 'a.b', 'a@b', 'a=b', 'a-b', 'wxid_abc123']) {
      assert.equal(m._isValidAccountId(id), true, id);
    }
  });

  it('_isValidAccountId 拒绝非字符串与空值', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    for (const id of [null, undefined, 0, 1, NaN, true, false, {}, [], () => {}]) {
      assert.equal(m._isValidAccountId(id), false, String(id));
    }
    assert.equal(m._isValidAccountId(''), false);
    assert.equal(m._isValidAccountId('   '), false);
  });

  it('_isValidAccountId 拒绝正则外字符与换行', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    for (const id of ['a b', 'a/b', 'a\\b', 'a+b', 'a#b', '../../etc/passwd', 'a\nb', 'ab\n']) {
      assert.equal(m._isValidAccountId(id), false, JSON.stringify(id));
    }
  });

  it('ACCOUNT_ID_RE 与 _isValidAccountId 判据一致（同字符集）', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    assert.ok(m.ACCOUNT_ID_RE instanceof RegExp);
    assert.equal(m.ACCOUNT_ID_RE.test('good_id-1@x.y=z'), true);
    assert.equal(m.ACCOUNT_ID_RE.test(''), false);
    assert.equal(m.ACCOUNT_ID_RE.test('bad id'), false);
  });

  // Measured: reassigning the exported ACCOUNT_ID_RE property does NOT change
  // _isValidAccountId, which closes over the module-level const. The export is a
  // loose copy, so mutating the public surface silently fails to take effect.
  it('KNOWN-DEFECT: 改导出对象上的 ACCOUNT_ID_RE 对 _isValidAccountId 无效（闭包引用另一份）', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    const original = m.ACCOUNT_ID_RE;
    try {
      m.ACCOUNT_ID_RE = /^zzz$/;
      assert.equal(m.ACCOUNT_ID_RE.test('good_id'), false);
      assert.equal(m._isValidAccountId('good_id'), true);
    } finally {
      m.ACCOUNT_ID_RE = original;
    }
    assert.equal(m._isValidAccountId('good_id'), true);
  });

  it('全程只在临时目录下算路径，未在仓库落任何文件', () => {
    installStub(() => tmpRoot);
    delete require.cache[require.resolve('./ilinkStorePaths')];
    const m = require('./ilinkStorePaths');
    m._dir();
    m._credFile();
    m._credBak();
    m._cursorFile();
    m._stateFile();
    m._ctxTokenFile();
    assert.equal(fs.existsSync(tmpRoot), true);
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
  });
});
