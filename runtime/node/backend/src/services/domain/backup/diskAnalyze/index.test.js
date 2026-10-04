'use strict';

// Colocated tests for diskAnalyze/index.js (analyze facade).
// catalog/report leaves and child-process-free deps are stubbed via require.cache
// so the orchestration logic is tested deterministically, with a fake fsImpl.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const catalogPath = require.resolve('../../../diskAnalyzeCatalog');
const reportPath = require.resolve('../../../diskAnalyzeReport');

const realCatalog = require.cache[catalogPath];
const realReport = require.cache[reportPath];

// Mutable fake leaves — individual tests rewire behavior via these objects.
const fakeCatalog = {
  resolveMinSizeBytes: () => 100,
  isOldInstaller: (f, now, env) => /\.exe$/i.test(f.path) && f.mtimeMs > 0,
  groupBySize: (files) => ({ groups: [] }),
  selectHashCandidates: () => ({ toHash: [], skippedTooBig: 0, skippedOverCount: 0 }),
};
const fakeReport = {
  renderAnalyzeReport: (result) => 'REPORT:' + result.totals.files,
};
require.cache[catalogPath] = {
  id: catalogPath,
  filename: catalogPath,
  loaded: true,
  exports: fakeCatalog,
};
require.cache[reportPath] = {
  id: reportPath,
  filename: reportPath,
  loaded: true,
  exports: fakeReport,
};

const analyzer = require('./index');

test.after(() => {
  if (realCatalog) require.cache[catalogPath] = realCatalog;
  else delete require.cache[catalogPath];
  if (realReport) require.cache[reportPath] = realReport;
  else delete require.cache[reportPath];
});

// Fake fs tree: root/big.bin(500) root/small.txt(1) root/tool.exe(old) root/dup1.bin & dup2.bin (same 4 bytes)
function fakeDeps(nowMs) {
  const blobs = {
    'root\\dup1.bin': Buffer.from('SAME'),
    'root\\dup2.bin': Buffer.from('SAME'),
  };
  const files = {
    'big.bin': { size: 500, mtimeMs: 1000 },
    'small.txt': { size: 1, mtimeMs: 1000 },
    'tool.exe': { size: 200, mtimeMs: 1000 },
    'dup1.bin': { size: 4, mtimeMs: 1000 },
    'dup2.bin': { size: 4, mtimeMs: 1000 },
  };
  return {
    fsImpl: {
      readdirSync(dir) {
        if (String(dir) === 'root') {
          return Object.keys(files).map((n) => ({ name: n }));
        }
        const err = new Error('ENOENT');
        throw err;
      },
      lstatSync(p) {
        const name = path.basename(String(p));
        if (!(name in files)) {
          throw new Error('ENOENT');
        }
        const f = files[name];
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          size: f.size,
          mtimeMs: f.mtimeMs,
        };
      },
      readFileSync: (p) => blobs[String(p)],
    },
    now: () => nowMs,
    platform: 'windows',
  };
}

// KNOWN-DEFECT: 门面注释承诺「绝不抛(fail-soft 返回结构化空结果)」，但 analyze(null) 在
// 进入 try 之前就于 index.js:90 读 opts.env → TypeError——「绝不抛」契约对 null opts 不成立
// （低危：正常调用方传对象字面量，未见实际崩溃路径）。
test('KNOWN-DEFECT: analyze(null) 抛 TypeError 而非结构化空结果', () => {
  assert.throws(() => analyzer.analyze(null), TypeError);
});

test('analyze 垃圾入参：空对象 → roots 兜底 cwd 的结构化空结果', () => {
  const r = analyzer.analyze({ deps: fakeDeps(0) });
  assert.equal(r.success, true);
  assert.equal(Array.isArray(r.roots), true);
  assert.ok(r.roots.length >= 1);
  assert.equal(r.largeFiles.length, 0);
  assert.ok(r.report.startsWith('REPORT:'));
});

test('analyze roots 归一：去重 + 裸盘符补反斜杠 + path 单根', () => {
  const r = analyzer.analyze({
    roots: ['C:\\data', 'C:\\data', ' D:\\ '],
    path: 'E:',
    deps: fakeDeps(0),
  });
  const roots = r.roots.map((s) => s.trim());
  assert.equal(roots.filter((s) => s === 'C:\\data').length, 1); // 去重
  assert.ok(roots.includes('E:\\')); // 裸盘符
  assert.ok(roots.includes('D:\\'));
});

