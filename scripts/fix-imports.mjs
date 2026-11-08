#!/usr/bin/env node
// 拆文件之后清理「未用 import」的收敛器(2026-11-08,超长文件棘轮配套工具)。
//
// 为什么需要它:一次 `impl` 拆分会把原来的 import 头复制到每个子文件,每个子文件
// 只用得到其中一部分,`clippy -D warnings` 会一次报几十条 unused import。肉眼数
// 这些名字是灾难 —— 删错一个就 E0425,删不到位下一轮还红。唯一可信的裁判是编译器。
//
// 用法:
//   node scripts/fix-imports.mjs -p kb-service        # 收敛到干净为止
//   node scripts/fix-imports.mjs -p kb-web --dry-run  # 只报告,不改文件
//
// 三个必须记住的坑(脚本里都处理了,写下来免得下次再踩):
//   1. cargo **不会重发**上一次编译已经报过的 warning。不 touch 源文件,第二轮
//      就会拿到空输出,看起来像「干净了」——这是最危险的假绿。
//   2. 诊断走 **stderr**。只读 stdout 会得到同样的假绿。
//   3. 不带 `--message-format short` 时诊断是 `-->` 风格,没有 `file:line:col:`
//      前缀,解析不出来。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'


const args = process.argv.slice(2)
const pkgIdx = args.indexOf('-p')
if (pkgIdx === -1 || !args[pkgIdx + 1]) {
  console.error('用法: node scripts/fix-imports.mjs -p <crate> [--dry-run] [--max-rounds=8]')
  process.exit(2)
}
const pkg = args[pkgIdx + 1]
const dryRun = args.includes('--dry-run')
const maxRounds = Number((args.find((a) => a.startsWith('--max-rounds=')) ?? '--max-rounds=8').split('=')[1])

/** 让 cargo 重发所有 warning —— 见坑 1。 */
function touchSources(dir) {
  execFileSync('find', [dir, '-name', '*.rs', '-exec', 'touch', '{}', '+'], { stdio: 'ignore' })
}

/** 跑一次 clippy,返回 `{ 文件 → { 行号 → 名字集合 } }`。 */
function collectUnused() {
  let out = ''
  try {
    out = execFileSync(
      'cargo',
      ['clippy', '-p', pkg, '--all-targets', '--message-format', 'short', '--', '-D', 'warnings'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CARGO_TERM_COLOR: 'never' } },
    )
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  const hits = new Map()
  const pat = /^(\S+?):(\d+):(\d+): (?:error|warning): unused imports?: (.*)$/
  for (const line of out.split('\n')) {
    const m = pat.exec(line)
    if (!m) continue
    if (!hits.has(m[1])) hits.set(m[1], new Map())
    const byLine = hits.get(m[1])
    const lineNo = Number(m[2])
    if (!byLine.has(lineNo)) byLine.set(lineNo, new Set())
    for (const raw of m[4].matchAll(/`([^`]+)`/g)) {
      // `axum::http::HeaderMap` → `HeaderMap`(import 行里写的是最后一段)
      byLine.get(lineNo).add(raw[1].split('::').pop())
    }
  }
  return hits
}

touchSources('crates')
for (let round = 0; round < maxRounds; round++) {
  const hits = collectUnused()
  if (hits.size === 0) {
    console.log(`✓ 第 ${round} 轮后干净`)
    process.exit(0)
  }
  let removed = 0
  for (const [file, byLine] of hits) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [lineNo, names] of byLine) {
      const idx = lineNo - 1
      if (idx >= lines.length) continue
      let line = lines[idx]
      for (const name of names) {
        const re = new RegExp(`\\s*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*,?`)
        line = line.replace(re, '')
        removed++
      }
      // 整行只剩 `use ... { }` 或空行时删掉整行,否则留个 `use x;` 悬空
      lines[idx] = /^\s*use\s*[\w:]*(\{\s*\})?\s*;?\s*$/.test(line) || line.trim() === '' ? null : line
    }
    if (!dryRun) writeFileSync(file, lines.filter((l) => l !== null).join('\n'))
    console.log(`${dryRun ? '会删' : '删'} ${removed} 个名字:${file}`)
  }
  if (dryRun) process.exit(1)
  touchSources('crates')
}
console.error(`✗ ${maxRounds} 轮还没收敛,剩下的大概不是 unused import 问题`)
process.exit(1)
