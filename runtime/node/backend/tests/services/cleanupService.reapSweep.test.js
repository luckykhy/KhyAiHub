'use strict';

/**
 * cleanupService.reapSweep.test.js — 原子写孤儿 tmp 与空目录回收的字节路径。
 *
 * 覆盖的真实缺口（2026-10-07 实测）：works/data/khy 顶层 95 个
 * `.name.tmp-<pid>-<hex>` 孤儿（kill -9 跳过 finally 清理）与 170 个空目录
 * （getProjectDataDir 式访问器在解析路径时就 mkdir）此前没有任何保留目标管辖。
 *
 * 跑法：node --test tests/services/cleanupService.reapSweep.test.js
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require cleanupService 之前钉住 data home（进程级先到先得缓存）。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-reap-sweep-'));
const PREV_ENV = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_EMPTY_DIR_REAP: process.env.KHY_EMPTY_DIR_REAP,
  KHY_EMPTY_DIR_MAX_AGE_D: process.env.KHY_EMPTY_DIR_MAX_AGE_D,
};
process.env.KHY_DATA_HOME = ROOT;
process.env.KHY_APP_HOME = ROOT;
process.env.KHY_EMPTY_DIR_MAX_AGE_D = '0';

const cleanupService = require('../../src/services/cleanupService');

const STALE_MS = 48 * 3600 * 1000; // 48h 前，超过 TEMP_MAX_AGE_HOURS(24h)
function backdate(p, ms = STALE_MS) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

before(() => {
  fs.mkdirSync(ROOT, { recursive: true });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('cleanAtomicTmpOrphans', () => {
  test('回收过期的 .name.tmp-<pid>-<hex> 孤儿', () => {
    const orphan = path.join(ROOT, '.settings.json.tmp-12345-abcdef012345');
    fs.writeFileSync(orphan, 'partial');
    backdate(orphan);
    const r = cleanupService.cleanAtomicTmpOrphans();
    assert.ok(r.removed >= 1);
    assert.ok(!fs.existsSync(orphan));
  });

  test('新鲜 tmp 不回收（不与进行中的原子写竞争）', () => {
    const fresh = path.join(ROOT, '.fresh.json.tmp-99999-0123456789ab');
    fs.writeFileSync(fresh, 'in-flight');
    cleanupService.cleanAtomicTmpOrphans();
    assert.ok(fs.existsSync(fresh));
    fs.unlinkSync(fresh);
  });

  test('指针风格的 .name.tmp-<pid>（无随机尾巴）同样回收', () => {
    const orphan = path.join(ROOT, '.location.json.tmp-4242');
    fs.writeFileSync(orphan, '{}');
    backdate(orphan);
    cleanupService.cleanAtomicTmpOrphans();
    assert.ok(!fs.existsSync(orphan));
  });

  test('普通文件与.tmp- 以外的前缀点文件不回收', () => {
    const keep1 = path.join(ROOT, 'settings.json');
    const keep2 = path.join(ROOT, '.env');
    fs.writeFileSync(keep1, '{}');
    fs.writeFileSync(keep2, 'KHY=1');
    backdate(keep1);
    backdate(keep2);
    cleanupService.cleanAtomicTmpOrphans();
    assert.ok(fs.existsSync(keep1) && fs.existsSync(keep2));
    fs.unlinkSync(keep1);
    fs.unlinkSync(keep2);
  });
});

describe('reapEmptyDirs', () => {
  test('回收超过年龄的空目录（深层先行，父目录连带回收）', () => {
    const parent = path.join(ROOT, 'reap-me');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    backdate(parent);
    backdate(child);
    const r = cleanupService.reapEmptyDirs();
    assert.ok(r.removed >= 2);
    assert.ok(!fs.existsSync(parent));
  });

  test('非空目录不动，豁免名单（credentials/audit-trajectory）空目录也不动', () => {
    const full = path.join(ROOT, 'keep-full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'data.json'), '{}');
    backdate(full);

    const cred = path.join(ROOT, 'credentials');
    fs.mkdirSync(cred);
    backdate(cred);

    const audit = path.join(ROOT, 'audit-trajectory');
    fs.mkdirSync(audit);
    backdate(audit);

    cleanupService.reapEmptyDirs();
    assert.ok(fs.existsSync(full) && fs.existsSync(path.join(full, 'data.json')));
    assert.ok(fs.existsSync(cred));
    assert.ok(fs.existsSync(audit));
    fs.rmSync(full, { recursive: true, force: true });
    fs.rmdirSync(cred);
    fs.rmdirSync(audit);
  });

  test('符号链接绝不跟随、绝不回收', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-reap-outside-'));
    const link = path.join(ROOT, 'linked');
    fs.symlinkSync(outside, link, 'junction');
    const r = cleanupService.reapEmptyDirs();
    assert.ok(fs.existsSync(link));
    assert.ok(fs.existsSync(outside));
    fs.rmSync(link);
    fs.rmSync(outside, { recursive: true, force: true });
    void r;
  });

  test('KHY_EMPTY_DIR_REAP=0 关闭整个回收', () => {
    const d = path.join(ROOT, 'gated-off');
    fs.mkdirSync(d);
    backdate(d);
    process.env.KHY_EMPTY_DIR_REAP = '0';
    try {
      const r = cleanupService.reapEmptyDirs();
      assert.equal(r.removed, 0);
      assert.ok(fs.existsSync(d));
    } finally {
      if (PREV_ENV.KHY_EMPTY_DIR_REAP === undefined) delete process.env.KHY_EMPTY_DIR_REAP;
      else process.env.KHY_EMPTY_DIR_REAP = PREV_ENV.KHY_EMPTY_DIR_REAP;
    }
    fs.rmdirSync(d);
  });

  test('数据家根目录本身绝不回收（即使空）', () => {
    // ROOT 里此刻可能恰好全空：reap 之后根必须还在。
    cleanupService.reapEmptyDirs();
    assert.ok(fs.existsSync(ROOT));
  });
});

describe('getStorageReport 含两个新目标', () => {
  test('atomicTmpOrphans / emptyDirs 有读数', () => {
    const report = cleanupService.getStorageReport();
    assert.ok(typeof report.atomicTmpOrphans.count === 'number');
    assert.ok(typeof report.emptyDirs.count === 'number');
  });
});
