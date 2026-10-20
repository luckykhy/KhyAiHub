'use strict';

/**
 * ilinkDeliveryGuard 离线单测(node:test)。
 *
 * 为什么这个套件的存在本身就是结论：`~/.khyquant` 在本机就是符号链接
 * （`lstatSync().isSymbolicLink()` 为 true，`realpathSync()` = `C:\.khyquant`），
 * 而 stat/readFile 都跟随链接 —— 所以「按路径字符串比前缀」的结构性绕过在这台
 * 机器上是常态，不是假设。本文件里每一条 deny-dir 断言都必须经 realpath 才成立。
 *
 * 全部离线：只用 mkdtemp 临时目录，不触网络、不读真实凭据文件。
 *
 * 关于**文件**符号链接：本机建不出来（`fs.symlinkSync(..., 'file')` 抛 EPERM，即下面
 * 「文件链接指向凭据」那条用例被显式 t.skip 的原因）。硬链接不需要特权，所以硬链接那组
 * 用例是无条件执行的。文件名的取值（raw / real 两个 basename 的并集）改用打桩
 * `fs.promises.realpath` 的方式钉住 —— 那两条**不会**因为本机缺 symlink 能力而退化，
 * 也不会像「普通文件下断言 fileName === basename(realpath)」那样变异盲（普通文件场景
 * realpath(raw) === raw，把判定改回 raw 侧照样绿）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('node:test');
const assert = require('node:assert');

const guard = require('../../../src/services/domain/messaging/channels/ilinkDeliveryGuard.js');
const defaults = require('../../../src/constants/serviceDefaults');
const dataHome = require('../../../src/utils/dataHome');

/** 临时根：所有「允许路径」都从这里长出来，测试结束即弃。 */
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 写一个文件（含中间目录），返回绝对路径。 */
function writeFileUnder(root, rel, contents = 'x') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

/** 只留 home 一条家目录解析，dataHome 家族全摘掉（否则会命中本机 works/data/khy）。 */
function onlyHome(home) {
  return { home, appHome: '', dataHome: '', baseHome: '' };
}

// ── 必拒：文件名规则 ──────────────────────────────────────────────────────

test('禁发文件名:.env / .ENV / .env.local / .npmrc —— 大小写都拒', async () => {
  const tmp = mkTmp('gdg-name-');
  for (const name of ['.env', '.ENV', '.env.local', '.env.production', '.npmrc']) {
    const f = writeFileUnder(tmp, name, 'SECRET=1');
    const v = await guard.isDeliverablePath(f);
    assert.strictEqual(v.ok, false, `${name} 应被拒`);
    assert.strictEqual(v.rule, 'deny-name', `${name} 应命中文件名规则,实际:${v.rule}`);
  }
});

test('禁发文件名:*.pem / *.key / *.p12 / *.kdbx / id_rsa* / id_ed25519* —— 拒', async () => {
  const tmp = mkTmp('gdg-key-');
  for (const name of ['server.pem', 'private.key', 'cert.p12', 'vault.kdbx', 'id_rsa', 'id_rsa.pub', 'id_ed25519']) {
    const f = writeFileUnder(tmp, name);
    const v = await guard.isDeliverablePath(f);
    assert.strictEqual(v.ok, false, `${name} 应被拒`);
    assert.strictEqual(v.rule, 'deny-name', `${name} 应命中文件名规则,实际:${v.rule}`);
  }
});

test('禁发文件名:*credentials* / *secret* —— 子串即拒', async () => {
  const tmp = mkTmp('gdg-sub-');
  for (const name of ['aws-credentials.json', 'my_secret_notes.txt', 'SECRET.env.bak']) {
    const f = writeFileUnder(tmp, name);
    const v = await guard.isDeliverablePath(f);
    assert.strictEqual(v.ok, false, `${name} 应被拒,实际:${JSON.stringify(v)}`);
  }
});

