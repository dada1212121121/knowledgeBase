// 用户偏好的服务端存取(GET/PUT /api/v1/me/prefs)。
//
// 约定(后端已上线):响应 {ok, data: {prefs: {...}}};PUT 请求体 {prefs: {...}} **整体替换**,
// 不超过 8KB,只认浏览器会话,要带 X-KB-CSRF: 1。
// 因为是整体替换,写回时必须带上服务器返回的其它键,否则会把别的功能存的偏好冲掉。
export type PrefsObject = Record<string, unknown>

/** 读取服务端偏好;未登录 / 老后端 / 网络失败一律返回 null(偏好只是锦上添花,不能挡住页面)。 */
export async function fetchPrefs(): Promise<PrefsObject | null> {
  try {
    const response = await fetch('/api/v1/me/prefs', { credentials: 'same-origin', headers: { 'x-kb-csrf': '1' } })
    if (!response.ok) return null
    const body = (await response.json()) as { ok?: boolean; data?: { prefs?: unknown } }
    const prefs = body.data?.prefs
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as PrefsObject) : null
  } catch {
    return null
  }
}

/**
 * 整体写回偏好。失败静默返回 false。
 * keepalive:页面关闭 / 切到后台时的最后一次写入也要能发出去。
 */
export async function savePrefs(prefs: PrefsObject, options: { keepalive?: boolean } = {}): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/me/prefs', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-kb-csrf': '1' },
      body: JSON.stringify({ prefs }),
      keepalive: options.keepalive === true,
    })
    return response.ok
  } catch {
    return false
  }
}
