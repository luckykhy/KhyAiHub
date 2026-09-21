<template>
  <GlobalErrorBoundary>
    <router-view />
  </GlobalErrorBoundary>
  <!-- PWA: offline banner (all platforms) + update prompt (web only) -->
  <OfflineIndicator />
  <PwaUpdatePrompt v-if="!isNativePlatform" />
  <!-- 🔥 全局同步通知组件 -->
  <SyncNotification />
  <FirstLaunchLoader
    :visible="showFirstLaunchLoader"
    :progress="launchShown"
    :status-text="launchStatus"
    :step-text="launchStep"
  />
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useUserStore } from '@/stores/user'
import { usePacedProgress } from '@khy/ui-shared/progress'
import SyncNotification from '@/components/SyncNotification.vue'
import GlobalErrorBoundary from '@/components/GlobalErrorBoundary.vue'
import FirstLaunchLoader from '@/components/FirstLaunchLoader.vue'
import OfflineIndicator from '@/components/OfflineIndicator.vue'
import PwaUpdatePrompt from '@/components/PwaUpdatePrompt.vue'

const userStore = useUserStore()

// Detect Capacitor native shell — skip PWA SW prompt inside WebView
const isNativePlatform = computed(() => {
  try {
    // @capacitor/core sets this when running inside a native app
    return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true
  } catch {
    return false
  }
})
const showFirstLaunchLoader = ref(false)
const launchTarget = ref(0) // the real target: advanced by elapsed time, capped per phase
const launchStatus = ref('正在准备应用资源...')
const launchStep = ref('初始化')

// First-launch phases. `budgetMs` is the expected duration of the phase: the target grows with
// elapsed time and is capped at `cap`, so a slow phase (restoring the login hits the network)
// keeps the bar moving instead of freezing on a milestone.
//
// The numbers below used to be written straight into the display (0 → 12 → 34 → 62 → 100), i.e.
// jumps of 20–40 points per frame. They are now only phase ceilings: the displayed value comes
// from the pacer below, which advances at most 1% per 160ms frame and never overshoots the target.
const LAUNCH_PHASES = [
  { step: '读取配置', base: 4, cap: 16, budgetMs: 700, statusText: '正在读取本地配置与网络模式...' },
  { step: '预热页面', base: 16, cap: 44, budgetMs: 1500, statusText: '正在预加载核心页面...' },
  { step: '恢复登录', base: 44, cap: 88, budgetMs: 2500, statusText: '正在恢复账号状态...' },
  { step: '完成', base: 88, cap: 99, budgetMs: 400, statusText: '资源加载完成，正在进入系统...' },
]

// Determinate lane: the target is authoritative and the shown value walks toward it 1% at a
// time, never overshooting it and never jumping. `prefers-reduced-motion` degrades to reporting
// the target directly (a fake animation would be a second kind of lie).
const launchPacer = usePacedProgress({
  determinate: true,
  source: () => launchTarget.value,
  active: () => showFirstLaunchLoader.value,
})
const launchShown = launchPacer.percent

let phaseIndex = -1
let phaseStartedAt = 0
let targetTimer = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Advance the target by this phase's elapsed time (monotonic — the display may never regress). */
function advanceLaunchTarget() {
  const phase = LAUNCH_PHASES[phaseIndex]
  if (!phase) return
  const elapsed = Math.min(1, (Date.now() - phaseStartedAt) / phase.budgetMs)
  const next = Math.round(phase.base + elapsed * (phase.cap - phase.base))
  if (next > launchTarget.value) launchTarget.value = next
}

function beginLaunchPhase(index) {
  phaseIndex = index
  phaseStartedAt = Date.now()
  launchStep.value = LAUNCH_PHASES[index].step
  launchStatus.value = LAUNCH_PHASES[index].statusText
  advanceLaunchTarget()
}

// The pacer only steps once per 160ms, so the target has to be re-read on the same beat.
// 160 === RENDER_MS / STEP_MS of the shared pacer (the display advances 1% per frame).
function startLaunchTargetClock() {
  if (!targetTimer) targetTimer = setInterval(advanceLaunchTarget, 160)
}

function stopLaunchTargetClock() {
  if (targetTimer) {
    clearInterval(targetTimer)
    targetTimer = null
  }
}

onBeforeUnmount(() => {
  // Tear down both clocks on unmount — no idle timers left behind.
  stopLaunchTargetClock()
  launchPacer.finish()
})

function runWhenIdle(task) {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(() => task().catch(() => null), { timeout: 1200 })
    return
  }
  setTimeout(() => {
    task().catch(() => null)
  }, 80)
}

async function ensureUserInfo() {
  if (userStore.isAuthenticated() && !userStore.user) {
    try {
      await userStore.fetchUserInfo()
    } catch (error) {
      await userStore.logout({ skipRemote: true })
    }
  }
}

async function preloadCriticalChunks() {
  await import('@/views/Dashboard.vue').catch(() => null)
}

function preloadNonCriticalChunks() {
  runWhenIdle(async () => {
    await Promise.all([
      import('@/views/Trading.vue'),
      import('@/components/TradingAgentsBotSimple.vue')
    ])
  })
}

async function runLaunchSequence() {
  const firstLaunch = localStorage.getItem('khy_first_launch_done') !== 'true'
  if (!firstLaunch) return

  showFirstLaunchLoader.value = true
  startLaunchTargetClock()

  beginLaunchPhase(0)
  await sleep(100)

  beginLaunchPhase(1)
  await preloadCriticalChunks()
  await sleep(80)

  beginLaunchPhase(2)
  await ensureUserInfo()
  await sleep(90)

  beginLaunchPhase(3)
  localStorage.setItem('khy_first_launch_done', 'true')
  await sleep(120)

  // Close on real completion. We deliberately do NOT snap the bar to 100 here: that snap would be
  // exactly the jump this rewrite removes, and the whole sequence legitimately takes under a
  // second — holding the splash open just to watch the bar walk to 100% would be the fake wait
  // the user objected to. The step text ("完成") carries the real completion signal.
  stopLaunchTargetClock()
  showFirstLaunchLoader.value = false

  // 非关键模块放到空闲时预热，减少首启阻塞
  preloadNonCriticalChunks()
}

// 应用启动时获取用户信息
onMounted(async () => {
  await runLaunchSequence()
  await ensureUserInfo()
  preloadNonCriticalChunks()

  window.dispatchEvent(new Event('khy-app-ready'))
})
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  overflow-x: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
}

#app {
  min-height: 100vh;
}
</style>
