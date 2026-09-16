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
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
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
