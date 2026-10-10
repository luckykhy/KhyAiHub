// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "D:\\Portable\\khy-os\\apps\\provider-hub";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
    }
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "dist/renderer"
    }
  }
});
export {
  electron_vite_config_default as default
};
