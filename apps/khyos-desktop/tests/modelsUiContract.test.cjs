'use strict';

// modelsUiContract.test.cjs — 模型管理页（ModelsPage）的 UI/接线契约
// （DESIGN-ARCH-091 §8b extension）。
//
// 与 tests/modelsStore.test.mjs 的分工：
//   · modelsStore.test.mjs —— main 侧行为（apply 写什么、probe 分几类、三名怎么拼）
//   · 本文件              —— 渲染层契约（通道对齐、类型镜像、出口语义、入口齐全）
// 两者合起来才覆盖「models 功能」；此前这个功能**两条都不在门禁里**
// （package.json 的 test 串既没有 modelsStore 也没有 modelsUiContract）。
//
// 每条断言都对应一个已发生过的坑：
//   M1 通道对齐        —— preload 暴露的 7 个 models:* 必须 main 侧有人注册且不撞名
//   M2 类型镜像        —— 页面 import 的每个类型/方法都要在 renderer api.ts 有声明
//                         （第 1 轮 typecheck 门禁红的 40+ 条全是因为这里漏了）
//   M3 按钮响应        —— 结构判据（照 wiringRuntime 口径，指向 ModelsPage）
//   M4 出口语义        —— standalone 与主窗整屏分支的出口不能互相错位
//   M5 首次使用路径    —— 零卡片时必须有可点的下一步（不许卡死）
//   M6 三个入口        —— Ctrl+Shift+M / 窗口菜单 / 侧栏按钮
//   M7 App.tsx 传参    —— standalone 必须是真值，不能硬编码
//   M8 脱敏            —— keyId 只显示前 8 位
//
// Run: node --test apps/khyos-desktop/tests/modelsUiContract.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { unregisteredChannels, duplicateChannels } = require('./ipcChannelScan.cjs');

const projectRoot = join(__dirname, '..');
const read = (p) => {
  const full = join(projectRoot, p);
  return existsSync(full) ? readFileSync(full, 'utf-8') : '';
};

const PAGE = 'src/renderer/components/modelManager/ModelsPage.tsx';
const pageSrc = read(PAGE);
const apiSrc = read('src/renderer/keyManager/api.ts');
const appSrc = read('src/renderer/App.tsx');
const preloadSrc = read('src/preload/index.ts');
const keymapSrc = read('src/renderer/shared/keymap.ts');
const titleBarSrc = read('src/renderer/components/layout/TitleBar.tsx');
const sidebarSrc = read('src/renderer/components/layout/WorkspaceSidebar.tsx');
const modelsWindowSrc = read('src/main/modelsWindow.ts');

// 受管模型的 7 个 IPC 通道（真源：src/main/keyManager/ipc.ts:191-228）
const MODELS_CHANNELS = [
  'models:managed', 'models:add', 'models:update', 'models:remove',
  'models:apply', 'models:probe', 'models:catalog'
];

test('M0: 被测文件都在（缺一个就是本测试被静默跳过）', () => {
  for (const [name, src] of [
    ['ModelsPage.tsx', pageSrc],
    ['renderer/keyManager/api.ts', apiSrc],
    ['App.tsx', appSrc],
    ['preload/index.ts', preloadSrc],
    ['renderer/shared/keymap.ts', keymapSrc],
    ['TitleBar.tsx', titleBarSrc],
    ['WorkspaceSidebar.tsx', sidebarSrc],
    ['main/modelsWindow.ts', modelsWindowSrc]
  ]) {
    assert.ok(src.length > 0, `${name} 缺失或读不到`);
  }
});

// ── M1 通道对齐 ────────────────────────────────────────────────────────────

test('M1: 7 个 models:* 通道在 preload 暴露且主进程侧无重复注册', () => {
  for (const ch of MODELS_CHANNELS) {
    assert.ok(preloadSrc.includes(`invoke('${ch}'`), `preload 未暴露 ${ch}`);
  }
  // 通道名必须是 models:<action> 全小写（desktopUiContract D6 正则）
  for (const ch of MODELS_CHANNELS) {
    assert.match(ch, /^models:[a-z][a-z-]*$/, `${ch} 不符合 D6 命名`);
  }
  // 撞名 = 启动即崩：registerKeyManagerIpc 早于 createWindow，重复注册让
  // createWindow 抛错、其后约 44 个 handler 全丢。models:list 这个撞过名的
  // 通道已被让位成 models:managed，这里钉住别再撞。
  const dup = duplicateChannels(projectRoot);
  assert.deepEqual(dup, [], `主进程侧重复注册：${dup.join(', ')}`);
  // preload 里的 models:list 是 host 转发的模型选择器（合法、另一条语义），
  // 要钉住的是「受管模型列表必须挂 models:managed」。
  assert.ok(
    /modelsManaged:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('models:managed'\)/.test(preloadSrc),
    'modelsManaged 必须映射到 models:managed（不是 models:list）'
  );
});

