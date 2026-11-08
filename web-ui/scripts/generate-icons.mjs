#!/usr/bin/env node
// 生成 PWA 图标:public/icon.svg 与 public/icons/*.png。
//
// 为什么自己画:仓库里没有品牌位图,也不能为了几张图引入图像库(不 npm install)。
// 图标 = 侧栏品牌块的复刻(靛紫渐变底 + 白色 "kb" 字标),字标用线段 + 圆环拼出来,
// SVG 与 PNG 用同一份几何数据,所以两者一致。PNG 用 4×4 超采样抗锯齿,只依赖 node 自带的 zlib。
//
// 用法:node scripts/generate-icons.mjs   (改了图形再跑一遍,把结果一起提交;不属于 build,build 不依赖它)
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// 底色:默认强调色 indigo-500 → 与 .logo 渐变同向的紫(components.css 里 color-mix(accent 55%, #c03fe0) 的结果)
const FROM = [0x5e, 0x6a, 0xd2]
const TO = [0x8a, 0x57, 0xd8]

// 字标几何(100×100 画布;线宽 11,圆头):k = 竖线 + 向左的 "<";b = 竖线 + 圆环
const STROKE = 11
const SHAPES = [
  { type: 'line', a: [19, 22], b: [19, 78] }, // k 竖线
  { type: 'line', a: [42, 36], b: [19, 57] }, // k 上臂
  { type: 'line', a: [19, 57], b: [42, 78] }, // k 下腿
  { type: 'line', a: [56, 22], b: [56, 78] }, // b 竖线
  { type: 'ring', c: [69, 62], r: 13 }, // b 圆环
]

/** 距离场:点到线段 / 圆环的距离(再减去半线宽 = 笔画内为负)。 */
function strokeDistance(shape, x, y) {
  if (shape.type === 'ring') return Math.abs(Math.hypot(x - shape.c[0], y - shape.c[1]) - shape.r) - STROKE / 2
  const [ax, ay] = shape.a
  const [bx, by] = shape.b
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - STROKE / 2
}

/** 圆角矩形距离场(100×100 画布,半径 radius;radius=0 就是铺满的方块,给 maskable 用)。 */
function roundedRectDistance(x, y, radius) {
  const qx = Math.abs(x - 50) - (50 - radius)
  const qy = Math.abs(y - 50) - (50 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

/**
 * 画一张 size×size 的 RGBA。
 * - radius:底的圆角(画布单位);maskable 用 0(系统自己裁圆)
 * - glyph:字标缩放(以画布中心为准);maskable 要把字标收进中间 80% 的安全圆,所以更小
 */
function render(size, { radius, glyph }) {
  const out = Buffer.alloc(size * size * 4)
  const SS = 4
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0
      let ink = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = ((px + (sx + 0.5) / SS) / size) * 100
          const y = ((py + (sy + 0.5) / SS) / size) * 100
          if (roundedRectDistance(x, y, radius) <= 0) bg += 1
          // 字标:把采样点从画布坐标映回字标坐标
          const gx = (x - 50) / glyph + 50
          const gy = (y - 50) / glyph + 50
          if (SHAPES.some((shape) => strokeDistance(shape, gx, gy) <= 0)) ink += 1
        }
      }
      const total = SS * SS
      // 渐变:左上 → 右下(135deg)
      const t = Math.min(1, Math.max(0, (px + py) / (2 * (size - 1))))
      const base = FROM.map((value, index) => value + (TO[index] - value) * t)
      const coverage = bg / total
      const white = ink / total
      const offset = (py * size + px) * 4
      for (let channel = 0; channel < 3; channel += 1) out[offset + channel] = Math.round(base[channel] * (1 - white) + 255 * white)
      out[offset + 3] = Math.round(255 * coverage)
    }
  }
  return out
}

// ---- 最小 PNG 编码(RGBA 8 位,无隔行) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // 位深
  header[9] = 6 // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0 // 过滤器:无
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- SVG(同一份几何) ----
function svg() {
  const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`
  const parts = SHAPES.map((shape) =>
    shape.type === 'ring'
      ? `<circle cx="${shape.c[0]}" cy="${shape.c[1]}" r="${shape.r}"/>`
      : `<line x1="${shape.a[0]}" y1="${shape.a[1]}" x2="${shape.b[0]}" y2="${shape.b[1]}"/>`,
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(FROM)}"/><stop offset="1" stop-color="${hex(TO)}"/></linearGradient></defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="${STROKE}" stroke-linecap="round">${parts.join('')}</g>
</svg>
`
}

mkdirSync(join(ROOT, 'icons'), { recursive: true })
const ANY = { radius: 22, glyph: 1 }
// maskable:系统会按自己的形状(圆 / 圆角方)裁,只有中间 80% 圆形安全区保证可见,所以整块铺满底色、字标缩到 0.66
const MASKABLE = { radius: 0, glyph: 0.66 }
const files = [
  ['icons/icon-192.png', 192, ANY],
  ['icons/icon-512.png', 512, ANY],
  ['icons/icon-maskable-512.png', 512, MASKABLE],
  ['icons/apple-touch-icon.png', 180, { radius: 0, glyph: 0.82 }], // iOS 自己加圆角,所以铺满;不透明
]
for (const [name, size, options] of files) {
  writeFileSync(join(ROOT, name), encodePng(size, render(size, options)))
  console.log(`写入 public/${name} (${size}×${size})`)
}
writeFileSync(join(ROOT, 'icon.svg'), svg())
console.log('写入 public/icon.svg')
