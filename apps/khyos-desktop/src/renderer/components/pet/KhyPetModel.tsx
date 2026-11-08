/**
 * KhyPetModel —— 桌宠的 3D 展示层：把 GLB 真模型渲染成可转的桌宠。
 *
 * 三条渲染路径，同一个模型：
 *   ① WebGL 路径 —— 原生 WebGL 加载 GLB，真 3D（可任意角度、可呼吸感的光照）。
 *      仓库不引 three.js（见 delivery/web/ai-frontend/src/webgl/khyAura3d.js 的约定）。
 *   ② 转盘序列路径 —— 没有任何 WebGL 上下文时（虚拟机 / 无显卡 / 被 GPU 开关关掉），
 *      用 Blender 预先渲好的 36 帧旋转序列逐帧贴图。**每一帧都是这个 3D 模型本身的
 *      渲染**，不是另一套图片素材，所以没 GPU 的机器上桌宠照样转得起来。
 *   ③ 两条都不可用 —— 落回 PNG 立绘，桌宠永不消失。
 *
 * 三种形态并存（settings.json 的 desktopPetForm）：
 *   relief    立绘浮雕：定妆照烘出的带厚度 2.5D 网格，像素级最像本人（默认）
 *   model     真 3D Q 版模型：程序化建的 GLB，可整圈转
 *   realistic 写实真人 3D：模型槽位 `khy-pet-*-realistic.glb`，**资产可选**
 *             （没进仓时这一形态退回立绘，并由卡片标出「真人模型待生成」）
 *
 * 「能不能整圈转」按**网格形状**判，不按形态名判（见 petAssetShape.ts）：
 * 板状资产（浮雕，包括现在槽位里的真人浮雕）只做小角度轻摆 —— 整圈转台
 * 会露出侧边，背面还是镜像；立体网格才整圈自转。第三形态的槽位换成外部服务
 * 出的真扫描网格后，自转策略自动切回整圈转，**这里一行都不用改**。
 *
 * 交互分工（别弄反）：
 *   · 在**画布上拖动** = 旋转模型（看不同角度）
 *   · 在**卡片头部拖动** = 移动卡片（由 KhyPet 负责）
 *   · 在画布上**点一下**（位移 < 4px） = 打招呼
 */
import { useEffect, useRef, useState } from 'react'
import { dataUrlToBytes, parseGlb } from './glbLoader'
import { createPetModelRenderer, type PetModelRenderer } from './petModelRenderer'
import { isPlateLike } from './petAssetShape'
import type { PetForm } from './petForms'
import type { PetCharacterId } from './petFortune'
import { realisticGlb, realisticTurntable } from './petRealisticAssets'
import femaleGlb from '@/assets/pet/models/khy-pet-female.glb?inline'
import maleGlb from '@/assets/pet/models/khy-pet-male.glb?inline'
import femaleRelief from '@/assets/pet/models/khy-pet-female-relief.glb?inline'
import maleRelief from '@/assets/pet/models/khy-pet-male-relief.glb?inline'
import koiRelief from '@/assets/pet/models/khy-pet-koi-relief.glb?inline'
import femaleTurntable from '@/assets/pet/models/khy-pet-female-turntable.png?inline'
import maleTurntable from '@/assets/pet/models/khy-pet-male-turntable.png?inline'
import femaleFallback from '@/assets/pet/khy-pet-female-idle-cutout.png'
import maleFallback from '@/assets/pet/khy-pet-male-idle-cutout.png'
import koiFallback from '@/assets/pet/khy-pet-koi-idle-cutout.png'

export type { PetForm } from './petForms'

/**
 * 每个角色各形态用哪份资产。
 *
 * 锦鲤目前只有立绘浮雕（定妆照烘出来的），Q 版 3D 模型与转盘序列都还没做 ——
 * 那两格写 null，`model` 形态落到静态立绘，卡片据此标「3D 模型待生成」，
 * 不能把形态名说成用户看到的画面之外的东西。
 */
const CHARACTER_ASSETS: Record<
  PetCharacterId,
  { model: string | null; relief: string; turntable: string | null; still: string }
