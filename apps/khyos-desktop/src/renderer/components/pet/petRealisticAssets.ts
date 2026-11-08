/**
 * petRealisticAssets —— 「真人」形态（第三形态）的资产登记表。
 *
 * 写实真人 3D 模型落在**一个固定的槽位**上：
 * `delivery/brand/pet/models/khy-pet-{female,male}-realistic.glb`，
 * 再由 scripts/brand/build-brand-assets.js 分发到各端。
 *
 * 槽位名只表示「这是第三形态的模型位」，**不表示实现方式**。现在装的是
 * scripts/brand/build-pet-realistic-relief.py 烘出来的浮雕派生 2.5D 网格
 * （真人立绘 + 厚度 + 起伏）；外部 AI 3D 服务（image-to-3D：真人立绘 → GLB）
 * 出真扫描网格后，经 scripts/brand/build-pet-realistic.py 归一化，用**同名文件
 * 覆盖**即可 —— 渲染端不用改代码（自转策略按网格形状自动切换，见 petAssetShape.ts）。
 *
 * 资产进仓之前，这一形态必须**可选**：设置里能选、卡片能切到，
 * 但构建不能挂、画布也不能空。
 *
 * 为什么用 import.meta.glob 而不是静态 import：
 *   静态 import 在文件不存在时会把整个渲染层构建打挂（rollup 解析不到模块）。
 *   glob 按**匹配结果**生成 import：一个都没匹配上时它就是一张空表，
 *   构建照过，运行时按「资产缺失」降级到立绘。资产进仓后，下一次构建
 *   自动把它接上，不需要改任何代码。
 *
 * ?inline 内联是必须的：打包后的渲染层跑在 file:// 上，
 * Chromium 拒绝 fetch(file://…)，模型字节不能走运行时 fetch。
 */

import type { PetCharacterId } from './petFortune'

type AssetMap = Record<string, string>

/** 写实真人 GLB。 */
const realisticGlbMap = import.meta.glob('../../assets/pet/models/*-realistic.glb', {
  eager: true,
  import: 'default',
  query: '?inline',
}) as AssetMap

/** 写实真人的 36 帧转盘序列（没有 WebGL 的环境下的 2.5D 兜底）。 */
const realisticSheetMap = import.meta.glob('../../assets/pet/models/*-realistic-turntable.png', {
  eager: true,
  import: 'default',
  query: '?inline',
}) as AssetMap

/** 按文件名从 glob 表里取一份资产（glob 的键是带前导路径的）。 */
function pick(map: AssetMap, fileName: string): string | null {
  for (const key of Object.keys(map)) {
    if (key.endsWith('/' + fileName)) return map[key]
  }
  return null
}

/** 写实真人 GLB（data URL）；资产未进仓时返回 null。 */
export function realisticGlb(characterId: PetCharacterId): string | null {
  return pick(realisticGlbMap, `khy-pet-${characterId}-realistic.glb`)
}

/** 写实真人的转盘序列（data URL）；资产未进仓时返回 null。 */
export function realisticTurntable(characterId: PetCharacterId): string | null {
  return pick(realisticSheetMap, `khy-pet-${characterId}-realistic-turntable.png`)
}

/** 该角色的写实真人资产是否已就位（设置页与卡片据此提示「待生成」）。 */
export function hasRealisticAssets(characterId: PetCharacterId): boolean {
  return realisticGlb(characterId) !== null || realisticTurntable(characterId) !== null
}
