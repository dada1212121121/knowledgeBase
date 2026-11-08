#!/usr/bin/env node
// 构建期预压缩:给 dist 里的文本类 / wasm / TTF·OTF 字体生成同名 .br(brotli 11)与 .gz(gzip 9)。
//
// 为什么要在构建期做,而不是只靠服务器运行时压缩:
//   - 运行时只能用快档(scripts/serve.mjs 是 brotli 6,守护进程是 gzip 最快档),构建期用最高档,
//     xlsx / pptx / docx 的 wasm 再小 15~20%(docx_edit 6.36 → 5.13 MB);
//   - 冷缓存时服务器不用当场把几十 MB 的 wasm 压一遍(docx_edit 用 brotli 6 也要约 1 秒 CPU);
//   - 性能基线(editor-bench)量到的传输量就是生产真实下发的字节,而不是测试服务器的原始字节。
// 由 scripts/serve.mjs(生产)、e2e/serve.mjs(测试)与 crates/kb-web/src/ui.rs(守护进程内嵌)按 Accept-Encoding 选用。
//
// 结果按内容 sha256 缓存在 node_modules/.cache/kb-precompress/:wasm 和字体几乎每次构建都不变,
// 只有第一次要花 1 分钟左右(docx_edit 一个文件就要 50 多秒的 brotli 11),之后只压改过的 JS / CSS。
// 本次构建没用到的缓存项会被删掉,缓存不会越攒越大。
//
// 用法:npm run build 会自动跑(postbuild);单独跑:node scripts/precompress.mjs [dist 目录]
//       KB_PRECOMPRESS=0 跳过(本地只想快速看页面时)。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

// 压缩走 libuv 线程池,默认只有 4 个线程;必须在第一次用到线程池之前设置
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(4, Math.min(16, availableParallelism())))
const zlib = await import('node:zlib')
const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(process.argv[2] ?? join(ROOT, 'dist'))
const CACHE = join(ROOT, 'node_modules', '.cache', 'kb-precompress')
// 参数一变,旧缓存就作废(键里带上它)
const VERSION = 'br11-lgwin24/gz9/v1'
/** 与生产服务器认的可压缩扩展名一致(单一真源在仓库根的 scripts/serve.mjs) */
const { COMPRESSIBLE_EXT } = await import(resolve(ROOT, '..', 'scripts', 'serve.mjs'))
const MIN_BYTES = 1024
/** 压完不到原来的 90% 就不生成(比如完整的 CJK OTF 字体),省磁盘也省内嵌体积 */
const MAX_RATIO = 0.9

if (process.env.KB_PRECOMPRESS === '0') {
  console.log('precompress: KB_PRECOMPRESS=0,跳过')
  process.exit(0)
}
if (!existsSync(DIST)) {
  console.error(`precompress: 找不到 ${DIST},先 vite build`)
  process.exit(1)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const files = [...walk(DIST)].filter((file) => {
  if (!COMPRESSIBLE_EXT.has(extname(file))) return false
  return statSync(file).size >= MIN_BYTES
})

mkdirSync(CACHE, { recursive: true })
const used = new Set()
const stats = { files: 0, raw: 0, br: 0, gz: 0, brFiles: 0, gzFiles: 0, cached: 0, compressed: 0 }

/** 取缓存或现压;缓存文件名 = sha256(参数 + 内容).编码 */
async function compressed(bytes, kind) {
  const key = createHash('sha256').update(VERSION).update(bytes).digest('hex')
  const cached = join(CACHE, `${key}.${kind}`)
  used.add(cached)
  if (existsSync(cached)) {
    stats.cached += 1
    return readFileSync(cached)
  }
  const out =
    kind === 'br'
      ? await brotli(bytes, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        })
      : await gzip(bytes, { level: 9 })
  writeFileSync(cached, out)
  stats.compressed += 1
  return out
}

async function one(file) {
  const bytes = readFileSync(file)
  stats.files += 1
  stats.raw += bytes.length
  const [br, gz] = await Promise.all([compressed(bytes, 'br'), compressed(bytes, 'gz')])
  // 先写原文件、后写预压缩文件:服务器只信比原文件新的 .br / .gz(防止原文件被替换后发出旧内容)
  if (br.length <= bytes.length * MAX_RATIO) {
    writeFileSync(`${file}.br`, br)
    stats.br += br.length
    stats.brFiles += 1
  }
  if (gz.length <= bytes.length * MAX_RATIO) {
    writeFileSync(`${file}.gz`, gz)
    stats.gz += gz.length
    stats.gzFiles += 1
  }
}

const started = performance.now()
// 大文件先压:docx_edit 一个就要 50 多秒,放到最后会让整体时间变成「其它所有文件 + 它」
const queue = [...files].sort((a, b) => statSync(b).size - statSync(a).size)
const workers = Number(process.env.UV_THREADPOOL_SIZE)
await Promise.all(
  Array.from({ length: workers }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        await one(file)
      } catch (error) {
        throw new Error(`precompress: ${relative(DIST, file)} 失败:${error.message}`)
      }
    }
  }),
)

// 清掉本次没用到的缓存项
for (const name of readdirSync(CACHE)) {
  const path = join(CACHE, name)
  if (!used.has(path)) rmSync(path, { force: true })
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
console.log(
  `precompress: ${stats.files} 个文件 ${mb(stats.raw)} → br ${stats.brFiles} 个 ${mb(stats.br)} / gz ${stats.gzFiles} 个 ${mb(stats.gz)}` +
    `(新压 ${stats.compressed} 份、缓存命中 ${stats.cached} 份,${((performance.now() - started) / 1000).toFixed(1)} s)`,
)
