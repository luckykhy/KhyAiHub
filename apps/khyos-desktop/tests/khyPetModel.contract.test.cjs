'use strict';

// khyPetModel.contract.test.cjs —— 桌宠 3D 模型的契约测试。
//
// 桌宠本体已经不是图片了，而是一份 Blender 导出的 GLB 真模型，由原生 WebGL 渲染。
// 这里锁死的是**不能退化的规格**：
//   M1 零依赖：不得引入 three.js（仓库的 3D 约定是手写 WebGL）
//   M2 真模型：模型以 ?inline 内联（file:// 下 fetch 被 Chromium 拒绝）
//   M3 渲染：WebGL 上下文、透明背景、贴图解码、方向光
//   M4 交互：拖模型=旋转、点头部=挪卡片、点模型=打招呼
//   M5 降级：WebGL/模型不可用时回落 PNG，桌宠不能凭空消失
//   M6 无障碍：动效尊重 prefers-reduced-motion
//   M8 两种形态：立绘浮雕（默认，最像定妆照）与真 3D 模型可切换

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const petDir = join(projectRoot, 'src', 'renderer', 'components', 'pet');
const read = (name) => {
  const p = join(petDir, name);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
};

const modelSrc = read('KhyPetModel.tsx');
const rendererSrc = read('petModelRenderer.ts');
const loaderSrc = read('glbLoader.ts');
const petSrc = read('KhyPet.tsx');
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));

// ── M1: 零依赖 ──────────────────────────────────────────────────

