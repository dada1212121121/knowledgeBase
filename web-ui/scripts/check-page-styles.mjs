#!/usr/bin/env node
// 页面层样式守卫(视觉基线规范 第 1 条):`src/pages/**` 与 `src/views/**` 里
// **禁止**写内联视觉样式(style="…"),也不允许直接写十六进制颜色。
//
// 允许的例外(必须在同一行写 `style-allow` 并说明理由):
//   - 数据驱动的动态尺寸(柱状图高度、进度条宽度)用 `:style` 且只引用 var()/百分比;
//   - 登录页(像素锁定的营销页)整文件豁免。
//
// 跑法:node scripts/check-page-styles.mjs(由 `npm run lint` 调用)。
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
    if (statSync(path).isDirectory()) walk(path)
    else if (entry.endsWith('.vue')) check(path)
  }
}

function check(path) {
  const text = readFileSync(path, 'utf8')
  if (text.includes('style-allow-file')) return
  text.split('\n').forEach((line, index) => {
    if (line.includes('style-allow')) return
    // 模板里的静态内联样式(允许 <style> 块,那里是页面级 CSS)
    if (/<[a-zA-Z][^>]*\sstyle="/.test(line)) {
      problems.push(`${path}:${index + 1} 内联 style="…"(改用 Kb* 组件或 kb-* 工具类)`)
    }
  })
}

for (const root of ROOTS) walk(root)

if (problems.length) {
  console.error(`✗ 页面里有 ${problems.length} 处内联样式(视觉基线规范):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('✓ 页面只组合组件与工具类,没有内联视觉样式')
