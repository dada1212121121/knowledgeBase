#!/usr/bin/env node
// 文档对表门禁:让 ARCHITECTURE.md 里两份「名单」无法悄悄过期。
//
// 为什么:文档漂移是慢性病——2026-11 复查发现 ARCHITECTURE.md 还写着 13 个 crate、缺 kb-mail / kb-collab / kb-acp,
// 画了一个不存在的 kb-daemon;旧稿更是把 Loader / KeywordIndex / EvolutionTrigger / register_embedder
// 当既有实现写,而它们在代码里要么已删、要么从来没有过。评审发现不了,只能靠脚本对表。
//
// 规则:
//   1. `<!-- kb-crates:start --> … <!-- kb-crates:end -->` 之间的名单
//      与 `Cargo.toml` 的 workspace.members(按目录名取名)逐一相等;
//   2. crates/ 下每个实际目录都要在名单里(反之亦然);
//   3. `<!-- kb-ports:start --> … <!-- kb-ports:end -->` 之间的名单
//      与 `crates/kb-core/src/ports/{mod,repo,system}.rs` 里的 `pub trait` 逐一相等;
//   4. 文档里不许再出现已不存在的 crate 名(kb-daemon)。
//
// 跑法:node scripts/check-docs.mjs(由 scripts/verify.sh 调用)
import { readdirSync, readFileSync } from 'node:fs'

const DOC = 'ARCHITECTURE.md'
const CRATES_DIR = 'crates'
const CRATES_BLOCK = ['<!-- kb-crates:start -->', '<!-- kb-crates:end -->']
const PORTS_BLOCK = ['<!-- kb-ports:start -->', '<!-- kb-ports:end -->']
/** 端口不止在 ports/mod.rs:repo.rs 放元数据端口,system.rs 放账号端口。
 *  这里写死三个文件名,是为了「新增一个端口文件」时脚本会报错提醒同步文档口径。 */
const PORT_FILES = [
  'crates/kb-core/src/ports/mod.rs',
  'crates/kb-core/src/ports/repo.rs',
  'crates/kb-core/src/ports/system.rs',
]
/** 文档里出现过、但实现中没有的 crate 名(历史设计名);只查「当成 crate 用」的写法,
 *  纯进程名(kb-daemon 作为进程)允许保留,ARCHITECTURE.md 有对表说明 */
const GHOSTS = ['kb-daemon']

const problems = []

const doc = readFileSync(DOC, 'utf8')

