// 分享接口封装的契约:请求体的形状(后端按这个解析)、公开接口的头与错误。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ShareHttpError,
  grantBatch,
  grantSet,
  linkCreate,
  publicCall,
  publicInfo,
  publicRawUrl,
  publicRename,
  publicUnlock,
  linkAccess,
  ownAccess,
  spaceAccess,
  type ShareTarget,
} from './share'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

type Call = [string, RequestInit]
function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}
const bodyOf = (spy: ReturnType<typeof mockFetch>, index = 0) => JSON.parse(String((spy.mock.calls[index] as unknown as Call)[1].body))
const urlOf = (spy: ReturnType<typeof mockFetch>, index = 0) => (spy.mock.calls[index] as unknown as Call)[0]
const headersOf = (spy: ReturnType<typeof mockFetch>, index = 0) => (spy.mock.calls[index] as unknown as Call)[1].headers as Record<string, string>

const note: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins_1' }

describe('协作者接口', () => {
  it('grant_set 带资源、人、角色;不填有效期就不带 expires_days(长期)', async () => {
    const spy = mockFetch(200, { ok: true, data: { grant: {}, previous: null } })
    await grantSet(note, 'usr_b', 'editor')
    expect(urlOf(spy)).toContain('/capabilities/grant_set')
    expect(bodyOf(spy)).toEqual({ target: note, user_id: 'usr_b', role: 'editor' })
  })

  it('grant_batch:有角色 = 加 / 改,没角色 = 移除(后端用缺省的 role 表示移除)', async () => {
    const spy = mockFetch(200, { ok: true, data: { changed: 2, unchanged: 0, removed: 0 } })
    await grantBatch([note], [{ user_id: 'usr_b', role: 'viewer' }, { user_id: 'usr_c' }, { user_id: 'usr_d', role: null }])
    expect(bodyOf(spy)).toEqual({ targets: [note], people: [{ user_id: 'usr_b', role: 'viewer' }, { user_id: 'usr_c' }, { user_id: 'usr_d' }] })
  })
})

describe('链接接口', () => {
  it('link_create 单个资源用 target,合集用 targets;不带 allow_reshare(后端只存不用,界面不提供)', async () => {
    const spy = mockFetch(200, { ok: true, data: { link: {}, url: 'https://x/s/abc' } })
    await linkCreate({ target: note, audience: 'anyone', role: 'viewer', expires_days: 7 })
    expect(bodyOf(spy)).toEqual({ target: note, audience: 'anyone', role: 'viewer', expires_days: 7 })
    expect(bodyOf(spy)).not.toHaveProperty('allow_reshare')
  })
})

describe('公开分享接口', () => {
  it('取状态:GET,带 CSRF 头,令牌要转义', async () => {
    const spy = mockFetch(200, { ok: true, data: { state: 'locked', requires_password: true, site: { name: '知识库' } } })
    const info = await publicInfo('a/b')
    expect(info.state).toBe('locked')
    expect(urlOf(spy)).toBe('/api/v1/share/a%2Fb')
    expect((spy.mock.calls[0] as unknown as Call)[1].method).toBe('GET')
    expect(headersOf(spy)['x-kb-csrf']).toBe('1')
  })

  it('解锁 / 改昵称 / 调能力都是 POST 且带 CSRF 与 JSON', async () => {
    const spy = mockFetch(200, { ok: true, data: { unlocked: true } })
    await publicUnlock('tok', 'sesame1')
    await publicRename('tok', '小王')
    await publicCall('tok', 'get_item', { id: 'ins_1' })
    expect(urlOf(spy, 0)).toBe('/api/v1/share/tok/unlock')
    expect(bodyOf(spy, 0)).toEqual({ password: 'sesame1' })
    expect(urlOf(spy, 1)).toBe('/api/v1/share/tok/guest')
    expect(bodyOf(spy, 1)).toEqual({ nickname: '小王' })
    expect(urlOf(spy, 2)).toBe('/api/v1/share/tok/call/get_item')
    for (const index of [0, 1, 2]) {
      expect(headersOf(spy, index)['x-kb-csrf']).toBe('1')
      expect(headersOf(spy, index)['content-type']).toBe('application/json')
    }
  })

  it('失败抛 ShareHttpError,带状态码和错误码;401 不会跳登录页(那是「要输密码」的正常回答)', async () => {
    const location = { href: '/s/tok', pathname: '/s/tok', search: '' }
    Object.defineProperty(window, 'location', { value: location, writable: true })
    mockFetch(401, { ok: false, error: { code: 'wrong_password', message: '访问密码不正确' } })
    const error = await publicUnlock('tok', 'x').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ShareHttpError)
    expect(error).toMatchObject({ status: 401, code: 'wrong_password', message: '访问密码不正确' })
    expect(location.href).toBe('/s/tok')
  })

  it('429 锁定也能区分出来(和密码错是两种文案)', async () => {
    mockFetch(429, { ok: false, error: { code: 'locked', message: '输错次数太多,请 10 分钟后再试' } })
    await expect(publicUnlock('tok', 'x')).rejects.toMatchObject({ status: 429, code: 'locked' })
  })

  it('连不上服务器时给一句人话,不是 Failed to fetch', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const error = await publicInfo('tok').catch((err: unknown) => err)
    expect(error).toMatchObject({ status: 0, code: 'network' })
    expect(String((error as Error).message)).not.toContain('fetch')
  })

  it('响应体不是 JSON(网关错误页)也不会抛出奇怪的解析异常', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    await expect(publicInfo('tok')).rejects.toMatchObject({ status: 502, code: 'unknown' })
  })

  it('原件地址同源,集合和路径编码', () => {
    expect(publicRawUrl('tok', 'proj/a', 'docs/图 1.png')).toBe('/api/v1/share/tok/raw?collection=proj%2Fa&path=docs%2F%E5%9B%BE+1.png')
  })
})

