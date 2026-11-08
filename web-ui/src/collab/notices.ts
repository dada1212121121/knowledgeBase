// 协作提示队列的纯逻辑(界面见 components/CollabBar.vue)。
// provider 在权限变化、整房被替换、重连发现内容被别处改过时会发 `notice`,其中有「你的修改没有保存」这种
// 用户必须看到的话。以前没有任何界面监听它,这些话是静默的。
// 规则:警告留着直到用户点掉(丢了东西的消息不能自己消失);普通提示 8 秒后自动收起;
// 同样的话只留一条(重连反复触发时不刷屏);最多同时显示 3 条,挤掉最老的。
import type { CollabNotice } from './provider'

export interface ShownNotice extends CollabNotice {
  id: number
}

export const MAX_NOTICES = 3
export const INFO_TTL_MS = 8000

/** 加入一条提示。同样的话替换掉旧的(顺序挪到最后、id 换新,自动收起的计时从头算)。 */
export function pushNotice(list: ShownNotice[], notice: CollabNotice, id: number): ShownNotice[] {
  const rest = list.filter((entry) => entry.text !== notice.text)
  return [...rest, { id, tone: notice.tone, text: notice.text }].slice(-MAX_NOTICES)
}

export function dismissNotice(list: ShownNotice[], id: number): ShownNotice[] {
  return list.filter((entry) => entry.id !== id)
}

/** 这条提示要不要自动收起 */
export function autoDismiss(notice: CollabNotice): boolean {
  return notice.tone === 'info'
}