test('M1: models:managed 而非 models:list（撞名让位决策写进代码注释）', () => {
  const ipcSrc = read('src/main/keyManager/ipc.ts');
  assert.ok(ipcSrc.includes("handle('models:managed'"), 'ipc.ts 必须注册 models:managed');
  assert.ok(!ipcSrc.includes("handle('models:list'"), 'ipc.ts 不得注册 models:list（与 host 转发撞名，Electron 会抛错）');
  assert.match(ipcSrc, /models:list[\s\S]{0,200}second handler|second handler/, '让位理由必须留在注释里，否则下一个人会改回去');
});

// ── M2 类型镜像 ────────────────────────────────────────────────────────────

test('M2: 页面 import 的每个 models 类型都在 renderer api.ts 有导出', () => {
  // 第 1 轮 typecheck 门禁红的根因就是这里：页面 import 了 4 个类型，api.ts 一个
  // 都没导出，于是 KhyOsApi 的 Record<string, ...never[]> 索引签名兜底接住调用，
  // 返回值全退化 unknown、实参全对不上 never。
  const importBlock = pageSrc.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/\.\.\/keyManager\/api'/);
  assert.ok(importBlock, 'ModelsPage 未从 keyManager/api 导入');
  const wanted = importBlock[1]
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, '').trim())
    .filter(Boolean);
  assert.ok(wanted.length >= 7, `导入清单异常短：${wanted.join(', ')}`);
  for (const name of wanted) {
    // 值导入（khyosApi）是 export function，类型导入才是 export interface/type
    const ok =
      new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`).test(apiSrc) ||
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(apiSrc);
    assert.ok(ok, `renderer/keyManager/api.ts 缺导出 ${name}（页面 import 了它）`);
  }
});

test('M2: 六个 input 载荷双侧同名（清单不再自相矛盾）', () => {
  const inputs = ['ModelsAddInput', 'ModelsUpdateInput', 'ModelsRemoveInput', 'ModelsApplyInput', 'ModelsProbeInput', 'ModelsCatalogInput'];
  for (const name of inputs) {
    assert.ok(new RegExp(`export\\s+interface\\s+${name}\\b`).test(apiSrc), `渲染侧缺 ${name}`);
    assert.ok(new RegExp(`export\\s+interface\\s+${name}\\b`).test(read('src/main/keyManager/models.ts')), `主侧缺 ${name}`);
  }
});

test('M2: 页面调的 7 个 models 方法都在 KhyOsApi 上具名（不靠 never 索引签名兜底）', () => {
  const apiType = apiSrc.match(/export type KhyOsApi[\s\S]*?\n\}/);
  assert.ok(apiType, 'KhyOsApi 类型缺失');
  for (const m of ['modelsManaged', 'modelsAdd', 'modelsUpdate', 'modelsRemove', 'modelsApply', 'modelsProbe', 'modelsCatalog']) {
    assert.ok(new RegExp(`\\b${m}\\(`).test(apiType[0]), `${m} 未在 KhyOsApi 上具名声明`);
  }
});

// ── M3 按钮响应（结构判据，照 wiringRuntime 口径）──────────────────────────

test('M3: 每个 api 调用点的返回值都被消费（结构判据）', () => {
  const unconsumed = [];
  pageSrc.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    const m = /^(?:void\s+)?(?:await\s+)?api\.([a-zA-Z]+)\(/.exec(trimmed);
    if (!m) return;
    const consumed =
      /(?:const|let|var)\s+[\w{[\s,]+\]\s*=/.test(trimmed) ||
      /\.then\(|\.catch\(/.test(trimmed) ||
      /^return\s/.test(trimmed);
    if (!consumed) unconsumed.push(`${i + 1}: ${trimmed.slice(0, 80)}`);
  });
  assert.deepEqual(unconsumed, [], `以下调用未消费返回值（点击后将无反馈）：\n${unconsumed.join('\n')}`);
});

test('M3: 存在失败回流（否定判定 + 提前返回）与成功反馈', () => {
  const hasFailurePath = /if\s*\(\s*!\s*[a-zA-Z_$][\w$]*\.ok\s*\)\s*\{[\s\S]{0,300}?(?:return|setMsg|setError)/.test(pageSrc);
  assert.ok(hasFailurePath, '缺少失败回流：应有 `if (!X.ok) { …return/提示… }`');
  assert.ok(/setMsg\(\{\s*kind:\s*'ok'/.test(pageSrc), '缺少成功反馈出口');
});

// ── M4 出口语义 ────────────────────────────────────────────────────────────

test('M4: ✕ 只在 standalone 渲染；「返回工作区」只在非 standalone 渲染', () => {
  // 两条出口分属两种窗口形态，错位就是死路：
  //   · 独立无框窗（frame:false）没有系统关闭钮 → 必须页面画 ✕
  //   · 独立窗里点「返回工作区」会把 1080×720 管理窗变成一屏 AppLayout，且那窗
  //     没有侧栏/TitleBar，进去就出不来 → 不能渲染
  assert.ok(/closeWindow/.test(pageSrc), '页面必须能关窗（独立窗唯一出口）');
  assert.ok(/\{standalone\s*&&\s*\(/.test(pageSrc), '✕ 必须关在 standalone 分支里');
  assert.ok(/\{!standalone\s*&&\s*\(/.test(pageSrc), '「返回工作区」必须关在 !standalone 分支里');
  assert.ok(/window\.location\.hash\s*=\s*''/.test(pageSrc), '「返回工作区」仍是 hash 清空');
});

test('M4: 独立窗里「端点与密钥管理」开第二个独立窗，不在本窗跳 hash', () => {
  // 在无框管理窗里跳 #/key-manager：本页被换成 KeyManagerPage，而它的 ✕ 是
  // api.closeWindow()，关掉的是**本窗自己** → 用户得到「密钥窗 + 模型窗消失」。
  const block = pageSrc.match(/端点与密钥管理[\s\S]{0,900}/);
  assert.ok(block, '找不到「端点与密钥管理」按钮');
  assert.ok(/goKeyManager/.test(block[0]), 'standalone 时必须走 goKeyManager（再开一个独立窗）');
});

test('M4: goKeyManager 是唯一出口（顶栏 + 零卡片态共用，不留第二条 hash 路）', () => {
  const fn = pageSrc.match(/const goKeyManager = [\s\S]{0,500}?\n  \}/);
  assert.ok(fn, 'goKeyManager 缺失');
  assert.ok(/openKeyManagerWindow/.test(fn[0]), 'standalone 分支必须调 openKeyManagerWindow');
  assert.ok(/#\/key-manager/.test(fn[0]), '非 standalone 分支跳 #/key-manager');
  assert.ok(/standalone/.test(fn[0]), '必须按 standalone 分流');
  // 两个调用点都必须走这个函数，而不是各写一份 hash（注释里的提及不算）
  const hashSites = pageSrc
    .split(/\r?\n/)
    .filter((l) => /^\s*window\.location\.hash\s*=\s*'#\/key-manager'/.test(l));
  assert.equal(hashSites.length, 1, `#/key-manager 只应出现在 goKeyManager 里，实见 ${hashSites.length} 处`);
  assert.ok(/onClick=\{goKeyManager\}/.test(pageSrc), '顶栏按钮必须绑 goKeyManager');
});

