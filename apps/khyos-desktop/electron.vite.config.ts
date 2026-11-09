import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

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
