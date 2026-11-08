#!/usr/bin/env node
// 共享包边界门禁:packages/kb-ui 是「可独立复用」的组件层,不许反向依赖应用层。
//
// 为什么:`@kb/ui` 里的组件本该只认 props / inject / 自己的 composables。
// 一旦出现 `import { callCapability } from '@/api/client'` 这种写法,共享包就和应用层的
// http 客户端、路由表绑死,既没法单独发布,也让「改一条路由」变成改共享包。
// 历史上 KbCommandPalette 就是这样越界的,所以把规则钉成脚本。
//
// 规则:packages/kb-ui/src 下的 .ts / .vue(测试文件除外)
//   1. 不许 import `@/…`(应用层别名);
//   2. 不许用相对路径跳出包外去取应用层目录(…/src/…);
//   3. 不许 import `vue-router` 之外的应用层单例(按路径判断,等价于 1)。
//
// 跑法:node scripts/check-kb-ui.mjs(由 `npm run lint` 调用)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'packages/kb-ui/src'
const EXT = /\.(vue|ts)$/
const SKIP = /\.spec\.ts$|node_modules/
// 只认真正的模块说明符,避免把注释里的示例算进来
const FROM = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

const problems = []
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (SKIP.test(path)) continue
    if (statSync(path).isDirectory()) walk(path)
    else if (EXT.test(entry)) files.push(path)
  }
}
walk(ROOT)

for (const path of files) {
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(FROM)) {
      const spec = match[1]
      if (spec.startsWith('@/')) {
        problems.push(`${path}:${index + 1} 引入应用层别名 ${spec}(改成 props / inject,数据留在应用层)`)
      } else if (/(^|\/)src\//.test(spec) && spec.startsWith('..')) {
        problems.push(`${path}:${index + 1} 相对路径跳出共享包 ${spec}(改成 props / inject)`)
      }
    }
  })
}

if (problems.length) {
  console.error(`✗ 共享包越界 ${problems.length} 处:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`✓ ${files.length} 个共享包文件没有反向依赖应用层`)
