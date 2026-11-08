'use strict';

// khyPet.test.cjs —— 桌面端「Lucky 桌宠」的 UI 不变量契约测试。
//
// 本仓桌面端的 UI 契约测试一律是「读源码文本 + 正则/关键字匹配」风格
// （见 desktopUiContract.test.cjs），因为 renderer 没有 DOM 测试环境。
// 这里锁死的是**规格**，不是渲染结果：
//   P1  抽签算法：三端逐位一致的 FNV-1a + 位偏移派生 + 加权区间
//   P2  持久化键：khy_pet_pos / khy_pet_char / khy_pet_hidden
//   P3  不抢界面：卡片是唯一命中区，没有全屏命中层；z-40 在弹层之下
//   P4  真商标：用 BrandMark 组件，不许手绘近似图形
//   P5  互动：点击说话 / 抽签 / 切角色 / 收起唤出
//   P6  接线：AppLayout 挂载 <KhyPet />
//   P7  不新增 IPC：preload 与 main 的通道配对不受影响
//   P8  测试登记：新测试文件必须在 package.json 的 test 脚本里

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const petDir = join(projectRoot, 'src', 'renderer', 'components', 'pet');
const fortunePath = join(petDir, 'petFortune.ts');
const petPath = join(petDir, 'KhyPet.tsx');
const layoutPath = join(projectRoot, 'src', 'renderer', 'components', 'layout', 'AppLayout.tsx');
const preloadPath = join(projectRoot, 'src', 'preload', 'index.ts');
const mainPath = join(projectRoot, 'src', 'main', 'index.ts');
const pkgPath = join(projectRoot, 'package.json');

const fortuneSrc = existsSync(fortunePath) ? readFileSync(fortunePath, 'utf-8') : '';
const petSrc = existsSync(petPath) ? readFileSync(petPath, 'utf-8') : '';
const layoutSrc = existsSync(layoutPath) ? readFileSync(layoutPath, 'utf-8') : '';
const preloadSrc = existsSync(preloadPath) ? readFileSync(preloadPath, 'utf-8') : '';
const mainSrc = existsSync(mainPath) ? readFileSync(mainPath, 'utf-8') : '';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// ── P1: 抽签算法 ──────────────────────────────────────────────

test('P1: 抽签算法与三端共享契约一致（FNV-1a 32 + 位偏移 + 加权区间）', () => {
  assert.match(fortuneSrc, /FNV_OFFSET_BASIS\s*=\s*0x811c9dc5/);
  assert.match(fortuneSrc, /FNV_PRIME\s*=\s*0x01000193/);
  // Math.imul 是必须的：朴素乘法超过 2^53 会丢精度，三端就会对不上。
  assert.match(fortuneSrc, /Math\.imul\(hash, FNV_PRIME\)/);
  assert.match(fortuneSrc, /\(seed >>> 8\) % data\.tips\.length/);
  assert.match(fortuneSrc, /\(seed >>> 16\) % data\.luckyColors\.length/);
  assert.match(fortuneSrc, /seed % totalWeight/);
  // 加权命中：按数组顺序累计 weight，取第一个累计值大于余数的档位。
  assert.match(fortuneSrc, /accumulated \+= candidate\.weight/);
  assert.match(fortuneSrc, /remainder < accumulated/);
  // 播种键 = 日期 + 角色
  assert.match(fortuneSrc, /fnv1a32\(`\$\{dateKey\}:\$\{characterId\}`\)/);
  assert.match(fortuneSrc, /localDateKey/);
});

// ── P2: 持久化键 ──────────────────────────────────────────────

test('P2: 位置与收起态的持久化键稳定（角色不在 localStorage，见 P9）', () => {
  assert.match(petSrc, /const POS_KEY = 'khy_pet_pos'/);
  assert.match(petSrc, /const HIDDEN_KEY = 'khy_pet_hidden'/);
  assert.match(petSrc, /window\.localStorage\.setItem/);
  assert.match(petSrc, /window\.localStorage\.getItem/);
  // 角色曾经用 localStorage 存过（khy_pet_char）。现在真源是 settings.json，
  // 留着一个第二真源就会让设置页与桌宠卡片各说各话 —— 不许再出现。
  assert.doesNotMatch(petSrc, /khy_pet_char/);
});

