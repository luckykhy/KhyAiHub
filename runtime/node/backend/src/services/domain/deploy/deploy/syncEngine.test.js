'use strict';

// Co-located tests for syncEngine.js. shouldExclude/isInside are pure-logic
// units; syncTree runs against an in-memory fs double for decision coverage
// plus one real-fs end-to-end pass confined to an os.tmpdir() sandbox.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const sync = require('./syncEngine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-sync-'));

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

class MemoryFs {
  constructor(tree) {
    // Keys are resolved so the map works identically whether the host joins
    // with '/' (posix) or rewrites '/src' to '<cwdDrive>:\\src' (win32).
    this.nodes = new Map(Object.entries(tree).map(([k, v]) => [path.resolve(k), v]));
    this.mkdirCalls = [];
    this.copyCalls = [];
    this.rmCalls = [];
    this.linkCalls = [];
  }
  existsSync(p) { return this.nodes.has(path.resolve(p)); }
  mkdirSync(p, opts) { this.mkdirCalls.push([p, opts]); this.nodes.set(path.resolve(p), { type: 'dir' }); }
  readdirSync(p) {
    const rp = path.resolve(p);
    const prefix = `${rp}${path.sep}`;
    const out = [];
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes(path.sep)) out.push(rest);
    }
    return out;
  }
  lstatSync(p) {
    const node = this.nodes.get(path.resolve(p));
    if (!node) { const e = new Error(`ENOENT ${p}`); e.code = 'ENOENT'; throw e; }
    return {
      isSymbolicLink: () => node.type === 'symlink',
      isDirectory: () => node.type === 'dir',
      isFile: () => node.type === 'file',
      size: node.size,
    };
  }
  copyFileSync(a, b) { this.copyCalls.push([a, b]); this.nodes.set(path.resolve(b), { type: 'file', size: 1 }); }
  readlinkSync(p) { return this.nodes.get(path.resolve(p)).target; }
  symlinkSync(target, p) {
    this.linkCalls.push([target, p]);
    if (this.throwOnLink) { const e = new Error('EPERM symlink'); e.code = 'EPERM'; throw e; }
    if (this.nodes.has(path.resolve(p))) throw new Error('EEXIST');
    this.nodes.set(path.resolve(p), { type: 'symlink', target });
  }
  rmSync(p) { this.rmCalls.push(p); this.nodes.delete(path.resolve(p)); }
}

function srcTree(extra = {}) {
  return {
    '/src': { type: 'dir' },
    '/src/a.txt': { type: 'file', size: 10 },
    '/src/sub': { type: 'dir' },
    '/src/sub/b.txt': { type: 'file', size: 5 },
    '/src/node_modules': { type: 'dir' },
    '/src/node_modules/lib.js': { type: 'file', size: 999 },
    '/src/debug.log': { type: 'file', size: 77 },
    ...extra,
  };
}

