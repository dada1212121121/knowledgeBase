// 个人访问令牌(后端 crates/kb-web/src/auth/mod.rs 的 create_token / list_tokens / revoke_token,形状见 e2e_mcp_users.rs 的 make_token)。
// 注意这是浏览器会话专用的 HTTP 接口,不是能力调用:能力 `create_token`(系统设置页在用)没有 include_shared 参数。
import { accountRequest, type ApiToken } from './client'

export type TokenScope = 'mcp' | 'api'

export interface CreatedToken {
  id: string
  name: string
  scope: TokenScope
  /** 令牌明文,**只在创建时返回这一次**。 */
  token: string
}

/** 我的令牌(含已撤销的)。 */
export async function tokensList(): Promise<ApiToken[]> {
  const data = await accountRequest<{ tokens?: ApiToken[] }>('GET', '/api/v1/auth/tokens', { signedIn: true })
  return (data.tokens ?? []).map((token) => ({ ...token, scopes: token.scopes ?? token.scope ?? '' }))
}

/**
 * 新建令牌。`includeShared` 只对 `mcp` 令牌生效(后端对 `api` 令牌会忽略它),所以 `api` 时一律不发 true,
 * 免得界面上看着开了、实际没生效。
 */
export const tokenCreate = (name: string, scope: TokenScope, includeShared: boolean) =>
  accountRequest<CreatedToken>('POST', '/api/v1/auth/tokens', {
    json: { name: name.trim(), scope, include_shared: scope === 'mcp' && includeShared },
    signedIn: true,
  })

/** 撤销令牌:用它的客户端立即失效,不能恢复。 */
export const tokenRevoke = (id: string) =>
  accountRequest<{ id: string; revoked_at: number }>('DELETE', `/api/v1/auth/tokens/${encodeURIComponent(id)}`, { signedIn: true })
