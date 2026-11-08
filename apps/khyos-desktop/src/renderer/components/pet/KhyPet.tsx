/**
 * KhyPet — the Lucky desktop pet (Khy OS, Electron renderer).
 *
 * A draggable card that floats above the workspace without stealing any
 * pointer input from the app underneath:
 *   · the card is the ONLY hit area — there is no full-screen layer, so the
 *     workspace keeps every click it had before the pet existed;
 *   · it sits at z-40, below the app's own overlays (modals and the command
 *     center use z-50) and above the regular content;
 *   · it can be dragged, collapsed to a 32px brand badge, and put away.
 *
 * The character is a real 3D model (GLB, Blender-built) rendered by
 * KhyPetModel on a native WebGL canvas — not a flat picture:
 *   · drag ON the model   → rotate it (see the character from any angle)
 *   · drag on the HEADER  → move the card around the screen
 *
 * Interactions (all local, no model call, no new IPC channel):
 *   · tap the character  → an idle line from that character, bubble auto-hides
 *   · tap the charm      → the daily fortune draw (same result all day)
 *   · tap the name       → switch between 澪 (female), 凯 (male) and 锦鲤 (koi)
 *   · tap ×              → collapse to the brand badge
 *
 * State lives in two places, each with a single owner:
 *   · position / collapsed → localStorage (khy_pet_pos / khy_pet_hidden);
 *     these are window-local UI state, not app settings.
 *   · character → settings.json (settings.desktopPetCharacter). The settings
 *     page owns the choice (设置 → 常规 → 桌宠), this card can also flip it,
 *     and both write the same key so they never disagree.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { BrandMark } from '../ui/BrandMark'
import {
  dailyFortune,
  pickLine,
  type PetCharacterId,
  type PetFortuneData,
} from './petFortune'
import fortuneJson from '@/assets/pet/pet-fortune.json'
import { KhyPetModel, hasModelAssets } from './KhyPetModel'
import {
  PET_FORM_LABELS,
  PET_FORM_NEXT_LABELS,
  isPetForm,
  nextPetForm,
  type PetForm,
} from './petForms'
import { hasRealisticAssets } from './petRealisticAssets'
import {
  AUTO_MOVE_COOLDOWN_MS,
  CHECK_INTERVAL_MS,
  HOME_CLEAR_STREAK,
  MANUAL_GRACE_MS,
  blockedLines,
  candidateSlots,
  chooseEscapeSlot,
  coverageRatio,
  shouldReturnHome,
  slotRect,
  type Slot,
} from './petAvoidance'
import { collectTextSpans, isPetOnTop, type Rect, type TextSpan } from './petTextProbe'

const POS_KEY = 'khy_pet_pos'
const HIDDEN_KEY = 'khy_pet_hidden'
/** Where the pet goes back to once the text it was avoiding is gone. */
const HOME_KEY = 'khy_pet_home'

/** The user's choice of character. Single source of truth: settings.json
 *  (settings.desktopPetCharacter, default 'female'). The settings page writes
 *  it; this component reads it on mount and writes it back when the user
 *  switches characters from the pet card itself. */
const PET_CHARACTER_SETTING = 'desktopPetCharacter'

/** Which body the pet wears: 'relief' = 立绘浮雕 (default, closest to the
 *  character sheet) / 'model' = the true 3D model / 'realistic' = the
 *  photorealistic human 3D model (AI 3D service output, asset optional).
 *  Same single-source rule as the character: it lives in settings.json,
 *  not in localStorage. */
const PET_FORM_SETTING = 'desktopPetForm'

type PetApi = {
  getSettings?: () => Promise<Record<string, unknown>>
  setSetting?: (key: string, value: unknown) => Promise<void>
}

function petApi(): PetApi | undefined {
  return (window as unknown as { __KHYOS__?: PetApi }).__KHYOS__
}

function isCharacterId(value: unknown): value is PetCharacterId {
  return value === 'female' || value === 'male' || value === 'koi'
}

/** 名字按钮的轮换顺序。新增角色只改这一处 + 资产表。 */
const CHARACTER_ORDER: readonly PetCharacterId[] = ['female', 'male', 'koi']

function nextCharacter(current: PetCharacterId): PetCharacterId {
  const index = CHARACTER_ORDER.indexOf(current)
  return CHARACTER_ORDER[(index + 1) % CHARACTER_ORDER.length]
}

