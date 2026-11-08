/**
 * petAssetShape —— 桌宠 3D 资产「板状 / 立体」判定的真逻辑测试。
 *
 * 跑的是仓库里**真的 GLB 文件**（Blender 导出的真模型），不是 mock：
 * 判据要是错的，板状资产就会被整圈转台转过去 —— 侧面只剩一条边、
 * 背面还是镜像，用户看到的是「模型坏了」而不是「这是块浮雕」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { parseGlb } = await import('../src/renderer/components/pet/glbLoader.ts')
const { isPlateLike, PLATE_DEPTH_RATIO } = await import('../src/renderer/components/pet/petAssetShape.ts')

const projectRoot = join(import.meta.dirname, '..')
const modelDir = join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models')

function loadBounds(name) {
  const bytes = readFileSync(join(modelDir, name))
  return parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).bounds
}

const bounds = (min, max) => ({ min, max })

test('板状判定：深度不足高度的这个比例就是平板', () => {
  // 高度 1、深度 0.06 —— 真人浮雕那一类
  assert.equal(isPlateLike(bounds([0, 0, 0], [0.3, 1, 0.06])), true)
  // 高度 1、深度 0.5 —— 立体网格
  assert.equal(isPlateLike(bounds([0, 0, 0], [0.6, 1, 0.5])), false)
  // 高度 1、深度正好卡在阈值上 —— 不算平板（立体那一侧）
  assert.equal(isPlateLike(bounds([0, 0, 0], [0.6, 1, PLATE_DEPTH_RATIO])), false)
  // 阈值下方一丁点 —— 算平板
  assert.equal(isPlateLike(bounds([0, 0, 0], [0.6, 1, PLATE_DEPTH_RATIO - 0.001])), true)
})

test('板状判定：坏数据不误判成平板', () => {
  // 高度为 0（模型没烘出来 / 顶点全零）→ 不当平板，按立体处理，
  // 免得一个空模型被当成浮雕锁死角度。
  assert.equal(isPlateLike(bounds([0, 0, 0], [0, 0, 0])), false)
  assert.equal(isPlateLike(bounds([0, 0, 0], [0.3, 0, 0.01])), false)
})

test('立绘浮雕（第一形态）是板状', () => {
  for (const name of ['khy-pet-female-relief.glb', 'khy-pet-male-relief.glb']) {
    assert.ok(existsSync(join(modelDir, name)), `缺少浮雕模型 ${name}`)
    assert.equal(isPlateLike(loadBounds(name)), true, `${name} 应判为板状`)
  }
})

test('Q 版立体模型（第二形态）不是板状', () => {
  for (const name of ['khy-pet-female.glb', 'khy-pet-male.glb']) {
    assert.ok(existsSync(join(modelDir, name)), `缺少模型 ${name}`)
    assert.equal(isPlateLike(loadBounds(name)), false, `${name} 应判为立体`)
  }
})

test('写实真人模型（第三形态槽位）是板状 —— 现在装的是浮雕派生的 2.5D 网格', () => {
  // 槽位名只表示「第三形态的模型位」，不表示实现方式：
  // 外部服务给出真扫描网格后同名覆盖，这两条断言会自己翻过来
  //（那时深度/高度比会远大于阈值）。
  for (const name of ['khy-pet-female-realistic.glb', 'khy-pet-male-realistic.glb']) {
    assert.ok(existsSync(join(modelDir, name)), `缺少真人模型 ${name}`)
    assert.equal(isPlateLike(loadBounds(name)), true, `${name} 应判为板状`)
  }
})
