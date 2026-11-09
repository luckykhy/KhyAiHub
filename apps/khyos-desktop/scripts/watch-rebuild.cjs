#!/usr/bin/env node
/**
 * watch-rebuild.cjs — 盯着桌面端源码，改完就重新构建 out/，可选重启应用。
 *
 * 为什么需要它：这个 app 跑的是构建产物 out/（launcher/start-khyos.cmd 里的
 * `electron.exe .`），源码改完不重建 = 窗口里还是旧代码。以前每次都要人想起来
 * 手动跑一遍三条构建命令，漏一次就会出现「明明改了却没效果」的误会。
 *
 * 用法：
 *   node scripts/watch-rebuild.cjs              只重建，不动正在跑的窗口
 *   node scripts/watch-rebuild.cjs --relaunch   重建后重启应用（接住新产物）
 *   node scripts/watch-rebuild.cjs --ensure     比一次时间戳：源码比产物新才构建，完事退出
 *                                               （launcher 冷启动前跑这个，产物自然是最新的）
 *
 * 行为约定：
 *   · 只监听源码与构建配置；out/、dist-electron/、node_modules/ 不参与触发。
 *   · 合并抖动：连续改动只在最后一次之后 DEBOUNCE_MS 才开建。
 *   · 一次只跑一个构建；构建期间又改了的，建完再来一轮（不丢改动）。
 *   · 构建失败不退出：打印失败的那一步并继续监听，下一轮改动会重试。
 *   · `--relaunch` 只终止从本 app 目录起的 electron（按命令行匹配），
 *     不会误杀别处的 Electron 应用。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_DIR = path.resolve(__dirname, '..')
const RELAUNCH = process.argv.includes('--relaunch')
const ENSURE_ONLY = process.argv.includes('--ensure')
const DEBOUNCE_MS = 2500
const IGNORE = /(^|[\\/])(node_modules|out|dist-electron|\.git)([\\/]|$)/

// 与 package.json 的 build 脚本同一条链，顺序不能换：electron-vite 先出
// main/preload/renderer，host 与 scheduler 是各自独立的 vite 构建。
const BUILD_STEPS = [
  { label: 'main/preload/renderer', bin: 'node_modules/electron-vite/bin/electron-vite.js', args: ['build'] },
  { label: 'host', bin: 'node_modules/vite/bin/vite.js', args: ['build', '--config', 'vite.host.config.ts'] },
  { label: 'scheduler', bin: 'node_modules/vite/bin/vite.js', args: ['build', '--config', 'vite.scheduler.config.ts'] },
]

const WATCH_TARGETS = ['src']
const WATCH_FILES = ['electron.vite.config.ts', 'vite.host.config.ts', 'vite.scheduler.config.ts', 'index.html']

// 四份产物缺一份也算没构建过：只有 main 没 host 的 out/ 一样跑不起来。
const ARTIFACTS = ['out/main/index.js', 'out/renderer/index.html', 'out/host/index.js', 'out/scheduler/index.js']

let timer = null
let building = false
let pending = false

function newestSource() {
  let newest = { path: '', mtime: 0 }
  const visit = (file) => {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry))
      return
    }
    if (stat.mtimeMs > newest.mtime) newest = { path: path.relative(APP_DIR, file), mtime: stat.mtimeMs }
  }
  for (const dir of WATCH_TARGETS) visit(path.join(APP_DIR, dir))
  for (const file of WATCH_FILES) visit(path.join(APP_DIR, file))
  return newest
}

function oldestArtifact() {
  let oldest = { path: '', mtime: Infinity }
  for (const relative of ARTIFACTS) {
    const file = path.join(APP_DIR, relative)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return { path: relative, mtime: -1 }
    }
    if (stat.mtimeMs < oldest.mtime) oldest = { path: relative, mtime: stat.mtimeMs }
  }
  return oldest
}

function ensureBuilt() {
  const source = newestSource()
  const artifact = oldestArtifact()
  if (artifact.mtime < 0) {
    log(`缺产物 ${artifact.path} → 构建一次`)
  } else if (source.mtime <= artifact.mtime) {
    log(`产物已是最新（最新源码 ${source.path}，最早产物 ${artifact.path}）`)
    return 0
  } else {
    log(`源码比产物新（${source.path} 晚于 ${artifact.path}）→ 构建一次`)
  }
  return runBuild('源码比产物新') ? 0 : 1
}

function log(message) {
  const stamp = new Date().toTimeString().slice(0, 8)
  console.log(`[${stamp}] ${message}`)
}

function schedule(reason) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    runBuild(reason)
  }, DEBOUNCE_MS)
}

function runBuild(reason) {
  if (building) {
    pending = true
    return
  }
  // Windows 的 fs.watch 会给目录级/无文件名的空事件（实测某个 index.html
  // 事件发生时该文件 mtime 还是十天前）。开建前比一次时间戳，白跑一轮
  // 要三分钟，不能靠事件本身诚实。
  const source = newestSource()
  const artifact = oldestArtifact()
  if (artifact.mtime > 0 && source.mtime <= artifact.mtime) {
    log(`忽略事件：${reason}（源码不比产物新，最新改动仍是 ${source.path}）`)
    return true
  }
  building = true
  const startedAt = Date.now()
  log(`改动：${reason} → 重新构建 main/preload/renderer、host、scheduler`)
  let ok = true
  for (const step of BUILD_STEPS) {
    log(`构建 ${step.label}（${(Date.now() - startedAt) / 1000 | 0}s）`)
    const result = spawnSync(process.execPath, [step.bin, ...step.args], {
      cwd: APP_DIR,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      log(`构建失败：${step.label} 退出码 ${result.status}。产物可能停在半旧状态，继续监听等下一轮改动`)
      ok = false
      break
    }
  }
  building = false
  if (ok) {
    log(`构建完成，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
    // --ensure 的重启由调用方负责（它要先拿到退出码），这里再重启一次
    // 会连关两次窗口 —— 实测第一轮刚起来就被第二轮杀掉。
    if (RELAUNCH && !ENSURE_ONLY) restartApp('构建完成')
  }
  if (pending) {
    pending = false
    schedule('上一轮构建期间又有改动')
  }
  return ok
}

function appProcessTree() {
  // 只按 APP_DIR 匹配会漏掉主进程：它由 launcher 以 `electron.exe . ...` 启动，
  // 命令行里根本没有 app 目录（实测只匹配到 3 个子进程，杀完主进程还活着，
  // 新实例抢不到单实例锁直接退出 —— 窗口就这么没了）。所以先沿父链找到这些
  // 进程所在的整棵 electron 树，再返回树里的每个成员：
  // 光杀根不够，实测 taskkill /T 会漏掉一个已被孤儿化的子进程，它仍握着
  // 单实例锁文件，新实例只会留下 "Lock file can not be created"。
  const pattern = APP_DIR.replace(/'/g, "''")
  const script = [
    `$all = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"`,
    `foreach ($p in $all) {`,
    `  $match = 0`,
    `  if ($p.CommandLine -like '*${pattern}*') { $match = 1 }`,
    `  "$($p.ProcessId) $($p.ParentProcessId) $match"`,
    `}`,
  ].join('\n')
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0) return { roots: [], family: [] }
  const parentOf = new Map()
  const matched = []
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const [pid, parent, match] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || pid <= 0) continue
    parentOf.set(pid, parent)
    if (match === 1) matched.push(pid)
  }
  const rootOf = (pid) => {
    let current = pid
    for (let guard = 0; guard < 32; guard++) {
      const parent = parentOf.get(current)
      if (!parentOf.has(parent)) break
      current = parent
    }
    return current
  }
  const roots = new Set(matched.map(rootOf))
  const family = [...parentOf.keys()].filter((pid) => roots.has(rootOf(pid)))
  return { roots: [...roots], family }
}

function startApp() {
  // 用 launcher 自己启动，而不是在这里再拼一份同样的命令行：直接 spawn
  // electron.exe 起的实例实测每次都死在 `gles2_cmd_decoder: Validating command
  // decoder is not supported`，同一份产物走 launcher 就稳。启动方式只留一处，
  // 免得下次改 GPU 开关时两边不同步。
  const launcher = path.join(APP_DIR, 'launcher', 'start-khyos.cmd')
  if (!fs.existsSync(launcher)) {
    log(`找不到 ${launcher}，跳过启动（产物已更新，下次手动开窗口即可）`)
    return
  }
  const child = spawn('cmd', ['/c', launcher], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // launcher 内部只是 `start ""` 派发，没有可报的 pid；等它把进程树拉起来再
  // 按命令行找回来。实测 launcher 从 cmd 冷启动到主进程出现要 9s 左右，
  // 所以给到 25s 的窗口，期间每秒看一次。
  let family = []
  for (let waited = 0; waited < 25 && family.length === 0; waited++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    family = appProcessTree().family
  }
  log(family.length > 0 ? `已启动应用（pid ${family.join(', ')}）` : '启动后 25s 内没看到本应用进程，检查 launcher/start-khyos.cmd 的输出')
}

function stopApp() {
  const { family } = appProcessTree()
  if (family.length === 0) return false
  for (const id of family) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(id)], { stdio: 'ignore' })
  }
  // 孤儿化的子进程会躲过 /T（实测剩一个握着单实例锁），再扫一轮把它补掉。
  for (let attempt = 0; attempt < 2; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800)
    const left = appProcessTree().family
    if (left.length === 0) break
    for (const id of left) spawnSync('taskkill', ['/F', '/PID', String(id)], { stdio: 'ignore' })
  }
  log(`已终止 ${family.length} 个本应用进程（${family.join(', ')}）`)
  // GPU 缓存文件在进程退出后才异步释放，紧接着重启会撞 ACCESS_DENIED。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
  return true
}

function restartApp(reason) {
  log(`重启应用（${reason}）。窗口里的未发送输入会丢，会话本身已落盘`)
  stopApp()
  startApp()
}

function watchOne(target) {
  try {
    return fs.watch(target, { recursive: true }, (eventType, filename) => {
      const relative = filename ? path.join(path.relative(APP_DIR, target), filename.toString()) : target
      if (IGNORE.test(relative)) return
      schedule(relative)
    })
  } catch (error) {
    log(`监听失败：${target}（${error.message}）`)
    return null
  }
}

if (ENSURE_ONLY) {
  const code = ensureBuilt()
  if (code === 0 && RELAUNCH) restartApp('构建完成')
  process.exit(code)
}

for (const dir of WATCH_TARGETS) {
  const target = path.join(APP_DIR, dir)
  if (fs.existsSync(target)) watchOne(target)
}
for (const file of WATCH_FILES) {
  const target = path.join(APP_DIR, file)
  if (fs.existsSync(target)) watchOne(target)
}

log(`监听中：${WATCH_TARGETS.join('、')}、${WATCH_FILES.join('、')}（Ctrl+C 退出）`)
log(RELAUNCH ? '模式：重建后自动重启应用' : '模式：只重建，不重启应用（加 --relaunch 可自动重启）')

if (RELAUNCH && appProcessTree().family.length === 0) startApp()

process.on('SIGINT', () => {
  log('退出监听')
  process.exit(0)
})
