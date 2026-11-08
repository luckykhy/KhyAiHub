/**
 * glbLoader —— 桌宠 3D 模型解析器的真逻辑测试。
 *
 * 跑的是真的 GLB 文件（Blender 导出的真模型），不是 mock：
 * 解析器读不出网格/材质/商标贴图，桌宠在应用里就是一块黑屏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  parseGlb,
  dataUrlToBytes,
  mat4Multiply,
  mat4Identity,
} = await import('../src/renderer/components/pet/glbLoader.ts')

const projectRoot = join(import.meta.dirname, '..')
const modelDir = join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'models')

function loadModel(name) {
  const bytes = readFileSync(join(modelDir, name))
  return parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

test('GLB 头部与 JSON/BIN chunk 都能解析', () => {
  const bytes = readFileSync(join(modelDir, 'khy-pet-female.glb'))
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'magic 应为 glTF')
  assert.equal(bytes.readUInt32LE(4), 2, 'version 应为 2')
  const scene = loadModel('khy-pet-female.glb')
  assert.ok(scene.primitives.length > 0, '没有任何绘制项')
})

test('澪的模型：有网格、有材质、有商标贴图', () => {
  const scene = loadModel('khy-pet-female.glb')
  assert.ok(scene.primitives.length >= 5, `绘制项太少：${scene.primitives.length}`)
  for (const primitive of scene.primitives) {
    assert.ok(primitive.position.length > 0, '存在空网格')
    assert.equal(primitive.position.length % 3, 0, 'position 必须是 xyz 交错')
    assert.equal(primitive.normal.length, primitive.position.length, '法线数须与顶点数一致')
    assert.ok(primitive.indices.length > 0, '索引为空')
    assert.equal(primitive.indices.length % 3, 0, '索引必须是三角形的整数倍')
    assert.ok(primitive.baseColor.some((c) => c > 0), '基础色不应全黑')
  }
  // 真商标贴图：护身符上的 Khy OS 标记（PNG 字节）
  const withTexture = scene.primitives.filter((p) => p.texture)
  assert.ok(withTexture.length > 0, '模型里没有找到贴图（护身符商标丢了）')
  assert.equal(withTexture[0].texture.mimeType, 'image/png')
  assert.ok(withTexture[0].texture.data.length > 1000, '贴图字节过少')
  // PNG 魔数
  const magic = Array.from(withTexture[0].texture.data.slice(0, 4))
  assert.deepEqual(magic, [0x89, 0x50, 0x4e, 0x47])
})

test('凯的模型同样可解析且带胸章贴图', () => {
  const scene = loadModel('khy-pet-male.glb')
  assert.ok(scene.primitives.length >= 5, `绘制项太少：${scene.primitives.length}`)
  assert.ok(scene.primitives.some((p) => p.texture), '凯的模型没有胸章贴图')
})

test('包围盒可用于摆相机（底座贴地、尺寸为正）', () => {
  const scene = loadModel('khy-pet-female.glb')
  const { min, max } = scene.bounds
  assert.ok(Number.isFinite(min[0]) && Number.isFinite(max[0]), '包围盒不是有限数')
  assert.ok(max[1] > min[1], '高度为负')
  assert.ok(max[0] - min[0] > 0.2, '宽度异常')
  assert.ok(max[1] - min[1] > 0.5, '高度异常（模型应约 1 个单位高）')
  assert.ok(min[1] > -0.05, '底座应贴地（y 最小值接近 0）')
})

test('顶点坐标不是全零：bufferView 索引 0 是 falsy 的坑', () => {
  // 回归：`if (!accessor.bufferView)` 会把索引 0 误判成「没有 bufferView」，
  // 于是第一个网格拿到一份全零顶点 —— 模型里表现为呆毛凭空消失，
  // 浮雕里表现为整块角色塌成原点、画布上一片空白。
  for (const name of ['khy-pet-female.glb', 'khy-pet-male.glb', 'khy-pet-female-relief.glb']) {
    const scene = loadModel(name)
    for (const [i, primitive] of scene.primitives.entries()) {
      let nonZero = 0
      for (let k = 0; k < primitive.position.length; k += 1) {
        if (primitive.position[k] !== 0) nonZero += 1
      }
      assert.ok(
        nonZero > 0,
        `${name} 第 ${i} 个网格的顶点全是 0（bufferView 索引 0 被当成空）`,
      )
    }
  }
})

test('立绘浮雕：角色正立（Y 向上）、正面朝 +Z、有厚度', () => {
  const scene = loadModel('khy-pet-female-relief.glb')
  assert.equal(scene.primitives.length, 1, '浮雕应是一个整体网格')
  const { min, max } = scene.bounds
  // 高度沿 Y（glTF 是 Y-up）：脚下贴地、头朝 +Y
  assert.ok(min[1] > -0.05 && max[1] > 0.8, `高度轴不对：y=${min[1]}..${max[1]}`)
  // 厚度沿 Z：很薄，但不为零（有厚度才叫浮雕）
  const thickness = max[2] - min[2]
  assert.ok(thickness > 0.01, `浮雕没有厚度：${thickness}`)
  assert.ok(thickness < 0.3, `浮雕厚得像块砖：${thickness}`)
  // 宽度
  assert.ok(max[0] - min[0] > 0.3, '宽度异常')
  // 贴图：立绘本身（带 alpha 的抠图 PNG）
  const texture = scene.primitives[0].texture
  assert.ok(texture, '浮雕没有贴图')
  assert.equal(texture.mimeType, 'image/png')
  assert.ok(texture.data.length > 100000, '浮雕贴图字节过少')
})

test('data URL 能还原出原始字节', () => {
  const bytes = readFileSync(join(modelDir, 'khy-pet-male.glb'))
  const base64 = bytes.toString('base64')
  const restored = dataUrlToBytes(`data:model/gltf-binary;base64,${base64}`)
  assert.equal(restored.length, bytes.length)
  assert.deepEqual(Array.from(restored.slice(0, 8)), Array.from(bytes.slice(0, 8)))
})

test('矩阵乘法满足单位矩阵性质', () => {
  const m = mat4Multiply(mat4Identity(), mat4Identity())
  for (let i = 0; i < 16; i += 1) {
    const expected = i % 5 === 0 ? 1 : 0
    assert.equal(m[i], expected)
  }
})
