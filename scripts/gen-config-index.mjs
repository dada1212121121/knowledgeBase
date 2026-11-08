#!/usr/bin/env node
// 配置键清单生成与对表。
//
// 为什么要它:`Config` 结构体有 200 多个 `pub` 字段,前端 `settingsFields.ts` 用点分路径
// (`extract.ocr.slots`)指同一批键。Rust 里改个名字、前端不改,表现是「设置页那一栏点了没反应」
// ——没有任何一处会报错。这个脚本从 Rust 源码里把键清单抽出来,写进 `docs/CONFIG_INDEX.md`
// 的标记块,再反过来检查前端每一条 `path:` 都在清单里。
//
// 用法:
//   node scripts/gen-config-index.mjs           对表(不一致 exit 1,CI / verify.sh 用这个)
//   node scripts/gen-config-index.mjs --write   重新生成 docs/CONFIG_INDEX.md 的标记块
//
// 只负责「键」;默认值 / 区间的对账在 `web-ui/src/utils/settingsFields.spec.ts`(它要读
// `impl Default for X`,逻辑已经在那边,不在这里重复一份)。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_DIR = 'crates/kb-core/src/config'
const DOC = 'docs/CONFIG_INDEX.md'
const FIELDS = 'web-ui/src/utils/settingsFields.ts'
const BLOCK = ['<!-- kb-config:start -->', '<!-- kb-config:end -->']

const problems = []

/** 去掉整行注释,留下能按行解析的结构骨架。
 *
 * 只删「整行都是注释」的行,不做全文去字符串:配置里出现过带 `"` 的字符字面量与
 * 含引号的说明文字,全文正则配对会把结构体整段吃掉(踩过一次:一个文件只解析出 1 个结构体)。
 * 这个脚本只认 `pub struct` / `pub 字段:` 两种行,它们不会出现在注释里。 */
