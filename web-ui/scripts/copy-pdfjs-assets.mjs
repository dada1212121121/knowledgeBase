#!/usr/bin/env node
// pdf.js 运行时要按需读的静态资源(CJK 字体映射 CMap、标准字体、ICC、JBIG2/JPX 的纯 JS 回退)。
// CSP 是 script-src 'self':不能走 CDN,也不能用 wasm(没有 'wasm-unsafe-eval'),所以复制到 public/pdfjs/,
// 由 Vite 原样带进 dist/,最终随 kb-web 一起嵌进守护进程。public/pdfjs 是生成物,不入库。
//
// 由 npm 的 predev / prebuild 自动调用;也可手动:node scripts/copy-pdfjs-assets.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules/pdfjs-dist')
const target = join(root, 'public/pdfjs')

if (!existsSync(source)) {
  console.error('找不到 node_modules/pdfjs-dist,先运行 npm ci')
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'iccs']) cpSync(join(source, dir), join(target, dir), { recursive: true })
mkdirSync(join(target, 'wasm'), { recursive: true })
for (const name of readdirSync(join(source, 'wasm'))) {
  // 只要纯 JS 回退;.wasm 本体在 CSP 下加载不了,留着只会白占二进制体积
  if (name.endsWith('_nowasm_fallback.js')) cpSync(join(source, 'wasm', name), join(target, 'wasm', name))
}
console.log('pdfjs assets →', target)
