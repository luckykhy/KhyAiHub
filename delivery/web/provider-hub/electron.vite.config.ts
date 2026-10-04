// electron-vite 构建配置：main / preload / renderer 三入口（DESIGN-ARCH-094 §3）。
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      // 沙箱化 preload（Electron 20+ 默认 sandbox:true）只支持 CommonJS：
      // 必须产出 .js + cjs，否则 contextBridge 静默不执行、window.khyHub 为 undefined，
      // 表现为渲染层 app.js 报 "Cannot read properties of undefined (reading 'cards')"。
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.js' }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'dist/renderer'
    }
  }
})
