// PWA 资源与 service worker:manifest 字段、图标真实尺寸、index.html 声明、sw.js 的缓存策略(在沙箱里真跑它的 fetch 处理)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PATHS } from '@/router/paths'
import { THEME_COLORS } from '@kb-ui/theme/useAppearance'
import { registerServiceWorker } from './register'
import { pngInfo as readPngInfo, readText, runInSandbox } from '../../scripts/lib/files.mjs'

const read = (name: string) => readText(`public/${name}`)
const manifest = JSON.parse(read('manifest.webmanifest'))
const pngInfo = (name: string) => readPngInfo(`public/${name}`)

describe('manifest', () => {
  it('必填字段:名称、起始地址在作用域内、独立窗口显示、语言', () => {
    expect(manifest.name).toBe('knowledgeBase')
    expect(manifest.short_name).toBe('知识库')
    expect(manifest.display).toBe('standalone')
    expect(manifest.lang).toBe('zh-CN')
    expect(manifest.scope).toBe('/')
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true)
    expect(manifest.id).toBe('/')
  })
  it('颜色跟默认(深色)主题的页面底色一致,启动画面不闪白', () => {
    expect(manifest.theme_color).toBe(THEME_COLORS.dark)
    expect(manifest.background_color).toBe(THEME_COLORS.dark)
  })
  it('图标:192 与 512 的 any、512 的 maskable;文件存在且真实尺寸与声明一致', () => {
    const find = (size: string, purpose: string) => manifest.icons.find((icon: { sizes: string; purpose: string }) => icon.sizes === size && icon.purpose === purpose)
    expect(find('192x192', 'any')).toBeTruthy()
    expect(find('512x512', 'any')).toBeTruthy()
    expect(find('512x512', 'maskable')).toBeTruthy()
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      const info = pngInfo(icon.src.slice(1))
      expect(`${info.width}x${info.height}`).toBe(icon.sizes)
      expect(icon.type).toBe('image/png')
    }
  })
  it('apple-touch-icon 是 180×180 的不透明 PNG(iOS 自己加圆角,透明会变成黑底)', () => {
    const info = pngInfo('icons/apple-touch-icon.png')
    expect([info.width, info.height]).toEqual([180, 180])
    expect(info.colorType).toBe(6)
  })
  it('快捷方式指向真实存在的页面', () => {
    const known = new Set<string>(Object.values(PATHS))
    for (const shortcut of manifest.shortcuts as { url: string }[]) expect(known.has(shortcut.url)).toBe(true)
  })
})

describe('index.html', () => {
  const html = readText('index.html')
  it('声明 manifest、主题色、图标与 iOS 主屏幕 App 所需的 meta', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('<meta name="theme-color"')
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black"')
    expect(html).toContain('viewport-fit=cover')
  })
  it('theme-color 的初值在 boot 脚本之前(脚本要能改到它)', () => {
    expect(html.indexOf('name="theme-color"')).toBeLessThan(html.indexOf('<script src="/appearance-boot.js">'))
  })
})