> = {
  female: { model: femaleGlb, relief: femaleRelief, turntable: femaleTurntable, still: femaleFallback },
  male: { model: maleGlb, relief: maleRelief, turntable: maleTurntable, still: maleFallback },
  koi: { model: null, relief: koiRelief, turntable: null, still: koiFallback },
}

/** 该角色有没有真 3D Q 版模型（卡片据此提示「3D 模型待生成」）。 */
export function hasModelAssets(characterId: PetCharacterId): boolean {
  return CHARACTER_ASSETS[characterId].model !== null
}

export interface KhyPetModelProps {
  characterId: PetCharacterId
  /** 形态：relief = 立绘浮雕（最像定妆照，默认）/ model = 真 3D Q 版模型
   *  / realistic = 写实真人 3D 模型（模型槽位，资产可选） */
  form?: PetForm
  /** 抽签成功态：模型快速甩一圈 */
  lucky?: boolean
  /** 点一下角色（未拖动）时触发 */
  onActivate?: () => void
  className?: string
}

const DRAG_THRESHOLD = 4
const IDLE_SPIN = 0.35
const LUCKY_SPIN = 7.5
/** 板状资产（立绘浮雕 / 浮雕派生的真人模型）是一张**有厚度的平板**：
 *  正面看就是那张定妆照，转过去会露侧边、背面还是镜像，画面变形。
 *  给它一个很小的偏航范围，形体永远读得出是那个人。
 *  立体网格不受限，可以整圈转（判定见 petAssetShape.ts）。 */
const RELIEF_YAW_LIMIT = 0.28
const RELIEF_PITCH_LIMIT = 0.35
/** 写实真人模型：真人比例比 Q 版玩偶更高更瘦（宽度只有 Q 版的 0.42），
 *  相机要再拉近一档，角色才占得住 132px 的卡片。 */
const REALISTIC_DISTANCE_FACTOR = 1.7
/** 转盘序列：6×6 网格，每帧 256px，共 36 帧（10°/帧） */
const SPRITE_COLS = 6
const SPRITE_ROWS = 6
const SPRITE_FRAME = 256
const SPRITE_FRAMES = SPRITE_COLS * SPRITE_ROWS

function frameForAngle(yaw: number): number {
  const twoPi = Math.PI * 2
  const normalized = ((yaw % twoPi) + twoPi) % twoPi
  return Math.round((normalized / twoPi) * SPRITE_FRAMES) % SPRITE_FRAMES
}

