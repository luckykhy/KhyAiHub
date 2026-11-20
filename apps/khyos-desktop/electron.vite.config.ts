import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// ⚠️ out/ 必须留在 app 目录内，别为了 LAYOUT-005 把它迁去 entries/（2026-11-19 试过，
// 已回退并登记为寄生产物）。两个硬理由，都有 app-builder-lib 源码为依据：
//   1. package.json 的 main 在开发态（electron . 从 app 目录读）与打包态（asar 内
//      解析）必须指向同一处——asar 内路径逃不出归档，迁出去打包产物直接起不来。
//   2. electron-builder 的 files 匹配走不出 app 目录：filter.js 的 createFilter 只对
//      walker 走过的文件算「相对 appDir」路径再 minimatch，`../` 字符串 pattern 静默
//      零匹配（高级 {from,to} pattern 虽可越界，但 main 的第 1 条理由仍然无解）。
// 打包输出 dist-electron 相反——那是纯输出、无运行时解析语义，已迁 entries/electron/。

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        // Sandboxed Electron preloads must be CommonJS (real ZCode ships
        // .cjs preloads too). package.json type:module makes electron-vite
        // default to ESM, which fails with "Cannot use import statement
        // outside a module" — force CJS output (ZC-ALIGN-001 P0-6).
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: 'src/renderer',
    // 桌宠的 3D 模型是 .glb：Vite 默认不认这个扩展名，会当成 JS 解析而报错。
    // 声明成资源后，`?inline` 会把模型转成 base64 data URL 内联进包里
    // （打包后的渲染层跑在 file:// 上，fetch(file://…) 会被 Chromium 拒绝）。
    assetsInclude: ['**/*.glb'],
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      },
      // monacoSetup 用 new URL('monaco-editor/esm/…worker.js', import.meta.url)
      // 起 module worker，Vite 默认按 iife 出 worker 包，module worker 加载
      // 不了；es 格式才匹配 { type: 'module' }。
      worker: {
        format: 'es'
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer')
      },
      // pnpm can resolve react and react-dom to different copies, which
      // crashes the renderer with React error #527 — force a single copy.
      dedupe: ['react', 'react-dom']
    }
  }
})