// ---- service worker:在沙箱里加载 public/sw.js,伪造运行环境,真的触发它的事件 ----
type Handler = (event: unknown) => void
function loadWorker(origin = 'https://kb.test') {
  const handlers: Record<string, Handler> = {}
  const store = new Map<string, Map<string, { body: string; type: string }>>()
  class FakeResponse {
    constructor(public body: string, public init: { status?: number; headers?: Record<string, string> } = {}) {}
    get status() { return this.init.status ?? 200 }
    get ok() { return this.status >= 200 && this.status < 300 }
    get headers() { return { get: (name: string) => this.init.headers?.[name.toLowerCase()] ?? this.init.headers?.[name] ?? null } }
    clone() { return new FakeResponse(this.body, this.init) }
  }
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map())
      const bucket = store.get(name)!
      return {
        match: async (request: { url: string }) => {
          const hit = bucket.get(request.url)
          return hit ? new FakeResponse(hit.body, { headers: { 'content-type': hit.type } }) : undefined
        },
        put: async (request: { url: string }, response: FakeResponse) => {
          bucket.set(request.url, { body: response.body, type: response.headers.get('content-type') ?? '' })
        },
        keys: async () => [...bucket.keys()].map((url) => ({ url })),
        delete: async (request: { url: string }) => bucket.delete(request.url),
      }
    },
  }
  const network = vi.fn<(request: { url: string }) => Promise<FakeResponse>>()
  const self = {
    location: { origin },
    addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
  }
  runInSandbox(read('sw.js'), { self, caches, fetch: network, Response: FakeResponse, URL, Math })
  /** 触发 fetch 事件;返回 respondWith 的结果(没接管则 undefined)。 */
  async function dispatchFetch(path: string, init: { method?: string; mode?: string; origin?: string } = {}) {
    let responded: Promise<FakeResponse> | undefined
    const request = { url: `${init.origin ?? origin}${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }
    handlers.fetch({ request, respondWith: (value: Promise<FakeResponse>) => (responded = value) })
    return responded ? await responded : undefined
  }
  /** 当前缓存名(sw.js 里的 CACHE);断言用它,不写死版本号,否则改名后断言会静默变成「永远是空」。 */
  const currentCache = async () => {
    let done: Promise<unknown> = Promise.resolve()
    handlers.activate({ waitUntil: (value: Promise<unknown>) => (done = value) })
    await done
    return [...store.keys()].find((name) => name.startsWith('kb-static-')) ?? ''
  }
  return { handlers, store, network, self, dispatchFetch, FakeResponse, currentCache }
}

describe('sw.js', () => {
  it('静态资源:缓存优先——第一次走网络并存下,第二次直接命中、不再请求网络', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValue(new worker.FakeResponse('console.log(1)', { headers: { 'content-type': 'text/javascript' } }))
    const first = await worker.dispatchFetch('/assets/app-abc123.js')
    expect(first?.body).toBe('console.log(1)')
    expect(worker.network).toHaveBeenCalledTimes(1)
    const second = await worker.dispatchFetch('/assets/app-abc123.js')
    expect(second?.body).toBe('console.log(1)')
    expect(worker.network).toHaveBeenCalledTimes(1)
  })
  it('图标(固定文件名):网络优先——换了 Logo,老用户下次打开就能拿到新的', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValueOnce(new worker.FakeResponse('old-svg', { headers: { 'content-type': 'image/svg+xml' } }))
    expect((await worker.dispatchFetch('/icon.svg'))?.body).toBe('old-svg')
    // 换了图标(同一个 URL、新内容):必须再回源一次,而不是一直吃缓存里的旧图
    worker.network.mockResolvedValueOnce(new worker.FakeResponse('new-svg', { headers: { 'content-type': 'image/svg+xml' } }))
    expect((await worker.dispatchFetch('/icon.svg'))?.body).toBe('new-svg')
    expect(worker.network).toHaveBeenCalledTimes(2)
    // 缓存里也已经是新的,断网时不会退回到旧图标
    const bucket = worker.store.get(await worker.currentCache())!
    expect([...bucket.values()].map((hit) => hit.body)).toEqual(['new-svg'])
  })
  it('图标断网时退回缓存(离线打开仍然有图)', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValueOnce(new worker.FakeResponse('png', { headers: { 'content-type': 'image/png' } }))
    await worker.dispatchFetch('/icons/icon-192.png')
    worker.network.mockRejectedValueOnce(new TypeError('offline'))
    expect((await worker.dispatchFetch('/icons/icon-192.png'))?.body).toBe('png')
  })
  it('API / WebSocket / MCP / 预览原件:不接管(respondWith 不被调用),也不会进缓存', async () => {
    const worker = loadWorker()
    for (const path of ['/api/v1/me/prefs', '/api/v1/items/1/preview', '/ws', '/mcp', '/some/page']) {
      expect(await worker.dispatchFetch(path)).toBeUndefined()
    }
    expect(worker.network).not.toHaveBeenCalled()
    expect(worker.store.size).toBe(0)
  })
  it('非 GET、跨域请求:不接管', async () => {
    const worker = loadWorker()
    expect(await worker.dispatchFetch('/assets/app.js', { method: 'POST' })).toBeUndefined()
    expect(await worker.dispatchFetch('/assets/app.js', { origin: 'https://cdn.example.com' })).toBeUndefined()
  })
  it('后端对不存在的静态路径会回 index.html(text/html):不能把它当资源缓存', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValue(new worker.FakeResponse('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    const response = await worker.dispatchFetch('/assets/missing.js')
    expect(response?.body).toBe('<!doctype html>')
    expect([...(worker.store.get(await worker.currentCache()) ?? new Map()).keys()]).toEqual([])
  })
  it('失败的响应(404/500)不缓存', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValue(new worker.FakeResponse('x', { status: 500, headers: { 'content-type': 'text/javascript' } }))
    await worker.dispatchFetch('/assets/app.js')
    expect((worker.store.get(await worker.currentCache()) ?? new Map()).size).toBe(0)
  })
  it('页面导航:正常走网络;网络失败时给 503 的离线说明页,而不是缓存旧页面', async () => {
    const worker = loadWorker()
    worker.network.mockResolvedValueOnce(new worker.FakeResponse('<html>live</html>', { headers: { 'content-type': 'text/html' } }))
    expect((await worker.dispatchFetch('/home', { mode: 'navigate' }))?.body).toBe('<html>live</html>')
    worker.network.mockRejectedValueOnce(new TypeError('offline'))
    const offline = await worker.dispatchFetch('/home', { mode: 'navigate' })
    expect(offline?.status).toBe(503)
    expect(offline?.body).toContain('连不上服务器')
    expect(worker.store.size).toBe(0)
  })
  it('缓存条数有上限:超出后最早的被淘汰', async () => {
    const worker = loadWorker()
    worker.network.mockImplementation(async () => new worker.FakeResponse('x', { headers: { 'content-type': 'text/javascript' } }))
    for (let index = 0; index < 125; index += 1) await worker.dispatchFetch(`/assets/chunk-${index}.js`)
    const currentCache = worker.store.keys().next().value
    const bucket = worker.store.get(currentCache ?? "")!
    expect(bucket.size).toBe(120)
    expect(bucket.has('https://kb.test/assets/chunk-0.js')).toBe(false)
    expect(bucket.has('https://kb.test/assets/chunk-124.js')).toBe(true)
  })
  it('升级:activate 删掉旧版本的缓存,但不动别人的缓存', async () => {
    const worker = loadWorker()
    worker.store.set('kb-static-v0', new Map())
    worker.store.set('other-app', new Map())
    let done: Promise<unknown> = Promise.resolve()
    worker.handlers.activate({ waitUntil: (value: Promise<unknown>) => (done = value) })
    await done
    expect([...worker.store.keys()].sort()).toEqual(['other-app'])
    expect(worker.self.clients.claim).toHaveBeenCalled()
  })
  it('install 不预缓存任何东西,并立即启用新版本', () => {
    const worker = loadWorker()
    worker.handlers.install({})
    expect(worker.self.skipWaiting).toHaveBeenCalled()
    expect(worker.store.size).toBe(0)
  })
  it('源码里没有任何 /api 缓存逻辑(防止以后有人顺手加上)', () => {
    const code = read('sw.js').split('\n').filter((line: string) => !line.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/\/api|\/ws|\/mcp/)
  })
})

describe('registerServiceWorker', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('开发环境(enabled=false)不注册', async () => {
    const register = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { register } })
    expect(await registerServiceWorker({ enabled: false })).toBeNull()
    expect(register).not.toHaveBeenCalled()
  })
  it('不支持 service worker 的环境安静跳过', async () => {
    vi.stubGlobal('navigator', {})
    expect(await registerServiceWorker({ enabled: true })).toBeNull()
  })
  it('生产环境:页面加载完后以根作用域注册 /sw.js', async () => {
    const registration = { scope: '/' }
    const register = vi.fn().mockResolvedValue(registration)
    vi.stubGlobal('navigator', { serviceWorker: { register } })
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    expect(await registerServiceWorker({ enabled: true })).toBe(registration)
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })
  it('注册失败不抛错(PWA 只是增强)', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockRejectedValue(new Error('SecurityError')) } })
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    expect(await registerServiceWorker({ enabled: true })).toBeNull()
  })
})
