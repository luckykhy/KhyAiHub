'use strict';

/**
 * instructionIncludeBoundary.test.js — 纯叶子契约 + resolveIncludes 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、isIncludeAllowed(base/home 下→true·
 * 兄弟名前缀→false·另一用户 home→false·关门/非串→null·自定义 sep)、fail-soft;接线活验:
 * 门开兄弟目录 @include 被拒(denied 注释),真 base 内 include 仍解析,门关逐字节回退(兄弟重新放行)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const leaf = require(path.join(__dirname, '../src/services/instructionIncludeBoundary'));

test('includeBoundaryAnchorEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.includeBoundaryAnchorEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.includeBoundaryAnchorEnabled({ KHY_INCLUDE_BOUNDARY_ANCHOR: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.includeBoundaryAnchorEnabled({ KHY_INCLUDE_BOUNDARY_ANCHOR: 'yes' }), true);
});

test('isIncludeAllowed: ON → anchored allow (base/home only, no sibling)', () => {
  const base = '/tmp/proj';
  const home = '/home/user';
  assert.strictEqual(leaf.isIncludeAllowed('/tmp/proj/a.md', base, home, '/', {}), true);     // in base
  assert.strictEqual(leaf.isIncludeAllowed(base, base, home, '/', {}), true);                 // base itself
  assert.strictEqual(leaf.isIncludeAllowed('/home/user/.khy/x.md', base, home, '/', {}), true); // in home
  assert.strictEqual(leaf.isIncludeAllowed('/tmp/proj-evil/inject.md', base, home, '/', {}), false); // sibling of base
  assert.strictEqual(leaf.isIncludeAllowed('/home/user2/.ssh/id_rsa', base, home, '/', {}), false);  // another user's home
  assert.strictEqual(leaf.isIncludeAllowed('/etc/passwd', base, home, '/', {}), false);
  // custom separator
  assert.strictEqual(leaf.isIncludeAllowed('C:\\proj\\a', 'C:\\proj', 'C:\\home', '\\', {}), true);
  assert.strictEqual(leaf.isIncludeAllowed('C:\\proj-x\\a', 'C:\\proj', 'C:\\home', '\\', {}), false);
});

test('isIncludeAllowed: OFF → null; non-string → null', () => {
  assert.strictEqual(leaf.isIncludeAllowed('/a/b', '/a', '/h', '/', { KHY_INCLUDE_BOUNDARY_ANCHOR: '0' }), null);
  assert.strictEqual(leaf.isIncludeAllowed(null, '/a', '/h', '/', {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.isIncludeAllowed('/a', '/a', '/h', '/', undefined));
  assert.doesNotThrow(() => leaf.includeBoundaryAnchorEnabled(null));
});

// ── resolveIncludes 接线(真跑;用临时目录构造 base + sibling 文件)──────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// Windows 上 os.tmpdir() 落在用户 profile 之下（C:\Users\<u>\AppData\Local\Temp），
// 而门的允许范围本就包含 $HOME/ —— 夹具的「evil 兄弟目录」于是落在允许范围内，
// 「sibling 必须被拒」这条 Linux 假设在 Windows 恒不成立（门开也放行）。
// 把 home 钉到一个不覆盖临时目录的 POSIX 路径，只隔离「兄弟名前缀」这一条判据。
const _realHomedir = os.homedir;
os.homedir = () => '/home/user';
test.after(() => { os.homedir = _realHomedir; });

function freshService() {
  delete require.cache[require.resolve('../src/services/instructionFileService')];
  delete require.cache[require.resolve('../src/services/instructionIncludeBoundary')];
  return require('../src/services/instructionFileService');
}

// Build: <tmp>/proj/main.md (base) and <tmp>/proj-evil/inject.md (sibling prefix).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-include-'));
const BASE = path.join(TMP, 'proj');
const SIB = path.join(TMP, 'proj-evil');
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(SIB, { recursive: true });
fs.writeFileSync(path.join(BASE, 'inner.md'), 'INNER-OK');
fs.writeFileSync(path.join(SIB, 'inject.md'), 'SIBLING-SECRET');

test('wiring ON: sibling-prefix @include denied; in-base include resolved', () => {
  withEnv({ KHY_INCLUDE_BOUNDARY_ANCHOR: undefined }, () => {
    const svc = freshService();
    // sibling: @../proj-evil/inject.md — resolves to /tmp/.../proj-evil/inject.md
    const outSib = svc.resolveIncludes('@../proj-evil/inject.md', BASE);
    assert.ok(outSib.includes('denied'), `expected denied, got: ${outSib}`);
    assert.ok(!outSib.includes('SIBLING-SECRET'), 'sibling content must NOT be inlined');
    // legit in-base include still works
    const outIn = svc.resolveIncludes('@inner.md', BASE);
    assert.ok(outIn.includes('INNER-OK'), `expected inlined, got: ${outIn}`);
  });
});

test('wiring OFF: byte-revert → sibling-prefix @include inlined again', () => {
  withEnv({ KHY_INCLUDE_BOUNDARY_ANCHOR: '0' }, () => {
    const svc = freshService();
    const outSib = svc.resolveIncludes('@../proj-evil/inject.md', BASE);
    // pre-existing over-permit returns → proves gate is a pure superset of denials
    assert.ok(outSib.includes('SIBLING-SECRET'), `legacy should inline sibling, got: ${outSib}`);
  });
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