/** 取出标记块里的名单(每行一项,忽略空行)。 */
function readBlock([start, end], label) {
  const from = doc.indexOf(start)
  const to = doc.indexOf(end)
  if (from < 0 || to < from) {
    console.error(`✗ ${DOC} 缺少 ${start} … ${end} 标记块(${label}名单要能被脚本读到)`)
    process.exit(1)
  }
  return doc
    .slice(from + start.length, to)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 名单与实际集合互查;返回去重后的名单长度(重复项单独报错)。 */
function compare(listed, actual, label, hint) {
  if (new Set(listed).size !== listed.length) problems.push(`${DOC} ${label}名单有重复项`)
  for (const name of actual) {
    if (!listed.includes(name)) problems.push(`${DOC} ${label}名单少了 ${name}${hint ? `(${hint})` : ''}`)
  }
  for (const name of listed) {
    if (!actual.includes(name)) problems.push(`${DOC} ${label}名单写了不存在的 ${name}`)
  }
}

// ── 1. crate 名单 ────────────────────────────────────────────────
const [cratesStart, cratesEnd] = CRATES_BLOCK
const listed = readBlock(CRATES_BLOCK, 'crate ')

const actual = readdirSync(CRATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

compare(listed, actual, 'crate ', '新增 crate 时在名单块里补一行')

// Cargo.toml 的 members 也要与目录一致(防止「加了目录忘了登记」)
const manifest = readFileSync('Cargo.toml', 'utf8')
const membersBlock = manifest.match(/members\s*=\s*\[([\s\S]*?)\]/)
if (!membersBlock) {
  problems.push('Cargo.toml 里找不到 workspace.members')
} else {
  const members = [...membersBlock[1].matchAll(/"crates\/([^"]+)"/g)].map((match) => match[1]).sort()
  for (const name of actual) if (!members.includes(name)) problems.push(`Cargo.toml workspace.members 少了 crates/${name}`)
  for (const name of members) if (!actual.includes(name)) problems.push(`Cargo.toml workspace.members 写了不存在的 crates/${name}`)
}

// 幽灵 crate:只在「名单块之外」查,且要求是路径 / crate 语境
// (kb-daemon 作为进程名是设计术语,允许保留;写成 crates/kb-daemon 或「kb-daemon crate」才算错)
const outside = doc.replace(doc.slice(doc.indexOf(cratesStart), doc.indexOf(cratesEnd)), '')
for (const ghost of GHOSTS) {
  const patterns = [`crates/${ghost}`, `${ghost}/`, `${ghost}\\s+crate`]
  for (const pattern of patterns) {
    if (new RegExp(pattern).test(outside)) {
      problems.push(`${DOC} 把 ${ghost} 当成 crate 写了(实现里是 kb daemon 子命令,见 ARCHITECTURE.md)`)
    }
  }
}

// ── 2. 端口名单 ──────────────────────────────────────────────────
const listedPorts = readBlock(PORTS_BLOCK, '端口')
const actualPorts = []
for (const file of PORT_FILES) {
  const source = readFileSync(file, 'utf8')
  // 只认行首的 `pub trait`(文档注释里举反例时不会误伤)
  for (const [, name] of source.matchAll(/^pub trait (\w+)/gm)) actualPorts.push(name)
}

compare(listedPorts, actualPorts, '端口', '在名单块里补一行')

// 端口文件本身的增删也要提醒:文件名写死在脚本里,新增文件后上面那段读不到它
const portFiles = readdirSync('crates/kb-core/src/ports')
  .filter((name) => name.endsWith('.rs'))
  .map((name) => `crates/kb-core/src/ports/${name}`)
for (const file of portFiles) {
  if (!PORT_FILES.includes(file)) problems.push(`${file} 不在 check-docs.mjs 的 PORT_FILES 里,它的端口没被对表`)
}

// ── 3. 设计章节的实现状态 ────────────────────────────────────────
// 第 14 章之后是设计章节,如果不标状态,读者会把规划当成现状——「文档撒谎比没文档更贵」。
// 每章标题后(空行之后)必须有一条 `> **状态:已实现|部分实现|规划**`。
const DESIGN_SECTIONS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
const STATUS_TAGS = ['已实现', '部分实现', '规划']
const lines = doc.split('\n')
for (const number of DESIGN_SECTIONS) {
  const title = lines.findIndex((line) => line.startsWith(`## ${number}. `))
  if (title < 0) {
    problems.push(`${DOC} 找不到第 ${number} 章标题(章节编号被改过?)`)
    continue
  }
  // 标题后 1~8 行内必须出现状态行(允许先空一行)
  const window = lines.slice(title + 1, title + 9).join('\n')
  const found = window.match(/> \*\*状态:([^*]+)\*\*/)
  if (!found) {
    problems.push(`${DOC} 第 ${number} 章没有状态标记(在标题下写一行「> **状态:已实现 / 部分实现 / 规划**」)`)
  } else if (!STATUS_TAGS.includes(found[1].trim())) {
    problems.push(`${DOC} 第 ${number} 章的状态「${found[1]}」不在 ${STATUS_TAGS.join(' / ')} 里`)
  }
}

if (problems.length) {
  console.error(`✗ 文档与实现有 ${problems.length} 处对不上:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`✓ ${DOC} 的 ${actual.length} 个 crate 与 crates/ 目录、Cargo.toml 成员一致`)
console.log(`✓ ${DOC} 的 ${actualPorts.length} 个端口与 crates/kb-core/src/ports/ 的 pub trait 一致`)
console.log(`✓ ${DOC} 第 14~23 章的 ${DESIGN_SECTIONS.length} 章都标了实现状态`)
console.log('  新增 crate / 端口时记得在对应名单块里补一行(脚本会报出来)')
