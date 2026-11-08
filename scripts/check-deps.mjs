#!/usr/bin/env node
// 分层门禁:crate 之间的依赖方向必须与 ARCHITECTURE.md（分层与端口设计）一致。
//
// 为什么要有这个脚本:端口 + 适配器的设计只有「编译期依赖方向」能真正守住。
// 代码评审能发现一次 import 越界,但守不住一百次;这里把三条约定变成可断言的:
//
//   1. 领域层(kb-core)只依赖轻量库:不许出现 lancedb / lance / axum / rusqlite / fastembed 等
//      ——一旦引入,「换库时只改适配器」的前提就没了。
//   2. 服务层(kb-service)只许依赖三个纯能力库(kb-extract / kb-index / kb-llm),
//      不许依赖任何端口实现(kb-store-lance / kb-meta / kb-embed)与接入层。
//   3. 接入层(kb-web / kb-mcp / kb-acp)是「叶子」:其它 crate 不许反过来依赖它;
//      kb-cli 是组合根,谁都依赖它是不可能的(它只被自己依赖)。
//
// 另外做两件棘轮(ratchet):
//   - 外部依赖白名单存在 scripts/deps-baseline.json:新增/删除都要显式 --update,
//     避免「随手加个 crate」悄悄绕过分层;
//   - PENDING 里登记已知越界:越界消失后脚本会报「已还清,请删掉豁免」,
//     不会让欠账悄悄变成永久豁免。**当前是空的**(最后一个 kb-web → kb-meta 随
//     接入层改造还清:接入层改吃 kb_core::ports::system::IdentityStore)。
//
// 跑法:node scripts/check-deps.mjs(由 scripts/verify.sh 调用)
//       node scripts/check-deps.mjs --update(重写白名单基线)
//       cargo 不在 PATH 时先 source scripts/env.sh。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const BASELINE = 'scripts/deps-baseline.json'
const UPDATE = process.argv.includes('--update')

/** 领域层不许出现的基础设施依赖(出现即分层破功) */
const CORE_FORBIDDEN = [
  'lancedb', 'lance', 'lance-index', 'arrow', 'arrow-array', 'arrow-schema', 'arrow-buffer',
  'axum', 'tower', 'tower-http', 'hyper', 'rusqlite', 'sqlx', 'tokio', 'fastembed', 'ort',
  'reqwest', 'git2',
]

/** 服务层允许依赖的内部 crate(纯能力库,无端口实现、无 IO 配置) */
const SERVICE_INTERNAL_ALLOW = new Set(['kb-core', 'kb-extract', 'kb-index', 'kb-llm'])

/** 接入层:组合根之外谁都不许依赖它们 */
const ENTRY_CRATES = new Set(['kb-web', 'kb-mcp', 'kb-acp'])

/** 已知欠账:越界还在时放行(打印警告),越界修好后必须删掉这里,否则脚本失败 */
const PENDING = []

let metadata
try {
  metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }),
  )
} catch (error) {
  console.error('✗ 跑不动 cargo metadata(先 source scripts/env.sh)')
  console.error(`  ${error.message.split('\n')[0]}`)
  process.exit(1)
}

const members = new Set(metadata.packages.map((pkg) => pkg.name))
/** 只看 normal 依赖:dev-dependencies 是测试夹具,不参与分层 */
const normalDeps = (pkg) =>
  pkg.dependencies
    .filter((dep) => dep.kind === null || dep.kind === 'normal')
    .map((dep) => dep.name)
const internalDeps = (pkg) => normalDeps(pkg).filter((name) => members.has(name))
const externalDeps = (pkg) => normalDeps(pkg).filter((name) => !members.has(name))

const problems = []
const pendingHits = new Set()

/** 基线:每个 crate 的外部依赖快照(棘轮,新增必须显式确认) */
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
if (UPDATE) {
  for (const pkg of metadata.packages) baseline[pkg.name] = externalDeps(pkg).sort()
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`✓ 已更新 ${BASELINE}`)
  process.exit(0)
}

for (const pkg of metadata.packages) {
  const name = pkg.name
  const internal = internalDeps(pkg)
  const pending = PENDING.find((item) => item.from === name && internal.includes(item.to))
  const effective = internal.filter((dep) => !(pending && dep === pending.to))
  if (pending) {
    pendingHits.add(`${pending.from}->${pending.to}`)
    console.log(`… ${name} → ${pending.to}:${pending.reason}`)
  }

  // 规则 1:领域层不许碰基础设施
  if (name === 'kb-core') {
    for (const dep of externalDeps(pkg)) {
      if (CORE_FORBIDDEN.includes(dep)) problems.push(`kb-core 依赖了基础设施库 ${dep}(领域层只放纯逻辑)`)
    }
  }

  // 规则 2:服务层的内部依赖白名单
  if (name === 'kb-service') {
    for (const dep of effective) {
      if (!SERVICE_INTERNAL_ALLOW.has(dep)) {
        problems.push(`kb-service 依赖了 ${dep}(服务层只能用 ${[...SERVICE_INTERNAL_ALLOW].join(' / ')};端口实现在组合根注入)`)
      }
    }
  }

  // 规则 3:叶子 crate 不被反向依赖;组合根不被任何 crate 依赖(组合根自己要装配它们)
  if (!ENTRY_CRATES.has(name) && name !== 'kb-cli') {
    for (const dep of internal) {
      if (ENTRY_CRATES.has(dep)) problems.push(`${name} 反向依赖了接入层 ${dep}(依赖方向必须是 接入层 → 应用层 → 领域层)`)
    }
  }
  if (name !== 'kb-cli' && internal.includes('kb-cli')) {
    problems.push(`${name} 依赖了 kb-cli(kb-cli 是组合根,只能它依赖别人)`)
  }

  // 规则 4:外部依赖棘轮
  const expected = baseline[name]
  if (!expected) {
    problems.push(`${name} 不在 ${BASELINE} 里(跑 node scripts/check-deps.mjs --update 登记)`)
  } else {
    const now = externalDeps(pkg).sort()
    const added = now.filter((dep) => !expected.includes(dep))
    const removed = expected.filter((dep) => !now.includes(dep))
    for (const dep of added) problems.push(`${name} 新增外部依赖 ${dep}(跑 node scripts/check-deps.mjs --update,并在提交信息里说明用途)`)
    for (const dep of removed) problems.push(`${name} 移除了外部依赖 ${dep}(跑 node scripts/check-deps.mjs --update 同步基线)`)
  }
}

// 规则 5:豁免不能长期挂着
for (const item of PENDING) {
  if (!pendingHits.has(`${item.from}->${item.to}`)) {
    problems.push(`PENDING 里的 ${item.from} → ${item.to} 已经还清,请删掉这条豁免`)
  }
}

if (problems.length) {
  console.error(`✗ 发现 ${problems.length} 处分层问题:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`✓ ${members.size} 个 crate 的依赖方向符合分层(外部依赖白名单 ${BASELINE})`)
