// 生产静态页:提供 web dist,把 /api 与 /mcp(含 websocket)反代到 kbd。
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const PORT = +process.env.KBASE_PORT || 18600
const UP_HOST = '127.0.0.1'
const UP_PORT = +process.env.KBD_PORT || 17878
const ROOT = process.env.KBASE_WEB || '/opt/kb/web'
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // 办公文档编辑器随应用带的字体(Carlito、中文裁剪版等):没有这两项会按 octet-stream 发出
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  // PWA 的 manifest:没有这一项会按 octet-stream 发出,部分浏览器会拒绝当成 manifest 解析
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  // 使用指南的 PDF 下载:没有这一项会按 octet-stream 发出,浏览器内嵌查看器打不开
  '.pdf': 'application/pdf',
}
// script-src 里的 'wasm-unsafe-eval' 只允许编译 WebAssembly,不放开 JS 的 eval:办公文档的在线编辑引擎(xlsx / docx / pptx)
// 是 Rust 编成的 WASM,没有它浏览器会拒绝加载。其余指令保持原样。
const SECURITY = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
}
const isApi = (u) => u.startsWith('/api/') || u === '/api' || u.startsWith('/mcp')

// ---- 压缩 ----
// 公网流量由 Cloudflare 在边缘压缩(只有 gzip),但内网直连是原样发:前端入口 JS 未压缩约 500 KB,
// 之后文档引擎的 WebAssembly 单个就有几十 MB(docx 四个模块合计 35.6 MB)。压缩放在这一层而不是守护进程里:
// kbd 只监听本机,所有流量都经过这里,压缩一次、缓存起来,守护进程不多花 CPU。
//
// 只压缩文本类、wasm 和 TTF / OTF 字体(这两种字体文件没有压缩,办公文档编辑器随应用带的中文字体有 2 MB 多)。
// 图片、woff2 字体、PDF 本身已经是压缩格式,再压只会白费 CPU;
// 带 Range 的请求要的是原始字节范围;HEAD 没有正文;事件流(SSE)压缩会让数据攒着不发;
// 下载原件不动,保留浏览器的下载进度。
export const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.ttf', '.otf', '.map', '.txt', '.ico'])
/** 小于这个长度的不值得压缩(压缩头部本身就要占几十个字节)。 */
const MIN_COMPRESS_BYTES = 1024
/** 内存里最多缓存多少压缩结果(超出按先进先出淘汰)。 */
const COMPRESS_CACHE_BYTES = 128 * 1024 * 1024
const BROTLI_QUALITY = 6

/**
 * 按 `Accept-Encoding` 选 br 或 gzip;都不接受(没带头、`q=0`、只要 identity)返回 null。
 * q 值高的优先,一样高时 br 优先(同样内容更小)。
 */
export function pickEncoding(header) {
  return acceptedEncodings(header)[0] ?? null
}

/**
 * 客户端接受的压缩方式(只认 br / gzip),按偏好排好:q 值高的在前,一样高时 br 在前;都不接受返回空数组。
 * 预压缩文件可能只有其中一种(压不小的那种不生成),所以要拿到整个列表,依次找第一个存在的。
 */
export function acceptedEncodings(header) {
  if (!header) return []
  const accepted = new Map()
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let q = 1
    for (const param of params) {
      const [key, value] = param.trim().split('=')
      if (key === 'q') q = Number.parseFloat(value)
    }
    accepted.set(name, Number.isFinite(q) ? q : 0)
  }
  const qOf = (encoding) => (accepted.has(encoding) ? accepted.get(encoding) : (accepted.get('*') ?? 0))
  const br = qOf('br')
  const gzip = qOf('gzip')
  const ranked = [
    { name: 'br', q: br },
    { name: 'gzip', q: gzip },
  ].filter((item) => item.q > 0)
  // sort 是稳定的:q 一样时保持 br 在前
  ranked.sort((a, b) => b.q - a.q)
  return ranked.map((item) => item.name)
}

/** 预压缩文件的后缀(web-ui/scripts/precompress.mjs 生成) */
const PRECOMPRESSED_SUFFIX = { br: '.br', gzip: '.gz' }

/** 响应头里这个内容类型值不值得压缩(只认 JSON:API 里其它类型多半是下载的原件或流)。 */
function isCompressibleApiType(contentType) {
  return /^application\/json\b/i.test(String(contentType || ''))
}

/** 把 `Vary: Accept-Encoding` 并进已有的 Vary。 */
function withVary(existing) {
  const values = String(existing || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.includes('*') || values.some((value) => value.toLowerCase() === 'accept-encoding')) return values.join(', ')
  return [...values, 'Accept-Encoding'].join(', ')
}

function compressBuffer(buffer, encoding) {
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out))
    if (encoding === 'br') {
      zlib.brotliCompress(
        buffer,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } },
        done,
      )
    } else {
      zlib.gzip(buffer, { level: 6 }, done)
    }
  })
}

