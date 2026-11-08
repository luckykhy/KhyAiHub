// Asset module declarations for the renderer bundle.
//
// The desktop renderer never imported binary assets before (icons are inline
// SVG, the brand mark is a React component), so Vite's client types were not
// referenced anywhere. The pet sprites are the first real image imports, and
// this file declares just those — pulling in `vite/client` wholesale would
// also silence the pre-existing `import.meta.env` error that the typecheck
// baseline records on purpose.
declare module '*.png' {
  const src: string
  export default src
}

// 品牌背景套图（theme/background.ts）：构建期由 Vite 产出带 hash 的 URL。
declare module '*.jpg' {
  const src: string
  export default src
}

// GLB 以 `?inline` 在构建期转成 base64 data URL 内联进 JS 包：
// 打包后的渲染层跑在 file:// 上，Chromium 会拒绝 fetch(file://…)，
// 所以模型字节不能走运行时 fetch，只能构建期内联。
declare module '*.glb?inline' {
  const dataUrl: string
  export default dataUrl
}

// 转盘序列（36 帧旋转精灵表）同样内联：打包后渲染层跑在 file:// 上，
// 从 asar 里按 URL 取图片并不可靠，内联成 data URL 才稳。
declare module '*.png?inline' {
  const dataUrl: string
  export default dataUrl
}

// Vite 的 import.meta.glob：桌面端只用它做「可选资产」的按 glob 匹配
// （写实真人 GLB 还没进仓时，静态 import 会直接把整个渲染层构建打挂）。
// 这里只声明用到的那部分，不整体引入 vite/client —— 那会顺带消掉既有
// import.meta.env 的 typecheck 报错，而那份报错是既有基线的一部分。
// ImportMeta 在 lib.es5.d.ts 里是全局接口，接口合并即可扩展。
interface ImportMeta {
  glob(
    pattern: string,
    options?: {
      eager?: boolean
      import?: string
      query?: string | Record<string, string>
    },
  ): Record<string, unknown>
}
