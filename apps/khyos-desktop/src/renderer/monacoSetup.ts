// monacoSetup — Monaco 本地化装载。必须在任何 Editor 挂载前 import 一次
// （入口 main.tsx 负责）。
//
// 为什么必须存在这个文件：@monaco-editor/react 的 loader 默认从 CDN 拉
// monaco 脚本（jsdelivr 域名写死在库里）——桌面端不能有这条路径：源码里
// 出现第三方端点违反 RUNTIME-001，且离线安装/内网环境根本拉不到。这里把
// 本地 monaco-editor 模块显式塞进 loader，语言 worker 同样走 Vite 打包的
// 本地 chunk（module worker，Electron 44 Chromium 支持）。
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

loader.config({ monaco })

// ts.worker 给 js/ts 提供补全与语法诊断；其余语言（json/py/css/html/vue…）
// 用基础 editor.worker 即可（无补全，有高亮）。
const env = self as unknown as { MonacoEnvironment: monaco.Environment }
env.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
        { type: 'module' },
      )
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    )
  },
}
