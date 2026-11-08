#!/usr/bin/env node
// 样式变量守卫:引用了从没定义过、也没写兜底值的 CSS 变量,浏览器会让整条声明静默失效
// (padding 变成 0、颜色回退成继承色),肉眼才看得出,lint 的其它检查(原始色值 / px)抓不到。
// 审核收件箱就栽过:--pad-3 / --gap-1 / --fs-15 都不存在,卡片内边距是 0,按钮挤成一团。
//
// 规则:源码里每个 `var(--x)`(没有兜底值)的 --x,必须在某处被定义:
//   - CSS / Vue 样式里的声明 `--x: …`;
//   - JS 里 `style.setProperty('--x', …)` 或 `:style="{ '--x': … }"` 这类运行时设置。
// 带兜底值的 `var(--x, 12px)` 不查(没定义时有兜底,是有意的)。
//
// 例外:同一行写 `css-vars-allow` 并说明理由(例如某个变量由第三方库注入)。
// 跑法:node scripts/check-css-vars.mjs(由 `npm run lint` 调用)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'packages/kb-ui/src', 'public']
const EXT = /\.(vue|css|ts|js|mjs)$/
const SKIP = /\.spec\.ts$|node_modules|\/dist\//

const files = []
function walk(dir) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (SKIP.test(path)) continue
    if (statSync(path).isDirectory()) walk(path)
    else if (EXT.test(entry)) files.push(path)
  }
}
for (const root of ROOTS) walk(root)
files.push('index.html')

const defined = new Set()
const used = [] // { name, file, line }
const DECLARE = /(--[A-Za-z0-9_-]+)\s*:/g
const SET_PROP = /setProperty\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g
const STYLE_KEY = /['"`](--[A-Za-z0-9_-]+)['"`]\s*:/g
// 完整的引用:var(--x) 或 var(--x, 兜底);后面不是 `)` 或 `,` 的(模板字符串拼出来的名字)不算
const USE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,|\))/g

for (const file of files) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const re of [DECLARE, SET_PROP, STYLE_KEY]) for (const match of text.matchAll(re)) defined.add(match[1])
  text.split('\n').forEach((line, index) => {
    if (line.includes('css-vars-allow')) return
    for (const match of line.matchAll(USE)) {
      if (match[2] === ',') continue // 有兜底值
      used.push({ name: match[1], file, line: index + 1 })
    }
  })
}

const problems = used.filter((entry) => !defined.has(entry.name))
if (problems.length) {
  console.error('✗ 引用了从没定义过、也没写兜底值的 CSS 变量(样式会静默失效):')
  for (const entry of problems) console.error(`  ${entry.file}:${entry.line}  var(${entry.name})`)
  console.error('  改成已有的 token(见 packages/kb-ui/src/tokens/),或给它定义/写兜底值 var(--x, 默认值)。')
  process.exit(1)
}
console.log(`✓ 样式变量:${new Set(used.map((entry) => entry.name)).size} 个被引用的变量都有定义`)
