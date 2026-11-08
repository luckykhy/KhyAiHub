/**
 * glbLoader —— 纯逻辑的二进制 glTF（GLB）解析器。
 *
 * 零依赖、可在 node 里直接跑（测试就是这么测的），只做一件事：
 * 把 GLB 解成「一串可以直接喂给 WebGL 的绘制项」。
 *
 * 为什么自己写而不用现成 gltf 库：本仓明确不引 three.js（见
 * delivery/web/ai-frontend/src/webgl/khyAura3d.js 的「no three.js」约定），
 * 而桌宠模型只需要 POSITION/NORMAL/UV + 一个基础色 + 至多一张贴图。
 *
 * 两处关键取舍：
 *  1. 节点变换**烘进顶点**：遍历场景图算世界矩阵，直接把顶点变换好，
 *     渲染端就只需要按 primitive 逐个 draw，不必实现完整场景图。
 *  2. 图片以原始字节 + mimeType 交出（不自己解 PNG），解码交给浏览器
 *     的 createImageBitmap —— 浏览器解码 PNG 比手写解码器靠谱。
 */

export interface GlbTexture {
  /** 图片原始字节（PNG/JPEG） */
  data: Uint8Array
  mimeType: string
}

export interface GlbPrimitive {
  /** 顶点位置（已烘焙世界变换），xyz 交错 */
  position: Float32Array
  /** 法线（已烘焙世界变换），xyz 交错 */
  normal: Float32Array
  /** UV（可能没有） */
  uv: Float32Array | null
  /** 三角索引 */
  indices: Uint32Array
  /** 基础色（线性空间，rgba） */
  baseColor: [number, number, number, number]
  metallic: number
  roughness: number
  /** 至多一张贴图（护身符/胸章上的真商标） */
  texture: GlbTexture | null
}

export interface GlbBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface GlbScene {
  primitives: GlbPrimitive[]
  bounds: GlbBounds
}

const MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

const COMPONENT_FLOAT = 5126
const COMPONENT_UNSIGNED_SHORT = 5123
const COMPONENT_UNSIGNED_INT = 5125
const COMPONENT_UNSIGNED_BYTE = 5121
const COMPONENT_BYTE = 5120
const COMPONENT_SHORT = 5122

type Json = Record<string, any>

// ── 4x4 矩阵（列主序，与 glTF 一致） ────────────────────────────────

export type Mat4 = Float32Array

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = sum
    }
  }
  return out
}