/** Pointer travel (px) before a press turns into a drag instead of a tap. */
const DRAG_THRESHOLD = 4
/** How long the speech bubble and the lucky pose stay up. */
const BUBBLE_MS = 2500
/** 按最宽的角色名（锦鲤）留头部空间：148px 时品牌名会被截成「Khy ...」。 */
const CARD_WIDTH = 160
const CARD_HEIGHT = 196
const EDGE_MARGIN = 8
const DEFAULT_LEFT = 24
const DEFAULT_BOTTOM = 24
/** Gap between the card's edge and the viewport edge when it parks itself. */
const PARK_MARGIN = 12

interface PetPosition {
  left: number
  top: number
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  moved: boolean
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode / locked profile): the pet still works */
  }
}

function readPosition(): PetPosition | null {
  const raw = readString(POS_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PetPosition
    if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') return parsed
  } catch {
    /* corrupted entry: fall back to the default anchor */
  }
  return null
}

/**
 * The pet's "home" — the spot it was last asked to stay at (either the
 * user's drag or the default anchor). Kept apart from the live position so
 * the pet can wander off to dodge text and then walk back.
 */
function readHome(): PetPosition | null {
  const raw = readString(HOME_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PetPosition
    if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') return parsed
  } catch {
    /* corrupted entry: treat as "no home recorded" */
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function clampIntoView(position: PetPosition): PetPosition {
  // 窗口尺寸变了（缩放、换屏、分辨率变化）之后，之前存的位置可能落在视口外，
  // 桌宠就「找不到了」。这里把它拉回可见范围内。
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - CARD_WIDTH - EDGE_MARGIN)
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - CARD_HEIGHT - EDGE_MARGIN)
  return {
    left: Math.min(Math.max(position.left, EDGE_MARGIN), maxLeft),
    top: Math.min(Math.max(position.top, EDGE_MARGIN), maxTop),
  }
}

