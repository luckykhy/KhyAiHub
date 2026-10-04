'use strict';

/**
 * genericExtractor.test.js — 通用兜底解包驱动的契约。
 *
 * 真源规范：DESIGN-ARCH-054（unpack 的「遇到未知格式不自救」缺口的补救层）。
 * 本文件把平台与可执行探测都注入（opts.platform / opts.has），因此零真机探测、零子进程，
 * 可确定性运行。重点钉：候选优先序、地板/上限、fail-closed，以及 B27-F1 的回归。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ge = require('./genericExtractor');

const REAL_KEYS = [
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.lzma',
  '.zst',
  '.lz4',
  '.cab',
  '.iso',
  '.deb',
  '.rpm',
];

test('detectGenericFormat 覆盖 11 个登记扩展名，大小写不敏感', () => {
  assert.ok(REAL_KEYS.length > 0);
  for (const ext of REAL_KEYS) {
    assert.strictEqual(ge.detectGenericFormat(`archive${ext}`), ext, `${ext} 应被识别`);
    assert.strictEqual(ge.detectGenericFormat(`archive${ext.toUpperCase()}`), ext);
  }
});

test('detectGenericFormat 对空/非串/未登记扩展名返回 null', () => {
  assert.strictEqual(ge.detectGenericFormat(null), null);
  assert.strictEqual(ge.detectGenericFormat(''), null);
  assert.strictEqual(ge.detectGenericFormat(7), null);
  assert.strictEqual(ge.detectGenericFormat('archive.zip'), null); // zip 族不走兜底
  assert.strictEqual(ge.detectGenericFormat('archive.tar.xz'), '.xz'); // 只看尾巴
});

test('pickExtractor 按登记表的偏好序取第一个可用工具', () => {
  const rar = ge.GENERIC_FORMATS['.rar'].tools;
  assert.deepStrictEqual(rar, ['7z', 'unar', 'unrar', '7za']);
  assert.deepStrictEqual(ge.pickExtractor('.rar', { has: (b) => b === 'unrar' }), {
    bin: 'unrar',
    kind: 'unrar',
  });
  // 前两名都缺时，第三名的 kind 仍由可执行名归一。
  assert.deepStrictEqual(
    ge.pickExtractor('.rar', { has: (b) => b === '7za' }),
    { bin: '7za', kind: '7z' }
  );
  assert.strictEqual(ge.pickExtractor('.rar', { has: () => false }), null);
});

test('pickExtractor 把 has() 抛错视作不可用并继续试下一个（fail-closed）', () => {
  const seen = [];
  const picked = ge.pickExtractor('.7z', {
    has: (b) => {
      seen.push(b);
      if (b === '7z') {
        throw new Error('probe blew up');
      }
      return b === '7zz';
    },
  });
  assert.deepStrictEqual(picked, { bin: '7zz', kind: '7z' });
  assert.deepStrictEqual(seen, ['7z', '7za', '7zz']);
});

test('B27-F1 回归：继承键不再写穿兜底，pickExtractor 安全返回 null 而不是抛', () => {
  for (const key of ['constructor', 'valueOf', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.doesNotThrow(() => ge.pickExtractor(key, { has: () => false }), `${key} 不应抛`);
    assert.strictEqual(ge.pickExtractor(key, { has: () => true }), null, `${key} 应视作未登记`);
  }
});

test('B27-F1 回归：detectPackageManager 对畸形 platform 走 linux 兜底，绝不抛', () => {
  assert.doesNotThrow(() => ge.detectPackageManager({ platform: 'constructor', has: () => true }));
  assert.strictEqual(ge.detectPackageManager({ platform: 'constructor', has: () => true }), 'apt');
  assert.strictEqual(ge.detectPackageManager({ platform: 'nonesuch', has: () => true }), 'apt');
  assert.strictEqual(ge.detectPackageManager({ platform: 'nonesuch', has: () => false }), null);
});

test('detectPackageManager 按平台偏好序返回 PKG_INSTALL 的键', () => {
  assert.strictEqual(ge.detectPackageManager({ platform: 'windows', has: () => true }), 'winget');
  assert.strictEqual(ge.detectPackageManager({ platform: 'macos', has: () => true }), 'brew');
  assert.strictEqual(ge.detectPackageManager({ platform: 'linux', has: () => true }), 'apt');
  assert.strictEqual(ge.detectPackageManager({ platform: 'wsl', has: () => true }), 'apt');
  // 首选缺失时按序退让。
  assert.strictEqual(
    ge.detectPackageManager({ platform: 'linux', has: (b) => b === 'pacman' }),
    'pacman'
  );
  assert.strictEqual(
    ge.detectPackageManager({ platform: 'windows', has: (b) => b === 'choco' }),
    'choco'
  );
});

test('buildInstallCommand 命中时给出精确命令，manager 字段只在命令成形时非空', () => {
  const r = ge.buildInstallCommand('.7z', { platform: 'windows', has: () => true });
  assert.deepStrictEqual(
    r.command,
    'winget install --id 7zip.7zip -e --accept-package-agreements --accept-source-agreements'
  );
  assert.strictEqual(r.manager, 'winget');
  assert.strictEqual(r.pkgKey, '7z');
});

test('buildInstallCommand：该包在此管理器无名字时 command=null 且 manager 归 null，但 options 仍全量指路', () => {
  // .rar 推荐 unar，而 unar 在 winget/choco 名下是 null。
  const r = ge.buildInstallCommand('.rar', { platform: 'windows', has: () => true });
  assert.strictEqual(r.pkgKey, 'unar');
  assert.strictEqual(r.command, null);
  assert.strictEqual(r.manager, null);
  assert.deepStrictEqual(
    r.options.map((o) => o.split(' ')[0]),
    ['sudo', 'sudo', 'sudo', 'sudo', 'brew']
  );
  assert.strictEqual(r.options.length, 5);
});

test('buildInstallCommand 对未登记格式退回 7z 包，options 含全部 7 个管理器', () => {
  const r = ge.buildInstallCommand('.unknown-so-far', { platform: 'linux', has: () => false });
  assert.strictEqual(r.pkgKey, '7z');
  assert.strictEqual(r.command, null);
  assert.strictEqual(r.options.length, 7);
  assert.ok(r.options.some((o) => o.startsWith('choco')));
});

test('GENERIC_FORMATS / PKG_INSTALL / PM_CMD 三张表互相闭合：每个 pkgKey 都有名字与命令构造器', () => {
  const pkgKeys = new Set(Object.values(ge.GENERIC_FORMATS).map((v) => v.pkg));
  for (const k of pkgKeys) {
    assert.ok(ge.PKG_INSTALL[k], `PKG_INSTALL 缺 ${k}`);
    for (const [mgr, name] of Object.entries(ge.PKG_INSTALL[k])) {
      assert.strictEqual(typeof ge.PM_CMD[mgr], 'function', `PM_CMD 缺 ${mgr}`);
      if (name) {
        assert.ok(ge.PM_CMD[mgr](name).includes(name));
      }
    }
  }
  // 候选工具名必须能归一成四种驱动之一，否则 argv 构造会落空。
  const kinds = new Set();
  for (const spec of Object.values(ge.GENERIC_FORMATS)) {
    for (const bin of spec.tools) {
      kinds.add(bin.replace(/\.exe$/, ''));
    }
  }
  assert.deepStrictEqual([...kinds].sort(), ['7z', '7za', '7zz', 'bsdtar', 'unar', 'unrar']);
});

test('extractWith 对没有 argv 构造的驱动如实返回，不启动任何子进程', async () => {
  // 驱动种类只有 7z/bsdtar/unar/unrar 四种；其余（含未登记名）一律拒解并如实回报。
  for (const kind of ['bogus', 'lzma', '', undefined]) {
    const r = await ge.extractWith(kind, 'khy-b27-should-not-spawn', 'a.7z', 'out');
    assert.strictEqual(r.ok, false, `kind=${String(kind)} 应拒解`);
    assert.match(r.error, /不支持解包/);
  }
});

test('listWith 对 unar 无可解析列举模式（保守返回 null 驱动），失败形状与 extractWith 一致', async () => {
  const r = await ge.listWith('unar', 'unar', 'a.rar');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /无可解析的列举模式/);
});

test('listWith 在二进制不存在时 fail-closed：resolve 而非 reject，也不抛', async () => {
  const r = await ge.listWith('7z', 'khy-b27-definitely-not-installed', 'a.7z');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.error, 'string');
});
