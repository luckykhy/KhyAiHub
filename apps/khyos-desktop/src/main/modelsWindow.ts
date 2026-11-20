// khy-canary: Khy-20261119-319-W7NP3XRD
// modelsWindow — the standalone Model Manager window
// (DESIGN-ARCH-091 §8b extension: same shape as keyManagerWindow).
//
// 1080×720 (min 880×560), frameless like the main window, same preload.
// The renderer loads #/model-manager and renders the full-screen manager view.
//
// URL 带 `?window=models` 查询段：这个窗是 frame:false 的无框窗，没有系统关闭钮，
// 页面必须自己渲染 ✕（ModelsPage 的 standalone 分支）；而主窗侧栏入口走同一个
// hash 的整屏替换分支，那边有 TitleBar/侧栏，不需要 ✕。渲染层单看 hash 分不出
// 这两者，所以由建窗方把身份写进 URL（App.tsx 的 modelsStandalone 读它）。

import { BrowserWindow, app } from 'electron'
import path from 'path'

// 独立管理窗的身份标记（hash 查询段，不参与 route 匹配）
export const MODELS_WINDOW_QUERY = 'window=models'

export interface ModelsWindowOptions {
  standalone?: boolean
}

export function openModelsWindow(opts: ModelsWindowOptions = {}): BrowserWindow {
  // 去重：连点 Ctrl+Shift+M / 窗口菜单会叠出一串模型管理窗（keyManagerWindow
  // 与 keymanager:openWindow 同款既有缺陷）。已开着就 focus 现有那个，
  // 不新建 —— 同一 hash 的第二个窗没有任何新增信息。
  const existing = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.getURL().includes('#/model-manager')
  )
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    show: false,
    title: 'KhyOS 模型管理',
    webPreferences: {
      // Preload built as CJS — see src/main/index.ts / electron.vite.config.ts (P0-6)
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // dev-server URL from env (electron-vite injects VITE_DEV_SERVER_URL); the
  // port falls back to a variable (zero-hardcoding exemption class)
  const devPort = process.env.VITE_DEV_PORT || '5173'
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`
  const useDev = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === 'development'
  if (useDev) {
    win.loadURL(`${devServerUrl}#/model-manager?${MODELS_WINDOW_QUERY}`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
    // packaged build: force the manager hash once the renderer is up
    win.webContents.once('did-stop-loading', () => {
      win.webContents.executeJavaScript(`location.hash = 'model-manager?${MODELS_WINDOW_QUERY}'`).catch(() => {})
    })
  }

  win.once('ready-to-show', () => win.show())

  if (opts.standalone) {
    // standalone entry: single-window app; closing the manager quits
    win.on('closed', () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit()
    })
  }
  return win
}