// ── M5 首次使用路径 ────────────────────────────────────────────────────────

test('M5: 零卡片态给出可点的下一步（去端点与密钥管理建卡）', () => {
  // 没有卡片时块4 下拉为空；唯一出路是先建卡。此前块0 把「端点与密钥管理」引导
  // 钮关在 standalone 里，侧栏进来的用户页内无出口，第一个模型永远加不进来。
  const zeroCard = pageSrc.match(/cards\.length\s*===\s*0[\s\S]{0,700}/);
  assert.ok(zeroCard, '零卡片态分支缺失');
  assert.ok(/goKeyManager/.test(zeroCard[0]), '零卡片态必须给「去创建 →」动作（goKeyManager）');
  assert.ok(/去创建/.test(zeroCard[0]), '零卡片态必须有明确动作文案');
  // 且这个出口不依赖 standalone（主窗整屏分支与独立窗都要能建卡）
  assert.ok(/const goKeyManager = [\s\S]{0,500}?\n  \}/.test(pageSrc), 'goKeyManager 必须存在');
});

test('M5: 页面经 cardsList 拿卡片下拉（数据通道写死，不留自由发挥空间）', () => {
  assert.ok(/api\.cardsList\(/.test(pageSrc), '块4 卡片下拉必须走 cards:list');
  assert.ok(/setCards\(/.test(pageSrc), '必须把卡片列表接进 state');
});

// ── M6 三个入口 ───────────────────────────────────────────────────────────

test('M6: 入口① Ctrl+Shift+M —— keymap 登记 + App.tsx 消费 + main 注册', () => {
  assert.match(keymapSrc, /'openModels'/, 'DesktopAction 联合必须含 openModels（否则 TS2367）');
  assert.ok(/\{\s*action:\s*'openModels'[^}]*'m'/.test(keymapSrc), 'KEY_BINDINGS 必须登记 openModels → Ctrl+Shift+M');
  assert.ok(/action\s*===\s*'openModels'/.test(appSrc), 'App.tsx 必须消费 openModels');
  assert.ok(/openModelsWindow/.test(appSrc), 'App.tsx 必须 invoke openModelsWindow');
  assert.ok(read('src/main/index.ts').includes("handle('models:openWindow'"), 'main 必须注册 models:openWindow');
});

test('M6: 入口② 窗口菜单项（TitleBar）', () => {
  assert.ok(/label:\s*'模型管理'/.test(titleBarSrc), 'TitleBar 窗口菜单缺「模型管理」项');
  assert.ok(/keyLabelFor\('openModels'\)/.test(titleBarSrc), '菜单项键位徽标必须从 keymap 单一真源派生');
  assert.ok(/openModelsWindow\?:/.test(titleBarSrc), 'TitleBar 的 api 类型必须声明 openModelsWindow');
});

test('M6: 入口③ 侧栏按钮（WorkspaceSidebar，走主窗 hash 整屏分支）', () => {
  assert.ok(/#\/model-manager/.test(sidebarSrc), '侧栏必须有 #/model-manager 入口');
  const btn = sidebarSrc.match(/#\/model-manager[\s\S]{0,400}/);
  assert.ok(/模型管理/.test(btn[0]), '侧栏入口必须标「模型管理」');
});

// ── M7 App.tsx 传参 ───────────────────────────────────────────────────────

test('M7: App.tsx 把真实的 standalone 传给 ModelsPage（不硬编码、不省略）', () => {
  const branch = appSrc.match(/if\s*\(models\)\s*\{[\s\S]{0,500}/);
  assert.ok(branch, 'App.tsx 的 models 分支缺失');
  assert.ok(/<ModelsPage\s+standalone=\{/.test(branch[0]), '必须显式传 standalone 属性');
  assert.ok(/modelsStandalone/.test(branch[0]), 'standalone 必须是派生值而不是字面量');
  // 派生值必须真的从 URL 查询段读（否则主窗与独立窗分不出，✕ 会画错地方）
  assert.ok(/modelsStandalone/.test(appSrc) && /get\('window'\)\s*===\s*'models'/.test(appSrc), 'modelsStandalone 必须由 ?window=models 查询段派生');
  // 路由匹配必须容忍查询段
  assert.ok(/route\s*===\s*'model-manager'\s*\|\|\s*route\.startsWith\('model-manager\?'\)/.test(appSrc), 'models 路由必须前缀匹配带查询段的 hash');
});

test('M7: 独立窗 URL 带身份查询段（建窗方负责区分两种窗口）', () => {
  assert.ok(/window=models/.test(modelsWindowSrc), 'modelsWindow 必须加载 #/model-manager?window=models');
  assert.ok(/MODELS_WINDOW_QUERY/.test(modelsWindowSrc), '查询段应提为常量，dev/packaged 两条加载路共用');
});

test('M7: 连开不叠窗（已存在则 focus）', () => {
  assert.ok(/getAllWindows\(\)/.test(modelsWindowSrc), 'openModelsWindow 必须先去重');
  assert.ok(/\.focus\(\)/.test(modelsWindowSrc), '已开着的窗应 focus 而不是新建');
});

// ── M8 脱敏 ───────────────────────────────────────────────────────────────

test('M8: 渲染层只显示 keyId 前 8 位，不出现明文 key 出口', () => {
  assert.ok(/keyId\.slice\(0,\s*8\)/.test(pageSrc), 'keyId 必须只显示前 8 位');
  assert.ok(!/keysReveal/.test(pageSrc), '模型管理页不得消费 keys:reveal（明文 key 唯一出口不在这里）');
  assert.ok(!/return\s+ok\(\{\s*key:/.test(read('src/main/keyManager/models.ts')), 'models.ts 不得回传明文 key');
  assert.ok(!/apiKeys|plaintext/.test(pageSrc), '页面不得接触明文 key 概念');
});

// ── M9 诚实状态 ───────────────────────────────────────────────────────────

test('M9: 重启生效的期望管理在页面上明示（CC 启动时读 settings.json）', () => {
  assert.ok(/CC_RESTART_HINT|重启 Claude Code/.test(pageSrc), '必须明示「替换模型后需重启 Claude Code 生效」');
});

test('M9: 非 anthropic 线卡片禁「应用（直连）」并附原因', () => {
  assert.ok(/DIRECT_BLOCKED_HINT/.test(pageSrc), '直连禁用提示常量缺失');
  assert.ok(/directBlocked/.test(pageSrc), '必须有 directBlocked 判据');
});
