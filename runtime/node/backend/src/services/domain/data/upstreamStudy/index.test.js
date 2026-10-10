'use strict';

// Colocated tests for upstreamStudy/index.js (archive-study facade).
// Pure decision leaves (catalog/plan/report) are stubbed via require.cache;
// inspect comes through deps injection; baseline walking uses real fs in tmpdir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(relPath, exports) {
  const key = require.resolve(relPath);
  const original = require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
  return { key, original };
}

const stubs = [
  stub('../../../upstreamStudyCatalog', {
    recognizeProject: () => 'fake-proj',
    classifyEntry: (e) =>
      /dross|\.md$/i.test(e.path)
        ? { verdict: 'dross', bucket: 'docs', reason: 'doc' }
        : { verdict: 'essence', bucket: 'code', reason: 'src', tooLarge: false },
    scoreEssence: (item) => item.path.length,
    resolveTop: (env) => Number(env && env.KHY_UPSTREAM_STUDY_TOP) || 10,
  }),
  stub('../../../upstreamStudyPlan', {
    portabilityOf: () => null,
    portWaveOf: () => null,
    buildStudyPlan: () => null,
  }),
  stub('../../../upstreamStudyReport', { renderStudyReport: (r) => 'REPORT:' + r.totals.files }),
];

const svc = require('./index');

test.after(() => {
  for (const s of stubs) {
    if (s.original) require.cache[s.key] = s.original;
    else delete require.cache[s.key];
  }
});

// inspect stub returning the given archive entries.
function makeInspect(entries, extra = {}) {
  const calls = [];
  const inspect = async (archive, mimeType, opts) => {
    calls.push({ archive, mimeType, opts });
    return { success: true, entries, kindToken: 'zip', truncated: false, ...extra };
  };
  inspect.calls = calls;
  return inspect;
}

test('_commonTopDir：共享顶层剥除、混杂返空、垃圾返空', () => {
  assert.equal(svc._commonTopDir(['Proj-main/a/x.js', 'Proj-main/b/y.js']), 'Proj-main');
  assert.equal(svc._commonTopDir(['Proj-main/a', 'Other/b']), '');
  assert.equal(svc._commonTopDir(['top.js', 'Proj/a']), ''); // 顶层散文件 → 无公共前缀
  assert.equal(svc._commonTopDir([]), '');
  // 私有助手无垃圾守卫：非可迭代入参直接 TypeError（study 内部恒传 map 数组，不构成风险面）
  assert.throws(() => svc._commonTopDir(null), TypeError);
  assert.equal(svc._commonTopDir([null, '']), '');
  assert.equal(svc._commonTopDir(['单目录']), '');
  // 'A/' 归一去尾分隔后成 'A'（无内层 '/'）→ 与 'A/x' 不共享顶层 → 返 ''
  assert.equal(svc._commonTopDir(['A/', 'A/x']), '');
});

test('_relOf：剥前缀、不匹配原样归一', () => {
  assert.equal(svc._relOf('Proj-main/a/x.js', 'Proj-main'), 'a/x.js');
  assert.equal(svc._relOf('Proj-main', 'Proj-main'), '');
  assert.equal(svc._relOf('Other/a', 'Proj-main'), 'Other/a');
  assert.equal(svc._relOf('a\\b\\c.js', ''), 'a/b/c.js');
  assert.equal(svc._relOf(null, 'x'), '');
});