/** 静态文件压缩结果的缓存:同一个文件(路径 + 大小 + 修改时间)同一种编码只压缩一次,并发请求共用同一个任务。 */
function createCompressionCache() {
  const entries = new Map()
  let total = 0
  const compressions = { br: 0, gzip: 0 }
  function trim() {
    for (const [key, entry] of entries) {
      if (total <= COMPRESS_CACHE_BYTES) break
      if (!entry.size) continue
      entries.delete(key)
      total -= entry.size
    }
  }
  function get(file, stat, encoding) {
    const key = `${encoding}\0${file}\0${stat.size}\0${stat.mtimeMs}`
    let entry = entries.get(key)
    if (!entry) {
      entry = { size: 0 }
      entry.promise = fs.promises
        .readFile(file)
        .then((buffer) => compressBuffer(buffer, encoding))
        .then((out) => {
          compressions[encoding] += 1
          entry.size = out.length
          total += out.length
          trim()
          return out
        })
      // 失败不缓存,下次请求重来
      entry.promise.catch(() => entries.delete(key))
      entries.set(key, entry)
    }
    return entry.promise
  }
  return { get, compressions }
}

function decodePath(url) {
  const raw = String(url || '/').split('?')[0]
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function fail(res, status, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY })
  res.end(body)
}

