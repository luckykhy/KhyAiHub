import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  build: {
    rollupOptions: { input: 'src/scheduler/index.ts' },
    // out/ 必须在 app 目录内，见 electron.vite.config.ts 顶部说明
    outDir: 'out/scheduler',
    ssr: true
  },
  plugins: [externalizeDepsPlugin()]
})
