import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  build: {
    rollupOptions: { input: 'src/host/index.ts' },
    // out/ 必须在 app 目录内（electron-builder 打包输入 + main 解析），见 electron.vite.config.ts 顶部说明
    outDir: 'out/host',
    ssr: true
  },
  plugins: [externalizeDepsPlugin()]
})