describe('spaceAccess:共享给我——每次调用都带对方的知识库 id', () => {
  it('能力调用带 X-KB-Space(请求落在对方的知识库,不是我自己的);原件地址带 space 参数', async () => {
    const spy = mockFetch(200, { ok: true, data: { item: {} } })
    const access = spaceAccess('sp_alice0123', 'viewer')
    await access.call('get_item', { id: 'ins_1' })
    expect(urlOf(spy)).toContain('/capabilities/get_item')
    expect(headersOf(spy)['x-kb-space']).toBe('sp_alice0123')
    expect(bodyOf(spy)).toEqual({ id: 'ins_1' })
    expect(access.rawUrl('proj/a', 'docs/图.png')).toBe('/api/v1/raw?collection=proj%2Fa&path=docs%2F%E5%9B%BE.png&space=sp_alice0123')
  })

  it('能做什么跟着角色走:查看只读;评论可评论;编辑可编辑;都可以下载', () => {
    const can = (role: string) => spaceAccess('sp', role).can
    expect(can('viewer')).toEqual({ edit: false, comment: false, download: true })
    expect(can('commenter')).toEqual({ edit: false, comment: true, download: true })
    expect(can('editor')).toEqual({ edit: true, comment: true, download: true })
    expect(can('manager')).toEqual({ edit: true, comment: true, download: true })
  })
})

describe('linkAccess:公开链接——能力走 /share/{token}/call,不碰账号接口', () => {
  it('公开链接入口都带 viaLink(页面据此不去请求白名单之外的能力);自己的库和共享给我没有', () => {
    expect(linkAccess('tok', { view: true, comment: false, edit: true, download: false }).viaLink).toBe(true)
    expect(linkAccess('tok', { view: true, comment: false, edit: true, download: false }, { guest: true }).viaLink).toBe(true)
    expect(spaceAccess('sp_a', 'editor').viaLink).toBeUndefined()
    expect(ownAccess(true).viaLink).toBeUndefined()
  })

  it('调用走令牌自己的路径,没有 X-KB-Space,也没有 /capabilities/', async () => {
    const spy = mockFetch(200, { ok: true, data: {} })
    const access = linkAccess('tok', { view: true, comment: true, edit: false, download: false })
    await access.call('add_annotation', { body: '好' })
    expect(urlOf(spy)).toBe('/api/v1/share/tok/call/add_annotation')
    expect(urlOf(spy)).not.toContain('/capabilities/')
    expect(headersOf(spy)['x-kb-space']).toBeUndefined()
    expect(access.rawUrl('c', 'a.png')).toBe('/api/v1/share/tok/raw?collection=c&path=a.png')
  })

  it('能做什么直接用服务端给的 can(含游客降级后的结果和「不许下载」),不自己推算', () => {
    expect(linkAccess('tok', { view: true, comment: false, edit: false, download: false }).can).toEqual({ edit: false, comment: false, download: false })
    expect(linkAccess('tok', { view: true, comment: true, edit: true, download: true }).can).toEqual({ edit: true, comment: true, download: true })
  })
})
