// 当前登录用户和他最终生效的功能(来自 /api/v1/auth/me)。
//
// 界面上每个入口是否显示都问这里:没开通的功能、被管理员关掉的 AI 功能,入口一律不出现。
// 后端对每个能力调用照样检查功能点(隐藏只是体验,不是安全边界)。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { visibleInterval } from '@/utils/visibleInterval'

export interface SessionUser {
  id: string
  username: string
  display_name: string
  email: string | null
  /** 邮箱是否已验证(老后端没有这个字段,按未知处理)。 */
  email_verified?: boolean
  /** 头像文件名;没有头像是 null。拼地址见 utils/avatar.ts。 */
  avatar?: string | null
  /** 正在注销的账号:冷静期结束的时间(毫秒时间戳);不在注销中是 null。 */
  delete_after?: number | null
  role_id: string
  space_id: string | null
  must_change_password: boolean
}

interface MeResponse {
  local: boolean
  user: (SessionUser & { features: string[]; ai_enabled: boolean }) | null
  features?: string[]
  ai_enabled?: boolean
  /** 部署开关:关掉后连 `sys.inspect` 也不显示「查看」。老后端没有这个字段,按开处理。 */
  admin_inspect_enabled?: boolean
}

/** 隔多久在后台刷新一次(管理员改了角色 / 关了 AI,不用刷新页面也会跟上)。 */
const REFRESH_MS = 20_000

export const useSessionStore = defineStore('session', () => {
  const user = ref<SessionUser | null>(null)
  const features = ref<Set<string>>(new Set())
  const aiEnabled = ref(true)
  /** 部署开关 `[admin] inspect_enabled`;关掉后前端不显示「查看」。 */
  const inspectEnabled = ref(true)
  /** 第一次拿到答案之前为 false:这时不要因为「没有功能」而闪一下隐藏。 */
  const loaded = ref(false)
  /**
   * 站点要求管理级账号开启两步验证、而这个账号还没开:后端会拒绝除 /api/v1/auth/ 以外的所有接口(403 totp_setup_required)。
   * 只放内存里:刷新页面后由第一次被拒绝的请求重新置位。置位后路由守卫把所有页面带到个人设置的两步验证区(见 api/authGate.ts)。
   */
  const needsTotpSetup = ref(false)
  let stopRefresh: (() => void) | undefined

  async function load() {
    try {
      const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' })
      if (!response.ok) return
      const body = (await response.json()) as { data?: MeResponse }
      const data = body.data
      if (!data) return
      const list = data.user?.features ?? data.features
      // 形状不对(老后端、被代理改写)就当没拿到,宁可多显示也别把所有入口藏掉
      if (!Array.isArray(list)) return
      features.value = new Set(list)
      aiEnabled.value = data.user?.ai_enabled ?? data.ai_enabled ?? true
      inspectEnabled.value = data.admin_inspect_enabled ?? true
      user.value = data.user
        ? {
            id: data.user.id,
            username: data.user.username,
            display_name: data.user.display_name,
            email: data.user.email,
            email_verified: data.user.email_verified,
            avatar: data.user.avatar ?? null,
            delete_after: data.user.delete_after ?? null,
            role_id: data.user.role_id,
            space_id: data.user.space_id,
            must_change_password: data.user.must_change_password,
          }
        : null
      loaded.value = true
    } catch {
      /* 网络抖动时保留上一次的结果 */
    }
  }

  /** 开始定时刷新(重复调用无副作用)。 */
  function start() {
    if (stopRefresh) return
    // 标签页在后台时不刷新,回到前台再补一次
    stopRefresh = visibleInterval(() => void load(), REFRESH_MS, { immediate: true })
  }

  /** 有没有这个功能点。还没加载完时按「有」处理,避免入口先消失再出现。 */
  function has(feature: string | undefined): boolean {
    if (!feature) return true
    if (!loaded.value) return true
    return features.value.has(feature)
  }

  /** 有没有任意一个 `sys.*` 系统功能(决定要不要显示系统设置)。 */
  const isAdmin = computed(() => {
    if (!loaded.value) return true
    return [...features.value].some((id) => id.startsWith('sys.'))
  })

  return { user, features, aiEnabled, inspectEnabled, loaded, needsTotpSetup, load, start, has, isAdmin }
})
