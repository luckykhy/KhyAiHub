'use strict';

// Colocated tests for DataLocation.js (user-data path resolution + transparent migration).
// os.homedir is stubbed via require.cache BEFORE the target require so all reads/writes
// land inside os.tmpdir(); nothing outside tmpdir is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const osReal = require('os');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dataloc-'));

// Builtins resolve to their bare name; Module._load consults require.cache first.
const osKey = require.resolve('os');
require.cache[osKey] = {
  id: 'os',
  filename: 'osKey',
  loaded: true,
  exports: Object.assign({}, osReal, { homedir: () => FAKE_HOME }),
};

const svc = require('./DataLocation');

test.after(() => {
  delete require.cache[osKey];
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

test('getKhyHome / getKhyquantHome 指向桩定的 home', () => {
  assert.equal(svc.getKhyHome(), path.join(FAKE_HOME, '.khy'));
  assert.equal(svc.getKhyquantHome(), path.join(FAKE_HOME, '.khyquant'));
});

test('hasLegacyData：无目录/仅点文件 → false，含真实文件 → true', () => {
  const legacy = svc.getKhyquantHome();
  assert.equal(svc.hasLegacyData(), false); // 目录不存在

  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, '.gitignore'), '');
  assert.equal(svc.hasLegacyData(), false); // 仅一个点开头占位

  fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  assert.equal(svc.hasLegacyData(), true);

  for (const f of fs.readdirSync(legacy)) fs.rmSync(path.join(legacy, f));
  fs.writeFileSync(path.join(legacy, '.a'), '');
  fs.writeFileSync(path.join(legacy, '.b'), '');
  // KNOWN-DEFECT: files.length>1 分支不过滤点开头文件，两个点占位被误判为有真实数据（低危：
  // 只影响 hasLegacyData/getStorageStatus 的提示语义，不会触发迁移——迁移看具体 dataType 是否存在）。
  assert.equal(svc.hasLegacyData(), true);
});

test('KNOWN-DEFECT: 首次单文件迁移在 ~/.khy 尚不存在时必失败（copyFileSync 不建父目录）', () => {
  // 复现场景：全新机器只有 ~/.khyquant 有数据、~/.khy 还没被任何东西建出来——这正是
  // 「运行时按需透明迁移、老用户零感知」的主场景。migrateIfNeeded(DataLocation.js:103)
  // 直接 copyFileSync，目标父目录缺失 → ENOENT → catch 后返 false，迁移静默不发生；
  // 而 getUserDataPath 随后仍返回 ~/.khy 下的目标路径（不存在）→ 用户看到「数据丢了」。
  // （目录版走 cpSync recursive 会自建父目录，不受影响——见上一用例。）
  fs.rmSync(svc.getKhyHome(), { recursive: true, force: true });
  fs.rmSync(svc.getKhyquantHome(), { recursive: true, force: true });
  fs.mkdirSync(svc.getKhyquantHome(), { recursive: true });
  fs.writeFileSync(path.join(svc.getKhyquantHome(), 'fresh.json'), '{"first":1}');
  assert.equal(fs.existsSync(svc.getKhyHome()), false); // ~/.khy 确实不存在
  assert.equal(svc.migrateIfNeeded('fresh.json'), false); // 高危：迁移失败
  assert.equal(fs.existsSync(path.join(svc.getKhyHome(), 'fresh.json')), false);
});

test('migrateIfNeeded：目标缺、遗留有 → 复制并返 true；二次调用返 false', () => {
  const legacy = svc.getKhyquantHome();
  // 规避上一用例钉住的缺陷：先把 ~/.khy 建出来（有 .khy 的存量机器的真实路径）
  fs.mkdirSync(svc.getKhyHome(), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), '{"v":1}');
  const target = path.join(svc.getKhyHome(), 'config.json');
  assert.equal(fs.existsSync(target), false);

  assert.equal(svc.migrateIfNeeded('config.json'), true);
  assert.equal(fs.readFileSync(target, 'utf-8'), '{"v":1}');
  assert.equal(svc.migrateIfNeeded('config.json'), false); // 目标已存在

  assert.equal(svc.migrateIfNeeded('never-exists.bin'), false); // 两边都无
});

