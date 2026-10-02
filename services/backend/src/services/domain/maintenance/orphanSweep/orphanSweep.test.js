'use strict';

// Colocated tests for orphanSweep.js (pip-upgrade `~` orphan directory sweeper).
// Uses injected fake fs for edge cases and real fs inside os.tmpdir() for the
// end-to-end sweep; nothing outside tmpdir is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./orphanSweep');

test('isEnabled：KHY_ORPHAN_SWEEP 默认开，仅 0/false/off/no 关', () => {
  assert.equal(svc.isEnabled({}), true);
  assert.equal(svc.isEnabled(undefined), true);
  assert.equal(svc.isEnabled(null), true);
  for (const v of ['0', 'false', 'off', 'no', ' FALSE ']) {
    assert.equal(svc.isEnabled({ KHY_ORPHAN_SWEEP: v }), false, v);
  }
  assert.equal(svc.isEnabled({ KHY_ORPHAN_SWEEP: '1' }), true);
  assert.equal(svc.isEnabled({ KHY_ORPHAN_SWEEP: null }), true); // null → 'true' 惯例
});

test('resolveMaxSweep：KHY_ORPHAN_SWEEP_MAX 垃圾值全回默认，正整数生效', () => {
  assert.equal(svc.resolveMaxSweep({}), svc.DEFAULT_MAX_SWEEP);
  assert.equal(svc.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: '3' }), 3);
  assert.equal(svc.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: 5 }), 5);
  for (const bad of ['abc', '0', '-3', '2.5', '', '   ', NaN, {}]) {
    assert.equal(svc.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: bad }), svc.DEFAULT_MAX_SWEEP, String(bad));
  }
  // '1e3' 经 Number() = 1000：整数且 >0 → 生效（科学计数法被接受）
  assert.equal(svc.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: '1e3' }), 1000);
  assert.equal(svc.resolveMaxSweep(null), svc.DEFAULT_MAX_SWEEP);
});

test('isCorruptOrphanName：仅 ~ 开头的非 ./. .. 名字判真', () => {
  for (const good of ['~rc', '~', '~~x', '~0', '~$office-lock']) {
    assert.equal(svc.isCorruptOrphanName(good), true, good);
  }
  for (const bad of ['src', '', '.', '..', '~'.repeat(0), null, undefined, 0, 42, {}, [], '~'.charCodeAt(0)]) {
    assert.equal(svc.isCorruptOrphanName(bad), false, String(bad));
  }
});

test('_isInside：树内真、树外假、根自身真、垃圾假', () => {
  const root = path.join(os.tmpdir(), 'wa-orphan-root');
  assert.equal(svc._isInside(path.join(root, 'a'), root), true);
  assert.equal(svc._isInside(root, root), true);
  assert.equal(svc._isInside(root + 'sibling', root), false);
  assert.equal(svc._isInside(null, root), false);
  assert.equal(svc._isInside(path.join(root, 'a'), null), false);
});

test('sweepBundledOrphans 门控关 / 无 root → skipped 空结果', () => {
  const off = svc.sweepBundledOrphans({ root: 'x', env: { KHY_ORPHAN_SWEEP: '0' } });
  assert.equal(off.skipped, true);
  assert.equal(off.reason, 'gate-off');
  for (const root of [undefined, null, '', 0, {}, ['x']]) {
    const r = svc.sweepBundledOrphans({ root, env: {} });
    assert.equal(r.skipped, true, String(root));
    assert.equal(r.reason, 'no-root');
  }
});

