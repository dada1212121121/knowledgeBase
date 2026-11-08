#!/usr/bin/env node
// 编辑器阶段视觉基线：新路径在 5 个视口 × 深浅两套主题下的截图。
//
// 用法：
//   npm run build && node e2e/editor-shots.mjs --surface=text|code|pdf
//   node e2e/editor-shots.mjs --surface=code --update   # 明知道视觉变了，重写基线
//
// 产物：e2e/shots/editor-native/<surface>-<尺寸>-<dark|light>.png，以及差异图 *-diff.png。
// 旧编辑器已随 删除，这里的基线只剩统一外壳。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { contextOptions, engineSuffix, launch, pickDevices, pickEngines } from './devices.mjs'
import { installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'e2e', 'shots', 'editor-native')
const COLLECTION = 'knowledgeBase%2Finsights'
const ITEM = 'ins_8f21'
const CODE_ITEM = 'file_rs'
const PDF_ITEM = 'file_pdf'
const SIZES = ['390x844', '820x1180', '1180x820', '1440x900', '1920x1080']
const THEMES = ['dark', 'light']
// 允许的抗锯齿 / 字体栅格差异；超过 1% 视为视觉回归
const MAX_DIFF_RATIO = 0.01

function parseArgs(argv) {
  const args = { surface: 'text', update: false }
  for (const arg of argv) {
    if (arg.startsWith('--surface=')) args.surface = arg.slice('--surface='.length)
    if (arg === '--update') args.update = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!['text', 'code', 'pdf'].includes(args.surface)) {
  console.error(`editor-shots: 只支持 --surface=text|code|pdf（收到 ${args.surface}）`)
  process.exit(2)
}
// PDF 用 50 页样本：单页样本看不出虚拟化 / 页码 / 缩略图的真实排布
if (args.surface === 'pdf') process.env.KB_SAMPLE_PDF = join(ROOT, 'e2e/fixtures/pdf-50p.pdf')

async function openNative(tab, base) {
  const item = args.surface === 'code' ? CODE_ITEM : args.surface === 'pdf' ? PDF_ITEM : ITEM
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${item}`, { waitUntil: 'domcontentloaded' })
  // 只有 Markdown 阅读页用 .kb-dp；代码 / PDF 的文件页不渲染 DocPage
  if (args.surface === 'text') await tab.waitForSelector('.kb-dp', { timeout: 20_000 })
  if (args.surface !== 'pdf') await tab.getByRole('button', { name: /^编辑$/ }).first().click()
  const ready = args.surface === 'code' ? '[data-testid="editor-host"] .kb-ce .cm-content' : args.surface === 'pdf' ? '[data-testid="editor-host"] .kb-pv .textLayer span' : '[data-testid="editor-host"] .kb-text-prose'
  await tab.waitForSelector(ready, { timeout: 30_000 })
  // 字体与渲染首帧都稳定后再截；右栏目录/状态栏也会在这一拍就位
  await tab.evaluate(() => document.fonts?.ready)
  await tab.waitForTimeout(250)
}

async function compare(name, buffer) {
  const file = join(OUT, `${name}.png`)
  if (args.update || !existsSync(file)) {
    await writeFile(file, buffer)
    return args.update ? 'updated' : 'created'
  }
  const baseline = PNG.sync.read(await readFile(file))
  const actual = PNG.sync.read(buffer)
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    await writeFile(join(OUT, `${name}-diff.png`), buffer)
    return `尺寸变化 ${baseline.width}x${baseline.height} → ${actual.width}x${actual.height}`
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height })
  const changed = pixelmatch(baseline.data, actual.data, diff.data, baseline.width, baseline.height, {
    threshold: 0.12,
    includeAA: false,
  })
  const ratio = changed / (baseline.width * baseline.height)
  if (ratio > MAX_DIFF_RATIO) {
    await writeFile(join(OUT, `${name}-actual.png`), buffer)
    await writeFile(join(OUT, `${name}-diff.png`), PNG.sync.write(diff))
    return `${(ratio * 100).toFixed(2)}% 像素变化（阈值 ${MAX_DIFF_RATIO * 100}%）`
  }
  return null
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const devices = pickDevices({ sizes: SIZES.join(',') })
  const engines = pickEngines()
  const { server, base } = await startStaticServer()
  let failed = 0
  try {
    for (const engine of engines) {
      const browser = await launch(engine)
      for (const device of devices) {
        for (const theme of THEMES) {
          const context = await browser.newContext(
            contextOptions(device, engine, {
              locale: 'zh-CN',
              colorScheme: theme,
            }),
          )
          await installFixture(context, SOLO_EDIT_FIXTURE)
          const tab = await context.newPage()
          const errors = []
          tab.on('pageerror', (error) => errors.push(error.message))
          const name = `${args.surface}-${device.name}-${theme}${engineSuffix(engine)}`
          try {
            await openNative(tab, base)
            await tab.evaluate((value) => {
              document.documentElement.setAttribute('data-theme', value)
              document.documentElement.setAttribute('data-tone', value)
            }, theme)
            // 主题切换有 120ms 的颜色过渡；截在过渡中会让基线每次都不一样
            await tab.waitForTimeout(260)
            const result = await compare(name, await tab.screenshot({ animations: 'disabled' }))
            if (result && result !== 'created' && result !== 'updated') {
              failed += 1
              console.log(`✗ [${engine}] ${name} ${result}`)
            } else {
              console.log(`✓ [${engine}] ${name}${result ? ` (${result})` : ''}`)
            }
            if (errors.length) {
              failed += 1
              console.log(`  ⚠ 页面异常：${errors.join(' | ')}`)
            }
          } catch (error) {
            failed += 1
            console.log(`✗ [${engine}] ${name} ${error.message}`)
          }
          await context.close()
        }
      }
      await browser.close()
    }
  } finally {
    server.close()
  }
  if (failed) {
    console.log(`\n${failed} 张截图未通过；确认视觉变化符合预期后加 --update 重写基线`)
    process.exit(1)
  }
  console.log(args.update ? '\n✓ 视觉基线已更新' : '\n✓ 视觉基线全部在阈值内')
}

void main()