describe('shouldExclude', () => {
  test('默认名单按 basename 命中：构建物/VCS/缓存目录全排除', () => {
    for (const b of ['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', 'env', '.next', '.DS_Store', '.vscode']) {
      assert.equal(sync.shouldExclude(`x/${b}`, b, {}), true, b);
    }
    assert.ok(Array.isArray(sync.DEFAULT_EXCLUDES));
  });

  test('*.log 无条件排除且大小写不敏感；普通文件放行', () => {
    assert.equal(sync.shouldExclude('x', 'debug.LOG', {}), true);
    assert.equal(sync.shouldExclude('x', 'app.LOG', { excludes: [] }), true, '自定义名单不豁免 .log 规则');
    assert.equal(sync.shouldExclude('x', 'log', {}), false);
    assert.equal(sync.shouldExclude('x', 'a.log.bak', {}), false);
    assert.equal(sync.shouldExclude('x', 'README.md', {}), false);
  });

  test('excludeDotfiles 才排除点开头条目', () => {
    assert.equal(sync.shouldExclude('x', '.env', {}), false);
    assert.equal(sync.shouldExclude('x', '.env', { excludeDotfiles: true }), true);
  });

  test('KNOWN-DEFECT: 默认配置下 .env/.npmrc 等凭据点文件被原样拷进部署目标', () => {
    // syncEngine.js:27-48 — DEFAULT_EXCLUDES covers 'env' (the venv dir name)
    // but NOT the dotfile secrets ('.env', '.npmrc', '.git-credentials').
    // excludeDotfiles is opt-in only, so the default deploy copy ships
    // credentials sitting in the project root to the target directory.
    assert.equal(sync.shouldExclude('.env', '.env', {}), false);
    assert.equal(sync.shouldExclude('conf/.npmrc', '.npmrc', {}), false);
  });

  test('垃圾 opts：excludes 传非数组字符串不炸（includes 语义巧合可用）', () => {
    assert.equal(sync.shouldExclude('x', 'node_modules', { excludes: 'node_modules' }), true, 'string.includes matches basename');
    assert.equal(sync.shouldExclude('x', 'node_modules', { excludes: [] }), false);
    assert.equal(sync.shouldExclude(undefined, undefined, {}), false);
  });
});

describe('isInside', () => {
  test('等于/嵌套为 true；同级前缀目录与旁路为 false', () => {
    assert.equal(sync.isInside('/a', '/a'), true);
    assert.equal(sync.isInside('/a', path.join('/a', 'b', 'c')), true);
    assert.equal(sync.isInside('/a', '/ab'), false);
    assert.equal(sync.isInside('/a/b', '/a'), false);
    assert.equal(sync.isInside('/a', path.join('/x', '..', 'a', 'b')), true);
  });
});

