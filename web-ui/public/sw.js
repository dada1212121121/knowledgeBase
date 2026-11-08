// 最小 service worker():只做两件事——
//   1. 缓存静态资源(assets/* 与图标),二次打开不再等网络;
//   2. 导航请求断网时给一页说明,而不是浏览器自带的「无法访问」。
// 它不缓存任何 API / WebSocket / 鉴权相关的响应,也不缓存页面本身(index.html):
// 管理端的数据必须是实时的,缓存一份旧页面比没有更糟(权限变了还显示旧菜单)。
// 同源脚本,符合 CSP 的 script-src 'self'。
//
// 升级:只需要改 CACHE 的版本号;activate 时删掉所有旧版本的缓存。
const CACHE = 'kb-static-v4'
// 文件名带内容哈希(assets/*):内容变了文件名就变,所以「缓存优先」是安全的。
const HASHED = /^\/assets\//
// 图标是固定文件名、内容会被直接替换(换 Logo 就是这类)。以前它和 /assets 一样走缓存优先,
// 结果老用户永远停在旧图标上——换图不发版也是同一个文件名,缓存命中就再也不回源。
// 现在改成网络优先:能连上就用新的并回写缓存,断网才退回缓存。
const FIXED = /^\/(icons\/|icon\.svg$|favicon\.ico$)/
// 限制条数,避免多次发版后越攒越多。
const MAX_ENTRIES = 120

self.addEventListener('install', () => {
  // 不预缓存:首次访问就拉全部资源会拖慢首屏;用到什么缓存什么。
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('kb-static-') && name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

async function trim(cache) {
  const keys = await cache.keys()
  // 最早放进去的先删(cache.keys 按插入顺序)
  for (const request of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(request)
}

const OFFLINE_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>离线</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:16px system-ui,sans-serif;background:#08080a;color:#e8e8ea"><main style="padding:24px;text-align:center"><h1 style="font-size:20px;margin:0 0 8px">连不上服务器</h1><p style="margin:0 0 16px;color:#9a9aa2">请检查网络,或确认知识库服务在运行。</p><button onclick="location.reload()" style="font:inherit;padding:10px 20px;border-radius:8px;border:0;background:#5e6ad2;color:#fff">重试</button></main></body></html>`

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 页面导航:正常走网络;断网时给离线说明
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        () => new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      ),
    )
    return
  }

  // 可缓存的形状:成功后回写(后端对不存在的路径会回 index.html,不能把它当成 js 缓存下来)
  const cacheable = (response) => {
    const type = response.headers.get('content-type') || ''
    return response.ok && !type.startsWith('text/html')
  }

  // 带哈希的资源:缓存优先
  if (HASHED.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const hit = await cache.match(request)
        if (hit) return hit
        const response = await fetch(request)
        if (cacheable(response)) {
          await cache.put(request, response.clone())
          await trim(cache)
        }
        return response
      })(),
    )
    return
  }

  // 固定文件名的图标:网络优先,断网才用缓存(换 Logo 后老用户下次打开就能看到新的)
  if (FIXED.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const response = await fetch(request)
          if (cacheable(response)) {
            await cache.put(request, response.clone())
            await trim(cache)
          }
          return response
        } catch (err) {
          const hit = await cache.match(request)
          if (hit) return hit
          throw err
        }
      })(),
    )
  }
  // 其余(api、/ws、/mcp、页面数据)不碰,交给浏览器正常处理
})