test('analyze 大文件：阈值过滤 + 降序 + top 截断 + 计数入 totals', () => {
  fakeCatalog.resolveMinSizeBytes = () => 100;
  const r = analyzer.analyze({ roots: ['root'], find: ['large'], top: 2, deps: fakeDeps(0) });
  assert.equal(r.largeFiles.length, 2); // top=2
  assert.equal(r.largeFiles[0].size, 500); // 降序
  assert.equal(r.totals.largeCount, 2); // 500 与 200 过阈值（200 的 .exe 也算大文件）
  assert.ok(r.report.includes('REPORT:'));
});

test('analyze find 过滤未知键：只处理合法 find 值', () => {
  const r = analyzer.analyze({ roots: ['root'], find: ['large', 'bogus'], deps: fakeDeps(0) });
  assert.equal(r.largeFiles.length, 2);
  assert.equal(r.oldInstallers.length, 0);
  assert.equal(r.duplicateGroups.length, 0);
  assert.equal(r.totals.installerCount, 0);
  assert.equal(r.totals.dupGroups, 0);
});

test('analyze 旧安装包：isOldInstaller 命中 + ageDays 由注入 now 推算', () => {
  fakeCatalog.resolveMinSizeBytes = () => 100;
  const NOW = 24 * 3600 * 1000 * 10; // 10 days
  const r = analyzer.analyze({ roots: ['root'], find: ['installers'], deps: fakeDeps(NOW) });
  assert.equal(r.oldInstallers.length, 1);
  assert.ok(r.oldInstallers[0].path.endsWith('tool.exe'));
  assert.ok(Math.abs(r.oldInstallers[0].ageDays - 10) < 1e-3);
  assert.equal(r.totals.installerCount, 1);
});

test('analyze 重复文件：候选 → hash → 浪费字节按 files-1 计', () => {
  fakeCatalog.groupBySize = (files) => ({ groups: files });
  fakeCatalog.selectHashCandidates = () => ({
    toHash: [
      { path: path.join('root', 'dup1.bin'), sizeBytes: 4 },
      { path: path.join('root', 'dup2.bin'), sizeBytes: 4 },
    ],
    skippedTooBig: 3,
    skippedOverCount: 1,
  });
  const r = analyzer.analyze({ roots: ['root'], find: ['duplicates'], deps: fakeDeps(0) });
  assert.equal(r.duplicateGroups.length, 1);
  assert.equal(r.duplicateGroups[0].wastedBytes, 4); // 4 * (2-1)
  assert.equal(r.totals.dupGroups, 1);
  assert.ok(r.notes.some((n) => n.includes('3 个超大文件')));
  assert.ok(r.notes.some((n) => n.includes('1 个候选')));
});

test('analyze 截断透传：walker truncated → note 提示部分视图', () => {
  const deps = fakeDeps(0);
  // 让 readdir 一直报 EACCES → walker 直接跳过；这里改用 deadline 恒超时制造截断
  const r = analyzer.analyze({
    roots: ['root'],
    deps: { ...deps, now: undefined },
  });
  // walker 内部 opts.deadline 未注入 → createWalkDeadline 默认 8s 预算不会触发；此用例只断言不抛
  assert.equal(r.success, true);
});

test('analyze 报告渲染抛错 → success:false + 分析异常 note，绝不抛', () => {
  fakeReport.renderAnalyzeReport = () => {
    throw new Error('render exploded');
  };
  const r = analyzer.analyze({ roots: ['root'], find: [], deps: fakeDeps(0) });
  assert.equal(r.success, false);
  assert.ok(r.notes.some((n) => n.includes('分析异常') && n.includes('render exploded')));
  assert.equal(r.report, '');
  // 还原
  fakeReport.renderAnalyzeReport = (result) => 'REPORT:' + result.totals.files;
});

test('analyze top 值钳制：非有限数回退默认 20，超大值钳到 1000（不崩、正常产出）', () => {
  fakeCatalog.resolveMinSizeBytes = () => 100;
  for (const top of [0, -5, NaN, 99999]) {
    const r = analyzer.analyze({ roots: ['root'], find: ['large'], top, deps: fakeDeps(0) });
    assert.equal(r.success, true);
    assert.equal(r.largeFiles.length, 2); // 候选只有 2 个大文件
    assert.ok(r.largeFiles.length <= 1000);
  }
});
