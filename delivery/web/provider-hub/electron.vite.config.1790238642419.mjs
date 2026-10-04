// electron.vite.build.tmp.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "D:\\Portable\\khy-os\\apps\\provider-hub";
var electron_vite_build_tmp_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: ".build-tmp/main",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: ".build-tmp/preload",
      // 沙箱化 preload（Electron 20+ 默认 sandbox:true）只支持 CommonJS，
      // 必须产出 .js + cjs，否则 contextBridge 静默不执行、window.khyHub 为 undefined。
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/preload/index.ts"), formats: ["cjs"], fileName: () => "index.js" }
    }
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: resolve(__electron_vite_injected_dirname, ".build-tmp/renderer"),
      emptyOutDir: false
    }
  }
});
export {
  electron_vite_build_tmp_default as default
};