export function mat4FromNode(node: Json): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return new Float32Array(node.matrix)
  }
  const t = node.translation ?? [0, 0, 0]
  const r = node.rotation ?? [0, 0, 0, 1]
  const s = node.scale ?? [1, 1, 1]
  // T * R * S
  const [x, y, z, w] = r
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  const m = new Float32Array(16)
  m[0] = (1 - (yy + zz)) * s[0]
  m[1] = (xy + wz) * s[0]
  m[2] = (xz - wy) * s[0]
  m[3] = 0
  m[4] = (xy - wz) * s[1]
  m[5] = (1 - (xx + zz)) * s[1]
  m[6] = (yz + wx) * s[1]
  m[7] = 0
  m[8] = (xz + wy) * s[2]
  m[9] = (yz - wx) * s[2]
  m[10] = (1 - (xx + yy)) * s[2]
  m[11] = 0
  m[12] = t[0]
  m[13] = t[1]
  m[14] = t[2]
  m[15] = 1
  return m
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/** 法线用世界矩阵的 3x3 部分转置（模型只有旋转与等比缩放，转置即逆转置）。 */
function transformNormal(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const nx = m[0] * x + m[4] * y + m[8] * z
  const ny = m[1] * x + m[5] * y + m[9] * z
  const nz = m[2] * x + m[6] * y + m[10] * z
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

// ── accessor 读取 ─────────────────────────────────────────────────

const COMPONENT_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

function readComponent(view: DataView, byteOffset: number, componentType: number): number {
  switch (componentType) {
    case COMPONENT_FLOAT:
      return view.getFloat32(byteOffset, true)
    case COMPONENT_UNSIGNED_SHORT:
      return view.getUint16(byteOffset, true)
    case COMPONENT_UNSIGNED_BYTE:
      return view.getUint8(byteOffset)
    case COMPONENT_BYTE:
      return view.getInt8(byteOffset)
    case COMPONENT_SHORT:
      return view.getInt16(byteOffset, true)
    case COMPONENT_UNSIGNED_INT:
      return view.getUint32(byteOffset, true)
    default:
      throw new Error('unsupported componentType ' + componentType)
  }
}

function normalizeComponent(value: number, componentType: number): number {
  switch (componentType) {
    case COMPONENT_UNSIGNED_BYTE:
      return value / 255
    case COMPONENT_BYTE:
      return Math.max(value / 127, -1)
    case COMPONENT_SHORT:
      return Math.max(value / 32767, -1)
    case COMPONENT_UNSIGNED_SHORT:
      return value / 65535
    default:
      return value
  }
}

/**
 * 读一个 accessor，返回交错展开的 Float32Array（每元素 components 个分量）。
 * 索引单独走 readIndices（不归一化）。
 */
export function readAccessor(json: Json, bin: Uint8Array, accessorIndex: number): {
  data: Float32Array
  components: number
} {
  const accessor = json.accessors?.[accessorIndex]
  if (!accessor) throw new Error('missing accessor ' + accessorIndex)
  const components = COMPONENT_COUNT[accessor.type] ?? 1
  const count = accessor.count ?? 0
  const out = new Float32Array(count * components)
  // ⚠ 不能写成 `if (!accessor.bufferView)`：bufferView 索引 **0** 是合法的，
  // 而 `!0 === true` —— 第一个网格会拿到一份全零顶点（模型里表现为「模型塌了/
  // 浮雕整块消失」）。必须显式判空。
  if (accessor.bufferView === undefined || accessor.bufferView === null) {
    return { data: out, components }
  }

  const view = json.bufferViews?.[accessor.bufferView]
  if (!view) throw new Error('missing bufferView ' + accessor.bufferView)
  // ⚠ 切片已经把 bufferView 的起点裁掉了，所以这里的偏移是**相对 bufferView** 的：
  //   elementStart = accessor.byteOffset + i * stride
  // 之前这里又加了一次 view.byteOffset，等于把偏移算了两遍 —— 顶点全部读错位，
  // 模型会塌成一小团，画面看着像什么都没画。
  const base = accessor.byteOffset ?? 0
  const stride = view.byteStride ?? 0
  const viewStart = bin.byteOffset + (view.byteOffset ?? 0)
  const viewBytes = bin.buffer.slice(viewStart, viewStart + view.byteLength)
  const viewView = new DataView(viewBytes)

  for (let i = 0; i < count; i += 1) {
    const elementStart = base + (stride > 0 ? i * stride : i * components * 4)
    for (let c = 0; c < components; c += 1) {
      const componentOffset = elementStart + c * 4
      if (componentOffset + 4 > viewView.byteLength) {
        out[i * components + c] = 0
        continue
      }
      const raw = readComponent(viewView, componentOffset, accessor.componentType)
      out[i * components + c] = accessor.normalized ? normalizeComponent(raw, accessor.componentType) : raw
    }
  }
  return { data: out, components }
}

function readIndices(json: Json, bin: Uint8Array, accessorIndex: number): Uint32Array {
  const accessor = json.accessors?.[accessorIndex]
  if (!accessor) throw new Error('missing index accessor ' + accessorIndex)
  const view = json.bufferViews?.[accessor.bufferView]
  const base = (view?.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const out = new Uint32Array(accessor.count ?? 0)
  // 索引分量可能是 UNSIGNED_SHORT(2B) 或 UNSIGNED_INT(4B) —— 按实际分量宽度读。
  const elementSize = accessor.componentType === COMPONENT_UNSIGNED_SHORT ? 2 : 4
  const start = bin.byteOffset + base
  const copy = new Uint8Array(bin.subarray(start, start + out.length * elementSize))
  const viewView = new DataView(copy.buffer)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = elementSize === 2
      ? viewView.getUint16(i * 2, true)
      : viewView.getUint32(i * 4, true)
  }
  return out
}

// ── 主入口 ───────────────────────────────────────────────────────

export function parseGlb(buffer: ArrayBuffer): GlbScene {
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('not a GLB file')
  const version = view.getUint32(4, true)
  if (version !== 2) throw new Error('unsupported GLB version: ' + version)

  let offset = 12
  let json: Json | null = null
  let bin: Uint8Array | null = null
  while (offset + 8 <= view.byteLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const dataStart = offset + 8
    if (chunkType === CHUNK_JSON) {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer, dataStart, chunkLength))
      json = JSON.parse(text)
    } else if (chunkType === CHUNK_BIN) {
      bin = new Uint8Array(buffer.slice(dataStart, dataStart + chunkLength))
    }
    offset = dataStart + chunkLength + ((4 - (chunkLength % 4)) % 4)
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  const binChunk = bin ?? new Uint8Array(0)

  const primitives: GlbPrimitive[] = []
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  const textureCache = new Map<number, GlbTexture | null>()
  const resolveTexture = (materialIndex: number): GlbTexture | null => {
    if (textureCache.has(materialIndex)) return textureCache.get(materialIndex) ?? null
    let result: GlbTexture | null = null
    const material = json?.materials?.[materialIndex]
    const texIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index
    if (typeof texIndex === 'number') {
      const source = json?.textures?.[texIndex]?.source
      const image = typeof source === 'number' ? json?.images?.[source] : null
      if (image && typeof image.bufferView === 'number') {
        const bufferView = json?.bufferViews?.[image.bufferView]
        if (bufferView) {
          const start = binChunk.byteOffset + (bufferView.byteOffset ?? 0)
          result = {
            data: binChunk.slice(start, start + bufferView.byteLength),
            mimeType: image.mimeType ?? 'image/png',
          }
        }
      }
    }
    textureCache.set(materialIndex, result)
    return result
  }

  const nodes: Json[] = json.nodes ?? []
  const emitMesh = (meshIndex: number, world: Mat4) => {
    const mesh = json?.meshes?.[meshIndex]
    if (!mesh) return
    for (const prim of mesh.primitives ?? []) {
      const positionAccessor = prim.attributes?.POSITION
      if (typeof positionAccessor !== 'number') continue
      const position = readAccessor(json, binChunk, positionAccessor)
      const normalAccessor = prim.attributes?.NORMAL
      const normal = typeof normalAccessor === 'number'
        ? readAccessor(json, binChunk, normalAccessor)
        : { data: new Float32Array(position.data.length), components: 3 }
      const uvAccessor = prim.attributes?.TEXCOORD_0
      const uv = typeof uvAccessor === 'number' ? readAccessor(json, binChunk, uvAccessor) : null

      const count = position.data.length / 3
      const bakedPosition = new Float32Array(count * 3)
      const bakedNormal = new Float32Array(count * 3)
      for (let i = 0; i < count; i += 1) {
        const [x, y, z] = transformPoint(world, position.data[i * 3], position.data[i * 3 + 1], position.data[i * 3 + 2])
        bakedPosition[i * 3] = x
        bakedPosition[i * 3 + 1] = y
        bakedPosition[i * 3 + 2] = z
        if (x < min[0]) min[0] = x
        if (y < min[1]) min[1] = y
        if (z < min[2]) min[2] = z
        if (x > max[0]) max[0] = x
        if (y > max[1]) max[1] = y
        if (z > max[2]) max[2] = z

        const [nx, ny, nz] = transformNormal(world, normal.data[i * 3], normal.data[i * 3 + 1], normal.data[i * 3 + 2])
        bakedNormal[i * 3] = nx
        bakedNormal[i * 3 + 1] = ny
        bakedNormal[i * 3 + 2] = nz
      }

      const indices = typeof prim.indices === 'number'
        ? readIndices(json, binChunk, prim.indices)
        : Uint32Array.from({ length: count }, (_, i) => i)

      const materialIndex = typeof prim.material === 'number' ? prim.material : -1
      const material = materialIndex >= 0 ? json?.materials?.[materialIndex] : null
      const factor = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]

      primitives.push({
        position: bakedPosition,
        normal: bakedNormal,
        uv: uv ? uv.data : null,
        indices,
        baseColor: [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1, factor[3] ?? 1],
        metallic: material?.pbrMetallicRoughness?.metallicFactor ?? 1,
        roughness: material?.pbrMetallicRoughness?.roughnessFactor ?? 1,
        texture: materialIndex >= 0 ? resolveTexture(materialIndex) : null,
      })
    }
  }

  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = nodes[nodeIndex]
    if (!node) return
    const world = mat4Multiply(parent, mat4FromNode(node))
    if (typeof node.mesh === 'number') emitMesh(node.mesh, world)
    for (const child of node.children ?? []) visit(child, world)
  }

  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0
  const scene = json.scenes?.[sceneIndex]
  if (scene) {
    for (const root of scene.nodes ?? []) visit(root, mat4Identity())
  } else {
    // 没有场景就按节点顺序兜底
    nodes.forEach((_node, index) => visit(index, mat4Identity()))
  }

  if (!Number.isFinite(min[0])) {
    return { primitives, bounds: { min: [0, 0, 0], max: [0, 0, 0] } }
  }
  return { primitives, bounds: { min, max } }
}

/** data: URL（Vite `?inline` 产物）→ 原始字节。 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('not a data URL')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!meta.includes(';base64')) {
    const decoded = decodeURIComponent(payload)
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i)
    return bytes
  }
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
