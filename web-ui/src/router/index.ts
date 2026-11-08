// 路由实例与守卫。路由表在 routes.ts,旧地址重定向在 legacy.ts,地址常量在 paths.ts。
import { createRouter, createWebHistory } from 'vue-router'
import { authStatus } from '@/api/client'
import { totpGateRedirect } from '@/api/authGate'
import { useSessionStore } from '@/stores/session'
import { classifyUnavailable } from '@/utils/status'
import { routes } from './routes'

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 未登录时跳登录页(登录页本身与静态资源除外)。
// 登录态**缓存 5 分钟**:每次切页都等一次 /auth/status 往返(经隧道要几百毫秒)是“切页发黏”的主因;
// 会话过期时能力调用会返回 401,client.ts 会立刻跳登录页,所以缓存不会放过未登录访问。
const AUTH_TTL_MS = 5 * 60_000
let verifiedAt = 0

export function forgetAuth() {
  verifiedAt = 0
}

// 站点要求开启两步验证而当前账号还没开(见 api/authGate.ts):在开启之前,其它页面都回到个人设置的两步验证区。
// 放在登录检查前面——这个标记只在已经登录、并被后端明确拒绝之后才会置位。
router.beforeEach((to) => totpGateRedirect(to, useSessionStore().needsTotpSetup))

router.beforeEach(async (to) => {
  if (to.meta.public) {
    verifiedAt = 0
    return true
  }
  if (Date.now() - verifiedAt < AUTH_TTL_MS) return true
  try {
    const status = await authStatus()
    if (!status.logged_in) {
      return { path: '/login', query: { next: to.fullPath } }
    }
    verifiedAt = Date.now()
  } catch (err) {
    // 连不上服务 / 服务返回错误:不能当成「没登录」扔去登录页(登录页同样连不上,用户只看到一个不会好的登录框)。
    // 带上原因和要去的地址,服务不可用页会自动重试,恢复后回到这里
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null
    return { path: '/unavailable', query: { kind: classifyUnavailable(status, navigator.onLine), next: to.fullPath } }
  }
  return true
})

// 首屏之后在浏览器空闲时把其它页面的代码块预取好:点侧栏时不再等 JS 下载。
// Browser 的编辑器外壳是单独异步块,不在这里预取,只在真正进入编辑时加载。
let preloaded = false
router.afterEach((to) => {
  if (preloaded || to.meta.public) return
  preloaded = true
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
  const run = () => {
    for (const route of routes) {
      const component = (route as { component?: unknown }).component
      if (typeof component === 'function') void (component as () => Promise<unknown>)().catch(() => undefined)
    }
  }
  if (idle) idle(run)
  else window.setTimeout(run, 1500)
})

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    public?: boolean
    /** 在导航里归属的一级入口路径(没有就是它自己) */
    group?: string
    /** 页面类型:workbench = 文档工作台(自带顶栏) */
    chrome?: 'workbench'
    /** 手机顶栏左上角「返回」的目标;不写就回「我的」页 */
    parent?: string
  }
}
