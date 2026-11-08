// `@` 引用的状态机:检测触发、按类型搜索、键盘选择、插入引用链接。
import { computed, ref } from 'vue'
import {
  MENTION_KINDS,
  mentionQueryOf,
  mentionToken,
  searchMentions,
  type MentionKind,
  type MentionRef,
  type MentionSearchContext,
} from '@/agent/mentions'

export function useMentions(getContext: () => MentionSearchContext) {
  const open = ref(false)
  const query = ref('')
  const start = ref(0)
  const kind = ref<MentionKind>('agent')
  const items = ref<MentionRef[]>([])
  const active = ref(0)
  const loading = ref(false)
  const kinds = MENTION_KINDS

  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh() {
    const mine = ++seq
    loading.value = true
    try {
      const result = await searchMentions(kind.value, query.value, getContext())
      if (mine !== seq) return
      items.value = result
      active.value = 0
    } catch {
      if (mine === seq) items.value = []
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  /** 输入变化:末尾有 `@xxx` 就开面板。 */
  function onInput(text: string) {
    const hit = mentionQueryOf(text)
    if (!hit) {
      open.value = false
      return
    }
    const wasOpen = open.value
    open.value = true
    query.value = hit.query
    start.value = hit.start
    if (!wasOpen) {
      kind.value = 'agent'
      void refresh()
    } else {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 160)
    }
  }

  function setKind(next: MentionKind) {
    kind.value = next
    void refresh()
  }

  function move(delta: number) {
    if (!open.value || items.value.length === 0) return
    active.value = (active.value + delta + items.value.length) % items.value.length
  }

  /** 选中:代理返回 ref(由调用方切后端),其余把 `@query` 换成引用链接。 */
  function choose(index: number, text: string): { text: string; ref?: MentionRef } {
    const ref = items.value[index]
    if (!ref) return { text }
    open.value = false
    if (ref.kind === 'agent') return { text, ref }
    const before = text.slice(0, start.value)
    return { text: `${before}${mentionToken(ref)} `, ref }
  }

  function close() {
    open.value = false
  }

  const current = computed(() => items.value[active.value])

  return {
    open,
    query,
    kind,
    items,
    active,
    loading,
    kinds,
    current,
    onInput,
    setKind,
    move,
    choose,
    close,
  }
}
