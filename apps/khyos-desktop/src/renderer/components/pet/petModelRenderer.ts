/**
 * petModelRenderer —— 原生 WebGL 的桌宠渲染器（零依赖）。
 *
 * 本仓的 3D 约定是手写 WebGL（见 delivery/web/ai-frontend/src/webgl/khyAura3d.js：
 * 「no three.js, native WebGL only」），这里沿用同一手法：GLSL ES 1.00，
 * WebGL2 优先、回落 WebGL1。
 *
 * 做的是**够用**的渲染，不是 PBR：基础色 + 方向光漫反射 + 一档高光 + 至多一张贴图。
 * 桌宠在 130px 上下，多一个 roughness 通道也看不出来。
 *
 * 透明背景：画布 alpha 开着、清屏用 (0,0,0,0)，桌宠卡片可以直接叠在界面���。
 */

import { parseGlb, type GlbPrimitive, type GlbScene } from './glbLoader'

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uProjection;
uniform mat4 uView;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vPosition;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  vPosition = aPosition;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vPosition;
uniform vec4 uBaseColor;
uniform float uMetallic;
uniform float uRoughness;
uniform float uHasTexture;
uniform sampler2D uTexture;
uniform vec3 uLightDir;
void main() {
  vec3 n = normalize(vNormal);
  // 光跟着相机走（头灯）：写死方向的话，模型一转、背对光就黑成剪影。
  vec3 l = normalize(uLightDir);
  vec3 v = normalize(-vPosition);
  vec3 h = normalize(l + v);
  vec3 base = uBaseColor.rgb;
  float alpha = uBaseColor.a;
  float textured = 0.0;
  if (uHasTexture > 0.5) {
    vec4 texel = texture2D(uTexture, vUv);
    // 贴图（PNG）是 sRGB 编码的，材质 Base Color 是线性值。先把贴图转回线性，
    // 让后面的光照运算全程在线性空间，最后统一转回 sRGB 输出。
    // 少这一步，立绘浮雕会整体发白（sRGB 值被当线性用，再被 1/2.2 提亮一次）。
    base *= pow(max(texel.rgb, vec3(0.0)), vec3(2.2));
    alpha *= texel.a;
    textured = 1.0;
  }
  float diffuse = max(dot(n, l), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35;
  float shininess = mix(8.0, 64.0, 1.0 - clamp(uRoughness, 0.0, 1.0));
  float specular = pow(max(dot(n, h), 0.0), shininess) * (0.12 + 0.45 * uMetallic);
  // 画出来的表面（立绘浮雕、护身符上的真商标）用**平缓**的明暗：画面要认得出是
  // 哪一张图，不能被光照重新塑形。没贴图的 3D 模型面保留完整明暗，那才有体积感。
  float lit = mix(0.42 + 0.68 * diffuse, 0.82 + 0.26 * diffuse, textured);
  specular *= mix(1.0, 0.25, textured);
  rim *= mix(1.0, 0.35, textured);
  vec3 color = base * lit + vec3(specular) + base * rim;
  // 线性 → sRGB：材质的 Base Color 是线性值（与 Blender 一致），直接写进画布会
  // 整体偏暗（深藏青会变成近黑）。这一步不做，应用里的模型就永远不像定妆照。
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(color, alpha);
}
`

interface GpuPrimitive {
  primitive: GlbPrimitive
  positionBuffer: WebGLBuffer
  normalBuffer: WebGLBuffer
  uvBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer
  texture: WebGLTexture | null
}

export interface PetModelRenderer {
  setScene(scene: GlbScene): void
  setRotation(yaw: number, pitch: number): void
  setSize(width: number, height: number): void
  render(): void
  dispose(): void
  readonly ready: boolean
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('cannot create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error('shader compile failed: ' + log)
  }
  return shader
}

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}

function lookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const zx = eye[0] - center[0]
  const zy = eye[1] - center[1]
  const zz = eye[2] - center[2]
  let len = Math.hypot(zx, zy, zz) || 1
  const z = [zx / len, zy / len, zz / len]
  let xx = up[1] * z[2] - up[2] * z[1]
  let xy = up[2] * z[0] - up[0] * z[2]
  let xz = up[0] * z[1] - up[1] * z[0]
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len; xy /= len; xz /= len
  const y = [z[1] * xz - z[2] * xy, z[2] * xx - z[0] * xz, z[0] * xy - z[1] * xx]
  return new Float32Array([
    xx, y[0], z[0], 0,
    xy, y[1], z[1], 0,
    xz, y[2], z[2], 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ])
}

export interface PetModelRendererOptions {
  /**
   * 相机距离系数：distance = 包围盒尺寸 × 该系数。越小离得越近、角色越大。
   * 立绘浮雕用 1.95（定妆照四周留白多，默认的 2.6 会让角色只占画布一半）；
   * 真 3D 模型用默认的 2.6（本身已经按底座对齐构图）。
   */
  distanceFactor?: number
}

export function createPetModelRenderer(
  canvas: HTMLCanvasElement,
  options: PetModelRendererOptions = {},
): PetModelRenderer {
  const distanceFactor = options.distanceFactor ?? 2.6
  const gl = (canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    // 着色器输出的是**直通 alpha**（vec4(color, a)），画布也必须按直通方式合成。
    // 声明成 premultiplied 会让半透明边缘被乘两次 alpha，浮雕的羽化边就发黑。
    premultipliedAlpha: false,
    // 保留绘制缓冲：否则合成之后 readPixels 读不到内容（截屏/自检都取不到像素）。
    preserveDrawingBuffer: true,
  }) || canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  })) as WebGLRenderingContext | null
  if (!gl) throw new Error('WebGL unavailable')

  const program = gl.createProgram()
  if (!program) throw new Error('cannot create program')
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(program))
  }
  gl.useProgram(program)

  const attrPosition = gl.getAttribLocation(program, 'aPosition')
  const attrNormal = gl.getAttribLocation(program, 'aNormal')
  const attrUv = gl.getAttribLocation(program, 'aUv')
  const uniformProjection = gl.getUniformLocation(program, 'uProjection')
  const uniformView = gl.getUniformLocation(program, 'uView')
  const uniformBaseColor = gl.getUniformLocation(program, 'uBaseColor')
  const uniformMetallic = gl.getUniformLocation(program, 'uMetallic')
  const uniformRoughness = gl.getUniformLocation(program, 'uRoughness')
  const uniformHasTexture = gl.getUniformLocation(program, 'uHasTexture')
  const uniformLightDir = gl.getUniformLocation(program, 'uLightDir')
  const uniformTexture = gl.getUniformLocation(program, 'uTexture')

  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  let gpuPrimitives: GpuPrimitive[] = []
  let bounds = { min: [0, 0, 0], max: [1, 1, 1] }
  let yaw = 0
  let pitch = 0
  let width = canvas.width || 132
  let height = canvas.height || 132
  let disposed = false

  const uploadTexture = async (bytes: Uint8Array, mimeType: string): Promise<WebGLTexture | null> => {
    try {
      const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
      const bitmap = await createImageBitmap(blob)
      const texture = gl.createTexture()
      if (!texture) return null
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      bitmap.close?.()
      return texture
    } catch {
      return null
    }
  }

  const disposeScene = () => {
    for (const item of gpuPrimitives) {
      gl.deleteBuffer(item.positionBuffer)
      gl.deleteBuffer(item.normalBuffer)
      if (item.uvBuffer) gl.deleteBuffer(item.uvBuffer)
      gl.deleteBuffer(item.indexBuffer)
      if (item.texture) gl.deleteTexture(item.texture)
    }
    gpuPrimitives = []
  }

  return {
    get ready() {
      return gpuPrimitives.length > 0
    },

    setScene(scene: GlbScene) {
      disposeScene()
      bounds = scene.bounds
      for (const primitive of scene.primitives) {
        const positionBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, primitive.position, gl.STATIC_DRAW)

        const normalBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, primitive.normal, gl.STATIC_DRAW)

        let uvBuffer: WebGLBuffer | null = null
        if (primitive.uv) {
          uvBuffer = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
          gl.bufferData(gl.ARRAY_BUFFER, primitive.uv, gl.STATIC_DRAW)
        }

        const indexBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, primitive.indices, gl.STATIC_DRAW)

        gpuPrimitives.push({
          primitive,
          positionBuffer,
          normalBuffer,
          uvBuffer,
          indexBuffer,
          texture: null,
        })
      }
      // 贴图是异步解码（createImageBitmap），解码完再挂到各自的绘制项上。
      gpuPrimitives.forEach((item, index) => {
        const source = scene.primitives[index].texture
        if (!source) return
        void uploadTexture(source.data, source.mimeType).then((texture) => {
          if (disposed || !texture) return
          item.texture = texture
        })
      })
    },

    setRotation(nextYaw: number, nextPitch: number) {
      yaw = nextYaw
      pitch = Math.max(-0.9, Math.min(0.9, nextPitch))
    },

    setSize(nextWidth: number, nextHeight: number) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      canvas.width = width
      canvas.height = height
    },

    render() {
      if (disposed) return
      gl.viewport(0, 0, width, height)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      if (gpuPrimitives.length === 0) return

      const cx = (bounds.min[0] + bounds.max[0]) / 2
      const cy = (bounds.min[1] + bounds.max[1]) / 2
      const cz = (bounds.min[2] + bounds.max[2]) / 2
      const size = Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) || 1
      const distance = size * distanceFactor
      const eye = [
        cx + Math.sin(yaw) * Math.cos(pitch) * distance,
        cy + Math.sin(pitch) * distance,
        cz + Math.cos(yaw) * Math.cos(pitch) * distance,
      ]
      const projection = perspective(Math.PI / 4, width / height, size * 0.05, distance * 4)
      const view = lookAt(eye, [cx, cy, cz], [0, 1, 0])

      gl.useProgram(program)
      gl.uniformMatrix4fv(uniformProjection, false, projection)
      gl.uniformMatrix4fv(uniformView, false, view)
      // 头灯：光从相机打向模型中心（世界坐标），模型转到哪一面都有光。
      const lx = eye[0] - cx
      const ly = eye[1] - cy
      const lz = eye[2] - cz + size * 0.6
      const ll = Math.hypot(lx, ly, lz) || 1
      gl.uniform3f(uniformLightDir, lx / ll, ly / ll, lz / ll)

      for (const item of gpuPrimitives) {
        const { primitive } = item
        gl.bindBuffer(gl.ARRAY_BUFFER, item.positionBuffer)
        gl.enableVertexAttribArray(attrPosition)
        gl.vertexAttribPointer(attrPosition, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, item.normalBuffer)
        gl.enableVertexAttribArray(attrNormal)
        gl.vertexAttribPointer(attrNormal, 3, gl.FLOAT, false, 0, 0)

        if (item.uvBuffer && primitive.uv && attrUv >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, item.uvBuffer)
          gl.enableVertexAttribArray(attrUv)
          gl.vertexAttribPointer(attrUv, 2, gl.FLOAT, false, 0, 0)
        } else if (attrUv >= 0) {
          gl.disableVertexAttribArray(attrUv)
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, item.indexBuffer)
        gl.uniform4fv(uniformBaseColor, primitive.baseColor)
        gl.uniform1f(uniformMetallic, primitive.metallic)
        gl.uniform1f(uniformRoughness, primitive.roughness)
        if (item.texture) {
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, item.texture)
          gl.uniform1i(uniformTexture, 0)
          gl.uniform1f(uniformHasTexture, 1)
        } else {
          gl.uniform1f(uniformHasTexture, 0)
        }
        gl.drawElements(gl.TRIANGLES, primitive.indices.length, gl.UNSIGNED_INT, 0)
      }

    },

    dispose() {
      disposed = true
      disposeScene()
      gl.deleteProgram(program)
    },
  }
}

/** 便捷入口：给 GLB 字节建一个渲染器并装载场景。 */
export async function createPetModelFromBytes(
  canvas: HTMLCanvasElement,
  bytes: Uint8Array,
): Promise<PetModelRenderer> {
  const renderer = createPetModelRenderer(canvas)
  const scene = parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  renderer.setScene(scene)
  return renderer
}
