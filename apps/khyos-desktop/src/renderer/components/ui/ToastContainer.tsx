// khy-canary: Khy-20261102-328-TVSQHVR0
// ToastContainer — redux 接线版 toast 宿主（App.tsx 消费的就是这个）。
//
// 此前这里只做一件事：import 展示型的 ToastContainer（住在 Toast.tsx 里）再转发。
// 两个文件各有一个同名实现、职责交叉，改一处要改两处；现在展示型的列表容器
// 内联在本文件，Toast.tsx 只出口展示型 Toast 单件。

import { useAppSelector, useAppDispatch } from '../../state/store'
import { removeToast } from '../../state/toastSlice'
import { Toast } from './Toast'

interface ViewToast {
  id: string
  message: string
  type?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}

function ToastList({ toasts, onRemove }: { toasts: ViewToast[]; onRemove: (id: string) => void }) {
  return (
    // role="status" + aria-live="polite"：这块是「先有区域、后进内容」，
    // 屏幕阅读器才会把新 toast 当作一条通知念出来（只挂在每枚 toast 上不行：
    // 元素带着文案一起插入时，live region 往往不播报）。
    // pointer-events-none：容器固定在右下角，别挡住底下内容的点击。
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  )
}

export function ToastContainer() {
  const toasts = useAppSelector((state) => state.toast.toasts)
  const dispatch = useAppDispatch()
  // redux toast uses { title, description? } — adapt to the presentational { message }
  const viewToasts = toasts.map((t) => ({
    id: t.id,
    message: t.description ? `${t.title} ${t.description}` : t.title,
    type: t.type,
    // duration 必须透传：展示型 Toast 的默认是 3000ms，业务侧自定义的时长
    // （toastSlice 的 duration 字段）否则会被无声地吃掉。
    duration: t.duration,
  }))
  return <ToastList toasts={viewToasts} onRemove={(id) => dispatch(removeToast(id))} />
}