function skeleton(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/** 把 `pub struct NAME { ... }` 的字段抽出来(带 serde rename / flatten / 定界行号)。 */
function parseStructs(file, source) {
  const clean = skeleton(source)
  const rawLines = source.split('\n')
  const structs = new Map()
  // 只认行首的 `pub struct`,文档注释里的例子不会误伤
  const re = /^pub struct (\w+)\b/gm
  for (const match of clean.matchAll(re)) {
    const name = match[1]
    const start = clean.indexOf('{', match.index)
    if (start < 0) continue
    // 配平花括号拿到结构体范围
    let depth = 0
    let end = start
    for (let i = start; i < clean.length; i += 1) {
      if (clean[i] === '{') depth += 1
      else if (clean[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = clean.slice(start + 1, end)
    const fields = []
    // 字段行是缩进的,所以不能要求 `^pub`;类型在一行内(配置结构体没有跨行类型)
    for (const field of body.matchAll(/^\s*pub (\w+):\s*([^,]+?),?\s*$/gm)) {
      fields.push({ name: field[1], type: field[2].replace(/\s+/g, ' ').trim() })
    }
    // serde rename 要回到原文里找:每行 `#[serde(rename = "...")]` 紧跟一个字段
    const lineOfStruct = rawLines.findIndex((line) => line.startsWith(`pub struct ${name}`))
    const renames = new Map()
    for (let i = lineOfStruct; i >= 0 && i < rawLines.length; i += 1) {
      const rename = rawLines[i].match(/^#\[serde\(rename = "([^"]+)"/)
      if (rename) {
        for (let j = i + 1; j < rawLines.length; j += 1) {
          const field = rawLines[j].match(/^\s*pub (\w+):/)
          if (field) {
            renames.set(field[1], rename[1])
            break
          }
          if (/^\s*#\[/.test(rawLines[j])) continue
          break
        }
      }
    }
    const struct = { name, fields: fields.map((field) => ({ ...field, key: renames.get(field.name) ?? field.name })) }
    structs.set(name, struct)
  }
  return structs
}

// ── 1. 读 kb-core 的配置结构体 ─────────────────────────────────────
const sources = new Map()
for (const file of readdirSync(CONFIG_DIR).filter((name) => name.endsWith('.rs') && !name.endsWith('tests.rs'))) {
  const path = join(CONFIG_DIR, file)
  sources.set(path, readFileSync(path, 'utf8'))
}

const structs = new Map()
for (const [path, source] of sources) {
  for (const [name, struct] of parseStructs(path, source)) {
    if (structs.has(name)) problems.push(`${name} 在两个文件里都定义了(${path});键清单会有歧义`)
    structs.set(name, { ...struct, file: path })
  }
}

/** 展开一层:类型名(去掉 `Option<>` / `Box<>` 外壳)如果是我认识的配置结构体,就继续往下走。 */
const nested = (type) => {
  const bare = type.replace(/^Option<|>$/g, '').replace(/^Box<|>$/g, '').trim()
  return structs.has(bare) ? bare : null
}

const root = structs.get('Config')
if (!root) {
  console.error('✗ crates/kb-core/src/config 里找不到 `pub struct Config`')
  process.exit(1)
}

const leaves = []
const walk = (structName, prefix, seen) => {
  const struct = structs.get(structName)
  for (const field of struct.fields) {
    const path = prefix ? `${prefix}.${field.key}` : field.key
    const inner = nested(field.type)
    if (inner && !seen.includes(inner)) walk(inner, path, [...seen, inner])
    else leaves.push({ path, type: field.type, file: `${struct.file}`, struct: structName, field: field.name })
  }
}
walk('Config', '', ['Config'])
leaves.sort((left, right) => left.path.localeCompare(right.path))

if (leaves.length < 100) problems.push(`只抽出 ${leaves.length} 个键,明显少于预期的 200 左右(解析器坏了?)`)

// ── 2. 前端每条 path 都必须在清单里 ────────────────────────────────
const fieldsSource = readFileSync(FIELDS, 'utf8')
const known = new Set(leaves.map((leaf) => leaf.path))
const declared = [...fieldsSource.matchAll(/\bpath: '([^']+)'/g)].map((match) => match[1])
for (const path of declared) {
  if (!known.has(path)) problems.push(`${FIELDS} 的 path:'${path}' 在 kb-core 的配置里不存在(改名了?键清单见 ${DOC})`)
}

// ── 3. 文档里的标记块与生成的清单一致 ──────────────────────────────
const docSource = readFileSync(DOC, 'utf8')
const from = docSource.indexOf(BLOCK[0])
const to = docSource.indexOf(BLOCK[1])
if (from < 0 || to < from) {
  console.error(`✗ ${DOC} 缺少 ${BLOCK[0]} … ${BLOCK[1]} 标记块`)
  process.exit(1)
}

const listed = docSource
  .slice(from + BLOCK[0].length, to)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const want = leaves.map((leaf) => leaf.path)
const missing = want.filter((path) => !listed.includes(path))
const extra = listed.filter((path) => !known.has(path))
for (const path of missing) problems.push(`${DOC} 少了配置键 ${path}(跑 node scripts/gen-config-index.mjs --write)`)
for (const path of extra) problems.push(`${DOC} 多了配置键 ${path}(源码里没有;手写的就删掉)`)

if (process.argv.includes('--write')) {
  if (missing.length || extra.length) {
    const block = `${BLOCK[0]}\n${want.join('\n')}\n${BLOCK[1]}`
    writeFileSync(DOC, docSource.slice(0, from) + block + docSource.slice(to + BLOCK[1].length))
    console.log(`✓ 已把 ${want.length} 个配置键写进 ${DOC}`)
    process.exit(0)
  }
}

if (problems.length) {
  console.error(`✗ 配置键对表有 ${problems.length} 处问题:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`✓ ${DOC} 的 ${listed.length} 个配置键与 kb-core/src/config 一致`)
console.log(`✓ 前端 ${FIELDS} 的 ${declared.length} 条 path 都在配置键清单里`)
