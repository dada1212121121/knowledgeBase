// Toast 队列(全局单例):「已保存 / 已复制 / 已撤销」这类操作回馈。
// 每条自带倒计时细条,鼠标停在上面会暂停(由 KbToastStack 的 CSS 动画实现);点击立即关闭。
import { reactive } from 'vue'

export interface Toast {
  id: number
  message: string
  tone: 'success' | 'warning' | 'danger'
  /** 毫秒 */
  duration: number
}

export const toasts = reactive<Toast[]>([])

let nextId = 1
const MAX = 4

export function dismissToast(id: number) {
  const index = toasts.findIndex((toast) => toast.id === id)
  if (index >= 0) toasts.splice(index, 1)
}

export function useToast() {
  return {
    push(message: string, tone: Toast['tone'] = 'success', duration = tone === 'danger' ? 5200 : 3200) {
      const id = nextId++
      toasts.unshift({ id, message, tone, duration })
      // 最多同时 4 条,更早的直接收掉
      while (toasts.length > MAX) toasts.pop()
      // 兜底:倒计时动画没跑起来(标签页在后台等)时也要消失
      window.setTimeout(() => dismissToast(id), duration + 2500)
    },
  }
}