export function KhyPet() {
  const fortune = useMemo(() => fortuneJson as unknown as PetFortuneData, [])
  const [position, setPosition] = useState<PetPosition | null>(null)
  const [hidden, setHidden] = useState(false)
  const [characterId, setCharacterId] = useState<PetCharacterId>('female')
  const [form, setForm] = useState<PetForm>('relief')
  const [bubble, setBubble] = useState<string | null>(null)
  const [lucky, setLucky] = useState(false)
  const [ready, setReady] = useState(false)

  const dragRef = useRef<DragState | null>(null)
  const bubbleTimer = useRef<number | null>(null)
  const lastLine = useRef<string | null>(null)
  /** The card element itself — the text probe has to exclude it, and the
   *  "is the pet on top" test needs it as the hit-test anchor. */
  const cardRef = useRef<HTMLDivElement | null>(null)
  /** Mirrors of the state the avoid-check needs to read without re-binding
   *  the interval on every render. */
  const positionRef = useRef<PetPosition | null>(null)
  const hiddenRef = useRef(false)
  /** Where the user last parked the pet. The pet walks back here once the
   *  text it dodged is gone. */
  const homeRef = useRef<PetPosition | null>(null)
  /** True while the pet is away from home (it dodged something). */
  const awayRef = useRef(false)
  /** Consecutive checks in which home was clear of text. */
  const clearStreakRef = useRef(0)
  /** Timestamp of the last manual drag — during the grace period the pet
   *  stays where the user put it. */
  const manualAtRef = useRef(0)
  /** Timestamp of the last automatic move (cooldown between hops). */
  const autoMovedAtRef = useRef(0)

  // Restore the persisted state on mount. The default anchor needs the window
  // size, so it cannot be computed during the first render.
  useEffect(() => {
    const saved = readPosition()
    const savedHidden = readString(HIDDEN_KEY)
    if (saved) {
      setPosition(clampIntoView(saved))
    } else {
      setPosition({
        left: DEFAULT_LEFT,
        top: Math.max(EDGE_MARGIN, window.innerHeight - DEFAULT_BOTTOM - CARD_HEIGHT),
      })
    }
    // 「家」= 用户上次停放桌宠的位置。没有记录时以恢复出来的位置为准，
    // 这样自动避让走开之后还有地方可回。
    const savedHome = readHome()
    homeRef.current = savedHome
      ? clampIntoView(savedHome)
      : (saved ? clampIntoView(saved) : null)
    if (savedHidden === '1') setHidden(true)
    setReady(true)
    // The character comes from settings.json, not from localStorage — one
    // source of truth, the same one the settings page writes.
    void petApi()?.getSettings?.()
      .then((s) => {
        const value = s?.[PET_CHARACTER_SETTING]
        if (isCharacterId(value)) setCharacterId(value)
        const formValue = s?.[PET_FORM_SETTING]
        if (isPetForm(formValue)) setForm(formValue)
      })
      .catch(() => {})
  }, [])

  // The settings page broadcasts the choice; adopt it right away when the pet
  // happens to be mounted behind it.
  useEffect(() => {
    const onPick = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (isCharacterId(value)) {
        setCharacterId(value)
        setLucky(false)
      }
    }
    // 形态也走广播：设置页改了形态，挂在工作区里的桌宠立刻换身体，
    // 不必等用户切回工作区才发现卡片还停在旧形态。
    const onForm = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (isPetForm(value)) setForm(value)
    }
    window.addEventListener('khy:pet-character', onPick)
    window.addEventListener('khy:pet-form', onForm)
    return () => {
      window.removeEventListener('khy:pet-character', onPick)
      window.removeEventListener('khy:pet-form', onForm)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    }
  }, [])

  // 窗口尺寸变化时把桌宠拉回可见范围（否则缩小窗口后它会停在视口外找不着）。
  useEffect(() => {
    const onResize = () => {
      setPosition((current) => {
        if (!current) return current
        const next = clampIntoView(current)
        if (next.left !== current.left || next.top !== current.top) {
          writeString(POS_KEY, JSON.stringify(next))
        }
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 避让检查跑在 interval 里，用 ref 镜像读状态，省得每次渲染都重绑定时器。
  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  // ── 自动避让：挡住字就自己换个位置 ─────────────────────────────
  //
  // 桌宠是浮在工作区之上的，所以它确实会盖住下方的文字（聊天消息、文件名、
  // 按钮标签）。这里的规则是：
  //   · 定时（1.5s）量一次自己脚下压住了几行字；
  //   · 压住了 → 在视口四周的候选位里挑一个「明显更空」的位置挪过去；
  //   · 挪走后记住「家」；等家那边不再压字了，再自己走回去。
  //
  // 两个必须有的约束，否则这个功能会变成噪音：
  //   · **用户拖过就听用户的**——拖拽后有 MANUAL_GRACE_MS 宽限期，期间绝不
  //     自己乱跑。否则用户刚松手它就跳走，像是在跟人抢方向盘。
  //   · **只在明显更好时才挪**——目标位必须「空得多」（chooseEscapeSlot 里
  //     的 IMPROVE_FACTOR），否则它会在两个一样挤的角落之间来回蹦。
  useEffect(() => {
    if (!ready) return
    const card = cardRef.current
    if (!card) return

    const check = () => {
      const current = positionRef.current
      if (!current || hiddenRef.current) return
      // 用户正在拖：别插手。
      if (dragRef.current) return
      const now = Date.now()
      // 用户刚拖过 → 尊重用户的选择（宽限期内不动）。
      if (now - manualAtRef.current < MANUAL_GRACE_MS) return
      // 两次自动挪动之间的冷却，避免连续弹跳。
      if (now - autoMovedAtRef.current < AUTO_MOVE_COOLDOWN_MS) return

      const selfRect: Rect = {
        left: current.left,
        top: current.top,
        right: current.left + CARD_WIDTH,
        bottom: current.top + CARD_HEIGHT,
      }
      // 被弹窗/浮层盖住时，桌宠根本看不见，它也没在挡任何字。
      if (!isPetOnTop(card, selfRect)) return

      const slots = candidateSlots(
        window.innerWidth,
        window.innerHeight,
        CARD_WIDTH,
        CARD_HEIGHT,
        PARK_MARGIN,
      )
      // 一次扫描覆盖所有候选位：文本矩形与各候选位求交即可，
      // 不必为每个候选位各扫一遍 DOM。
      const regions: Rect[] = [selfRect, ...slots.map((slot) => slotRect(slot, CARD_WIDTH, CARD_HEIGHT))]
      const spans: TextSpan[] = collectTextSpans(document.body, card, regions)

      const selfBlocked = blockedLines(selfRect, spans) > 0
      const home = homeRef.current
      const homeRect: Rect | null = home
        ? { left: home.left, top: home.top, right: home.left + CARD_WIDTH, bottom: home.top + CARD_HEIGHT }
        : null
      const homeBlocked = homeRect ? blockedLines(homeRect, spans) > 0 : false

      if (!selfBlocked) {
        // 现在脚下没字了：如果之前是躲出去的，且家也空了，就走回去。
        if (awayRef.current && home) {
          clearStreakRef.current = homeBlocked ? 0 : clearStreakRef.current + 1
          if (shouldReturnHome({ homeBlocked, clearStreak: clearStreakRef.current })) {
            awayRef.current = false
            clearStreakRef.current = 0
            setPosition(home)
            writeString(POS_KEY, JSON.stringify(home))
          }
        }
        return
      }

      // 脚下压着字 → 找个明显更空的位置。
      const currentRatio = coverageRatio(selfRect, spans)
      const target = chooseEscapeSlot({
        slots,
        current,
        currentRatio,
        coverageOf: (slot) => coverageRatio(slotRect(slot, CARD_WIDTH, CARD_HEIGHT), spans),
      })
      if (!target) return
      awayRef.current = true
      clearStreakRef.current = 0
      autoMovedAtRef.current = now
      const next: PetPosition = { left: target.left, top: target.top }
      setPosition(next)
      // 只持久化「当前在哪」，不持久化「家」——家是用户的意图，自动挪动
      // 只是临时避让，下次启动该回哪儿还得回哪儿。
      writeString(POS_KEY, JSON.stringify(next))
    }

    const timer = window.setInterval(check, CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [ready])

  const showBubble = useCallback((text: string) => {
    setBubble(text)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => {
      setBubble(null)
      bubbleTimer.current = null
    }, BUBBLE_MS)
  }, [])

  const character = fortune.characters[characterId]

  const handleGreet = useCallback(() => {
    const line = pickLine(character?.idle ?? [], lastLine.current)
    lastLine.current = line
    showBubble(line)
  }, [character, showBubble])

  const handleDraw = useCallback(() => {
    const result = dailyFortune(fortune, characterId)
    const colorText = result.color ? result.color.name : ''
    showBubble(`${result.level.label} · ${result.level.hint}｜幸运色：${colorText}`)
    setLucky(true)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => {
      setLucky(false)
      setBubble(null)
      bubbleTimer.current = null
    }, BUBBLE_MS)
  }, [characterId, fortune, showBubble])

  const handleSwitch = useCallback(() => {
    setCharacterId((current) => {
      const next: PetCharacterId = nextCharacter(current)
      // Persist through settings.json so the settings page and the pet card
      // never disagree about who the pet is.
      void petApi()?.setSetting?.(PET_CHARACTER_SETTING, next)?.catch(() => {})
      // 设置页换人时由它自己广播；卡片直接换人这条路径也要广播，
      // 否则消息头的助手名要等重开应用才跟上（见 shared/chatIdentity）。
      window.dispatchEvent(new CustomEvent('khy:pet-character', { detail: next }))
      return next
    })
    setLucky(false)
    lastLine.current = null
  }, [])

  const handleToggleForm = useCallback(() => {
    setForm((current) => {
      // 三形态轮换：立绘 → 3D → 真人 → 立绘。
      const next = nextPetForm(current)
      void petApi()?.setSetting?.(PET_FORM_SETTING, next)?.catch(() => {})
      return next
    })
  }, [])

  const handleCollapse = useCallback(() => {
    setHidden(true)
    writeString(HIDDEN_KEY, '1')
  }, [])

  const handleRestore = useCallback(() => {
    setHidden(false)
    writeString(HIDDEN_KEY, '0')
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!position) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: position.left,
      originTop: position.top,
      moved: false,
    }
  }, [position])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    const next = {
      left: clamp(drag.originLeft + dx, EDGE_MARGIN, window.innerWidth - CARD_WIDTH - EDGE_MARGIN),
      top: clamp(drag.originTop + dy, EDGE_MARGIN, window.innerHeight - CARD_HEIGHT - EDGE_MARGIN),
    }
    setPosition(next)
  }, [])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
    // 卡片拖动只负责挪位置；「打招呼」由 3D 画布上的点按触发（避免和按钮点击打架）。
    setPosition((current) => {
      if (current) {
        writeString(POS_KEY, JSON.stringify(current))
        // 用户亲手放的位置就是「家」：自动避让以后要回到这里。
        homeRef.current = current
        writeString(HOME_KEY, JSON.stringify(current))
      }
      return current
    })
    // 用户刚拖过 → 给一段宽限期，期间自动避让不插手（否则它会立刻
    // 跳走，用户会觉得「这东西不听话」）。
    manualAtRef.current = Date.now()
    awayRef.current = false
    clearStreakRef.current = 0
  }, [])

  if (!ready) return null

  const style: CSSProperties = position
    ? { left: `${position.left}px`, top: `${position.top}px` }
    : { left: `${DEFAULT_LEFT}px`, bottom: `${DEFAULT_BOTTOM}px` }

  if (hidden) {
    return (
      <button
        type="button"
        aria-label={`唤出桌宠（${character?.name ?? 'Khy OS'}）`}
        onClick={handleRestore}
        style={style}
        className="fixed z-40 flex h-8 w-8 items-center justify-center rounded-full border border-brand/40 bg-background/90 shadow-md backdrop-blur transition-opacity hover:opacity-80"
      >
        <BrandMark size={18} />
      </button>
    )
  }

  return (
    <div
      ref={cardRef}
      style={style}
      data-testid="khy-pet"
      className="fixed z-40 w-[160px] select-none rounded-2xl border border-brand/30 bg-background/95 p-1.5 shadow-lg backdrop-blur"
    >
      {/* 卡片头部：拖这里挪卡片（模型本体是 3D 画布，拖它会转模型而不是挪卡片）。 */}
      <div
        className="flex h-5 cursor-grab touch-none items-center justify-between gap-1 px-0.5 active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <span className="flex min-w-0 items-center gap-1">
          <BrandMark size={14} />
          <span className="truncate text-[10px] leading-none text-brand">{fortune.brand.name}</span>
        </span>
        {/* 三个按钮都不换行：多字角色名（锦鲤）曾把「立绘/锦鲤」挤成竖排。 */}
        <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap">
          <button
            type="button"
            aria-label={PET_FORM_NEXT_LABELS[form]}
            onClick={handleToggleForm}
            className="rounded px-1 text-[10px] leading-none text-brand/80 hover:bg-brand/15"
          >
            {PET_FORM_LABELS[form]}
          </button>
          <button
            type="button"
            aria-label="切换桌宠角色"
            onClick={handleSwitch}
            className="whitespace-nowrap rounded px-1 text-[10px] leading-none text-brand/80 hover:bg-brand/15"
          >
            {character?.name ?? '换装'}
          </button>
          <button
            type="button"
            aria-label="收起桌宠"
            onClick={handleCollapse}
            className="rounded px-1 text-[10px] leading-none text-brand/80 hover:bg-brand/15"
          >
            ×
          </button>
        </span>
      </div>

      <div className="relative mt-1">
        <KhyPetModel characterId={characterId} form={form} lucky={lucky} onActivate={handleGreet} />
        {form === 'model' && !hasModelAssets(characterId) && (
          // 锦鲤还没有 Q 版 3D 模型：这一形态画的是立绘，卡片得说清楚。
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-background/85 px-1 text-[9px] leading-tight text-foreground/70">
            3D 模型待生成
          </span>
        )}
        {form === 'realistic' && !hasRealisticAssets(characterId) && (
          // 诚实提示：真人形态的资产是外部 AI 3D 服务出的模，还没进仓。
          // 桌宠此时画的是立绘（不能凭空消失），但必须说清楚它不是真人模型。
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-background/85 px-1 text-[9px] leading-tight text-foreground/70">
            真人模型待生成
          </span>
        )}
        {bubble && (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-0 rounded-lg border border-brand/30 bg-background/95 px-1.5 py-1 text-[10px] leading-tight text-foreground shadow-sm"
          >
            {bubble}
          </div>
        )}
        <button
          type="button"
          aria-label="抽一签"
          onClick={handleDraw}
          className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border border-brand/40 bg-background/95 shadow-sm transition-transform hover:scale-105"
        >
          <BrandMark size={14} />
        </button>
      </div>
    </div>
  )
}
