// 管理员只读查看子树里的统一调用:每次都显式带上目标用户(`X-KB-Admin-View`)。
//
// 不放进全局状态:管理员自己的通知、会话、上传等后台请求必须仍然落在自己的知识库里,
// 只有这个弹窗里的页面组件通过它调用。
import { toValue, type MaybeRefOrGetter } from 'vue'
import { callCapability, type CallOptions } from '@/api/client'

/** 返回一个和 `callCapability` 同形的函数;`viewAs` 为空时就是普通调用。 */
export function useViewCall(viewAs: MaybeRefOrGetter<string | undefined>) {
  return <T = unknown>(name: string, args: Record<string, unknown> = {}, options: CallOptions = {}) =>
    callCapability<T>(name, args, { ...options, adminView: toValue(viewAs) ?? options.adminView })
}