test('_walkBaseline：真实 fs 递归收集 (相对路径→size)，symlink 语义由 Dirent 保证', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upstream-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.js'), '12345'); // 5 bytes
    fs.writeFileSync(path.join(root, 'src', 'b.js'), '123'); // 3 bytes
    const { map, truncated } = svc._walkBaseline(root, null, { KHY_FS_WALK_BUDGET: '1' }, null);
    assert.equal(truncated, false);
    assert.equal(map.get('a.js'), 5);
    assert.equal(map.get('src/b.js'), 3); // rel 经 _norm 归一为正斜杠
    assert.equal(map.size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_walkBaseline：时钟预算耗尽 → truncated:true（部分视图）', () => {
  let calls = 0;
  const nowFn = () => (calls++ < 1 ? 0 : Number.MAX_SAFE_INTEGER);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upstream-'));
  try {
    fs.writeFileSync(path.join(root, 'a.js'), 'x');
    const { map, truncated } = svc._walkBaseline(root, null, {}, nowFn);
    assert.equal(truncated, true);
    assert.ok(map.size <= 1); // 至多收了一部分
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_walkBaseline 垃圾入参：假根/假 fs 绝不抛', () => {
  assert.deepEqual(svc._walkBaseline(null, null, { KHY_FS_WALK_BUDGET: '1' }, null).map.size, 0);
  assert.deepEqual(
    svc._walkBaseline('D:/definitely-missing-zz', null, { KHY_FS_WALK_BUDGET: '1' }, null).map.size,
    0
  );
  const broken = { readdirSync: () => { throw new Error('EACCES'); }, lstatSync: () => { throw new Error('EACCES'); } };
  assert.deepEqual(svc._walkBaseline('R', broken, { KHY_FS_WALK_BUDGET: '1' }, null).map.size, 0);
});

// KNOWN-DEFECT: 注释承诺「绝不抛;失败以 {success:false,error} 诚实上报」，但 study(null)
// 在进入 try 之前就于 index.js:158 读 opts.env → TypeError——契约对 null opts 不成立
// （低危：正常调用方传对象字面量，未见实际崩溃路径）。
test('study：无 archive → success:false + 中文错误；null opts 抛 TypeError（钉契约）', async () => {
  for (const opts of [undefined, {}, { archive: '' }]) {
    const r = await svc.study(opts, {});
    assert.equal(r.success, false);
    assert.ok(r.error.includes('未提供压缩包路径'));
  }
  // async 函数不会同步抛——须用 rejects 断言
  await assert.rejects(() => svc.study(null, {}), TypeError);
});

test('study：inspect 失败 → 透传错误与 skipped 语义', async () => {
  const r1 = await svc.study({ archive: 'a.zip' }, { inspect: async () => null });
  assert.equal(r1.success, false);
  assert.equal(r1.error, '无法列出压缩包内容');

  const r2 = await svc.study({ archive: 'a.zip' }, {
    inspect: async () => ({ success: false, error: '密码错误' }),
  });
  assert.equal(r2.success, false);
  assert.equal(r2.error, '密码错误');

  const r3 = await svc.study({ archive: 'a.zip' }, {
    inspect: async () => ({ success: false, skipped: true }),
  });
  assert.equal(r3.skipped, true);
});

test('study：inspect 抛错 → 兜底「学习失败」，绝不抛出调用方', async () => {
  const r = await svc.study({ archive: 'a.zip' }, {
    inspect: async () => { throw new Error('disk on fire'); },
  });
  assert.equal(r.success, false);
  assert.ok(r.error.includes('学习失败'));
  assert.ok(r.error.includes('disk on fire'));
});

test('study 主流程：目录剔除、分类分桶、精华 Top-N 排序、报告', async () => {
  const inspect = makeInspect([
    { name: 'Proj-main/src/a.js', size: 30, isDirectory: false },
    { name: 'Proj-main/src/bbbbbbbb.js', size: 20, isDirectory: false },
    { name: 'Proj-main/README.md', size: 5, isDirectory: false },
    { name: 'Proj-main/src/', size: 0, isDirectory: true }, // 目录剔除
    { name: '', size: 0, isDirectory: false }, // 空名剔除
  ]);
  const r = await svc.study({ archive: 'proj.zip' }, { inspect });
  assert.equal(r.success, true);
  assert.equal(r.recognized, 'fake-proj');
  assert.equal(r.format, 'zip');
  assert.equal(r.totals.files, 3); // 目录与空名已剔
  assert.equal(r.totals.essence, 2);
  assert.equal(r.totals.dross, 1);
  assert.deepEqual(r.dross.buckets, { docs: 1 });
  // scoreEssence = path.length → bbbbbbbb.js(剥前缀前更长) 排前
  assert.equal(r.essence[0].path, 'Proj-main/src/bbbbbbbb.js');
  assert.equal(r.essence[0].bucket, 'code');
  assert.equal(r.essenceTotal, 2);
  assert.ok(r.report.startsWith('REPORT:3'));
  assert.equal(inspect.calls[0].archive, 'proj.zip');
});

test('study：opts.top 逐参覆盖 env（不污染全局 env）', async () => {
  const inspect = makeInspect([
    { name: 'a.js', size: 1, isDirectory: false },
    { name: 'bb.js', size: 1, isDirectory: false },
    { name: 'ccc.js', size: 1, isDirectory: false },
  ]);
  const env = {};
  const r = await svc.study({ archive: 'a.zip', top: 2, env }, { inspect });
  assert.equal(r.essence.length, 2);
  assert.equal(env.KHY_UPSTREAM_STUDY_TOP, undefined); // 未污染
  assert.equal(r.essenceTotal, 3);
});

test('study：基线差异——新增/改动/删除（删除 200 封顶且无截断标注）', async () => {
  // KNOWN-DEFECT 钉点见下方断言注释。
  const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upstream-base-'));
  try {
    // 基线放 202 个文件；更新包只有 2 个同名同尺寸文件 → 200 个「删除」
    for (let i = 0; i < 202; i++) {
      fs.writeFileSync(path.join(baselineRoot, 'f' + i + '.js'), 'same');
    }
    const inspect = makeInspect([
      { name: 'f0.js', size: 4, isDirectory: false },
      { name: 'f1.js', size: 9, isDirectory: false }, // 尺寸不同 → 改动
    ]);
    const r = await svc.study(
      { archive: 'u.zip', baseline: baselineRoot },
      { inspect }
    );
    assert.equal(r.success, true);
    assert.deepEqual(r.diff.newCount, 0);
    assert.deepEqual(r.diff.changedCount, 1);
    // KNOWN-DEFECT: removed 在 index.js:253-260 满 200 即 break，diff.removedCount 封顶 200
    // 且 note 为空——「还有 2 个删除项未计入」这一事实被静默吞掉（低危：只影响策展报告的删除清单）。
    assert.equal(r.diff.removedCount, 200);
    assert.equal(r.diff.note, '');
    assert.equal(r.diff.removed.length, 200);
    assert.equal(r.truncated, false);
  } finally {
    fs.rmSync(baselineRoot, { recursive: true, force: true });
  }
});

test('study：基线遍历截断语义由 _walkBaseline 层保证；study 正常 diff 不误报截断', async () => {
  const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upstream-tr-'));
  try {
    fs.writeFileSync(path.join(baselineRoot, 'only.js'), 'x');
    const inspect = makeInspect([{ name: 'only.js', size: 1, isDirectory: false }]);
    const r = await svc.study({ archive: 'u.zip', baseline: baselineRoot }, { inspect });
    assert.equal(r.diff.note, '');
    assert.equal(r.diff.removedCount, 0);
    assert.equal(r.diff.newCount, 0);
    assert.equal(r.diff.changedCount, 0);
  } finally {
    fs.rmSync(baselineRoot, { recursive: true, force: true });
  }
});

test('study：dross/neutral 边界与新增标记（isNew/isChanged 传给 score 与条目）', async () => {
  const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upstream-n-'));
  try {
    fs.writeFileSync(path.join(baselineRoot, 'old.js'), 'same'); // 同名同尺寸
    fs.writeFileSync(path.join(baselineRoot, 'chg.js'), '12345'); // 更新包里尺寸不同
    const inspect = makeInspect([
      { name: 'old.js', size: 4, isDirectory: false },
      { name: 'chg.js', size: 3, isDirectory: false },
      { name: 'brand-new.js', size: 1, isDirectory: false },
      { name: 'notes.md', size: 1, isDirectory: false }, // dross，但基线没有 → 计入 newCount
    ]);
    const r = await svc.study({ archive: 'u.zip', baseline: baselineRoot }, { inspect });
    assert.equal(r.totals.essence, 3);
    const byPath = Object.fromEntries(r.essence.map((e) => [e.path, e]));
    assert.equal(byPath['old.js'].isNew, false);
    assert.equal(byPath['old.js'].isChanged, false);
    assert.equal(byPath['chg.js'].isChanged, true);
    assert.equal(byPath['brand-new.js'].isNew, true);
    // newCount/changedCount 遍历全部条目（含 dross），不只精华类
    assert.equal(r.diff.newCount, 2);
    assert.equal(r.diff.changedCount, 1);
    assert.equal(r.diff.removedCount, 0);
  } finally {
    fs.rmSync(baselineRoot, { recursive: true, force: true });
  }
});