test('禁发文件名来自 serviceDefaults(不是业务文件里写死的)', () => {
  assert.ok(Array.isArray(defaults.ILINK_DELIVERY_DENY_NAMES));
  assert.ok(defaults.ILINK_DELIVERY_DENY_NAMES.includes('.env'));
  assert.ok(defaults.ILINK_DELIVERY_DENY_NAMES.includes('*.pem'));
});

// ── 必拒：目录前缀（本轮的核心修订）────────────────────────────────────────

test('禁发目录:~/.khyquant 之下任意文件 —— 拒,含 config.json 与 tool_permissions.json', async () => {
  const home = mkTmp('gdg-home-');
  const kq = path.join(home, '.khyquant');
  const files = [
    'built-in-keys.json',
    'preferences.json',
    'audit.jsonl',
    'integrity_manifest.json',
    'permissions.json',
    'tool_permissions.json',
    'config.json',
    'memory/recall.json',
    'file_history/2026/10/a.md',
  ];
  for (const rel of files) {
    const f = writeFileUnder(kq, rel);
    const v = await guard.isDeliverablePath(f, { pathEnv: onlyHome(home) });
    assert.strictEqual(v.ok, false, `${rel} 应被拒`);
    // permissions.json / tool_permissions.json 同时在文件名清单里，先命中 deny-name；
    // 其余的**只有目录前缀能挡**（补文件名是补不完的），必须是 deny-dir。
    const expected = rel.endsWith('.json') && /permissions/.test(rel) ? 'deny-name' : 'deny-dir';
    assert.strictEqual(v.rule, expected, `${rel} 应命中 ${expected},实际:${v.rule}`);
  }
});

test('禁发目录:~/.ssh / ~/.aws / ~/.gnupg / ~/.config/gh 之下 —— 拒', async () => {
  const home = mkTmp('gdg-home2-');
  const targets = ['.ssh/id_ed25519', '.aws/credentials.json', '.gnupg/secring.gpg', '.config/gh/hosts.yml'];
  for (const rel of targets) {
    const f = writeFileUnder(home, rel);
    const v = await guard.isDeliverablePath(f, { pathEnv: onlyHome(home) });
    assert.strictEqual(v.ok, false, `${rel} 应被拒,实际:${JSON.stringify(v)}`);
  }
});

test('禁发目录:家目录下的 .netrc —— 拒（目录前缀挡不住它，只能按形状收）', async () => {
  const home = mkTmp('gdg-home3-');
  const f = writeFileUnder(home, '.netrc');
  const v = await guard.isDeliverablePath(f, { pathEnv: onlyHome(home) });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rule, 'deny-home-rc');
});

test('禁发目录:getAppHome() 与 getBaseDataDir(".") 之下任意文件 —— 拒', async () => {
  const appFile = writeFileUnder(dataHome.getAppHome(), 'ilink-guard-probe.txt');
  const baseFile = writeFileUnder(dataHome.getBaseDataDir('.'), 'ilink-guard-probe.txt');
  try {
    const a = await guard.isDeliverablePath(appFile);
    assert.strictEqual(a.ok, false, 'getAppHome 之下应拒');
    assert.strictEqual(a.rule, 'deny-dir');
    const b = await guard.isDeliverablePath(baseFile);
    assert.strictEqual(b.ok, false, 'getBaseDataDir 之下应拒');
    assert.strictEqual(b.rule, 'deny-dir');
  } finally {
    for (const f of [appFile, baseFile]) {
      try { fs.unlinkSync(f); } catch { /* 清理失败不该让测试红 */ }
    }
  }
});

