// 「这个功能点我现在能不能用」:入口是否显示统一问这里(设计规范,.9)。
//
// 最终是否显示 = AI 总开关开 且 子开关开 且 角色有这个功能点 且 没被单独禁止,
// 这些后端已经折算进了 /auth/me 的 features 列表;前端只看列表里有没有。
// 隐藏只是体验,不是安全边界:后端对每个能力调用照样检查。
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'

/** 响应式地判断一个功能点;没有传功能点表示不限制。 */
export function useFeature(feature?: string) {
  const session = useSessionStore()
  return computed(() => session.has(feature))
}

/** 一次判断多个:全部具备才算(例如既要 ai.assistant 又要 ai.acp)。 */
export function useFeatures(features: string[]) {
  const session = useSessionStore()
  return computed(() => features.every((feature) => session.has(feature)))
}
