#!/usr/bin/env node
// 「新增文件 ≤ 900 行」棘轮。
//
// 为什么是棘轮而不是一刀切:仓库里有 30 多个 `src/` 文件早就超过 900 行(最长的
// `kb-capability/src/defs/mod.rs` 4 558 行)。要求一次性全部拆开,结果一定是没人敢动这张卡;
// 而只要不再新增超长文件,存量就会被后面的卡一个个啃掉。所以这里的规则是:
//
//   - 不在豁免表里的 `src/` 文件超过 900 行 → 红(新文件别再造第二个 defs/mod.rs);
//   - 在豁免表里的文件,**行数只许减不许增** → 红(你在这张卡里往老超长文件里加代码);
//   - 豁免表里的文件已经降到 900 行以内(或已不存在)→ 红,提醒把这行删掉(表只减不增)。
//
// 只看 `crates/*/src/` 与 `web-ui` 下的 `.vue`:测试文件(`tests.rs` / `*_tests.rs` / `/tests/`)
// 天然会很长,按行数逼着拆测试只会把断言切碎。前端从 2026-11-08 起也进棘轮 ——
// 之前 Rust 侧刚立规矩、前端就有三个 2000+ 行的 `.vue` 在扫描范围外,等于规矩一进前端就破了。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIMIT = 900

/** 存量豁免表:`路径 → 当前行数`。行数降到 `LIMIT` 以下就把这一行删掉。 */
const EXEMPT = new Map(
  Object.entries({
    'crates/kb-service/src/index/mod.rs': 1790,
    'crates/kb-service/src/upload/ingest.rs': 1647,
    'crates/kb-store-lance/src/lib.rs': 1640,
    'crates/kb-cli/src/daemon.rs': 1547,
    'crates/kb-cli/src/commands/eval.rs': 1519,
    'crates/kb-service/src/scheduler.rs': 1402,
    'crates/kb-cli/src/doctor.rs': 1391,
    'crates/kb-service/src/items.rs': 1370,
    'crates/kb-web/src/editor_ext.rs': 1285,
    'crates/kb-collab/src/core.rs': 1283,
    'crates/kb-service/src/office_install.rs': 1258,
    'crates/kb-meta/src/system/grants.rs': 1170,
    'crates/kb-web/src/share_public.rs': 1169,
    'crates/kb-service/src/sources.rs': 1157,
    'crates/kb-cli/src/capability_backend/files.rs': 1124,
    'crates/kb-web/src/auth/mod.rs': 1104,
    'crates/kb-service/src/upload/mod.rs': 1089,
    'crates/kb-cli/src/office_collab.rs': 1067,
    'crates/kb-core/src/ports/repo.rs': 1061,
    'crates/kb-service/src/skills/plugin.rs': 1034,
    'crates/kb-extract/src/ooxml.rs': 1032,
    'crates/kb-meta/src/repo/job.rs': 987,
    'crates/kb-service/src/evolution/session.rs': 987,
    'crates/kb-cli/src/capability_backend/jobs.rs': 968,
    'crates/kb-core/src/ports/system.rs': 913,
  }),
)

/** 前端存量豁免表:`.vue` 单文件 900 行上限,`Browser.vue` 这种 4000 行的先冻住。 */
const EXEMPT_VUE = new Map(
  Object.entries({
    "web-ui/src/components/AssistantDrawer.vue": 2305,
    "web-ui/src/components/DocPage.vue": 2244,
    "web-ui/src/components/OfficeEditor.vue": 983,
    "web-ui/src/components/PdfViewer.vue": 1029,
    "web-ui/src/components/share/SharedDoc.vue": 993,
    "web-ui/src/editor/host/EditorChrome.vue": 1958,
    "web-ui/src/editor/host/EditorHost.vue": 1266,
    "web-ui/src/editor/surfaces/grid/GridSurface.vue": 986,
    "web-ui/src/editor/surfaces/grid/XlsxReadView.vue": 1507,
    "web-ui/src/editor/surfaces/page/DocxReadView.vue": 911,
    "web-ui/src/editor/surfaces/page/edit/DocxEditView.vue": 1123,
    "web-ui/src/editor/surfaces/slide/SlideView.vue": 1230,
    "web-ui/src/pages/Browser.vue": 4010,
  }),
)

/** 测试文件不参与(长是常态)。 */
const isTest = (path) => /\/tests\.rs$|_tests\.rs$|\/tests\//.test(path)

function* vueSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* vueSources(path)
    else if (entry.name.endsWith('.vue')) yield path
  }
}

function* rustSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* rustSources(path)
    else if (entry.name.endsWith('.rs')) yield path
  }
}

const crates = 'crates'
const files = []
for (const entry of readdirSync(crates, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const src = join(crates, entry.name, 'src')
  try {
    if (!statSync(src).isDirectory()) continue
  } catch {
    continue
  }
  for (const path of rustSources(src)) {
    if (isTest(path)) continue
    files.push(path)
  }
}

const problems = []
const seen = new Set()
for (const path of files) {
  const lines = readFileSync(path, 'utf8').split('\n').length - 1
  const allowed = EXEMPT.get(path)
  seen.add(path)
  if (allowed === undefined) {
    if (lines > LIMIT) {
      problems.push(`${path} 有 ${lines} 行,超过 ${LIMIT} 行上限(拆成子模块,别加进豁免表)`)
    }
    continue
  }
  if (lines > allowed) {
    problems.push(`${path} 从 ${allowed} 行涨到 ${lines} 行(豁免表里的文件只许变短)`)
  } else if (lines <= LIMIT) {
    problems.push(`${path} 已经降到 ${lines} 行,把它从 EXEMPT 里删掉(表只减不增)`)
  } else if (lines < allowed) {
    // 变短了但还在阈值上:允许,但把新数字记下来,免得下次涨回去没人管
    console.log(`  ${path}:${allowed} → ${lines} 行(记得更新豁免表的数字)`)
  }
}
const vueDirs = ['web-ui/src', 'web-ui/packages']
const vues = []
for (const dir of vueDirs) {
  try {
    for (const path of vueSources(dir)) vues.push([path, readFileSync(path, 'utf8').split('\n').length])
  } catch {
    // 目录不存在时跳过(纯 Rust 环境也能跑这个脚本)
  }
}
for (const [path, lines] of vues) {
  const allowed = EXEMPT_VUE.get(path)
  if (allowed === undefined) {
    if (lines > LIMIT) problems.push(`${path} 有 ${lines} 行,超过 ${LIMIT} 行上限(拆成子组件,别加进豁免表)`)
  } else if (lines > allowed) {
    problems.push(`${path} 从 ${allowed} 涨到 ${lines} 行(豁免表只许变短)`)
  } else if (lines <= LIMIT) {
    problems.push(`${path} 已经降到 ${lines} 行,把它从 EXEMPT_VUE 里删掉(表只减不增)`)
  }
}
for (const path of EXEMPT_VUE.keys()) {
  if (!vues.some(([p]) => p === path)) problems.push(`${path} 在豁免表里但文件不在(改名 / 删掉了?),把这一行删掉`)
}

for (const path of EXEMPT.keys()) {
  if (!seen.has(path)) problems.push(`${path} 在豁免表里但文件不在(改名 / 删掉了?),把这一行删掉`)
}

if (problems.length) {
  console.error(`✗ 文件大小棘轮有 ${problems.length} 处问题:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(
  `✓ ${files.length} 个 src 文件 + ${vues.length} 个 .vue:${EXEMPT.size + EXEMPT_VUE.size} 个存量超长文件在豁免表里(只许变短),其余都不超过 ${LIMIT} 行`,
)