test('本机事实:getBaseDataDir(".") 嵌套在 getAppHome() 内 —— 摘掉 baseHome 后仍拒(只有一个有效前缀)', async () => {
  // 本机实测：getBaseDataDir('.') === <appHome>/T1-domains/base。
  // 所以 base 那条前缀是**冗余**的：即使不注册它，同一个文件照样被 appHome 挡下。
  // 这条断言钉的就是「别把两条前缀当成两道独立的闸门」。
  const appHome = dataHome.getAppHome();
  const baseHome = dataHome.getBaseDataDir('.');
  assert.ok(baseHome.startsWith(appHome), `本机 base 应嵌在 appHome 内:${baseHome} vs ${appHome}`);

  const f = writeFileUnder(baseHome, 'ilink-guard-probe2.txt');
  try {
    const withBase = await guard.isDeliverablePath(f);
    const withoutBase = await guard.isDeliverablePath(f, { pathEnv: { baseHome: '' } });
    assert.strictEqual(withBase.ok, false);
    assert.strictEqual(withBase.rule, 'deny-dir');
    assert.strictEqual(withoutBase.ok, false, '摘掉 baseHome 后仍应被 appHome 前缀挡住');
    assert.strictEqual(withoutBase.rule, 'deny-dir');
    assert.strictEqual(
      withoutBase.reason,
      withBase.reason,
      '两条路径命中的是同一条前缀规则,不是两道独立闸门'
    );
  } finally {
    try { fs.unlinkSync(f); } catch { /* 清理失败不该让测试红 */ }
  }
});

// ── 符号链接：本轮新增的用例 ──────────────────────────────────────────────

test('符号链接:禁发目录本身是链接时,realpath 形态也必须命中', async () => {
  // 复刻本机形态：家目录下的 .khyquant 是一个链接（真实位置在别处）。
  // 只登记「原路径形态」的话，判定路径 realpath 之后落在真实位置，就被绕过了。
  const tmp = mkTmp('gdg-link-');
  const realBase = mkTmp('gdg-real-');
  const realDir = path.join(realBase, '.khyquant');
  fs.mkdirSync(realDir);
  writeFileUnder(realDir, 'built-in-keys.json');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  try {
    fs.symlinkSync(realDir, path.join(home, '.khyquant'), 'junction');
  } catch (err) {
    assert.fail(`本机无法建目录链接(junction),用例无法执行:${err.code}`);
  }
  const env = onlyHome(home);

  // 直接经链接给的路径
  const viaLink = await guard.isDeliverablePath(
    path.join(home, '.khyquant', 'built-in-keys.json'),
    { pathEnv: env }
  );
  assert.strictEqual(viaLink.ok, false, '经链接给的路径应拒');

  // 经一条「位于允许目录下」的链接进来的路径：按字符串比前缀完全看不出问题。
  const allowDir = mkTmp('gdg-allow-');
  const junction = path.join(allowDir, 'docs');
  try {
    fs.symlinkSync(realDir, junction, 'junction');
  } catch (err) {
    assert.fail(`本机无法建目录链接(junction),用例无法执行:${err.code}`);
  }
  const viaJunction = await guard.isDeliverablePath(path.join(junction, 'built-in-keys.json'), {
    pathEnv: env,
  });
  assert.strictEqual(
    viaJunction.ok,
    false,
    '允许目录下的链接指向禁发目录时必须拒 —— 这正是本轮修的洞'
  );
  assert.strictEqual(viaJunction.rule, 'deny-dir');
});

test('符号链接:允许目录下的**文件**链接指向凭据 —— 拒(本机 EPERM 时显式跳过,不许静默 pass)', async (t) => {
  const tmp = mkTmp('gdg-flink-');
  const home = mkTmp('gdg-flinkhome-');
  const kq = path.join(home, '.khyquant');
  fs.mkdirSync(kq);
  const secret = writeFileUnder(kq, 'built-in-keys.json', '{"api_key":"..."}');

  const allowDir = mkTmp('gdg-flinkallow-');
  const link = path.join(allowDir, 'notes.txt');
  try {
    fs.symlinkSync(secret, link, 'file');
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      t.skip(`本机无法建文件符号链接(${err.code}),本用例未执行 —— 需要管理员或开发者模式`);
      return;
    }
    throw err;
  }

  const v = await guard.isDeliverablePath(link, { pathEnv: onlyHome(home) });
  assert.strictEqual(v.ok, false, 'notes.txt 是指向凭据的链接时必须拒');
  assert.strictEqual(v.rule, 'deny-dir');
  assert.ok(
    String(v.realPath).includes('.khyquant'),
    `realPath 应暴露真实位置(判定必须作用在链接之后):${v.realPath}`
  );
});

