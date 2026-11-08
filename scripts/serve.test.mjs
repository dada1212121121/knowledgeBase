import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { createServer } from './serve.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

test('malformed percent-encoding returns 400 and the server keeps answering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`)
    assert.equal(bad.status, 400)
    const home = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(home.status, 200)
    assert.equal(await home.text(), 'home')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the guide pdf is served as application/pdf and /guide (a page and a directory) falls back to index.html', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  fs.mkdirSync(path.join(root, 'guide'))
  fs.writeFileSync(path.join(root, 'guide', 'g.pdf'), '%PDF-1.4')
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const pdf = await fetch(`http://127.0.0.1:${port}/guide/g.pdf`)
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    // /guide 在磁盘上是目录:回退成页面,而不是读目录出错
    const page = await fetch(`http://127.0.0.1:${port}/guide`)
    assert.equal(page.status, 200)
    assert.equal(await page.text(), 'home')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the PWA manifest is served as application/manifest+json so the browser parses it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  fs.writeFileSync(path.join(root, 'manifest.webmanifest'), '{}')
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/manifest+json')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the site CSP allows compiling WebAssembly but not JS eval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>')
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`)
    const csp = response.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/)
    assert.doesNotMatch(csp, /unsafe-eval(?!')/, '不能放开 JS 的 eval')
    assert.doesNotMatch(csp, /'unsafe-eval'/)
    assert.match(csp, /object-src 'none'/)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an upstream sandbox CSP is not replaced by the site policy', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-security-policy': 'sandbox',
    })
    res.end('raw')
  })
  const upPort = await listen(upstream)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  const server = createServer({ root, upPort })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/raw?x=1`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-security-policy'), 'sandbox')
    assert.equal(await response.text(), 'raw')
  } finally {
    server.close()
    upstream.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-hashed files carry ETag and Last-Modified, and a matching conditional request gets 304 with no body', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  fs.mkdirSync(path.join(root, 'pdfjs'))
  fs.writeFileSync(path.join(root, 'pdfjs', 'a.mjs'), 'x'.repeat(5000))
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/pdfjs/a.mjs`
  try {
    const first = await fetch(url)
    assert.equal(first.status, 200)
    assert.equal((await first.text()).length, 5000)
    const etag = first.headers.get('etag')
    const modified = first.headers.get('last-modified')
    assert.ok(etag, '应带 ETag')
    assert.ok(modified, '应带 Last-Modified')
    // 仍然要求每次向服务器确认(文件名不带哈希,不能当永久缓存)
    assert.equal(first.headers.get('cache-control'), 'no-cache')

    const byEtag = await fetch(url, { headers: { 'if-none-match': etag } })
    assert.equal(byEtag.status, 304)
    assert.equal(await byEtag.text(), '')
    assert.equal(byEtag.headers.get('etag'), etag)

    const byDate = await fetch(url, { headers: { 'if-modified-since': modified } })
    assert.equal(byDate.status, 304)

    // ETag 不匹配时照常返回内容
    const stale = await fetch(url, { headers: { 'if-none-match': '"nope"' } })
    assert.equal(stale.status, 200)
    assert.equal((await stale.text()).length, 5000)

    // 文件变了:旧 ETag 不再命中,拿到新内容和新 ETag
    await new Promise((resolve) => setTimeout(resolve, 20))
    fs.writeFileSync(path.join(root, 'pdfjs', 'a.mjs'), 'y'.repeat(7000))
    const changed = await fetch(url, { headers: { 'if-none-match': etag } })
    assert.equal(changed.status, 200)
    assert.equal((await changed.text()).length, 7000)
    assert.notEqual(changed.headers.get('etag'), etag)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('hashed /assets files stay immutable and the SPA fallback page also revalidates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log(1)')
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const asset = await fetch(`http://127.0.0.1:${port}/assets/index-abc123.js`)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    // 前端路由地址落到 index.html:同样要能 304,否则每次打开都整页重新下载
    const page = await fetch(`http://127.0.0.1:${port}/some/route`)
    assert.equal(page.status, 200)
    const etag = page.headers.get('etag')
    assert.ok(etag)
    const again = await fetch(`http://127.0.0.1:${port}/some/route`, { headers: { 'if-none-match': etag } })
    assert.equal(again.status, 304)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---- L1:压缩(静态文件 + 上游的 JSON 响应) ----

/** 用 node:http 发请求,不自动解压:要看服务器到底发了什么字节。 */
function rawGet(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

function webRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbase-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'home')
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), content)
  }
  return root
}

const BIG = 'KnowledgeBase 静态资源,重复内容压缩得很好。'.repeat(500)