// ── P3: 不抢界面 ──────────────────────────────────────────────

test('P3: 桌宠不抢工作区的点击，层级在弹层之下', () => {
  // 卡片是唯一命中区：不允许出现铺满窗口的命中层。
  assert.doesNotMatch(petSrc, /fixed inset-0/);
  assert.doesNotMatch(petSrc, /inset-0[^"']*pointer-events-auto/);
  // z-40：高于正文，低于应用自身的弹层（z-50）。
  assert.match(petSrc, /fixed z-40/);
  // 拖拽与点击靠阈值区分。
  assert.match(petSrc, /const DRAG_THRESHOLD = 4/);
  assert.match(petSrc, /Math\.hypot\(dx, dy\) < DRAG_THRESHOLD/);
  // 拖拽时禁掉文字选中；PNG 降级图不许被浏览器自己拖走（那张图在 3D 组件里）。
  assert.match(petSrc, /select-none/);
  const modelSrc = existsSync(join(petDir, 'KhyPetModel.tsx'))
    ? readFileSync(join(petDir, 'KhyPetModel.tsx'), 'utf-8')
    : '';
  assert.match(modelSrc, /draggable=\{false\}/);
});

// ── P4: 真商标 ────────────────────────────────────────────────

test('P4: 商标走 BrandMark 组件，不许手绘近似图形', () => {
  assert.match(petSrc, /import \{ BrandMark \} from '\.\.\/ui\/BrandMark'/);
  assert.match(petSrc, /<BrandMark/);
  // 组件内不得自己画 svg（那是品牌几何真源的活）。
  assert.doesNotMatch(petSrc, /<svg/);
  // 品牌名以真名出现。
  assert.match(petSrc, /fortune\.brand\.name/);
});

// ── P5: 互动 ──────────────────────────────────────────────────

test('P5: 四种互动都在（说话 / 抽签 / 切角色 / 收起唤出）', () => {
  assert.match(petSrc, /handleGreet/);
  assert.match(petSrc, /handleDraw/);
  assert.match(petSrc, /handleSwitch/);
  assert.match(petSrc, /handleCollapse/);
  assert.match(petSrc, /handleRestore/);
  // 抽签走共享算法，气泡同时给档位、提示与幸运色。
  assert.match(petSrc, /dailyFortune\(fortune, characterId\)/);
  assert.match(petSrc, /result\.level\.label/);
  assert.match(petSrc, /result\.level\.hint/);
  assert.match(petSrc, /result\.color/);
  // 抽签后切幸运姿态，2.5 秒后复原。
  assert.match(petSrc, /const BUBBLE_MS = 2500/);
  assert.match(petSrc, /setLucky\(true\)/);
  assert.match(petSrc, /setLucky\(false\)/);
  // 角色在 澪 / 凯 / 锦鲤 之间轮换，并把选择写回设置真源。
  assert.match(petSrc, /const CHARACTER_ORDER: readonly PetCharacterId\[\] = \['female', 'male', 'koi'\]/);
  assert.match(petSrc, /const next: PetCharacterId = nextCharacter\(current\)/);
  assert.match(petSrc, /setSetting\?\.\(PET_CHARACTER_SETTING, next\)/);
  // 四个按钮都要有可访问名。
  for (const label of ['切换桌宠角色', '收起桌宠', '抽一签', '唤出桌宠']) {
    assert.ok(petSrc.includes(label), `缺少 aria-label：${label}`);
  }
});

// ── P6: 接线 ──────────────────────────────────────────────────

test('P6: AppLayout 挂载了桌宠', () => {
  assert.match(layoutSrc, /import \{ KhyPet \} from '\.\.\/pet\/KhyPet'/);
  assert.match(layoutSrc, /<KhyPet \/>/);
});

// ── P7: 不新增 IPC ────────────────────────────────────────────

test('P7: 桌宠没有新增 preload/main 通道', () => {
  assert.doesNotMatch(petSrc, /ipcRenderer|window\.__KHYOS__/);
  // preload 与 main 的通道仍是一一对应（与 desktopUiContract 的 D6 同源：
  // KeyManager 的通道注册在 src/main/keyManager/ipc.ts，也要一起扫）。
  const keyManagerIpcPath = join(projectRoot, 'src', 'main', 'keyManager', 'ipc.ts');
  const keyManagerIpcSrc = existsSync(keyManagerIpcPath) ? readFileSync(keyManagerIpcPath, 'utf-8') : '';
  const preloadChannels = [...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  const mainHandles = [
    ...mainSrc.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g),
    // keyManager 模块走自己的 ipc.handle 包装，不是裸 ipcMain.handle。
    ...keyManagerIpcSrc.matchAll(/ipc(?:Main)?\.handle\(\s*'([^']+)'/g),
  ].map((m) => m[1]);
  for (const channel of preloadChannels) {
    assert.ok(mainHandles.includes(channel), `preload 用了未注册的通道：${channel}`);
  }
});

// ── P8: 测试登记 ──────────────────────────────────────────────

test('P8: 新测试文件已登记进 package.json 的 test 脚本', () => {
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/petFortune.test.mjs'), 'petFortune.test.mjs 未登记');
  assert.ok(script.includes('tests/khyPet.test.cjs'), 'khyPet.test.cjs 未登记');
});

// ── P10: 自动避让（挡住字就自己挪开） ──────────────────────────

test('P10: 桌宠会自己避开压住的文字', () => {
  const avoidPath = join(petDir, 'petAvoidance.ts');
  const probePath = join(petDir, 'petTextProbe.ts');
  const avoidSrc = existsSync(avoidPath) ? readFileSync(avoidPath, 'utf-8') : '';
  const probeSrc = existsSync(probePath) ? readFileSync(probePath, 'utf-8') : '';

  // 判定逻辑与 DOM 测量分层：前者纯函数可单测，后者负责取文字矩形。
  assert.ok(avoidSrc, '缺少 petAvoidance.ts');
  assert.ok(probeSrc, '缺少 petTextProbe.ts');
  assert.match(avoidSrc, /export function blockedLines/);
  assert.match(avoidSrc, /export function coverageRatio/);
  assert.match(avoidSrc, /export function candidateSlots/);
  assert.match(avoidSrc, /export function chooseEscapeSlot/);
  assert.match(avoidSrc, /export function shouldReturnHome/);
  // 文字矩形取的是「墨迹」而不是元素外框：Range.getClientRects 才是行级真形。
  assert.match(probeSrc, /getClientRects/);
  assert.match(probeSrc, /collectTextSpans/);

  // 组件确实接上了这套逻辑
  assert.match(petSrc, /from '\.\/petAvoidance'/);
  assert.match(petSrc, /from '\.\/petTextProbe'/);
  assert.match(petSrc, /collectTextSpans\(document\.body, card, regions\)/);
  assert.match(petSrc, /blockedLines\(selfRect, spans\)/);
  assert.match(petSrc, /chooseEscapeSlot\(\{/);
  // 定时检查（周期常量来自 petAvoidance，组件按它建 interval）
  assert.match(petSrc, /CHECK_INTERVAL_MS/);
  assert.match(petSrc, /window\.setInterval\(check, CHECK_INTERVAL_MS\)/);
  assert.match(avoidSrc, /export const CHECK_INTERVAL_MS/);
  // 桌宠自己的 DOM 要排除在外，否则卡片上的名字/按钮会被当成「被挡住的字」
  assert.match(petSrc, /ref=\{cardRef\}/);
});

test('P10b: 自动避让不与用户抢方向盘（拖过就听用户的）', () => {
  const avoidSrc = readFileSync(join(petDir, 'petAvoidance.ts'), 'utf-8');
  // 拖拽宽限期：用户刚放下的位置，桌宠不能立刻跳走
  assert.match(avoidSrc, /export const MANUAL_GRACE_MS/);
  assert.match(petSrc, /manualAtRef\.current = Date\.now\(\)/);
  assert.match(petSrc, /now - manualAtRef\.current < MANUAL_GRACE_MS/);
  // 拖拽时的位置就是「家」，自动避让之后要能走回来
  assert.match(petSrc, /const HOME_KEY = 'khy_pet_home'/);
  assert.match(petSrc, /homeRef\.current = current/);
  assert.match(petSrc, /shouldReturnHome\(\{/);
  // 冷却：两次自动挪动之间要有间隔，否则会在两个位置之间抖动
  assert.match(avoidSrc, /export const AUTO_MOVE_COOLDOWN_MS/);
  assert.match(petSrc, /now - autoMovedAtRef\.current < AUTO_MOVE_COOLDOWN_MS/);
});

test('P10c: 新测试文件已登记进 package.json 的 test 脚本', () => {
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/petAvoidance.test.mjs'), 'petAvoidance.test.mjs 未登记');
});

// ── P9: 角色由用户二选一，且只有一个真源 ────────────────────────

test('P9: 桌宠角色是设置项（设置页三选一 + 设置页与桌宠同一真源）', () => {
  const settingsStorePath = join(projectRoot, 'src', 'main', 'settingsStore.ts');
  const generalPath = join(projectRoot, 'src', 'renderer', 'components', 'settings', 'GeneralSettings.tsx');
  const fieldsPath = join(projectRoot, 'src', 'renderer', 'components', 'settings', 'fields.tsx');
  const settingsStoreSrc = existsSync(settingsStorePath) ? readFileSync(settingsStorePath, 'utf-8') : '';
  const generalSrc = existsSync(generalPath) ? readFileSync(generalPath, 'utf-8') : '';
  const fieldsSrc = existsSync(fieldsPath) ? readFileSync(fieldsPath, 'utf-8') : '';

  // 真源落在 settings.json 的默认值里（主进程侧）。
  assert.match(settingsStoreSrc, /desktopPetCharacter: 'female'/);
  // 设置页是「三选一」：RadioField 三个选项，各自带形象预览。
  assert.match(generalSrc, /RadioField/);
  assert.match(generalSrc, /value: 'female'/);
  assert.match(generalSrc, /value: 'male'/);
  assert.match(generalSrc, /value: 'koi'/);
  assert.match(generalSrc, /preview: femaleIdle/);
  assert.match(generalSrc, /preview: maleIdle/);
  assert.match(generalSrc, /preview: koiIdle/);
  assert.match(generalSrc, /onChange\('desktopPetCharacter', v\)/);
  // 选完广播窗口事件，桌宠立刻换人。
  assert.match(generalSrc, /khy:pet-character/);
  // RadioField 支持可选预览图。
  assert.match(fieldsSrc, /preview\?: string/);
  // 桌宠读同一个设置项、写同一个设置项。
  assert.match(petSrc, /const PET_CHARACTER_SETTING = 'desktopPetCharacter'/);
  assert.match(petSrc, /getSettings\?\.\(\)/);
  assert.match(petSrc, /setSetting\?\.\(PET_CHARACTER_SETTING, next\)/);
  assert.match(petSrc, /window\.addEventListener\('khy:pet-character'/);
});

// ── P11: 三形态并存（立绘浮雕 / 真 3D Q 版 / 写实真人 3D） ─────────
//
// 人的拍板（2026-11-04）：「作为第三种形态并存」——写实真人 3D 模型作为
// 第三种形态与现有两种并存，走外部 AI 3D 服务出模（image-to-3D）。
// 形态真源与角色真源同一条规矩：settings.json 的 desktopPetForm。

test('P11: 形态开关三形态并存，唯一真源仍是 settings.json', () => {
  const settingsStorePath = join(projectRoot, 'src', 'main', 'settingsStore.ts');
  const settingsStoreSrc = existsSync(settingsStorePath) ? readFileSync(settingsStorePath, 'utf-8') : '';
  const formsSrc = existsSync(join(petDir, 'petForms.ts')) ? readFileSync(join(petDir, 'petForms.ts'), 'utf-8') : '';

  // 真源：settings.json（主进程侧默认值 + 渲染层读写同一键）
  assert.match(settingsStoreSrc, /desktopPetForm: 'relief'/);
  assert.match(petSrc, /const PET_FORM_SETTING = 'desktopPetForm'/);
  assert.match(petSrc, /s\?\.\[PET_FORM_SETTING\]/);
  assert.match(petSrc, /isPetForm\(formValue\)/);
  assert.match(petSrc, /setSetting\?\.\(PET_FORM_SETTING, next\)/);
  // 形态集合只有一份，卡片与设置页共用
  assert.match(formsSrc, /export const PET_FORMS: readonly PetForm\[\] = \['relief', 'model', 'realistic'\]/);
  // 轮换走集合，不再写死二选一
  assert.match(petSrc, /nextPetForm\(current\)/);
  assert.doesNotMatch(petSrc, /current === 'relief' \? 'model' : 'relief'/);
  // 不另开 localStorage 存形态（那是第二个真源）
  assert.doesNotMatch(petSrc, /khy_pet_form/);
});

test('P11b: 真人形态缺资产时必须说清楚（不能悄悄显示成别的形态）', () => {
  const assetsSrc = existsSync(join(petDir, 'petRealisticAssets.ts'))
    ? readFileSync(join(petDir, 'petRealisticAssets.ts'), 'utf-8')
    : '';
  assert.match(assetsSrc, /export function hasRealisticAssets/);
  assert.match(petSrc, /hasRealisticAssets\(characterId\)/);
  assert.match(petSrc, /真人模型待生成/);
  // 卡片按钮的 aria-label 说的是「点下去会切到哪个形态」
  assert.match(petSrc, /PET_FORM_NEXT_LABELS\[form\]/);
  assert.match(petSrc, /PET_FORM_LABELS\[form\]/);
});

test('P11e: 锦鲤只有立绘浮雕，缺 Q 版 3D 模型时同样要标注', () => {
  const modelSrc = existsSync(join(petDir, 'KhyPetModel.tsx'))
    ? readFileSync(join(petDir, 'KhyPetModel.tsx'), 'utf-8')
    : '';
  // 三角色资产表是唯一分发点（不再散成三元表达式）
  assert.match(modelSrc, /const CHARACTER_ASSETS: Record</);
  assert.match(modelSrc, /koi: \{ model: null, relief: koiRelief/);
  assert.match(modelSrc, /export function hasModelAssets/);
  assert.match(petSrc, /hasModelAssets\(characterId\)/);
  assert.match(petSrc, /3D 模型待生成/);
});

test('P11c: 设置页有形态三选一，并广播 khy:pet-form', () => {
  const generalPath = join(projectRoot, 'src', 'renderer', 'components', 'settings', 'GeneralSettings.tsx');
  const generalSrc = existsSync(generalPath) ? readFileSync(generalPath, 'utf-8') : '';
  assert.match(generalSrc, /desktopPetForm/);
  assert.match(generalSrc, /PET_FORMS\.map/);
  assert.match(generalSrc, /khy:pet-form/);
  // 桌宠要听这个广播，设置页改完立刻换身体
  assert.match(petSrc, /window\.addEventListener\('khy:pet-form'/);
  assert.match(petSrc, /window\.removeEventListener\('khy:pet-form'/);
});

test('P11d: 新测试文件已登记进 package.json 的 test 脚本', () => {
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/petForms.test.mjs'), 'petForms.test.mjs 未登记');
});
