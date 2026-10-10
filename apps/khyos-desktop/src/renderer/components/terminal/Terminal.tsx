import { useEffect, useRef } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// TerminalPanel — 真终端（[DESIGN-ARCH-176] A3）。
// 之前是 stub：`writeln('KhyOS Terminal')` + 输入只得到「命令执行结果（stub）」假回显。
// 现在走 main 进程的 PTY（src/main/ptyHost.ts，@lydell/node-pty，Electron ABI 实测通过）：
// 输入 → pty:write，输出 → pty:data 事件流，窗口缩放 → fit → pty:resize。
// shell 由 main 侧选（KHY_DESKTOP_SHELL || ComSpec）；PTY 不可用时 fail-soft 显示原因，
// 不白屏、不崩溃 —— 与 cli/pty.js 的降级策略同策。

interface PtyApi {
  ptyCreate?: (opts?: { cols?: number; rows?: number; cwd?: string }) =>
    Promise<{ ok: boolean; id?: string; pid?: number; error?: string }>
  ptyWrite?: (id: string, data: string) => Promise<void>
  ptyResize?: (id: string, cols: number, rows: number) => Promise<void>
  ptyKill?: (id: string) => Promise<void>
  onPtyData?: (cb: (payload: { id: string; data: string }) => void) => () => void
  onPtyExit?: (cb: (payload: { id: string; code: number }) => void) => () => void
  getWorkspacePath?: () => Promise<string>
}

function getPtyApi(): PtyApi {
  return (window as unknown as { __KHYOS__?: PtyApi }).__KHYOS__ || {}
}

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const ptyIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const api = getPtyApi()
    let disposed = false
    const cleanups: (() => void)[] = []

    const term = new XTerminal({
      theme: {
        background: 'var(--color-terminal-bg)', foreground: 'var(--color-terminal-fg)',
        cursor: 'var(--color-terminal-cursor)', cursorAccent: 'var(--color-terminal-cursor-accent)',
        black: 'var(--color-terminal-black)', red: 'var(--color-terminal-red)',
        green: 'var(--color-terminal-green)', yellow: 'var(--color-terminal-yellow)',
        blue: 'var(--color-terminal-blue)', magenta: 'var(--color-terminal-magenta)',
        cyan: 'var(--color-terminal-cyan)', white: 'var(--color-terminal-white)',
        brightBlack: 'var(--color-terminal-bright-black)', brightRed: 'var(--color-terminal-bright-red)',
        brightGreen: 'var(--color-terminal-bright-green)', brightYellow: 'var(--color-terminal-bright-yellow)',
        brightBlue: 'var(--color-terminal-bright-blue)', brightMagenta: 'var(--color-terminal-bright-magenta)',
        brightCyan: 'var(--color-terminal-bright-cyan)', brightWhite: 'var(--color-terminal-bright-white)'
      },
      fontFamily: 'var(--font-mono)', fontSize: 14
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon); term.loadAddon(new WebLinksAddon()); term.loadAddon(new SearchAddon())
    // open() 必须先于 WebglAddon：activate 在 term.element 为空时会经 onWillOpen
    // 推迟到 open 期间执行，绕开 try/catch —— 禁 GPU 启动参数（main/index.ts 刻意
    // 关硬件加速）下 getContext('webgl2') 返回 null，"WebGL2 not supported" 就成了
    // 未捕获异常。open 先行后 activate 同步走，异常才接得住。
    term.open(containerRef.current)
    try { term.loadAddon(new WebglAddon()) } catch (e) { /* WebGL not available: DOM renderer fallback */ }
    fitAddon.fit()
    // Re-fit on pane resize (side pane drag / maximize): xterm keeps its
    // initial grid unless FitAddon is re-run against the new box.
    const resizeObserver = new ResizeObserver(() => { fitAddon.fit() })
    resizeObserver.observe(containerRef.current)
    cleanups.push(() => resizeObserver.disconnect())

    // PTY 数据流：main → 渲染层（先订阅再创建会话，避免首屏输出丢字节）
    if (api.onPtyData) {
      cleanups.push(api.onPtyData(({ data }) => { term.write(data) }))
    }
    if (api.onPtyExit) {
      cleanups.push(api.onPtyExit(({ code }) => {
        term.writeln(`\r\n\x1b[2m[进程已退出，exit code ${code}]\x1b[0m`)
        ptyIdRef.current = null
      }))
    }

    const spawn = async () => {
      let cwd: string | undefined
      try { cwd = (await api.getWorkspacePath?.()) || undefined } catch { /* main 侧兜底 process.cwd */ }
      let res: { ok: boolean; id?: string; error?: string } | undefined
      try {
        res = await api.ptyCreate?.({ cols: term.cols, rows: term.rows, cwd })
      } catch (e) {
        res = { ok: false, error: (e as Error)?.message || String(e) }
      }
      if (disposed) {
        // 组件在 await 期间被卸载：杀掉刚建的会话，防泄漏
        if (res?.ok && res.id && api.ptyKill) void api.ptyKill(res.id)
        return
      }
      if (!res?.ok || !res.id) {
        term.writeln(`\x1b[31mPTY 不可用：${res?.error || 'main 进程未暴露 pty API'}\x1b[0m`)
        term.writeln('\x1b[2m（@lydell/node-pty 加载失败或依赖未安装，见 ptyHost.ts）\x1b[0m')
        return
      }
      ptyIdRef.current = res.id
      if (api.ptyWrite) {
        const off = term.onData((data) => {
          if (ptyIdRef.current) void api.ptyWrite!(ptyIdRef.current, data)
        })
        cleanups.push(() => off.dispose())
      }
      if (api.ptyResize) {
        const off = term.onResize(({ cols, rows }) => {
          if (ptyIdRef.current) void api.ptyResize!(ptyIdRef.current, cols, rows)
        })
        cleanups.push(() => off.dispose())
      }
    }
    void spawn()

    termRef.current = term
    return () => {
      disposed = true
      for (const c of cleanups) { try { c() } catch { /* ignore */ } }
      if (ptyIdRef.current && api.ptyKill) void api.ptyKill(ptyIdRef.current)
      ptyIdRef.current = null
      term.dispose()
    }
  }, [])
  return <div ref={containerRef} className="h-full bg-terminal-bg" />
}