test('sweepBundledOrphans 真实 fs：递归删 ~ 目录、~ 文件不动、剪枝 node_modules/.git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-orphan-'));
  try {
    fs.mkdirSync(path.join(root, 'services', 'backend', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '~rc'), { recursive: true }); // 顶层孤儿
    fs.mkdirSync(path.join(root, 'services', '~ogrotate.d'), { recursive: true }); // 深层孤儿
    fs.writeFileSync(path.join(root, '~file.txt'), 'keep me'); // ~ 前缀文件
    fs.writeFileSync(path.join(root, '~rc', 'junk.bin'), 'x');
    fs.mkdirSync(path.join(root, 'node_modules', '~pkg'), { recursive: true }); // 剪枝内不扫
    fs.mkdirSync(path.join(root, '.git', '~obj'), { recursive: true });

    // dry-run：计数但不删
    const dry = svc.sweepBundledOrphans({ root, apply: false, env: {} });
    assert.equal(dry.ok, true);
    assert.equal(dry.removed.length, 2);
    assert.equal(fs.existsSync(path.join(root, '~rc')), true);

    // 实删
    const r = svc.sweepBundledOrphans({ root, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'done');
    assert.equal(r.removed.length, 2);
    assert.equal(fs.existsSync(path.join(root, '~rc')), false);
    assert.equal(fs.existsSync(path.join(root, 'services', '~ogrotate.d')), false);
    assert.equal(fs.existsSync(path.join(root, '~file.txt')), true); // 文件保留
    assert.equal(fs.existsSync(path.join(root, 'services', 'backend', 'src')), true);
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '~pkg')), true); // 剪枝未入
    assert.equal(fs.existsSync(path.join(root, '.git', '~obj')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans limit：达上限即停并报 reason=limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-orphan-'));
  try {
    fs.mkdirSync(path.join(root, '~a'), { recursive: true });
    fs.mkdirSync(path.join(root, '~b'), { recursive: true });
    const r = svc.sweepBundledOrphans({ root, limit: 1, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.removed.length, 1);
    assert.equal(r.reason, 'limit');
    assert.equal(fs.existsSync(path.join(root, '~b')), true); // 第二个未删
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans：root 不存在（realpath 抛）→ skipped no-root', () => {
  const r = svc.sweepBundledOrphans({ root: path.join(os.tmpdir(), 'wa-orphan-missing-zz'), env: {} });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-root');
});

test('sweepBundledOrphans 注入 fs：符号链接跳过、不可读目录跳过、绝不抛', () => {
  const entries = {
    [path.join('R', '')]: [
      { name: 'link', isSymbolicLink: () => true, isDirectory: () => false },
      { name: '~orphan', isSymbolicLink: () => false, isDirectory: () => true },
      { name: 'plain', isSymbolicLink: () => false, isDirectory: () => true },
    ],
    [path.join('R', 'plain', '')]: null, // readdir 抛错 → 跳过
  };
  const calls = { rm: [] };
  const fsm = {
    realpathSync: (p) => p,
    readdirSync(dir) {
      const e = entries[path.join(dir, '')];
      if (!e) {
        throw new Error('EACCES');
      }
      return e;
    },
    rmSync: (p, o) => calls.rm.push(p),
  };
  const r = svc.sweepBundledOrphans({ root: 'R', fs: fsm, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 1); // 只有 ~orphan；link 跳过、plain 深入但读失败
  assert.ok(r.removed[0].endsWith('~orphan'));
  assert.equal(calls.rm.length, 1);
});

// KNOWN-DEFECT: 条目缺 name 时 path.join(dir, undefined) 抛 TypeError（orphanSweep.js:183-184
// 不在 try 内），被最外层 catch 捕获后整个清扫以 ok:false 收场——单条坏条目中断全扫，
// 而非按目录级 fail-soft（低危：真实 Dirent 恒有 name，仅注入/异常 fs 可触发）。
test('KNOWN-DEFECT: 注入 fs 条目缺 name → 全扫以 ok:false 中断', () => {
  const fsm = {
    realpathSync: (p) => p,
    readdirSync: () => [{ isSymbolicLink: () => false, isDirectory: () => true }], // 无 name
    rmSync: () => {},
  };
  const r = svc.sweepBundledOrphans({ root: 'R', fs: fsm, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^error:/);
});

test('sweepBundledOrphans 注入 fs 删除失败 → 跳过该条目继续', () => {
  const fsm = {
    realpathSync: (p) => p,
    readdirSync: (dir) => {
      if (dir === 'R') {
        return [
          { name: '~bad', isSymbolicLink: () => false, isDirectory: () => true },
          { name: '~good', isSymbolicLink: () => false, isDirectory: () => true },
        ];
      }
      return [];
    },
    rmSync: (p) => {
      if (p.endsWith('~bad')) {
        throw new Error('EBUSY');
      }
    },
  };
  const r = svc.sweepBundledOrphans({ root: 'R', fs: fsm, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 1);
  assert.ok(r.removed[0].endsWith('~good'));
});
