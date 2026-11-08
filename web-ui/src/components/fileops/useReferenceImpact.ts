// 删除 / 移动前的引用影响:查有多少篇文档引用了这个文件。
//
// 链接图谱是辅助信息,查询失败(旧服务 / 没有权限)不能拦住删除或移动,所以只返回 null。
import { onMounted, ref, type Ref } from 'vue'
import { callCapability } from '@/api/client'
import type { FileActions } from './types'

export function useReferenceImpact(actions: FileActions): Ref<number | null> {
  const references = ref<number | null>(null)
  onMounted(async () => {
    try {
      const result = await callCapability<{ inbound?: unknown[] }>('doc_links', {
        collection: actions.collection,
        ...(actions.folder ? { path_prefix: actions.path } : { path: actions.path }),
        direction: 'to',
        limit: 50,
      })
      references.value = result.inbound?.length ?? 0
    } catch {
      references.value = null
    }
  })
  return references
}
