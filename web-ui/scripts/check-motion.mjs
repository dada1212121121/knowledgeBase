#!/usr/bin/env node
// 编辑器动效守卫:编辑器 / 文档页里的 transition / animation 不允许写死时长和曲线,
// 必须取项目的动效令牌(var(--dur-*) / var(--ease-*) / var(--spring-dur) …)。
//
// 为什么:令牌随「动效偏好」(mac / crisp / lively / reduce)和系统「减少动效」一起变,写死的数字不会变。
// 以前编辑器里手写了 1.2s ease-in-out 的骨架屏,用户选了「减少动效」它还在闪;现在统一走令牌。
// 例外:在同一行写 `motion-allow` 并说明理由(例如光标闪烁是编辑器自己的节奏,不属于界面动效)。
//
// 范围:src/editor 里属于笔记 / 外壳的部分,以及文档页相关组件。Office 引擎(engines / page / grid / slide / pdf)
// 是另一套画布,不在这里管。
// 跑法:node scripts/check-motion.mjs(由 `npm run lint` 调用)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/editor']
const FILES = [
  'src/components/DocPage.vue',
  'src/components/DocSkeleton.vue',
  'src/components/FoldTransition.vue',
  'src/components/CollabBar.vue',
]
const SKIP_DIRS = new Set(['engines', 'page', 'grid', 'slide', 'pdf', 'extensions', 'codecs', 'collab', 'session', 'api', '__fixtures__'])
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
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path)
    } else if (/\.(vue|css)$/.test(entry) && !/\.spec\./.test(entry)) check(path)
  }
}

/** 声明里出现的字面时间(120ms / 0.3s),不算 var(...) 里面的、也不算 0s(visibility 的零延迟) */
const LITERAL_TIME = /(?<![\w.-])(?:\d+\.\d+|[1-9]\d*)(?:ms|s)\b/

function check(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  let inMotionDecl = false
  lines.forEach((line, index) => {
    if (line.includes('motion-allow')) {
      inMotionDecl = false
      return
    }
    const starts = /(^|[\s{;])(transition|animation)(-duration|-delay)?\s*:/.test(line)
    if (starts) inMotionDecl = true
    if (inMotionDecl) {
      // 去掉 var(...) 里的内容再找字面时间:var(--dur-base, 200ms) 的兜底值不算违规
      const bare = line.replace(/var\([^)]*\)/g, 'var()').replace(/calc\(([^()]|\([^()]*\))*\)/g, (m) => (/var\(\)/.test(m) ? '' : m))
      const hit = bare.match(LITERAL_TIME)
      if (hit) problems.push(`${path}:${index + 1} 写死的动效时长 ${hit[0]}(应取 var(--dur-*) 等动效令牌;确需例外在这一行写 motion-allow 并说明理由)`)
      if (/\bease(-in|-out|-in-out)?\b|\blinear\b(?!\s*\()/.test(bare.replace(/var\(\)/g, '')) && !/steps\(/.test(bare)) {
        problems.push(`${path}:${index + 1} 写死的缓动曲线(应取 var(--ease-*))`)
      }
    }
    if (inMotionDecl && line.includes(';') && !/,\s*$/.test(line)) inMotionDecl = false
  })
}

for (const root of ROOTS) walk(root)
for (const file of FILES) check(file)

if (problems.length) {
  console.error(`✗ 编辑器动效有 ${problems.length} 处没走令牌:`)
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}
console.log('✓ 编辑器 / 文档页的动效都走项目令牌(时长、曲线没有写死)')
