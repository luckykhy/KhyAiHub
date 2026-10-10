'use strict';

// Co-located contract tests for qcEngine.js (trajectory package QC).
// child_process is stubbed through require.cache (the module imports spawnSync but must
// never spawn anything), and every package tree is built inside os.tmpdir().

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CP_ID = require.resolve('child_process');
const spawnCalls = [];
const prevCp = require.cache[CP_ID];
require.cache[CP_ID] = {
  id: CP_ID,
  filename: CP_ID,
  loaded: true,
  exports: {
    ...require('child_process'),
    spawnSync: (...a) => { spawnCalls.push(a); return { status: 0, stdout: '', stderr: '' }; },
  },
  children: [],
  paths: [],
};

const { runQC } = require('./qcEngine');

after(() => {
  if (prevCp) require.cache[CP_ID] = prevCp; else delete require.cache[CP_ID];
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const tmpDirs = [];
function mkPkg(fill = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-qc-'));
  tmpDirs.push(dir);
  const put = (rel, content) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  for (const sub of ['task', 'trajectory', 'screenshots', 'workspace/src', 'workspace/dist', 'env', 'qc']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  put('task/prompt.md', '做一个 3D 落地页，含 WebGL 场景与交互。');
  put('workspace/dist/index.html', '<html></html>');
  if (fill.selfCheck !== false) {
    put('qc/self_check.md', fill.selfCheck || '轨迹完整\n产物可运行\n依赖锁定\n截图齐全\n自检完成\n');
  }
  if (fill.manifest) put('manifest.json', JSON.stringify(fill.manifest));
  if (fill.assets) {
    put('task/assets/a.png', 'x');
    put('task/assets/b.jpg', 'yy');
  }
  if (fill.assetLicense) put('task/assets_license.md', 'CC0');
  if (fill.acceptanceCriteria) put('task/acceptance_criteria.json', '{}');
  if (fill.bare) {
    fs.rmSync(path.join(dir, 'task', 'prompt.md'), { force: true });
    fs.rmSync(path.join(dir, 'workspace', 'dist', 'index.html'), { force: true });
  }
  return dir;
}

const GOOD_MANIFEST = {
  package: {
    apiCallCount: 4,
    screenshots: 5,
    workspaceDistFiles: 2,
    hasLockfile: true,
    hasEnvSnapshot: true,
    hasBuildMd: true,
  },
};

test('完整且达标的包：passed/verdict/score 三项与零 defect', () => {
  const dir = mkPkg({ acceptanceCriteria: true });
  const r = runQC(dir, { level: 'L2' }, GOOD_MANIFEST);
  assert.deepEqual(r.defects, []);
  assert.equal(r.passed, true);
  assert.equal(r.score, 1);
  assert.equal(r.verdict, 'pass');
});

test('空包（无自检、无 manifest、dist 被清）→ 10 条缺陷、score 触底 0、verdict fail', () => {
  const dir = mkPkg({ selfCheck: false, bare: true });
  const r = runQC(dir, { level: 'L1' }, undefined);
  assert.deepEqual(
    r.defects.map((d) => `${d.key}:${d.severity}`),
    [
      'self_check:major',
      'structure:critical',
      'structure:critical',
      'no_api_calls:critical',
      'no_screenshots:major',
      'no_dist:critical',
      'no_lockfile:major',
      'no_env_snapshot:minor',
      'no_build_md:minor',
      'no_acceptance_criteria:minor',
    ],
  );
  assert.match(
    r.defects.filter((d) => d.key === 'structure').map((d) => d.description).join('|'),
    /Missing required path: task\/prompt\.md\|workspace\/dist\/ is empty/,
  );
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.equal(r.verdict, 'fail');
});

test('prompt.md 短于 10 字节 / dist 空目录各出一条结构 critical', () => {
  const dir = mkPkg();
  fs.writeFileSync(path.join(dir, 'task', 'prompt.md'), 'tiny');
  const r = runQC(dir, { level: 'L1' }, GOOD_MANIFEST);
  const descs = r.defects.filter((d) => d.key === 'structure').map((d) => d.description);
  assert.ok(descs.includes('prompt.md is empty or too small'));
  assert.ok(!descs.some((s) => /dist\/ is empty/.test(s)));

  const dir2 = mkPkg();
  fs.rmSync(path.join(dir2, 'workspace', 'dist', 'index.html'));
  const r2 = runQC(dir2, { level: 'L1' }, GOOD_MANIFEST);
  assert.ok(
    r2.defects.some((d) => d.description === 'workspace/dist/ is empty — no built output'),
  );
});

test('自检清单只满足 4/5 条正则即判 major', () => {
  const dir = mkPkg({ selfCheck: '轨迹完整\n产物可运行\n依赖锁定\n截图齐全\n' });
  const r = runQC(dir, { level: 'L1' }, GOOD_MANIFEST);
  assert.equal(r.defects.filter((d) => d.key === 'self_check').length, 1);
  assert.equal(r.defects.find((d) => d.key === 'self_check').severity, 'major');
});

test('内容缺项按 critical/major/minor 三档分别记分（实测 0.4）', () => {
  const dir = mkPkg();
  const r = runQC(dir, { level: 'L1' }, { package: { apiCallCount: 2, hasLockfile: true } });
  assert.deepEqual(
    r.defects.map((d) => `${d.key}:${d.severity}`),
    [
      'no_screenshots:major',
      'no_dist:critical',
      'no_env_snapshot:minor',
      'no_build_md:minor',
      'no_acceptance_criteria:minor',
    ],
  );
  // -0.15 -0.3 -0.05*3 = 0.4（qc/self_check.md 在 mkPkg 里已写全，故无 self_check 项）
  assert.equal(r.score, 0.4);
  assert.equal(r.passed, false);
});

test('passed:true 也可能 verdict:needs_rework（0.7 落在此档）', () => {
  const dir = mkPkg();
  const r = runQC(dir, { level: 'L1' }, {
    package: {
      apiCallCount: 3, screenshots: 0, workspaceDistFiles: 1, hasLockfile: true,
      hasEnvSnapshot: false, hasBuildMd: false,
    },
  });
  assert.equal(r.score, 0.7);
  assert.equal(r.passed, true);
  assert.equal(r.verdict, 'needs_rework');
  // index.js:131 只读 passed 位，needs_rework 与 pass 在库里同为 'reviewing'。
});

test('passed 由两道独立闸门决定：有 critical 时 0.65 也不过，无 critical 时 0.4 也不过', () => {
  const dir = mkPkg();
  // 只留一条 content critical（manifest 说 dist 为 0，但磁盘上 dist 有文件 → 结构检查不报）
  const withCritical = runQC(dir, { level: 'L1' }, {
    package: {
      apiCallCount: 1, screenshots: 1, workspaceDistFiles: 0, hasLockfile: true,
      hasEnvSnapshot: true, hasBuildMd: true,
    },
  });
  assert.equal(withCritical.score, 0.65);
  assert.equal(withCritical.passed, false);
  assert.ok(withCritical.defects.every((d) => d.key !== 'structure'));

  // 全 major/minor、零 critical，但分数跌破 0.6 → 仍然不过
  const dir2 = mkPkg({ assets: true });
  const lowScore = runQC(dir2, { level: 'L1' }, {
    package: {
      apiCallCount: 1, workspaceDistFiles: 1, hasLockfile: false, hasEnvSnapshot: false,
      hasBuildMd: false,
    },
  });
  assert.equal(lowScore.defects.filter((d) => d.severity === 'critical').length, 0);
  assert.equal(lowScore.score, 0.4);
  assert.equal(lowScore.passed, false);
});

test('KNOWN-DEFECT: 负数计数通过真值门，「有 API 调用」被 -1 假满足', () => {
  const dir = mkPkg();
  const r = runQC(dir, { level: 'L1' }, {
    package: {
      apiCallCount: -1, screenshots: -3, workspaceDistFiles: -2, hasLockfile: true,
      hasEnvSnapshot: true, hasBuildMd: true,
    },
  });
  // qcEngine.js:136-158 用 `!pkg.x || pkg.x === 0` 判定「没有」：-1 既真又非 0，
  // 于是空包被判成内容齐全（no_api_calls / no_screenshots / no_dist 全部缺席）。
  const keys = r.defects.map((d) => d.key);
  assert.ok(!keys.includes('no_api_calls'));
  assert.ok(!keys.includes('no_screenshots'));
  assert.ok(!keys.includes('no_dist'));
  assert.equal(r.passed, true);
});

test('KNOWN-DEFECT: 缺陷多到跌破 0 时 Math.max 把 score 钉成 0，包与包之间失去区分度', () => {
  const dir = mkPkg({ selfCheck: false });
  const r = runQC(dir, { level: 'L1' }, { package: {} });
  const raw = r.defects.reduce(
    (s, d) => s - (d.severity === 'critical' ? 0.3 : d.severity === 'major' ? 0.15 : 0.05),
    1,
  );
  assert.ok(raw < 0, `未截断的分应为负，实测 ${raw}`);
  assert.equal(r.score, 0);
  // qcEngine.js:64 截断后，index.js:135 写进库的 qc_score 无法区分「4 条 critical」与
  // 「20 条 critical」，返工统计与看板排序都被抹平成同一个 0。
});

test('资源授权：有 assets 无 license 出一条 major；无 assets 目录则完全跳过', () => {
  const dir = mkPkg({ assets: true });
  const r = runQC(dir, { level: 'L1' }, GOOD_MANIFEST);
  const lic = r.defects.find((d) => d.key === 'no_asset_license');
  assert.equal(lic.severity, 'major');
  assert.match(lic.description, /存在 2 个资源文件但缺少授权说明/);

  const dir2 = mkPkg({ assets: true, assetLicense: true });
  assert.equal(runQC(dir2, { level: 'L1' }, GOOD_MANIFEST).defects.find((d) => d.key === 'no_asset_license'), undefined);

  const dir3 = mkPkg();
  fs.mkdirSync(path.join(dir3, 'task', 'assets'));
  fs.writeFileSync(path.join(dir3, 'task', 'assets', 'README.txt'), 'no binary');
  assert.equal(runQC(dir3, { level: 'L1' }, GOOD_MANIFEST).defects.find((d) => d.key === 'no_asset_license'), undefined);
});

test('L3 需要 acceptance_criteria.json，缺则 minor', () => {
  const dir = mkPkg({ manifest: GOOD_MANIFEST });
  const r = runQC(dir, { level: 'L3' }, GOOD_MANIFEST);
  assert.ok(r.defects.some((d) => d.key === 'no_acceptance_criteria' && d.severity === 'minor'));
});

test('KNOWN-DEFECT: L3 截图检查读的是磁盘 manifest.json，不读传入的 manifest 参数；文件缺失时静默跳过', () => {
  const dir = mkPkg(); // 不写 manifest.json
  const r = runQC(dir, { level: 'L3' }, {
    package: { ...GOOD_MANIFEST.package, screenshots: 0 },
  });
  // qcEngine.js:245-246 走 _readManifest(pkgDir)（文件不存在 → null），
  // 于是 `manifest?.package?.screenshots < 3` 变成 `undefined < 3` === false，
  // L3 截图不足的 major 永远不会报出——传进来的 manifest 参数被完全忽略。
  assert.equal(r.defects.find((d) => d.key === 'l3_screenshots'), undefined);

  const dir2 = mkPkg({ manifest: { package: { screenshots: 1 } } });
  const r2 = runQC(dir2, { level: 'L3' }, { package: { ...GOOD_MANIFEST.package, screenshots: 1 } });
  assert.ok(r2.defects.some((d) => d.key === 'l3_screenshots'));
});

test('垃圾入参不抛：目录不存在 / task=null / manifest 是非对象', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-qc-empty-')), 'nope');
  tmpDirs.push(path.dirname(missing));
  const r = runQC(missing, null, null);
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.ok(r.defects.length >= 8);

  const dir = mkPkg();
  const r2 = runQC(dir, undefined, 'not-an-object');
  assert.equal(r2.defects.filter((d) => d.key === 'no_api_calls').length, 1);
  const r3 = runQC(dir, { level: 'L9' }, GOOD_MANIFEST);
  assert.equal(r3.passed, true); // 未知等级按 L1 之外的通用检查放行
});

test('runQC 全程不 spawn 任何子进程（child_process 只被 import，不被使用）', () => {
  const dir = mkPkg({ acceptanceCriteria: true });
  runQC(dir, { level: 'L3' }, GOOD_MANIFEST);
  assert.deepEqual(spawnCalls, []);
});
