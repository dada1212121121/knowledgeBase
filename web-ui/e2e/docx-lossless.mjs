#!/usr/bin/env node
// Word 保存无损门禁：对一组真实 docx 逐份验证
//   1. 打开 → 页面在隔离的临时会话里做一次真实的探针编辑（文首插入一个标记字符）并保存 → 服务端比较 + 本地内容清点，
//      得到三态：可编辑 / 只读但可「仍然编辑」（别的部件会被改写）/ 不能编辑（会丢内容）。
//      为什么不是"不改保存"：引擎对没改过的文档原样返回原件字节，那种检查永远显示无损，看不见重写时丢东西；
//   2. 能编辑的：真的改一个词、保存。检查保存出的内容不丢（文字、形状、表格…），无损的文件只能动 word/document.xml 与 docProps/core.xml；
//      **不能编辑的文件必须真的是只读**（键入不改字、没有保存请求）；
//   3. 同一份文件第二次打开：不再起临时会话、也不再请求服务端（按 sha256 缓存）。
// 比较规则同服务端 office_check（见 office-compare.mjs）；页面发出的 roundtrip-check 请求由本脚本用同一规则作答。
//
// 用法（先 npm run build）：
//   node e2e/docx-lossless.mjs                                   # 默认清单 scratch/office-e2e/compat-docx-files.txt
//   node e2e/docx-lossless.mjs --list=/path/files.txt --limit=3
//   node e2e/docx-lossless.mjs --self-test                       # 只跑比较规则的自检
// 结果：e2e/out/docx-lossless.json / .md。有"丢内容却能编辑"、"不能编辑却能改字"、改字动了不该动的部件、缓存没生效，退出码 1。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { adminMe, ALL_FEATURES, FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { COLLECTION } from './editor-helpers.mjs'
import JSZip from 'jszip'
import { comparePackages, selfTest } from './office-compare.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const flag = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback

if (process.argv.includes('--self-test')) {
  const failures = await selfTest()
  if (failures.length) {
    console.error(`✗ office-compare 自检未通过\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('✓ office-compare 自检通过')
  process.exit(0)
}
// 每次都先自检：比较规则本身错了，后面 18 份的结论都不可信
const selfFailures = await selfTest()
if (selfFailures.length) {
  console.error(`✗ office-compare 自检未通过，中止\n  ${selfFailures.join('\n  ')}`)
  process.exit(1)
}

// 默认清单在主仓库的 scratch 下（不进 git）；换机器 / 换清单用 --list= 或 KB_DOCX_LIST
const LIST = flag('list', process.env.KB_DOCX_LIST ?? '/srv/kb/scratch/office-e2e/compat-docx-files.txt')
const LIMIT = Number(flag('limit', '999'))
const OPEN_TIMEOUT = Number(flag('timeout', '240000'))
// 改一个词时允许被改动的部件：正文与文档属性（最后修改时间等）
const EDITABLE_PARTS = new Set(['word/document.xml', 'docProps/core.xml'])

const files = readFileSync(LIST, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, LIMIT)
const missing = files.filter((file) => !existsSync(file))
if (missing.length) {
  console.error(`清单里有文件不存在：\n  ${missing.join('\n  ')}`)
  process.exit(2)
}

FILES.file_docx.item.origin = 'upload'
FILES.file_docx.preview.origin = 'upload'

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
const results = []

/** 独立的内容清点（故意不复用被测的 TS 实现）：文字（不含 mc:Fallback 里重复的那份）与图形名称 */
async function docxInventory(bytes) {
  const xml = (await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string')).replace(/<mc:Fallback[\s>][\s\S]*?<\/mc:Fallback>/g, '')
  return {
    text: [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''),
    shapes: [...xml.matchAll(/<wp:docPr [^>]*name="([^"]*)"/g)].map((m) => m[1]),
  }
}

async function openEditor(tab, url) {
  const started = Date.now()
  await tab.goto(url, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 90_000 })
  await tab.click('[data-testid="office-edit-open"]')
  // 结束条件：出现画布且遮罩消失，或者出现错误提示
  await tab.waitForFunction(
    () => !!document.querySelector('[data-testid="office-error"]') || (!!document.querySelector('.kb-office-host canvas') && !document.querySelector('[data-testid="office-veil"]')),
    null,
    { timeout: OPEN_TIMEOUT, polling: 200 },
  )
  return Date.now() - started
}

async function saveAndGet(tab, office) {
  const before = office.replaces.length
  await tab.click('[data-testid="editor-save"]')
  const until = Date.now() + 60_000
  while (office.replaces.length <= before && Date.now() < until) await tab.waitForTimeout(200)
  return office.replaces.length > before ? office.replaces.at(-1).body : null
}

try {
  for (const [index, file] of files.entries()) {
    const original = readFileSync(file)
    const sha = createHash('sha256').update(original).digest('hex')
    const row = { index: index + 1, name: basename(file), size: statSync(file).size, state: 'error', note: '' }
    results.push(row)
    process.env.KB_SAMPLE_DOCX = file
    const office = { replaces: [], roundtrips: [], held: true }
    const reports = []
    // 页面发来的是"探针保存的包"（文首多了一个标记字符）；这里按服务端 `roundtrip-check` 的口径作答：
    // 逐部件比较。文字是否丢失由页面自己的内容清点判断（服务端对这种包的 text_equal 必然为 false，页面不采信）
    office.roundtrip = async (resaved) => {
      const diff = await comparePackages(original, resaved)
      const identical = !diff.changed.length && !diff.removed.length && !diff.added.length
      const report = { valid: true, reason: null, lossless: identical, changed_parts: diff.changed, removed_parts: diff.removed, added_parts: diff.added, text_equal: false }
      reports.push(report)
      return report
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
    try {
      await installFixture(context, {
        __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) },
        file_info: () => ({ sha256: sha, origin: 'upload', max_replace_bytes: 256 * 1024 * 1024 }),
        __officeEdit: office,
      })
      const tab = await context.newPage()
      const errors = []
      tab.on('pageerror', (error) => errors.push(error.message.slice(0, 160)))
      const url = `${base}/kb?collection=${COLLECTION}&item=file_docx`
      row.openMs = await openEditor(tab, url)
      const failed = await tab.locator('[data-testid="office-error"]').count()
      if (failed) {
        row.state = 'error'
        row.note = (await tab.locator('[data-testid="office-error"]').innerText()).slice(0, 200)
        continue
      }
      const report = reports.at(-1)
      row.server = report ? { changed: report.changed_parts, removed: report.removed_parts, added: report.added_parts } : null
      row.cachedHit = !report
      const readonly = (await tab.locator('[data-testid="office-readonly"]').count()) > 0
      const force = (await tab.locator('[data-testid="office-force"]').count()) > 0
      row.concern = (await tab.locator('[data-testid="office-concern"]').count()) ? (await tab.locator('[data-testid="office-concern"]').first().innerText()).slice(0, 160) : ''
      row.state = !readonly ? 'editable' : force ? 'force' : 'blocked'

      // 独立的内容检查：页面说"可编辑"就必须真改一次不丢
      const input = tab.locator('textarea.paged-editor__input')
      const typeAndSave = async () => {
        await input.focus()
        await tab.keyboard.press('Control+End')
        await tab.keyboard.type('验', { delay: 30 })
        await tab.waitForTimeout(800)
        return saveAndGet(tab, office)
      }
      const judge = async (saved) => {
        const diff = await comparePackages(original, saved)
        const before = await docxInventory(original)
        const after = await docxInventory(saved)
        return {
          parts: { changed: diff.changed, removed: diff.removed, added: diff.added },
          textOk: after.text === `${before.text}验`,
          // 按个数比：引擎重写图片时会改名重建（图片 7 → Picture 1372585881），名称不可靠
          lostShapes: after.shapes.length < before.shapes.length ? [`少了 ${before.shapes.length - after.shapes.length} 个（${before.shapes.length}→${after.shapes.length}）`] : [],
          textDiff: after.text === `${before.text}验` ? null : { before: before.text.length, after: after.text.length },
        }
      }
      if (row.state === 'editable') {
        const saved = await typeAndSave()
        if (saved && process.env.KB_DOCX_KEEP) writeFileSync(`${process.env.KB_DOCX_KEEP}/${basename(file, '.docx')}.edited.docx`, saved)
        row.edit = saved ? await judge(saved) : { error: '改字后保存没有发出请求' }
      } else if (row.state === 'force') {
        await tab.click('[data-testid="office-force"]')
        await tab.waitForFunction(() => !document.querySelector('[data-testid="office-veil"]') && !document.querySelector('[data-testid="office-readonly"]'), null, { timeout: OPEN_TIMEOUT })
        const saved = await typeAndSave()
        row.edit = saved ? await judge(saved) : { error: '改字后保存没有发出请求' }
      } else {
        // 不能编辑：必须真的只读——键入不改字、也发不出保存请求
        await input.focus()
        await tab.keyboard.type('验', { delay: 30 })
        await tab.waitForTimeout(600)
        row.readOnlyHolds = {
          inputReadOnly: await tab.evaluate(() => document.querySelector('textarea.paged-editor__input')?.readOnly === true),
          saveButton: await tab.locator('[data-testid="editor-save"]').count(),
          replaces: office.replaces.length,
        }
      }

      // 第二次打开同一份：同一个 context（localStorage 缓存在里面），不应再起探针 / 请求服务端
      const roundtripsBefore = office.roundtrips.length
      const tab2 = await context.newPage()
      row.reopenMs = await openEditor(tab2, url)
      row.reopenRoundtrips = office.roundtrips.length - roundtripsBefore
      await tab2.close()
      row.pageErrors = errors.slice(0, 3)
    } catch (error) {
      row.state = 'error'
      row.note = String(error.message ?? error).split('\n')[0].slice(0, 200)
    } finally {
      await context.close()
      delete process.env.KB_SAMPLE_DOCX
    }
    const editNote = row.edit ? (row.edit.error ? row.edit.error : `edit→${[...row.edit.parts.changed, ...row.edit.parts.removed, ...row.edit.parts.added].join('|') || '无'}${row.edit.textOk ? '' : ' 文字不对'}${row.edit.lostShapes.length ? ` 丢形状${row.edit.lostShapes.join('/')}` : ''}`) : ''
    const flagText = [`#${row.index}`, row.name, `${(row.size / 1024).toFixed(0)}KB`, row.state, row.openMs ? `${row.openMs}ms` : '', row.state === 'blocked' ? row.concern.slice(0, 70) : '', editNote, row.reopenMs ? `reopen=${row.reopenMs}ms/${row.reopenRoundtrips}次检查` : '', row.note]
    console.log(flagText.filter(Boolean).join('  '))
  }
} finally {
  await browser.close()
  server.close()
}

/* ---------------- 判定 ---------------- */
const problems = []
for (const row of results) {
  if (row.state === 'error') problems.push(`${row.name}：${row.note}`)
  if (row.edit?.error) problems.push(`${row.name}：${row.edit.error}`)
  if (row.edit && !row.edit.error) {
    // 页面放开编辑的文件，改一个词之后不能丢东西——这是对页面判定的独立校对
    if (row.state === 'editable' && !row.edit.textOk) problems.push(`${row.name}：判定可编辑，但改字后文字不对 ${JSON.stringify(row.edit.textDiff)}`)
    if (row.state === 'editable' && row.edit.lostShapes.length) problems.push(`${row.name}：判定可编辑，但改字后丢了图形 ${row.edit.lostShapes.join('、')}`)
    const extra = [...row.edit.parts.changed, ...row.edit.parts.removed, ...row.edit.parts.added].filter((part) => !EDITABLE_PARTS.has(part))
    if (row.state === 'editable' && extra.length) problems.push(`${row.name}：判定可编辑（说明只会改正文），但改字动了 ${extra.join('、')}`)
    if (row.state === 'force' && (!row.edit.textOk || row.edit.lostShapes.length)) problems.push(`${row.name}：「仍然编辑」的文件改字后丢内容 ${JSON.stringify(row.edit.textDiff)} ${row.edit.lostShapes.join('、')}`)
  }
  if (row.state === 'blocked') {
    const hold = row.readOnlyHolds
    if (!hold?.inputReadOnly) problems.push(`${row.name}：判定不能编辑，输入框却不是只读`)
    if (hold?.saveButton) problems.push(`${row.name}：判定不能编辑，却还有保存按钮`)
    if (hold?.replaces) problems.push(`${row.name}：判定不能编辑，却发出了 ${hold.replaces} 次保存`)
    if (!row.concern) problems.push(`${row.name}：判定不能编辑，页面没有说明原因`)
  }
  if (row.reopenRoundtrips > 0) problems.push(`${row.name}：第二次打开又请求了 ${row.reopenRoundtrips} 次服务端检查（缓存没生效）`)
}

const tally = results.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] ?? 0) + 1 }), {})
mkdirSync(resolve(ROOT, 'e2e/out'), { recursive: true })
writeFileSync(resolve(ROOT, 'e2e/out/docx-lossless.json'), JSON.stringify({ at: new Date().toISOString(), tally, problems, results }, null, 2))
const partsOf = (row) => (row.edit && !row.edit.error ? [...row.edit.parts.changed, ...row.edit.parts.removed, ...row.edit.parts.added].join('、') || '无' : '—')
const md = [
  '# Word 保存无损检查', '', `共 ${results.length} 份；${Object.entries(tally).map(([key, value]) => `${key} ${value}`).join(' / ')}`, '',
  '| # | 文件 | 大小 | 结论 | 打开 | 改一个词动了的部件 | 二次打开 |', '|---|---|---:|---|---:|---|---|',
  ...results.map((row) => `| ${row.index} | ${row.name} | ${(row.size / 1024).toFixed(0)} KB | ${row.state}${row.state === 'blocked' ? `（${row.concern}）` : ''} | ${row.openMs ?? ''} ms | ${partsOf(row)} | ${row.reopenMs ? `${row.reopenMs} ms / ${row.reopenRoundtrips} 次检查` : '—'} |`),
].join('\n')
writeFileSync(resolve(ROOT, 'e2e/out/docx-lossless.md'), `${md}\n`)

console.log(`\n结论：${Object.entries(tally).map(([key, value]) => `${key} ${value}`).join(' / ')}`)
if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('✓ Word 保存无损门禁通过')