function handle(req, res, opts) {
  const url = req.url || '/'
  if (isApi(url)) {
    const p = http.request(
      {
        host: opts.upHost,
        port: opts.upPort,
        method: req.method,
        path: url,
        headers: req.headers,
      },
      (upstream) => {
        try {
          // 上游已有的头优先,这样 /api/v1/raw 的 CSP: sandbox 不会被站点策略盖掉。
          const headers = { ...SECURITY, ...upstream.headers }
          relay(req, res, upstream, headers)
        } catch (err) {
          console.error(err)
          fail(res, 500, 'internal error')
        }
      },
    )
    p.on('error', () => fail(res, 502, 'kbd unavailable'))
    req.pipe(p)
    return
  }
  const decoded = decodePath(url)
  if (decoded == null) {
    fail(res, 400, 'bad request')
    return
  }
  let f = path.join(opts.root, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''))
  let stat = f.startsWith(opts.root) ? statFile(f) : null
  if (!stat) {
    f = path.join(opts.root, 'index.html')
    stat = statFile(f)
  }
  if (!stat) {
    fail(res, 404, 'not found')
    return
  }
  const ext = path.extname(f)
  // 文本类和 wasm 值得压缩;HEAD 没有正文、带 Range 要的是原始字节范围,都不压缩
  const eligible = COMPRESSIBLE_EXT.has(ext) && stat.size >= MIN_COMPRESS_BYTES
  const accepted =
    eligible && req.method !== 'HEAD' && !req.headers.range ? acceptedEncodings(req.headers['accept-encoding']) : []
  // 构建期预压缩(npm run build 的 postbuild,brotli 11 / gzip 9)的同名文件优先:比运行时 brotli 6 再小 15~20%,
  // 冷缓存时也不用当场压一遍几十 MB 的 wasm。只信比原文件新的预压缩文件:原文件后来被替换过,旧的 .br 不能拿来冒充
  const pre = accepted
    .map((name) => ({ name, file: f + PRECOMPRESSED_SUFFIX[name] }))
    .map((item) => ({ ...item, stat: statFile(item.file) }))
    .find((item) => item.stat && item.stat.mtimeMs >= stat.mtimeMs)
  // 没有预压缩文件(没跑 postbuild、或压不小没生成)才在运行时压;KBASE_RUNTIME_COMPRESS=0 关掉这条回退
  const encoding = pre ? pre.name : opts.runtimeCompress ? (accepted[0] ?? null) : null
  // 文件名不带哈希的静态文件(index.html、pdfjs/、guide/)每次都要向服务器确认,
  // 但没变时只回 304,不再整包重新下载(pdfjs 约 2.5 MB、使用指南约 4.6 MB)。
  // 压缩版和原文不是同一个表示,ETag 分开,免得拿 br 版的 ETag 去换到原文的 304。
  const variant = (encoding) =>
    `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ''}"`
  const headersFor = (encoding) => ({
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': f.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    etag: variant(encoding),
    'last-modified': stat.mtime.toUTCString(),
    // 不压缩的响应也要带:同一个地址对不同的客户端有两种表示,中间的缓存要分开存
    ...(eligible ? { vary: 'Accept-Encoding' } : {}),
    ...SECURITY,
  })
  if (notModified(req, variant(encoding), stat.mtimeMs)) {
    res.writeHead(304, headersFor(encoding))
    res.end()
    return
  }
  const sendPlain = () => {
    res.writeHead(200, { ...headersFor(null), 'content-length': stat.size })
    const stream = fs.createReadStream(f)
    // 文件在检查之后被删 / 读失败:头已经发出,只能断开连接,不能让未处理的错误带走进程
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
  if (!encoding) {
    sendPlain()
    return
  }
  if (pre) {
    res.writeHead(200, { ...headersFor(encoding), 'content-encoding': encoding, 'content-length': pre.stat.size })
    const stream = fs.createReadStream(pre.file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
  opts.compression.get(f, stat, encoding).then(
    (body) => {
      res.writeHead(200, { ...headersFor(encoding), 'content-encoding': encoding, 'content-length': body.length })
      res.end(body)
    },
    // 压缩失败(文件读不了等)就退回原样发,不让一个请求失败
    () => sendPlain(),
  )
}

/**
 * 把上游(kbd)的响应转给浏览器。JSON 且够大、客户端接受时就地压缩;其余原样转发。
 * 不动的:事件流、非 JSON(下载的原件)、已经有 Content-Encoding 的、`no-transform`、带 Range 的请求、
 * 非 200(错误页很小,也不值得)、HEAD。
 */
function relay(req, res, upstream, headers) {
  const status = upstream.statusCode || 502
  const declared = Number(upstream.headers['content-length'])
  const eligible =
    status === 200 &&
    req.method !== 'HEAD' &&
    !req.headers.range &&
    isCompressibleApiType(upstream.headers['content-type']) &&
    !upstream.headers['content-encoding'] &&
    !/\bno-transform\b/i.test(String(upstream.headers['cache-control'] || '')) &&
    !(Number.isFinite(declared) && declared < MIN_COMPRESS_BYTES)
  if (!eligible) {
    res.writeHead(status, headers)
    upstream.pipe(res)
    return
  }
  headers.vary = withVary(headers.vary)
  const encoding = pickEncoding(req.headers['accept-encoding'])
  if (!encoding) {
    res.writeHead(status, headers)
    upstream.pipe(res)
    return
  }
  // 长度可能没声明(分块传输):先攒够 MIN_COMPRESS_BYTES 再决定压不压,不到就原样发
  const held = []
  let heldBytes = 0
  let compressor = null
  const start = () => {
    delete headers['content-length']
    delete headers['transfer-encoding']
    headers['content-encoding'] = encoding
    res.writeHead(status, headers)
    compressor =
      encoding === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : zlib.createGzip({ level: 5 })
    compressor.on('error', () => res.destroy())
    compressor.pipe(res)
    for (const chunk of held) compressor.write(chunk)
    held.length = 0
  }
  upstream.on('data', (chunk) => {
    if (compressor) {
      if (!compressor.write(chunk)) {
        upstream.pause()
        compressor.once('drain', () => upstream.resume())
      }
      return
    }
    held.push(chunk)
    heldBytes += chunk.length
    if (heldBytes >= MIN_COMPRESS_BYTES) start()
  })
  upstream.on('end', () => {
    if (compressor) {
      compressor.end()
      return
    }
    delete headers['transfer-encoding']
    res.writeHead(status, { ...headers, 'content-length': heldBytes })
    res.end(Buffer.concat(held))
  })
  upstream.on('error', () => res.destroy())
  // 浏览器提前断开:别让上游和压缩器一直挂着
  res.on('close', () => {
    upstream.destroy()
    compressor?.destroy()
  })
}

/** 普通文件的 stat;不存在、是目录、读不了都返回 null。 */
function statFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/** 条件请求是否命中:`If-None-Match` 优先(RFC 9110),没有才看 `If-Modified-Since`。 */
function notModified(req, etag, mtimeMs) {
  const none = req.headers['if-none-match']
  if (none) {
    return none
      .split(',')
      .map((value) => value.trim())
      .some((value) => value === '*' || value === etag || value.replace(/^W\//, '') === etag.replace(/^W\//, ''))
  }
  const since = Date.parse(req.headers['if-modified-since'] || '')
  // HTTP 日期只精确到秒
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since
}

export function createServer(options = {}) {
  const compression = createCompressionCache()
  const opts = {
    upHost: options.upHost || UP_HOST,
    upPort: options.upPort ?? UP_PORT,
    root: options.root || ROOT,
    compression,
    // 运行时压缩只是没有预压缩文件时的回退;部署脚本总会先 npm run build(含预压缩),这条路平时走不到
    runtimeCompress: options.runtimeCompress ?? process.env.KBASE_RUNTIME_COMPRESS !== '0',
  }
  const server = http.createServer((req, res) => {
    try {
      handle(req, res, opts)
    } catch (err) {
      console.error(err)
      fail(res, 500, 'internal error')
    }
  })
  // 压缩了几次(测试用:同一个文件同一种编码应该只压缩一次)
  server.compressions = compression.compressions
  server.on('upgrade', (req, sock, head) => {
    if (!isApi(req.url || '')) {
      sock.destroy()
      return
    }
    // 关掉 Nagle(两头都关):协同编辑的 WebSocket 一秒几十上百个小帧,Nagle 遇上对端的延迟确认会让一个帧等 40 毫秒
    sock.setNoDelay(true)
    const up = net.connect(opts.upPort, opts.upHost, () => {
      let s = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        s += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      }
      up.write(s + '\r\n')
      if (head && head.length) up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    up.setNoDelay(true)
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  return server
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  createServer().listen(PORT, '127.0.0.1', () => console.log('kbase web on', PORT))
}
