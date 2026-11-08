// 编辑器的 key:没有协作连接是 'solo',有连接是 'collab-<文档代>'。
// 协作插件只能在创建编辑器时装进去,而文档被作废重开(docEpoch 加一)后旧的 Yjs 文档已经和房间无关,
// 所以连接出现 / 消失 / 换代时都要把编辑器整个重建。
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { CollabProvider } from './provider'

export function useCollabKey(source: () => CollabProvider | null | undefined): Ref<string> {
  const key = ref('solo')
  let off: (() => void) | null = null
  const stop = watch(
    source,
    (provider) => {
      off?.()
      off = null
      if (!provider) {
        key.value = 'solo'
        return
      }
      key.value = `collab-${provider.getState().docEpoch}`
      off = provider.subscribe((state) => {
        key.value = `collab-${state.docEpoch}`
      })
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    stop()
    off?.()
  })
  return key
}
