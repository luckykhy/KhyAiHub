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

test('classify: 已登记项目根 → 子目录会话归入该项目（2026-10-20 语义）', () => {
  const regs = [{ path: 'D:\\Portable\\khy-os', name: 'khy-os' }];
  const r = M.classifyWorkspacePath('D:\\Portable\\khy-os\\runtime\\node\\backend', regs);
  assert.strictEqual(r.bucket, 'registered');
  assert.strictEqual(r.name, 'khy-os');
  // 分桶键必须是登记的项目根，不是 cwd 本身 —— 否则子目录会话又裂成一行
  assert.strictEqual(r.rootPath, 'D:\\Portable\\khy-os');
  assert.strictEqual(r.inferred, false);
});

test('classify: 未登记路径的 rootPath 等于自身（保持精确分桶）', () => {
  const r = M.classifyWorkspacePath('D:\\Portable\\khy-os\\apps', []);
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.rootPath, 'D:\\Portable\\khy-os\\apps');
});

// ── findProjectRoot / isUnderPath：项目根前缀匹配 ──────────────

test('isUnderPath: 段边界匹配，兄弟前缀目录不误吸', () => {
  assert.strictEqual(M.isUnderPath('D:\\a\\b', 'D:\\a\\b'), true);
  assert.strictEqual(M.isUnderPath('D:\\a\\b\\c', 'D:\\a\\b'), true);
  // 反模式钉住：裸 startsWith 会把 D:\a\bc 吸进 D:\a\b
  assert.strictEqual(M.isUnderPath('D:\\a\\bc', 'D:\\a\\b'), false);
  assert.strictEqual(M.isUnderPath('D:\\a\\b', 'D:\\a\\b\\c'), false);
});

test('isUnderPath: 分隔符混用与 Windows 大小写不敏感', () => {
  assert.strictEqual(M.isUnderPath('D:/Portable/khy-os/apps', 'D:\\Portable\\khy-os'), true);
  assert.strictEqual(M.isUnderPath('d:\\portable\\KHY-OS\\apps', 'D:\\Portable\\khy-os'), true);
  // POSIX 大小写敏感，不能被折叠
  assert.strictEqual(M.isUnderPath('/home/u/Proj/x', '/home/u/proj'), false);
});

test('isUnderPath: 尾部多余分隔符不影响判定', () => {
  assert.strictEqual(M.isUnderPath('D:\\a\\b\\c', 'D:\\a\\b\\'), true);
  assert.strictEqual(M.isUnderPath('D:\\a\\b\\', 'D:\\a\\b'), true);
});

test('findProjectRoot: 最长前缀胜出（更具体的登记更接近用户意图）', () => {
  const regs = [
    { path: 'D:\\a', name: 'outer' },
    { path: 'D:\\a\\b', name: 'inner' },
  ];
  assert.strictEqual(M.findProjectRoot('D:\\a\\b\\c', regs).name, 'inner');
  assert.strictEqual(M.findProjectRoot('D:\\a\\x', regs).name, 'outer');
  assert.strictEqual(M.findProjectRoot('D:\\z', regs), undefined);
});

test('findProjectRoot: 空 path / 空登记表返回 undefined（不炸）', () => {
  assert.strictEqual(M.findProjectRoot('D:\\a', []), undefined);
  assert.strictEqual(M.findProjectRoot('', [{ path: 'D:\\a', name: 'a' }]), undefined);
  assert.strictEqual(M.findProjectRoot('D:\\a', [{ path: '', name: 'x' }]), undefined);
});

test('parentPath: 上一级，盘符根不再上溯', () => {
  assert.strictEqual(M.parentPath('D:\\Portable\\khy-os\\apps'), 'D:\\Portable\\khy-os');
  assert.strictEqual(M.parentPath('D:\\Portable\\khy-os\\'), 'D:\\Portable');
  assert.strictEqual(M.parentPath('D:\\Portable'), 'D:\\');
  assert.strictEqual(M.parentPath('D:\\'), 'D:\\');
  assert.strictEqual(M.parentPath('/home/u'), '/home');
  assert.strictEqual(M.parentPath('/'), '/');
});

// ── transientRoots：系统临时目录（位置事实，不是名字形状） ──────

test('classify: 系统临时目录下的路径 → transient', () => {
  const opts = { transientRoots: ['C:\\Users\\u\\AppData\\Local\\Temp'] };
  const r = M.classifyWorkspacePath('C:\\Users\\u\\AppData\\Local\\Temp\\agprobe-1792032717941', [], opts);
  assert.strictEqual(r.bucket, 'transient');
  assert.strictEqual(r.name, '');
});

test('classify: 不在临时根下的路径不受影响', () => {
  const opts = { transientRoots: ['C:\\Users\\u\\AppData\\Local\\Temp'] };
  const r = M.classifyWorkspacePath('C:\\Users\\u\\Documents\\proj', [], opts);
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.name, 'proj');
});

test('classify: 段边界 —— Temp 的兄弟目录 Temp2 不被吸进临时根', () => {
  const opts = { transientRoots: ['C:\\Temp'] };
  assert.strictEqual(M.classifyWorkspacePath('C:\\Temp2\\proj', [], opts).bucket, 'inferred');
});

test('classify: 登记优先于临时目录位置（用户意图 > 位置事实）', () => {
  const opts = { transientRoots: ['C:\\Temp'] };
  const regs = [{ path: 'C:\\Temp\\my-proj', name: 'my-proj' }];
  const r = M.classifyWorkspacePath('C:\\Temp\\my-proj\\sub', regs, opts);
  assert.strictEqual(r.bucket, 'registered');
  assert.strictEqual(r.name, 'my-proj');
});

test('classify: 不传 options 时行为不变（回滚能力）', () => {
  const r = M.classifyWorkspacePath('C:\\Users\\u\\AppData\\Local\\Temp\\agprobe-1', []);
  assert.strictEqual(r.bucket, 'inferred');
  assert.strictEqual(r.name, 'agprobe-1');
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

test('WorkspaceSidebar.tsx 按 rootPath 分桶（子目录归并已接线）', () => {
  const sidebar = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'components', 'layout', 'WorkspaceSidebar.tsx'),
    'utf-8',
  );
  // 分桶键必须是判定层给的 rootPath；用 cwd 本身作 key 会让子目录会话再裂开
  assert.match(sidebar, /c\.rootPath/, '应以 classifyWorkspacePath 的 rootPath 作分桶键');
  assert.match(sidebar, /parentPath/, '登记对话框应能上溯到项目根文件夹');
});
