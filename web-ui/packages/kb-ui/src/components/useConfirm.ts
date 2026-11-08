// 确认弹窗的 Promise 接口,替换浏览器原生的 window.confirm:
//
//   const ok = await useConfirm.ask({
//     title: '删除这条经验?', message: '可以在「审计 / 批次」里撤销。', confirmText: '删除', tone: 'danger',
//     doneText: '已删除',                        // 可选:成功后弹窗原地变成「✓ 已删除」,停一会儿再收起
//     action: () => callCapability('delete_item', { id }),   // 可选:点确认后在弹窗里执行,期间按钮转圈;失败就地显示错误,可重试
//   })
//
// 返回 true = 已确认(有 action 时表示 action 成功);false = 取消 / Esc。点遮罩不会关闭(必须明确选一个)。
import { reactive } from 'vue'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  tone?: 'default' | 'danger'
  doneText?: string
  action?: () => Promise<unknown>
}

export type ConfirmPhase = 'ask' | 'busy' | 'done'

interface ConfirmState {
  open: boolean
  phase: ConfirmPhase
  error: string
  options: ConfirmOptions
  resolve: ((ok: boolean) => void) | null
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  phase: 'ask',
  error: '',
  options: { title: '' },
  resolve: null,
})

const DONE_HOLD_MS = 800

function settle(ok: boolean) {
  const resolve = confirmState.resolve
  confirmState.resolve = null
  confirmState.open = false
  resolve?.(ok)
}

export function cancelConfirm() {
  if (confirmState.phase === 'busy') return
  settle(false)
}

export async function acceptConfirm() {
  if (confirmState.phase === 'busy') return
  const { action, doneText } = confirmState.options
  if (!action) {
    if (doneText) {
      confirmState.phase = 'done'
      window.setTimeout(() => settle(true), DONE_HOLD_MS)
    } else {
      settle(true)
    }
    return
  }
  confirmState.phase = 'busy'
  confirmState.error = ''
  try {
    await action()
  } catch (err) {
    confirmState.phase = 'ask'
    confirmState.error = err instanceof Error ? err.message : '操作失败'
    return
  }
  if (doneText) {
    confirmState.phase = 'done'
    window.setTimeout(() => settle(true), DONE_HOLD_MS)
  } else {
    settle(true)
  }
}

/** Esc:done 阶段立刻收起并算作成功;其余阶段取消。 */
export function escapeConfirm() {
  if (confirmState.phase === 'done') settle(true)
  else cancelConfirm()
}

export function useConfirm() {
  return {
    ask(options: ConfirmOptions): Promise<boolean> {
      // 已有一个在问:先按取消收掉(同一时刻只会有一个确认框)
      if (confirmState.resolve) settle(false)
      return new Promise<boolean>((resolve) => {
        confirmState.options = options
        confirmState.phase = 'ask'
        confirmState.error = ''
        confirmState.resolve = resolve
        confirmState.open = true
      })
    },
  }
}
