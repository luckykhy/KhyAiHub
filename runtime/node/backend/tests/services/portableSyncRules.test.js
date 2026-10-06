'use strict';

const fs = require('fs');
const path = require('path');

const {
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
  PROTECTED_TARGET_DIRS,
  DEP_LOCK_FILES,
  CRITICAL_ENTRY_FILES,
  MANIFEST_FILE,
} = require('../../src/services/portableSyncRules.js');

describe('portableSyncRules', () => {
  it('should export EXCLUDE_DIRS as array', () => {
    expect(Array.isArray(EXCLUDE_DIRS)).toBe(true);
    expect(EXCLUDE_DIRS.length).toBeGreaterThan(0);
    expect(EXCLUDE_DIRS).toContain('.git');
    expect(EXCLUDE_DIRS).toContain('node_modules');
    expect(EXCLUDE_DIRS).toContain('.khy');
  });

  it('should export EXCLUDE_FILES as array', () => {
    expect(Array.isArray(EXCLUDE_FILES)).toBe(true);
    expect(EXCLUDE_FILES).toContain('*.db');
    expect(EXCLUDE_FILES).toContain('_debug.log');
  });

  it('should export PROTECTED_TARGET_DIRS as array', () => {
    expect(Array.isArray(PROTECTED_TARGET_DIRS)).toBe(true);
    expect(PROTECTED_TARGET_DIRS).toContain('.khyquant-data');
    expect(PROTECTED_TARGET_DIRS).toContain('.env');
  });

  it('should export DEP_LOCK_FILES as array', () => {
    expect(Array.isArray(DEP_LOCK_FILES)).toBe(true);
    expect(DEP_LOCK_FILES).toContain('runtime/node/backend/package-lock.json');
  });

  it('should export CRITICAL_ENTRY_FILES as array', () => {
    expect(Array.isArray(CRITICAL_ENTRY_FILES)).toBe(true);
    expect(CRITICAL_ENTRY_FILES).toContain('runtime/node/backend/bin/khy.js');
    expect(CRITICAL_ENTRY_FILES).toContain('runtime/node/backend/src/cli/router.js');
  });

  // 这两张表是**仓根基准**被 portableSyncService.checkSourceHealth join 使用的：
  // 任何一条指空，源码健康门就永远报「文件不存在」而拒绝同步（层级迁移时正是这样坏的）。
  // 所以这里不钉字面量，钉存在性。
  it('DEP_LOCK_FILES 与 CRITICAL_ENTRY_FILES 每条都必须真实存在', () => {
    const ROOT = path.resolve(__dirname, '../../../../..');
    for (const rel of [...DEP_LOCK_FILES, ...CRITICAL_ENTRY_FILES]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  it('should export MANIFEST_FILE as string', () => {
    expect(MANIFEST_FILE).toBe('.sync-manifest.json');
  });
});