test('static text and wasm are compressed: brotli preferred, gzip as fallback, identity when not accepted', async () => {
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.alloc(20000, 7)])
  const root = webRoot({ 'assets/app-abc.js': BIG, 'x/engine.wasm': wasm })
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const br = await rawGet(port, '/assets/app-abc.js', { 'accept-encoding': 'gzip, deflate, br' })
    assert.equal(br.status, 200)
    assert.equal(br.headers['content-encoding'], 'br')
    assert.equal(br.headers.vary?.toLowerCase(), 'accept-encoding')
    assert.equal(br.headers['content-length'], String(br.body.length))
    assert.ok(br.body.length < BIG.length / 10, `压缩后应远小于原文,实际 ${br.body.length}`)
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), BIG)
    // 带哈希的资源仍然是永久缓存
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable')

    const gz = await rawGet(port, '/assets/app-abc.js', { 'accept-encoding': 'gzip' })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal(zlib.gunzipSync(gz.body).toString(), BIG)

    const plain = await rawGet(port, '/assets/app-abc.js', {})
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString(), BIG)
    assert.equal(plain.headers.vary?.toLowerCase(), 'accept-encoding', '不压缩时也要带 Vary,免得缓存把压缩版发给不认的人')

    const refused = await rawGet(port, '/assets/app-abc.js', { 'accept-encoding': 'br;q=0, gzip;q=0' })
    assert.equal(refused.headers['content-encoding'], undefined, 'q=0 表示不接受')

    const wasmBr = await rawGet(port, '/x/engine.wasm', { 'accept-encoding': 'br' })
    assert.equal(wasmBr.headers['content-encoding'], 'br')
    assert.equal(wasmBr.headers['content-type'], 'application/wasm')
    assert.ok(zlib.brotliDecompressSync(wasmBr.body).equals(wasm))
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('TTF / OTF fonts are compressed (they are not compressed formats), woff2 is not', async () => {
  // 办公文档编辑器随应用带的中文字体是 TTF(2 MB 多),不压缩每个用户第一次打开都多下一半
  const glyphs = Buffer.from('字形数据'.repeat(5000))
  const root = webRoot({ 'assets/cjk.ttf': glyphs, 'assets/cjk.otf': glyphs, 'assets/cjk.woff2': glyphs })
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    for (const name of ['/assets/cjk.ttf', '/assets/cjk.otf']) {
      const response = await rawGet(port, name, { 'accept-encoding': 'br' })
      assert.equal(response.headers['content-encoding'], 'br', name)
      assert.ok(zlib.brotliDecompressSync(response.body).equals(glyphs), `${name} 解压后与原文件一致`)
      assert.ok(response.body.length < glyphs.length / 2, `${name} 确实变小了`)
    }
    const woff2 = await rawGet(port, '/assets/cjk.woff2', { 'accept-encoding': 'br' })
    assert.equal(woff2.headers['content-encoding'], undefined, 'woff2 自带压缩')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('already compressed, tiny and ranged static responses are left alone', async () => {
  const png = Buffer.alloc(20000, 1)
  const root = webRoot({
    'a.png': png,
    'f.woff2': png,
    'g/guide.pdf': png,
    'tiny.js': 'x'.repeat(100),
    'assets/big.js': BIG,
  })
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  const accept = { 'accept-encoding': 'gzip, br' }
  try {
    for (const name of ['/a.png', '/f.woff2', '/g/guide.pdf', '/tiny.js']) {
      const response = await rawGet(port, name, accept)
      assert.equal(response.status, 200, name)
      assert.equal(response.headers['content-encoding'], undefined, `${name} 不该压缩`)
    }
    // 带 Range 的请求要的是原始字节范围,不能回压缩后的整份
    const ranged = await rawGet(port, '/assets/big.js', { ...accept, range: 'bytes=0-99' })
    assert.equal(ranged.headers['content-encoding'], undefined)
    // HEAD 没有正文,不为它压缩
    const head = await rawGet(port, '/assets/big.js', accept, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-encoding'], undefined, 'HEAD 不为不存在的正文压缩')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('each variant has its own ETag, a matching conditional request gets 304, and a file is compressed once', async () => {
  const root = webRoot({ 'pdfjs/a.mjs': BIG })
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const first = await rawGet(port, '/pdfjs/a.mjs', { 'accept-encoding': 'br' })
    const gz = await rawGet(port, '/pdfjs/a.mjs', { 'accept-encoding': 'gzip' })
    const plain = await rawGet(port, '/pdfjs/a.mjs', {})
    const tags = new Set([first.headers.etag, gz.headers.etag, plain.headers.etag])
    assert.equal(tags.size, 3, '压缩版和原文不是同一个表示,ETag 要分开')

    const again = await rawGet(port, '/pdfjs/a.mjs', {
      'accept-encoding': 'br',
      'if-none-match': first.headers.etag,
    })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)
    // 拿 br 版的 ETag 去问不压缩的版本:不命中
    const cross = await rawGet(port, '/pdfjs/a.mjs', { 'if-none-match': first.headers.etag })
    assert.equal(cross.status, 200)

    // 多个请求并发、反复请求同一个文件,只压缩一次
    await Promise.all(
      Array.from({ length: 5 }, () => rawGet(port, '/pdfjs/a.mjs', { 'accept-encoding': 'br' })),
    )
    assert.equal(server.compressions.br, 1)
    assert.equal(server.compressions.gzip, 1)

    // 文件变了:压缩结果跟着变,不会发旧的
    await new Promise((resolve) => setTimeout(resolve, 20))
    fs.writeFileSync(path.join(root, 'pdfjs', 'a.mjs'), 'changed. '.repeat(400))
    const changed = await rawGet(port, '/pdfjs/a.mjs', { 'accept-encoding': 'br' })
    assert.equal(zlib.brotliDecompressSync(changed.body).toString(), 'changed. '.repeat(400))
    assert.equal(server.compressions.br, 2)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('JSON from kbd is compressed on the fly; streams, ranges, other types and encoded responses are not', async () => {
  const json = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}` })) })
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/v1/list') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
      res.end(json)
    } else if (req.url === '/api/v1/small') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } else if (req.url === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + 'x'.repeat(3000) + '\n\n')
      res.end()
    } else if (req.url === '/api/v1/raw') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(BIG)
    } else if (req.url === '/api/v1/encoded') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'identity' })
      res.end(json)
    } else if (req.url === '/api/v1/transform') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-transform' })
      res.end(json)
    } else if (req.url === '/api/v1/missing') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(json)
    }
  })
  const upPort = await listen(upstream)
  const root = webRoot({})
  const server = createServer({ root, upPort })
  const port = await listen(server)
  const accept = { 'accept-encoding': 'gzip, br' }
  try {
    const list = await rawGet(port, '/api/v1/list', accept)
    assert.equal(list.status, 200)
    assert.equal(list.headers['content-encoding'], 'br')
    assert.equal(list.headers['content-length'], undefined, '压缩后长度变了,不能沿用上游的 content-length')
    assert.equal(list.headers.vary?.toLowerCase(), 'accept-encoding')
    assert.equal(zlib.brotliDecompressSync(list.body).toString(), json)
    assert.ok(list.body.length < json.length / 3)

    const gz = await rawGet(port, '/api/v1/list', { 'accept-encoding': 'gzip' })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal(zlib.gunzipSync(gz.body).toString(), json)

    const plain = await rawGet(port, '/api/v1/list', {})
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString(), json)
    assert.equal(plain.headers['content-length'], String(Buffer.byteLength(json)))

    for (const [name, headers] of [
      ['/api/v1/events', accept],
      ['/api/v1/raw', accept],
      ['/api/v1/encoded', accept],
      ['/api/v1/transform', accept],
      ['/api/v1/missing', accept],
      ['/api/v1/list', { ...accept, range: 'bytes=0-9' }],
    ]) {
      const response = await rawGet(port, name, headers)
      assert.ok(
        [undefined, 'identity'].includes(response.headers['content-encoding']),
        `${name} 不该被压缩,实际 ${response.headers['content-encoding']}`,
      )
    }
    const small = await rawGet(port, '/api/v1/small', accept)
    assert.equal(small.body.toString(), '{"ok":true}')
    assert.equal(small.headers['content-encoding'], undefined, '太小不值得压缩')
  } finally {
    server.close()
    upstream.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('WebSocket upgrades are proxied with Nagle off on both sockets (small collaboration frames are not held back)', async () => {
  const seen = []
  const original = net.Socket.prototype.setNoDelay
  net.Socket.prototype.setNoDelay = function (value) {
    seen.push(value)
    return original.call(this, value)
  }
  const upstream = http.createServer()
  const sockets = []
  upstream.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  const upPort = await listen(upstream)
  const server = createServer({ upPort, upHost: '127.0.0.1' })
  const port = await listen(server)
  try {
    const echoed = await new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write('GET /api/v1/collab/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
      let buffer = ''
      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('101') && !buffer.includes('ping')) client.write('ping')
        if (buffer.includes('ping')) {
          client.destroy()
          resolve(buffer)
        }
      })
      client.on('error', reject)
    })
    assert.match(echoed, /101 Switching Protocols/)
    // 浏览器那一头(服务端 socket)和连守护进程的那一头都设了 noDelay
    assert.ok(seen.filter((value) => value === true).length >= 2, `setNoDelay 调用:${JSON.stringify(seen)}`)
  } finally {
    net.Socket.prototype.setNoDelay = original
    for (const socket of sockets) socket.destroy()
    server.close()
    upstream.close()
  }
})

test('build-time precompressed siblings (.br / .gz) are served as-is and never recompressed at runtime', async () => {
  // 预压缩文件故意写成「能解开、但和运行时压出来的不一样」的内容,才能区分发出去的是哪一份
  const precompressedBr = zlib.brotliCompressSync(Buffer.from(BIG), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
  const precompressedGz = zlib.gzipSync(Buffer.from(BIG), { level: 9 })
  const root = webRoot({ 'assets/app-pre.js': BIG })
  // 预压缩文件要比原文件新(构建时先写原文件、后写 .br / .gz)
  fs.writeFileSync(path.join(root, 'assets/app-pre.js.br'), precompressedBr)
  fs.writeFileSync(path.join(root, 'assets/app-pre.js.gz'), precompressedGz)
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const br = await rawGet(port, '/assets/app-pre.js', { 'accept-encoding': 'gzip, br' })
    assert.equal(br.headers['content-encoding'], 'br')
    assert.ok(br.body.equals(precompressedBr), '发的是预压缩文件本身')
    assert.equal(br.headers['content-length'], String(precompressedBr.length))
    assert.equal(br.headers['content-type'], 'text/javascript')
    assert.equal(br.headers.vary?.toLowerCase(), 'accept-encoding')
    const gz = await rawGet(port, '/assets/app-pre.js', { 'accept-encoding': 'gzip' })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.ok(gz.body.equals(precompressedGz))
    const plain = await rawGet(port, '/assets/app-pre.js', {})
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString(), BIG)
    // 带 Range 要原始字节范围,预压缩文件也不能用
    const ranged = await rawGet(port, '/assets/app-pre.js', { 'accept-encoding': 'br', range: 'bytes=0-9' })
    assert.equal(ranged.headers['content-encoding'], undefined)
    assert.deepEqual(server.compressions, { br: 0, gzip: 0 }, '有预压缩文件时一次运行时压缩都不做')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('only a .gz sibling: a br-preferring client gets the gzip file instead of a runtime brotli pass', async () => {
  const root = webRoot({ 'assets/font-x.ttf': BIG })
  const precompressedGz = zlib.gzipSync(Buffer.from(BIG), { level: 9 })
  fs.writeFileSync(path.join(root, 'assets/font-x.ttf.gz'), precompressedGz)
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const response = await rawGet(port, '/assets/font-x.ttf', { 'accept-encoding': 'br, gzip' })
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.equal(response.headers['content-type'], 'font/ttf')
    assert.ok(response.body.equals(precompressedGz))
    assert.deepEqual(server.compressions, { br: 0, gzip: 0 })
    // q 值更高的优先:明确更想要 gzip 时即使有 br 文件也发 gzip
    fs.writeFileSync(path.join(root, 'assets/font-x.ttf.br'), zlib.brotliCompressSync(Buffer.from(BIG)))
    const preferGzip = await rawGet(port, '/assets/font-x.ttf', { 'accept-encoding': 'br;q=0.5, gzip;q=1' })
    assert.equal(preferGzip.headers['content-encoding'], 'gzip')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a precompressed file older than the original is ignored (stale .br must not shadow a replaced file)', async () => {
  const root = webRoot({ 'assets/app-old.js': BIG })
  const stale = path.join(root, 'assets/app-old.js.br')
  fs.writeFileSync(stale, zlib.brotliCompressSync(Buffer.from('旧内容'.repeat(400))))
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(stale, past, past)
  const server = createServer({ root, upPort: 1 })
  const port = await listen(server)
  try {
    const response = await rawGet(port, '/assets/app-old.js', { 'accept-encoding': 'br' })
    assert.equal(response.headers['content-encoding'], 'br')
    assert.equal(zlib.brotliDecompressSync(response.body).toString(), BIG, '旧的预压缩文件被跳过,改为运行时压缩当前原文')
    assert.equal(server.compressions.br, 1)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime compression can be switched off: files without a sibling go out as identity', async () => {
  const root = webRoot({ 'assets/app-raw.js': BIG })
  const server = createServer({ root, upPort: 1, runtimeCompress: false })
  const port = await listen(server)
  try {
    const response = await rawGet(port, '/assets/app-raw.js', { 'accept-encoding': 'br, gzip' })
    assert.equal(response.headers['content-encoding'], undefined)
    assert.equal(response.body.toString(), BIG)
    assert.equal(response.headers.vary?.toLowerCase(), 'accept-encoding')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
