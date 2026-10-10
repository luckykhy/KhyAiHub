'use strict';

// sidebarProjectClassify.test.cjs — 侧栏项目判定层（[DESIGN-ARCH-177]）的钉住用例。
//
// runner 纪律（见 skill §6.3）：本文件用 node:test 写、放在 tests/ 下安全
// （jest.config.js 会把 require('node:test') 的文件放进 testPathIgnorePatterns，
// 而 CI 的 `node --test tests/**/*.test.js` 会扫到它）。❌ 绝不在这里用裸
// describe/test/expect —— 那是 jest 风格，会被 node --test 扫走并炸在
// 「describe is not defined」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const modPath = join(__dirname, '..', 'src', 'renderer', 'shared', 'sidebarProjectClassify.ts');
const src = readFileSync(modPath, 'utf-8');

// 该模块是纯 TS 叶子（零 import），但 node --test 不吃 .ts。用仓里现成的
// TypeScript 5.9.3 做正规转译 —— 不要用正则剥类型注解，那是猜。
// （out/ 构建产物不能用作测试源：那要求先 build，把「跑测试」耦合到「构建成功」，
//   而 build 本就因 src/host 既有 33 条错误而不可靠。）
const ts = require('typescript');
function loadModule() {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

const M = loadModule();

// ── baseName：路径末段 ──────────────────────────────────────────

test('baseName: Windows 路径取末段', () => {
  assert.strictEqual(M.baseName('D:\\Portable\\khy-os'), 'khy-os');
  assert.strictEqual(M.baseName('D:\\Portable'), 'Portable');
});

test('baseName: POSIX 路径取末段', () => {
  assert.strictEqual(M.baseName('/home/u/proj'), 'proj');
});

test('baseName: 空串与纯分隔符原样返回（不补假数据）', () => {
  assert.strictEqual(M.baseName(''), '');
  assert.strictEqual(M.baseName('///'), '///');
});

// ── isTransientPath：只认锚定前缀 ───────────────────────────────

test('isTransientPath: 命中 khy-durable-transcript- 前缀', () => {
  assert.strictEqual(M.isTransientPath('D:\\tmp\\khy-durable-transcript-OotVEc'), true);
  assert.strictEqual(M.isTransientPath('khy-durable-transcript-Jg9K0J'), true);
});

test('isTransientPath: 真项目不得被误杀', () => {
  assert.strictEqual(M.isTransientPath('D:\\Portable\\khy-os'), false);
  assert.strictEqual(M.isTransientPath('D:\\Portable\\khy-os\\apps\\backend'), false);
  // 反模式钉住：泛化「随机串」启发会误杀这一条
  assert.strictEqual(M.isTransientPath('D:\\work\\khy-agents-v2'), false);
  assert.strictEqual(M.isTransientPath('D:\\work\\abc123'), false);
});

// ── classifyWorkspacePath：三态判定 ────────────────────────────

test('classify: 已登记路径取登记名 + 图标 + 颜色', () => {
  const regs = [{ path: 'D:\\Portable\\khy-os', name: 'khy-os 主力仓', icon: 'review', color: 'blue' }];
  const r = M.classifyWorkspacePath('D:\\Portable\\khy-os', regs);
  assert.strictEqual(r.bucket, 'registered');
  assert.strictEqual(r.name, 'khy-os 主力仓');
  assert.strictEqual(r.icon, 'review');
  assert.strictEqual(r.color, 'blue');
  assert.strictEqual(r.inferred, false);
});

test('classify: 已登记但 name 为空时回退路径末段', () => {
  const regs = [{ path: 'D:\\a\\b', name: '' }];
  const r = M.classifyWorkspacePath('D:\\a\\b', regs);
  assert.strictEqual(r.bucket, 'registered');
  assert.strictEqual(r.name, 'b');
});

test('classify: 临时目录归 transient，name 为空（调用方归入未归属）', () => {
  const r = M.classifyWorkspacePath('D:\\tmp\\khy-durable-transcript-OotVEc', []);
  assert.strictEqual(r.bucket, 'transient');
  assert.strictEqual(r.name, '');
  assert.strictEqual(r.inferred, false);
});

test('classify: 未登记普通路径 → inferred + 路径末段 + 弱化标记', () => {
  const r = M.classifyWorkspacePath('D:\\Portable', []);
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.name, 'Portable');
  assert.strictEqual(r.inferred, true);
});

test('classify: 空路径 → 未归属项目', () => {
  const r = M.classifyWorkspacePath('', []);
  assert.strictEqual(r.name, '未归属项目');
});

test('classify: 登记表为 undefined 时不炸（回滚能力）', () => {
  const r = M.classifyWorkspacePath('D:\\Portable\\khy-os');
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.name, 'khy-os');
});

test('classify: 登记按精确匹配，不按前缀（子目录不继承父登记）', () => {
  const regs = [{ path: 'D:\\Portable\\khy-os', name: 'khy-os' }];
  const r = M.classifyWorkspacePath('D:\\Portable\\khy-os\\apps\\backend', regs);
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.name, 'backend');
});

// ── inferredColorKey：稳定散列 ─────────────────────────────────

test('inferredColorKey: 同一路径恒定（刷新不跳色）', () => {
  const a = M.inferredColorKey('D:\\Portable');
  const b = M.inferredColorKey('D:\\Portable');
  assert.strictEqual(a, b);
});

test('inferredColorKey: 返回值必在 6 键内', () => {
  const KEYS = ['green', 'blue', 'amber', 'red', 'purple', 'teal'];
  for (const p of ['D:\\a', 'D:\\b', 'D:\\Portable\\khy-os', '', 'C:\\x\\y\\z']) {
    assert.ok(KEYS.includes(M.inferredColorKey(p)), `越界色键: ${M.inferredColorKey(p)}`);
  }
});

// ── 品牌色禁令（方案 §6 反模式：不能用 --color-brand 上色） ────

test('ProjectColorKey 联合类型不含 brand（品牌色浅深下同色）', () => {
  // 精确匹配 ProjectColorKey 的联合定义，避开注释里解释「为什么不用 brand」
  // 的行（那是设计依据，不是声明）。
  const m = src.match(/export type ProjectColorKey\s*=([\s\S]*?)$/m);
  assert.ok(m, '应能找到 ProjectColorKey 联合类型定义');
  assert.ok(!/\bbrand\b/.test(m[1]), `ProjectColorKey 不得含 brand：${m[1].trim()}`);
});

test('inferredColorKey 返回值不在任何含 brand 的键表内', () => {
  const KEYS = ['green', 'blue', 'amber', 'red', 'purple', 'teal'];
  for (const p of ['D:\\a', 'D:\\Portable', '', 'C:\\x']) {
    const k = M.inferredColorKey(p);
    assert.ok(KEYS.includes(k) && !/brand/i.test(k), `越界或含 brand 的色键: ${k}`);
  }
});

// ── 落地后自检 ─────────────────────────────────────────────────

test('WorkspaceSidebar.tsx 已改为消费判定层，不再内联 baseName 分桶', () => {
  const sidebar = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'components', 'layout', 'WorkspaceSidebar.tsx'),
    'utf-8',
  );
  assert.match(sidebar, /classifyWorkspacePath/, '应 import 并使用 classifyWorkspacePath');
  assert.match(sidebar, /inferredColorKey/, '第三期：文件夹头应使用 inferredColorKey 上色条');
  assert.doesNotMatch(
    sidebar,
    /name:\s*p\s*\?\s*baseName\(p\)/,
    '不得保留「项目名 = 路径末段」的内联分桶（旧实现）',
  );
});