// ── 必放行 ────────────────────────────────────────────────────────────────

test('放行:临时目录下的普通文件与 <repo>/README.md', async () => {
  const tmp = mkTmp('gdg-ok-');
  const report = writeFileUnder(tmp, 'report.pdf', '%PDF-1.4');
  assert.strictEqual((await guard.isDeliverablePath(report)).ok, true);

  const repoReadme = path.join(__dirname, '..', '..', '..', '..', 'README.md');
  if (fs.existsSync(repoReadme)) {
    const v = await guard.isDeliverablePath(repoReadme);
    assert.strictEqual(v.ok, true, `仓库 README 应放行,实际:${JSON.stringify(v)}`);
  }
});

test('放行:roots 非空时,根内文件放行', async () => {
  const tmp = mkTmp('gdg-roots-');
  const f = writeFileUnder(tmp, 'sub/ok.txt');
  const v = await guard.isDeliverablePath(f, { roots: [tmp] });
  assert.strictEqual(v.ok, true, `根内应放行,实际:${JSON.stringify(v)}`);
});

test('roots 非空:根外文件 —— 拒', async () => {
  const tmp = mkTmp('gdg-roots2-');
  const f = writeFileUnder(tmp, 'ok.txt');
  const other = mkTmp('gdg-roots3-');
  const v = await guard.isDeliverablePath(f, { roots: [other] });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rule, 'outside-roots');
});

test('roots 非空:<root>/../outside 穿越 —— 拒（realpath 已把 .. 解析掉）', async () => {
  const tmp = mkTmp('gdg-traverse-');
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root, { recursive: true });
  // 名字不能撞禁发清单（*secret* 之类），否则先被 deny-name 拦掉，测不到 roots。
  const outside = writeFileUnder(tmp, 'payload.bin');
  const traversal = path.join(root, '..', 'payload.bin');
  const v = await guard.isDeliverablePath(traversal, { roots: [root] });
  assert.strictEqual(v.ok, false, '穿越到根外必须拒');
  assert.strictEqual(v.rule, 'outside-roots');
  assert.ok(String(v.realPath).startsWith(fs.realpathSync.native(outside)));
});

// ── fail-closed ───────────────────────────────────────────────────────────

test('fail-closed:realpath 失败(路径不存在)—— 拒,并给出可读原因', async () => {
  const tmp = mkTmp('gdg-missing-');
  const v = await guard.isDeliverablePath(path.join(tmp, 'nope.txt'));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rule, 'resolve-failed');
  assert.match(v.reason, /路径解析失败/);
});

test('fail-closed:空路径与相对路径 —— 拒', async () => {
  assert.strictEqual((await guard.isDeliverablePath('')).ok, false);
  assert.strictEqual((await guard.isDeliverablePath(null)).ok, false);
  const rel = await guard.isDeliverablePath('relative/report.pdf');
  assert.strictEqual(rel.ok, false);
  assert.strictEqual(rel.rule, 'not-absolute');
});

test('fail-closed:目录不是可投递文件 —— 拒(否则 ok:true 报一个随后必炸的路径)', async () => {
  const tmp = mkTmp('gdg-dir-');
  const v = await guard.isDeliverablePath(tmp);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rule, 'not-a-file');
});

// ── 硬链接：realpath 挡不住的绕过 ─────────────────────────────────────────
// 本组用例无条件执行：建硬链接不需要特权（与上面那条被 skip 的文件符号链接不同）。