export function KhyPetModel({ characterId, form = 'relief', lucky = false, onActivate, className = '' }: KhyPetModelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotationRef = useRef({ yaw: 0.35, pitch: 0.12 })
  /** 用户拖出来的偏航基准值。浮雕在它周围轻轻摆动，模型则在其上持续自转。 */
  const yawRef = useRef(0)
  const spinRef = useRef(0)
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const luckyRef = useRef(lucky)
  /** 这块资产是不是「一块平板」（板状只能小角度摆，立体才能整圈转）。
   *  按**网格形状**判，不按形态名判 —— 第三形态的槽位现在装的是浮雕派生的
   *  2.5D 网格，外部服务给出真扫描网格后同名覆盖，按形状判就自动切回整圈转。 */
  const plateRef = useRef(false)
  const [failed, setFailed] = useState(false)

  // ── 当前形态用哪份资产 ────────────────────────────────────────
  // 三层兜底：真 3D（GLB）→ 转盘序列 → 静态立绘。
  // 真人形态的资产是**可选**的：外部 AI 3D 服务出的模还没进仓时这里拿到
  // null，直接落到立绘（桌宠不能凭空消失，形态也不能悄悄变成别的）。
  //
  // 为什么算在渲染层而不是 effect 里：画布身份（key）要跟着「这条路径要不要
  // WebGL 上下文」走 —— 同一块画布一旦被 WebGL 绑过，getContext('2d') 就返回
  // null，2D 兜底画不出东西，还会**留着上一形态的旧画面**（看着像这个形态，
  // 其实不是）。换一块新画布是唯一干净的办法。
  const isRelief = form === 'relief'
  const isRealistic = form === 'realistic'
  const assets = CHARACTER_ASSETS[characterId]
  const glbData = isRelief
    ? assets.relief
    : isRealistic
      ? realisticGlb(characterId)
      : assets.model
  const sheetData = isRelief
    ? null
    : isRealistic
      ? realisticTurntable(characterId)
      : assets.turntable
  const stillSrc = assets.still
  /** 画布身份：webgl = 这条路径要 WebGL 上下文；2d = 这条路径要 2D 上下文。 */
  const canvasKey = glbData ? 'webgl' : '2d'

  useEffect(() => {
    luckyRef.current = lucky
  }, [lucky])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 换形态/换角色时清掉上一形态的失败态：失败态一旦粘住就再也回不来
    // （静态图会盖住画布，之后切回任何形态都不再渲染 3D）。
    setFailed(false)

    // 换角色或换形态 → 重置视角。三种形态都从**正面**起手：桌宠静止时该正脸
    // 看着用户，浮雕正面就是那张定妆照，模型正面才看得见脸。
    rotationRef.current = { yaw: 0, pitch: isRelief ? 0 : 0.08 }
    yawRef.current = 0
    spinRef.current = 0
    // 板状判定也复位：上一形态的判定不能粘到这一形态上（否则换形态后的
    // 第一帧用着旧的旋转策略）。默认值按「立绘浮雕是板状」给。
    plateRef.current = isRelief

    let renderer: PetModelRenderer | null = null
    let raf = 0
    let disposed = false
    let sprite: HTMLImageElement | null = null
    let spriteCtx: CanvasRenderingContext2D | null = null
    let mode: 'webgl' | 'sprite' = 'webgl'
    /** 转盘序列是 6×6 精灵表；立绘原图是单张 —— 两种取图方式不同。 */
    let spriteIsSheet = false

    // ① 先试 WebGL；失败就退到 ② 转盘序列。
    if (glbData) {
      try {
        const bytes = dataUrlToBytes(glbData)
        const scene = parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
        // 板状判定跟 WebGL 无关：解析成功就算得出来（退到转盘序列时同样用得上）。
        //
        // 为什么按**形状**判而不是按形态名判：第三形态的槽位里现在装的是浮雕派生的
        // 2.5D 网格；外部 AI 3D 服务给出真扫描网格后同名文件覆盖即可 ——
        // 按形状判，自转策略会自己从「轻摆」切回「整圈转」，渲染端不用跟着改。
        plateRef.current = isRelief || isPlateLike(scene.bounds)
        renderer = createPetModelRenderer(canvas, {
          // 立绘定妆照四周留白多，相机拉近一点，角色才占得住 132px 的卡片；
          // 真 3D 模型本身窄高，也要拉近一档才不至于缩成一小撮。
          distanceFactor: isRelief ? 1.95 : isRealistic ? REALISTIC_DISTANCE_FACTOR : 2.1,
        })
        renderer.setScene(scene)
      } catch {
        renderer?.dispose()
        renderer = null
        mode = 'sprite'
      }
    } else {
      // 资产缺失（真人形态还没出模）→ 直接走静态立绘，
      // 不浪费一次 WebGL 上下文初始化。
      mode = 'sprite'
    }

    if (mode === 'sprite') {
      spriteCtx = canvas.getContext('2d')
      if (!spriteCtx) {
        // 拿不到 2D 上下文：这块画布已经被 WebGL 绑过（同一块画布只能有一种
        // 上下文）。此时 2D 兜底画不出东西，画布上只会**留着上一形态的旧画面**
        // —— 看着像这个形态，其实不是。直接落回静态立绘。
        setFailed(true)
      } else {
        sprite = new Image()
        // 转盘序列也加载不了（资源缺失等）→ 最后一层兜底：PNG 立绘。
        //
        // ⚠ 清理期会把 sprite.src 置空（释放那张图），那会**触发一次 error 事件**。
        // 那不是「资产加载失败」，不能据此把形态判成失败 —— 否则用户切一次形态
        // 画布就永久变成静态图。disposed 是唯一的判据。
        sprite.onerror = () => {
          if (disposed) return
          setFailed(true)
        }
        if (sheetData) {
          // 转盘图用构建期内联的 data URL：file:// 下从 asar 里取图片并不可靠。
          sprite.src = sheetData
          spriteIsSheet = true
        } else {
          // 没有转盘序列可退（浮雕形态，或真人资产未进仓）→ 退回立绘原图：
          // 宁可不动，也不要换成另一套（3D 模型的）画面 —— 形态必须始终是
          // 用户选的那一个。
          sprite.src = stillSrc
        }
      }
    }

    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      // ⚠ 必须走 renderer.setSize：它同时设置画布尺寸**和 gl.viewport**。
      // 只改 canvas.width 的话 viewport 仍是默认的 300×150，模型被画到画布外，看起来像什么都没画。
      if (renderer) {
        renderer.setSize(w, h)
      } else if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    resize()
    window.addEventListener('resize', resize)

    let last = performance.now()
    const loop = (now: number) => {
      if (disposed) return
      const delta = Math.min(0.1, (now - last) / 1000)
      last = now
      const rotation = rotationRef.current
      const dragging = dragRef.current !== null
      if (!reducedMotion && !dragging) {
        spinRef.current += delta
        if (plateRef.current) {
          // 板状资产（一块有厚度的平板）：慢速左右轻摆（抽签成功时抖一下）。
          // 不做整圈转台 —— 平板转过去只会露出一条边，背面还是镜像，
          // 画面反而认不出是那个人了。
          const amp = luckyRef.current ? RELIEF_YAW_LIMIT : RELIEF_YAW_LIMIT * 0.45
          const speed = luckyRef.current ? 9.0 : 0.8
          rotation.yaw = yawRef.current + amp * Math.sin(spinRef.current * speed)
        } else {
          yawRef.current += delta * (luckyRef.current ? LUCKY_SPIN : IDLE_SPIN)
          rotation.yaw = yawRef.current
        }
      }
      if (renderer) {
        renderer.setRotation(rotation.yaw, rotation.pitch)
        renderer.render()
      } else if (sprite && sprite.complete && sprite.naturalWidth > 0 && spriteCtx) {
        if (spriteIsSheet) {
          const index = frameForAngle(rotation.yaw)
          const sx = (index % SPRITE_COLS) * SPRITE_FRAME
          const sy = Math.floor(index / SPRITE_COLS) * SPRITE_FRAME
          spriteCtx.clearRect(0, 0, canvas.width, canvas.height)
          spriteCtx.drawImage(sprite, sx, sy, SPRITE_FRAME, SPRITE_FRAME, 0, 0, canvas.width, canvas.height)
        } else {
          // 单张立绘：整幅贴到画布。
          spriteCtx.clearRect(0, 0, canvas.width, canvas.height)
          spriteCtx.drawImage(sprite, 0, 0, sprite.naturalWidth, sprite.naturalHeight, 0, 0, canvas.width, canvas.height)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      renderer?.dispose()
      if (sprite) sprite.src = ''
    }
  }, [characterId, form])

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    const rotation = rotationRef.current
    yawRef.current += dx * 0.012
    rotation.yaw = yawRef.current
    rotation.pitch = Math.max(-0.9, Math.min(0.9, rotation.pitch + dy * 0.008))
    if (plateRef.current) {
      // 板状资产锁在小角度内：拖再多也只是「歪头看」，不会把定妆照拧成平行四边形。
      yawRef.current = Math.max(-RELIEF_YAW_LIMIT, Math.min(RELIEF_YAW_LIMIT, yawRef.current))
      rotation.yaw = yawRef.current
      rotation.pitch = Math.max(-RELIEF_PITCH_LIMIT, Math.min(RELIEF_PITCH_LIMIT, rotation.pitch))
    }
    drag.x = event.clientX
    drag.y = event.clientY
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
    if (drag && !drag.moved) onActivate?.()
  }

  // 画布**始终**渲染：失败态用静态立绘盖在它上面，而不是把它换掉。
  // 换掉的话画布就不在 DOM 里，effect 拿不到 canvas、也就没法在换形态时
  // 重新初始化 —— 失败态会永久粘住（切回任何形态都不再渲染 3D）。
  return (
    <div className={`relative h-[132px] w-[132px] ${className}`}>
      <canvas
        key={canvasKey}
        ref={canvasRef}
        aria-label="桌宠 3D 模型，可拖动旋转"
        role="img"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="block h-[132px] w-[132px] cursor-grab touch-none active:cursor-grabbing"
      />
      {failed && (
        <img
          src={stillSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-[132px] w-[132px] object-contain"
        />
      )}
    </div>
  )
}
