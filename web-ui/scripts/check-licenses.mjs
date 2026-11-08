#!/usr/bin/env node
/**
 * 前端依赖许可检查
 *
 * 为什么自己写而不是装 license-checker：只需要读 package-lock.json 里每个包的 `license` 字段，
 * 不值得为此多一个依赖；而且锁文件就是实际打进产物的那一份，比扫 node_modules 更准。
 *
 * 规则：
 *  - 运行时依赖（非 dev）出现 GPL / AGPL / LGPL / SSPL / 无许可声明 → 失败；
 *  - dev 依赖只报告，不失败（不进产物，但仍列出来便于审计）；
 *  - 少数包在锁文件里没写 license 字段，按包内 package.json 再读一次。
 *
 * 用法：node scripts/check-licenses.mjs [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
const asJson = process.argv.includes('--json')

/** 禁止进运行时产物的许可（大小写不敏感，按单词匹配，`OR` 组合里任一项允许即可） */
const FORBIDDEN = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-NC)\b/i

function licenseOf(path, entry) {
  if (entry.license) return String(entry.license)
  const pkg = join(ROOT, path, 'package.json')
  if (!existsSync(pkg)) return ''
  const meta = JSON.parse(readFileSync(pkg, 'utf8'))
  if (typeof meta.license === 'string') return meta.license
  if (Array.isArray(meta.licenses)) return meta.licenses.map((item) => item.type ?? item).join(' OR ')
  return sniffLicenseFile(join(ROOT, path))
}

/** package.json 没写许可时（如 khroma），读包里的 LICENSE 文件开头识别常见许可；认不出就当未声明 */
function sniffLicenseFile(dir) {
  for (const name of ['LICENSE', 'license', 'LICENSE.md', 'LICENSE.txt', 'license.md']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const head = readFileSync(file, 'utf8').slice(0, 400)
    if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return 'MIT（据 LICENSE 文件）'
    if (/Apache License/i.test(head)) return 'Apache-2.0（据 LICENSE 文件）'
    if (/ISC License/i.test(head)) return 'ISC（据 LICENSE 文件）'
    if (/GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i.test(head)) return 'GPL（据 LICENSE 文件）'
  }
  return ''
}

/** SPDX 表达式里只要有一个允许的分支就算允许（`MIT OR GPL-2.0` 可以按 MIT 用） */
function allowed(license) {
  const branches = license.replace(/[()]/g, '').split(/\s+OR\s+/i)
  return branches.some((branch) => branch.trim() && !FORBIDDEN.test(branch))
}

const rows = []
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/')) continue
  // 本仓 workspace 链接（packages/kb-ui）不算第三方
  if (entry.link) continue
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const license = licenseOf(path, entry)
  rows.push({ name, version: entry.version ?? '', license, dev: !!entry.dev, ok: !!license && allowed(license) })
}

const runtimeBad = rows.filter((row) => !row.dev && !row.ok)
const devBad = rows.filter((row) => row.dev && !row.ok)
const tally = new Map()
for (const row of rows.filter((item) => !item.dev)) tally.set(row.license || '（未声明）', (tally.get(row.license || '（未声明）') ?? 0) + 1)

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, runtime: rows.filter((row) => !row.dev).length, runtimeBad, devBad, tally: Object.fromEntries(tally) }, null, 2))
} else {
  console.log(`依赖 ${rows.length} 个（运行时 ${rows.filter((row) => !row.dev).length} 个）`)
  console.log([...tally].sort((a, b) => b[1] - a[1]).map(([license, count]) => `  ${count}\t${license}`).join('\n'))
  if (devBad.length) console.log(`\n开发依赖里不允许进产物的许可（只报告）：\n${devBad.map((row) => `  ${row.name}@${row.version}  ${row.license || '（未声明）'}`).join('\n')}`)
}
if (runtimeBad.length) {
  console.error(`\n✗ 运行时依赖有 ${runtimeBad.length} 个许可不允许或未声明：\n${runtimeBad.map((row) => `  ${row.name}@${row.version}  ${row.license || '（未声明）'}`).join('\n')}`)
  process.exit(1)
}
if (!asJson) console.log('\n✓ 运行时依赖许可检查通过（无 GPL / AGPL / LGPL / SSPL，无未声明）')