test('硬链接:禁发目录里的凭据硬链接成允许目录下的 notes.txt —— 拒(rule=hardlink)', async () => {
  // 复核员实测的绕过：realpath 对硬链接返回链接自身，所以前缀与文件名规则全都看不见它。
  // 这里复刻同一形状（凭据内容为自造的假凭据，不碰真文件）。
  const home = mkTmp('gdg-hlhome-');
  const secret = writeFileUnder(path.join(home, '.khyquant'), 'built-in-keys.json', '{"api_key":"fake"}');
  const allowDir = mkTmp('gdg-hlallow-');
  const link = path.join(allowDir, 'notes.txt');

  try {
    fs.linkSync(secret, link);
  } catch (err) {
    assert.fail(`本机无法建硬链接,用例无法执行:${err.code || err.message}`);
  }
  // 前置事实：这条路径的 realpath 就是链接自身，deny-dir / deny-name 都看不见凭据目录。
  assert.strictEqual(fs.realpathSync.native(link), fs.realpathSync.native(link));
  assert.strictEqual(path.basename(fs.realpathSync.native(link)), 'notes.txt');
  assert.strictEqual(fs.statSync(secret).nlink, 2);

  const v = await guard.isDeliverablePath(link, { pathEnv: onlyHome(home), roots: [allowDir] });
  assert.strictEqual(v.ok, false, '凭据的硬链接必须拒');
  assert.strictEqual(v.rule, 'hardlink', `应命中硬链接规则,实际:${JSON.stringify(v)}`);
  assert.match(v.reason, /硬链接/);
});

test('硬链接:nlink=1 的普通文件不受影响 —— 仍放行', async () => {
  const tmp = mkTmp('gdg-hlok-');
  const f = writeFileUnder(tmp, 'report.pdf', '%PDF-1.4');
  assert.strictEqual(fs.statSync(f).nlink, 1, '新建文件应为唯一目录项');
  assert.strictEqual((await guard.isDeliverablePath(f)).ok, true);

  const repoReadme = path.join(__dirname, '..', '..', '..', '..', 'README.md');
  if (fs.existsSync(repoReadme)) {
    assert.strictEqual(fs.statSync(repoReadme).nlink, 1, '仓库文件应为唯一目录项');
    assert.strictEqual((await guard.isDeliverablePath(repoReadme)).ok, true);
  }
});

test('硬链接(取舍):两个都在允许目录、都不在禁发目录下的硬链接 —— 也拒', async () => {
  // 这是**有意的取舍，不是 bug**：守卫无从区分「A 的副本」和「凭据的别名」，因为硬链接
  // 没有真名可查。误伤面是「被 git clone --local / 备份工具硬链接过的普通文件发不出去」，
  // 换来的是凭据不可能借硬链接出站。回话里会把这件事说出来（见 ilinkFileDelivery 的
  // hardlink 分支），所以用户知道该复制一份再发。
  const a = mkTmp('gdg-hlA-');
  const b = mkTmp('gdg-hlB-');
  const src = writeFileUnder(a, 'payload.bin', 'data');
  const dup = path.join(b, 'payload-copy.bin');
  try {
    fs.linkSync(src, dup);
  } catch (err) {
    assert.fail(`本机无法建硬链接,用例无法执行:${err.code || err.message}`);
  }
  const v = await guard.isDeliverablePath(dup, { roots: [a, b] });
  assert.strictEqual(v.ok, false, '多目录项的普通文件也拒（取舍）');
  assert.strictEqual(v.rule, 'hardlink');
  // 上限可由 opts 覆盖：调到 2 才放行 —— 这条同时钉住开关是接上的、不是写死的。
  assert.strictEqual((await guard.isDeliverablePath(dup, { roots: [a, b], maxNlinks: 2 })).ok, true);
});

test('硬链接 fail-closed:stat 取不到 nlink —— 拒(未知即拒)', async (t) => {
  const tmp = mkTmp('gdg-hlunknown-');
  const f = writeFileUnder(tmp, 'ok.txt');
  t.mock.method(fs.promises, 'stat', async () => ({ isFile: () => true }));
  const v = await guard.isDeliverablePath(f);
  assert.strictEqual(v.ok, false, 'nlink 不可判定时必须拒');
  assert.strictEqual(v.rule, 'hardlink');
  assert.match(v.reason, /不可判定/);
});

