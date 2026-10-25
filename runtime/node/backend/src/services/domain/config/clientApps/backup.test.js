'use strict';

/**
 * backup.js 契约测试 —— 双档备份原语（[DESIGN-ARCH-189] P3）。
 *
 * 钉住六件事：
 *   1. `.orig` **永不覆盖**：第二次备份必须一字不动第一次留下的原始态。
 *      这一条是整个回退链的锚，被破坏就等于没有备份。
 *   2. `.prev` **每次刷新**：反映最近一次写入前的状态。
 *   3. `backupKey` 非法即抛，不静默——坏 key 会让备份落到意外位置。
 *   4. 三个「目标不是常规文件」的形状全部**跳过并说明原因**，绝不 throw：
 *      不存在 / 是目录（coze）/ 空路径。
 *   5. 整笔回退：一组里第二个失败时，第一个已被改的文件要从 `.prev` 还原；
 *      且 `.orig` 不参与回退。
 *   6. `.prev` 写入是原子的（临时文件 + rename），不留半截备份。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  backupManagedFile,
  backupManagedSet,
  assertBackupKey,
  ORIG_SUFFIX,
  PREV_SUFFIX,
} = require('./backup');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clientapps-backup-${name}-`));
}

// --- 1. .orig 永不覆盖 -------------------------------------------------------
test('.orig is created once and never overwritten', () => {
  const dir = tmpdir('orig');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'V1');

  const r1 = backupManagedFile(file, 'claude-code-settings');
  assert.equal(r1.status, 'backed-up');
  assert.equal(r1.origCreated, true);
  assert.equal(fs.readFileSync(path.join(dir, 'claude-code-settings.orig'), 'utf8'), 'V1');

  // 用户改过一次，再备份
  fs.writeFileSync(file, 'V2');
  const r2 = backupManagedFile(file, 'claude-code-settings');
  assert.equal(r2.origCreated, false, '.orig 不得被第二次备份覆盖');
  assert.equal(fs.readFileSync(path.join(dir, 'claude-code-settings.orig'), 'utf8'), 'V1', '.orig 必须保持原始态');
  assert.equal(fs.readFileSync(path.join(dir, 'claude-code-settings.prev'), 'utf8'), 'V2', '.prev 应刷新为最近一次');
});

// --- 2. .prev 每次刷新 -------------------------------------------------------
test('.prev refreshes every call', () => {
  const dir = tmpdir('prev');
  const file = path.join(dir, 'config.toml');
  const key = 'codex-config';
  fs.writeFileSync(file, 'A');
  backupManagedFile(file, key);
  assert.equal(fs.readFileSync(path.join(dir, key + PREV_SUFFIX), 'utf8'), 'A');

  fs.writeFileSync(file, 'B');
  backupManagedFile(file, key);
  assert.equal(fs.readFileSync(path.join(dir, key + PREV_SUFFIX), 'utf8'), 'B');

  fs.writeFileSync(file, 'C');
  backupManagedFile(file, key);
  assert.equal(fs.readFileSync(path.join(dir, key + PREV_SUFFIX), 'utf8'), 'C');
});

// --- 3. backupKey 校验 -------------------------------------------------------
test('invalid backupKey throws (never silently accepted)', () => {
  const dir = tmpdir('key');
  const file = path.join(dir, 'f.json');
  fs.writeFileSync(file, 'x');
  for (const bad of ['', '   ', '../escape', 'a/b', 'a\\b', '.hidden', 'has space']) {
    assert.throws(() => backupManagedFile(file, bad), /CLIENT_APPS_BACKUP_INVALID|备份原语/, `应拒绝 ${JSON.stringify(bad)}`);
  }
  // 合法形态不抛
  assert.doesNotThrow(() => assertBackupKey('claude-code-settings'));
  assert.doesNotThrow(() => assertBackupKey('codex.auth.json'));
});

// --- 4. 三个非文件形状全部跳过 -------------------------------------------------
test('non-file targets are skipped with a reason, never thrown', () => {
  const dir = tmpdir('shapes');

  // 4a. 不存在（首次配置）
  const missing = path.join(dir, 'not-there.json');
  const rMiss = backupManagedFile(missing, 'k1');
  assert.equal(rMiss.status, 'nothing-to-back-up');
  assert.equal(rMiss.origCreated, false);

  // 4b. 是目录（coze 的 configPath 语义）
  const asDir = path.join(dir, 'model-templates');
  fs.mkdirSync(asDir);
  const rDir = backupManagedFile(asDir, 'k2');
  assert.equal(rDir.status, 'skipped');
  assert.match(rDir.reason, /目录/);

  // 4c. 空路径（COZE_HOME 未设时 configPath() 返回 ''）
  const rEmpty = backupManagedFile('', 'k3');
  assert.equal(rEmpty.status, 'skipped');
  assert.match(rEmpty.reason, /为空/);

  const rNull = backupManagedFile(null, 'k3');
  assert.equal(rNull.status, 'skipped');
});

// --- 5. 整笔回退 -------------------------------------------------------------
test('backupManagedSet rolls back already-backed-up files when a later one fails', () => {
  const dir = tmpdir('rollback');
  const f1 = path.join(dir, 'a.json');
  const f2 = path.join(dir, 'b.json');
  fs.writeFileSync(f1, 'A-original');
  fs.writeFileSync(f2, 'B-original');

  // 第一个合法，第二个用非法 key 触发失败
  const res = backupManagedSet([
    { file: f1, backupKey: 'good-key' },
    { file: f2, backupKey: '../bad' },
  ]);

  assert.equal(res.ok, false);
  assert.match(res.error, /备份原语/);
  // 第一个已被改的文件必须从 .prev 还原
  assert.deepEqual(res.restored, [f1]);
  assert.equal(fs.readFileSync(f1, 'utf8'), 'A-original', '失败后 f1 必须还原');
  // .orig 不得被回退触及——它保持原始态
  assert.equal(fs.readFileSync(path.join(dir, 'good-key.orig'), 'utf8'), 'A-original');
});

test('backupManagedSet succeeds for a clean multi-file set', () => {
  const dir = tmpdir('multi');
  const files = ['one.json', 'two.json'].map((n) => path.join(dir, n));
  files.forEach((f, i) => fs.writeFileSync(f, `content-${i}`));

  const res = backupManagedSet([
    { file: files[0], backupKey: 'app-one' },
    { file: files[1], backupKey: 'app-two' },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => r.status === 'backed-up'));
  assert.equal(res.restored.length, 0);
});

// --- 6. .prev 原子写 ---------------------------------------------------------
test('.prev is written atomically (no leftover tmp files)', () => {
  const dir = tmpdir('atomic');
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, 'data');
  backupManagedFile(file, 'atomic-key');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0, '不得留下临时文件');
});
