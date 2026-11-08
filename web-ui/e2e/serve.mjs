// 截图与冒烟用例共用的静态服务器:托管 dist/,并把 /api 反代到守护进程。
//
// 直接运行:node e2e/serve.mjs [端口]   (默认 0 = 随机端口,打印实际地址)
// 作为模块:import { startStaticServer } from './serve.mjs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
// 与生产静态服务器(仓库根 scripts/serve.mjs)共用 MIME 表、可压缩扩展名与 Accept-Encoding 协商,
// 测试里量到的 content-type / 传输量才和生产一致(以前这里没有 wasm 的 MIME,引擎只能退到非流式编译)
import { acceptedEncodings, COMPRESSIBLE_EXT, MIME as PROD_MIME } from '../../scripts/serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// KB_DIST=/某个目录:托管这个目录里的构建产物(默认 web-ui/dist)。长时间的整套 e2e 可以对着一份拷贝跑,同时继续改代码、重新构建
const DIST = process.env.KB_DIST ? resolve(process.env.KB_DIST) : join(ROOT, 'dist')
const MIME = {
  ...PROD_MIME,
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
}

/** 起服务器;返回 { server, base }。 */
export async function startStaticServer(daemonUrl = process.env.KB_DAEMON_URL ?? 'http://127.0.0.1:7878') {
  const server = createServer((req, res) => {
    // 回调是 async 的,里面任何没接住的异常都会变成未处理的 Promise 拒绝而打死调用它的场景运行器;统一在这里兜住
    handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end()
      else res.destroy()
    })
  })
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      await proxy(req, res, daemonUrl)
      return
    }
    if (url.pathname === '/fontcss/inter.css') {
      await sendFile(res, join(ROOT, 'node_modules/@fontsource-variable/inter/index.css'))
      return
    }
    if (url.pathname === '/fontcss/noto.css') {
      await sendFile(res, join(ROOT, 'node_modules/@fontsource-variable/noto-sans-sc/index.css'))
      return
    }
    if (url.pathname.startsWith('/fontcss/files/')) {
      const name = url.pathname.slice('/fontcss/files/'.length)
      const inter = join(ROOT, 'node_modules/@fontsource-variable/inter/files', name)
      const noto = join(ROOT, 'node_modules/@fontsource-variable/noto-sans-sc/files', name)
      await sendFile(res, existsSync(inter) ? inter : noto)
      return
    }
    let path = join(DIST, url.pathname)
    // 目录也要回退到 index.html:/guide 是页面地址,同时 public/guide/ 又是存放下载文件的目录,不回退就会去读目录而 500
    if (!existsSync(path) || url.pathname === '/' || statSync(path).isDirectory()) path = join(DIST, 'index.html')
    try {
      // 构建期预压缩的 .br / .gz(web-ui/scripts/precompress.mjs)按 Accept-Encoding 选用;没有就发原文件。
      // 这里不做运行时压缩:基线要量的是构建产物本身,没跑预压缩时宁可量出原始字节、让问题暴露出来
      const ext = extname(path)
      const encodings = COMPRESSIBLE_EXT.has(ext) && !req.headers.range ? acceptedEncodings(req.headers['accept-encoding']) : []
      const pre = encodings
        .map((name) => ({ name, file: `${path}${name === 'br' ? '.br' : '.gz'}` }))
        .find((item) => existsSync(item.file) && statSync(item.file).mtimeMs >= statSync(path).mtimeMs)
      const body = await readFile(pre ? pre.file : path)
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        ...(COMPRESSIBLE_EXT.has(ext) ? { vary: 'Accept-Encoding' } : {}),
        ...(pre ? { 'content-encoding': pre.name } : {}),
        // 与守护进程(crates/kb-web/src/router.rs security_headers)一致:截图时就在真实 CSP 下跑,
        // worker / wasm / blob 之类的违规才会在这里暴露,而不是上线后。KB_CSP=0 可关闭。
        ...(process.env.KB_CSP === '0'
          ? {}
          : {
              'content-security-policy':
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
            }),
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}` }
}

async function sendFile(res, path) {
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

async function proxy(req, res, daemonUrl) {
  try {
    // 读请求体也要在 try 里:浏览器导航 / 关页面时会中途断开,Node 的请求流此时抛 `aborted`(ECONNRESET)。
    // 以前这一步在 try 外面,抛出就成了未处理的 Promise 拒绝,把整个场景运行器进程打死(机器忙、导航多时几乎必现)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const upstream = await fetch(`${daemonUrl}${req.url}`, {
      method: req.method,
      // 守护进程的 CSRF 校验比较 Origin 与 Host,而 fetch 会按目标 URL 重写 Host,
      // 所以这里把 Origin 也改成守护进程的地址(等价于反代把两边对齐)。
      headers: {
        ...req.headers,
        ...(req.headers.origin ? { origin: `http://${new URL(daemonUrl).host}` } : {}),
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'set-cookie': upstream.headers.get('set-cookie') ?? '',
    })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (err) {
    // 客户端已经走了(请求被中途中止)就没有人可回了,别再往已关闭的连接上写
    if (res.destroyed || res.writableEnded || req.aborted) return
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'unavailable', message: String(err) } }))
  }
}

// 直接运行时:监听指定端口并打印地址
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const port = Number(process.argv[2] ?? 0)
  const { base } = await startStaticServer()
  const actual = new URL(base).port
  console.log(`serving dist/ on http://127.0.0.1:${port || actual}(/api → ${process.env.KB_DAEMON_URL ?? 'http://127.0.0.1:7878'})`)
}