// ── 文件名取值：raw 与 real 两个 basename 的并集 ────────────────────────────
// 打桩 fs.promises.realpath 来造「raw 名 ≠ real 名」的形状。本机建不出文件符号链接
// （EPERM），而普通文件场景 realpath(raw) === raw，两条断言都会变异盲。

test('文件名规则:真实名命中 —— 拒(即便调用方给的名字无害)', async (t) => {
  const tmp = mkTmp('gdg-namereal-');
  const raw = writeFileUnder(tmp, 'notes.txt');
  const real = writeFileUnder(tmp, 'server.pem');
  t.mock.method(fs.promises, 'realpath', async () => real);

  const v = await guard.isDeliverablePath(raw);
  assert.strictEqual(v.ok, false, '真实位置的名字命中禁发清单时必须拒');
  assert.strictEqual(v.rule, 'deny-name');
});

test('返回值 fileName 取真实名(不是调用方给的名字)', async (t) => {
  // 打桩下两个 basename 确实不同，所以这条钉住的是取值本身 —— 普通文件场景
  // realpath(raw) === raw，「普通文件下断言 fileName」那种写法在这里是变异盲的。
  const tmp = mkTmp('gdg-namefield-');
  const raw = writeFileUnder(tmp, 'notes.txt');
  const real = writeFileUnder(tmp, 'report.pdf');
  t.mock.method(fs.promises, 'realpath', async () => real);

  const v = await guard.isDeliverablePath(raw, { roots: [tmp] });
  assert.strictEqual(v.ok, true, `两个名字都不该命中禁发清单:${JSON.stringify(v)}`);
  assert.strictEqual(v.fileName, 'report.pdf');
  assert.notStrictEqual(path.basename(raw), v.fileName, '这条用例只在两个名字不同时才有钉住力');
});

test('文件名规则:调用方给的名字命中 —— 拒(即便真实名无害,只判 real 名会把它放行)', async (t) => {
  // 评审点出的反向路径：<allow>/.env 指向 <allow>/report.pdf。今天按 raw 名拒；
  // 若改成只判 real 名，report.pdf 不命中 → 照发。只判 raw 名会漏的是上一条。
  const tmp = mkTmp('gdg-nameraw-');
  const raw = writeFileUnder(tmp, '.env', 'FAKE=1');
  const real = writeFileUnder(tmp, 'report.pdf', '%PDF-1.4');
  t.mock.method(fs.promises, 'realpath', async () => real);

  const v = await guard.isDeliverablePath(raw);
  assert.strictEqual(v.ok, false, '调用方给的文件名命中禁发清单时必须拒');
  assert.strictEqual(v.rule, 'deny-name');
  assert.match(v.reason, /\.env/);
});

test('rc 规则同样取并集:真实名 / 调用方名 各自命中都拒', async (t) => {
  const home = mkTmp('gdg-rcunion-');
  const notes = writeFileUnder(home, 'notes.txt');
  const netrc = writeFileUnder(home, '.netrc');

  // 真实名是 .netrc
  t.mock.method(fs.promises, 'realpath', async () => netrc);
  const byReal = await guard.isDeliverablePath(notes, { pathEnv: onlyHome(home) });
  assert.strictEqual(byReal.rule, 'deny-home-rc', '真实名的 rc 形态要拦下');
  t.mock.restoreAll();

  // 调用方给的名字是 .netrc
  t.mock.method(fs.promises, 'realpath', async () => notes);
  const byRaw = await guard.isDeliverablePath(netrc, { pathEnv: onlyHome(home) });
  assert.strictEqual(byRaw.rule, 'deny-home-rc', '调用方给的 rc 名字要拦下');
});