test('migrateIfNeeded 支持目录级迁移', () => {
  const legacy = svc.getKhyquantHome();
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'skills', 'a.md'), 'A');
  assert.equal(svc.migrateIfNeeded('skills'), true);
  assert.equal(fs.readFileSync(path.join(svc.getKhyHome(), 'skills', 'a.md'), 'utf-8'), 'A');
});

test('getUserDataPath：迁移完成标记 → 直接标准位；标准位存在 → 直接用', () => {
  const target = path.join(svc.getKhyHome(), 'exists.json');
  fs.writeFileSync(target, '{}');
  assert.equal(svc.getUserDataPath('exists.json'), target);

  // 已有目标时打迁移完成标记
  svc.markMigrationComplete();
  assert.equal(svc.isMigrationComplete(), true);
  assert.equal(svc.getUserDataPath('whatever.bin'), path.join(svc.getKhyHome(), 'whatever.bin'));
});

test('getUserDataPath：目标缺但遗留有 → 透明迁移后仍返回标准位', () => {
  // 先清迁移标记，回到「未迁移」态；.khy 由上一用例建出（规避单文件迁移缺陷）
  fs.rmSync(path.join(svc.getKhyHome(), '.migration-complete'), { force: true });
  assert.equal(svc.isMigrationComplete(), false);

  const legacyFile = path.join(svc.getKhyquantHome(), 'credentials.json');
  fs.writeFileSync(legacyFile, '{"k":1}');
  const target = path.join(svc.getKhyHome(), 'credentials.json');
  assert.equal(fs.existsSync(target), false);

  assert.equal(svc.getUserDataPath('credentials.json'), target);
  assert.equal(fs.existsSync(target), true); // 已复制
  assert.equal(svc.isMigrationComplete(), false); // 迁移文件不自动写（显式 mark 才写）
});

test('getUserDataPath 垃圾入参：null/非字符串抛 TypeError（path.join 契约）', () => {
  assert.throws(() => svc.getUserDataPath(null));
  assert.throws(() => svc.getUserDataPath({}));
});

test('getUserDataDir 建目录并返回绝对路径', () => {
  const dir = svc.getUserDataDir('a', 'b');
  assert.equal(dir, path.join(svc.getKhyHome(), 'a', 'b'));
  assert.ok(fs.statSync(dir).isDirectory());
});

test('getStorageStatus 四象限组合与建议文案', () => {
  // 现场状态：.khy 存在（前面用例建过）且迁移标记被清
  const st1 = svc.getStorageStatus();
  assert.equal(st1.standard.exists, true);
  assert.equal(st1.legacy.exists, true);
  assert.equal(typeof st1.healthy, 'boolean');
  assert.equal(typeof st1.recommendation, 'string');

  // 两边都删 → 未初始化
  fs.rmSync(svc.getKhyHome(), { recursive: true, force: true });
  fs.rmSync(svc.getKhyquantHome(), { recursive: true, force: true });
  const st2 = svc.getStorageStatus();
  assert.equal(st2.standard.exists, false);
  assert.equal(st2.legacy.exists, false);
  assert.equal(st2.healthy, false);
  assert.ok(st2.recommendation.includes('尚未初始化'));

  // 仅遗留存在且未迁移 → 提示遗留
  fs.mkdirSync(svc.getKhyquantHome(), { recursive: true });
  const st3 = svc.getStorageStatus();
  assert.equal(st3.healthy, false);
  assert.ok(st3.recommendation.includes('遗留'), st3.recommendation);

  // 标准存在 + 迁移完成 → 健康
  svc.markMigrationComplete();
  const st4 = svc.getStorageStatus();
  assert.equal(st4.healthy, true);
  assert.ok(st4.recommendation.includes('已统一'));
});
