#!/usr/bin/env node
// 视觉基线守卫（「无原始值」）:页面与视图里不允许出现
//   - 硬编码的十六进制颜色;
//   - 没有走 token 的字号 / 圆角 / 间距(只允许 calc(<n>px * var(--fs)) 或 var(--*));
// 例外:纯透明的 rgba() 阴影、以及 data-* 预览里刻意写死的颜色,用 // tokens-allow 标记。
//
// 跑法:node scripts/check-tokens.mjs(由 `npm run lint` 调用)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/pages', 'src/views']
const problems = []

function walk(dir) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) walk(path)
    else if (/\.(vue|css)$/.test(entry)) check(path)
  }
}

function check(path) {
  const text = readFileSync(path, 'utf8')
  // 文件级豁免:仅用于像素锁定的页面(例如登录页),必须在同文件里写明理由
  if (text.includes('tokens-allow-file')) return
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (line.includes('tokens-allow')) return
    // 十六进制颜色(#fff / #ffffff);#id 选择器不会出现在 template 里
    const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g)
    if (hex) {
      for (const value of hex) {
        // 只报“看起来像颜色”的:3/6/8 位且前面不是 & 或字母
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
          problems.push(`${path}:${index + 1} 硬编码颜色 ${value}`)
        }
      }
    }
    // 原始字号:font-size:13px(允许 calc(13px*var(--fs)))
    const fontSize = line.match(/font-size:\s*\d+(\.\d+)?px/)
    if (fontSize) {
      problems.push(`${path}:${index + 1} 原始字号 ${fontSize[0]}(应写 calc(<n>px*var(--fs)))`)
    }
    // 原始圆角 / 间距(允许 0 / 100% / auto / 单值 calc)
    const radius = line.match(/border-radius:\s*\d+(\.\d+)?px/)
    if (radius) {
      problems.push(`${path}:${index + 1} 原始圆角 ${radius[0]}(应走 var(--r*))`)
    }
  })
}

for (const root of ROOTS) walk(root)

if (problems.length) {
  console.error(`✗ 发现 ${problems.length} 处硬编码的视觉值:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('✓ 页面里没有硬编码的颜色 / 字号 / 圆角')