test('M1: 桌宠 3D 不引入 three.js（沿用手写 WebGL 约定）', () => {
  const deps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
  assert.ok(!deps.includes('three'), 'package.json 里出现了 three');
  for (const src of [modelSrc, rendererSrc, loaderSrc]) {
    assert.doesNotMatch(src, /from ['"]three['"]/);
    assert.doesNotMatch(src, /@react-three/);
  }
});

// ── M2: 真模型 + 内联加载 ───────────────────────────────────────

test('M2: 模型是 GLB 且以 ?inline 内联（file:// 下 fetch 会被拒）', () => {
  assert.match(modelSrc, /khy-pet-female\.glb\?inline/);
  assert.match(modelSrc, /khy-pet-male\.glb\?inline/);
  assert.match(modelSrc, /dataUrlToBytes/);
  assert.match(loaderSrc, /export function parseGlb/);
  assert.match(loaderSrc, /export function dataUrlToBytes/);
  // 真的模型文件得在仓库里
  for (const name of ['khy-pet-female.glb', 'khy-pet-male.glb']) {
    assert.ok(
      existsSync(join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models', name)),
      `缺少模型文件 ${name}`,
    );
  }
});

// ── M3: 渲染 ────────────────────────────────────────────────────

test('M3: 原生 WebGL 渲染 + 透明背景 + 贴图解码', () => {
  assert.match(rendererSrc, /getContext\('webgl2'/);
  assert.match(rendererSrc, /getContext\('webgl'/);
  assert.match(rendererSrc, /clearColor\(0, 0, 0, 0\)/);
  assert.match(rendererSrc, /createImageBitmap/);
  assert.match(rendererSrc, /drawElements/);
  assert.match(rendererSrc, /uBaseColor/);
  assert.match(rendererSrc, /uHasTexture/);
  // 解析器要处理 chunk、accessor 与节点变换
  assert.match(loaderSrc, /CHUNK_JSON/);
  assert.match(loaderSrc, /CHUNK_BIN/);
  assert.match(loaderSrc, /readAccessor/);
  assert.match(loaderSrc, /mat4FromNode/);
});

// ── M4: 交互分工 ────────────────────────────────────────────────

test('M4: 拖模型=旋转，拖头部=挪卡片，点模型=打招呼', () => {
  assert.match(modelSrc, /yawRef\.current \+= dx \* 0\.012/);
  assert.match(modelSrc, /onActivate\?\.\(\)/);
  assert.match(petSrc, /<KhyPetModel characterId=\{characterId\} form=\{form\} lucky=\{lucky\} onActivate=\{handleGreet\}/);
  // 卡片拖拽挂在头部（不是模型画布上）
  assert.match(petSrc, /onPointerDown=\{handlePointerDown\}/);
  assert.match(petSrc, /cursor-grab touch-none items-center/);
  // 拖动阈值与坐标持久化仍在
  assert.match(petSrc, /const DRAG_THRESHOLD = 4/);
  assert.match(petSrc, /const POS_KEY = 'khy_pet_pos'/);
  assert.match(petSrc, /writeString\(POS_KEY/);
});

// ── M5: 降级 ────────────────────────────────────────────────────

test('M5: 模型/WebGL 不可用时回落 PNG 立绘', () => {
  assert.match(modelSrc, /catch/);
  assert.match(modelSrc, /setFailed\(true\)/);
  // 兜底用的是**抠掉背景的**立绘：原始定妆照带奶白底，深色卡片上会露出一块方框。
  assert.match(modelSrc, /khy-pet-female-idle-cutout\.png/);
  assert.match(modelSrc, /khy-pet-male-idle-cutout\.png/);
});

test('M5b: 无 WebGL 时走转盘序列（36 帧旋转序列，同一个 3D 模型的渲染）', () => {
  assert.match(modelSrc, /turntable/);
  assert.match(modelSrc, /SPRITE_FRAMES/);
  assert.match(modelSrc, /drawImage\(sprite/);
  assert.match(modelSrc, /frameForAngle/);
  // 转盘精灵表必须在仓库里
  for (const name of ['khy-pet-female-turntable.png', 'khy-pet-male-turntable.png']) {
    assert.ok(
      existsSync(join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models', name)),
      `缺少转盘序列 ${name}`,
    );
  }
});

// ── M6: 无障碍 / 动效 ───────────────────────────────────────────

test('M6: 尊重 prefers-reduced-motion，模型有可访问名', () => {
  assert.match(modelSrc, /prefers-reduced-motion: reduce/);
  assert.match(modelSrc, /aria-label="桌宠 3D 模型，可拖动旋转"/);
  assert.match(modelSrc, /role="img"/);
});

// ── M7: 测试登记 ────────────────────────────────────────────────

test('M7: 新测试文件登记进 package.json 的 test 脚本', () => {
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/glbLoader.test.mjs'), 'glbLoader.test.mjs 未登记');
  assert.ok(script.includes('tests/khyPetModel.contract.test.cjs'), 'khyPetModel.contract.test.cjs 未登记');
});

// ── M8: 两种形态（立绘浮雕 / 真 3D 模型） ────────────────────────
//
// 背景：程序化 3D 模型给不出插画的笔触，出来的是另一个 Q 版角色。
// 人的拍板是「两种形态并存：默认立绘（最像）+ 可切 3D 转圈」。
// 立绘形态 = 把定妆照烘成**带厚度的浮雕网格**：正面就是那张图，转起来有厚度。

test('M8: 立绘浮雕形态存在且以 ?inline 内联', () => {
  assert.match(modelSrc, /khy-pet-female-relief\.glb\?inline/);
  assert.match(modelSrc, /khy-pet-male-relief\.glb\?inline/);
  for (const name of ['khy-pet-female-relief.glb', 'khy-pet-male-relief.glb']) {
    const p = join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models', name);
    assert.ok(existsSync(p), `缺少浮雕模型 ${name}`);
    const size = statSync(p).size;
    assert.ok(size > 50 * 1024, `${name} 太小（${size}），多半没烘出来`);
    assert.ok(size < 4 * 1024 * 1024, `${name} 太大（${size}），内联后渲染包会爆`);
  }
});

test('M8b: 形态切换有唯一真源（settings.json 的 desktopPetForm）', () => {
  const store = readFileSync(join(projectRoot, 'src', 'main', 'settingsStore.ts'), 'utf-8');
  assert.match(store, /desktopPetForm: 'relief'/);
  assert.match(petSrc, /const PET_FORM_SETTING = 'desktopPetForm'/);
  assert.match(petSrc, /setSetting\?\.\(PET_FORM_SETTING, next\)/);
  // 挂载时从 settings 读回来（不能只靠 localStorage —— 那是第二个真源）
  assert.match(petSrc, /s\?\.\[PET_FORM_SETTING\]/);
  assert.match(petSrc, /isPetForm\(formValue\)/);
  // 卡头上有形态切换按钮（文案集中在 petForms.ts，按钮只引用它）
  const formsSrc = read('petForms.ts');
  assert.match(petSrc, /aria-label=\{PET_FORM_NEXT_LABELS\[form\]\}/);
  assert.match(formsSrc, /PET_FORM_NEXT_LABELS/);
  assert.match(formsSrc, /切换到立绘形态/);
});

test('M8c: 浮雕是正面的平板，偏航被锁在小角度内（不能转成平行四边形）', () => {
  assert.match(modelSrc, /const RELIEF_YAW_LIMIT = 0\.28/);
  assert.match(modelSrc, /RELIEF_PITCH_LIMIT/);
  // 浮雕不做整圈转台，只做轻摆
  assert.match(modelSrc, /form === 'relief'/);
  assert.match(modelSrc, /RELIEF_YAW_LIMIT \* 0\.45/);
  assert.match(modelSrc, /Math\.sin\(spinRef\.current \* speed\)/);
  // 拖动时也要把偏航夹回限制内
  assert.match(modelSrc, /Math\.min\(RELIEF_YAW_LIMIT, yawRef\.current\)/);
});

test('M8d: 着色器把 sRGB 贴图转回线性再参与光照（否则立绘发白）', () => {
  // 贴图是 sRGB 编码的 PNG，材质 Base Color 是线性值：少这一步颜色就整体偏亮
  assert.match(rendererSrc, /pow\(max\(texel\.rgb, vec3\(0\.0\)\), vec3\(2\.2\)\)/);
  // 画出来的表面用平缓明暗，保持「画得出哪张图」
  assert.match(rendererSrc, /float lit = mix\(/);
});

// ── M9: 三形态并存（立绘浮雕 / 真 3D Q 版 / 写实真人 3D） ─────────
//
// 人的拍板（2026-11-04）：「作为第三种形态并存」——写实真人 3D 模型作为第三种
// 形态与现有两种并存，走外部 AI 3D 服务出模（image-to-3D）。
//
// 关键约束：真人形态的资产是**可选**的（服务出的模还没进仓）。静态 import
// 会在文件不存在时把整个渲染层构建打挂，所以这一形态必须走 glob 匹配。

test('M9: 三形态枚举只有一份真源（petForms.ts）', () => {
  const formsSrc = read('petForms.ts');
  assert.match(formsSrc, /export type PetForm = 'relief' \| 'model' \| 'realistic'/);
  assert.match(formsSrc, /export const PET_FORMS: readonly PetForm\[\] = \['relief', 'model', 'realistic'\]/);
  assert.match(formsSrc, /export function nextPetForm/);
  assert.match(formsSrc, /export function isPetForm/);
  // KhyPetModel 不再自己定义形态集合（两处各写一份必然漂移）
  assert.doesNotMatch(modelSrc, /export const PET_FORMS/);
  assert.doesNotMatch(modelSrc, /export type PetForm =/);
});

test('M9b: 真人资产走 import.meta.glob（缺资产时构建不能挂）', () => {
  const assetsSrc = read('petRealisticAssets.ts');
  assert.match(assetsSrc, /import\.meta\.glob\('\.\.\/\.\.\/assets\/pet\/models\/\*-realistic\.glb'/);
  assert.match(assetsSrc, /import\.meta\.glob\('\.\.\/\.\.\/assets\/pet\/models\/\*-realistic-turntable\.png'/);
  // ?inline 内联是必须的：file:// 下 Chromium 拒绝 fetch(file://)
  assert.match(assetsSrc, /query: '\?inline'/);
  // 静态 import 会在文件不存在时把渲染层构建打挂 —— 不许出现
  assert.doesNotMatch(assetsSrc, /from '@\/assets\/pet\/models\/khy-pet-\w+-realistic\.glb'/);
  // 缺资产时返回 null（不是 undefined、不是抛错）
  assert.match(assetsSrc, /export function realisticGlb\(characterId: PetCharacterId\): string \| null/);
  assert.match(assetsSrc, /export function realisticTurntable\(characterId: PetCharacterId\): string \| null/);
  assert.match(assetsSrc, /export function hasRealisticAssets/);
});

test('M9c: 三路降级（GLB → 转盘 → 立绘），真人缺资产时不建 WebGL 上下文', () => {
  assert.match(modelSrc, /realisticGlb\(characterId\)/);
  assert.match(modelSrc, /realisticTurntable\(characterId\)/);
  // 没有 GLB 可用时直接走静态立绘，别浪费一次 WebGL 初始化
  assert.match(modelSrc, /if \(glbData\)/);
  // 没有转盘序列可退时落回静态立绘（桌宠永不消失）
  assert.match(modelSrc, /sprite\.src = stillSrc/);
  // 浮雕形态仍然没有转盘序列（转过去会露侧边，认不出是那张图）
  assert.match(modelSrc, /const sheetData = isRelief/);
});

test('M9d: 能不能整圈转按**网格形状**判，不按形态名判', () => {
  // 板状资产（浮雕，含现在槽位里的真人浮雕）锁在 ±0.28 rad，只做轻摆：
  // 整圈转台会露出侧边，背面还是镜像 —— 用户看到的是「模型坏了」。
  // 立体网格（Q 版模型、外部服务出的真扫描网格）才整圈自转。
  assert.match(modelSrc, /const RELIEF_YAW_LIMIT = 0\.28/);
  assert.match(modelSrc, /RELIEF_YAW_LIMIT \* 0\.45/);
  assert.match(modelSrc, /Math\.sin\(spinRef\.current \* speed\)/);
  assert.match(modelSrc, /Math\.min\(RELIEF_YAW_LIMIT, yawRef\.current\)/);
  // 判定依据是网格包围盒（深度/高度），不是形态名
  assert.match(modelSrc, /import \{ isPlateLike \} from '\.\/petAssetShape'/);
  assert.match(modelSrc, /plateRef\.current = isRelief \|\| isPlateLike\(scene\.bounds\)/);
  // ⚠ 取反会写反：isPlateLike 为 true 表示「是板状」，取反等于把板状当成立体，
  // 板状资产就会被整圈转台转成一条边（打包版实测抓到过）。
  assert.doesNotMatch(modelSrc, /!isPlateLike\(scene\.bounds\)/);
  // 动画循环与拖拽都读同一个判定
  assert.match(modelSrc, /if \(plateRef\.current\)/);
  // 立绘浮雕仍按构造就是平板
  assert.match(modelSrc, /const isRelief = form === 'relief'/);
  assert.match(modelSrc, /REALISTIC_DISTANCE_FACTOR/);
});

test('M9h: 形状判定独立成模块（有单测，真 GLB 跑）', () => {
  const shapeSrc = read('petAssetShape.ts');
  assert.match(shapeSrc, /export const PLATE_DEPTH_RATIO/);
  assert.match(shapeSrc, /export function isPlateLike/);
  // 真逻辑单测：跑的是仓库里真的 GLB
  assert.ok(existsSync(join(projectRoot, 'tests', 'petAssetShape.test.mjs')), '缺少 petAssetShape.test.mjs');
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/petAssetShape.test.mjs'), 'petAssetShape.test.mjs 未登记进 test 脚本');
});

test('M11: 写实真人模型与转盘序列已进仓（第三形态不再是「待生成」）', () => {
  // 槽位文件：名字只表示「第三形态的模型位」，不表示实现方式
  for (const name of ['khy-pet-female-realistic.glb', 'khy-pet-male-realistic.glb']) {
    const p = join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models', name);
    assert.ok(existsSync(p), `缺少真人模型 ${name}`);
    const size = statSync(p).size;
    assert.ok(size > 50 * 1024, `${name} 太小（${size}），多半没烘出来`);
    assert.ok(size < 4 * 1024 * 1024, `${name} 太大（${size}），内联后渲染包会爆`);
  }
  // 无 WebGL 环境下的 2.5D 兜底
  for (const name of ['khy-pet-female-realistic-turntable.png', 'khy-pet-male-realistic-turntable.png']) {
    assert.ok(
      existsSync(join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models', name)),
      `缺少真人转盘序列 ${name}`,
    );
  }
});

// ── M9e: 形态切换后画布不能被「失败态」粘住 ──────────────────────
//
// 实测抓到的真 bug：清理期把 sprite.src 置空会触发一次 error 事件，
// 而 onerror 无条件 setFailed(true) —— 于是用户切一次形态，画布就永久
// 变成静态 <img>，之后再切任何形态都不再渲染 3D。

test('M9e: 切形态不会把画布永久换成静态图', () => {
  // onerror 必须先看 disposed：清理期的 error 不是「资产加载失败」
  assert.match(modelSrc, /sprite\.onerror = \(\) => \{[\s\S]*?if \(disposed\) return[\s\S]*?setFailed\(true\)/);
  // 换形态/换角色时清掉上一形态的失败态
  assert.match(modelSrc, /setFailed\(false\)/);
});

test('M9f: 打包版必须有 WebGL（3D 形态的前提）', () => {
  const mainSrc = readFileSync(join(projectRoot, 'src', 'main', 'index.ts'), 'utf-8');
  // 不能整体关掉 GPU：那样整个进程没有 WebGL，3D 形态只剩一张平面图
  assert.doesNotMatch(mainSrc, /app\.disableHardwareAcceleration\(\)/);
  assert.doesNotMatch(mainSrc, /appendSwitch\('disable-gpu'\)/);
  assert.doesNotMatch(mainSrc, /appendSwitch\('disable-software-rasterizer'\)/);
  // 没显卡的机器要能走软件光栅化兜底
  assert.match(mainSrc, /appendSwitch\('enable-unsafe-swiftshader'\)/);
});

test('M9g: 画布身份跟着渲染路径走（切形态不留上一形态的旧画面）', () => {
  // 一块画布只能有一种上下文：被 WebGL 绑过之后 getContext('2d') 返回 null，
  // 2D 兜底就画不出东西，画布上只剩**上一形态的旧画面** —— 看着像这个形态，
  // 其实不是。key 必须区分两条路径，换路径就换一块新画布。
  assert.match(modelSrc, /const canvasKey = glbData \? 'webgl' : '2d'/);
  assert.match(modelSrc, /key=\{canvasKey\}/);
  // 拿不到 2D 上下文时直接落回静态图，不留旧画面
  assert.match(modelSrc, /if \(!spriteCtx\)/);
  // 画布始终渲染：失败态用静态图盖在上面，而不是把画布换掉
  // （换掉的话画布就不在 DOM 里，effect 拿不到它、也就无法在换形态时重初始化，
  //   失败态会永久粘住）。
  assert.match(modelSrc, /\{failed && \(/);
});

// ── M10: 资产管线（真人模型要能自动到位） ───────────────────────
//
// 写实真人 GLB 由 scripts/brand/build-pet-realistic.py 归一化后落到
// delivery/brand/pet/models/，再由 scripts/brand/build-brand-assets.js 分发。
// 只扫顶层的分发脚本会**整个漏掉 models/ 目录**（之前的 Q 版模型就是手工拷的），
// 所以这里锁死「递归分发」这条。

test('M10: 资产管线：models/ 递归分发 + Blender 归一化脚本在位', () => {
  const repoRoot = join(projectRoot, '..', '..');
  const brandScriptPath = join(repoRoot, 'scripts', 'brand', 'build-brand-assets.js');
  assert.ok(existsSync(brandScriptPath), '缺少 scripts/brand/build-brand-assets.js');
  const brandScript = readFileSync(brandScriptPath, 'utf-8');
  assert.match(brandScript, /const petModelsDir = path\.join\(petSrcDir, 'models'\)/);
  assert.match(brandScript, /walkModels/);
  assert.match(brandScript, /apps\/khyos-desktop\/src\/renderer\/assets\/pet/);

  const realisticScriptPath = join(repoRoot, 'scripts', 'brand', 'build-pet-realistic.py');
  assert.ok(existsSync(realisticScriptPath), '缺少 scripts/brand/build-pet-realistic.py');
  const realisticScript = readFileSync(realisticScriptPath, 'utf-8');
  // 朝向与尺度必须归一化：不同服务的输出约定不一致
  assert.match(realisticScript, /export_yup=True/);
  assert.match(realisticScript, /TARGET_HEIGHT = 1\.05/);
  assert.match(realisticScript, /def strip_stray_geometry/);
  // 36 帧转盘 + 6×6 精灵表（无 WebGL 环境的兜底）
  assert.match(realisticScript, /SPRITE_FRAMES = SPRITE_COLS \* SPRITE_ROWS/);
  assert.match(realisticScript, /def assemble_sheet/);
});

test('M10b: 新测试文件已登记进 package.json 的 test 脚本', () => {
  const script = pkg.scripts?.test || '';
  assert.ok(script.includes('tests/petForms.test.mjs'), 'petForms.test.mjs 未登记');
});