describe('syncTree（内存 fs 决策面）', () => {
  test('正常递归拷贝：copied 用 posix 相对路径、bytes 累加、排除入 skipped', () => {
    const mfs = new MemoryFs(srcTree());
    const r = sync.syncTree('/src', '/dst', { fs: mfs });
    assert.deepEqual(r.copied.sort(), ['a.txt', 'sub/b.txt']);
    assert.deepEqual(r.skipped.sort(), ['debug.log', 'node_modules']);
    assert.equal(r.bytes, 15);
    assert.ok(r.dirs >= 1);
    assert.ok(mfs.nodes.has(path.resolve('/dst/sub/b.txt')));
  });

  test('源不存在/源等于目标/目标在源内部 → 各自抛具体中文错误', () => {
    const mfs = new MemoryFs(srcTree());
    assert.throws(() => sync.syncTree('/ghost', '/dst', { fs: mfs }), /部署源不存在/);
    assert.throws(() => sync.syncTree('/src', '/src', { fs: mfs }), /部署源与目标相同/);
    assert.throws(() => sync.syncTree('/src', path.resolve('/src', 'inner'), { fs: mfs }), /部署目标位于源目录内部/);
  });

  test('目标在源之外（源在目标内）允许执行', () => {
    const mfs = new MemoryFs({ '/dst': { type: 'dir' }, '/dst/src': { type: 'dir' }, '/dst/src/f.txt': { type: 'file', size: 2 } });
    const r = sync.syncTree('/dst/src', '/dst2', { fs: mfs });
    assert.deepEqual(r.copied, ['f.txt']);
  });

  test('symlink 原样保留（不解引用），目标已存在先删再链', () => {
    const extra = {
      '/src/rel-link': { type: 'symlink', target: '../outside' },
      '/dst': { type: 'dir' },
      '/dst/rel-link': { type: 'file', size: 1 },
    };
    const mfs = new MemoryFs({ ...srcTree(), ...extra });
    const r = sync.syncTree('/src', '/dst', { fs: mfs });
    assert.ok(r.copied.includes('rel-link'));
    assert.ok(mfs.rmCalls.some((p) => p.endsWith(path.join('dst', 'rel-link'))), 'existing dest entry must be removed first');
    assert.equal(mfs.linkCalls[0][0], '../outside');
    assert.ok(mfs.linkCalls[0][1].endsWith(path.join('dst', 'rel-link')));
  });

  test('symlink 创建失败（如权限不足）归入 skipped 不中断整体拷贝', () => {
    const mfs = new MemoryFs({ ...srcTree(), '/src/bad-link': { type: 'symlink', target: 'x' } });
    mfs.throwOnLink = true;
    const r = sync.syncTree('/src', '/dst', { fs: mfs });
    assert.ok(r.skipped.includes('bad-link'));
    assert.ok(r.copied.includes('a.txt'), 'other entries continue unaffected');
  });

  test('KNOWN-DEFECT: 既非文件/目录/符号链接的条目（fifo/socket/设备）凭空消失', () => {
    // syncEngine.js:125-143 — the lstat dispatch has no else branch: such an
    // entry lands in NEITHER copied NOR skipped, breaking the documented
    // "transparency: manifest of copied files and skipped entries" contract.
    const mfs = new MemoryFs({ ...srcTree(), '/src/sock': { type: 'fifo' } });
    const r = sync.syncTree('/src', '/dst', { fs: mfs });
    assert.ok(!r.copied.includes('sock'));
    assert.ok(!r.skipped.includes('sock'));
  });

  test('自定义 excludes 替换默认名单（默认项不再被排除）', () => {
    const mfs = new MemoryFs(srcTree());
    const r = sync.syncTree('/src', '/dst', { fs: mfs, excludes: ['sub'] });
    assert.ok(r.skipped.includes('sub'));
    assert.ok(r.copied.includes('node_modules/lib.js'), 'node_modules no longer excluded when list is overridden');
  });

  test('opts 对象被实时消费：result 每次全新，复用 opts 会改变后续运行', () => {
    const opts = { fs: new MemoryFs(srcTree()), excludes: [] };
    const r1 = sync.syncTree('/src', '/dst', opts);
    opts.excludes.push('a.txt');
    const r2 = sync.syncTree('/src', '/dst', opts);
    assert.notEqual(r1, r2);
    assert.notEqual(r1.copied, r2.copied);
    assert.ok(r1.copied.includes('a.txt'));
    assert.ok(r2.skipped.includes('a.txt'), 'a reused opts object changes later runs — syncTree holds no snapshot');
  });

  test('目录已存在于目标时不重复计数 dirs', () => {
    const mfs = new MemoryFs(srcTree({ '/dst': { type: 'dir' }, '/dst/sub': { type: 'dir' } }));
    const r = sync.syncTree('/src', '/dst', { fs: mfs });
    assert.equal(r.dirs, 0, 'both /dst and /dst/sub already exist, nothing to create or count');
  });
});

describe('syncTree（真实 fs，仅 tmp）', () => {
  test('真实目录端到端：排除 node_modules 与 .log，内容一致', () => {
    const src = path.join(tmp, 'e2e-src');
    const dst = path.join(tmp, 'e2e-dst');
    fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.js'), 'main');
    fs.writeFileSync(path.join(src, 'src', 'util.js'), 'util');
    fs.writeFileSync(path.join(src, 'node_modules', 'pkg', 'x.js'), 'dep');
    fs.writeFileSync(path.join(src, 'run.log'), 'noisy');
    const r = sync.syncTree(src, dst, {});
    assert.ok(r.copied.includes('index.js'));
    assert.ok(r.copied.includes(path.join('src', 'util.js').split(path.sep).join('/')));
    assert.ok(r.skipped.includes('node_modules'));
    assert.ok(r.skipped.includes('run.log'));
    assert.equal(fs.readFileSync(path.join(dst, 'index.js'), 'utf8'), 'main');
    assert.equal(fs.existsSync(path.join(dst, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(dst, 'run.log')), false);
  });

  test('源路径传相对不存在目录时按 resolve 后报错（不静默）', () => {
    assert.throws(() => sync.syncTree(path.join(tmp, 'nope'), path.join(tmp, 'out'), {}), /部署源不存在/);
  });
});
