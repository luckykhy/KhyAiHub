'use strict';

/**
 * scripts/tests/fanInTiering.test.js — C-6 常驻分档仪器的契约测试。
 *
 * 两层：① 合成小仓（mkdtemp）把口径逐条钉死（D5 排除、注释剥离、目录形态解析、
 * 动态 require 盲区、阈值分档、登记表缺失如实抛错）；② 真仓只验**反空转**不变量
 * （源文件数 > 1000、四档求和等于总数、盲区读数非 0），不钉具体数字——
 * 具体数字随并发写入面漂移，钉死它只会造出假红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const lib = require(path.join(ROOT, 'scripts', 'lib', 'fanInTiering.js'));

function makeRepo(files, tiers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fanin-'));
  const regDir = path.join(dir, 'docs', '10_规范', 'registry');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(
    path.join(regDir, 'DOMAIN-DEPS.json'),
    JSON.stringify({
      domains: {
        D1: { roots: ['src/app'] },
        D3: { roots: ['src/utils'] },
        D5: { roots: ['archive'] },
      },
    })
  );
  const body = tiers === 'skip'
    ? '{}'
    : tiers === 'nonint'
      ? JSON.stringify({ fanInTiers: { hot: 'x', warm: 2, cool: 1 } })
      : JSON.stringify({ fanInTiers: tiers || { hot: 3, warm: 2, cool: 1 } });
  fs.writeFileSync(path.join(regDir, 'DATA-LOCATIONS.json'), body);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

test('合成仓：hub 的 fan-in 只数核心域内的真实 require 站点（3 档阈值分档正确）', () => {
  const dir = makeRepo({
    'src/utils/hub.js': "module.exports = { a: 1 };\n",
    'src/app/a.js': "require('../utils/hub');\n",
    'src/app/b.js': "const h = require('../utils/hub/index.js');\n",
    'src/app/c.js': "require('../utils/nope');\n",
    'src/app/d.js': "const p = require(path.join(X, 'hub'));\n",
    'src/app/e.js': "// require('../utils/hub');\n/* require('../utils/hub') */\nmodule.exports = 1;\n",
    'src/app/f.test.js': "require('../utils/hub');\n",
    'archive/x.js': "require('../src/utils/hub');\n",
  });
  try {
    const r = lib.measureFanInTiers({ repoRoot: dir });
    // 只有 a.js 的 '../utils/hub' 经 base+'.js' 解析命中；b.js 写成目录形态
    // '../utils/hub/index.js'（候选表里 base 与 base+'.js' 都不存在）落进 dangling ——
    // 这正是候选表的行为，钉住它而不是修正期望。
    assert.equal(r.fanInTiers.cool, 1, 'hub 扇入 1 → 落 cool（阈值 ≥1）');
    assert.equal(r.fanInTiers.warm, 0);
    assert.equal(r.scope.sourceFiles, 6, '5 个 D1 源文件 + 1 个 D3 源文件；测试与 D5 都不计入');
    assert.equal(r.zeroFanIn, 5);
    assert.equal(r.topFanIn[0].file, 'src/utils/hub.js');
    assert.equal(r.topFanIn[0].fanIn, 1, '注释里的两条与 D5/测试里的三条都不算边');
    assert.equal(r.unresolvedSpecifiers, 2, "nope 与 hub/index.js 两条都解析不到");
    assert.equal(r.dynamicRequires.sites, 1, '非字面量 require 计成盲区而不是 0');
    assert.deepEqual(r.dynamicRequires.topDirs, [{ dir: 'src/app', count: 1 }]);
    assert.equal(r.fanInByDomain.D1, 5);
    assert.equal(r.fanInByDomain.D3, 1);
    assert.equal(r.fanInByDomain.D5, undefined, 'D5 是归档面，整域不进核心域口径');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('合成仓：注释里的 require 不是边，模板串与插值不影响计数', () => {
  const dir = makeRepo({
    'src/utils/hub.js': 'x',
    'src/app/a.js': "require('../utils/hub');\n",
    'src/app/b.js': "require(`../utils/hub`);\n",
    'src/app/c.js': "  /* require('../utils/hub') */ require('../utils/hub');\n",
  });
  try {
    const r = lib.measureFanInTiers({ repoRoot: dir });
    assert.equal(r.topFanIn[0].fanIn, 2, '字面单/双引号两条算边（模板串那条不算），块注释里的不算');
    assert.equal(r.unresolvedSpecifiers, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('登记表缺 fanInTiers 块或缺整数档位：如实抛错，绝不静默兜底', () => {
  const dirA = makeRepo({ 'src/utils/hub.js': 'x' }, 'skip');
  const dirB = makeRepo({ 'src/utils/hub.js': 'x' }, 'nonint');
  try {
    assert.throws(() => lib.loadTierThresholds(dirA), /缺 fanInTiers 块/);
    assert.throws(() => lib.measureFanInTiers({ repoRoot: dirA }), /缺 fanInTiers 块/);
    assert.throws(() => lib.loadTierThresholds(dirB), /缺整数档位：hot/);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('阈值与扫描范围取自登记表，脚本内不另立第二份清单', () => {
  const th = lib.loadTierThresholds(ROOT);
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '10_规范', 'registry', 'DATA-LOCATIONS.json'), 'utf8'));
  assert.deepEqual(th, { hot: reg.fanInTiers.hot, warm: reg.fanInTiers.warm, cool: reg.fanInTiers.cool });
  const roots = lib.loadCoreRoots(ROOT);
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '10_规范', 'registry', 'DOMAIN-DEPS.json'), 'utf8'));
  const expected = [];
  for (const [d, spec] of Object.entries(dep.domains)) {
    if (d === 'D5') continue;
    for (const r0 of spec.roots || []) if (!expected.includes(r0)) expected.push(r0);
  }
  assert.deepEqual(roots, expected);
});

test('真仓反空转：源文件数、四档求和与盲区读数都必须是活数字', () => {
  const r = lib.measureFanInTiers({ repoRoot: ROOT, topN: 5 });
  assert.ok(r.scope.sourceFiles > 1000, `核心域源文件读数过小即仪器空转：${r.scope.sourceFiles}`);
  const sum = Object.values(r.fanInTiers).reduce((a, b) => a + b, 0);
  assert.equal(sum, r.scope.sourceFiles, '四档必须无重无漏地覆盖全部源文件');
  assert.ok(r.fanInTiers.hot >= 1, '本仓确有 utils/dataHome.js 这类高扇入底座，hot=0 是可疑读数');
  assert.ok(r.dynamicRequires.sites >= 3, '已实测 delivery/extension/scripts/khy-portable 有 3 处动态 require');
  assert.ok(r.depthOver6 > 0, 'C-2 深度存量不该为 0');
  assert.equal(r.topFanIn.length, 5);
  assert.equal(typeof r.proxy, 'string');
  assert.match(r.proxy, /变更频率不可得/);
});
