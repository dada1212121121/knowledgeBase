#!/usr/bin/env node
// 旧别名棘轮:components.css 顶部为 mockup 保留的 --t/--m/--b/--ac… 短别名,
// 语义上等价于 --text-*/--surface-*/--border-*/--accent*,但读代码时无法判断 --r 是危险色还是圆角。
// 编辑器已经全部迁到语义 token;其余页面仍有存量,所以用「总数只减不增」的棘轮守住,禁止新代码继续加债。
//
// 规则:
//   1. src/editor/ 与 src/utils/editorTheme.ts 已迁移完成,出现任何旧别名即失败;
//   2. 全仓旧别名引用数不得超过 scripts/legacy-tokens-baseline.json 的 allowed;
//   3. 存量下降后跑 `node scripts/check-legacy-tokens.mjs --update` 下调基线,防止数字回弹。
//
// 跑法:node scripts/check-legacy-tokens.mjs(由 `npm run lint` 调用)。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'packages/kb-ui/src']
const EXT = /\.(vue|css|ts)$/
const SKIP = /\.spec\.ts$|node_modules|\/dist\//
const BASELINE = 'scripts/legacy-tokens-baseline.json'
// 已迁移范围:这里不允许回退到旧别名
const MIGRATED = ['src/editor/', 'src/utils/editorTheme.ts']
// 与 components.css 顶部别名表保持一致;新增别名要先迁移完存量再加入这里
const ALIASES = new Set([
  'bg', 'panel', 'panel2', 'hover',
  'e0', 'e1', 'e2', 'e3', 'ring', 'sans', 'mono',
  't', 't2', 'm', 'm2', 'b', 'b2', 'b3', 'ac', 'ac2', 'acbg',
  'g', 'y', 'r', 'o', 'c', 'p',
])
const USE = /var\(\s*--([A-Za-z0-9_-]+)\s*(?:,|\))/g

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

const found = [] // { file, line, name }
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(USE)) {
      if (ALIASES.has(match[1])) found.push({ file, line: index + 1, name: match[1] })
    }
  })
}

const migrated = found.filter((entry) => MIGRATED.some((scope) => entry.file === scope || entry.file.startsWith(scope)))
if (migrated.length) {
  console.error(`✗ 已迁移语义 token 的范围里出现 ${migrated.length} 处旧别名(禁止回退):`)
  for (const entry of migrated) console.error(`  ${entry.file}:${entry.line}  var(--${entry.name})`)
  console.error('  改成 --text-* / --surface-* / --border-* / --accent* 等语义 token;圆角用 --r1..--r4。')
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
if (process.argv.includes('--update')) {
  const next = { ...baseline, allowed: found.length }
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`✓ 旧别名基线已更新:${baseline.allowed} → ${found.length}`)
  process.exit(0)
}

if (found.length > baseline.allowed) {
  const byFile = new Map()
  for (const entry of found) byFile.set(entry.file, (byFile.get(entry.file) ?? 0) + 1)
  console.error(`✗ 旧别名引用数 ${found.length} 超过基线 ${baseline.allowed}(新增了 ${found.length - baseline.allowed} 处):`)
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.error(`  ${file}  ${count}`)
  }
  console.error('  新代码请直接用语义 token;确实要加存量时先评估,不要随手抬高基线。')
  process.exit(1)
}

const remaining = baseline.allowed - found.length
console.log(
  `✓ 旧别名棘轮:${found.length}/${baseline.allowed}${remaining > 0 ? `(已减少 ${remaining} 处,可跑 --update 下调基线)` : ''}`,
)
