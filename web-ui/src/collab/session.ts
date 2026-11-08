// 打开一个协作连接:拼地址、接上"握手失败后查原因"、连接。登录用户走 /api/v1/collab/ws;
// 分享链接的访问者走 /api/v1/share/{token}/collab(后端各自核对权限)。
import { CollabProvider, type Diagnosis } from './provider'
import { collabKindOf, docKey, type DocRefInput } from './resourceKey'

export interface OpenCollabOptions {
  spaceId: string
  collection: string
  doc: DocRefInput
  /** 经分享链接进来时的链接令牌;不给就是登录用户 */
  linkToken?: string
}

export function collabUrl(options: OpenCollabOptions, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const doc = encodeURIComponent(docKey(options.spaceId, options.collection, options.doc))
  const path = options.linkToken ? `/api/v1/share/${encodeURIComponent(options.linkToken)}/collab` : '/api/v1/collab/ws'
  return `${scheme}://${location.host}${path}?doc=${doc}`
}

/**
 * 握手被拒时浏览器只知道"没连上",看不到 HTTP 状态码。provider 连续失败几次后会来问一次原因:
 * 这里用一个普通的读取请求(笔记 get_item / 文件 file_preview / 链接 info)探一下同一篇文档,
 * 把状态码翻成人话。能确定"再试也没用"的(没登录 / 没权限 / 不存在)返回终止性的结论,
 * 其余(限流、服务暂不可用)返回 retry 只更新提示,provider 继续退避重连。
 */
export function diagnosisFromStatus(status: number): Diagnosis | null {
  if (status === 401) return { kind: 'unauthorized', message: '登录已经过期,请重新登录后再编辑。' }
  if (status === 403) return { kind: 'denied', message: '你现在没有权限编辑这篇文档。联系文档的所有者确认。' }
  // 对没有权限的人,后端对不存在和无权访问一律回 404,不泄露文档是否存在
  if (status === 404) return { kind: 'denied', message: '这篇文档不存在,或者你已经没有权限打开它。' }
  if (status === 410) return { kind: 'deleted', message: '这篇文档已经被删除。' }
  if (status === 429) return { kind: 'retry', message: '操作太频繁了,稍后会自动重试。' }
  if (status === 503) return { kind: 'retry', message: '服务暂时不可用,稍后会自动重试。' }
  if (status >= 200 && status < 300) return { kind: 'retry', message: '协作服务暂时连不上,正在重试。你的修改先留在本页。' }
  return null
}

export function probeRequest(options: OpenCollabOptions): { url: string; init: RequestInit } {
  const json = { 'content-type': 'application/json', 'x-kb-csrf': '1' }
  if (options.linkToken) {
    return { url: `/api/v1/share/${encodeURIComponent(options.linkToken)}`, init: { credentials: 'same-origin' } }
  }
  const headers = { ...json, 'x-kb-space': options.spaceId }
  if ('insight' in options.doc) {
    return { url: '/api/v1/capabilities/get_item', init: { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ id: options.doc.insight }) } }
  }
  return {
    url: '/api/v1/capabilities/file_preview',
    init: { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ collection: options.collection, path: options.doc.file }) },
  }
}

async function diagnose(options: OpenCollabOptions): Promise<Diagnosis | null> {
  try {
    const request = probeRequest(options)
    const response = await fetch(request.url, request.init)
    return diagnosisFromStatus(response.status)
  } catch {
    // 网络不通:当作普通断线重试
    return null
  }
}

export function openCollab(options: OpenCollabOptions): CollabProvider {
  const provider = new CollabProvider({
    url: () => collabUrl(options),
    kind: collabKindOf(options.doc),
    diagnose: () => diagnose(options),
  })
  provider.connect()
  return provider
}
