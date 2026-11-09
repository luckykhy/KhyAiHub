'use strict';
// Q1′ 三判据契约测试（[DESIGN-LAY-008] §19）：root-uncatalogued / registry-path-dangling / floor-closed-set。
// 判据均为 S1 观察者档——本测试锁「纯函数判定正确」，不锁阻断行为。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const layout = require(path.join(repoRoot, 'scripts/ci/check-repo-layout.js'));
const registry = require(path.join(repoRoot, 'scripts/ci/check-rules-registry.js'));

test('Q-1 root-uncatalogued：层级/横切/白名单/README 变体都不算未登记，散落的顶层实体才算', () => {
  const entries = [
    // LAYERS 的键自 2026-10-15 起是路径（`runtime/node`），顶层判定取首段，
    // 故这里喂顶层名 `runtime` / `delivery` 才对应得上。旧用例喂 `services`，
    // 那已是搬走前的层名，现在理应被判未登记 —— 故一并作为反例留在下面。
    { name: 'runtime' },      // LAYERS['runtime/node'] 的首段 → 已登记
    { name: 'delivery' },      // LAYERS['delivery/channel'] 的首段 → 已登记
    { name: 'docs' },          // CROSSCUTTING → 已登记
    { name: 'build' },         // GENERATED → 已登记
    { name: 'node_modules' },  // 公认非层级
    { name: 'AGENTS.md' },     // ROOT_DOC_WHITELIST
    { name: 'README.fr.md' },  // README 变体
    { name: '.khy' },          // ROOT_CATALOG(localdata)
    { name: 'stray-thing' },   // 未登记
    { name: 'leftover.py' },   // 未登记（口径洞：非 md/txt 也能抓到）
  ];
  assert.deepStrictEqual(layout.findUncataloguedRootEntries(entries), ['leftover.py', 'stray-thing']);
});

test('Q-1：方案 P 搬走前的层名不再是已登记顶层目录', () => {
  // 这条是 layer-registry-stale 的同一件事在 root-uncatalogued 这一侧的镜像：
  // 名册键改成真实落点后，`services` / `software` / `extensions` / `tools` /
  // `packaging` / `kernel` / `platform` 这些旧顶层名若有人重建，会立刻被要求
  // 重新登记 —— 而不会因为「名字在老规范里见过」被静默放行。
  const offenders = layout.findUncataloguedRootEntries(
    ['kernel', 'platform', 'services', 'software', 'extensions', 'tools', 'packaging'].map(name => ({ name }))
  );
  assert.deepStrictEqual(offenders.sort(),
    ['extensions', 'kernel', 'packaging', 'platform', 'services', 'software', 'tools']);
});

test('Q-1：当前真实根上无未登记实体（ROOT_CATALOG 覆盖完整）', () => {
  const real = fs.readdirSync(repoRoot, { withFileTypes: true }).map(e => ({ name: e.name }));
  const offenders = layout.findUncataloguedRootEntries(real);
  assert.deepStrictEqual(offenders, [], `根上有未登记实体：${offenders.join(', ')}`);
});

test('Q-2 registry-path-dangling：paths glob 首段不存在即报，存在则不报', () => {
  const fakeExists = (p) => p === 'services' || p === 'docs';
  const rules = [
    { id: 'OK-1', paths: ['services/**', 'docs/**'] },
    { id: 'DANGLE-1', paths: ['_产物/**', 'ghost/**'] },
    { id: 'ROOTGLOB', paths: ['*.md'] },  // 根级 glob 无目录段，跳过
  ];
  const dangling = registry.findDanglingRegistryPaths(rules, fakeExists);
  assert.deepStrictEqual(
    dangling.map(d => `${d.id}:${d.seg}`).sort(),
    ['DANGLE-1:_产物', 'DANGLE-1:ghost'],
  );
});

test('Q-3 debt-ledger：layout.floor-closed-set 行存在且 target 严格小于 measured（只降不升）', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/ci/debt-ledger.json'), 'utf8'));
  const row = ledger.entries.find(e => e.id === 'layout.floor-closed-set');
  assert.ok(row, '缺 layout.floor-closed-set 行');
  // metric 是 root-uncatalogued —— **违规计数**，终局档位是 0（归零）。
  // 旧断言写的 10 是把「封闭清单下限」与「违规计数目标」混成了一个量，与台账行自身的
  // metric/target 字段矛盾（台账行一直是 target: 0）。
  assert.strictEqual(row.target, 0, '违规计数的终局档位应为 0（归零）');
  // 只降不升的棘轮：未归零时 measured 必须大于 target；已归零（measured === 0）即清偿，
  // 见台账 _statusMeaning: 'closed（已归零）'。
  assert.ok(
    typeof row.measured === 'number' && (row.measured > row.target || row.measured === 0),
    'measured 须大于 target（已归零则视为清偿）'
  );
  assert.match(row.measuredAt, /^\d{4}-\d{2}-\d{2}$/, 'measuredAt 须为日期');
});
