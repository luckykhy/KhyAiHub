// khy-canary: Khy-20261102-340-4RMGVCJV
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './state/store'
import App from './App'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import './i18n'
// monacoSetup 不再在这里引入：Monaco 只服务两个 lazy 入口（工作台 / 侧栏编辑态），
// 首屏引入等于把 ~4MB 内核钉死在入口 chunk（[DESIGN-ARCH-210] M1）。
import './theme/globals.css'
import { loadBackground } from './theme/background'

// 壁纸自举：把当前预设的 CSS 变量写到 <html>（含活场景开关 --khy-bg-live）。
// 异步、不 await——首帧不因为它晚几百毫秒；失败也只是壁纸回落到 CSS 兜底，
// 拖垮应用没有任何好处。
void loadBackground()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      {/* 顶层兜底：ErrorBoundary 早已实现（连文案都写着「不会直接白屏」），
          却从没被任何地方挂载 —— 于是任何渲染期异常都会把整棵 React 树卸载成
          纯白屏，用户连错误信息都看不到。「自动化」页空白就是这么暴露出来的。
          必须挂在 App **外面**，才能兜住 App 自身的渲染错误。 */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Provider>
  </StrictMode>
)
