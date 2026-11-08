// 「站点要求开启两步验证」的全局处理。
//
// 站点设置了 `accounts.require_admin_totp` 以后,没开两步验证的管理级账号,除 /api/v1/auth/ 之外的所有接口
// 都会被后端拒绝:403,`error.code = totp_setup_required`。如果每个页面各自把它当普通报错弹出来,用户只会看到
// 满屏的「加载失败」而不知道该做什么。所以在这里统一拦:
//   1. 包装 window.fetch(项目里有十几处直接 fetch,不止 callCapability),发现这个错误就通知上层;
//   2. 上层(main.ts)记下标记并把用户带到个人设置的两步验证区;路由守卫(router/index.ts)在标记放下之前
//      把其它页面都挡回那里——页面不会再去请求注定失败的接口。
// 只读响应的副本(clone),调用方照常读自己的那份。

/** 后端的错误码。 */
export const TOTP_SETUP_REQUIRED = 'totp_setup_required'

/** 个人设置里两步验证所在的页面(与 router/paths.ts 的 PATHS.me 一致,这里不引入路由以免循环依赖)。 */
const SETUP_PATH = '/me'

const INSTALLED = Symbol.for('kb.authGate.installed')

function isApiRequest(input: RequestInfo | URL, origin: string): boolean {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin)
    return url.origin === origin && url.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/** 这个响应是不是「要先开启两步验证」的拒绝。不会消耗原响应的内容。 */
export async function isTotpSetupRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } } | null
    return body?.error?.code === TOTP_SETUP_REQUIRED
  } catch {
    // 不是 JSON(网关的 403 页面等):不是我们关心的那种
    return false
  }
}

/**
 * 包装 `fetch`:遇到 `totp_setup_required` 就调用 `onRequired`。重复调用无副作用。
 * `onRequired` 抛错也不影响业务请求的结果。
 */
export function installAuthGate(onRequired: () => void, target: Pick<Window, 'fetch' | 'location'> = window): void {
  const holder = target as unknown as Record<symbol, boolean>
  if (holder[INSTALLED]) return
  holder[INSTALLED] = true
  const original = target.fetch.bind(target)
  target.fetch = async (input, init) => {
    const response = await original(input, init)
    if (response.status === 403 && isApiRequest(input, target.location.origin) && (await isTotpSetupRequired(response))) {
      try {
        onRequired()
      } catch {
        /* 上层处理失败不能让业务请求也失败 */
      }
    }
    return response
  }
}

/**
 * 路由守卫用:标记已置位时,除个人设置和公开页之外的导航都改道去两步验证区。
 * 返回 `true` 表示放行,否则是要跳转的位置。
 */
export function totpGateRedirect(to: { path: string; meta?: { public?: boolean } }, needsSetup: boolean): true | { path: string; query: { need: string }; replace: true } {
  if (!needsSetup || to.meta?.public || to.path === SETUP_PATH) return true
  return { path: SETUP_PATH, query: { need: 'totp' }, replace: true }
}
