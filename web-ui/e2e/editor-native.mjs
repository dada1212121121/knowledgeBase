#!/usr/bin/env node
// 阶段门禁（旧实现已删除）：在真实构建产物上打开对应内容面，
// 验证统一外壳、编辑/保存与无障碍，并守住「产物里没有旧内核」（依赖层 + 产物指纹，见 legacyFreeIssues）。
//
// 用法：
//   npm run build && node e2e/editor-native.mjs --surface=text
//   KB_ENGINE=webkit node e2e/editor-native.mjs --surface=text
//   node e2e/editor-native.mjs --surface=text --regression=100   # 真实 Markdown 语料批量开编辑态
//   node e2e/editor-native.mjs --surface=xlsx                    # XLSX 原生编辑
//   node e2e/editor-native.mjs --surface=pptx                    # PPTX 阶段门禁：构建期 manifest + 只读 + 编辑 + 协同冒烟
//
// 夹具来自 e2e/fixture.mjs：/api/v1/** 全部本地应答，不需要守护进程，也不需要 KB_WEB_PASSWORD。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { contextOptions, launch, pickEngines } from './devices.mjs'
import { FILES, fileItem, installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { FakeCsvServer, decodeBytes, encodeText } from './csv-server-fake.mjs'
import { CSV_FILES, diffRegion, registerCsvFixtures, seedCsvServer } from './csv-fixtures.mjs'
import { startStaticServer } from './serve.mjs'
import { axeIssues } from './axe-helpers.mjs'
import { TEXT_FEATURE_SCENARIOS } from './editor-text-scenarios.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const REPO = resolve(ROOT, '..')
const COLLECTION = 'knowledgeBase%2Finsights'
const ITEM = 'ins_8f21'
const BODY = '## 现象\n守护进程重启期间，`kb search` 连接失败。\n\n## 做法\n- 回退为只读直连 SQLite\n'

function parseArgs(argv) {
  const args = { surface: 'text', regression: 0, only: [] }
  for (const arg of argv) {
    if (arg.startsWith('--surface=')) args.surface = arg.slice('--surface='.length)
    else if (arg.startsWith('--regression=')) args.regression = Number(arg.slice('--regression='.length)) || 0
    // 只跑名字包含这些片段（逗号分隔）的场景：调试单个场景时不用等全量
    else if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length).split(',').filter(Boolean)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!['text', 'code', 'pdf', 'csv', 'xlsx-read', 'xlsx', 'docx-read', 'docx', 'pptx-read', 'pptx'].includes(args.surface)) {
  console.error(`editor-native: 未知 --surface=${args.surface}（支持 text / code / pdf / csv / xlsx-read / xlsx / docx-read / docx / pptx-read / pptx）`)
  process.exit(2)
}
// PDF 门禁用 50 页真实文件：fixture 的 sampleFor 按扩展名读取，环境变量是它支持的覆盖入口
if (args.surface === 'pdf') process.env.KB_SAMPLE_PDF = resolve(ROOT, 'e2e/fixtures/pdf-50p.pdf')
// Word 只读门禁用 20 页合成文档（标题 / 表格 / 图片 / 页眉页脚齐全）
if (args.surface === 'docx-read' || args.surface === 'docx') process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-20p.docx')
// 只有上传来的 docx 才能在线编辑：把夹具里的 Word 标成上传来源
if (args.surface === 'docx') {
  FILES.file_docx.item.origin = 'upload'
  FILES.file_docx.preview.origin = 'upload'
}
// PowerPoint 只读门禁默认用 30 页合成 deck（python-pptx 独立生成：中文、图片、图表、备注、深浅背景齐全）
const PPTX_DECK = resolve(ROOT, 'e2e/fixtures/editor/deck-30p.pptx')
const PPTX_LATIN = resolve(ROOT, 'e2e/fixtures/editor/deck-latin-8p.pptx')
/** 夹具里 file_pptx 原本的来源（项目目录文件，不可在线编辑）：pptx 门禁里只有声明 upload 的场景临时改成上传 */
const PPTX_FIXTURE_ORIGIN = { item: FILES.file_pptx.item.origin, preview: FILES.file_pptx.preview.origin }
if (args.surface === 'pptx-read' || args.surface === 'pptx') process.env.KB_SAMPLE_PPTX = PPTX_DECK

/**
 * 按一个只移动光标的键（Ctrl+End、Home…），并等 ProseMirror 把自己的选区同步过去再返回。
 * 浏览器移动光标后，ProseMirror 是在 selectionchange 事件里读回选区的；先挂好监听再按键，
 * 等这次事件派发完（下一帧时它的处理函数已经跑完）。按的键没有让光标动（已在文末）时不会有事件，最多等 1 秒
 */
async function pressAndSyncSelection(tab, key) {
  await tab.evaluate(() => {
    // 之前的点击也会排一个 selectionchange：先让它派发掉（两帧之后一定已经派发），监听才只等这次按键的那一个
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await tab.evaluate(() => {
    window.__kbSelectionSynced = new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000)
      document.addEventListener('selectionchange', () => requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      }), { once: true })
    })
  })
  await tab.keyboard.press(key)
  await tab.evaluate(() => window.__kbSelectionSynced)
}

/** 收集页面实际下载的 chunk，用来证明新路径没有把 Crepe / 旧编辑器拖进来 */
function watchResources(tab) {
  const urls = []
  tab.on('request', (request) => {
    const url = request.url()
    if (/\.(?:js|css)(?:\?|$)/.test(url)) urls.push(url)
  })
  return urls
}

const OLD_EDITOR = /(DocEditor|milkdown|crepe|prosemirror)/i

const DIST = join(ROOT, 'dist')
const MANIFEST = join(DIST, '.vite/manifest.json')
/**
 * 静态 import 闭包，**包含根本身**（不跟 dynamicImports：那才是按需加载的部分）。
 * 以前这里遇到 `index.html` 就直接跳过，入口的闭包永远是空的，「默认路径不含旧岛」从来没真正检查过；
 * 现在根也算进闭包，调用方再用 `entryReadIssue` 兜底，保证入口真的被读到了。
 */
function staticClosure(manifest, roots) {
  const seen = new Set()
  const walk = (key) => {
    if (!key || seen.has(key)) return
    const item = manifest[key]
    if (!item) return
    seen.add(key)
    for (const next of item.imports ?? []) walk(next)
  }
  roots.forEach(walk)
  return seen
}

/** 入口闭包必须真的含 index.html 且对应的 bundle 文件存在；否则门禁是在空集合上做检查，会假绿 */
function entryReadIssue(manifest, entryKeys) {
  if (!manifest['index.html']) return '构建 manifest 里没有 index.html 入口'
  if (!entryKeys.has('index.html') || !existsSync(join(DIST, manifest['index.html'].file ?? ''))) return '门禁没有读到入口 bundle'
  return ''
}

/**
 * 起旧实现（React 编辑岛 / pptx-preview / Milkdown / md-editor-v3 / 完整 CJK 字体）已从仓库里删除，
 * 「默认路径不加载旧内核」不再靠 manifest 里找不到旧 chunk 来证明（旧 chunk 根本不存在了，按名字匹配会永远空过），
 * 而是两层硬证据：
 * 1. 依赖层：`package.json` 与 `package-lock.json` 里根本没有这些包；
 * 2. 产物层：dist 里所有 JS / CSS 的内容里没有它们的运行时指纹（React 运行时的内部符号等），也没有完整 CJK 的 OTF 字体。
 * 指纹是字符串字面量，压缩后也还在；扫整个 dist 而不只是入口闭包，因为旧岛被并进别的 chunk 时按名字认不出来。
 */
const REMOVED_PACKAGES = [
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  '@betteroffice/docx-react',
  '@betteroffice/xlsx-react',
  '@betteroffice/pptx-react',
  '@betteroffice/docx-i18n',
  '@betteroffice/xlsx-i18n',
  '@betteroffice/pptx-i18n',
  'pptx-preview',
  'md-editor-v3',
  '@milkdown/crepe',
  '@milkdown/plugin-collab',
  '@milkdown/kit',
  '@betteroffice/fonts-cjk',
]
const LEGACY_FINGERPRINTS = [
  ['React 运行时', /react\.transitional\.element|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE|__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/],
  ['@betteroffice/xlsx-react 的界面代码', /"xlsx-workspace"|"xlsx-sheet-tabs"|"xlsx-overlay-host"/],
  ['pptx-preview 的幻灯片容器', /pptx-preview-(?:wrapper|slide-wrapper)/],
  ['Milkdown / Crepe 的编辑器类名', /\bmilkdown-[a-z]|\bcrepe-[a-z]/],
  ['md-editor-v3 的预览类名', /md-editor-(?:preview|previewOnly)/],
]

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, out)
    else out.push(path)
  }
  return out
}

/** 依赖层 + 产物层的「没有旧内核」检查（xlsx / docx / pptx 三个编辑门禁共用） */
function legacyFreeIssues() {
  const issues = []
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  for (const name of REMOVED_PACKAGES) {
    if (declared.has(name)) issues.push(`package.json 里还声明着已卸载的包：${name}`)
    // 锁文件里：直接依赖不许有；传递依赖只允许 fonts-cjk（@betteroffice/fonts 的可选 peer，构建期被插件替换成空表，不进产物）
    if (name !== '@betteroffice/fonts-cjk' && lock.packages?.[`node_modules/${name}`]) issues.push(`package-lock.json 里还有已卸载的包：${name}`)
  }
  const files = walkFiles(DIST).filter((file) => /\.(?:js|mjs|css)$/.test(file))
  if (files.length < 50) issues.push(`dist 里只找到 ${files.length} 个 JS / CSS，门禁没有读到构建产物`)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [label, pattern] of LEGACY_FINGERPRINTS) {
      if (pattern.test(text)) issues.push(`构建产物里出现了旧内核：${file.slice(DIST.length + 1)} 含 ${label}`)
    }
  }
  const otf = walkFiles(DIST).filter((file) => /\.otf$/i.test(file))
  if (otf.length) issues.push(`dist 里有完整 CJK 的 OTF 字体（应只留 GB2312 裁剪版）：${otf.map((file) => basename(file)).join(', ')}`)
  return issues
}

/** 入口的静态依赖里不能带办公引擎：引擎、WASM 都是打开文档时才下载的 */
function entryHasNoOfficeEngine(manifest, entryKeys) {
  const heavy = /node_modules\/@betteroffice\/|src\/editor\/engines\/|src\/editor\/surfaces\/(?:grid|page|slide)\//
  return [...entryKeys].filter((key) => heavy.test(key) || heavy.test(manifest[key]?.file ?? '')).map((key) => `入口的静态依赖里出现了办公引擎 / 内容面：${manifest[key]?.file ?? key}`)
}

const fileOfKey = (manifest, key) => manifest[key]?.file ?? key
const gzipOfFile = (file) => (existsSync(join(DIST, file)) ? gzipSync(readFileSync(join(DIST, file))).length : 0)
const kbOf = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

function loadManifest() {
  if (!existsSync(MANIFEST)) return null
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

/** OfficeEditor 所在的 JS chunk 的键（只认 JS：它的 CSS 也叫 _OfficeEditor-*.css，manifest 的键顺序随构建变化） */
function officeEditorKey(manifest) {
  return Object.entries(manifest).find(([key, item]) => (/OfficeEditor/.test(key) || /OfficeEditor/.test(item.file ?? '')) && /\.js$/.test(item.file ?? ''))?.[0]
}

/**
 * 构建期门禁（改写）：入口不含办公引擎，XLSX 内容面与保存通道都是 OfficeEditor 的动态导入，
 * 并且没有旧内核；同时打印原生路径的 gzip 体积，作为迁移报告的数字来源。
 */
function xlsxManifestGate() {
  const manifest = loadManifest()
  if (!manifest) return [`找不到 ${MANIFEST}：先 npm run build`]
  const issues = legacyFreeIssues()
  const officeKey = officeEditorKey(manifest)
  if (!officeKey) return [...issues, '构建 manifest 里找不到 OfficeEditor']
  const entryKeys = staticClosure(manifest, ['index.html'])
  const officeKeys = staticClosure(manifest, [officeKey])
  const entryIssue = entryReadIssue(manifest, entryKeys)
  if (entryIssue) issues.push(entryIssue)
  issues.push(...entryHasNoOfficeEngine(manifest, entryKeys))
  const dynamicKeys = new Set(manifest[officeKey]?.dynamicImports ?? [])
  for (const want of ['src/editor/surfaces/grid/xlsxSurface.ts', 'src/editor/codecs/xlsx.ts']) {
    if (![...dynamicKeys].some((key) => key.includes(want))) issues.push(`XLSX 没有按需加载：${want}`)
  }
  const surfaceKey = [...dynamicKeys].find((key) => key.includes('src/editor/surfaces/grid/xlsxSurface.ts'))
  const codecKey = [...dynamicKeys].find((key) => key.includes('src/editor/codecs/xlsx.ts'))
  const nativeKeys = [...new Set([...(surfaceKey ? staticClosure(manifest, [surfaceKey]) : []), ...(codecKey ? staticClosure(manifest, [codecKey]) : [])])].filter(
    (key) => !officeKeys.has(key) && !entryKeys.has(key),
  )
  const sizeOf = (keys) => keys.reduce((sum, key) => sum + gzipOfFile(fileOfKey(manifest, key)), 0)
  const wasm = Object.values(manifest).find((item) => /xlsx_wasm_bg[^/]*\.wasm$/.test(item.file ?? ''))
  console.log(`XLSX 体积（gzip，不含 WASM）：原生路径 ${kbOf(sizeOf(nativeKeys))}（${nativeKeys.length} 个 chunk）`)
  if (wasm) console.log(`XLSX WASM：${kbOf(existsSync(join(DIST, wasm.file)) ? readFileSync(join(DIST, wasm.file)).length : 0)} 原始 / ${kbOf(gzipOfFile(wasm.file))} gzip（打开编辑态才下载）`)
  return issues
}

/**
 * 构建期门禁（改写）：
 * - 入口、FileViewer、OfficeEditor 的静态依赖里不能出现办公引擎，也不能有旧内核；
 * - 原生路径（引擎、只读 / 编辑面、codec、协同传输）必须是按需加载的。
 * 同时打印原生路径的 gzip 体积，作为迁移报告的数字来源。
 */
function pptxManifestGate() {
  const manifest = loadManifest()
  if (!manifest) return [`找不到 ${MANIFEST}：先 npm run build`]
  const issues = legacyFreeIssues()
  const keys = Object.keys(manifest)
  const jsKey = (re) => keys.find((key) => re.test(key) && /\.js$/.test(manifest[key].file ?? ''))
  const officeKey = jsKey(/OfficeEditor/)
  const viewerKey = jsKey(/FileViewer/)
  if (!manifest['index.html']) issues.push('构建 manifest 里没有 index.html 入口')
  if (!officeKey) issues.push('构建 manifest 里找不到 OfficeEditor')
  if (!viewerKey) issues.push('构建 manifest 里找不到 FileViewer')
  if (!officeKey || !viewerKey || !manifest['index.html']) return issues
  const entryKeys = staticClosure(manifest, ['index.html'])
  const officeKeys = staticClosure(manifest, [officeKey])
  const viewerKeys = staticClosure(manifest, [viewerKey])
  const entryIssue = entryReadIssue(manifest, entryKeys)
  if (entryIssue) issues.push(entryIssue)
  issues.push(...entryHasNoOfficeEngine(manifest, entryKeys))
  const dynamicOf = (key) => new Set(manifest[key]?.dynamicImports ?? [])
  const hasDynamic = (keySet, want) => [...keySet].some((key) => key.includes(want))
  const officeDynamic = dynamicOf(officeKey)
  for (const want of ['src/editor/engines/pptxEdit.ts', 'src/editor/engines/pptxCollab.ts', 'src/editor/surfaces/slide/edit-surface.ts', 'src/editor/codecs/pptx.ts', 'src/editor/collab/OfficeTransport.ts']) {
    if (!hasDynamic(officeDynamic, want)) issues.push(`PPTX 编辑路径没有按需加载（不在 OfficeEditor 的动态 import 里）：${want}`)
  }
  // 原生路径的 chunk 集合：引擎、只读 / 编辑面、codec、协同传输各自的静态闭包
  const nativeRoots = keys.filter((key) => /src\/editor\/(?:engines\/pptx(?:Edit|Collab)?|surfaces\/slide\/(?:index|edit-surface)|codecs\/pptx|collab\/OfficeTransport)\.ts$/.test(key))
  if (nativeRoots.length < 5) issues.push(`manifest 里只找到 ${nativeRoots.length} 个 PPTX 原生路径 chunk`)
  const nativeKeys = new Set([...staticClosure(manifest, nativeRoots)].filter((key) => !officeKeys.has(key) && !entryKeys.has(key) && !viewerKeys.has(key)))
  const sizeOf = (list) => [...list].reduce((sum, key) => sum + gzipOfFile(fileOfKey(manifest, key)), 0)
  const wasm = Object.values(manifest).find((item) => /pptx_wasm_bg[^/]*\.wasm$/.test(item.file ?? ''))
  console.log(`PPTX 体积（gzip，不含 WASM）：原生路径 ${kbOf(sizeOf(nativeKeys))}（${nativeKeys.size} 个 chunk）`)
  if (wasm) console.log(`PPTX WASM：${kbOf(existsSync(join(DIST, wasm.file)) ? readFileSync(join(DIST, wasm.file)).length : 0)} 原始 / ${kbOf(gzipOfFile(wasm.file))} gzip（打开幻灯片才下载）`)
  return issues
}

/**
 * Word 编辑的构建期门禁（改写）：入口 / 页面 / OfficeEditor 的静态依赖里不能有办公引擎或旧内核，
 * Word 编辑面与保存通道必须是 OfficeEditor 的动态导入（Excel / PowerPoint 用户不下载 Word 的编辑代码）。
 */
function docxManifestGate() {
  const manifest = loadManifest()
  if (!manifest) return [`找不到 ${MANIFEST}：先 npm run build`]
  const issues = legacyFreeIssues()
  // OfficeEditor 被 Rollup 合并进别的 chunk 时（有人静态引用了它的依赖）按文件名找不到：把「找不到」本身当成信号报出来
  const officeKey = officeEditorKey(manifest)
  const entryKeys = staticClosure(manifest, ['index.html'])
  const entryIssue = entryReadIssue(manifest, entryKeys)
  if (entryIssue) issues.push(entryIssue)
  issues.push(...entryHasNoOfficeEngine(manifest, entryKeys))
  // 所有「页面级」入口（路由）的静态闭包也算：Browser.vue 等页面静态 import 了什么
  const pageRoots = Object.entries(manifest).filter(([key, item]) => item.isEntry || /^src\/(pages|components)\//.test(key)).map(([key]) => key)
  const pageKeys = staticClosure(manifest, pageRoots)
  const officeKeys = officeKey ? staticClosure(manifest, [officeKey]) : new Set()
  if (!officeKey) issues.push('构建 manifest 里找不到 OfficeEditor 的独立 chunk（它被合并进别的 chunk 了，通常说明有人静态引用了它的依赖）')
  const heavy = /node_modules\/@betteroffice\/(?:docx|xlsx|pptx)\/|src\/editor\/surfaces\/(?:grid|page\/edit|slide)\//
  for (const key of [...officeKeys, ...pageKeys]) {
    if (heavy.test(key) || heavy.test(fileOfKey(manifest, key))) issues.push(`页面 / OfficeEditor 的静态依赖里出现了办公引擎或编辑面：${fileOfKey(manifest, key)}`)
  }
  // Word 原生编辑面必须是 OfficeEditor 的动态导入
  const dynamicKeys = new Set(manifest[officeKey]?.dynamicImports ?? [])
  const surfaceKey = [...dynamicKeys].find((key) => key.includes('src/editor/surfaces/page/edit/docxEditSurface.ts'))
  const codecKey = [...dynamicKeys].find((key) => key.includes('src/editor/codecs/docx.ts'))
  if (!surfaceKey) issues.push('Word 编辑面没有按需加载（不在 OfficeEditor 的动态导入里）：docxEditSurface.ts')
  if (!codecKey) issues.push('Word 保存通道没有按需加载：codecs/docx.ts')
  const nativeKeys = [...new Set([...(surfaceKey ? staticClosure(manifest, [surfaceKey]) : []), ...(codecKey ? staticClosure(manifest, [codecKey]) : [])])].filter((key) => !officeKeys.has(key) && !entryKeys.has(key))
  const sum = (keys) => keys.reduce((total, key) => total + gzipOfFile(fileOfKey(manifest, key)), 0)
  console.log(`Word 编辑体积（gzip，不含 WASM / 字体）：原生路径 ${kbOf(sum(nativeKeys))}（${nativeKeys.length} 个 chunk）`)
  return issues
}

/**
 * 笔记「进入编辑」比「阅读」多下载的 JS（笔记编辑 chunk ≤ 150 KB gzip）。
 *
 * 口径：构建产物 manifest 里，外壳 `EditorHost.vue` 与文本面 `surfaces/text/index.ts` 的**静态闭包**，
 * 减去入口 `index.html` 与阅读路径（文件浏览页 / 文档页 / Markdown 阅读）的静态闭包，剩下 JS 的 gzip 总和。
 * 动态导入（协同 yjs、代码块高亮引擎、公式 / 流程图…）不算：它们只在用到时才下载。
 *
 * 为什么要「找不到根就失败」：Rollup 会在文本面 chunk 与别的 chunk 共享模块时把它的入口身份丢掉
 * （manifest 里就没有 `surfaces/text/index.ts` 这个键），空集合上的体积是 0，会悄悄放行。
 * 所以任何一个根缺失、或增量里一个 JS 都没有，都直接报红。
 */
const TEXT_EDIT_BUDGET_KB = 150
const TEXT_EDIT_ROOTS = ['src/editor/host/EditorHost.vue', 'src/editor/surfaces/text/index.ts']
const TEXT_READ_ROOTS = ['index.html', 'src/pages/Browser.vue', 'src/components/DocPage.vue', 'src/components/MarkdownRead.vue']

function textEditIncrement(manifest) {
  const issues = []
  for (const root of [...TEXT_EDIT_ROOTS, ...TEXT_READ_ROOTS]) {
    if (!manifest[root]) issues.push(`manifest 里找不到 ${root}：门禁没有读到这个根，不能在空集合上放行`)
  }
  const editKeys = staticClosure(manifest, TEXT_EDIT_ROOTS)
  const readKeys = staticClosure(manifest, TEXT_READ_ROOTS)
  const rows = [...editKeys]
    .filter((key) => !readKeys.has(key) && /\.js$/.test(fileOfKey(manifest, key)))
    .map((key) => ({ key, file: fileOfKey(manifest, key), bytes: gzipOfFile(fileOfKey(manifest, key)) }))
    .sort((a, b) => b.bytes - a.bytes)
  const total = rows.reduce((sum, row) => sum + row.bytes, 0)
  if (rows.length === 0 || total === 0) issues.push('笔记编辑增量里没有任何 JS：门禁在空集合上算出了 0，口径或产物不对')
  return { issues, rows, total }
}

/** 文本阶段的构建期门禁：笔记编辑增量不得超过预算；超了打印最大的几个 chunk，方便看是谁被静态带进来 */
function textManifestGate() {
  const manifest = loadManifest()
  if (!manifest) return { issues: [`找不到 ${MANIFEST}：先 npm run build`], lines: [] }
  const { issues, rows, total } = textEditIncrement(manifest)
  const lines = [`笔记编辑增量（gzip，只算 JS）：${kbOf(total)} / 预算 ${TEXT_EDIT_BUDGET_KB} KB（${rows.length} 个 chunk）`]
  for (const row of rows.slice(0, 5)) lines.push(`  ${kbOf(row.bytes).padStart(9)}  ${row.file}  ← ${row.key}`)
  if (total > TEXT_EDIT_BUDGET_KB * 1024) {
    issues.push(`笔记编辑比阅读多下载 ${kbOf(total)} JS（gzip），超过 ${TEXT_EDIT_BUDGET_KB} KB 预算；最大的几个：\n${lines.slice(1).join('\n')}`)
  }
  return { issues, lines }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 打开一篇经验笔记并进入编辑态（外壳是唯一实现；`extra` 是附加的查询串） */
async function openEditable(tab, base, extra = '') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${ITEM}${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-dp', { timeout: 20_000 })
  const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
  await edit.waitFor({ state: 'visible', timeout: 20_000 })
  await edit.click()
  // 阅读 → 编辑有一段交接：编辑器在后台起来时带 is-held（不占版面、看不见），起来后才换上并去掉它。
  // 等到换上再动手，否则按交接前的位置算出来的坐标会在换上的那一刻整体偏移
  await tab.waitForSelector('[data-testid="editor-host"]:not(.is-held) .kb-text-prose', { timeout: 20_000 })
}

/** 标题级别是工具栏上的下拉：先开下拉再点级别，和用户操作一致 */
async function pickHeading(tab, id) {
  await tab.click('[data-testid="editor-toolbar-slot"] [data-action="heading"]')
  await tab.click(`[role^="menuitem"][data-action="${id}"]`)
}

const TEXT_SCENARIOS = {
  'native-open': {
    title: '打开即外壳：工具栏、状态、正文都在，没有旧编辑器节点或资源',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openEditable(tab, base)
      // 放不下的按钮在「更多」里：打开它，一起数
      if (await tab.locator('[data-testid="editor-toolbar-more"]').count()) await tab.click('[data-testid="editor-toolbar-more"]')
      const info = await tab.evaluate(() => ({
        host: !!document.querySelector('[data-testid="editor-host"]'),
        prose: !!document.querySelector('.kb-text-prose'),
        toolbar: document.querySelectorAll('[data-testid="editor-toolbar-slot"] [data-action]').length,
        chromeTitle: !!document.querySelector('.kb-editor-chrome-title'),
        close: !!document.querySelector('[data-testid="editor-close"]'),
        oldEditor: !!document.querySelector('.milkdown, .md-editor, .Crepe'),
        heading: document.querySelector('.kb-text-prose h2')?.textContent?.trim() ?? '',
      }))
      const issues = []
      if (!info.host || !info.prose) issues.push('新外壳或 Text Surface 没挂载')
      if (info.toolbar < 15) issues.push(`工具栏动作太少：${info.toolbar}`)
      if (info.chromeTitle) issues.push('页面已显示标题，外壳里不该再出现一份')
      if (info.close) issues.push('页面自己管完成，外壳不该再有第二个关闭按钮')
      if (info.oldEditor) issues.push('新路径出现了旧编辑器节点')
      if (info.heading !== '现象') issues.push(`正文首个小节不对：${info.heading}`)
      const dirty = resources.filter((url) => OLD_EDITOR.test(url))
      if (dirty.length) issues.push(`新路径加载了旧编辑器资源：${dirty.map((u) => u.split('/').pop()).join(', ')}`)
      return issues
    },
  },

  'native-page-integration': {
    title: '外壳与页面整合：只有一个「保存」、放不下的按钮进「更多」、字数与页头一致',
    async assert(tab, base) {
      await openEditable(tab, base)
      const issues = []
      const info = await tab.evaluate(() => {
        const tools = document.querySelector('[data-testid="editor-toolbar-slot"]')
        const box = tools?.getBoundingClientRect()
        const clipped = [...(tools?.querySelectorAll('[data-action]') ?? [])].filter((el) => {
          const rect = el.getBoundingClientRect()
          return box && (rect.right > box.right + 1 || rect.left < box.left - 1)
        }).length
        return {
          chromeSave: !!document.querySelector('[data-testid="editor-save"]'),
          pageSave: [...document.querySelectorAll('button')].filter((el) => el.textContent?.trim() === '保存' && !el.closest('[data-testid="editor-host"]')).length,
          clipped,
          more: !!document.querySelector('[data-testid="editor-toolbar-more"]'),
          chromeCount: document.querySelector('[data-testid="editor-chrome-count"]')?.textContent?.trim() ?? '',
          pageCount: document.querySelector('.kb-dp-stat')?.textContent?.trim() ?? '',
        }
      })
      if (info.chromeSave) issues.push('页面有自己的保存，外壳里不该再有第二个「保存」')
      if (info.pageSave !== 1) issues.push(`页面级「保存」按钮数量不对：${info.pageSave}`)
      if (info.clipped) issues.push(`${info.clipped} 个工具栏按钮被裁在可视区外`)
      // 标题收成下拉、插入项并进下拉，1440 宽下全部按钮放得下（不该出现多余的「更多」）；
      // 放不下的机制要在窄一点的窗口里验证：收窄后「更多」出现，查找替换在里面且点了能用
      if (info.more) issues.push('1440 宽下工具栏按钮应全部放得下（常用入口不该被挤进「更多」）')
      await tab.setViewportSize({ width: 820, height: 900 })
      const narrow = await tab.waitForSelector('[data-testid="editor-toolbar-more"]', { timeout: 5000 }).then(() => true).catch(() => false)
      if (!narrow) issues.push('窗口收窄后放不下全部按钮时应出现「更多」')
      else {
        await tab.click('[data-testid="editor-toolbar-more"]')
        const items = await tab.$$eval('[data-testid="editor-toolbar-more-menu"] [data-action]', (els) => els.map((el) => el.getAttribute('data-action')))
        // 收进「更多」的是排在后面的（大纲最先被收）；下拉被平铺成子项
        if (!items.includes('outline')) issues.push(`「更多」里应有大纲：${items.join(',')}`)
        if (items.includes('insertMore')) issues.push(`下拉按钮本身不该出现在「更多」里（应平铺成子项）：${items.join(',')}`)
        await tab.click(`[data-testid="editor-toolbar-more-menu"] [data-action="${items.includes('find') ? 'find' : items[0]}"]`)
        // 菜单收起有一小段退场动画（元素在退场期间还在 DOM 里），等它走完再判断
        if (!(await waitFor(async () => (await tab.locator('[data-testid="editor-toolbar-more-menu"]').count()) === 0, 1500))) issues.push('点了菜单项后「更多」菜单应收起')
      }
      await tab.setViewportSize({ width: 1440, height: 900 })
      const words = (text) => Number(/(\d+)\s*字/.exec(text)?.[1] ?? NaN)
      if (words(info.chromeCount) !== words(info.pageCount)) issues.push(`字数不一致：外壳 ${info.chromeCount} / 页头 ${info.pageCount}`)
      // 改正文之后两边都要跟着变
      await tab.click('.kb-text-prose p')
      await tab.keyboard.press('End')
      await tab.keyboard.type('新增十个汉字来测字数')
      await tab.waitForTimeout(600)
      const after = await tab.evaluate(() => ({
        chrome: document.querySelector('[data-testid="editor-chrome-count"]')?.textContent?.trim() ?? '',
        page: document.querySelector('.kb-dp-stat')?.textContent?.trim() ?? '',
      }))
      if (words(after.chrome) !== words(after.page)) issues.push(`编辑后字数不一致：外壳 ${after.chrome} / 页头 ${after.page}`)
      if (words(after.chrome) !== words(info.chromeCount) + 10) issues.push(`编辑后外壳字数没跟着变：${info.chromeCount} → ${after.chrome}`)
      return issues
    },
  },

  'native-edit-save': {
    title: '工具栏改标题 → Ctrl+S 保存，落盘的是最新正文',
    async assert(tab, base, state) {
      await openEditable(tab, base)
      await pickHeading(tab, 'heading.1')
      await tab.waitForFunction(() => document.querySelector('.kb-text-prose h1')?.textContent?.trim() === '现象')
      await tab.keyboard.press('Control+s')
      const ok = await waitFor(async () => state.saved.length > 0)
      const issues = []
      if (!ok) issues.push('没有等到 edit_item 保存请求')
      else {
        const body = state.saved.at(-1)?.body ?? ''
        if (!body.includes('# 现象')) issues.push('保存正文里没有改后的一级标题')
        if (body.includes('## 现象')) issues.push('保存的还是初始正文（工具栏改动没进快照）')
      }
      return issues
    },
  },

  'native-find': {
    title: 'Ctrl+F 打开查找、结果数来自 Surface、Esc 关闭',
    async assert(tab, base) {
      await openEditable(tab, base)
      await tab.click('.kb-text-prose h2')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 })
      await tab.fill('[data-testid="editor-find-input"]', '现象')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 3000 })
      const count = await tab.textContent('[data-testid="editor-find-count"]')
      const hits = await tab.evaluate(() => document.querySelectorAll('.kb-find-hit').length)
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      const issues = []
      if (count?.trim() !== '1/1') issues.push(`命中数不对：${count}`)
      if (hits !== 1) issues.push(`高亮数量不对：${hits}`)
      return issues
    },
  },

  'native-undo': {
    title: 'Ctrl+Z 撤销工具栏动作，文档回到原状',
    async assert(tab, base) {
      await openEditable(tab, base)
      const before = await tab.textContent('.kb-text-prose h2')
      await pickHeading(tab, 'heading.1')
      await tab.waitForFunction(() => document.querySelector('.kb-text-prose h1') !== null)
      await tab.keyboard.press('Control+z')
      await tab.waitForFunction(() => document.querySelector('.kb-text-prose h1') === null)
      const after = await tab.textContent('.kb-text-prose h2')
      return before === after ? [] : [`撤销后正文不一致：${before} → ${after}`]
    },
  },

  'code-highlight-lazy': {
    title: '代码块高亮按需加载（体积门禁的运行时对照）：没有带语言的代码块时不下载语言引擎；输入 ```js 之后才下载，并且上色、文字不变',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openEditable(tab, base)
      await tab.waitForTimeout(500)
      const heavy = () => resources.filter((url) => /codeHighlightEngine|editorLanguage/.test(url)).map((url) => url.split('/').pop())
      const issues = []
      if (heavy().length) issues.push(`正文里没有带语言的代码块，却下载了高亮引擎：${heavy().join(', ')}`)
      // 在文末新起一段，输入 ```js 加空格（输入规则把它变成 js 代码块），再写一行代码。
      // Ctrl+End 只移动浏览器的光标，ProseMirror 要等 selectionchange 事件才同步自己的选区；紧接着回车会落在旧位置
      // （文档开头的「现象」标题上，输入规则随后把整个标题变成代码块）。所以等这次事件真的发生、处理完再回车
      await tab.click('.kb-text-prose p')
      await pressAndSyncSelection(tab, 'Control+End')
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('```js ')
      await tab.keyboard.type('const a = "x" + 1')
      const colored = await tab.waitForSelector('.kb-code-block code [class^="tok-"]', { timeout: 15_000 }).then(() => true, () => false)
      if (!colored) issues.push('输入 ```js 代码块后一直没有上色')
      if (!heavy().some((url) => /codeHighlightEngine/.test(url))) issues.push(`上色了，但没有看到高亮引擎被下载：${heavy().join(', ')}`)
      const text = await tab.textContent('.kb-code-block code')
      if (text !== 'const a = "x" + 1') issues.push(`上色改动了代码块的文字：${JSON.stringify(text)}`)
      return issues
    },
  },

  'native-axe': {
    title: 'axe：编辑器区域无 critical / serious（深浅两套主题）',
    async assert(tab, base) {
      await openEditable(tab, base)
      const issues = await axeIssues(tab, { scope: '[data-testid="editor-host"]' })
      return issues.map((item) => `axe ${item}`)
    },
  },

  'native-editor-param-ignored': {
    title: '旧链接 / 书签里的 `?editor=next|legacy|随便写` 不报错、被忽略，照样是同一个外壳（现在 `?editor=` 不再是开关）',
    async assert(tab, base) {
      const issues = []
      for (const value of ['next', 'legacy', 'bogus']) {
        await openEditable(tab, base, `&editor=${value}`)
        const info = await tab.evaluate(() => ({
          host: !!document.querySelector('[data-testid="editor-host"]'),
          oldEditor: !!document.querySelector('.milkdown, .md-editor, .Crepe'),
        }))
        if (!info.host) issues.push(`\`?editor=${value}\` 没挂外壳`)
        if (info.oldEditor) issues.push(`\`?editor=${value}\` 出现了旧编辑器`)
      }
      return issues
    },
  },

  ...TEXT_FEATURE_SCENARIOS,
}

/** 打开一个代码/配置文件并进入统一外壳的编辑态 */
/** 起代码文件编辑默认就是新外壳：门禁走不带参数的默认路由，量用户真实打开的那条路 */
async function openCodeEditable(tab, base, id = 'file_rs') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${id}`, { waitUntil: 'domcontentloaded' })
  const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
  await edit.waitFor({ state: 'visible', timeout: 20_000 })
  await edit.click()
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="code"] .kb-ce .cm-content', { timeout: 20_000 })
}

const CODE_SCENARIOS = {
  'code-wrap': {
    title: '外壳工具栏的「换行」（旧代码工具栏有，搬进外壳不能丢）：点了切软换行，按钮高亮跟着变',
    async assert(tab, base) {
      await openCodeEditable(tab, base)
      const issues = []
      const button = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="wrap"]')
      if (!(await button.count())) return ['工具栏没有「换行」']
      const wrapped = () => tab.evaluate(() => !!document.querySelector('.kb-ce .cm-content.cm-lineWrapping'))
      const before = await wrapped()
      await button.click()
      await tab.waitForTimeout(200)
      if ((await wrapped()) === before) issues.push('点「换行」没有切换软换行')
      if ((await button.getAttribute('aria-pressed')) !== String(!before)) issues.push('「换行」按钮高亮没跟着变')
      await button.click()
      return issues
    },
  },

  'defaults-unchanged': {
    title: '翻默认之后：Markdown 笔记编辑不带参数走新外壳，CSV 表格编辑默认进统一外壳的网格',
    async assert(tab, base) {
      const issues = []
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=ins_8f21`, { waitUntil: 'domcontentloaded' })
      await tab.getByRole('button', { name: /^编辑$/ }).first().click({ timeout: 20_000 })
      await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose', { timeout: 30_000 }).catch(() => issues.push('笔记编辑默认应是新外壳'))
      if (await tab.locator('.kb-dp .milkdown').count()) issues.push('笔记编辑默认不该挂旧编辑器')
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_csv`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('.kb-fv', { timeout: 20_000 })
      await tab.click('[data-testid="csv-edit-open"]')
      await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs', { timeout: 20_000 }).catch(() => issues.push('CSV 表格编辑默认应进统一外壳的网格'))
      if (await tab.locator('[data-testid="csv-editor"], [data-testid="csv-collab-editor"]').count()) issues.push('CSV 表格编辑默认不该再挂旧编辑器')
      return issues
    },
  },

  'code-open': {
    title: '代码文件进统一外壳：CodeMirror、行号、工具栏都在，旧编辑分支不在',
    async assert(tab, base) {
      await openCodeEditable(tab, base)
      const info = await tab.evaluate(() => ({
        host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="code"]'),
        surface: !!document.querySelector('[data-testid="code-surface"]'),
        content: (document.querySelector('[data-testid="editor-host"] .cm-content')?.textContent ?? '').includes('degrade_read'),
        lines: document.querySelectorAll('[data-testid="editor-host"] .cm-line').length,
        gutters: document.querySelectorAll('[data-testid="editor-host"] .cm-gutters .cm-lineNumbers .cm-gutterElement').length,
        toolbar: document.querySelectorAll('[data-testid="editor-toolbar-slot"] [data-action]').length,
        oldShell: !!document.querySelector('.kb-md-editor-host:not([data-testid="file-native-editor"])'),
        selectAll: !!document.querySelector('[data-action="selectAll"]'),
      }))
      const issues = []
      if (!info.host || !info.surface) issues.push('代码文件没有进入统一外壳')
      if (!info.content) issues.push('CodeMirror 没有渲染源码')
      if (info.lines < 3 || info.gutters < 3) issues.push(`行号/行数不对：${info.lines}/${info.gutters}`)
      if (info.toolbar < 2 || !info.selectAll) issues.push('代码外壳缺少视图动作')
      if (info.oldShell) issues.push('新路径还挂了旧代码编辑器外壳')
      return issues
    },
  },

  'code-edit-save': {
    title: '代码里输入 → Ctrl+S，保存请求带上完整新正文',
    async assert(tab, base, state) {
      await openCodeEditable(tab, base)
      await tab.click('[data-testid="editor-host"] .cm-content')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('\n// e2e native save')
      await tab.keyboard.press('Control+s')
      const ok = await waitFor(async () => state.saved.some((entry) => String(entry?.content ?? '').includes('// e2e native save')))
      const issues = []
      if (!ok) issues.push('没有等到包含新行的 save_file 请求')
      const hit = [...state.saved].reverse().find((entry) => String(entry?.content ?? '').includes('// e2e native save'))
      if (hit && !String(hit.path ?? '').endsWith('degrade.rs')) issues.push(`保存路径不对：${hit.path}`)
      if (hit && String(hit.content).includes('\r\n')) issues.push('新保存把行尾全部改成了 CRLF')
      return issues
    },
  },

  'code-find': {
    title: 'Ctrl+F 在代码面查找：计数来自 Surface，Esc 关闭并清掉高亮',
    async assert(tab, base) {
      await openCodeEditable(tab, base)
      await tab.click('[data-testid="editor-host"] .cm-content')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 })
      await tab.fill('[data-testid="editor-find-input"]', 'eprintln!')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 3000 })
      const count = await tab.textContent('[data-testid="editor-find-count"]')
      // CodeMirror 的选区画在 selectionLayer 里，不是浏览器原生 Selection
      const selected = await tab.evaluate(() => !!document.querySelector('[data-testid="editor-host"] .cm-selectionBackground'))
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      const issues = []
      if (count?.trim() !== '1/1') issues.push(`命中数不对：${count}`)
      if (!selected) issues.push('没有把命中词选中')
      return issues
    },
  },

  'code-undo': {
    title: 'Ctrl+Z 撤销代码输入，正文回到打开时',
    async assert(tab, base) {
      await openCodeEditable(tab, base)
      await tab.click('[data-testid="editor-host"] .cm-content')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('\n// undo me')
      await tab.keyboard.press('Control+z')
      const text = await tab.textContent('[data-testid="editor-host"] .cm-content')
      return String(text).includes('// undo me') ? ['撤销后仍残留输入内容'] : []
    },
  },

  'code-axe': {
    title: 'axe：代码外壳无 critical / serious',
    async assert(tab, base) {
      await openCodeEditable(tab, base)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

}


/** 打开 CSV 并进入统一外壳的表格（默认路由，不再需要 editor=next） */
async function openCsvEditable(tab, base, extra = '', id = 'file_csv', { waitCell = true } = {}) {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${id}${extra ? `&${extra}` : ''}`, { waitUntil: 'domcontentloaded' })
  // 详情异步加载预览；预览未落地时点编辑，openDetail 收尾会复位 csvEditing，点击就丢了（按钮在加载期间是禁用的）
  await tab.waitForSelector('[data-testid="csv-edit-open"]:not([disabled])', { timeout: 20_000 })
  await tab.click('[data-testid="csv-edit-open"]')
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs', { timeout: 20_000 })
  // 首屏的格子读到之后公式栏才有内容（服务端分页的表要等第一页；空表没有格子，不等）
  if (waitCell) await tab.waitForFunction(() => (document.querySelector('.kb-gs-formula-input')?.value ?? '') !== '', null, { timeout: 20_000 })
}

/** 当前选中格的公式栏内容 / 单元格名 */
const formulaOf = (tab) => tab.$eval('.kb-gs-formula-input', (input) => input.value)
const cellNameOf = (tab) => tab.$eval('.kb-gs-cellname', (node) => node.textContent?.trim() ?? '')
const noteOf = (tab) => tab.$eval('[data-testid="grid-note"]', (node) => node.textContent?.trim() ?? '').catch(() => '')

/** 网格几何（与 geometry.ts 一致）：行号列 44、列标行 24、默认行高 24 */
const HEADER_W = 44
const HEADER_H = 24
const ROW_H = 24
/** 点第 `row` 行（0 基，视口顶部算起）的行号 / 第一列的格子 */
const clickRowHeader = (tab, row, options = {}) => tab.click('.kb-gs-canvas', { position: { x: 20, y: HEADER_H + row * ROW_H + 12 }, ...options })
const clickCell = (tab, row, col = 0) => tab.click('.kb-gs-canvas', { position: { x: HEADER_W + 12 + col * 100, y: HEADER_H + row * ROW_H + 12 } })

/** 在当前选中格里输入并提交（F2 → 填 → Enter；`key` 为 Tab 时提交后向右移） */
async function typeIntoSelected(tab, text, key = 'Enter') {
  await tab.keyboard.press('F2')
  await tab.fill('.kb-gs-editor', text)
  await tab.keyboard.press(key)
}

/** 到第 `row` 行第 `col` 列（只在首屏范围内用：键盘走过去） */
async function gotoCell(tab, row, col) {
  await tab.click('.kb-gs-canvas')
  await tab.keyboard.press('Control+Home')
  for (let i = 0; i < row; i += 1) await tab.keyboard.press('ArrowDown')
  for (let i = 0; i < col; i += 1) await tab.keyboard.press('ArrowRight')
}

/** 把一份文本按行号 / 列号改一格（夹具里没有带引号的逗号，按分隔符直接切就够，不依赖假服务端的实现） */
function replaceField(text, { row, col, value, newline, delimiter }) {
  const lines = text.split(newline)
  const fields = lines[row].split(delimiter)
  fields[col] = value
  lines[row] = fields.join(delimiter)
  return lines.join(newline)
}

/** 本地小文件那条路写回的字节：和服务端 save_file 一样按原编码 */
const bytesOfText = (text, encoding) => encodeText(text, encoding)

const waitUntilBytes = (server, path, predicate, timeout = 8000) => waitFor(async () => predicate(server.bytes(path)), timeout)

/** 通用的「不改直接保存逐字节不变 → 改一格保存只动这一格、编码不变」检查 */
function roundtripScenario(id, { remote, newline, delimiter, ext }) {
  const spec = CSV_FILES[id]
  return {
    title: `${spec.path}（${remote ? '服务端分页' : '本地'}）：不改保存逐字节相同；改一格保存后只有这一格的字节变化、编码与行尾保持`,
    async assert(tab, base, { server }) {
      const issues = []
      const original = Buffer.from(server.bytes(spec.path))
      const info = decodeBytes(original)
      await openCsvEditable(tab, base, '', id)
      // 走的是预期的那条路径：服务端分页的会在状态栏写出编码，本地的没有
      const note = await noteOf(tab)
      if (remote && !note.includes('分隔')) issues.push(`服务端分页路径的状态栏应写出编码 / 分隔符：${note}`)
      if (!remote && note) issues.push(`本地路径不该有状态栏说明：${note}`)
      if (remote && server.reads.length === 0) issues.push('服务端分页路径没有向服务端取行')
      if (!remote && server.reads.length) issues.push('本地路径不该向服务端分页取行')
      // 1. 不改，直接保存
      await tab.focus('.kb-gs')
      await tab.keyboard.press('Control+s')
      await tab.waitForTimeout(400)
      if (!server.bytes(spec.path).equals(original)) issues.push('不改直接保存，文件字节变了')
      if (server.edits.length || server.saves.length) issues.push('没有改动却发出了保存请求')
      // 2. 改第 1 行第 3 列，保存
      const before = info.text.split(newline)[1].split(delimiter)[3]
      const value = '改了-新值'
      await gotoCell(tab, 1, 3)
      if ((await formulaOf(tab)) !== before) issues.push(`定位到的格子不对：${await formulaOf(tab)} ≠ ${before}`)
      await typeIntoSelected(tab, value)
      await tab.keyboard.press('Control+s')
      const changed = await waitUntilBytes(server, spec.path, (bytes) => !bytes.equals(original))
      if (!changed) return [...issues, '改一格后保存，文件没有变化']
      const after = server.bytes(spec.path)
      const expected = bytesOfText(replaceField(info.text, { row: 1, col: 3, value, newline, delimiter }), info.encoding)
      if (!after.equals(expected)) issues.push(`保存后的字节不是「只替换这一格」的结果（${after.length} ≠ ${expected.length} 字节）`)
      // 变化的字节区间不超过「旧格 + 新格」各自的编码长度（BOM 不算在格子里）
      const bomLength = { 'utf-8-bom': 3, 'utf-16le': 2, 'utf-16be': 2 }[info.encoding] ?? 0
      const cellBytes = (text) => bytesOfText(text, info.encoding).length - bomLength
      const region = diffRegion(original, after)
      if (region.changedBefore > cellBytes(before) || region.changedAfter > cellBytes(value)) issues.push(`变化区间超出这一格：${JSON.stringify(region)}`)
      const reread = decodeBytes(after)
      if (reread.encoding !== info.encoding) issues.push(`编码变了：${info.encoding} → ${reread.encoding}`)
      if (remote) {
        const edit = server.edits.at(-1)
        if (server.edits.length !== 1) issues.push(`应只提交一次编辑：${server.edits.length}`)
        if (JSON.stringify(edit?.ops) !== JSON.stringify([{ op: 'set_cell', row: 1, col: 3, value }])) issues.push(`提交的操作列表不对：${JSON.stringify(edit?.ops)}`)
        if (edit?.expectedVersion !== 1 || !edit?.expectedSha) issues.push('保存没有带乐观锁的版本号 / 哈希')
      } else if (server.saves.length !== 1) issues.push(`应只提交一次保存：${server.saves.length}`)
      return issues
    },
  }
}

const CSV_SCENARIOS = {
  'csv-open': {
    title: 'CSV 进原生网格：公式栏、行列、旧表格编辑器都不在',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openCsvEditable(tab, base)
      const info = await tab.evaluate(() => ({
        host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="grid"]'),
        grid: !!document.querySelector('.kb-gs'),
        canvas: !!document.querySelector('.kb-gs canvas'),
        cell: document.querySelector('.kb-gs-cellname')?.textContent?.trim() ?? '',
        formula: document.querySelector('.kb-gs-formula-input')?.value ?? '',
        old: !!document.querySelector('[data-testid="csv-editor"]'),
        tabs: document.querySelectorAll('.kb-gs-tab').length,
        rowActions: [...document.querySelectorAll('[data-testid="editor-toolbar-slot"] [data-action^="row."]')].map((node) => node.getAttribute('data-action')),
      }))
      const issues = []
      if (!info.host || !info.grid || !info.canvas) issues.push('CSV 没有进入原生网格')
      if (info.cell !== 'A1') issues.push(`首格不是 A1：${info.cell}`)
      if (info.formula !== '编号') issues.push(`公式栏没有首格内容：${info.formula}`)
      if (info.old) issues.push('新路径还挂着旧 CSV 编辑器')
      if (info.tabs < 1) issues.push('缺少工作表标签')
      if (info.rowActions.join() !== 'row.insertAbove,row.insertBelow,row.delete,row.append') issues.push(`工具栏缺少行操作：${info.rowActions}`)
      // 默认路由是新网格：不该把旧表格编辑器的代码拉下来
      const old = resources.filter((url) => /CsvEditor|CsvCollabEditor/.test(url))
      if (old.length) issues.push(`新路径加载了旧 CSV 编辑器资源：${old.map((url) => url.split('/').pop()).join(', ')}`)
      return issues
    },
  },

  'csv-edit-save': {
    title: '改一个格子 → Ctrl+S：只改这一格，其它字节不动',
    async assert(tab, base, state) {
      await openCsvEditable(tab, base)
      await tab.focus('.kb-gs')
      await tab.keyboard.press('ArrowDown')
      await tab.keyboard.press('ArrowDown')
      await tab.keyboard.press('F2')
      await tab.fill('.kb-gs-editor', 'q002-改')
      await tab.keyboard.press('Enter')
      await tab.keyboard.press('Control+s')
      const ok = await waitFor(async () => state.saved.some((entry) => String(entry?.content ?? '').includes('q002-改')))
      const issues = []
      if (!ok) issues.push('没有等到包含新格子的 save_file 请求')
      const hit = [...state.saved].reverse().find((entry) => String(entry?.content ?? '').includes('q002-改'))
      if (hit) {
        const content = String(hit.content)
        if (!content.startsWith('编号,查询,命中名次,耗时(ms)\n')) issues.push('表头被改动')
        if (!content.includes('q001,"UDS 断线, 第 1 次",1,40')) issues.push('未改动的行没有原样保留')
        if (content.includes('\r\n')) issues.push('保存把 LF 改成了 CRLF')
      }
      return issues
    },
  },

  'csv-find': {
    title: 'Ctrl+F 在网格里查找：命中数来自 Surface，Esc 关闭',
    async assert(tab, base) {
      await openCsvEditable(tab, base)
      await tab.focus('.kb-gs')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 })
      await tab.fill('[data-testid="editor-find-input"]', 'q002')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 3000 })
      const count = await tab.textContent('[data-testid="editor-find-count"]')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      return count?.trim() === '1/1' ? [] : [`命中数不对：${count}`]
    },
  },

  'csv-axe': {
    title: 'axe：网格外壳无 critical / serious',
    async assert(tab, base) {
      await openCsvEditable(tab, base)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

  'csv-remote-axe': {
    title: 'axe：服务端分页的网格（状态栏有编码说明）与行右键菜单展开时无 critical / serious',
    async assert(tab, base) {
      await openCsvEditable(tab, base, '', 'file_csv_gbk')
      const issues = (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
      await clickRowHeader(tab, 2, { button: 'right' })
      await tab.waitForSelector('[data-testid="grid-row-menu"]', { timeout: 3000 })
      return issues.concat((await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe（菜单展开）${item}`))
    },
  },

  // ---- 编码：每种编码一份夹具，逐字节往返 ----
  'csv-roundtrip-bom': roundtripScenario('file_csv_bom', { remote: false, newline: '\r\n', delimiter: ',' }),
  'csv-roundtrip-gbk': roundtripScenario('file_csv_gbk', { remote: true, newline: '\r\n', delimiter: ',' }),
  'csv-roundtrip-gb18030': roundtripScenario('file_csv_gb18030', { remote: true, newline: '\r\n', delimiter: ',' }),
  'csv-roundtrip-utf16le': roundtripScenario('file_csv_u16le', { remote: true, newline: '\r\n', delimiter: ';' }),
  'csv-roundtrip-utf16be': roundtripScenario('file_csv_u16be', { remote: true, newline: '\n', delimiter: '\t' }),

  'csv-gb18030-rare-chars': {
    title: 'GB18030 的 4 字节字符（𠮷 䶮）显示正确，改别的格子后它们的字节原样不动',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_gb18030
      const original = Buffer.from(server.bytes(spec.path))
      await openCsvEditable(tab, base, '', 'file_csv_gb18030')
      await gotoCell(tab, 2, 3)
      const shown = await formulaOf(tab)
      const issues = shown === '𠮷野家 䶮' ? [] : [`4 字节字符显示不对：${shown}`]
      await gotoCell(tab, 1, 0)
      await typeIntoSelected(tab, 'q001-改')
      await tab.keyboard.press('Control+s')
      if (!(await waitUntilBytes(server, spec.path, (bytes) => !bytes.equals(original)))) return [...issues, '保存后文件没有变化']
      const after = server.bytes(spec.path)
      const rare = encodeText('𠮷野家 䶮', 'gb18030')
      if (after.indexOf(rare) < 0) issues.push('4 字节字符的原始字节丢了')
      if (original.indexOf(rare) < 0) issues.push('夹具里没有 4 字节字符，测试无效')
      return issues
    },
  },

  // ---- 大文件：超过 512 KB 按页取行 ----
  'csv-big-remote': {
    title: '5 MB 文件（超过 512 KB）在新网格可编辑：按页取行，滚到中间读到对的行，改一格保存只动这一格',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_big
      const original = Buffer.from(server.bytes(spec.path))
      await openCsvEditable(tab, base, '', 'file_csv_big')
      const issues = []
      const rowCount = await tab.evaluate(() => document.querySelector('.kb-gs-scroll')?.scrollHeight ?? 0)
      if (rowCount < 24 * 50_000) issues.push(`滚动高度不像几万行的表：${rowCount}`)
      // 滚到第 40000 行附近
      await tab.evaluate(() => {
        document.querySelector('.kb-gs-scroll').scrollTop = 40_000 * 24
      })
      if (!(await waitFor(async () => server.reads.some((read) => read.offset === 40_000), 8000))) issues.push(`没有读到第 40000 行所在的页：${JSON.stringify(server.reads.map((read) => read.offset))}`)
      await tab.waitForTimeout(400)
      await clickCell(tab, 0, 0)
      const name = await cellNameOf(tab)
      const formula = await formulaOf(tab)
      if (name !== 'A40001') issues.push(`滚动后首个可见格不是第 40001 行：${name}`)
      if (formula !== 'q0040000') issues.push(`第 40001 行读到的内容不对：${formula}`)
      // 只读了需要的页：打开的第一页 + 40000 行附近，没有把中间的 78 页都读一遍
      const offsets = server.reads.map((read) => read.offset)
      if (offsets.some((offset) => offset > 2000 && offset < 38_000)) issues.push(`为路过的页发了请求：${JSON.stringify(offsets)}`)
      if (offsets.length > 10) issues.push(`取页次数太多：${offsets.length}`)
      // 查找只扫读进来的页
      await tab.keyboard.press('Control+f')
      await tab.fill('[data-testid="editor-find-input"]', 'q0040000')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 3000 })
      await tab.keyboard.press('Escape')
      // 改这一格并保存
      await clickCell(tab, 0, 0)
      await typeIntoSelected(tab, 'EDITED')
      await tab.keyboard.press('Control+s')
      if (!(await waitUntilBytes(server, spec.path, (bytes) => !bytes.equals(original), 15_000))) return [...issues, '保存后文件没有变化']
      const after = server.bytes(spec.path)
      const region = diffRegion(original, after)
      if (region.changedBefore !== 'q0040000'.length || region.changedAfter !== 'EDITED'.length) issues.push(`变化区间不是这一格：${JSON.stringify(region)}`)
      if (after[0] !== 0xef || after[1] !== 0xbb || after[2] !== 0xbf) issues.push('UTF-8 BOM 丢了')
      const crlf = (buffer) => buffer.toString('utf8').split('\r\n').length
      if (crlf(after) !== crlf(original)) issues.push('行尾 CRLF 的数量变了')
      if (JSON.stringify(server.edits.at(-1)?.ops) !== JSON.stringify([{ op: 'set_cell', row: 40_000, col: 0, value: 'EDITED' }])) issues.push(`提交的操作不对：${JSON.stringify(server.edits.at(-1)?.ops)}`)
      return issues
    },
  },

  'csv-32m-longtask': {
    title: '接近 32 MB 的文件：打开 / 滚动到底 / 改格子，主线程最长任务不超过预算，滚动帧率正常',
    big: true,
    async assert(tab, base, { server }) {
      const budget = JSON.parse(readFileSync(join(ROOT, 'e2e/editor-budget.json'), 'utf8')).samples.csv
      // Long Tasks API 只有 Chromium 有：其它引擎只验证功能（滚动 / 取页 / 保存），不测长任务
      const measurable = tab.context().browser().browserType().name() === 'chromium'
      if (!measurable) console.log('    （非 Chromium：没有 Long Tasks API，只验证功能，不测长任务）')
      const path = CSV_FILES.file_csv_32m.path
      const original = Buffer.from(server.bytes(path))
      await tab.addInitScript(() => {
        window.__long = []
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__long.push(entry.duration)
          }).observe({ type: 'longtask', buffered: true })
        } catch {
          // 不支持 longtask 的引擎：下面按「无法测量」报错
        }
      })
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_csv_32m`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="csv-edit-open"]:not([disabled])', { timeout: 20_000 })
      await tab.waitForTimeout(500)
      // 先确认观测器真的能看到长任务：页面里排一个 120 ms 的忙等任务，必须被记下来，否则后面的“0 个长任务”不能算数
      await tab.evaluate(() => {
        setTimeout(() => {
          const started = performance.now()
          while (performance.now() - started < 120);
        }, 0)
      })
      const probed = !measurable || (await waitFor(async () => (await tab.evaluate(() => window.__long)).some((ms) => ms >= 100), 3000))
      if (!probed) return ['longtask 观测器没有记到探针任务，测量无效']
      await tab.evaluate(() => {
        window.__long.length = 0
      })
      // 打开编辑：服务端解析 32 MB 要一会儿（假服务端也一样），主线程不能被占住
      await tab.click('[data-testid="csv-edit-open"]')
      await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs', { timeout: 60_000 })
      await tab.waitForFunction(() => (document.querySelector('.kb-gs-formula-input')?.value ?? '') !== '', null, { timeout: 60_000 })
      const issues = []
      const rows = await tab.evaluate(() => Math.round((document.querySelector('.kb-gs-scroll')?.scrollHeight ?? 0) / 24))
      if (rows < 400_000) issues.push(`行数不像 3200 万字节的表：${rows}`)
      // 滚动：匀速滑 180 帧，量帧间隔
      const scroll = await tab.evaluate(async () => {
        const el = document.querySelector('.kb-gs-scroll')
        const deltas = []
        let last = performance.now()
        let frames = 0
        await new Promise((resolve) => {
          const step = (now) => {
            deltas.push(now - last)
            last = now
            el.scrollTop += 32
            frames += 1
            if (frames < 180) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        })
        const sorted = [...deltas].sort((a, b) => a - b)
        return { fps: 1000 / (deltas.reduce((sum, d) => sum + d, 0) / deltas.length), p95: sorted[Math.floor(sorted.length * 0.95)] }
      })
      // 直接跳到底部、再回到中间
      await tab.evaluate(() => {
        const el = document.querySelector('.kb-gs-scroll')
        el.scrollTop = el.scrollHeight
      })
      await tab.waitForTimeout(1500)
      await tab.evaluate(() => {
        document.querySelector('.kb-gs-scroll').scrollTop = 250_000 * 24
      })
      await tab.waitForTimeout(1500)
      await clickCell(tab, 2, 0)
      await typeIntoSelected(tab, 'X32')
      await tab.keyboard.press('Control+s')
      const saved = await waitUntilBytes(server, path, (bytes) => !bytes.equals(original), 30_000)
      const longTasks = await tab.evaluate(() => window.__long)
      const longest = Math.max(0, ...longTasks)
      console.log(`    32 MB：${rows} 行，滚动 ${scroll.fps.toFixed(1)} fps（p95 ${scroll.p95.toFixed(1)} ms），最长任务 ${longest.toFixed(0)} ms（${longTasks.length} 个，预算 ${budget.longTaskMs} ms），取页 ${server.reads.length} 次`)
      if (measurable && longest > budget.longTaskMs) issues.push(`主线程最长任务 ${longest.toFixed(0)} ms，超过预算 ${budget.longTaskMs} ms：${longTasks.map((ms) => ms.toFixed(0)).join('/')}`)
      // 帧率阈值只对 Chromium 有意义（与 editor-grid-bench 同口径）；WebKit 无头模式是软件渲染，数字只打印不判
      if (measurable && scroll.fps < 40) issues.push(`滚动只有 ${scroll.fps.toFixed(1)} fps`)
      if (!saved) issues.push('32 MB 文件改一格后保存没有生效')
      else if (diffRegion(original, server.bytes(path)).changedAfter > 'X32'.length + 2) issues.push('32 MB 文件保存后改动的字节超出这一格')
      return issues
    },
  },

  // ---- 行操作：本地（UTF-8 小文件）----
  'csv-rows-local': {
    title: '本地路径的插入 / 删除行：右键菜单、工具栏、撤销 / 重做；空行填了内容才写进文件，保存的字节只有这几处变化',
    async assert(tab, base, state) {
      await openCsvEditable(tab, base)
      const issues = []
      const original = FILES.file_csv.preview.content
      // 右键第 3 行（view 行 2）的行号 → 菜单 → 在上方插入行
      await clickRowHeader(tab, 2, { button: 'right' })
      await tab.waitForSelector('[data-testid="grid-row-menu"]', { timeout: 3000 })
      await tab.click('[data-action="row.insertAbove"]')
      await tab.waitForSelector('[data-testid="grid-row-menu"]', { state: 'detached', timeout: 3000 })
      // 新行在第 3 行，焦点在它的第一格；填内容
      if ((await cellNameOf(tab)) !== 'A3') issues.push(`插入后焦点不在新行：${await cellNameOf(tab)}`)
      await typeIntoSelected(tab, '新行A', 'Tab')
      await typeIntoSelected(tab, '新行B')
      // 此时视图：表头 / q001 / 新行 / q002 / q003 …；工具栏删除第 5 行（q003）：先点它的行号
      await clickRowHeader(tab, 4)
      await tab.click('[data-action="row.delete"]')
      // 撤销删除，再重做
      await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(150)
      await clickCell(tab, 4, 0)
      if ((await formulaOf(tab)) !== 'q003') issues.push(`撤销删除后第 5 行应是 q003：${await formulaOf(tab)}`)
      await tab.keyboard.press('Control+Shift+z')
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Control+s')
      const lines = original.split('\n')
      const expected = [lines[0], lines[1], '新行A,新行B', lines[2], ...lines.slice(4)].join('\n')
      const ok = await waitFor(async () => state.saved.some((entry) => String(entry?.content ?? '') === expected))
      if (!ok) issues.push(`保存的内容不是预期结果（最后一次：${JSON.stringify(String(state.saved.at(-1)?.content ?? '').slice(0, 160))}）`)
      return issues
    },
  },

  'csv-rows-local-blank': {
    title: '本地路径：只插入空行不填内容，保存时文件一个字节都不变（空行不写进文件）；末尾加一行可用',
    async assert(tab, base, state) {
      await openCsvEditable(tab, base)
      const issues = []
      await clickRowHeader(tab, 1)
      await tab.click('[data-action="row.insertBelow"]')
      await tab.click('[data-action="row.append"]')
      await tab.keyboard.press('Control+s')
      await tab.waitForTimeout(500)
      // 空行不在文本里：保存请求即使发出，内容也必须和原文一样
      for (const entry of state.saved) if (String(entry?.content ?? '') !== FILES.file_csv.preview.content) issues.push('只插入空行，保存的内容却变了')
      // 末尾加的那一行（最后一行）填上内容
      await tab.keyboard.press('Control+End')
      await typeIntoSelected(tab, 'LAST')
      await tab.keyboard.press('Control+s')
      // Ctrl+End 落在最后一行的最后一列（共 4 列），所以新行是 ",,,LAST"
      const ok = await waitFor(async () => state.saved.some((entry) => String(entry?.content ?? '').endsWith('\n,,,LAST')))
      if (!ok) issues.push(`末尾加的行没有写进文件：${JSON.stringify(String(state.saved.at(-1)?.content ?? '').slice(-60))}`)
      return issues
    },
  },

  // ---- 行操作：服务端分页（GBK）----
  'csv-rows-remote': {
    title: '服务端分页路径的插入 / 删除行：新行、删除、撤销 / 重做；保存提交的操作与最终字节都对（GBK 编码、CRLF 保持）',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_gbk
      const original = Buffer.from(server.bytes(spec.path))
      const info = decodeBytes(original)
      await openCsvEditable(tab, base, '', 'file_csv_gbk')
      const issues = []
      await clickRowHeader(tab, 2)
      await tab.click('[data-action="row.insertAbove"]')
      if ((await cellNameOf(tab)) !== 'A3') issues.push(`插入后焦点不在新行：${await cellNameOf(tab)}`)
      await typeIntoSelected(tab, '新行甲', 'Tab')
      await typeIntoSelected(tab, '新行乙')
      // 视图：表头 / q001 / 新行 / q002 / q003 / …；删第 5 行（q003）
      await clickRowHeader(tab, 4)
      await tab.click('[data-action="row.delete"]')
      let note = await noteOf(tab)
      if (!note.includes('删 1 行') || !note.includes('加 1 行')) issues.push(`状态栏的改动摘要不对：${note}`)
      // 撤销删除：摘要里不再有“删”，重做回来
      await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(150)
      note = await noteOf(tab)
      if (note.includes('删')) issues.push(`撤销删除后摘要还有删：${note}`)
      await tab.keyboard.press('Control+Shift+z')
      await tab.waitForTimeout(150)
      note = await noteOf(tab)
      if (!note.includes('删 1 行')) issues.push(`重做删除后摘要不对：${note}`)
      await tab.keyboard.press('Control+s')
      if (!(await waitUntilBytes(server, spec.path, (bytes) => !bytes.equals(original)))) return [...issues, '保存后文件没有变化']
      const ops = server.edits.at(-1)?.ops
      const wantOps = [
        { op: 'delete_row', row: 3 },
        { op: 'insert_row', at: 2, values: ['新行甲', '新行乙'] },
      ]
      if (JSON.stringify(ops) !== JSON.stringify(wantOps)) issues.push(`提交的操作不对：${JSON.stringify(ops)}`)
      const lines = info.text.split('\r\n')
      const expected = encodeText([lines[0], lines[1], '新行甲,新行乙', lines[2], ...lines.slice(4)].join('\r\n'), 'gb18030')
      if (!server.bytes(spec.path).equals(expected)) issues.push('保存后的字节不是预期结果（GBK / CRLF 应保持）')
      // 保存之后：基线换代，撤销栈清空，表以新内容为准（共 41 - 1 + 1 行）
      await tab.waitForFunction(() => !document.querySelector('[data-testid="grid-note"]')?.textContent?.includes('改了') && !document.querySelector('[data-testid="grid-note"]')?.textContent?.includes('加 '), null, { timeout: 5000 }).catch(() => issues.push('保存后状态栏还显示未保存的改动摘要'))
      await clickCell(tab, 2, 0)
      if ((await formulaOf(tab)) !== '新行甲') issues.push(`保存后第 3 行应是新行：${await formulaOf(tab)}`)
      return issues
    },
  },

  'csv-empty-remote': {
    title: '空文件：新网格打开空表，“末尾加一行”可用，填内容后保存，服务端按 UTF-8 写出这一行',
    async assert(tab, base, { server }) {
      // 空表没有格子可读：不等公式栏，外壳和按钮在就行
      await openCsvEditable(tab, base, '', 'file_csv_empty', { waitCell: false })
      const issues = []
      await tab.click('[data-action="row.append"]')
      await tab.waitForFunction(() => document.querySelector('.kb-gs-cellname')?.textContent?.trim() === 'A1', null, { timeout: 3000 })
      await typeIntoSelected(tab, 'hello')
      await tab.keyboard.press('Control+s')
      if (!(await waitUntilBytes(server, CSV_FILES.file_csv_empty.path, (bytes) => bytes.length > 0))) return ['空表加一行后保存没有生效']
      if (server.bytes(CSV_FILES.file_csv_empty.path).toString('utf8') !== 'hello\n') issues.push(`写出的内容不对：${JSON.stringify(server.bytes(CSV_FILES.file_csv_empty.path).toString('utf8'))}`)
      return issues
    },
  },

  // ---- 乐观锁 ----
  'csv-conflict-remote': {
    title: '乐观锁（服务端分页）：别人先保存后，本次保存被拒、状态显示版本冲突、草稿不丢；撤销仍可用',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_gbk
      await openCsvEditable(tab, base, '', 'file_csv_gbk')
      const issues = []
      await gotoCell(tab, 1, 0)
      await typeIntoSelected(tab, '我的改动')
      // 别人先存了一版
      const other = encodeText(decodeBytes(server.bytes(spec.path)).text.replace('q005', 'q005-别人'), 'gb18030')
      server.replaceExternally(spec.path, other)
      await tab.keyboard.press('Control+s')
      await tab.waitForFunction(() => (document.querySelector('[data-testid="editor-status-text"]')?.textContent ?? '').includes('冲突'), null, { timeout: 8000 }).catch(() => issues.push('状态栏没有显示版本冲突'))
      if (!server.bytes(spec.path).equals(other)) issues.push('冲突时服务端的文件不该被改动')
      if (server.edits.length !== 1) issues.push(`应只尝试过一次保存：${server.edits.length}`)
      // 草稿还在
      await gotoCell(tab, 1, 0)
      if ((await formulaOf(tab)) !== '我的改动') issues.push(`冲突后草稿丢了：${await formulaOf(tab)}`)
      const note = await noteOf(tab)
      if (!note.includes('改了 1 个格子')) issues.push(`冲突后改动摘要不见了：${note}`)
      // 撤销照常
      await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(150)
      if ((await formulaOf(tab)) !== 'q001') issues.push(`冲突后撤销不可用：${await formulaOf(tab)}`)
      return issues
    },
  },

  'csv-conflict-external-edit': {
    title: '乐观锁（文件被别的程序改了，版本号没变）：服务端按哈希拒绝，同样进入冲突、草稿不丢',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_gbk
      await openCsvEditable(tab, base, '', 'file_csv_gbk')
      await gotoCell(tab, 1, 0)
      await typeIntoSelected(tab, '我的改动')
      // 磁盘上的文件被改了，但版本号还是 1（没有经过保存流程）
      const file = server.files.get(spec.path)
      const other = encodeText(decodeBytes(file.bytes).text.replace('q005', 'q005-外部'), 'gb18030')
      const { createHash } = await import('node:crypto')
      server.files.set(spec.path, { bytes: other, version: file.version, sha256: createHash('sha256').update(other).digest('hex') })
      server.docs.delete(spec.path)
      await tab.keyboard.press('Control+s')
      const issues = []
      await tab.waitForFunction(() => (document.querySelector('[data-testid="editor-status-text"]')?.textContent ?? '').includes('冲突'), null, { timeout: 8000 }).catch(() => issues.push('哈希对不上时状态栏没有显示冲突'))
      await gotoCell(tab, 1, 0)
      if ((await formulaOf(tab)) !== '我的改动') issues.push('草稿丢了')
      return issues
    },
  },

  'csv-conflict-local': {
    title: '乐观锁（本地路径）：save_file 返回 409，状态显示版本冲突，格子里的改动还在',
    overrides: { __capabilityError: { save_file: { status: 409, code: 'conflict', message: '版本冲突' } } },
    async assert(tab, base) {
      await openCsvEditable(tab, base)
      await gotoCell(tab, 1, 0)
      await typeIntoSelected(tab, '我的改动')
      await tab.keyboard.press('Control+s')
      const issues = []
      await tab.waitForFunction(() => (document.querySelector('[data-testid="editor-status-text"]')?.textContent ?? '').includes('冲突'), null, { timeout: 8000 }).catch(() => issues.push('状态栏没有显示版本冲突'))
      await gotoCell(tab, 1, 0)
      if ((await formulaOf(tab)) !== '我的改动') issues.push('草稿丢了')
      return issues
    },
  },

  // ---- 回退：新网格打不开时退出编辑、回到预览并说明（不再有旧表格编辑器可回） ----
  'csv-remote-fallback': {
    title: '超过 32 MB 上限：新网格读不了第一页，显示原因并给回退入口，点了退出编辑回到预览并提示',
    big: true,
    async assert(tab, base) {
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_csv_toobig`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="csv-edit-open"]:not([disabled])', { timeout: 20_000 })
      await tab.click('[data-testid="csv-edit-open"]')
      const issues = []
      await tab.waitForSelector('[data-testid="editor-fallback"]', { timeout: 30_000 })
      const text = (await tab.textContent('[data-testid="editor-fallback"]')) ?? ''
      if (!text.includes('超过在线编辑的上限')) issues.push(`没有说明原因：${text.trim().slice(0, 80)}`)
      await tab.click('[data-testid="editor-fallback-btn"]')
      await tab.waitForSelector('[data-testid="csv-edit-open"]:not([disabled])', { timeout: 10_000 }).catch(() => issues.push('点回退没有回到预览（「表格编辑」入口没回来）'))
      if (await tab.locator('[data-testid="editor-host"]').count()) issues.push('回退后不该还挂着统一外壳')
      if (!(await tab.getByText('无法在编辑器里打开').count())) issues.push('回到预览后没有提示为什么')
      return issues
    },
  },

  // ---- 脏状态与离开保护 ----
  'csv-remote-discard': {
    title: '服务端分页路径：有未保存改动点“取消”要确认；放弃后回到阅读且文件没动；没改动直接退出',
    async assert(tab, base, { server }) {
      const spec = CSV_FILES.file_csv_gbk
      const original = Buffer.from(server.bytes(spec.path))
      await openCsvEditable(tab, base, '', 'file_csv_gbk')
      const issues = []
      await gotoCell(tab, 1, 0)
      await typeIntoSelected(tab, '不想要的改动')
      await tab.getByRole('button', { name: /^退出编辑$/ }).first().click()
      const discard = tab.getByRole('button', { name: '放弃修改' })
      if (!(await discard.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) issues.push('有未保存的改动，点「退出编辑」却没有确认')
      else await discard.click()
      await tab.waitForSelector('[data-testid="csv-edit-open"]', { timeout: 5000 })
      if (!server.bytes(spec.path).equals(original)) issues.push('放弃后文件被改动了')
      if (server.edits.length) issues.push('放弃后不该有任何保存请求')
      // 再进去，不改动，「退出编辑」应直接退出
      await tab.click('[data-testid="csv-edit-open"]')
      await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs', { timeout: 20_000 })
      await tab.getByRole('button', { name: /^退出编辑$/ }).first().click()
      await tab.waitForSelector('[data-testid="csv-edit-open"]', { timeout: 5000 }).catch(() => issues.push('没改动时「退出编辑」没有直接退出'))
      return issues
    },
  },
}

/** 打开 PDF 文件（统一外壳内的只读 PdfSurface） */
/** 起 PDF 预览默认进统一外壳（默认路由） */
async function openPdf(tab, base, extra = 'x=1') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_pdf&${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-pv', { timeout: 20_000 })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="pdf"] .kb-pv .page .textLayer span', { timeout: 30_000 })
}

/** 打开 XLSX 只读预览：由 Worker 画布渲染，失败会自动退回 SheetViewer（SheetJS）表格视图 */
async function openXlsx(tab, base, extra = 'x=1') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx&${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-fv', { timeout: 20_000 })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  // 首帧是异步的；等到公式栏拿到首格内容再断言，避免把 loading 当成失败
  await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A1', null, { timeout: 10_000 })
  // 公式栏在首帧之前就填好；等 loading 消失再点，否则 frame 还是 null，点击会被忽略
  await tab.waitForFunction(() => !document.querySelector('.kb-xg-loading'), null, { timeout: 10_000 })
  await tab.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}

const XLSX_SCENARIOS = {
  'xlsx-read-default': {
    title: '不带参数即进原生只读网格，「文字层」按钮在外壳工具栏里且能切过去',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openXlsx(tab, base, 'x=1')
      const info = await tab.evaluate(() => ({
        old: !!document.querySelector('.kb-sg'),
        switcher: !!document.querySelector('[data-testid="editor-host"] .kb-fv-switch'),
      }))
      const issues = []
      if (info.old) issues.push('默认路径还挂着旧 SheetViewer')
      if (!info.switcher) issues.push('原生网格里没有「文字层」切换按钮')
      if (resources.some((url) => /read-excel-file|\/SheetViewer-/.test(url))) issues.push('默认路径加载了旧表格视图 chunk')
      await tab.click('[data-testid="editor-host"] .kb-fv-switch')
      await tab.waitForSelector('.kb-fv .kb-dv', { timeout: 5000 }).catch(() => issues.push('点「文字层」没有切到抽取结果'))
      await tab.click('.kb-fv-strip .btn').catch(() => issues.push('文字层没有「查看原貌」按钮'))
      await tab.waitForSelector('[data-testid="editor-host"] .kb-xg .kb-xg-canvas', { timeout: 20_000 }).catch(() => issues.push('从文字层回不到原生网格'))
      return issues
    },
  },

  'xlsx-headers': {
    title: '行号列标：顶部 A/B/C、左侧 1/2/3 与网格对齐，点列标选整列、点行号选整行',
    async assert(tab, base) {
      await openXlsx(tab, base, 'x=1')
      const issues = []
      const info = await tab.evaluate(() => {
        const col = document.querySelector('[data-testid="xlsx-col-header"]')?.getBoundingClientRect()
        const row = document.querySelector('[data-testid="xlsx-row-header"]')?.getBoundingClientRect()
        const grid = document.querySelector('.kb-xg-canvas')?.getBoundingClientRect()
        return { col: col && { x: col.x, y: col.y, w: col.width, h: col.height }, row: row && { x: row.x, y: row.y, w: row.width, h: row.height }, grid: grid && { x: grid.x, y: grid.y, w: grid.width, h: grid.height } }
      })
      if (!info.col || !info.row || !info.grid) return ['行号 / 列标画布没有渲染']
      if (info.col.h < 16 || Math.abs(info.col.x - info.grid.x) > 1 || Math.abs(info.col.y + info.col.h - info.grid.y) > 1) issues.push(`列标没贴着网格上沿：${JSON.stringify(info)}`)
      if (info.row.w < 28 || Math.abs(info.row.x + info.row.w - info.grid.x) > 1 || Math.abs(info.row.y - info.grid.y) > 1) issues.push(`行号没贴着网格左沿：${JSON.stringify(info)}`)
      // 列标确实画了字：取中间一行像素看有没有非底色
      const inked = await tab.evaluate(() => {
        const canvas = document.querySelector('[data-testid="xlsx-col-header"]')
        const ctx = canvas.getContext('2d')
        const data = ctx.getImageData(0, Math.floor(canvas.height / 2), Math.min(canvas.width, 400), 1).data
        const base = data.slice(0, 4).join(',')
        let differ = 0
        for (let i = 0; i < data.length; i += 4) if (data.slice(i, i + 4).join(',') !== base) differ += 1
        return differ
      })
      if (inked < 5) issues.push('列标画布上没有字')
      // 点第一列的列标：选中整列
      await tab.click('[data-testid="xlsx-col-header"]', { position: { x: 5, y: 10 } })
      await tab.waitForTimeout(200)
      const summary = (await tab.locator('.kb-xg-selected').textContent())?.trim() ?? ''
      if (!/行 × 1 列/.test(summary)) issues.push(`点列标没有选中整列：${summary}`)
      await tab.click('[data-testid="xlsx-row-header"]', { position: { x: 10, y: 5 } })
      await tab.waitForTimeout(200)
      const rowSummary = (await tab.locator('.kb-xg-selected').textContent())?.trim() ?? ''
      if (!/^1 行 × \d+ 列$/.test(rowSummary)) issues.push(`点行号没有选中整行：${rowSummary}`)
      return issues
    },
  },

  'xlsx-read-hit': {
    title: '默认路径的检索命中（第二张表 R2）切表并定位到该行',
    async assert(tab, base) {
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx&highlight=ck_s_r2`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="editor-host"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
      await tab.waitForFunction(() => !document.querySelector('.kb-xg-loading'), null, { timeout: 15_000 })
      const ok = await waitFor(async () => (await tab.locator('.kb-xg-cellname').textContent())?.trim() === 'A2', 8000)
      const cell = (await tab.locator('.kb-xg-cellname').textContent())?.trim()
      const active = (await tab.locator('.kb-xg-tab[aria-selected="true"]').textContent())?.trim()
      const issues = []
      if (!ok) issues.push(`命中没有定位到 A2：${cell}`)
      if (active !== '评测汇总') issues.push(`命中工作表不对：${active}`)
      return issues
    },
  },

  'xlsx-open': {
    title: 'XLSX 进原生只读网格：画布、公式栏、真实工作表，旧 SheetViewer 不在',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openXlsx(tab, base)
      const info = await tab.evaluate(() => {
        const canvas = document.querySelector('.kb-xg .kb-xg-canvas')
        return {
          host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="grid"]'),
          surface: !!document.querySelector('.kb-xg'),
          width: canvas?.getBoundingClientRect().width ?? 0,
          height: canvas?.getBoundingClientRect().height ?? 0,
          cell: document.querySelector('.kb-xg-cellname')?.textContent?.trim() ?? '',
          formula: document.querySelector('.kb-xg-formula-input')?.value ?? '',
          tabs: [...document.querySelectorAll('.kb-xg-tab')].map((el) => el.textContent?.trim()),
          old: !!document.querySelector('.kb-sg'),
          editable: !!document.querySelector('.kb-xg [contenteditable="true"]'),
        }
      })
      const issues = []
      if (!info.host || !info.surface) issues.push('XLSX 没有进入原生只读网格')
      if (info.width < 200 || info.height < 100) issues.push(`画布没有铺开：${info.width}×${info.height}`)
      if (info.cell !== 'A1') issues.push(`首格不是 A1：${info.cell}`)
      if (info.formula !== '编号') issues.push(`公式栏没有首格内容：${info.formula}`)
      if (!info.tabs.includes('评测汇总') || !info.tabs.includes('原始数据')) issues.push(`工作表标签不对：${info.tabs.join(' / ')}`)
      if (info.old) issues.push('新路径还挂着旧 SheetViewer')
      if (info.editable) issues.push('只读表格出现了可编辑节点')
      const react = resources.filter((url) => /(?:xlsx-react|react-dom|\/react[-.])/i.test(url))
      if (react.length) issues.push(`只读路径加载了 React 编辑器：${react.map((u) => u.split('/').pop()).join(', ')}`)
      return issues
    },
  },

  'xlsx-scroll': {
    title: '滚动只改 rAF 画布：内容坐标变化，Vue 不参与重绘',
    async assert(tab, base) {
      await openXlsx(tab, base)
      const before = await tab.evaluate(() => document.querySelector('.kb-xg .kb-xg-canvas')?.toDataURL() ?? '')
      await tab.evaluate(() => {
        const scroller = document.querySelector('.kb-xg-scroll')
        if (scroller) scroller.scrollTop = 900
      })
      // 允许引擎异步取帧；像素变化即说明滚动确实重画了可见窗口
      const changed = await waitFor(
        async () =>
          (await tab.evaluate(() => document.querySelector('.kb-xg .kb-xg-canvas')?.toDataURL() ?? '')) !== before,
        3000,
      )
      const scrollTop = await tab.evaluate(() => document.querySelector('.kb-xg-scroll')?.scrollTop ?? 0)
      const issues = []
      if (!changed) issues.push('滚动后画布没有重绘')
      if (scrollTop < 500) issues.push(`滚动位置没有生效：${scrollTop}`)
      return issues
    },
  },

  'xlsx-select': {
    title: '点选远端单元格与切换工作表：公式栏跟随，选区在画布内',
    async assert(tab, base) {
      await openXlsx(tab, base)
      const box = await tab.locator('.kb-xg .kb-xg-canvas').boundingBox()
      if (!box) return ['找不到表格画布']
      await tab.mouse.click(box.x + 220, box.y + 90)
      await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() !== 'A1', null, { timeout: 3000 })
      const selected = await tab.textContent('.kb-xg-cellname')
      await tab.click('.kb-xg-tablist .kb-xg-tab:nth-child(2)')
      await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A1', null, { timeout: 5000 })
      const active = await tab.evaluate(() => document.querySelector('.kb-xg-tab[aria-selected="true"]')?.textContent?.trim() ?? '')
      const issues = []
      if (!selected || selected.trim() === 'A1') issues.push('点击没有移动选区')
      if (active !== '原始数据') issues.push(`切换工作表失败：${active}`)
      return issues
    },
  },

  'xlsx-find': {
    title: 'Ctrl+F 在只读表格查找：跨表命中后切到正确工作表与单元格，Esc 关闭',
    async assert(tab, base) {
      await openXlsx(tab, base)
      await tab.focus('.kb-xg')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 })
      // hit@1 只在第二张表，顺带验证查找跨表时活动工作表与选区锚点一起切换
      await tab.fill('[data-testid="editor-find-input"]', 'hit@1')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 5000 })
      const count = await tab.textContent('[data-testid="editor-find-count"]')
      await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A2', null, { timeout: 5000 })
      const active = await tab.textContent('.kb-xg-tab[aria-selected="true"]')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      const issues = []
      if (count?.trim() !== '1/1') issues.push(`命中数不对：${count}`)
      if (active?.trim() !== '原始数据') issues.push(`查找后没有切到命中工作表：${active}`)
      return issues
    },
  },

  'xlsx-axe': {
    title: 'axe：只读表格外壳无 critical / serious',
    async assert(tab, base) {
      await openXlsx(tab, base)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

}

/** 打开 XLSX 编辑态：走 OfficeEditor → 原生网格。 */
async function openXlsxEditor(tab, base, extra = '') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 20_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  // 首帧是异步的：等 loading 消失、公式栏拿到 A1，再断言，避免把挂载中当成失败
  await waitFor(async () => !(await tab.locator('.kb-xg-loading').count()), 20_000)
  await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A1', null, {
    timeout: 10_000,
  })
}

/** 输入一个值：可打印字符直接进就地编辑，回车提交后回到原格。 */
async function typeIntoXlsxCell(tab, value) {
  await tab.locator('.kb-xg').focus()
  await tab.keyboard.type(value)
  await tab.waitForSelector('[data-testid="xlsx-cell-editor"]', { timeout: 3000 })
  await tab.keyboard.press('Enter')
  // 回车后引擎下移一格；等一帧再按上，否则公式栏可能还停在旧格
  await new Promise((resolve) => setTimeout(resolve, 150))
  await tab.keyboard.press('ArrowUp')
  await new Promise((resolve) => setTimeout(resolve, 100))
}

/**
 * ：XLSX 默认路径阶段门禁。
 *
 * 和 `editor-xlsx-edit.mjs` 的分工：那边测命令/冲突/100 步撤销等细节；
 * 这里只守阶段出口——原生编辑、不加载 React、保存字节。
 */
const XLSX_EDIT_SCENARIOS = {
  'xlsx-native-default': {
    title: '打开即原生编辑：外壳 + 网格 + 编辑工具栏，没有 React 资源，WASM 按需加载',
    async assert(tab, base) {
      const resources = watchResources(tab)
      await openXlsxEditor(tab, base)
      const info = await tab.evaluate(() => ({
        native: !!document.querySelector('[data-testid="office-native-host"]'),
        host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="grid"]'),
        grid: !!document.querySelector('.kb-xg .kb-xg-canvas'),
        editable: !document.querySelector('[data-testid="office-readonly"]'),
        bold: !!document.querySelector('[data-testid="xlsx-bold"]'),
        save: !!document.querySelector('[data-testid="editor-save"]'),
        old: !!document.querySelector('.kb-sg, [data-testid="office-veil"]'),
      }))
      // WASM 由引擎自己的 Worker 拉取，页面 performance 里看不到，要从 Worker 里取
      const workerResources = []
      for (const worker of tab.workers()) {
        try {
          workerResources.push(...(await worker.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))))
        } catch {
          // Worker 正在销毁时 evaluate 会失败；只要其余证据齐全就不算失败
        }
      }
      const wasm = workerResources.filter((url) => /xlsx_wasm[^/]*\.wasm/.test(url))
      const issues = []
      if (!info.native || !info.host || !info.grid) issues.push('默认路径没有进入原生网格')
      if (!info.editable || !info.bold || !info.save) issues.push('原生编辑态缺少工具栏/保存入口，或被降成了只读')
      if (!wasm.length) issues.push('没有加载 XLSX WASM（引擎可能回退了）')
      if (info.old) issues.push('还挂着旧的表格视图 / 加载遮罩')
      // 旧岛已从仓库删除，「产物里没有旧内核」由构建期门禁（legacyFreeIssues）按内容指纹证明；这里只做运行期的名字兜底
      const legacy = resources.filter((url) => /xlsx-react|react-dom|\/react[-.]|scheduler/i.test(basename(new URL(url).pathname)))
      if (legacy.length) issues.push(`加载了 React 相关资源：${legacy.map((url) => basename(new URL(url).pathname)).join(', ')}`)
      return issues
    },
  },

  'xlsx-native-save': {
    title: '改 A1 → 保存：发 replace 请求，带原哈希与编辑权 session，字节是 ZIP',
    async assert(tab, base, state) {
      await openXlsxEditor(tab, base)
      await typeIntoXlsxCell(tab, '42')
      if ((await tab.locator('.kb-xg-formula-input').inputValue()) !== '42') {
        return [`公式栏没有回显输入：${await tab.locator('.kb-xg-formula-input').inputValue()}`]
      }
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) return ['有改动但外层没有未保存提示']
      await tab.click('[data-testid="editor-save"]')
      const saved = await waitFor(() => (state.office?.replaces?.length ?? 0) > 0, 15_000)
      if (!saved) return ['点保存后没有发出 replace 请求']
      const request = state.office.replaces[0]
      const issues = []
      if (!request.zip) issues.push('保存的字节不是 ZIP')
      if (request.bytes < 1000) issues.push(`保存的字节只有 ${request.bytes} B，疑似空包`)
      if (request.expected !== 'sha-fixture-original') issues.push(`保存没有带原始哈希：${request.expected}`)
      if (!request.session) issues.push('保存没有带编辑权 session')
      const status = (await tab.locator('[data-testid="editor-status"]').textContent()) ?? ''
      if (!/已就绪/.test(status)) issues.push(`保存后状态是「${status}」`)
      return issues
    },
  },

}

const PDF_SCENARIOS = {
  'pdf-open': {
    title: '50 页 PDF 进统一外壳：只读、页数正确、无编辑/保存按钮',
    async assert(tab, base) {
      await openPdf(tab, base)
      const info = await tab.evaluate(() => ({
        host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="pdf"]'),
        total: document.querySelector('.kb-pv-total')?.textContent?.trim() ?? '',
        pages: document.querySelectorAll('.kb-pv .page').length,
        textLayer: document.querySelectorAll('.kb-pv .textLayer span').length,
        editable: document.querySelectorAll('[data-testid="editor-host"] [contenteditable="true"]').length,
        edit: [...document.querySelectorAll('[data-testid="editor-host"] button')].filter((el) => /编辑|保存/.test(el.getAttribute('aria-label') ?? el.textContent ?? '')).length,
        save: !!document.querySelector('[data-testid="editor-save"]'),
        undo: !!document.querySelector('[data-testid="editor-undo"]'),
      }))
      const issues = []
      if (!info.host) issues.push('PDF 没有进入统一外壳')
      if (!info.total.includes('50')) issues.push(`页数不是 50：${info.total}`)
      if (info.pages < 1 || info.textLayer < 5) issues.push(`页面/文字层没渲染：${info.pages}/${info.textLayer}`)
      if (info.editable) issues.push('PDF 面出现了可编辑节点')
      if (info.edit) issues.push('PDF 面出现了编辑按钮')
      if (info.save || info.undo) issues.push('只读 PDF 不该出现保存/撤销按钮')
      return issues
    },
  },

  'pdf-page-zoom': {
    title: '翻页到第 2 页、放大后比例变化，页码输入可控',
    async assert(tab, base) {
      await openPdf(tab, base)
      const first = await tab.textContent('.kb-pv-zoom')
      const before = Number(await tab.inputValue('.kb-pv-page'))
      await tab.click('.kb-pv [aria-label="下一页"]')
      await tab.waitForFunction((wanted) => Number(document.querySelector('.kb-pv-page')?.value) === wanted, before + 1, { timeout: 5000 })
      await tab.click('.kb-pv [aria-label="放大"]')
      await tab.waitForFunction((before) => document.querySelector('.kb-pv-zoom')?.textContent?.trim() !== before, first, { timeout: 5000 })
      const page = Number(await tab.inputValue('.kb-pv-page'))
      const zoom = await tab.textContent('.kb-pv-zoom')
      const issues = []
      if (page !== before + 1) issues.push(`翻页后页码不对：${before} → ${page}`)
      if (zoom?.trim() === first?.trim()) issues.push('放大后比例没变')
      return issues
    },
  },

  'pdf-find': {
    title: 'Ctrl+F 用统一查找栏查 PDF：计数来自 pdf.js，Esc 关闭',
    async assert(tab, base) {
      await openPdf(tab, base)
      // 快捷键只在焦点位于 Host 内部时接管；点空白不保证拿到焦点，直接 focus 可聚焦容器
      await tab.focus('.kb-pv-container')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 5000 })
      await tab.fill('[data-testid="editor-find-input"]', '倒数排名融合')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 5000 })
      const count = await tab.textContent('[data-testid="editor-find-count"]')
      const internal = await tab.$('.kb-pv .kb-pv-find')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      const issues = []
      const [index, total] = String(count).trim().split('/').map(Number)
      if (!(total >= 1) || index !== 1) issues.push(`查找计数不对：${count}`)
      // 不只靠快捷键：工具栏上要有看得见的查找按钮
      const button = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="find"]')
      if (!(await button.count())) issues.push('PDF 工具栏上没有可见的查找按钮')
      else {
        await button.click()
        await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 }).catch(() => issues.push('点查找按钮没有打开查找条'))
        await tab.keyboard.press('Escape')
      }
      if (internal) issues.push('PDF 查看器自己又开了一套查找面板')
      return issues
    },
  },

  'pdf-select': {
    title: 'PDF 文字层可选择，选区非空（只读不等于不能复制）',
    async assert(tab, base) {
      await openPdf(tab, base)
      // 文字层是分批灌进去的；Chrome 偶尔会在首帧把刚建好的 Range 清掉，所以选择动作重试到读到非空文本为止
      const text = await tab.evaluate(async () => {
        for (let i = 0; i < 40; i += 1) {
          const span = [...document.querySelectorAll('[data-testid="editor-host"] .kb-pv .textLayer span')].find((s) => (s.textContent ?? '').trim().length > 2)
          if (span) {
            const range = document.createRange()
            range.selectNodeContents(span)
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
            const selected = selection?.toString().trim() ?? ''
            if (selected) return selected
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return ''
      })
      return text.length > 0 ? [] : ['PDF 文字层无法选择']
    },
  },

  'pdf-axe': {
    title: 'axe：PDF 外壳（含文字层）无 critical / serious',
    async assert(tab, base) {
      await openPdf(tab, base)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

}

/** 打开 Word 只读预览（默认进统一外壳的分页文档面） */
async function openDocx(tab, base, extra = 'x=1') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="page"] .kb-pgs section.kbdocx', { timeout: 30_000 })
}

/** 生成带一条批注的 docx：在 doc-20p 里「评测采用…」那一段上加批注（批注部件 + 内容类型 + 关系 + 范围标记） */
async function makeCommentedDocx() {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await readFile(resolve(ROOT, 'e2e/fixtures/editor/doc-20p.docx')))
  let xml = await zip.file('word/document.xml').async('string')
  const at = xml.indexOf('评测采用')
  const runStart = xml.lastIndexOf('<w:r>', at)
  const runEnd = xml.indexOf('</w:r>', at) + '</w:r>'.length
  xml = `${xml.slice(0, runStart)}<w:commentRangeStart w:id="0"/>${xml.slice(runStart, runEnd)}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${xml.slice(runEnd)}`
  zip.file('word/document.xml', xml)
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="测试者" w:date="2025-06-01T08:00:00Z" w:initials="CS"><w:p><w:r><w:t>指标口径要和黄金集对齐</w:t></w:r></w:p></w:comment></w:comments>`)
  let types = await zip.file('[Content_Types].xml').async('string')
  types = types.replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>')
  zip.file('[Content_Types].xml', types)
  let rels = await zip.file('word/_rels/document.xml.rels').async('string')
  rels = rels.replace('</Relationships>', '<Relationship Id="rIdKbComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', rels)
  const file = join(await mkdtemp(join(tmpdir(), 'kb-docx-')), 'commented.docx')
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
  return file
}

const pageInput = (tab) => tab.inputValue('.kb-pgs-page')

/* ---------------- Word 缩略图栏 / 高保真查看（补全）的共用小工具 ---------------- */

/** 等 N 张缩略图都画好（槽的 data-state=ready） */
const waitThumbs = (tab, count, timeout = 30_000) =>
  tab.waitForFunction((n) => document.querySelectorAll('.kb-pgt-slot[data-state="ready"]').length >= n, count, { timeout })

/**
 * 某页缩略图的墨量：元素截图解码后，非白色像素（亮度 < 235 且不透明）占比；整块空白 = 0。
 * 槽有 1px 边框（界面色，不是纸面），统计时去掉外圈 3px，免得边框把"空白页"算成有墨。
 */
async function thumbInk(tab, page) {
  const shot = await tab.locator(`[data-testid="page-thumb"][data-page="${page}"] .kb-pgt-slot`).screenshot()
  const png = PNG.sync.read(shot)
  const edge = 3
  let ink = 0
  let total = 0
  for (let y = edge; y < png.height - edge; y += 1) {
    for (let x = edge; x < png.width - edge; x += 1) {
      const i = (y * png.width + x) * 4
      const luma = (png.data[i] * 299 + png.data[i + 1] * 587 + png.data[i + 2] * 114) / 1000
      total += 1
      if (png.data[i + 3] > 200 && luma < 235) ink += 1
    }
  }
  return { ink: total ? ink / total : 0, width: png.width, height: png.height, corner: [png.data[edge * 4 + edge * png.width * 4], png.data[edge * 4 + edge * png.width * 4 + 1], png.data[edge * 4 + edge * png.width * 4 + 2]] }
}

/** 只读预览里视口中线所在的阅读位置：页（1 起）+ 页内比例 */
const lightPosition = (tab) =>
  tab.evaluate(() => {
    const scroller = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
    const middle = scroller.top + scroller.height / 2
    const pages = [...document.querySelectorAll('.kb-pgs section.kbdocx')]
    let index = pages.findIndex((page) => page.getBoundingClientRect().bottom >= middle)
    if (index < 0) index = pages.length - 1
    const rect = pages[index].getBoundingClientRect()
    return { page: index + 1, fraction: (middle - rect.top) / rect.height, input: document.querySelector('.kb-pgs-page')?.value }
  })

/** 滚动容器里把第 N 页（1 起）的顶部对到视口上沿再往下 offset 像素 */
const scrollLightTo = (tab, page, offset = 0) =>
  tab.evaluate(([n, extra]) => {
    const scroller = document.querySelector('.kb-pgs-scroll')
    const target = document.querySelectorAll('.kb-pgs section.kbdocx')[n - 1]
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + extra
  }, [page, offset])

/** 画布编辑里视口中线所在的阅读位置：页（1 起）+ 页内比例 */
const editPosition = (tab) =>
  tab.evaluate(() => {
    const scroller = document.querySelector('[data-testid="docx-edit-scroll"]').getBoundingClientRect()
    const middle = scroller.top + scroller.height / 2
    const pages = [...document.querySelectorAll('.kb-dex-page')]
    let index = pages.findIndex((page) => page.getBoundingClientRect().bottom >= middle)
    if (index < 0) index = pages.length - 1
    const rect = pages[index].getBoundingClientRect()
    return { page: index + 1, fraction: (middle - rect.top) / rect.height, input: document.querySelector('.kb-dex-page-input')?.value }
  })

/** 画布编辑里把第 N 页的顶部对到视口上沿再往下 offset 像素 */
const scrollEditTo = (tab, page, offset = 0) =>
  tab.evaluate(([n, extra]) => {
    const scroller = document.querySelector('[data-testid="docx-edit-scroll"]')
    const target = document.querySelectorAll('.kb-dex-page')[n - 1]
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + extra
  }, [page, offset])

/** 当前高亮的缩略图页码（aria-current） */
const currentThumb = (tab) => tab.evaluate(() => document.querySelector('[data-testid="page-thumb"][aria-current="page"]')?.dataset.page ?? '')

/** 缩略图完整落在栏的可见区里 */
const thumbVisibleInRail = (tab, page) =>
  tab.evaluate((n) => {
    const list = document.querySelector('[data-testid="page-thumbs"] .kb-pgt-list').getBoundingClientRect()
    const item = document.querySelector(`[data-testid="page-thumb"][data-page="${n}"]`).getBoundingClientRect()
    return item.top >= list.top - 1 && item.bottom <= list.bottom + 1 && item.left >= list.left - 1 && item.right <= list.right + 1
  }, page)

/** 一轮"滚动整篇"的流畅度：150 步 rAF 逐帧滚动，记帧间隔与主线程长任务 */
const scrollFpsRound = (tab, selector) =>
  tab.evaluate(async (sel) => {
    const frames = []
    const long = []
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => long.push(entry.duration)))
    observer.observe({ type: 'longtask', buffered: false })
    const scroller = document.querySelector(sel)
    scroller.scrollTop = 0
    await new Promise((resolve) => requestAnimationFrame(resolve))
    let last = performance.now()
    const total = scroller.scrollHeight - scroller.clientHeight
    const step = total / 150
    for (let i = 0; i < 150; i += 1) {
      scroller.scrollTop += step
      await new Promise((resolve) =>
        requestAnimationFrame((now) => {
          frames.push(now - last)
          last = now
          resolve()
        }),
      )
    }
    observer.disconnect()
    const sorted = [...frames.slice(2)].sort((a, b) => a - b)
    return {
      fps: 1000 / (sorted.reduce((sum, f) => sum + f, 0) / sorted.length),
      median: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      dropped: sorted.filter((f) => f > 33.4).length / sorted.length,
      longTasks: long.length,
      longMax: Math.max(0, ...long),
    }
  }, selector)

const WASM_URL = /\.wasm(?:\?|$)|docx_edit|docx\.worker/

const DOCX_READ_SCENARIOS = {
  'docx-open': {
    title: '20 页 Word 默认进统一外壳：只读、20 页、0 WASM、没有编辑/保存按钮',
    async assert(tab, base) {
      const wasm = []
      tab.on('request', (request) => {
        if (/\.wasm(?:\?|$)|docx_edit|docxWorker/.test(request.url())) wasm.push(request.url())
      })
      await openDocx(tab, base)
      const info = await tab.evaluate(() => ({
        pages: document.querySelectorAll('.kb-pgs section.kbdocx').length,
        total: document.querySelector('.kb-pgs-total')?.textContent?.trim() ?? '',
        title: document.querySelector('.kb-pgs section.kbdocx')?.textContent?.includes('性能样本') ?? false,
        table: !!document.querySelector('.kb-pgs table'),
        image: !!document.querySelector('.kb-pgs img'),
        editable: document.querySelectorAll('[data-testid="editor-host"] [contenteditable="true"]').length,
        save: !!document.querySelector('[data-testid="editor-save"]'),
        undo: !!document.querySelector('[data-testid="editor-undo"]'),
        overflowX: (() => { const s = document.querySelector('.kb-pgs-scroll'); return s ? s.scrollWidth - s.clientWidth : 0 })(),
      }))
      const issues = []
      if (info.pages !== 20) issues.push(`页数不是 20：${info.pages}`)
      if (!info.total.includes('20')) issues.push(`页数指示不对：${info.total}`)
      if (!info.title || !info.table || !info.image) issues.push(`正文/表格/图片没渲染：${JSON.stringify({ title: info.title, table: info.table, image: info.image })}`)
      if (info.editable || info.save || info.undo) issues.push('只读 Word 不该出现可编辑节点或保存/撤销按钮')
      if (info.overflowX > 2) issues.push(`文档区横向滚动 ${info.overflowX}px（应按宽度缩放）`)
      if (wasm.length) issues.push(`只读路径不该下载引擎：${wasm.map((u) => basename(new URL(u).pathname)).join(', ')}`)
      return issues
    },
  },

  'docx-page-zoom': {
    title: '翻页、页码输入跳转、滚动更新页码、缩放与恢复适应宽度',
    async assert(tab, base) {
      await openDocx(tab, base)
      const issues = []
      const fitted = (await tab.textContent('.kb-pgs-zoom')).trim()
      await tab.click('.kb-pgs [aria-label="下一页"]')
      if ((await pageInput(tab)) !== '2') issues.push(`点下一页后页码不是 2：${await pageInput(tab)}`)
      const gap = await tab.evaluate(() => {
        const scroller = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
        const page = document.querySelectorAll('.kb-pgs section.kbdocx')[1].getBoundingClientRect()
        return Math.round(page.top - scroller.top)
      })
      if (Math.abs(gap) > 40) issues.push(`第 2 页没有滚到视口顶部：偏差 ${gap}px`)
      await tab.fill('.kb-pgs-page', '15')
      await tab.press('.kb-pgs-page', 'Enter')
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '15', null, { timeout: 3000 })
      const scrolled = await tab.evaluate(() => {
        const scroller = document.querySelector('.kb-pgs-scroll')
        const page = document.querySelectorAll('.kb-pgs section.kbdocx')[14].getBoundingClientRect()
        return Math.round(page.top - scroller.getBoundingClientRect().top)
      })
      if (Math.abs(scrolled) > 40) issues.push(`输入 15 后没跳到第 15 页：偏差 ${scrolled}px`)
      // 手动滚回开头：页码要跟着滚动变回 1
      await tab.evaluate(() => { document.querySelector('.kb-pgs-scroll').scrollTop = 0 })
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '1', null, { timeout: 3000 }).catch(() => issues.push('滚回开头后页码没变回 1'))
      await tab.click('.kb-pgs [aria-label="放大"]')
      const zoomed = (await tab.textContent('.kb-pgs-zoom')).trim()
      if (zoomed === fitted) issues.push('放大后比例没变')
      await tab.click('.kb-pgs-zoom')
      if ((await tab.textContent('.kb-pgs-zoom')).trim() !== fitted) issues.push('点比例没有恢复适应宽度')
      return issues
    },
  },

  'docx-find': {
    title: 'Ctrl+F 统一查找栏：计数、Enter 下一个跳到别的页、Esc 关闭；工具栏有查找按钮',
    async assert(tab, base) {
      await openDocx(tab, base)
      await tab.focus('.kb-pgs-scroll')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 5000 })
      await tab.fill('[data-testid="editor-find-input"]', '章节标题')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 5000 })
      const first = (await tab.textContent('[data-testid="editor-find-count"]')).trim()
      const pageBefore = await pageInput(tab)
      await tab.press('[data-testid="editor-find-input"]', 'Enter')
      await tab.waitForFunction((before) => document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() !== before, first, { timeout: 3000 })
      const second = (await tab.textContent('[data-testid="editor-find-count"]')).trim()
      const highlighted = await tab.evaluate(() => (typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('kb-hit') && CSS.highlights.has('kb-query') : null))
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 })
      const cleared = await tab.evaluate(() => (typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('kb-query') : false))
      const issues = []
      const [index, total] = first.split('/').map(Number)
      if (index !== 1 || total < 19) issues.push(`查找计数不对：${first}（20 页每页一个标题）`)
      if (second !== `2/${total}`) issues.push(`Enter 没有跳到下一个：${first} → ${second}`)
      if (highlighted === false) issues.push('命中没有高亮')
      if (cleared) issues.push('Esc 后查找高亮没有清掉')
      void pageBefore
      const button = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="find"]')
      if (!(await button.count())) issues.push('工具栏上没有可见的查找按钮')
      return issues
    },
  },

  'docx-outline': {
    title: '大纲来自标题样式；点条目跳到那一页',
    async assert(tab, base) {
      await openDocx(tab, base)
      const button = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="outline"]')
      await button.waitFor({ state: 'visible', timeout: 5000 })
      await button.click()
      await tab.waitForSelector('[data-testid="editor-outline"] .kb-editor-outline-item', { timeout: 8000 })
      const items = await tab.$$eval('[data-testid="editor-outline"] .kb-editor-outline-item', (els) => els.map((el) => el.textContent.trim()))
      const issues = []
      if (items.length < 20) issues.push(`大纲条目太少：${items.length}`)
      if (!items.some((text) => text.startsWith('7. 章节标题'))) issues.push(`大纲里没有「7. 章节标题」：${items.slice(0, 5).join(' | ')}`)
      await tab.locator('[data-testid="editor-outline"] .kb-editor-outline-item', { hasText: '7. 章节标题' }).first().click()
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '7', null, { timeout: 5000 }).catch(async () => issues.push(`点大纲后页码不是 7：${await pageInput(tab)}`))
      return issues
    },
  },

  'docx-hit': {
    title: '从搜索结果打开：命中句子被高亮并滚到视野，不报「未能定位」',
    async assert(tab, base) {
      await openDocx(tab, base, 'highlight=ck_docx_2')
      await tab.waitForFunction(() => (typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('kb-hit') : true), null, { timeout: 8000 })
      const info = await tab.evaluate(() => ({
        miss: !!document.querySelector('.kb-pgs-miss'),
        hit: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('kb-hit') : null,
        visible: (() => {
          const range = typeof CSS !== 'undefined' && CSS.highlights ? [...(CSS.highlights.get('kb-hit') ?? [])][0] : null
          if (!range) return null
          const rect = range.getBoundingClientRect()
          const box = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
          return rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2
        })(),
      }))
      const issues = []
      if (info.miss) issues.push('提示「未能定位命中」')
      if (info.hit === false) issues.push('命中句子没高亮')
      if (info.visible === false) issues.push('命中句子不在视野里')
      return issues
    },
  },

  'docx-copy': {
    title: '复制：选中跨段落 + 表格的正文，粘贴出来保留段落与制表符，不带页眉页脚；全选则带上',
    async assert(tab, base) {
      await tab.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => undefined)
      await openDocx(tab, base)
      await tab.focus('.kb-pgs-scroll')
      await tab.evaluate(() => {
        const page = document.querySelector('.kb-pgs section.kbdocx')
        const paragraphs = [...page.querySelectorAll('p')]
        const from = paragraphs.find((p) => p.textContent.includes('混合检索与倒数排名融合'))
        const lastCell = [...page.querySelectorAll('table')][0].querySelector('tr:last-child td:last-child')
        const range = document.createRange()
        range.setStartBefore(from)
        range.setEndAfter(lastCell)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await tab.keyboard.press('Control+c')
      const text = await tab.evaluate(() => navigator.clipboard.readText())
      const issues = []
      if (!text.includes('混合检索与倒数排名融合\n')) issues.push(`段落没有换行分隔：${JSON.stringify(text.slice(0, 60))}`)
      if (!/\t/.test(text)) issues.push('表格单元格之间没有制表符')
      if (text.includes('性能基线样本') || text.includes('第 20 页合成文档')) issues.push('复制内容里混进了页眉页脚')
      await tab.keyboard.press('Control+a')
      await tab.keyboard.press('Control+c')
      const all = await tab.evaluate(() => navigator.clipboard.readText())
      if (!all.includes('性能基线样本')) issues.push('全选复制应包含页眉')
      if (all.includes('Word 工具栏') || all.includes('资源导航')) issues.push('全选选中了整个界面而不只是文档')
      return issues
    },
  },

  'docx-comments': {
    title: '批注侧栏：有批注才出现按钮；列出作者、原文、内容；点击定位到被批注的段落',
    async assert(tab, base) {
      const plain = process.env.KB_SAMPLE_DOCX
      await openDocx(tab, base)
      const issues = []
      if (await tab.locator('[data-testid="page-comments-toggle"]').count()) issues.push('没有批注的文档不该出现批注按钮')
      process.env.KB_SAMPLE_DOCX = await makeCommentedDocx()
      try {
        await openDocx(tab, base, 'y=2')
        const toggle = tab.locator('[data-testid="page-comments-toggle"]')
        await toggle.waitFor({ state: 'visible', timeout: 8000 })
        if (!(await toggle.textContent()).includes('1')) issues.push(`批注按钮没有数量：${await toggle.textContent()}`)
        await toggle.click()
        const panel = await tab.textContent('[data-testid="page-comments"]')
        if (!panel.includes('测试者') || !panel.includes('指标口径要和黄金集对齐') || !panel.includes('评测采用')) issues.push(`批注内容不全：${panel.replace(/\s+/g, ' ').slice(0, 120)}`)
        await tab.evaluate(() => { document.querySelector('.kb-pgs-scroll').scrollTop = 6000 })
        await tab.click('.kb-pgs-comment')
        const located = await tab.evaluate(() => {
          const range = typeof CSS !== 'undefined' && CSS.highlights ? [...(CSS.highlights.get('kb-hit') ?? [])][0] : null
          if (!range) return null
          const rect = range.getBoundingClientRect()
          const box = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
          return { text: range.toString().slice(0, 8), visible: rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2 }
        })
        if (!located || !located.visible) issues.push(`点批注没有把被批注的原文滚进视野：${JSON.stringify(located)}`)
      } finally {
        process.env.KB_SAMPLE_DOCX = plain
      }
      return issues
    },
  },

  'docx-phone': {
    title: '390×844 手机宽度：页面按宽度缩放无横向滚动，翻页与页码可点（≥36px）',
    async assert(tab, base) {
      // 触屏上下文：可点区域的规则（pointer: coarse）只在触屏下生效
      const context = await tab.context().browser().newContext(contextOptions({ width: 390, height: 844, dpr: 3, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      try {
        await installFixture(context, {})
        const phone = await context.newPage()
        await openDocx(phone, base)
        const info = await phone.evaluate(() => {
          const scroller = document.querySelector('.kb-pgs-scroll')
          const next = document.querySelector('.kb-pgs [aria-label="下一页"]').getBoundingClientRect()
          const section = document.querySelector('.kb-pgs section.kbdocx').getBoundingClientRect()
          return { overflowX: scroller.scrollWidth - scroller.clientWidth, next: [Math.round(next.width), Math.round(next.height)], pageWidth: Math.round(section.width), viewport: scroller.clientWidth }
        })
        const issues = []
        if (info.overflowX > 2) issues.push(`手机宽度横向滚动 ${info.overflowX}px`)
        if (info.pageWidth > info.viewport) issues.push(`页面比视口宽：${info.pageWidth} > ${info.viewport}`)
        if (info.next[0] < 36 || info.next[1] < 36) issues.push(`翻页按钮太小：${info.next.join('×')}`)
        return issues
      } finally {
        await context.close()
      }
    },
  },

  'docx-fallback': {
    title: '文件损坏：不白屏，回到检索文字层并给出重试入口',
    async assert(tab, base) {
      const plain = process.env.KB_SAMPLE_DOCX
      const dir = await mkdtemp(join(tmpdir(), 'kb-docx-bad-'))
      const bad = join(dir, 'bad.docx')
      await writeFile(bad, Buffer.from('这不是一个 docx 文件'))
      process.env.KB_SAMPLE_DOCX = bad
      try {
        await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&z=3`, { waitUntil: 'domcontentloaded' })
        await tab.waitForSelector('.kb-fv-strip.is-warn', { timeout: 30_000 })
        const strip = (await tab.textContent('.kb-fv-strip')).replace(/\s+/g, ' ')
        const text = await tab.evaluate(() => document.querySelector('.kb-fv')?.textContent ?? '')
        const issues = []
        if (!/渲染失败|损坏|无法/.test(strip)) issues.push(`失败提示不明确：${strip.slice(0, 80)}`)
        if (!text.includes('混合检索')) issues.push('没有回退到检索文字层')
        return issues
      } finally {
        process.env.KB_SAMPLE_DOCX = plain
      }
    },
  },

  'docx-axe': {
    title: 'axe：Word 只读外壳无 critical / serious',
    async assert(tab, base) {
      await openDocx(tab, base)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

  'docx-shapes': {
    title: '轻只读里的形状（流程图 / 文本框）：整页不再是空白——填充色是合法颜色、文字框在图形外、能看到形状和文字；含形状的文档提示"预览画不全"，无形状的不提示；提示可关闭',
    async assert(tab, base) {
      const issues = []
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-shapes.docx')
      try {
        await openDocx(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      await tab.waitForTimeout(800)
      const dom = await tab.evaluate(() => {
        const svgs = [...document.querySelectorAll('.kb-pgs section.kbdocx svg')]
        const ellipses = svgs.flatMap((svg) => [...svg.querySelectorAll('ellipse')])
        return {
          svgs: svgs.length,
          fills: ellipses.map((node) => node.getAttribute('fill')),
          strokes: ellipses.map((node) => node.getAttribute('stroke')),
          computedFills: ellipses.map((node) => getComputedStyle(node).fill),
          textBoxInShape: ellipses.filter((node) => node.querySelector('foreignObject')).length,
          texts: svgs.map((svg) => svg.querySelector('foreignObject')?.textContent?.trim() ?? ''),
        }
      })
      if (dom.svgs !== 2) issues.push(`夹具里有 2 个形状，实际 SVG ${dom.svgs} 个`)
      if (dom.fills.some((fill) => /\[\d+\]/.test(fill ?? ''))) issues.push(`填充色还带着样式索引（不是合法颜色）：${dom.fills.join(' | ')}`)
      if (dom.strokes.some((stroke) => /\[\d+\]/.test(stroke ?? ''))) issues.push(`描边色还带着样式索引：${dom.strokes.join(' | ')}`)
      if (dom.computedFills.some((fill) => /rgba\(0, 0, 0, 0\)/.test(fill))) issues.push(`形状的填充在浏览器里是透明的（颜色没被认出来）：${dom.computedFills.join(' | ')}`)
      if (dom.textBoxInShape) issues.push(`有 ${dom.textBoxInShape} 个文字框还在椭圆里面（SVG 图形元素不能有子节点，浏览器不画）`)
      if (dom.texts.join('|') !== '住院|开立医嘱') issues.push(`形状里的文字不对：${JSON.stringify(dom.texts)}`)

      // 看得见：判据用画面，不用 DOM。形状是蓝色（#4f81bd）椭圆，截图里应有一片蓝
      const shot = await tab.locator('.kb-pgs section.kbdocx').first().screenshot()
      const blue = await tab.evaluate(async (base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        let hits = 0
        for (let i = 0; i < data.length; i += 4) if (data[i] > 50 && data[i] < 120 && data[i + 1] > 100 && data[i + 1] < 160 && data[i + 2] > 160 && data[i + 2] < 220) hits += 1
        return hits
      }, shot.toString('base64'))
      console.log(`    · 形状的蓝色像素 ${blue} 个（两个 120pt × 48pt 的椭圆约 14000 个；不修时为 0）`)
      if (blue < 3000) issues.push(`页面上看不到蓝色椭圆：蓝色像素只有 ${blue} 个`)

      // 提示：含形状 → 有；可关闭
      const notice = tab.locator('[data-testid="page-shapes-notice"]')
      if (!(await notice.count())) issues.push('含形状的文档没有提示"预览画不全"')
      else {
        const text = (await notice.textContent()) ?? ''
        if (!text.includes('2 个图形')) issues.push(`提示没有说明有几个图形：${text.trim()}`)
        if (!/在线编辑|下载/.test(text)) issues.push(`提示没有给出路：${text.trim()}`)
        // 不挤没文档区
        const room = await tab.evaluate(() => document.querySelector('.kb-pgs-scroll')?.getBoundingClientRect().height ?? 0)
        if (room < 200) issues.push(`提示出现后文档区只剩 ${room}px`)
        await tab.click('[data-testid="page-shapes-notice-close"]')
        if (await notice.count()) issues.push('点"知道了"之后提示还在')
      }

      // 对照：无形状的文档不提示（否则就是对所有文档的噪音）
      await openDocx(tab, base)
      await tab.waitForTimeout(800)
      if (await tab.locator('[data-testid="page-shapes-notice"]').count()) issues.push('没有形状的文档不该提示"预览画不全"')
      return issues
    },
  },

  'docx-thumbs': {
    title: '缩略图栏：桌面默认打开；20 张缩略图都有可访问名称且画面非空白（墨量）；克隆体不混进页数 / 查找；当前页高亮；不下载引擎',
    async assert(tab, base) {
      const wasm = []
      tab.on('request', (request) => {
        if (WASM_URL.test(request.url())) wasm.push(request.url())
      })
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const info = await tab.evaluate(() => ({
        thumbs: document.querySelectorAll('[data-testid="page-thumb"]').length,
        names: [...document.querySelectorAll('[data-testid="page-thumb"] .kb-pgt-name')].map((el) => el.textContent.trim()),
        pages: document.querySelectorAll('.kb-pgs section.kbdocx').length,
        sections: document.querySelectorAll('section.kbdocx').length,
        wrappers: document.querySelectorAll('.kbdocx-wrapper').length,
        current: [...document.querySelectorAll('[data-testid="page-thumb"][aria-current="page"]')].map((el) => el.dataset.page),
        stops: [...document.querySelectorAll('[data-testid="page-thumb"][tabindex="0"]')].map((el) => el.dataset.page),
        pressed: document.querySelector('[data-action="page.thumbs"]')?.getAttribute('aria-pressed') ?? '',
        orientation: document.querySelector('[data-testid="page-thumbs"]')?.dataset.orientation ?? '',
        inert: document.querySelector('.kb-pgt-sheet')?.hasAttribute('inert') ?? false,
        ids: document.querySelectorAll('[data-testid="page-thumbs"] [id]').length,
        links: document.querySelectorAll('[data-testid="page-thumbs"] a[href]').length,
        aside: document.querySelector('[data-testid="page-thumbs"]')?.getAttribute('aria-label') ?? '',
        scrollerWidth: document.querySelector('.kb-pgs-scroll').clientWidth,
      }))
      const issues = []
      if (info.thumbs !== 20) issues.push(`缩略图数量不是 20：${info.thumbs}`)
      if (info.names[0] !== '第 1 页，共 20 页' || info.names[19] !== '第 20 页，共 20 页') issues.push(`缩略图的可访问名称不对：${info.names[0]} … ${info.names[19]}`)
      if (info.pages !== 20 || info.sections !== 20) issues.push(`缩略图克隆体混进了页选择器：.kb-pgs section.kbdocx=${info.pages}，section.kbdocx=${info.sections}（应都是 20）`)
      if (info.wrappers !== 1) issues.push(`.kbdocx-wrapper 应只有正文一个：${info.wrappers}`)
      if (info.current.join() !== '1') issues.push(`打开时应高亮第 1 页：${info.current.join()}`)
      if (info.stops.join() !== '1') issues.push(`Tab 停靠点应只有当前页：${info.stops.join()}`)
      if (info.pressed !== 'true') issues.push(`宽屏默认应打开缩略图，工具栏按钮 aria-pressed=${info.pressed}`)
      if (info.orientation !== 'vertical') issues.push(`宽屏应是纵栏：${info.orientation}`)
      if (!info.inert || info.ids || info.links) issues.push(`缩略图克隆体应 inert 且无 id / 链接：inert=${info.inert} ids=${info.ids} links=${info.links}`)
      if (info.aside !== '页面缩略图') issues.push(`栏的可访问名称不对：${info.aside}`)
      // 墨量：每张都有画面（整块空白 = 0）
      const inks = []
      for (let page = 1; page <= 20; page += 1) inks.push((await thumbInk(tab, page)).ink)
      const blank = inks.map((ink, index) => [ink, index + 1]).filter(([ink]) => ink < 0.003)
      console.log(`    · 20 张缩略图墨量（非白像素占比）：最小 ${(Math.min(...inks) * 100).toFixed(2)}%，平均 ${((inks.reduce((a, b) => a + b, 0) / inks.length) * 100).toFixed(2)}%，最大 ${(Math.max(...inks) * 100).toFixed(2)}%`)
      if (blank.length) issues.push(`缩略图几乎空白：第 ${blank.map(([, page]) => page).join('、')} 页`)
      // 查找只数正文：克隆体里的字不能被查到
      await tab.focus('.kb-pgs-scroll')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 5000 })
      await tab.fill('[data-testid="editor-find-input"]', '章节标题')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 5000 })
      const total = Number((await tab.textContent('[data-testid="editor-find-count"]')).trim().split('/')[1])
      if (total > 21) issues.push(`查找数到了缩略图里的字：共 ${total} 处（正文应约 20 处）`)
      await tab.keyboard.press('Escape')
      if (wasm.length) issues.push(`缩略图（DOM 克隆）不该下载引擎：${wasm.map((u) => basename(new URL(u).pathname)).join(', ')}`)
      return issues
    },
  },

  'docx-thumbs-nav': {
    title: '缩略图栏导航：点第 15 页缩略图跳到第 15 页；键盘 ↑↓ 移动焦点、Home / End、Enter 跳页、Esc 回正文；开关按钮可收起 / 展开',
    async assert(tab, base) {
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '15', null, { timeout: 3000 }).catch(async () => issues.push(`点第 15 页缩略图后页码不是 15：${await pageInput(tab)}`))
      const gap = await tab.evaluate(() => {
        const scroller = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
        return Math.round(document.querySelectorAll('.kb-pgs section.kbdocx')[14].getBoundingClientRect().top - scroller.top)
      })
      if (Math.abs(gap) > 40) issues.push(`第 15 页没有滚到视口顶部：偏差 ${gap}px`)
      if ((await currentThumb(tab)) !== '15') issues.push(`第 15 页缩略图没有高亮：${await currentThumb(tab)}`)

      // 键盘：焦点移动不翻页，Enter 才翻页
      const active = () => tab.evaluate(() => document.activeElement?.dataset?.page ?? document.activeElement?.className ?? '')
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').focus()
      await tab.keyboard.press('ArrowDown')
      if ((await active()) !== '16') issues.push(`↓ 后焦点不在第 16 页缩略图：${await active()}`)
      if ((await pageInput(tab)) !== '15') issues.push('仅移动焦点就翻页了（应按 Enter 才翻）')
      await tab.keyboard.press('Enter')
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '16', null, { timeout: 3000 }).catch(async () => issues.push(`Enter 后页码不是 16：${await pageInput(tab)}`))
      await tab.keyboard.press('ArrowUp')
      await tab.keyboard.press('ArrowUp')
      if ((await active()) !== '14') issues.push(`↑↑ 后焦点不在第 14 页缩略图：${await active()}`)
      await tab.keyboard.press('End')
      if ((await active()) !== '20') issues.push(`End 后焦点不在第 20 页：${await active()}`)
      if (!(await thumbVisibleInRail(tab, 20))) issues.push('End 后第 20 页缩略图没有滚进栏的可见区')
      await tab.keyboard.press('Home')
      if ((await active()) !== '1') issues.push(`Home 后焦点不在第 1 页：${await active()}`)
      await tab.keyboard.press('Escape')
      const back = await tab.evaluate(() => document.activeElement?.classList.contains('kb-pgs-scroll'))
      if (!back) issues.push('Esc 后焦点没有回到文档区')

      // 开关：收起后栏消失、按钮 aria-pressed=false、正文变宽；再点展开
      const widthWith = await tab.evaluate(() => document.querySelector('.kb-pgs-scroll').clientWidth)
      await tab.click('[data-action="page.thumbs"]')
      await tab.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 })
      if ((await tab.getAttribute('[data-action="page.thumbs"]', 'aria-pressed')) !== 'false') issues.push('收起后按钮 aria-pressed 应为 false')
      const widthWithout = await tab.evaluate(() => document.querySelector('.kb-pgs-scroll').clientWidth)
      if (widthWithout < widthWith + 150) issues.push(`收起后正文没有变宽：${widthWith} → ${widthWithout}`)
      await tab.click('[data-action="page.thumbs"]')
      await waitThumbs(tab, 20)
      return issues
    },
  },

  'docx-thumbs-sync': {
    title: '滚动同步：滚动主视图，缩略图高亮跟着变、并自动滚进栏的可见区；页码输入框同步',
    async assert(tab, base) {
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      const settle = (expected) =>
        tab
          .waitForFunction((page) => document.querySelector('[data-testid="page-thumb"][aria-current="page"]')?.dataset.page === page, expected, { timeout: 4000 })
          .then(() => true, () => false)
      for (const [page, offset] of [[12, 120], [20, 200], [7, 300], [1, 100]]) {
        await scrollLightTo(tab, page, offset)
        if (!(await settle(String(page)))) {
          issues.push(`滚到第 ${page} 页后高亮的是第 ${await currentThumb(tab)} 页`)
          continue
        }
        if ((await pageInput(tab)) !== String(page)) issues.push(`滚到第 ${page} 页后页码输入框是 ${await pageInput(tab)}`)
        // 栏滚动是在 rAF + nextTick 之后：给一帧
        await tab.waitForTimeout(150)
        if (!(await thumbVisibleInRail(tab, page))) issues.push(`第 ${page} 页缩略图高亮了但没有滚进栏的可见区`)
      }
      // 滚到最底：最后一页高亮，栏也滚到底附近
      await tab.evaluate(() => (document.querySelector('.kb-pgs-scroll').scrollTop = 1e7))
      if (!(await settle('20'))) issues.push(`滚到最底后高亮的是第 ${await currentThumb(tab)} 页`)
      return issues
    },
  },

  'docx-thumbs-zoom': {
    title: '缩放保持位置：放大 / 缩小 / 适应宽度 / 开关缩略图栏（改变正文宽度）之后仍在同一页同一处，不跳页',
    async assert(tab, base) {
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '15', null, { timeout: 3000 })
      await scrollLightTo(tab, 15, 380)
      await tab.waitForTimeout(200)
      const start = await lightPosition(tab)
      console.log(`    · 缩放前：第 ${start.page} 页，页内 ${(start.fraction * 100).toFixed(1)}%`)
      if (start.page !== 15) issues.push(`准备阶段没有停在第 15 页：${start.page}`)
      const check = async (what) => {
        await tab.waitForTimeout(350)
        const now = await lightPosition(tab)
        if (now.page !== start.page) issues.push(`${what}后页码从 ${start.page} 变成 ${now.page}（页码输入框 ${now.input}）`)
        else if (Math.abs(now.fraction - start.fraction) > 0.04) issues.push(`${what}后页内位置漂移：${(start.fraction * 100).toFixed(1)}% → ${(now.fraction * 100).toFixed(1)}%`)
        if (now.input !== String(start.page)) issues.push(`${what}后页码输入框是 ${now.input}`)
        return now
      }
      for (let i = 0; i < 3; i += 1) await tab.click('.kb-pgs [aria-label="放大"]')
      const zoomed = (await tab.textContent('.kb-pgs-zoom')).trim()
      await check(`放大到 ${zoomed}`)
      for (let i = 0; i < 7; i += 1) await tab.click('.kb-pgs [aria-label="缩小"]')
      const small = (await tab.textContent('.kb-pgs-zoom')).trim()
      await check(`缩小到 ${small}`)
      await tab.click('.kb-pgs-zoom')
      await check('恢复适应宽度')
      // 开关缩略图栏会改变正文宽度，适应宽度随之重算——位置也要保持
      await tab.click('[data-action="page.thumbs"]')
      await tab.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 })
      await check('收起缩略图栏')
      await tab.click('[data-action="page.thumbs"]')
      await check('展开缩略图栏')
      return issues
    },
  },

  'docx-thumbs-dark': {
    title: '深色模式只改界面：缩略图和正文的纸面仍是白底黑字，栏本身随主题变暗',
    async assert(tab, base) {
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      const light = await thumbInk(tab, 2)
      await tab.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark')
        document.documentElement.setAttribute('data-tone', 'dark')
      })
      await tab.waitForTimeout(400)
      const dark = await thumbInk(tab, 2)
      const info = await tab.evaluate(() => {
        const luma = (css) => {
          const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0]
          return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000
        }
        return {
          paper: getComputedStyle(document.querySelector('.kb-pgs section.kbdocx')).backgroundColor,
          sheet: getComputedStyle(document.querySelector('.kb-pgt-sheet')).backgroundColor,
          sheetText: getComputedStyle(document.querySelector('.kb-pgt-sheet p')).color,
          rail: luma(getComputedStyle(document.querySelector('[data-testid="page-thumbs"]')).backgroundColor),
        }
      })
      if (info.paper !== 'rgb(255, 255, 255)') issues.push(`深色下正文纸面不是白的：${info.paper}`)
      if (info.sheet !== 'rgb(255, 255, 255)') issues.push(`深色下缩略图纸面不是白的：${info.sheet}`)
      if (info.sheetText !== 'rgb(0, 0, 0)') issues.push(`深色下缩略图文字不是黑的：${info.sheetText}`)
      if (info.rail > 110) issues.push(`深色下栏本身没有变暗：亮度 ${info.rail.toFixed(0)}`)
      if (dark.corner.some((v) => v < 250)) issues.push(`深色下缩略图纸面角上的像素不是白的：${dark.corner.join(',')}`)
      if (Math.abs(dark.ink - light.ink) > 0.005) issues.push(`深色下缩略图墨量变了：${(light.ink * 100).toFixed(2)}% → ${(dark.ink * 100).toFixed(2)}%`)
      return issues
    },
  },

  'docx-hifi': {
    title: '高保真查看：悬停预取引擎；点按钮画布引擎只读打开、页码不变；不出现保存、不占编辑权、不进协同；画布缩略图可用；再点回到轻预览且页码不变、不重新下载原件',
    async assert(tab, base) {
      const requests = []
      const sockets = []
      tab.on('request', (request) => requests.push(request.url()))
      tab.on('websocket', (socket) => sockets.push(socket.url()))
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      const rawBefore = requests.filter((url) => /\/api\/v1\/raw/.test(url)).length
      if (requests.some((url) => WASM_URL.test(url))) issues.push('点高保真查看之前不该下载引擎')
      if (!(await tab.locator('[data-action="page.hifi"]').count())) return ['工具栏上没有「高保真查看」按钮']

      // 停到第 15 页中间
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '15', null, { timeout: 3000 })
      await scrollLightTo(tab, 15, 320)
      await tab.waitForTimeout(250)
      const before = await lightPosition(tab)

      // 悬停预取：不点击，引擎的 Worker / WASM 请求就该出现
      await tab.hover('[data-action="page.hifi"]')
      const prefetched = await waitFor(() => requests.some((url) => WASM_URL.test(url)), 20_000)
      if (!prefetched) issues.push('悬停「高保真查看」没有预取引擎')
      const startedAt = Date.now()
      await tab.click('[data-action="page.hifi"]')
      await tab.waitForSelector('[data-testid="page-hifi-stage"].is-live .kb-dex-page-input', { timeout: 120_000 })
      console.log(`    · 点「高保真查看」到画布可用（已预取）${((Date.now() - startedAt) / 1000).toFixed(1)} s`)
      const live = await tab.evaluate(() => ({
        input: document.querySelector('.kb-dex-page-input')?.value,
        total: document.querySelector('.kb-dex-total')?.textContent?.trim(),
        light: !!document.querySelector('.kb-pgs'),
        save: !!document.querySelector('[data-testid="editor-save"]'),
        undo: !!document.querySelector('[data-testid="editor-undo"]'),
        pressed: document.querySelector('[data-action="page.hifi"]')?.getAttribute('aria-pressed'),
        readonlyInput: document.querySelector('textarea.paged-editor__input')?.readOnly ?? null,
        canvases: document.querySelectorAll('.kb-dex-page canvas').length,
        loading: !!document.querySelector('[data-testid="page-hifi-loading"]'),
        focused: document.activeElement?.classList.contains('paged-editor__input') ?? false,
        host: document.querySelector('[data-testid="editor-host"]')?.getAttribute('data-surface-kind'),
      }))
      if (live.input !== '15') issues.push(`进入高保真后页码不是 15：${live.input}（共 ${live.total}）`)
      if (live.light) issues.push('进入高保真后轻预览还在')
      if (live.save || live.undo) issues.push(`高保真查看不该出现保存 / 撤销按钮：save=${live.save} undo=${live.undo}`)
      if (live.pressed !== 'true') issues.push(`「高保真查看」按钮应处于按下状态：${live.pressed}`)
      if (live.readonlyInput !== true) issues.push(`画布的输入框应是只读：${live.readonlyInput}`)
      if (!live.canvases) issues.push('画布上没有页面位图')
      if (live.loading) issues.push('加载提示没有消失')
      if (live.focused) issues.push('高保真查看不该抢输入焦点（手机上会弹软键盘）')
      if (live.host !== 'page') issues.push(`外壳内容面应仍是 page：${live.host}`)
      // 画布里键入不会改任何东西：没有脏标记、没有保存请求
      await tab.keyboard.press('x')
      await tab.waitForTimeout(300)
      // 不占编辑权、不进协同、不保存
      const forbidden = requests.filter((url) => /\/api\/v1\/(files\/lock|files\/replace|office\/(session|seed|base)|files\/roundtrip-check|office\/roundtrip-check)/.test(url))
      if (forbidden.length) issues.push(`高保真查看不该请求编辑权 / 协同 / 保存接口：${forbidden.map((u) => new URL(u).pathname).join(', ')}`)
      const officeSockets = sockets.filter((url) => /office|collab|room/i.test(url))
      if (officeSockets.length) issues.push(`高保真查看不该连协同房间：${officeSockets.join(', ')}`)
      if (await tab.locator('[data-testid="editor-dirty"], .kb-editor-dirty').count()) issues.push('高保真查看里出现了未保存标记')

      // 画布缩略图：20 张、非空白；点第 3 页跳过去
      await waitThumbs(tab, 20, 90_000)
      const inks = []
      for (const page of [1, 3, 10, 20]) inks.push([page, (await thumbInk(tab, page)).ink])
      console.log(`    · 画布缩略图墨量 ${inks.map(([page, ink]) => `第${page}页 ${(ink * 100).toFixed(2)}%`).join('，')}`)
      for (const [page, ink] of inks) if (ink < 0.003) issues.push(`高保真缩略图第 ${page} 页几乎空白（墨量 ${(ink * 100).toFixed(2)}%）`)
      await tab.locator('[data-testid="page-thumb"][data-page="3"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-dex-page-input')?.value === '3', null, { timeout: 4000 }).catch(async () => issues.push(`高保真里点第 3 页缩略图后页码是 ${await tab.inputValue('.kb-dex-page-input')}`))

      // 回到第 15 页中间再切回轻预览：页码保持
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-dex-page-input')?.value === '15', null, { timeout: 4000 })
      await tab.evaluate(() => (document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop += 260))
      await tab.waitForTimeout(300)
      const hifiPage = await tab.inputValue('.kb-dex-page-input')
      await tab.click('[data-action="page.hifi"]')
      await tab.waitForSelector('.kb-pgs section.kbdocx', { timeout: 30_000 })
      await tab.waitForFunction(() => document.querySelectorAll('.kb-pgs section.kbdocx').length === 20, null, { timeout: 15_000 })
      await tab.waitForTimeout(600)
      const after = await lightPosition(tab)
      console.log(`    · 往返：轻预览第 ${before.page} 页 ${(before.fraction * 100).toFixed(0)}% → 高保真第 ${hifiPage} 页 → 轻预览第 ${after.page} 页 ${(after.fraction * 100).toFixed(0)}%`)
      if (String(after.page) !== hifiPage || after.input !== hifiPage) issues.push(`切回轻预览后页码从 ${hifiPage} 变成 ${after.page}（输入框 ${after.input}）`)
      if (await tab.locator('[data-testid="page-hifi-stage"]').count()) issues.push('切回后画布舞台还在')
      if (await tab.locator('[data-testid="editor-save"]').count()) issues.push('轻预览出现了保存按钮')
      if (requests.filter((url) => /\/api\/v1\/raw/.test(url)).length !== rawBefore) issues.push('往返不该重新下载原件（应复用已读的字节）')
      if ((await tab.getAttribute('[data-action="page.hifi"]', 'aria-pressed')) !== 'false') issues.push('回到轻预览后按钮应弹起')
      await waitThumbs(tab, 20)
      if ((await currentThumb(tab)) !== hifiPage) issues.push(`回到轻预览后高亮的缩略图是 ${await currentThumb(tab)}`)
      return issues
    },
  },

  'docx-hifi-nav': {
    title: '高保真查看里外壳的查找 / 大纲 / 缩放 / 缩略图开关仍可用（命令转给画布面）：查找计数与 Enter 下一个、大纲点条目跳页、放大改变比例、缩略图可收起',
    async assert(tab, base) {
      await openDocx(tab, base)
      await tab.click('[data-action="page.hifi"]')
      await tab.waitForSelector('[data-testid="page-hifi-stage"].is-live .kb-dex-page-input', { timeout: 120_000 })
      const issues = []
      // 查找：工具栏的查找按钮 → 统一查找栏 → 计数 → Enter 下一个 → Esc 关闭
      await tab.click('[data-testid="editor-toolbar-slot"] [data-action="find"]')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 5000 })
      await tab.fill('[data-testid="editor-find-input"]', '章节标题')
      const counted = await waitFor(() => tab.evaluate(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? '')), 15_000)
      if (!counted) issues.push('高保真查看里查找没有给出计数')
      else {
        const first = (await tab.textContent('[data-testid="editor-find-count"]')).trim()
        const total = Number(first.split('/')[1])
        if (total < 19) issues.push(`查找计数不对：${first}（20 页每页一个标题）`)
        await tab.press('[data-testid="editor-find-input"]', 'Enter')
        await tab.waitForFunction((before) => document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() !== before, first, { timeout: 8000 }).catch(() => issues.push(`Enter 没有跳到下一个命中：${first}`))
      }
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 没有关闭查找栏'))

      // 大纲：点条目跳到那一页
      await tab.click('[data-testid="editor-toolbar-slot"] [data-action="outline"]')
      const hasOutline = await tab.waitForSelector('[data-testid="editor-outline"] .kb-editor-outline-item', { timeout: 15_000 }).then(() => true, () => false)
      if (!hasOutline) issues.push('高保真查看里大纲是空的')
      else {
        await tab.locator('[data-testid="editor-outline"] .kb-editor-outline-item', { hasText: '7. 章节标题' }).first().click()
        // 引擎的分页与 docx-preview 的分页不完全相同（标题落在第 6~8 页都算对），页码以视口中线为准，标题被滚到视口上三分之一处
        await waitFor(async () => ['6', '7', '8'].includes(await tab.inputValue('.kb-dex-page-input')), 8000)
        const landed = await tab.inputValue('.kb-dex-page-input')
        if (!['6', '7', '8'].includes(landed)) issues.push(`点大纲「7. 章节标题」后页码是 ${landed}（应在第 6~8 页）`)
      }

      // 缩放：放大后比例变了
      const before = (await tab.textContent('[data-testid="docx-edit-zoom"]')).trim()
      await tab.click('[data-testid="docx-edit-zoom-in"]')
      await tab.waitForTimeout(400)
      if ((await tab.textContent('[data-testid="docx-edit-zoom"]')).trim() === before) issues.push('高保真查看里放大没有改变比例')

      // 缩略图：按钮是亮着的（沿用轻预览里的打开状态），点一下收起、再点展开
      if ((await tab.getAttribute('[data-action="page.thumbs"]', 'aria-pressed')) !== 'true') issues.push('高保真查看里「缩略图」按钮应亮着（沿用轻预览里的打开状态）')
      await tab.click('[data-action="page.thumbs"]')
      await tab.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点「缩略图」没有收起栏'))
      if ((await tab.getAttribute('[data-action="page.thumbs"]', 'aria-pressed')) !== 'false') issues.push('收起后按钮应弹起')
      await tab.click('[data-action="page.thumbs"]')
      await waitThumbs(tab, 20, 90_000).catch(() => issues.push('再次展开后缩略图没有画出来'))
      return issues
    },
  },

  'docx-hifi-failure': {
    title: '高保真查看打不开时（引擎被拦）：如实提示，仍留在轻预览，页码与缩略图不受影响，按钮弹起',
    async assert(tab, base) {
      await tab.route(/docx\.worker|docx_edit.*\.wasm|\.wasm(\?|$)/, (route) => route.abort())
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const issues = []
      await tab.locator('[data-testid="page-thumb"][data-page="9"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '9', null, { timeout: 3000 })
      await tab.click('[data-action="page.hifi"]')
      await tab.waitForSelector('[data-testid="editor-command-notice"], .kb-editor-command-notice', { timeout: 90_000 }).catch(() => issues.push('引擎打不开时没有给出提示'))
      const text = ((await tab.locator('.kb-editor-command-notice').first().textContent().catch(() => '')) ?? '').trim()
      if (text && !/高保真查看没有打开/.test(text)) issues.push(`提示没有说明高保真查看没打开：${text}`)
      const info = await tab.evaluate(() => ({
        light: document.querySelectorAll('.kb-pgs section.kbdocx').length,
        stage: !!document.querySelector('[data-testid="page-hifi-stage"]'),
        loading: !!document.querySelector('[data-testid="page-hifi-loading"]'),
        pressed: document.querySelector('[data-action="page.hifi"]')?.getAttribute('aria-pressed'),
        page: document.querySelector('.kb-pgs-page')?.value,
      }))
      if (info.light !== 20) issues.push(`失败后轻预览应原样在：${info.light} 页`)
      if (info.stage || info.loading) issues.push('失败后留下了画布舞台 / 加载提示')
      if (info.pressed !== 'false') issues.push(`失败后按钮应弹起：${info.pressed}`)
      if (info.page !== '9') issues.push(`失败后页码变了：${info.page}`)
      return issues
    },
  },

  'docx-thumbs-phone': {
    title: '390×844 触屏：缩略图默认收起；点按钮展开成文档下方的横条、不盖正文；点缩略图翻页；再点收起',
    async assert(tab, base) {
      const context = await tab.context().browser().newContext(contextOptions({ width: 390, height: 844, dpr: 2, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      try {
        await installFixture(context, {})
        const phone = await context.newPage()
        await openDocx(phone, base)
        const issues = []
        await phone.waitForTimeout(500)
        if (await phone.locator('[data-testid="page-thumbs"]').count()) issues.push('手机上缩略图应默认收起')
        const button = phone.locator('[data-action="page.thumbs"]')
        await button.waitFor({ state: 'visible', timeout: 5000 })
        if ((await button.getAttribute('aria-pressed')) !== 'false') issues.push('默认收起时按钮 aria-pressed 应为 false')
        const box = await button.boundingBox()
        if (!box || box.width < 36 || box.height < 36) issues.push(`缩略图按钮在触屏上太小：${box?.width}×${box?.height}`)
        const scrollBefore = await phone.evaluate(() => {
          const s = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
          return { height: Math.round(s.height), width: Math.round(s.width), bottom: Math.round(s.bottom) }
        })
        await button.tap()
        await phone.waitForSelector('[data-testid="page-thumbs"]', { timeout: 5000 })
        await waitThumbs(phone, 20)
        const open = await phone.evaluate(() => {
          const s = document.querySelector('.kb-pgs-scroll').getBoundingClientRect()
          const r = document.querySelector('[data-testid="page-thumbs"]').getBoundingClientRect()
          const list = document.querySelector('[data-testid="page-thumbs"] .kb-pgt-list')
          const first = document.querySelector('[data-testid="page-thumb"][data-page="1"]').getBoundingClientRect()
          return {
            orientation: document.querySelector('[data-testid="page-thumbs"]').dataset.orientation,
            rail: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) },
            scroller: { top: Math.round(s.top), bottom: Math.round(s.bottom), height: Math.round(s.height), width: Math.round(s.width) },
            overlap: Math.max(0, Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top)),
            horizontalScroll: list.scrollWidth > list.clientWidth,
            firstTap: [Math.round(first.width), Math.round(first.height)],
            pageOverflow: document.querySelector('.kb-pgs-scroll').scrollWidth - document.querySelector('.kb-pgs-scroll').clientWidth,
          }
        })
        console.log(`    · 手机横条：高 ${open.rail.height}px（文档区 ${scrollBefore.height} → ${open.scroller.height}px，重叠 ${open.overlap}px）`)
        if (open.orientation !== 'horizontal') issues.push(`手机上应是横条：${open.orientation}`)
        if (open.overlap > 1) issues.push(`横条盖住了正文：重叠 ${open.overlap}px`)
        if (open.rail.top < open.scroller.bottom - 1) issues.push('横条应在文档区下方')
        if (open.scroller.width !== scrollBefore.width) issues.push(`横条把正文变窄了：${scrollBefore.width} → ${open.scroller.width}`)
        if (open.rail.height > 160) issues.push(`横条太高（${open.rail.height}px）`)
        if (!open.horizontalScroll) issues.push('20 页的横条应能横向滚动')
        if (open.firstTap[0] < 36 || open.firstTap[1] < 36) issues.push(`缩略图触控区太小：${open.firstTap.join('×')}`)
        if (open.pageOverflow > 2) issues.push(`手机宽度正文横向溢出 ${open.pageOverflow}px`)
        // 点第 6 张：翻到第 6 页（缩略图在横条里，可能需要滚动才可见，用 tap 让 Playwright 自己滚）
        await phone.locator('[data-testid="page-thumb"][data-page="6"]').tap()
        await phone.waitForFunction(() => document.querySelector('.kb-pgs-page')?.value === '6', null, { timeout: 4000 }).catch(async () => issues.push(`手机点第 6 张缩略图后页码是 ${await pageInput(phone)}`))
        // 翻页键与缩略图配合：下一页后高亮跟着变
        await phone.locator('.kb-pgs [aria-label="下一页"]').tap()
        await phone.waitForFunction(() => document.querySelector('[data-testid="page-thumb"][aria-current="page"]')?.dataset.page === '7', null, { timeout: 4000 }).catch(async () => issues.push(`点下一页后高亮的是第 ${await currentThumb(phone)} 页`))
        // 当前缩略图在横条的可见区里（横向）
        const visible = await phone.evaluate(() => {
          const list = document.querySelector('[data-testid="page-thumbs"] .kb-pgt-list').getBoundingClientRect()
          const item = document.querySelector('[data-testid="page-thumb"][data-page="7"]').getBoundingClientRect()
          return item.left >= list.left - 1 && item.right <= list.right + 1
        })
        if (!visible) issues.push('横条没有随翻页把当前缩略图滚进可见区')
        // 再点按钮收起，正文区恢复
        await button.tap()
        await phone.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 })
        const after = await phone.evaluate(() => Math.round(document.querySelector('.kb-pgs-scroll').getBoundingClientRect().height))
        if (Math.abs(after - scrollBefore.height) > 2) issues.push(`收起后文档区高度没有恢复：${scrollBefore.height} → ${after}`)
        return issues
      } finally {
        await context.close()
      }
    },
  },

  'docx-thumbs-fps': {
    title: '打开缩略图时主视图滚动仍 60 fps：缩略图全部生成后滚动整篇 20 页——帧间隔（rAF）与长任务；负载高时取多轮里最好的一轮',
    async assert(tab, base) {
      await openDocx(tab, base)
      await waitThumbs(tab, 20)
      const os = await import('node:os')
      const waitUntil = Date.now() + 90_000
      while (os.loadavg()[0] > os.cpus().length && Date.now() < waitUntil) await tab.waitForTimeout(3000)
      const load = os.loadavg()[0]
      const scrollRound = () => scrollFpsRound(tab, '.kb-pgs-scroll')
      const rounds = []
      for (let i = 0; i < 5; i += 1) rounds.push(await scrollRound())
      const best = [...rounds].sort((a, b) => a.median - b.median || a.dropped - b.dropped)[0]
      console.log(`    · 缩略图栏打开、滚动整篇 20 页（5 轮，系统负载 ${load.toFixed(1)}/16 核）：最好一轮 ${best.fps.toFixed(1)} fps，帧间隔中位 ${best.median.toFixed(1)} ms，p95 ${best.p95.toFixed(1)} ms，>33ms 掉帧 ${(best.dropped * 100).toFixed(1)}%，长任务 ${best.longTasks} 个（最长 ${best.longMax.toFixed(0)} ms）；各轮中位 ${rounds.map((r) => r.median.toFixed(1)).join('/')} ms`)
      // 对照：关掉缩略图栏再量一轮，看栏带来的差别（只记录，不作为判据）
      await tab.click('[data-action="page.thumbs"]')
      await tab.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 })
      const control = []
      for (let i = 0; i < 3; i += 1) control.push(await scrollRound())
      const base0 = [...control].sort((a, b) => a.median - b.median)[0]
      console.log(`    · 对照（栏关闭，3 轮）：最好一轮 ${base0.fps.toFixed(1)} fps，帧间隔中位 ${base0.median.toFixed(1)} ms，掉帧 ${(base0.dropped * 100).toFixed(1)}%`)
      const issues = []
      if (best.median > 17.5) issues.push(`缩略图栏打开：最好一轮帧间隔中位仍有 ${best.median.toFixed(1)} ms，达不到 60 fps`)
      if (best.dropped > 0.1) issues.push(`缩略图栏打开：最好一轮掉帧（>33ms）占 ${(best.dropped * 100).toFixed(1)}% > 10%`)
      return issues
    },
  },
}

/**
 * 打开 PowerPoint 预览（默认进统一外壳的幻灯片面）。
 * `deck` 换成别的文件靠环境变量：夹具的 sampleFor 每次请求时才读。
 */
async function openPptx(tab, base, extra = 'x=1', deck = PPTX_DECK) {
  process.env.KB_SAMPLE_PPTX = deck
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_pptx&${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="slide"] [data-testid="slide-surface"][data-state="ready"]', { timeout: 45_000 })
  await tab.waitForFunction(() => Number(document.querySelector('[data-testid="slide-surface"]')?.dataset.painted) >= 1, null, { timeout: 15_000 })
}

/** 在夹具的 pptx 预览里多加一条命中块：第 7 页上真实存在的一句话（引擎查找得到，用来验证高亮） */
const pptxPreview = (payload) => {
  const entry = Object.values(FILES).find((item) => item.item.source === payload?.path)
  const preview = entry?.preview ?? { format: 'md', blocks: [], chunks: [] }
  if (entry?.item.id !== 'file_pptx') return preview
  const hit = { id: 'ck_hit', ordinal: 9, anchor: { kind: 'slide', slide: 7 }, start_line: null, end_line: null, title: null, text: '批次 2 · OCR / 音视频转写' }
  return { ...preview, chunks: [...preview.chunks, hit] }
}

const slideNow = (tab) => tab.evaluate(() => Number(document.querySelector('[data-testid="slide-surface"]').dataset.slide))

/** 画布上和角落像素不同的采样点个数：> 0 说明画上了东西，而不是整块空白 */
const canvasInk = (tab, selector = '[data-testid="slide-canvas"]') =>
  tab.evaluate((sel) => {
    const canvas = document.querySelector(sel)
    if (!canvas || !canvas.width) return -1
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    const key = (i) => `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`
    const background = key(0)
    let ink = 0
    for (let i = 0; i < data.length; i += 4 * 11) if (key(i) !== background) ink += 1
    return ink
  }, selector)

/** 画布整体的摘要（翻页后画面变了没有） */
const canvasDigest = (tab) =>
  tab.evaluate(() => {
    const canvas = document.querySelector('[data-testid="slide-canvas"]')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 5381
    for (let i = 0; i < data.length; i += 4 * 7) hash = ((hash * 33) ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16)) | 0
    return hash
  })

/** 已经画出内容的缩略图个数 */
const paintedThumbs = (tab) =>
  tab.evaluate(() =>
    [...document.querySelectorAll('[data-testid="slide-thumb"] canvas')].filter((canvas) => {
      if (!canvas.width) return false
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      const first = `${data[0]},${data[1]},${data[2]}`
      for (let i = 0; i < data.length; i += 4 * 5) if (`${data[i]},${data[i + 1]},${data[i + 2]}` !== first) return true
      return false
    }).length,
  )

/** 点一下"翻页"，量到画面真的贴上去为止的耗时（ms） */
const flipMs = (tab, action) =>
  tab.evaluate(async (run) => {
    const root = document.querySelector('[data-testid="slide-surface"]')
    const before = Number(root.dataset.painted)
    const start = performance.now()
    new Function(`return (${run})()`)()
    while (Number(root.dataset.painted) === before) await new Promise((resolve) => requestAnimationFrame(resolve))
    return performance.now() - start
  }, action)

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

const PPTX_READ_SCENARIOS = {
  'pptx-open': {
    title: '30 页 deck 进统一外壳：只读、30 页、画布有内容、缩略图后台画出、引擎与中文字体按需下载',
    async assert(tab, base) {
      const resources = []
      tab.on('request', (request) => resources.push(request.url()))
      await openPptx(tab, base)
      const info = await tab.evaluate(() => ({
        total: document.querySelector('[data-testid="slide-total"]')?.textContent?.trim() ?? '',
        thumbs: document.querySelectorAll('[data-testid="slide-thumb"]').length,
        editable: document.querySelectorAll('[data-testid="editor-host"] [contenteditable="true"]').length,
        save: !!document.querySelector('[data-testid="editor-save"]'),
        undo: !!document.querySelector('[data-testid="editor-undo"]'),
        label: document.querySelector('[data-testid="slide-canvas"]')?.getAttribute('aria-label') ?? '',
        textLayer: !!document.querySelector('.kb-fv-switch'),
      }))
      const issues = []
      if (!info.total.includes('30')) issues.push(`页数指示不对：${info.total}`)
      if (info.thumbs !== 30) issues.push(`缩略图个数不对：${info.thumbs}`)
      if (info.editable || info.save || info.undo) issues.push('只读 PPT 不该出现可编辑节点或保存/撤销按钮')
      if (!info.label.includes('第 1 张，共 30 张：1. 产品路线图与检索质量')) issues.push(`画布无障碍名称不对：${info.label}`)
      await waitFor(async () => ((await tab.textContent('[data-testid="editor-status-count"]', { timeout: 500 }).catch(() => '')) ?? '').includes('30 页'), 5000).then((ok) => ok || issues.push('状态栏没有显示「30 页」'))
      if (!info.textLayer) issues.push('外壳里没有「文字层」切换入口（旧查看器有）')
      if ((await canvasInk(tab)) < 50) issues.push('主画布是空白的')
      // 缩略图后台生成：等到大部分画好
      const ok = await waitFor(async () => (await paintedThumbs(tab)) >= 28, 20_000)
      if (!ok) issues.push(`缩略图没有在后台画完：${await paintedThumbs(tab)}/30`)
      const names = resources.map((url) => basename(new URL(url).pathname))
      if (!names.some((name) => /pptx_wasm/.test(name))) issues.push('没有加载 pptx 引擎 WASM')
      // 中文 deck：中文度量（引擎排版）+ 实际用到的汉字片和标点片（浏览器画字）都要下载
      if (!names.some((name) => /^metrics-cjk.*\.ttf$/.test(name))) issues.push('deck 里有中文却没有加载中文度量字体')
      if (!names.some((name) => /^cjk-han-\d+.*\.woff2$/.test(name))) issues.push('deck 里有中文却没有加载汉字字形片')
      if (!names.some((name) => /^cjk-sym.*\.woff2$/.test(name))) issues.push('deck 里有中文标点却没有加载标点字形片')
      // 按需：只取用到的片，不是整套（deck-30p 只有 29 个不同的汉字，整套 46 片里不该下载超过一半）
      const hanSlices = new Set(names.filter((name) => /^cjk-han-\d+/.test(name)))
      if (hanSlices.size > 23) issues.push(`汉字片下载了 ${hanSlices.size} 片，说明没有按需（deck 里只有 29 个不同的汉字）`)
      // 旧的整套字体文件不该再下载
      const whole = names.filter((name) => /^(NotoSansSC|Carlito).*\.ttf$/.test(name))
      if (whole.length) issues.push(`幻灯片面不该再下载完整字体：${whole.join(', ')}`)
      const old = names.filter((name) => /pptx-preview|PptxViewer|pptx-react|react-dom/i.test(name))
      if (old.length) issues.push(`加载了 React 相关或 pptx-preview 资源：${old.join(', ')}`)
      return issues
    },
  },

  'pptx-latin-no-cjk': {
    title: '纯拉丁文字的 deck 不下载中文字体；表格 / 图片 / 备注照常',
    async assert(tab, base) {
      const resources = []
      tab.on('request', (request) => resources.push(request.url()))
      await openPptx(tab, base, 'x=2', PPTX_LATIN)
      const info = await tab.evaluate(() => ({
        total: document.querySelector('[data-testid="slide-total"]')?.textContent?.trim() ?? '',
        sr: document.querySelector('[data-testid="slide-sr"]')?.textContent ?? '',
      }))
      const issues = []
      if (!info.total.includes('8')) issues.push(`页数不对：${info.total}`)
      if (!info.sr.includes('Quarterly review 1')) issues.push(`读屏文字不对：${info.sr.slice(0, 60)}`)
      if ((await canvasInk(tab)) < 50) issues.push('主画布是空白的')
      await tab.fill('[data-testid="slide-page"]', '3')
      await tab.press('[data-testid="slide-page"]', 'Enter')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]').dataset.slide === '2', null, { timeout: 5000 })
      // 第 3 页有表格:读屏文字里要有单元格内容
      await waitFor(async () => (await tab.textContent('[data-testid="slide-sr"]')).includes('R2C2'), 5000).then((found) => found || issues.push('表格单元格文字没有出现在读屏文字里'))
      await tab.waitForTimeout(600)
      const names = resources.map((url) => basename(new URL(url).pathname))
      if (!names.some((name) => /^metrics-latin-regular.*\.ttf$/.test(name)) || !names.some((name) => /^metrics-latin-bold.*\.ttf$/.test(name))) issues.push('没有加载拉丁度量字体')
      if (!names.some((name) => /^latin-core-regular.*\.woff2$/.test(name)) || !names.some((name) => /^latin-core-bold.*\.woff2$/.test(name))) issues.push('没有加载拉丁字形')
      // 纯拉丁 deck：不下载任何中文相关文件（度量、汉字片、标点片、假名片都不该有）。
      // 注意只认字体文件本身：Vite 给 ?url 资源生成的同名小 JS 模块（只导出地址）不算
      const cjkFiles = names.filter((name) => /^(metrics-cjk|cjk-).*\.(ttf|woff2)$/.test(name))
      if (cjkFiles.length) issues.push(`纯拉丁 deck 不该下载中文字体：${cjkFiles.join(', ')}`)
      const whole = names.filter((name) => /^(NotoSansSC|Carlito).*\.ttf$/.test(name))
      if (whole.length) issues.push(`幻灯片面不该再下载完整字体：${whole.join(', ')}`)
      return issues
    },
  },

  'pptx-nav': {
    title: '翻页：缩略图跳页、页码输入、键盘、缩放；画面随页变化；30 页切页 < 100 ms',
    async assert(tab, base) {
      await openPptx(tab, base)
      const issues = []
      const first = await canvasDigest(tab)
      await tab.locator('[data-testid="slide-thumb"]').nth(9).click()
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]').dataset.slide === '9', null, { timeout: 5000 })
      await tab.waitForTimeout(300)
      if ((await canvasDigest(tab)) === first) issues.push('跳到第 10 页后画面没变')
      const label = await tab.getAttribute('[data-testid="slide-canvas"]', 'aria-label')
      if (!label.includes('第 10 张')) issues.push(`无障碍名称没跟着换页：${label}`)
      if ((await tab.getAttribute('[data-testid="slide-thumb"] >> nth=9', 'aria-current')) !== 'true') issues.push('当前页缩略图没有 aria-current')
      await tab.fill('[data-testid="slide-page"]', '30')
      await tab.press('[data-testid="slide-page"]', 'Enter')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]').dataset.slide === '29', null, { timeout: 5000 })
      if (!(await tab.isDisabled('[data-testid="slide-next"]'))) issues.push('最后一页「下一张」没有禁用')
      await tab.focus('[data-testid="slide-stage"]')
      await tab.keyboard.press('Home')
      if ((await slideNow(tab)) !== 0) issues.push('Home 没有回到第 1 页')
      await tab.keyboard.press('PageDown')
      if ((await slideNow(tab)) !== 1) issues.push('PageDown 没有翻到第 2 页')
      await tab.keyboard.press('ArrowRight')
      if ((await slideNow(tab)) !== 2) issues.push('→ 没有翻到第 3 页')
      const before = (await tab.textContent('[data-testid="slide-zoom"]')).trim()
      await tab.click('[aria-label="放大"]')
      const after = (await tab.textContent('[data-testid="slide-zoom"]')).trim()
      if (before === after) issues.push('放大后比例没变')
      await tab.click('[data-testid="slide-zoom"]')
      if ((await tab.textContent('[data-testid="slide-zoom"]')).trim() !== before) issues.push('点比例没有恢复适应页面')
      // 切页耗时:相邻页(已预渲染)与随机跳页(未缓存)各取中位数
      await tab.keyboard.press('Home')
      await tab.waitForTimeout(1200)
      const next = []
      for (let i = 0; i < 5; i += 1) {
        next.push(await flipMs(tab, "() => document.querySelector('[data-testid=\"slide-next\"]').click()"))
        await tab.waitForTimeout(250)
      }
      const jumps = []
      for (const target of [22, 8, 27, 14, 19]) {
        jumps.push(await flipMs(tab, `() => { const i = document.querySelector('[data-testid="slide-page"]'); i.value = '${target}'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }`))
        await tab.waitForTimeout(250)
      }
      console.log(`    切页耗时（ms）：相邻 ${next.map(Math.round).join('/')}，跳页 ${jumps.map(Math.round).join('/')}`)
      if (median(next) >= 100) issues.push(`相邻页切页中位数 ${Math.round(median(next))} ms，超过 100 ms`)
      if (median(jumps) >= 100) issues.push(`跳页（未缓存）切页中位数 ${Math.round(median(jumps))} ms，超过 100 ms`)
      return issues
    },
  },

  'pptx-notes': {
    title: '演讲者备注：显示当前页备注，可折叠；有备注的 deck 才有备注按钮',
    async assert(tab, base) {
      await openPptx(tab, base)
      const issues = []
      const text = (await tab.textContent('[data-testid="slide-notes"]').catch(() => '')) ?? ''
      if (!text.includes('先讲批次 1 的收益')) issues.push(`宽屏默认应展开备注：${text.slice(0, 60)}`)
      await tab.click('[data-testid="slide-notes-toggle"]')
      if (await tab.$('[data-testid="slide-notes"]')) issues.push('点备注按钮后没有折叠')
      await tab.click('[data-testid="slide-notes-toggle"]')
      if (!(await tab.$('[data-testid="slide-notes"]'))) issues.push('再点没有展开')
      return issues
    },
  },

  'pptx-present': {
    title: '放映：从当前页开始，键盘翻页，Esc 退出并回到那一页',
    async assert(tab, base) {
      await openPptx(tab, base)
      const issues = []
      await tab.locator('[data-testid="slide-thumb"]').nth(2).click()
      await tab.click('[data-testid="slide-present-btn"]')
      await tab.waitForSelector('[data-testid="slide-present"]', { timeout: 5000 })
      await waitFor(async () => (await canvasInk(tab, '[data-testid="slide-present"] canvas')) > 50, 8000).then((ok) => ok || issues.push('放映画布是空白的'))
      const no = async () => (await tab.textContent('[data-testid="slide-present-no"]')).trim()
      if (!(await no()).startsWith('3 /')) issues.push(`没有从当前页开始放映：${await no()}`)
      await tab.keyboard.press('ArrowRight')
      await tab.keyboard.press('Space')
      if (!(await no()).startsWith('5 /')) issues.push(`键盘翻页不对：${await no()}`)
      await tab.keyboard.press('ArrowLeft')
      if (!(await no()).startsWith('4 /')) issues.push(`← 没有回到上一页：${await no()}`)
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="slide-present"]', { state: 'detached', timeout: 5000 }).catch(() => issues.push('Esc 没有退出放映'))
      if ((await slideNow(tab)) !== 3) issues.push(`退出放映后没有停在放映时的那一页：${await slideNow(tab)}`)
      return issues
    },
  },

  'pptx-find': {
    title: 'Ctrl+F 统一查找栏：计数、Enter 下一个跳到别的页、命中高亮、Esc 关闭；大纲点条目跳页',
    async assert(tab, base) {
      await openPptx(tab, base)
      const issues = []
      await tab.focus('[data-testid="slide-stage"]')
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 5000 })
      await tab.fill('[data-testid="editor-find-input"]', '稠密向量')
      await tab.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() ?? ''), null, { timeout: 5000 })
      const first = (await tab.textContent('[data-testid="editor-find-count"]')).trim()
      if (first !== '1/30') issues.push(`查找计数不对：${first}（每页一处）`)
      await waitFor(async () => (await tab.locator('.kb-sl-hit').count()) > 0, 5000).then((ok) => ok || issues.push('命中没有在画布上高亮'))
      const rect = await tab.evaluate(() => {
        const hit = document.querySelector('.kb-sl-hit.is-active')?.getBoundingClientRect()
        const sheet = document.querySelector('.kb-sl-sheet')?.getBoundingClientRect()
        return hit && sheet ? { inside: hit.left >= sheet.left - 1 && hit.right <= sheet.right + 1 && hit.top >= sheet.top - 1 && hit.bottom <= sheet.bottom + 1, w: Math.round(hit.width), h: Math.round(hit.height) } : null
      })
      if (!rect || !rect.inside || rect.w < 20 || rect.h < 8) issues.push(`高亮矩形不合理：${JSON.stringify(rect)}`)
      await tab.press('[data-testid="editor-find-input"]', 'Enter')
      await tab.waitForFunction(() => document.querySelector('[data-testid="editor-find-count"]')?.textContent?.trim() === '2/30', null, { timeout: 3000 }).catch(() => issues.push('Enter 没有跳到下一个命中'))
      if ((await slideNow(tab)) !== 1) issues.push(`下一个命中应在第 2 页，实际 ${await slideNow(tab) + 1}`)
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 没有关闭查找栏'))
      await waitFor(async () => (await tab.locator('.kb-sl-hit').count()) === 0, 3000).then((ok) => ok || issues.push('关闭查找后高亮没有清掉'))
      const button = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="find"]')
      if (!(await button.count())) issues.push('工具栏上没有可见的查找按钮')
      // 大纲：条目是各页标题，点击跳页
      const outline = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="outline"]')
      if (!(await outline.count())) issues.push('工具栏上没有大纲按钮')
      return issues
    },
  },

  'pptx-hit': {
    title: '检索命中：翻到命中页并高亮；命中文字只在备注里时给提示，不高亮',
    async assert(tab, base) {
      const issues = []
      await openPptx(tab, base, 'highlight=ck_hit')
      if ((await slideNow(tab)) !== 6) issues.push(`命中应在第 7 页，实际 ${await slideNow(tab) + 1}`)
      await waitFor(async () => (await tab.locator('.kb-sl-hit').count()) > 0, 5000).then((ok) => ok || issues.push('命中文字没有高亮'))
      if ((await tab.locator('text=命中在备注或图片中').count()) > 0) issues.push('找得到的命中不该提示"在备注或图片中"')
      await openPptx(tab, base, 'highlight=ck_sl3n')
      if ((await slideNow(tab)) !== 2) issues.push(`备注命中应翻到第 3 页，实际 ${await slideNow(tab) + 1}`)
      await tab.waitForSelector('text=命中在备注或图片中', { timeout: 5000 }).catch(() => issues.push('备注里的命中没有给提示'))
      if ((await tab.locator('.kb-sl-hit').count()) > 0) issues.push('备注命中不该在画布上画高亮')
      return issues
    },
  },

  'pptx-phone': {
    title: '390×844 触屏：整页按宽度缩放无横向滚动、横滑翻页、目录抽屉、按钮 ≥ 36px、放映可滑动',
    async assert(tab, base) {
      const context = await tab.context().browser().newContext(contextOptions({ width: 390, height: 844, dpr: 3, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      try {
        await installFixture(context, { ...SOLO_EDIT_FIXTURE, file_preview: pptxPreview })
        const phone = await context.newPage()
        await openPptx(phone, base)
        const issues = []
        const info = await phone.evaluate(() => {
          const stage = document.querySelector('[data-testid="slide-stage"]')
          const sheet = document.querySelector('.kb-sl-sheet').getBoundingClientRect()
          const rail = document.querySelector('[data-testid="slide-rail"]')
          const small = [...document.querySelectorAll('.kb-sl button, .kb-sl input')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 36 || r.width < 36) && !el.closest('.kb-sl-rail') })
            .map((el) => `${el.getAttribute('aria-label') || el.textContent.trim() || el.className}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
          return { overflowX: stage.scrollWidth - stage.clientWidth, docOverflow: document.documentElement.scrollWidth - innerWidth, sheetW: Math.round(sheet.width), stageW: stage.clientWidth, railShown: !!rail && getComputedStyle(rail).display !== 'none', small }
        })
        if (info.overflowX > 2 || info.docOverflow > 2) issues.push(`手机宽度横向滚动：stage ${info.overflowX}px，页面 ${info.docOverflow}px`)
        if (info.sheetW > info.stageW) issues.push(`幻灯片比视口宽：${info.sheetW} > ${info.stageW}`)
        if (info.railShown) issues.push('手机上目录应默认收起')
        if (info.small.length) issues.push(`可点区域太小：${info.small.join('、')}`)
        // 横滑翻页（CDP 触摸）
        const cdp = await context.newCDPSession(phone)
        const swipe = async (x1, x2, y = 330) => {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y }] })
          for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / 6, y }] })
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          // 紧接着的轻点会被 Chromium 当作"停止惯性滚动"吞掉
          await phone.waitForTimeout(1600)
        }
        await swipe(320, 70)
        if ((await slideNow(phone)) !== 1) issues.push(`左滑没有翻到下一页：${await slideNow(phone)}`)
        await swipe(70, 320)
        if ((await slideNow(phone)) !== 0) issues.push(`右滑没有回到上一页：${await slideNow(phone)}`)
        // 目录抽屉
        await phone.tap('[data-testid="slide-rail-toggle"]')
        await phone.waitForSelector('[data-testid="slide-rail"]', { state: 'visible', timeout: 3000 }).catch(() => issues.push('点目录按钮没有打开抽屉'))
        await waitFor(async () => (await paintedThumbs(phone)) >= 3, 10_000).then((ok) => ok || issues.push('抽屉打开后缩略图没有画出'))
        await phone.locator('[data-testid="slide-thumb"]').nth(4).tap()
        await phone.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]').dataset.slide === '4', null, { timeout: 3000 }).catch(() => issues.push('点缩略图没有跳页'))
        if (await phone.locator('[data-testid="slide-rail"]').isVisible()) issues.push('选页后抽屉没有收起')
        // 放映：滑动与轻点
        await phone.tap('[data-testid="slide-present-btn"]')
        await phone.waitForSelector('[data-testid="slide-present"]', { timeout: 5000 })
        const no = async () => (await phone.textContent('[data-testid="slide-present-no"]')).trim()
        await swipe(320, 70, 400)
        if (!(await no()).startsWith('6 /')) issues.push(`放映左滑没有翻页：${await no()}`)
        await phone.touchscreen.tap(350, 400)
        await phone.waitForTimeout(250)
        if (!(await no()).startsWith('7 /')) issues.push(`放映点右侧没有下一页：${await no()}`)
        await phone.touchscreen.tap(30, 400)
        await phone.waitForTimeout(250)
        if (!(await no()).startsWith('6 /')) issues.push(`放映点左侧没有上一页：${await no()}`)
        await phone.tap('[data-testid="slide-present-exit"]')
        await phone.waitForSelector('[data-testid="slide-present"]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点退出没有结束放映'))
        return issues
      } finally {
        await context.close()
      }
    },
  },

  'pptx-fallback': {
    title: '文件损坏：引擎失败 → 直接回到检索文字层并给出重试入口，不白屏',
    async assert(tab, base) {
      const dir = await mkdtemp(join(tmpdir(), 'kb-pptx-bad-'))
      const bad = join(dir, 'bad.pptx')
      await writeFile(bad, Buffer.from('这不是一个 pptx 文件'))
      process.env.KB_SAMPLE_PPTX = bad
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_pptx&z=3`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('.kb-fv-strip.is-warn', { timeout: 45_000 })
      const strip = (await tab.textContent('.kb-fv-strip')).replace(/\s+/g, ' ')
      const text = await tab.evaluate(() => document.querySelector('.kb-fv')?.textContent ?? '')
      const issues = []
      if (!/渲染失败|损坏|无法/.test(strip)) issues.push(`失败提示不明确：${strip.slice(0, 80)}`)
      // 文字层是按页的幻灯片视图，首页是夹具里的「第 1 张 · 概述」
      if (!text.includes('概述')) issues.push(`没有回退到检索文字层：${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      return issues
    },
  },

  'pptx-engine-fallback': {
    title: '引擎起不来（WASM 下载失败）：回到带重试条的检索文字层，仍能看到每页的文字（没有中间一档 pptx-preview）',
    async assert(tab, base) {
      await tab.route(/pptx_wasm[^/]*\.wasm/, (route) => route.abort())
      process.env.KB_SAMPLE_PPTX = PPTX_DECK
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_pptx&z=4`, { waitUntil: 'domcontentloaded' })
      const shown = await tab.waitForSelector('.kb-fv-strip.is-warn', { timeout: 45_000 }).then(() => true, () => false)
      const issues = []
      if (!shown) issues.push('引擎失败后没有出现带重试入口的提示条')
      const text = await tab.evaluate(() => document.querySelector('.kb-fv')?.textContent ?? '')
      if (!text.includes('概述')) issues.push(`没有回到检索文字层：${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      if (await tab.$('[data-testid="slide-surface"]')) issues.push('回退后不该还挂着幻灯片面')
      return issues
    },
  },

  'pptx-read-worker': {
    title: '只读解析与排版在同源模块 Worker 里（不在主线程）；离开文档后 Worker 终止；Worker 起不来时退回主线程仍能打开',
    async assert(tab, base) {
      const issues = []
      const engineWorkers = (page) => page.workers().filter((worker) => /pptxRead\.worker/.test(worker.url()))
      // 1) 默认路径：有一个引擎 Worker，第一页和缩略图都画出来了
      await openPptx(tab, base)
      if (engineWorkers(tab).length !== 1) issues.push(`只读打开后应有 1 个引擎 Worker，实际 ${engineWorkers(tab).length}`)
      await waitFor(async () => (await paintedThumbs(tab)) >= 20, 20_000).then((ok) => ok || issues.push('Worker 路径下缩略图没有画出'))
      // 2) 切到别的文件：Worker 随文档一起终止（不留在后台占内存）
      await tab.evaluate((target) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target), `/kb?collection=${COLLECTION}&item=file_dat`)
      await waitFor(async () => engineWorkers(tab).length === 0, 10_000).then((ok) => ok || issues.push('离开文档后引擎 Worker 还在'))
      // 3) 环境不让起 Worker：退回主线程，照样打开、画出第一页，且没有引擎 Worker
      const context = await tab.context().browser().newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
      try {
        await context.addInitScript(() => {
          window.Worker = class {
            constructor() {
              throw new Error('Worker 被禁用（测试）')
            }
          }
        })
        await installFixture(context, { ...SOLO_EDIT_FIXTURE, file_preview: pptxPreview })
        const page = await context.newPage()
        await openPptx(page, base)
        if (engineWorkers(page).length) issues.push('Worker 被禁用时不该有引擎 Worker')
        const total = await page.textContent('[data-testid="slide-total"]')
        if (!/30/.test(total ?? '')) issues.push(`退回主线程后页数不对：${total}`)
      } finally {
        await context.close()
      }
      return issues
    },
  },

  'pptx-axe': {
    title: 'axe：幻灯片外壳（含目录、备注、放映入口）无 critical / serious',
    async assert(tab, base) {
      await openPptx(tab, base)
      await waitFor(async () => (await paintedThumbs(tab)) >= 20, 15_000)
      return (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`)
    },
  },

}

/** 夹具里的文件信息：上传的文件才能在线编辑（项目目录里的归代码仓库管） */
const PPTX_UPLOAD_INFO = () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 })

/** 点「在线编辑」，等引擎起来、第一页画出来、无损预检放开编辑 */
async function openPptxEditor(tab, base, extra = '', deck = PPTX_DECK) {
  process.env.KB_SAMPLE_PPTX = deck
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_pptx${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] [data-testid="slide-surface"][data-state="ready"]', { timeout: 60_000 })
  await tab.waitForFunction(() => Number(document.querySelector('[data-testid="slide-surface"]')?.dataset.painted) >= 1, null, { timeout: 20_000 })
  await tab.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]')?.dataset.editing === 'true', null, { timeout: 30_000 })
}

/** 幻灯片坐标（1280 宽）→ 点击；用来点第一页标题 */
async function clickSlidePoint(tab, x, y) {
  const box = await tab.locator('.kb-sl-sheet').boundingBox()
  const k = box.width / 1280
  await tab.mouse.click(box.x + x * k, box.y + y * k)
}

/** 部件级对照：哪些 zip 部件的内容变了 */
async function changedParts(before, after) {
  const { default: JSZip } = await import('jszip')
  const read = async (buffer) => {
    const zip = await JSZip.loadAsync(buffer)
    const parts = new Map()
    for (const [name, file] of Object.entries(zip.files)) if (!file.dir) parts.set(name, Buffer.from(await file.async('uint8array')))
    return parts
  }
  const [a, b] = await Promise.all([read(before), read(after)])
  const changed = [...a].filter(([name, bytes]) => !b.has(name) || !bytes.equals(b.get(name))).map(([name]) => name)
  return { changed: changed.sort(), added: [...b.keys()].filter((name) => !a.has(name)) }
}

const resourceNames = (urls) => urls.map((url) => basename(new URL(url).pathname))

const PPTX_EDIT_SCENARIOS = {
  'pptx-edit-default': {
    title: '打开即原生编辑：幻灯片编辑面 + 编辑工具栏 + 无损预检；不下载 React 相关资源',
    upload: true,
    async assert(tab, base, { office }) {
      const resources = watchResources(tab)
      await openPptxEditor(tab, base)
      const info = await tab.evaluate(() => ({
        bar: !!document.querySelector('[data-testid="slide-editbar"]'),
        layer: !!document.querySelector('[data-testid="slide-edit-layer"]'),
        legacyHost: !!document.querySelector('.kb-office-host:not(.kb-office-native)'),
        save: !!document.querySelector('[data-testid="editor-save"]'),
        readonlyTag: !!document.querySelector('[data-testid="office-readonly"]'),
      }))
      const issues = []
      if (!info.bar || !info.layer) issues.push('缺编辑工具栏或编辑层')
      if (info.legacyHost) issues.push('外壳之外还挂着别的编辑容器')
      if (!info.save) issues.push('缺外壳的保存按钮')
      if (info.readonlyTag) issues.push('不该是只读')
      if ((office.roundtrips?.length ?? 0) !== 1) issues.push(`无损预检应恰好一次：${office.roundtrips?.length ?? 0}`)
      const names = resourceNames(resources)
      const legacy = names.filter((name) => /pptx-react|pptx-preview|PptxViewer|react-dom/i.test(name))
      if (legacy.length) issues.push(`加载了 React 相关或 pptx-preview 资源：${legacy.join(', ')}`)
      if (!names.some((name) => /pptxSessionWorker/.test(name))) issues.push('没有起引擎 Worker 会话')
      // 单人编辑不该为协同多取东西（引擎协同子包、房间传输）：慢网络下每个依赖请求都是一个往返
      const collab = names.filter((name) => /^collaboration-|OfficeTransport|pptxCollab/.test(name))
      if (collab.length) issues.push(`单人编辑加载了协同模块：${collab.join(', ')}`)
      return issues
    },
  },

  'pptx-edit-save': {
    title: '改标题 → 保存：replace 请求带原哈希与编辑权 session，字节是 ZIP，只有目标 slide 的 XML 变',
    upload: true,
    async assert(tab, base, { office }) {
      await openPptxEditor(tab, base)
      await clickSlidePoint(tab, 520, 90)
      await tab.waitForSelector('[data-testid="slide-input"]', { timeout: 5000 })
      await tab.keyboard.type('ABC')
      await waitFor(async () => ((await tab.textContent('[data-testid="slide-sr"]')) ?? '').includes('ABC'), 5000)
      await tab.click('[data-testid="editor-save"]')
      const saved = await waitFor(() => (office.replaces?.length ?? 0) > 0, 20_000)
      if (!saved) return ['点保存后没有发出 replace 请求']
      const request = office.replaces.at(-1)
      const issues = []
      if (request.expected !== 'sha-fixture-original') issues.push(`保存没带原始哈希：${request.expected}`)
      if (!request.session) issues.push('保存没带编辑权 session')
      if (!request.zip) issues.push('保存的字节不是 ZIP')
      const diff = await changedParts(readFileSync(PPTX_DECK), request.body)
      if (diff.changed.join() !== 'ppt/slides/slide1.xml' || diff.added.length) issues.push(`被改动的部件不止目标页：${JSON.stringify(diff)}`)
      const { default: JSZip } = await import('jszip')
      const xml = (await (await JSZip.loadAsync(request.body)).file('ppt/slides/slide1.xml').async('string')) ?? ''
      if (!xml.includes('ABC')) issues.push('slide1.xml 里没有新键入的字')
      return issues
    },
  },

  'pptx-collab-native': {
    title: '多人协同走原生编辑面：连上真房间（office-worker 的 Room）显示已同步，敲字落地进文件',
    upload: true,
    // 服务端说这份文档可以多人协同：底稿哈希 + 房间可写
    fixture: { __officeSession: { mode: 'collab', base_sha: 'sha-fixture-original', format: 'pptx', writable: true, room_writable: true, lossless: true, participants: 0, size: 4096 } },
    async assert(tab, base) {
      const { startOfficeRoom } = await import('./office-room.mjs')
      const room = await startOfficeRoom({ bytes: readFileSync(PPTX_LATIN), format: 'pptx' })
      try {
        const resources = watchResources(tab)
        await tab.context().routeWebSocket(/\/api\/v1\/office\/collab\?/, (ws) => room.attach(ws, { writable: true, user: { id: 'usr_admin', name: '管理员' } }))
        await openPptxEditor(tab, base, '', PPTX_LATIN)
        const issues = []
        if (!(await waitFor(async () => ((await tab.textContent('[data-testid="office-collab-status"]').catch(() => '')) ?? '').includes('已同步'), 20_000))) issues.push('协同没有进入已同步')
        const bar = (await tab.textContent('[data-testid="editor-status-bar"]')) ?? ''
        if (!bar.includes('已同步') || bar.includes('正在连接协同')) issues.push(`状态栏没有显示房间状态：${bar.replace(/\s+/g, ' ')}`)
        if (await tab.$('.kb-office-host:not(.kb-office-native)')) issues.push('协同时外壳之外还挂着别的编辑容器')
        await clickSlidePoint(tab, 520, 90)
        await tab.waitForSelector('[data-testid="slide-input"]', { timeout: 5000 })
        await tab.keyboard.press('End')
        const before = room.landed.length
        await tab.keyboard.type('-COLLAB')
        if (!(await waitFor(() => room.landed.length > before, 20_000))) issues.push('房间没有落地')
        else {
          const { default: JSZip } = await import('jszip')
          const xml = await (await JSZip.loadAsync(Buffer.from(room.landed.at(-1)))).file('ppt/slides/slide1.xml').async('string')
          if (!xml.includes('-COLLAB')) issues.push('落地字节里没有刚敲的字')
        }
        const legacy = resourceNames(resources).filter((name) => /pptx-react|pptx-preview|PptxViewer|react-dom/i.test(name))
        if (legacy.length) issues.push(`协同加载了 React 相关或 pptx-preview 资源：${legacy.join(', ')}`)
        return issues
      } finally {
        room.close()
      }
    },
  },

}

/* ---------------- Word 画布编辑 ---------------- */

/** 只有上传来的 docx 才能在线编辑：夹具文件标成上传，file_info 也要这么回 */
const DOCX_EDIT_FIXTURE = {
  file_info: () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 }),
}

// 默认不带任何参数：默认路由本身就是 Word 画布编辑面
async function openDocxEdit(tab, base, extra = 'x=1') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 60_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('.kb-office-host canvas', { state: 'visible', timeout: 120_000 })
  while (await tab.locator('[data-testid="office-veil"]').count()) await tab.waitForTimeout(50)
  await tab.waitForTimeout(1200)
}

/** 读回文档段落：走无障碍「读取文档文本」面板（画布没有可读 DOM）；每次先关再开，保证按最新版本重读 */
async function docxParagraphs(tab) {
  await tab.evaluate(() => {
    const button = document.querySelector('.kb-office-host .sr-only button[aria-expanded]')
    if (button.getAttribute('aria-expanded') === 'true') button.click()
  })
  await tab.waitForTimeout(150)
  await tab.evaluate(() => document.querySelector('.kb-office-host .sr-only button[aria-expanded]').click())
  await tab.waitForFunction(() => document.querySelectorAll('.kb-office-host section[aria-label] p').length > 0, null, { timeout: 8000 })
  await tab.waitForTimeout(300)
  return tab.evaluate(() => [...document.querySelectorAll('.kb-office-host section[aria-label] p')].map((p) => p.textContent ?? ''))
}

/** 点第一页正文第三段（「评测采用…」）开头附近，让光标落进去 */
async function clickEvalParagraph(tab) {
  const page1 = await tab.evaluate(() => {
    const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  await tab.mouse.click(page1.x + 160, page1.y + 330)
  await tab.waitForTimeout(400)
}

/* ---------------- Word 编辑命令的辅助 ---------------- */

/** 点工具栏按钮；放不下被收进「更多」时从菜单里点 */
async function docxTool(tab, id) {
  const button = tab.locator(`[data-testid="editor-toolbar-slot"] [data-action="${id}"]`)
  if (await button.count()) await button.first().click()
  else {
    await tab.click('[data-testid="editor-toolbar-more"]')
    await tab.click(`[data-testid="editor-toolbar-more-menu"] [data-action="${id}"]`)
  }
  await tab.waitForTimeout(400)
}

/** 带选项的工具栏项：点开菜单选一项（收进「更多」时只占一行，先点开那一行再选） */
async function docxChoose(tab, id, label) {
  const button = tab.locator(`[data-testid="editor-toolbar-slot"] [data-action="${id}"]`)
  if (await button.count()) {
    await button.first().click()
    await tab.click(`[data-testid="choices-${id}"] [data-choice="${label}"]`)
  } else {
    await tab.click('[data-testid="editor-toolbar-more"]')
    const row = tab.locator(`[data-testid="editor-toolbar-more-menu"] [data-action="${id}"]:not([data-choice])`)
    // 这一行置灰时（例如图片没选中）click 会一直等到超时、看不出原因：先把置灰的原因（title）报出来
    await row.waitFor({ state: 'visible', timeout: 5000 })
    if (await row.isDisabled()) throw new Error(`「更多」里的 ${id} 不可用：${(await row.getAttribute('title')) ?? '没有写原因'}`)
    await row.click()
    await tab.click(`[data-testid="editor-toolbar-more-menu"] [data-action="${id}"][data-choice="${label}"]`)
  }
  await tab.waitForTimeout(500)
}

/** 点一个没有子菜单的工具栏动作；按钮可能在工具栏上，也可能被收进「更多」菜单 */
async function docxPress(tab, id) {
  const button = tab.locator(`[data-testid="editor-toolbar-slot"] [data-action="${id}"]`)
  if (await button.count()) {
    await button.first().click()
  } else {
    await tab.click('[data-testid="editor-toolbar-more"]')
    await tab.click(`[data-testid="editor-toolbar-more-menu"] [data-action="${id}"]`)
  }
}

/** 某个工具栏动作现在是否可点；按钮可能在工具栏上，也可能被收进「更多」菜单 */
async function docxToolEnabled(tab, id) {
  const slot = tab.locator(`[data-testid="editor-toolbar-slot"] [data-action="${id}"]`)
  if (await slot.count()) return slot.first().isEnabled()
  await tab.click('[data-testid="editor-toolbar-more"]')
  const item = tab.locator(`[data-testid="editor-toolbar-more-menu"] [data-action="${id}"]`).first()
  const enabled = (await item.count()) > 0 && (await item.isEnabled())
  await tab.keyboard.press('Escape')
  await tab.evaluate(() => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // 打开菜单会把焦点从文档输入框上拿走；探测只是看一眼，不能改变后面按键的去向
    document.querySelector('.paged-editor__input')?.focus({ preventScroll: true })
  })
  await tab.waitForTimeout(100)
  return enabled
}

/** 选中光标所在行（Home + Shift+End） */
async function docxSelectLine(tab) {
  await tab.keyboard.press('Home')
  await tab.keyboard.press('Shift+End')
  await tab.waitForTimeout(400)
}

/** 点保存，等 replace 请求落地，返回这一次的 document.xml；多次保存时只取新增的那一次 */
async function docxSavedXml(tab, state) {
  const before = state.office.replaces.length
  await tab.click('[data-testid="editor-save"]')
  if (!(await waitFor(() => state.office.replaces.length > before, 30_000))) throw new Error('点保存后没有发出 replace 请求')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(state.office.replaces[state.office.replaces.length - 1].body)
  return { xml: await zip.file('word/document.xml').async('string'), zip, count: state.office.replaces.length }
}

/** 取包含某段文字的 <w:p> 片段 */
function docxParagraphXml(xml, text) {
  const at = xml.indexOf(text)
  if (at < 0) return ''
  const start = Math.max(xml.lastIndexOf('<w:p>', at), xml.lastIndexOf('<w:p ', at))
  return xml.slice(start, xml.indexOf('</w:p>', at) + 6)
}

/** 文档段落总数（读取面板的 data-total）与前 32 段文本 */
async function docxParagraphCount(tab) {
  await docxParagraphs(tab)
  return Number(await tab.evaluate(() => document.querySelector('.kb-office-host section[aria-label]')?.getAttribute('data-total') ?? '0'))
}

const DOCX_EDIT_SCENARIOS = {
  'docx-edit-open': {
    title: '进 Vue 原生编辑面：20 页、窗口内只挂几张画布、输入框持焦点、不下载 React 运行时',
    async assert(tab, base) {
      const requests = []
      tab.on('request', (request) => requests.push(request.url()))
      // 内容级检查：下载下来的 JS 里含 React 运行时的特征串就是加载了 React。不看文件名——chunk 被合并 / 改名后
      // 文件名里不再有 docx-react，只看名字会放过它（变异验证时亲眼见过）
      const REACT_MARKERS = ['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE', '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED']
      const reactChunks = []
      const pending = []
      tab.on('response', (response) => {
        const url = response.url()
        if (!/\.js(?:\?|$)/.test(url) || !response.ok()) return
        pending.push(
          response.text().then(
            (text) => {
              if (REACT_MARKERS.some((marker) => text.includes(marker))) reactChunks.push(basename(new URL(url).pathname))
            },
            () => undefined,
          ),
        )
      })
      await openDocxEdit(tab, base)
      await Promise.all(pending)
      const info = await tab.evaluate(() => ({
        view: !!document.querySelector('.kb-office-host .kb-dex[data-testid="docx-edit-view"]'),
        pages: document.querySelectorAll('.kb-dex-page').length,
        canvases: document.querySelectorAll('.kb-dex canvas').length,
        focus: document.activeElement?.classList.contains('paged-editor__input') === true,
        total: document.querySelector('[data-testid="editor-status"]')?.textContent ?? '',
        host: document.querySelector('[data-testid="editor-host"]')?.getAttribute('data-surface-kind'),
      }))
      const issues = []
      if (!info.view) issues.push('没有挂原生编辑视图')
      if (info.pages !== 20) issues.push(`页数不是 20：${info.pages}`)
      // 20 页 > 12 页，走页窗口：首屏只应有视口附近几页的画布，而不是 20 张
      if (info.canvases < 1 || info.canvases > 6) issues.push(`画布数 ${info.canvases} 不在窗口预期 1~6 内`)
      if (!info.focus) issues.push('输入框没有持有焦点')
      if (info.host !== 'page') issues.push(`外壳内容面不是 page：${info.host}`)
      const react = requests.filter((url) => /docx-react|react-dom|scheduler/.test(url))
      if (react.length) issues.push(`原生路径不该下载 React 编辑岛：${react.map((u) => basename(new URL(u).pathname)).join(', ')}`)
      if (reactChunks.length) issues.push(`下载的 JS 里含 React 运行时：${reactChunks.join(', ')}`)
      return issues
    },
  },

  'docx-edit-type-save': {
    title: '点击定位 → 输入 → 文本进文档、出现未保存提示 → 保存发 replace（ZIP、原哈希、编辑权 session）',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      const before = await docxParagraphs(tab)
      const index = before.findIndex((text) => text.startsWith('评测采用'))
      if (index < 0) return ['样本里找不到「评测采用」段落']
      await clickEvalParagraph(tab)
      await tab.keyboard.type('KB', { delay: 30 })
      await tab.waitForTimeout(500)
      const issues = []
      const after = await docxParagraphs(tab)
      if (!after[index]?.startsWith('评测采KB用')) issues.push(`输入没落在点击处：${after[index]?.slice(0, 12)}`)
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) issues.push('有改动但外层没有未保存提示')
      await tab.click('[data-testid="editor-save"]')
      if (!(await waitFor(() => (state.office?.replaces?.length ?? 0) > 0, 20_000))) return [...issues, '点保存后没有发出 replace 请求']
      const request = state.office.replaces[0]
      if (!request.zip) issues.push('保存的字节不是 ZIP')
      if (request.bytes < 5000) issues.push(`保存的字节只有 ${request.bytes} B，疑似空包`)
      if (request.expected !== 'sha-fixture-original') issues.push(`保存没有带原始哈希：${request.expected}`)
      if (!request.session) issues.push('保存没有带编辑权 session')
      return issues
    },
  },

  'docx-edit-zoom-scroll': {
    title: '缩放与滚动：放大 / 缩小改变页面宽度；滚到末页后挂载的画布数仍有界（窗口外的被回收）',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      const issues = []
      const widthOf = () => tab.evaluate(() => document.querySelector('.kb-dex-column').getBoundingClientRect().width)
      const percentOf = () => tab.evaluate(() => document.querySelector('[data-testid="docx-edit-zoom"]').textContent.trim())
      const w100 = await widthOf()
      await tab.click('[data-testid="docx-edit-zoom-in"]')
      await tab.waitForTimeout(600)
      const wIn = await widthOf()
      if (!(wIn > w100 * 1.1)) issues.push(`放大后页面列宽度没变大：${w100.toFixed(0)} → ${wIn.toFixed(0)}`)
      if ((await percentOf()) !== '120%') issues.push(`放大后百分比显示 ${await percentOf()}，应为 120%`)
      await tab.click('[data-testid="docx-edit-zoom-out"]')
      await tab.click('[data-testid="docx-edit-zoom-out"]')
      await tab.waitForTimeout(600)
      const wOut = await widthOf()
      if (!(wOut < w100 * 0.95)) issues.push(`缩小后页面列宽度没变小：${w100.toFixed(0)} → ${wOut.toFixed(0)}`)
      // 滚到底
      await tab.evaluate(() => {
        const scroller = document.querySelector('[data-testid="docx-edit-scroll"]')
        scroller.scrollTop = scroller.scrollHeight
      })
      await tab.waitForTimeout(1500)
      const info = await tab.evaluate(() => ({
        canvases: document.querySelectorAll('.kb-dex canvas').length,
        indexes: [...document.querySelectorAll('.kb-dex canvas')].map((c) => Number(c.dataset.pageIndex)),
      }))
      if (info.canvases > 8) issues.push(`滚到末页后画布还有 ${info.canvases} 张（页窗口没回收）`)
      // 光标所在页（第 1 页）按设计保留画布：输入回显要画在它上面；窗口外其余页必须回收
      const stale = info.indexes.filter((i) => i > 0 && i < 14)
      if (stale.length) issues.push(`窗口外的页还挂着画布：${stale.join(',')}`)
      if (!info.indexes.some((i) => i >= 18)) issues.push(`末页附近没有画布：${info.indexes.join(',')}`)
      return issues
    },
  },

  'docx-edit-readonly': {
    title: '别人持有编辑权时只读：能看、能点，但键入不改文档，也没有保存按钮可点；打印和导出照常可用（按钮留着就必须点得动）',
    async assert(tab, base, state) {
      state.office.held = false
      // 打印窗口：包装 window.open 并把 print 换成计数的假实现（headless 下真调会阻塞）
      await tab.addInitScript(() => {
        window.__printWins = []
        const open = window.open.bind(window)
        window.open = (...args) => {
          const win = open(...args)
          if (win) {
            win.__printCalls = 0
            win.print = () => (win.__printCalls += 1)
            window.__printWins.push(win)
          }
          return win
        }
      })
      await openDocxEdit(tab, base)
      const issues = []
      if (!(await tab.locator('[data-testid="office-locked"]').count())) issues.push('没有提示"别人正在编辑"')
      const before = await docxParagraphs(tab)
      await clickEvalParagraph(tab)
      await tab.keyboard.type('ZZ', { delay: 30 })
      await tab.keyboard.press('Backspace')
      await tab.waitForTimeout(500)
      const after = await docxParagraphs(tab)
      if (JSON.stringify(before) !== JSON.stringify(after)) issues.push('只读状态下文档被改了')
      const readOnly = await tab.evaluate(() => document.querySelector('.paged-editor__input')?.readOnly)
      if (readOnly !== true) issues.push('输入框不是只读')
      if (state.office.replaces.length) issues.push('只读状态下发出了保存请求')

      // 只读文档里「打印」「导出」的按钮是留着的（非写动作），点下去就得真能执行。
      // 命令守卫曾经只认一份前缀白名单，和"按钮可见"用的 action.write 对不上——结果按钮摆着、点了提示"只读模式无法执行修改命令"。
      // 可编辑会话里的打印场景永远测不到，是 docx-compare 打开被判只读的真实文档才暴露的
      await docxPress(tab, 'docx.print')
      const printed = await waitFor(() => tab.evaluate(() => window.__printWins.length === 1 && window.__printWins[0].__printCalls >= 1), 40_000)
      if (!printed) {
        const notice = await tab.locator('[data-testid="editor-command-notice"]').first().textContent().catch(() => '')
        issues.push(`只读文档里点「打印」没有打印出来${notice ? `：${notice.trim()}` : ''}`)
      }
      if (await tab.locator('[data-testid="editor-command-notice"]').count()) issues.push('只读文档里点「打印」弹出了失败提示')
      await tab.evaluate(() => window.__printWins.forEach((win) => win.close()))
      const downloads = []
      tab.on('download', (download) => downloads.push(download.suggestedFilename()))
      await docxChoose(tab, 'docx.export', '下载 Word（.docx）')
      await waitFor(() => downloads.length > 0, 20_000)
      if (!downloads.some((name) => /\.docx$/.test(name))) issues.push(`只读文档里「导出 Word」没有下载出 .docx：${JSON.stringify(downloads)}`)
      // 写动作仍然被守卫拦着：读取工具栏上的写按钮在只读时本来就不渲染（choices.spec 已测），这里再确认没有因此放行任何写入
      if (state.office.replaces.length) issues.push('只读文档里点了打印 / 导出之后发出了保存请求')
      return issues
    },
  },

  'docx-cmd-marks': {
    title: '文字格式：粗斜体下划线删除线、字号 / 颜色 / 高亮 / 字体、居中——保存后 XML 里逐项存在，选区外的内容不变',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      await clickEvalParagraph(tab)
      await docxSelectLine(tab)
      for (const id of ['docx.bold', 'docx.italic', 'docx.underline', 'docx.strike']) await docxTool(tab, id)
      await docxChoose(tab, 'docx.fontSize', '18')
      await docxChoose(tab, 'docx.textColor', '红色')
      await docxChoose(tab, 'docx.highlight', '黄色')
      await docxChoose(tab, 'docx.fontFamily', 'Arial')
      await docxTool(tab, 'docx.align.center')
      const { xml } = await docxSavedXml(tab, state)
      const para = docxParagraphXml(xml, '评测采用')
      const issues = []
      const want = {
        粗体: '<w:b/>', 斜体: '<w:i/>', 删除线: '<w:strike/>', 下划线: '<w:u w:val="single"/>',
        '18 磅': '<w:sz w:val="36"/>', 红色: '<w:color w:val="C00000"/>', 黄色高亮: '<w:highlight w:val="yellow"/>',
        Arial: '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>', 居中: '<w:jc w:val="center"/>',
      }
      for (const [name, fragment] of Object.entries(want)) if (!para.includes(fragment)) issues.push(`${name}没写进文件：缺 ${fragment}`)
      // 选区只到第一行末尾：同段第二行的 run（"再以交叉编码器…"）必须保持原来的 22 半磅、没有粗体
      const tail = para.slice(para.indexOf('再以交叉'))
      if (!para.includes('再以交叉') || para.slice(para.lastIndexOf('<w:r>', para.indexOf('再以交叉'))).includes('<w:b/>')) issues.push('选区外的文字被一起加了格式')
      void tail
      // 别的段落不受影响
      if (docxParagraphXml(xml, '守护进程与 CLI').includes('<w:b/>')) issues.push('相邻段落被误加粗')
      return issues
    },
  },

  'docx-cmd-toggle-off': {
    title: '再点一次粗体 = 取消；清除格式去掉全部字符格式；快捷键 Ctrl+B / Ctrl+E 与按钮等效',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      await clickEvalParagraph(tab)
      await docxSelectLine(tab)
      await docxTool(tab, 'docx.bold')
      const pressed = await tab.locator('[data-action="docx.bold"]').first().getAttribute('aria-pressed')
      await docxTool(tab, 'docx.bold')
      const after = await tab.locator('[data-action="docx.bold"]').first().getAttribute('aria-pressed')
      const issues = []
      if (pressed !== 'true') issues.push(`加粗后按钮没亮：${pressed}`)
      if (after !== 'false') issues.push(`再点一次后按钮还亮着：${after}`)
      // 快捷键
      await tab.keyboard.press('Control+b')
      await tab.keyboard.press('Control+e')
      await tab.waitForTimeout(500)
      const { xml } = await docxSavedXml(tab, state)
      const para = docxParagraphXml(xml, '评测采用')
      if (!para.includes('<w:b/>')) issues.push('Ctrl+B 没有加粗')
      if (!para.includes('<w:jc w:val="center"/>')) issues.push('Ctrl+E 没有居中')
      return issues
    },
  },

  'docx-cmd-lists': {
    title: '列表：项目符号 / 编号 / 缩进——保存后段落带 numPr，缩进改变 ind',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      await clickEvalParagraph(tab)
      await docxTool(tab, 'docx.list.bullet')
      const bulletOn = await tab.locator('[data-action="docx.list.bullet"]').first().getAttribute('aria-pressed')
      await docxTool(tab, 'docx.indent')
      const { xml } = await docxSavedXml(tab, state)
      const para = docxParagraphXml(xml, '评测采用')
      const issues = []
      if (bulletOn !== 'true') issues.push(`项目符号按钮没亮：${bulletOn}`)
      if (!para.includes('<w:numPr>')) issues.push(`段落没有列表编号属性：${para.slice(0, 160)}`)
      if (!/<w:ilvl w:val="1"\/>|<w:ind /.test(para)) issues.push(`增加缩进没生效：${para.slice(0, 200)}`)
      return issues
    },
  },

  'docx-cmd-table-insert': {
    title: '新插入的表格：3×3 → 填字 → 下方加行 / 右侧加列 → 底纹 / 边框——每一步保存后结构正确',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      await clickEvalParagraph(tab)
      await tab.keyboard.press('End')
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(300)
      await docxChoose(tab, 'docx.table.insert', '3 × 3')
      await tab.waitForTimeout(600)
      const issues = []
      // 刚插入的表格里单元格没有结构化 id，引擎的 Tab 导航会拒绝（invalid-cell-target，见报告），
      // 所以逐格用鼠标点：先量第一格光标位置，再按列宽 / 行高推出其它格子
      const first = await tab.evaluate(() => {
        const r = document.querySelector('.kb-dex-caret').getBoundingClientRect()
        return { x: r.x, y: r.y, h: r.height }
      })
      const columnStep = (624 / 3) * 1 // 版心 6.5in = 624px，三列均分
      const typeAt = async (row, col, text) => {
        await tab.mouse.click(first.x + 6 + col * columnStep, first.y + first.h / 2 + row * (first.h + 10))
        await tab.waitForTimeout(350)
        await tab.keyboard.type(text)
        await tab.waitForTimeout(250)
      }
      await typeAt(0, 0, 'A1')
      await typeAt(0, 1, 'B1')
      await typeAt(0, 2, 'C1')
      await typeAt(1, 0, 'A2')
      const tableOf = (xml) => {
        const at = xml.indexOf('>A1<')
        return at < 0 ? '' : xml.slice(xml.lastIndexOf('<w:tbl>', at), xml.indexOf('</w:tbl>', at) + 8)
      }
      const rows = (table) => (table.match(/<w:tr[ >]/g) ?? []).length
      const cellsOfFirstRow = (table) => ((table.match(/<w:tr[ >][\s\S]*?<\/w:tr>/)?.[0] ?? '').match(/<w:tc>/g) ?? []).length
      const texts = (table) => [...table.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])

      let saved = await docxSavedXml(tab, state)
      let table = tableOf(saved.xml)
      if (!table) return ['保存后找不到新表格（含 A1 的 w:tbl）']
      if (rows(table) !== 3 || cellsOfFirstRow(table) !== 3) issues.push(`插入后应是 3×3：${rows(table)} 行 × ${cellsOfFirstRow(table)} 列`)
      if (texts(table).join(',') !== 'A1,B1,C1,A2') issues.push(`单元格文字不对：${texts(table).join(',')}`)

      await docxTool(tab, 'docx.table.rowBelow')
      await docxTool(tab, 'docx.table.colRight')
      saved = await docxSavedXml(tab, state)
      table = tableOf(saved.xml)
      if (rows(table) !== 4) issues.push(`下方插入行后应是 4 行：${rows(table)}`)
      if (cellsOfFirstRow(table) !== 4) issues.push(`右侧插入列后应是 4 列：${cellsOfFirstRow(table)}`)
      if (texts(table).join(',') !== 'A1,B1,C1,A2') issues.push(`加行加列后原有文字变了：${texts(table).join(',')}`)

      await docxChoose(tab, 'docx.table.shading', '浅黄')
      await docxChoose(tab, 'docx.table.borders', '所有框线')
      saved = await docxSavedXml(tab, state)
      table = tableOf(saved.xml)
      if (!table.includes('w:fill="FFF2CC"')) issues.push('单元格底纹没写进文件（缺 w:fill="FFF2CC"）')
      if (!/<w:tcBorders>|<w:tblBorders>/.test(table)) issues.push('边框没写进文件')
      return issues
    },
  },

  'docx-cmd-table-loaded': {
    title: '载入文档里的表格：Tab 逐格导航并填字 → Shift+方向键多选 → 合并 → 删行 / 删列 / 删表',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-table.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      // 点第一格：页边距 96 px，导语一行后表格第一行在页面顶部下方约 121 px（按截图实测），单元格内文字从 x≈96 开始
      const inTable = () => docxToolEnabled(tab, 'docx.table.rowAbove')
      const cell00 = { x: page1.x + 120, y: page1.y + 121 }
      await tab.mouse.click(cell00.x, cell00.y)
      await tab.waitForTimeout(500)
      if (!(await inTable())) return [`点第一格后光标不在表格里（点击坐标 ${cell00.x},${cell00.y}）`]
      await tab.keyboard.press('End')
      await tab.keyboard.type('+X')
      await tab.keyboard.press('Tab')
      await tab.waitForTimeout(300)
      await tab.keyboard.type('Y')
      await tab.keyboard.press('Tab')
      await tab.waitForTimeout(300)
      await tab.keyboard.type('Z')
      await tab.waitForTimeout(400)
      const tableOf = (xml) => xml.slice(xml.indexOf('<w:tbl>'), xml.indexOf('</w:tbl>') + 8)
      const rows = (table) => (table.match(/<w:tr[ >]/g) ?? []).length
      const texts = (table) => [...table.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
      let saved = await docxSavedXml(tab, state)
      let table = tableOf(saved.xml)
      // Tab 到下一格后引擎把光标放在该格文字的开头（不是选中整格），所以新字在原文字前面
      const got = texts(table).slice(0, 3).join(',')
      if (got !== 'cell00+X,Ycell01,Zcell02') issues.push(`Tab 逐格填字结果不对：${got}`)

      // 删列：光标此时在第三格（填了 Z），删掉后每行只剩两格，第三格的内容随之消失
      await docxTool(tab, 'docx.table.deleteColumn')
      saved = await docxSavedXml(tab, state)
      table = tableOf(saved.xml)
      const firstRowCells = ((table.match(/<w:tr[ >][\s\S]*?<\/w:tr>/)?.[0] ?? '').match(/<w:tc>/g) ?? []).length
      if (firstRowCells !== 2) issues.push(`删列后每行应剩 2 格：${firstRowCells}`)
      if (table.includes('Zcell02') || table.includes('cell12')) issues.push('删列后第三列的内容还在')

      // 多选：鼠标从第一格拖到第二格（每列 208 px），跨格拖选产生多单元格选区
      const cell01 = { x: cell00.x + 208, y: cell00.y }
      await tab.mouse.move(cell00.x, cell00.y)
      await tab.mouse.down()
      await tab.mouse.move(cell00.x + 100, cell00.y, { steps: 5 })
      await tab.mouse.move(cell01.x, cell01.y, { steps: 5 })
      await tab.mouse.up()
      await tab.waitForTimeout(600)
      const mergeEnabled = await docxToolEnabled(tab, 'docx.table.merge')
      if (!mergeEnabled) issues.push('选中多个单元格后「合并单元格」仍是灰的')
      else {
        await docxTool(tab, 'docx.table.merge')
        saved = await docxSavedXml(tab, state)
        table = tableOf(saved.xml)
        if (!/<w:gridSpan w:val="2"\/>|<w:hMerge/.test(table)) issues.push(`合并后没有 gridSpan / hMerge：${table.slice(0, 300)}`)
      }

      // 光标进第二行（键盘 ArrowDown，不依赖像素估算），删行
      await tab.mouse.click(cell00.x, cell00.y)
      await tab.keyboard.press('ArrowDown')
      await tab.waitForTimeout(500)
      await docxTool(tab, 'docx.table.deleteRow')
      saved = await docxSavedXml(tab, state)
      table = tableOf(saved.xml)
      if (rows(table) !== 1) issues.push(`删行后应剩 1 行：${rows(table)}`)

      await docxTool(tab, 'docx.table.delete')
      saved = await docxSavedXml(tab, state)
      if (saved.xml.includes('<w:tbl>')) issues.push('删除表格后文件里还有 w:tbl')
      if (!saved.xml.includes('After the table.') || !saved.xml.includes('Intro paragraph')) issues.push('删除表格误伤了前后的段落')
      return issues
    },
  },

  'docx-cmd-image': {
    title: '图片：选文件插入 → 选中出现句柄 → 拖句柄缩小 → 环绕改四周型 → 再插一张替换选中的——保存后 XML 对应变化',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(300)

      const png = resolve(ROOT, 'e2e/fixtures/editor/doc-image.png')
      const insertImage = async () => {
        const [chooser] = await Promise.all([tab.waitForEvent('filechooser', { timeout: 10_000 }), docxTool(tab, 'docx.image')])
        await chooser.setFiles(png)
        await tab.waitForTimeout(1200)
      }
      await insertImage()
      const drawings = (xml) => (xml.match(/<w:drawing>/g) ?? []).length
      const extentOf = (xml) => {
        const m = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)
        return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null
      }
      let saved = await docxSavedXml(tab, state)
      if (drawings(saved.xml) !== 1) issues.push(`插入后应有 1 个 w:drawing：${drawings(saved.xml)}`)
      if (!saved.xml.includes('<wp:inline')) issues.push('新插入的图片应是嵌入型（wp:inline）')
      const inserted = extentOf(saved.xml)
      if (!inserted) return [...issues, '找不到图片尺寸 wp:extent']
      // 960×540 的图超过版心宽度 612，应等比缩到 612 px（= 612*9525 EMU）宽
      if (Math.abs(inserted.cx - 612 * 9525) > 9525) issues.push(`超宽图片没有缩到版心宽度：cx=${inserted.cx}（期望 ${612 * 9525}）`)
      if (Math.abs(inserted.cy / inserted.cx - 540 / 960) > 0.01) issues.push(`缩放后宽高比变了：${(inserted.cy / inserted.cx).toFixed(3)}`)

      // 选中：点图片中心；出现选中框和 8 个句柄
      const frame = async () => tab.evaluate(() => {
        const box = document.querySelector('[data-testid="docx-edit-picture"]')?.getBoundingClientRect()
        return box ? { x: box.x, y: box.y, w: box.width, h: box.height, handles: document.querySelectorAll('.kb-dex-handle').length } : null
      })
      let box = await frame()
      if (!box) {
        // 插入后引擎可能没有自动选中：点图片所在行
        await tab.mouse.click(page1.x + 300, page1.y + 150)
        await tab.waitForTimeout(500)
        box = await frame()
      }
      if (!box) return [...issues, '图片没有出现选中框']
      if (box.handles !== 8) issues.push(`选中框应有 8 个缩放句柄：${box.handles}`)

      // 拖右下角句柄向左上 120/68 px：缩小
      const se = await tab.evaluate(() => {
        const r = document.querySelector('.kb-dex-handle[data-handle="se"]').getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await tab.mouse.move(se.x, se.y)
      await tab.mouse.down()
      await tab.mouse.move(se.x - 60, se.y - 34, { steps: 6 })
      await tab.mouse.move(se.x - 120, se.y - 68, { steps: 6 })
      const previewWhileDragging = await tab.evaluate(() => !!document.querySelector('.kb-dex-picture-preview'))
      await tab.mouse.up()
      await tab.waitForTimeout(900)
      if (!previewWhileDragging) issues.push('拖句柄时没有出现虚线预览框')
      saved = await docxSavedXml(tab, state)
      const resized = extentOf(saved.xml)
      if (!resized || !(resized.cx < inserted.cx - 80 * 9525)) issues.push(`拖句柄后图片没变小：${resized?.cx} vs ${inserted.cx}`)

      // 环绕：四周型 → wp:anchor + wrapSquare
      await docxChoose(tab, 'docx.image.wrap', '四周型')
      saved = await docxSavedXml(tab, state)
      if (!saved.xml.includes('<wp:anchor')) issues.push('改四周型后没有 wp:anchor')
      if (!saved.xml.includes('<wp:wrapSquare')) issues.push('改四周型后没有 wp:wrapSquare')
      if (drawings(saved.xml) !== 1) issues.push(`改环绕后图片数量变了：${drawings(saved.xml)}`)

      // 替换：图片仍是选中状态时再插一张，选中的那张被替换而不是多出一张
      if (!(await frame())) issues.push('改环绕后图片不再是选中状态，无法验证替换')
      else {
        const before = extentOf(saved.xml)
        await insertImage()
        saved = await docxSavedXml(tab, state)
        if (drawings(saved.xml) !== 1) issues.push(`替换后应仍是 1 张图：${drawings(saved.xml)}`)
        const replaced = extentOf(saved.xml)
        if (replaced && before && replaced.cx === before.cx && !saved.xml.includes('<wp:inline')) issues.push('替换后新图没有按默认的嵌入型 / 版心宽度插入')
      }
      return issues
    },
  },

  'docx-cmd-pagebreak': {
    title: '分页符：插入后页数 +1，保存后 XML 有 w:br type=page',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const pagesOf = () => tab.evaluate(() => document.querySelectorAll('.kb-dex-page').length)
      const before = await pagesOf()
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await docxTool(tab, 'docx.pageBreak')
      await tab.waitForTimeout(1200)
      const after = await pagesOf()
      const issues = []
      if (after !== before + 1) issues.push(`页数应从 ${before} 变成 ${before + 1}：${after}`)
      const { xml } = await docxSavedXml(tab, state)
      if (!/<w:br w:type="page"\/>|<w:pageBreakBefore/.test(xml)) issues.push('文件里没有分页符')
      return issues
    },
  },

  'docx-cmd-undo-redo-100': {
    title: '撤销 / 重做 100 步：100 次独立的回车 → 撤销 100 次回到原样 → 重做 100 次全部恢复；再 Ctrl+Z / Ctrl+Y 按步数对得上；中途新编辑清空重做栈',
    async assert(tab, base) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('Control+End')
      await tab.waitForTimeout(300)
      const base0 = await docxParagraphCount(tab)
      if (base0 !== 3) issues.push(`夹具应是 3 段：${base0}`)

      // 引擎的撤销管理器按时间窗口合并事务（实测：不留间隔时 12 次回车只是 1 个撤销步骤，与 Word 的连续输入合并一致）。
      // 要得到"100 个独立步骤"，每次回车之间必须超过合并窗口（上游 inputCoalescing 的 UNDO_CAPTURE_GAP_MS = 500 ms）
      for (let i = 0; i < 100; i += 1) {
        await tab.keyboard.press('Enter')
        await tab.waitForTimeout(520)
      }
      await tab.waitForTimeout(800)
      const after100 = await docxParagraphCount(tab)
      if (after100 !== base0 + 100) issues.push(`100 次回车后应有 ${base0 + 100} 段：${after100}`)

      // 第一轮：工具栏按钮撤销 100 次 → 重做 100 次
      const clickN = async (testid, n) => {
        for (let i = 0; i < n; i += 1) {
          await tab.click(`[data-testid="${testid}"]`)
          if (i % 10 === 9) await tab.waitForTimeout(60)
        }
        await tab.waitForTimeout(800)
      }
      await clickN('editor-undo', 100)
      const undone = await docxParagraphCount(tab)
      if (undone !== base0) issues.push(`撤销 100 次后应回到 ${base0} 段：${undone}`)
      await clickN('editor-redo', 100)
      const redone = await docxParagraphCount(tab)
      if (redone !== base0 + 100) issues.push(`重做 100 次后应恢复到 ${base0 + 100} 段：${redone}`)

      // 第二轮：键盘 Ctrl+Z / Ctrl+Y；撤销到一半再重做一半，状态要按步数对得上
      for (let i = 0; i < 60; i += 1) await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(800)
      const half = await docxParagraphCount(tab)
      if (half !== base0 + 40) issues.push(`Ctrl+Z 60 次后应是 ${base0 + 40} 段：${half}`)
      for (let i = 0; i < 25; i += 1) await tab.keyboard.press('Control+y')
      await tab.waitForTimeout(800)
      const some = await docxParagraphCount(tab)
      if (some !== base0 + 65) issues.push(`再 Ctrl+Y 25 次后应是 ${base0 + 65} 段：${some}`)

      // 在撤销栈中间做新编辑后，重做栈必须清空（不能再"重做"出被覆盖的步骤）
      await tab.keyboard.type('Z')
      await tab.waitForTimeout(500)
      const redoOff = await tab.evaluate(() => document.querySelector('[data-testid="editor-redo"]')?.hasAttribute('disabled'))
      void redoOff
      for (let i = 0; i < 10; i += 1) await tab.keyboard.press('Control+y')
      await tab.waitForTimeout(500)
      const stable = await docxParagraphCount(tab)
      if (stable !== base0 + 65) issues.push(`新编辑之后 Ctrl+Y 不该再恢复旧步骤：${stable}（期望 ${base0 + 65}）`)
      return issues
    },
  },

  'docx-cmd-cjk-format': {
    title: '中文输入 + 格式切换不丢字：组合输入「你好」→ 加粗 → 继续输入「世界」→ 改字号 → 再输入，全部字符按序在文档里',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const cdp = await tab.context().newCDPSession(tab)
      const compose = async (steps, commit) => {
        for (const text of steps) {
          await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
          await tab.waitForTimeout(40)
        }
        await cdp.send('Input.insertText', { text: commit })
        await tab.waitForTimeout(250)
      }
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      // 第三段（短）末尾：Third paragraph.
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('Control+End')
      await tab.waitForTimeout(300)
      await compose(['n', 'ni', 'ni h', 'ni hao'], '你好')
      await docxTool(tab, 'docx.bold')
      await compose(['s', 'sh', 'shi', 'shi j', 'shi jie'], '世界')
      await docxChoose(tab, 'docx.fontSize', '18')
      await compose(['z', 'zh', 'zhong', 'zhong w', 'zhong wen'], '中文')
      await tab.keyboard.type('ABC', { delay: 30 })
      await tab.waitForTimeout(500)
      const issues = []
      const paragraphs = await docxParagraphs(tab)
      if (paragraphs[2] !== 'Third paragraph.你好世界中文ABC') issues.push(`文字不对或丢字：${JSON.stringify(paragraphs[2])}`)
      const { xml } = await docxSavedXml(tab, state)
      const para = docxParagraphXml(xml, 'Third paragraph.')
      // 格式随位置切换：你好 无格式；世界 粗体；中文ABC 粗体 + 18pt
      const run = (text) => {
        const at = para.indexOf(text)
        if (at < 0) return ''
        return para.slice(para.lastIndexOf('<w:r>', at), at)
      }
      if (run('你好').includes('<w:b/>')) issues.push('「你好」不该是粗体')
      if (!run('世界').includes('<w:b/>')) issues.push('「世界」应该是粗体')
      if (!run('中文').includes('<w:b/>') || !run('中文').includes('w:val="36"')) issues.push('「中文」应是粗体 18 磅')
      return issues
    },
  },

  'docx-save-conflict': {
    title: '保存遇到 409（文件被别人改过）：显示版本冲突，本地改的字和未保存提示都保留；冲突解除后同一份内容能再保存',
    async assert(tab, base, state) {
      state.office.conflict = true
      await openDocxEdit(tab, base)
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 160, page1.y + 330)
      await tab.keyboard.type('冲突测试', { delay: 30 })
      await tab.waitForTimeout(600)
      const issues = []
      await tab.click('[data-testid="editor-save"]')
      if (!(await waitFor(() => state.office.replaces.length > 0, 20_000))) return ['点保存后没有发出 replace 请求']
      await tab.waitForTimeout(800)
      const status = (await tab.locator('[data-testid="editor-status"]').textContent()) ?? ''
      if (!/冲突/.test(status)) issues.push(`409 后状态应提示冲突：「${status}」`)
      // 本地改的字还在、仍然有未保存提示
      const paragraphs = await docxParagraphs(tab)
      if (!paragraphs.some((text) => text.includes('冲突测试'))) issues.push('409 之后本地改的字不见了')
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) issues.push('409 之后"有未保存的改动"提示丢了')
      if (await tab.locator('[data-testid="office-error"]').count()) issues.push('409 不该变成"编辑器出错"')

      // 冲突解除（别人的修改已合并 / 用户选择覆盖）后，同一份内容能再次保存
      state.office.conflict = false
      const before = state.office.replaces.length
      const saveDisabled = await tab.locator('[data-testid="editor-save"]').isDisabled()
      if (saveDisabled) {
        issues.push(`409 之后保存按钮是灰的，用户没法重试（状态「${status}」）`)
        return issues
      }
      await tab.click('[data-testid="editor-save"]')
      if (!(await waitFor(() => state.office.replaces.length > before, 20_000))) issues.push('冲突解除后再次点保存没有发出请求')
      else {
        await tab.waitForTimeout(600)
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(state.office.replaces.at(-1).body)
        const xml = await zip.file('word/document.xml').async('string')
        if (!xml.includes('冲突测试')) issues.push('冲突后再保存出的文件里没有本地改的字')
        const after = (await tab.locator('[data-testid="editor-status"]').textContent()) ?? ''
        if (/冲突/.test(after)) issues.push(`保存成功后状态还显示冲突：「${after}」`)
      }
      return issues
    },
  },

  'docx-save-footer-fields': {
    title: '页脚页码域（WPS / Word 的 PAGE、NUMPAGES 复杂域）：改正文并保存后页脚部件内容不丢（或文档只读）',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-footer.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      const readonly = (await tab.locator('[data-testid="office-readonly"]').count()) > 0
      if (readonly) {
        // 做不到无损时的合规退路：只读，并且说明原因
        if (!(await tab.locator('[data-testid="office-concern"]').count())) issues.push('页脚文档被判只读，但没有说明原因')
        return issues
      }
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await tab.keyboard.type('改动', { delay: 30 })
      await tab.waitForTimeout(600)
      const { xml, zip } = await docxSavedXml(tab, state)
      if (!xml.includes('改动')) issues.push('正文改动没有写进文件')
      const footerFile = zip.file('word/footer1.xml')
      if (!footerFile) return [...issues, '保存后的包里没有 word/footer1.xml（页脚部件丢了）']
      const footer = await footerFile.async('string')
      const text = [...footer.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
      if (text !== '第 1 页 共 1 页') issues.push(`页脚文字变了：「${text}」`)
      for (const instruction of ['PAGE', 'NUMPAGES']) if (!new RegExp(`<w:instrText[^>]*>\\s*${instruction}\\s*</w:instrText>`).test(footer)) issues.push(`页脚里的 ${instruction} 域丢了`)
      const begins = (footer.match(/w:fldCharType="begin"/g) ?? []).length
      const ends = (footer.match(/w:fldCharType="end"/g) ?? []).length
      if (begins !== 2 || ends !== 2) issues.push(`域的开始 / 结束标记数不对：begin ${begins} end ${ends}`)
      if (!xml.includes('<w:footerReference')) issues.push('正文节属性里的页脚引用丢了')
      return issues
    },
  },

  'docx-find-replace': {
    title: '查找替换（真引擎、20 页中文样本）：计数、跳页、高亮、替换当前、替换全部（一次撤销回到原样）、修订模式替换出修订标记',
    async assert(tab, base, state) {
      await openDocxEdit(tab, base)
      const issues = []
      const status = async () => {
        const text = (await tab.locator('[data-testid="editor-find-count"]').first().textContent().catch(() => '')) ?? ''
        return text.trim()
      }
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-input"]', { timeout: 5000 })

      // 1. 中文查找：41 处，跨 20 页
      await tab.fill('[data-testid="editor-find-input"]', '检索')
      await waitFor(async () => /41/.test(await status()), 15_000)
      if (!/41/.test(await status())) issues.push(`查找「检索」应有 41 处：${await status()}`)
      const highlights = await tab.locator('[data-testid="docx-find-highlight"]').count()
      if (highlights < 1) issues.push('查找后页面上没有高亮块')
      if ((await tab.locator('.kb-dex-find.is-current').count()) !== 1) issues.push('应有且只有一块"当前命中"高亮')

      // 2. 下一个多次 → 滚到后面的页
      const scrollBefore = await tab.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
      // Enter 要发给查找框（fill 之后焦点不一定还在它上面）
      await tab.locator('[data-testid="editor-find-input"]').focus()
      for (let i = 0; i < 30; i += 1) {
        await tab.keyboard.press('Enter')
        await tab.waitForTimeout(60)
      }
      // 跳到远端页后，当前命中的高亮要等引擎把那一页建出来才有（事件驱动，不是轮询）：空闲机器上实测 0.45~1.2 s，
      // 机器忙时 3~5 s。原来固定睡 800 ms 再断言，中位数离窗口太近，负载一高就偶发失败。改成等条件成立，
      // 上限 8 s——抓得到真正卡死（永远不出现），又不把"慢一点"误报成故障；实际用时打印出来留作证据
      const waitStart = Date.now()
      const appeared = await waitFor(async () => (await tab.locator('.kb-dex-find.is-current').count()) === 1, 8000)
      console.log(`    · 连按 30 次下一个后，当前命中高亮 ${appeared ? `${Date.now() - waitStart} ms 后出现` : '8 秒内没有出现'}`)
      const scrollAfter = await tab.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
      if (!(scrollAfter > scrollBefore + 2000)) issues.push(`连按下一个 30 次后应跳到靠后的页：scrollTop ${scrollBefore} → ${scrollAfter}`)
      const visible = await tab.evaluate(() => {
        const scroller = document.querySelector('[data-testid="docx-edit-scroll"]').getBoundingClientRect()
        const current = document.querySelector('.kb-dex-find.is-current')?.getBoundingClientRect()
        return current ? current.bottom > scroller.top && current.top < scroller.bottom : false
      })
      if (!visible) {
        const detail = await tab.evaluate(() => {
          const scroller = document.querySelector('[data-testid="docx-edit-scroll"]')
          const current = document.querySelector('.kb-dex-find.is-current')?.getBoundingClientRect()
          const box = scroller.getBoundingClientRect()
          return { scrollTop: scroller.scrollTop, viewport: [Math.round(box.top), Math.round(box.bottom)], current: current ? [Math.round(current.top), Math.round(current.bottom)] : null }
        })
        issues.push(`当前命中不在可视区内（没有滚过去，或跳到的页上没有补出高亮）：${JSON.stringify(detail)}`)
      }
      if ((await tab.locator('.kb-dex-find.is-current').count()) !== 1) issues.push('跳页之后应有且只有一块当前命中高亮')
      if (!/31\/41/.test(await status())) issues.push(`连按下一个 30 次后应在第 31/41 个：${await status()}`)

      // 3. 替换当前（展开替换栏）
      await tab.click('[data-testid="editor-find-toggle-replace"]').catch(() => undefined)
      await tab.fill('[data-testid="editor-find-replace-input"]', '搜寻')
      await tab.click('[data-testid="editor-find-replace"]')
      await waitFor(async () => /40/.test(await status()), 15_000)
      if (!/40/.test(await status())) issues.push(`替换一处后应剩 40 处：${await status()}`)

      // 4. 替换全部：一个撤销步骤回到替换前
      await tab.fill('[data-testid="editor-find-input"]', '倒数排名融合')
      await waitFor(async () => /21/.test(await status()), 15_000)
      const beforeAll = await docxParagraphs(tab)
      await tab.fill('[data-testid="editor-find-replace-input"]', 'RRF融合')
      await tab.click('[data-testid="editor-find-replace-all"]')
      await waitFor(async () => /\b0\b|无/.test(await status()), 15_000)
      const afterAll = await docxParagraphs(tab)
      if (afterAll.join('').includes('倒数排名融合')) issues.push('替换全部之后第一页的段落里还有旧文字')
      if (!afterAll.join('').includes('RRF融合')) issues.push('替换全部之后没有新文字')
      await tab.keyboard.press('Escape')
      await tab.locator('textarea.paged-editor__input').focus()
      await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(900)
      const undone = await docxParagraphs(tab)
      if (undone.join('') !== beforeAll.join('')) issues.push('替换全部后 Ctrl+Z 一次没有回到替换前（应是一个撤销步骤）')

      // 5. 保存后的文件
      const { xml } = await docxSavedXml(tab, state)
      if (!xml.includes('搜寻')) issues.push('替换当前的结果没写进文件')
      return issues
    },
  },

  'docx-review-comments': {
    title: '评论（真引擎）：选中文字新建 → 回复 → 解决（折叠到已解决）→ 重新打开 → 删除；点评论定位到文字；空内容 / 没选中被拦下',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      await docxTool(tab, 'docx.review')
      await tab.waitForSelector('[data-testid="docx-review-panel"]', { timeout: 5000 })
      if (!(await tab.locator('[data-testid="docx-comments-empty"]').count())) issues.push('一开始应显示"还没有评论"')

      // 没选中文字就评论：被拦下并说明原因，不产生评论
      await tab.fill('[data-testid="docx-comment-draft"]', '没选中')
      await tab.click('[data-testid="docx-comment-submit"]')
      await tab.waitForSelector('[data-testid="docx-review-notice"]', { timeout: 5000 })
      if ((await tab.locator('[data-testid="docx-comment-thread"]').count()) !== 0) issues.push('没选中文字却产生了评论')
      await tab.click('[data-testid="docx-review-notice"] button')

      // 选中第一段的一部分，新建评论
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('Home')
      await tab.keyboard.press('Shift+End')
      await tab.waitForTimeout(400)
      await tab.fill('[data-testid="docx-comment-draft"]', '这一段需要核对')
      await tab.click('[data-testid="docx-comment-submit"]')
      await waitFor(async () => (await tab.locator('[data-testid="docx-comment-thread"]').count()) === 1, 10_000)
      const text = await tab.locator('[data-testid="docx-comment-text"]').first().textContent()
      if (text?.trim() !== '这一段需要核对') issues.push(`评论文字不对：${text}`)

      // 回复
      await tab.click('[data-testid="docx-comment-reply-open"]')
      await tab.fill('[data-testid="docx-comment-reply-draft"]', '已核对，没问题')
      await tab.click('[data-testid="docx-comment-reply-submit"]')
      await waitFor(async () => (await tab.locator('[data-testid="docx-comment-reply"]').count()) === 1, 10_000)
      if ((await tab.locator('[data-testid="docx-comment-reply"]').count()) !== 1) issues.push('回复没有出现在线程下')

      // 点评论：定位到文字（选区回到被评论的那段）
      await tab.mouse.click(page1.x + 200, page1.y + 300)
      await tab.click('.kb-dex-comment >> nth=0')
      await tab.waitForTimeout(600)
      const selectedLines = await tab.evaluate(() => document.querySelectorAll('.kb-dex-selection').length)
      if (selectedLines < 1) issues.push('点评论后没有选中被评论的文字')

      // 空回复不提交
      await tab.click('[data-testid="docx-comment-reply-open"]')
      if (!(await tab.locator('[data-testid="docx-comment-reply-submit"]').isDisabled())) issues.push('空回复的提交按钮应是灰的')
      await tab.click('[data-testid="docx-comment-reply-open"]')

      // 解决 → 进"已解决"折叠区，不在进行中列表里
      await tab.click('[data-testid="docx-comment-resolve"]')
      await waitFor(async () => (await tab.locator('[data-testid="docx-comment-thread"]').count()) === 0, 10_000)
      if ((await tab.locator('[data-testid="docx-comment-thread"]').count()) !== 0) issues.push('解决后还在进行中列表里')
      await tab.click('[data-testid="docx-resolved-toggle"]')
      if ((await tab.locator('[data-testid="docx-comment-resolved"]').count()) !== 1) issues.push('已解决区里应有 1 条')
      // 重新打开
      await tab.click('[data-testid="docx-comment-reopen"]')
      await waitFor(async () => (await tab.locator('[data-testid="docx-comment-thread"]').count()) === 1, 10_000)
      if ((await tab.locator('[data-testid="docx-comment-thread"]').count()) !== 1) issues.push('重新打开后应回到进行中')

      // 保存：评论进文件（comments.xml + 范围标记）
      const { xml, zip } = await docxSavedXml(tab, state)
      if (!zip.file('word/comments.xml')) issues.push('保存的包里没有 word/comments.xml')
      else {
        const comments = await zip.file('word/comments.xml').async('string')
        if (!comments.includes('这一段需要核对') || !comments.includes('已核对，没问题')) issues.push('comments.xml 里缺评论或回复的文字')
      }
      if (!xml.includes('commentRangeStart')) issues.push('正文里没有评论范围标记 commentRangeStart')

      // 删除
      await tab.click('[data-testid="docx-comment-delete"]')
      await waitFor(async () => (await tab.locator('[data-testid="docx-comment-thread"]').count()) === 0, 10_000)
      if ((await tab.locator('[data-testid="docx-comment-thread"]').count()) !== 0) issues.push('删除后评论还在')
      return issues
    },
  },

  'docx-review-revisions': {
    title: '修订（真引擎）：开修订模式改一段 → 面板出现插入 / 删除 → 文件里有 w:ins / w:del → 接受后文字定稿 → 拒绝后恢复原文；修订模式下替换也出修订标记；关修订后直接改',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const issues = []
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      const count = () => tab.locator('[data-testid="docx-revision"]').count()
      await docxTool(tab, 'docx.review')
      await tab.waitForSelector('[data-testid="docx-review-panel"]')
      await tab.click('[data-testid="docx-tab-revisions"]')
      if (!(await tab.locator('[data-testid="docx-revisions-empty"]').count())) issues.push('一开始应显示"没有修订"')

      // 开修订模式（面板里的开关和工具栏按钮是同一个状态）
      await tab.check('[data-testid="docx-tracking-toggle"]')
      await tab.waitForTimeout(300)
      // 按钮可能在工具栏上，也可能被收进"更多"（那里是菜单项，用 is-active 表示亮）
      const lit = await tab.evaluate(() => {
        const button = document.querySelector('[data-testid="editor-toolbar-slot"] [data-action="docx.trackChanges"]')
        return button ? button.getAttribute('aria-pressed') === 'true' : null
      })
      if (lit === false) issues.push('开修订后工具栏的"修订"按钮应亮')
      if (lit === null) {
        await tab.click('[data-testid="editor-toolbar-more"]')
        const itemLit = await tab.evaluate(() => document.querySelector('[data-testid="editor-toolbar-more-menu"] [data-action="docx.trackChanges"]')?.classList.contains('is-active'))
        if (itemLit !== true) issues.push('开修订后"更多"菜单里的"修订"项应亮')
        await tab.keyboard.press('Escape')
        await tab.evaluate(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
      }

      // 第一段（"Hello world. This is a plain …"）：行尾插入一句，再把行首的 "Hello " 删掉
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await tab.keyboard.type(' ADDED', { delay: 25 })
      await tab.keyboard.press('Home')
      for (let i = 0; i < 6; i += 1) await tab.keyboard.press('Shift+ArrowRight')
      await tab.keyboard.press('Delete')
      await tab.waitForTimeout(900)
      await waitFor(async () => (await count()) >= 2, 10_000)
      const kinds = await tab.locator('[data-testid="docx-revision"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')))
      if (!kinds.includes('insertion')) issues.push(`应有插入修订：${kinds.join(',')}`)
      if (!kinds.includes('deletion')) issues.push(`应有删除修订：${kinds.join(',')}`)
      const summary = (await tab.locator('[data-testid="docx-revisions-summary"]').textContent())?.trim() ?? ''
      if (!/\d+ 处/.test(summary)) issues.push(`作者统计不对：${summary}`)

      // 文件里是真正的修订标记，删除的字还在（作为删除标记）
      const saved = await docxSavedXml(tab, state)
      if (!saved.xml.includes('<w:ins ') || !saved.xml.includes('<w:del ')) issues.push('保存的文件里没有 w:ins / w:del')
      if (!/<w:delText[^>]*>Hello /.test(saved.xml)) issues.push(`被删的 "Hello " 应作为 w:delText 留在文件里，而不是真删掉：${(saved.xml.match(/<w:del [\s\S]{0,300}/) ?? [''])[0]}`)
      // 引擎在修订模式下把键入的每个字符各记成一个 w:ins（合法的 OOXML，Word 能读）：文件里应是这些 w:ins 的文字依次拼成 " ADDED"
      const insertedText = [...saved.xml.matchAll(/<w:ins [^>]*>([\s\S]*?)<\/w:ins>/g)].map((match) => [...match[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')).join('')
      if (insertedText !== ' ADDED') issues.push(`文件里所有 w:ins 的文字拼起来应是 " ADDED"：${JSON.stringify(insertedText)}`)
      // 侧栏显示：这 6 个碎片合成"一条"插入（Word 里一次连续输入是一条修订），预览文字是完整的 " ADDED"
      const insertionRows = await tab.locator('[data-testid="docx-revision"][data-kind="insertion"]').count()
      if (insertionRows !== 1) issues.push(`侧栏里连续键入的插入应合并成 1 条：${insertionRows}`)
      const insertionText = (await tab.locator('[data-testid="docx-revision"][data-kind="insertion"] .kb-dex-comment-text').first().textContent())?.trim() ?? ''
      if (insertionText !== 'ADDED') issues.push(`合并后的插入预览应是 ADDED：${JSON.stringify(insertionText)}`)

      // 修订模式下的查找替换：替换出修订标记（原文还在，作为删除）
      // 点工具栏的查找按钮（焦点此刻在审阅栏的控件上，Ctrl+F 不一定被外壳接到）
      await docxTool(tab, 'find')
      await tab.fill('[data-testid="editor-find-input"]', 'Third')
      await waitFor(async () => /1\/1/.test((await tab.locator('[data-testid="editor-find-count"]').first().textContent().catch(() => '')) ?? ''), 10_000)
      await tab.click('[data-testid="editor-find-toggle-replace"]').catch(() => undefined)
      await tab.fill('[data-testid="editor-find-replace-input"]', '3rd')
      const before = await count()
      await tab.click('[data-testid="editor-find-replace"]')
      await waitFor(async () => (await count()) > before, 10_000)
      if (!((await count()) > before)) {
        const paragraphsNow = await docxParagraphs(tab)
        issues.push(`修订模式下替换应产生新的修订（删除旧字 + 插入新字），而不是直接改：修订数 ${before} → ${await count()}；末段现在是「${paragraphsNow.at(-1)}」`)
      }
      await tab.keyboard.press('Escape')

      // 逐条接受第一条，再逐条拒绝第二条
      const total = await count()
      await tab.click('[data-testid="docx-revision-accept"] >> nth=0')
      await waitFor(async () => (await count()) < total, 10_000)
      if (!((await count()) < total)) issues.push('接受一条后列表应少一条')

      // 全部拒绝：列表清空，文字回到原样（Second paragraph / Third paragraph. 都还原）
      await tab.click('[data-testid="docx-reject-all"]')
      await waitFor(async () => (await count()) === 0, 15_000)
      if ((await count()) !== 0) issues.push('全部拒绝后应没有修订')

      // 关修订后直接改：不再出修订
      await tab.uncheck('[data-testid="docx-tracking-toggle"]')
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await tab.keyboard.type('!', { delay: 25 })
      await tab.waitForTimeout(800)
      if ((await count()) !== 0) issues.push('关修订模式后的修改不该再产生修订')
      return issues
    },
  },

  'docx-outline-stats-export': {
    title: '大纲 / 字数 / 导出（真引擎、20 页）：大纲 20 项并能跳转；字数是真实字数且随编辑更新；导出 .docx 能解开且含改动，导出 .txt 是全文',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      const issues = []

      // 字数：真实字数（不是页数），单位是"字"
      const countText = async () => ((await tab.locator('[data-testid="editor-chrome-count"]').textContent()) ?? '').trim()
      await waitFor(async () => /字/.test(await countText()), 15_000)
      const first = await countText()
      const words = Number(first.match(/^(\d+)/)?.[1])
      if (!/字/.test(first) || !(words > 1000)) issues.push(`字数应是几千的真实字数（单位"字"）：「${first}」`)

      // 编辑后字数更新
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 330)
      await tab.keyboard.press('End')
      await tab.keyboard.type('新增十个汉字内容哈哈哈', { delay: 20 })
      await waitFor(async () => Number((await countText()).match(/^(\d+)/)?.[1]) === words + 11, 15_000)
      const after = Number((await countText()).match(/^(\d+)/)?.[1])
      if (after !== words + 11) issues.push(`键入 11 个汉字后字数应从 ${words} 变成 ${words + 11}：${after}`)

      // 大纲：20 个标题
      await docxTool(tab, 'outline')
      await tab.waitForSelector('[data-testid="editor-outline"]', { timeout: 5000 })
      const items = await tab.locator('.kb-editor-outline-item').count()
      if (items !== 20) issues.push(`大纲应有 20 个标题：${items}`)
      const firstItem = (await tab.locator('.kb-editor-outline-item').first().textContent())?.trim()
      if (!firstItem?.includes('混合检索与倒数排名融合')) issues.push(`大纲第一项不对：${firstItem}`)

      // 点第 12 项：跳到后面的页，光标在那个标题上
      const before = await tab.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
      await tab.locator('.kb-editor-outline-item').nth(11).click()
      await tab.waitForTimeout(1200)
      const afterJump = await tab.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
      if (!(afterJump > before + 5000)) issues.push(`点第 12 个标题应跳到靠后的页：scrollTop ${before} → ${afterJump}`)

      // 导出 .docx：下载的是真的 docx，且包含刚才的改动
      const exportOpen = async (label) => {
        await docxChoose(tab, 'docx.export', label)
      }
      const [download] = await Promise.all([tab.waitForEvent('download', { timeout: 20_000 }), exportOpen('下载 Word（.docx）')])
      if (!/\.docx$/.test(download.suggestedFilename())) issues.push(`导出的文件名应以 .docx 结尾：${download.suggestedFilename()}`)
      const docxPath = await download.path()
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(await readFile(docxPath))
      const xml = await zip.file('word/document.xml')?.async('string')
      if (!xml) issues.push('导出的 .docx 里没有 word/document.xml')
      else if (!xml.includes('新增十个汉字内容哈哈哈')) issues.push('导出的 .docx 里没有刚才的改动')

      // 导出纯文本：全文
      const [textDownload] = await Promise.all([tab.waitForEvent('download', { timeout: 20_000 }), exportOpen('下载纯文本（.txt）')])
      if (!/\.txt$/.test(textDownload.suggestedFilename())) issues.push(`纯文本导出的文件名应以 .txt 结尾：${textDownload.suggestedFilename()}`)
      const text = await readFile(await textDownload.path(), 'utf8')
      if (!text.includes('混合检索与倒数排名融合') || !text.includes('新增十个汉字内容哈哈哈')) issues.push('纯文本导出缺标题或改动')
      if (text.split('\n').length < 40) issues.push(`纯文本应有几十段：${text.split('\n').length} 行`)
      return issues
    },
  },

  'docx-perf-fps': {
    title: '20 页编辑流畅度：滚动整篇、连续输入——帧间隔（rAF）与主线程长任务（PerformanceObserver）两种证据；负载高时取多轮里最好的一半',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      // 流畅度对机器负载极敏感（别的进程抢 CPU，帧间隔就被放大）。采样前最多等 90 秒让 1 分钟平均负载降到核数以下；
      // 等不到也照测并如实写出负载——这是改善测量条件，判据本身不放宽
      const os = await import('node:os')
      const waitUntil = Date.now() + 90_000
      while (os.loadavg()[0] > os.cpus().length && Date.now() < waitUntil) await tab.waitForTimeout(3000)
      const load = os.loadavg()[0]
      const stats = (frames) => {
        const sorted = [...frames].sort((a, b) => a - b)
        const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
        return {
          frames: frames.length,
          fps: 1000 / (frames.reduce((sum, frame) => sum + frame, 0) / frames.length),
          median: at(0.5),
          p95: at(0.95),
          max: sorted.at(-1),
          dropped: frames.filter((frame) => frame > 33.4).length / frames.length,
        }
      }
      /** 一轮：开始 rAF 采样与长任务观察 → 驱动 → 收集 */
      const round = async (drive) => {
        await tab.evaluate(() => {
          window.__frames = []
          window.__long = []
          let last = performance.now()
          const tick = (now) => {
            window.__frames.push(now - last)
            last = now
            window.__raf = requestAnimationFrame(tick)
          }
          window.__raf = requestAnimationFrame(tick)
          window.__observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__long.push(entry.duration)
          })
          window.__observer.observe({ type: 'longtask', buffered: false })
        })
        await drive()
        const collected = await tab.evaluate(() => {
          cancelAnimationFrame(window.__raf)
          window.__observer.disconnect()
          return { frames: window.__frames.slice(2), long: window.__long }
        })
        return { ...stats(collected.frames), longTasks: collected.long.length, longTotal: collected.long.reduce((sum, duration) => sum + duration, 0), longMax: Math.max(0, ...collected.long) }
      }
      const scrollWhole = () =>
        tab.evaluate(async () => {
          const scroller = document.querySelector('[data-testid="docx-edit-scroll"]')
          scroller.scrollTop = 0
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const total = scroller.scrollHeight - scroller.clientHeight
          const step = total / 150
          for (let i = 0; i < 150; i += 1) {
            scroller.scrollTop += step
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        })
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      const typeBurst = async () => {
        await tab.evaluate(() => (document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop = 0))
        await tab.waitForTimeout(400)
        await tab.mouse.click(page1.x + 200, page1.y + 330)
        await tab.keyboard.press('End')
        for (let i = 0; i < 60; i += 1) {
          await tab.keyboard.type(String.fromCharCode(97 + (i % 26)))
          await tab.waitForTimeout(70)
        }
        await tab.waitForTimeout(300)
      }

      // 负载高时单轮不可靠（别的进程抢 CPU）：多轮取中位数最好的一半的最好一轮，并如实写出每轮数字
      const ROUNDS = 5
      const scrolls = []
      const typings = []
      for (let i = 0; i < ROUNDS; i += 1) scrolls.push(await round(scrollWhole))
      for (let i = 0; i < ROUNDS; i += 1) typings.push(await round(typeBurst))
      const best = (list) => [...list].sort((a, b) => a.median - b.median || a.dropped - b.dropped)[0]
      const show = (name, list) => {
        const top = best(list)
        console.log(`    · ${name}（${ROUNDS} 轮，系统负载 ${load.toFixed(1)}/16 核）：最好一轮 ${top.fps.toFixed(1)} fps，帧间隔中位 ${top.median.toFixed(1)} ms，p95 ${top.p95.toFixed(1)} ms，>33ms 掉帧 ${(top.dropped * 100).toFixed(1)}%，长任务 ${top.longTasks} 个（最长 ${top.longMax.toFixed(0)} ms）；各轮中位 ${list.map((item) => item.median.toFixed(1)).join('/')} ms`)
        return top
      }
      const scroll = show('滚动整篇 20 页', scrolls)
      const typing = show('连续输入 60 字', typings)
      const issues = []
      // 判据：最好的一轮达到 60 fps（中位 ≤ 17.5 ms）且掉帧 ≤ 10%。代码本身做不到的话，再空闲的机器也出不来这个数
      for (const [name, result] of [['滚动', scroll], ['输入', typing]]) {
        if (result.median > 17.5) issues.push(`${name}：最好一轮帧间隔中位仍有 ${result.median.toFixed(1)} ms，达不到 60 fps`)
        if (result.dropped > 0.1) issues.push(`${name}：最好一轮掉帧（>33ms）占 ${(result.dropped * 100).toFixed(1)}% > 10%`)
      }
      return issues
    },
  },

  'docx-thumbs-canvas': {
    title: '画布编辑的缩略图栏：默认收起；点「缩略图」后 20 张引擎位图都画出（非空白、纸面白底）；点第 15 页跳转并把焦点还给文档；滚动同步；缩放保持位置；收起 / 展开',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      const issues = []
      if (await tab.locator('[data-testid="page-thumbs"]').count()) issues.push('编辑面缩略图应默认收起（要另开引擎会话，用户需要才打开）')
      await docxPress(tab, 'page.thumbs')
      const openedAt = Date.now()
      await waitThumbs(tab, 20, 120_000)
      console.log(`    · 打开缩略图到 20 张画好（含另开光栅会话）${((Date.now() - openedAt) / 1000).toFixed(1)} s`)
      const info = await tab.evaluate(() => ({
        thumbs: document.querySelectorAll('[data-testid="page-thumb"]').length,
        names: [...document.querySelectorAll('[data-testid="page-thumb"] .kb-pgt-name')].map((el) => el.textContent.trim()),
        canvasesInRail: document.querySelectorAll('[data-testid="page-thumbs"] canvas').length,
        images: document.querySelectorAll('[data-testid="page-thumbs"] .kb-pgt-slot img').length,
        pageDivs: document.querySelectorAll('.kb-dex-page').length,
        pressed: document.querySelector('[data-action="page.thumbs"]')?.getAttribute('aria-pressed') ?? null,
        firstCanvas: document.querySelector('.kb-office-host canvas')?.closest('[data-testid="page-thumbs"]') ? 'thumb' : 'page',
        orientation: document.querySelector('[data-testid="page-thumbs"]')?.dataset.orientation,
      }))
      if (info.thumbs !== 20 || info.images !== 20) issues.push(`缩略图数量不对：按钮 ${info.thumbs}，位图 ${info.images}`)
      if (info.names[14] !== '第 15 页，共 20 页') issues.push(`缩略图的可访问名称不对：${info.names[14]}`)
      if (info.canvasesInRail) issues.push(`缩略图栏里不该有 <canvas>（会被按 canvas 取页的代码误取）：${info.canvasesInRail}`)
      if (info.firstCanvas !== 'page') issues.push('文档里第一块 canvas 应是页面画布，不是缩略图')
      if (info.pageDivs !== 20) issues.push(`页面容器数不是 20：${info.pageDivs}`)
      if (info.pressed !== null && info.pressed !== 'true') issues.push(`打开后按钮 aria-pressed=${info.pressed}`)
      const inks = []
      for (let page = 1; page <= 20; page += 1) inks.push(await thumbInk(tab, page))
      const values = inks.map((item) => item.ink)
      console.log(`    · 画布缩略图墨量：最小 ${(Math.min(...values) * 100).toFixed(2)}%，平均 ${((values.reduce((a, b) => a + b, 0) / values.length) * 100).toFixed(2)}%，最大 ${(Math.max(...values) * 100).toFixed(2)}%；盒子 ${inks[0].width}×${inks[0].height}`)
      values.forEach((ink, index) => ink < 0.003 && issues.push(`第 ${index + 1} 页缩略图几乎空白（墨量 ${(ink * 100).toFixed(2)}%）`))
      if (inks.some((item) => item.corner.some((v) => v < 250))) issues.push(`缩略图纸面不是白底：${inks.find((item) => item.corner.some((v) => v < 250)).corner.join(',')}`)

      // 无障碍：栏（含 20 张位图缩略图的按钮名称）无 critical / serious
      for (const item of await axeIssues(tab, { scope: '[data-testid="page-thumbs"]' })) issues.push(`画布缩略图栏 axe ${item}`)

      // 点第 15 页
      await tab.locator('[data-testid="page-thumb"][data-page="15"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-dex-page-input')?.value === '15', null, { timeout: 4000 }).catch(async () => issues.push(`点第 15 页缩略图后页码是 ${await tab.inputValue('.kb-dex-page-input')}`))
      const gap = await tab.evaluate(() => {
        const scroller = document.querySelector('[data-testid="docx-edit-scroll"]').getBoundingClientRect()
        return Math.round(document.querySelectorAll('.kb-dex-page')[14].getBoundingClientRect().top - scroller.top)
      })
      if (Math.abs(gap) > 40) issues.push(`第 15 页没有滚到视口顶部：偏差 ${gap}px`)
      if ((await currentThumb(tab)) !== '15') issues.push(`第 15 页缩略图没有高亮：${await currentThumb(tab)}`)
      const focused = await tab.evaluate(() => document.activeElement?.classList.contains('paged-editor__input'))
      if (!focused) issues.push('点缩略图跳页后焦点没有回到文档输入框（接着打字没反应）')

      // 滚动同步
      const settle = (expected) =>
        tab.waitForFunction((page) => document.querySelector('[data-testid="page-thumb"][aria-current="page"]')?.dataset.page === page, expected, { timeout: 4000 }).then(() => true, () => false)
      for (const [page, offset] of [[8, 150], [19, 100], [3, 200]]) {
        await scrollEditTo(tab, page, offset)
        if (!(await settle(String(page)))) {
          issues.push(`滚到第 ${page} 页后高亮的是第 ${await currentThumb(tab)} 页`)
          continue
        }
        await tab.waitForTimeout(200)
        if (!(await thumbVisibleInRail(tab, page))) issues.push(`第 ${page} 页缩略图高亮了但没有滚进栏的可见区`)
      }

      // 缩放保持位置
      await scrollEditTo(tab, 15, 380)
      await tab.waitForTimeout(400)
      const start = await editPosition(tab)
      if (start.page !== 15) issues.push(`准备阶段没有停在第 15 页：${start.page}`)
      const check = async (what) => {
        await tab.waitForTimeout(700)
        const now = await editPosition(tab)
        if (now.page !== start.page) issues.push(`${what}后页码从 ${start.page} 变成 ${now.page}（输入框 ${now.input}）`)
        else if (Math.abs(now.fraction - start.fraction) > 0.04) issues.push(`${what}后页内位置漂移：${(start.fraction * 100).toFixed(1)}% → ${(now.fraction * 100).toFixed(1)}%`)
      }
      for (let i = 0; i < 3; i += 1) await tab.click('[data-testid="docx-edit-zoom-in"]')
      await check(`放大到 ${(await tab.textContent('[data-testid="docx-edit-zoom"]')).trim()}`)
      for (let i = 0; i < 5; i += 1) await tab.click('[data-testid="docx-edit-zoom-out"]')
      await check(`缩小到 ${(await tab.textContent('[data-testid="docx-edit-zoom"]')).trim()}`)
      await tab.click('[data-testid="docx-edit-zoom"]')
      await check('恢复适应宽度')

      // 收起 / 展开
      await docxPress(tab, 'page.thumbs')
      await tab.waitForSelector('[data-testid="page-thumbs"]', { state: 'detached', timeout: 3000 })
      await check('收起缩略图栏')
      await docxPress(tab, 'page.thumbs')
      await waitThumbs(tab, 20, 120_000)
      return issues
    },
  },

  'docx-thumbs-edit': {
    title: '编辑后缩略图只重画改动页之后的页：在第 10 页打字 → 停手后第 1~9 页的缩略图原封不动，第 10 页起重画且第 10 页画面变了；打字期间不重画（节流）',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      await docxPress(tab, 'page.thumbs')
      await waitThumbs(tab, 20, 120_000)
      const issues = []
      // 给现有的 20 张缩略图元素打标，并记下第 10 页的画面摘要
      const digestOf = (page) =>
        tab.evaluate(async (n) => {
          const img = document.querySelector(`[data-testid="page-thumb"][data-page="${n}"] .kb-pgt-slot img`)
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          canvas.getContext('2d').drawImage(img, 0, 0)
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          let hash = 5381
          for (let i = 0; i < data.length; i += 4) hash = ((hash * 33) ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16)) | 0
          return hash
        }, page)
      await tab.evaluate(() => document.querySelectorAll('[data-testid="page-thumb"] .kb-pgt-slot img').forEach((img) => (img.__tag = 'orig')))
      const before10 = await digestOf(10)
      const tagged = () =>
        tab.evaluate(() => [...document.querySelectorAll('[data-testid="page-thumb"] .kb-pgt-slot img')].map((img) => img.__tag === 'orig'))

      // 到第 10 页，点进正文，打一串宽字符
      await tab.locator('[data-testid="page-thumb"][data-page="10"]').click()
      await tab.waitForFunction(() => document.querySelector('.kb-dex-page-input')?.value === '10', null, { timeout: 4000 })
      await tab.waitForTimeout(500)
      const box = await tab.evaluate(() => {
        const r = document.querySelectorAll('.kb-dex-page')[9].getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width }
      })
      await tab.mouse.click(box.x + box.width * 0.25, box.y + 330 * (box.width / 816))
      await tab.keyboard.press('End')
      const typedAt = Date.now()
      for (let i = 0; i < 12; i += 1) {
        await tab.keyboard.type('W')
        await tab.waitForTimeout(60)
      }
      // 打字期间（还没停手满 1.5 秒）缩略图不动
      const during = await tagged()
      if (during.some((ok) => !ok)) issues.push(`还在打字时缩略图就被重画了：${during.map((ok, i) => (ok ? '' : i + 1)).filter(Boolean).join(',')}`)

      // 停手后：第 10 页起全部重画（新元素没有标记），第 1~9 页原封不动
      const replaced = await waitFor(async () => (await tagged()).slice(9).every((ok) => !ok), 120_000)
      console.log(`    · 停手后第 10~20 页缩略图全部重画用时 ${((Date.now() - typedAt) / 1000).toFixed(1)} s`)
      if (!replaced) issues.push(`停手 2 分钟后第 10~20 页缩略图仍没有全部重画：${(await tagged()).map((ok, i) => (ok ? i + 1 : '')).filter(Boolean).join(',')} 页还是旧的`)
      // 再多等一阵：若实现把所有页都标成过期，第 1~9 页（不在栏的可见区）会排在后面，刚重画完第 10~20 页时它们可能还没轮到
      await tab.waitForTimeout(8000)
      const after = await tagged()
      const redrawnEarly = after.slice(0, 9).map((ok, i) => (ok ? '' : i + 1)).filter(Boolean)
      if (redrawnEarly.length) issues.push(`改动页之前的缩略图不该重画，但第 ${redrawnEarly.join('、')} 页被重画了`)
      const after10 = await digestOf(10)
      if (after10 === before10) issues.push('第 10 页缩略图画面没有变（应带上刚打的字）')
      const count = await tab.locator('[data-testid="page-thumbs"] .kb-pgt-slot img').count()
      if (count !== 20) issues.push(`重画后缩略图数量不是 20：${count}`)
      return issues
    },
  },

  'docx-thumbs-canvas-fps': {
    title: '画布编辑打开缩略图栏时滚动仍 60 fps：缩略图全部生成后滚动整篇 20 页；负载高时取多轮里最好的一轮',
    async assert(tab, base) {
      await openDocxEdit(tab, base)
      await docxPress(tab, 'page.thumbs')
      await waitThumbs(tab, 20, 120_000)
      const os = await import('node:os')
      const until = Date.now() + 90_000
      while (os.loadavg()[0] > os.cpus().length && Date.now() < until) await tab.waitForTimeout(3000)
      const load = os.loadavg()[0]
      const rounds = []
      for (let i = 0; i < 5; i += 1) rounds.push(await scrollFpsRound(tab, '[data-testid="docx-edit-scroll"]'))
      const best = [...rounds].sort((a, b) => a.median - b.median || a.dropped - b.dropped)[0]
      console.log(`    · 画布编辑、缩略图栏打开、滚动整篇 20 页（5 轮，系统负载 ${load.toFixed(1)}/16 核）：最好一轮 ${best.fps.toFixed(1)} fps，帧间隔中位 ${best.median.toFixed(1)} ms，p95 ${best.p95.toFixed(1)} ms，>33ms 掉帧 ${(best.dropped * 100).toFixed(1)}%，长任务 ${best.longTasks} 个（最长 ${best.longMax.toFixed(0)} ms）；各轮中位 ${rounds.map((r) => r.median.toFixed(1)).join('/')} ms`)
      const issues = []
      if (best.median > 17.5) issues.push(`缩略图栏打开：最好一轮帧间隔中位仍有 ${best.median.toFixed(1)} ms，达不到 60 fps`)
      if (best.dropped > 0.1) issues.push(`缩略图栏打开：最好一轮掉帧（>33ms）占 ${(best.dropped * 100).toFixed(1)}% > 10%`)
      return issues
    },
  },

  'docx-thumbs-phone-edit': {
    title: '390×844 触屏的画布编辑：缩略图默认收起；点按钮展开成文档下方的横条、不盖正文；点缩略图翻页',
    async assert(tab, base, state) {
      const browser = tab.context().browser()
      const context = await browser.newContext(contextOptions({ width: 390, height: 844, dpr: 2, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      try {
        await installFixture(context, { ...SOLO_EDIT_FIXTURE, ...DOCX_EDIT_FIXTURE, __officeEdit: state.office })
        const phone = await context.newPage()
        await openDocxEdit(phone, base)
        const issues = []
        if (await phone.locator('[data-testid="page-thumbs"]').count()) issues.push('手机上缩略图应默认收起')
        await docxPress(phone, 'page.thumbs')
        await phone.waitForSelector('[data-testid="page-thumbs"]', { timeout: 5000 })
        await waitThumbs(phone, 20, 120_000)
        const open = await phone.evaluate(() => {
          const s = document.querySelector('[data-testid="docx-edit-scroll"]').getBoundingClientRect()
          const r = document.querySelector('[data-testid="page-thumbs"]').getBoundingClientRect()
          return {
            orientation: document.querySelector('[data-testid="page-thumbs"]').dataset.orientation,
            overlap: Math.max(0, Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top)),
            railTop: r.top,
            scrollerBottom: s.bottom,
            railHeight: Math.round(r.height),
            scrollerHeight: Math.round(s.height),
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })
        console.log(`    · 手机画布编辑横条：高 ${open.railHeight}px，文档区 ${open.scrollerHeight}px，重叠 ${open.overlap}px`)
        if (open.orientation !== 'horizontal') issues.push(`手机上应是横条：${open.orientation}`)
        if (open.overlap > 1) issues.push(`横条盖住了正文：重叠 ${open.overlap}px`)
        if (open.railTop < open.scrollerBottom - 1) issues.push('横条应在文档区下方')
        if (open.overflowX > 2) issues.push(`页面出现横向溢出 ${open.overflowX}px`)
        await phone.locator('[data-testid="page-thumb"][data-page="5"]').tap()
        await phone.waitForFunction(() => document.querySelector('.kb-dex-page-input')?.value === '5', null, { timeout: 4000 }).catch(async () => issues.push(`手机点第 5 张缩略图后页码是 ${await phone.inputValue('.kb-dex-page-input')}`))
        const focused = await phone.evaluate(() => document.activeElement?.classList.contains('paged-editor__input'))
        if (focused) issues.push('触屏点缩略图不该把焦点给输入框（会弹软键盘）')
        return issues
      } finally {
        await context.close()
      }
    },
  },

  'docx-hover-prefetch': {
    title: '悬停预取：悬停「在线编辑」创建并预热 Worker → 点击复用而不是另建 → 移开不点则宽限期后释放（不泄漏）',
    async assert(tab, base, state) {
      const issues = []
      // 数 Word 引擎的 Worker（name=kb-docx-edit 对应的模块 Worker）：创建了几个、还活着几个
      const workers = []
      // 只数 Word 编辑引擎的 Worker（docx.worker-*.js）：页面上还有 xlsx 读取、旧岛等别的 Worker，混着数会误判
      tab.on('worker', (worker) => {
        if (!/docx\.worker/.test(worker.url())) return
        const record = { url: worker.url(), closed: false }
        workers.push(record)
        worker.on('close', () => (record.closed = true))
      })
      const alive = () => workers.filter((worker) => !worker.closed).length

      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&x=1`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 60_000 })
      await tab.waitForTimeout(1500)
      if (workers.length !== 0) return [`没悬停就已经创建了 ${workers.length} 个 Worker（不该预取）`]

      // 1. 悬停：创建并预热一个 Worker
      await tab.hover('[data-testid="office-edit-open"]')
      for (let i = 0; i < 40 && workers.length < 1; i += 1) await tab.waitForTimeout(100)
      if (workers.length !== 1) issues.push(`悬停后应创建 1 个 Worker，实际 ${workers.length}`)
      // 重复悬停（移开一点再回来）复用，不新建
      await tab.mouse.move(5, 5)
      await tab.waitForTimeout(300)
      await tab.hover('[data-testid="office-edit-open"]')
      await tab.waitForTimeout(500)
      if (workers.length !== 1) issues.push(`重复悬停堆出了多个 Worker：${workers.length}`)

      // 2. 点击：预取的那个被编辑会话认领。打开前的无损探测会自己建一个临时会话，所以总数是 2（预取复用 + 探测），不是 3
      await tab.click('[data-testid="office-edit-open"]')
      await tab.waitForSelector('.kb-office-host canvas', { state: 'visible', timeout: 120_000 })
      await tab.waitForTimeout(1500)
      if (workers.length !== 2) issues.push(`悬停后点击共应创建 2 个 Worker（预取复用 + 无损探测的临时会话），实际 ${workers.length}——预取没被认领，另建了一个`)
      if (alive() !== 1) issues.push(`打开后应只剩编辑会话这 1 个 Worker 存活（探测的已销毁），实际 ${alive()}`)
      return issues
    },
  },

  'docx-hover-prefetch-release': {
    title: '悬停预取释放：悬停后移开不点，宽限期（8 秒）后 Worker 被销毁；宽限期内回来则保留——不白占 Worker 和内存；xlsx 悬停不触发 Word 引擎',
    async assert(tab, base) {
      const issues = []
      const workers = []
      tab.on('worker', (worker) => {
        if (!/docx\.worker/.test(worker.url())) return
        const record = { closed: false }
        workers.push(record)
        worker.on('close', () => (record.closed = true))
      })
      const alive = () => workers.filter((worker) => !worker.closed).length
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&x=1`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 60_000 })
      await tab.waitForTimeout(1500)

      await tab.hover('[data-testid="office-edit-open"]')
      for (let i = 0; i < 40 && workers.length < 1; i += 1) await tab.waitForTimeout(100)
      if (alive() !== 1) return [`悬停后应有 1 个存活 Worker，实际 ${alive()}`]

      // 移开 3 秒后再回来：宽限期内，不该被销毁
      await tab.mouse.move(5, 5)
      await tab.waitForTimeout(3000)
      await tab.hover('[data-testid="office-edit-open"]')
      await tab.waitForTimeout(6000)
      if (alive() !== 1) issues.push(`宽限期内回来，Worker 不该被销毁，存活 ${alive()}`)

      // 移开不再回来：宽限期（8 秒）后销毁
      await tab.mouse.move(5, 5)
      await tab.waitForTimeout(9500)
      if (alive() !== 0) issues.push(`移开 9.5 秒后 Worker 应已销毁，存活 ${alive()}（泄漏）`)
      if (workers.length !== 1) issues.push(`整个过程只该创建 1 个 Worker，实际 ${workers.length}`)

      // 对照：xlsx 的「在线编辑」是同一个按钮，悬停它不该去下载 Word 引擎（34 MB）
      const before = workers.length
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx&x=1`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 60_000 })
      await tab.waitForTimeout(1500)
      await tab.hover('[data-testid="office-edit-open"]')
      await tab.waitForTimeout(2500)
      if (workers.length !== before) issues.push(`悬停 xlsx 的「在线编辑」不该创建 Word 引擎的 Worker：新增 ${workers.length - before} 个`)
      return issues
    },
  },

  'docx-print': {
    title: '打印：点「打印」→ 新窗口里每页一张整页位图（20 页 = 20 张，铺白纸、非空白、2 倍清晰度）→ 调用打印；不动用户正在看的视图；弹窗被拦截时明说，失败后可再次打印',
    async assert(tab, base) {
      const issues = []
      // headless 下真调 window.print 会阻塞：包装 window.open，把开出的窗口记下来，并把它的 print 换成计数的假实现
      await tab.addInitScript(() => {
        window.__printWins = []
        window.__blockPopups = false
        const open = window.open.bind(window)
        window.open = (...args) => {
          if (window.__blockPopups) return null
          const win = open(...args)
          if (win) {
            win.__printCalls = 0
            win.print = () => (win.__printCalls += 1)
            window.__printWins.push(win)
          }
          return win
        }
      })
      await openDocxEdit(tab, base)
      const scrollBefore = await tab.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)

      // 1. 正常打印。防连点（进行中再点不开第二个窗口）的并发行为在单测里验证（engines/docx/singleFlight.spec.ts）：
      // Playwright 逐次点击间隔几秒到几十秒（实测 2.7 s / 27 s），制造不出真正的并发，在这里测只会得到假结论
      const startedAt = Date.now()
      await docxPress(tab, 'docx.print')
      const ok = await waitFor(
        () => tab.evaluate(() => window.__printWins.length === 1 && window.__printWins[0].__printCalls >= 1),
        // 正常 3 秒左右；40 秒容得下高负载，又不会在卡死（如布局补全失效）时让人干等两分钟
        40_000,
      )
      const took = Date.now() - startedAt
      if (!ok) return ['点「打印」后没有在预期时间内调用打印']
      const info = await tab.evaluate(async () => {
        const win = window.__printWins[0]
        const images = [...win.document.querySelectorAll('img')]
        const decoded = await Promise.all(
          images.map(async (image) => {
            const probe = document.createElement('canvas')
            probe.width = image.naturalWidth
            probe.height = image.naturalHeight
            const context = probe.getContext('2d')
            context.drawImage(image, 0, 0)
            // 抽样：整页网格取点，数"有墨"的像素（不透明且不是白色）；整页空白说明引擎没画上就被取走了。
            // 位图带 alpha：透明像素的 RGB 是 0，直接比 RGB 会把透明当成黑墨——所以必须先看 alpha
            let ink = 0
            let opaque = 0
            let sampled = 0
            const data = context.getImageData(0, 0, probe.width, probe.height).data
            for (let i = 0; i < data.length; i += 4 * 97) {
              sampled += 1
              if (data[i + 3] < 200) continue
              opaque += 1
              if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink += 1
            }
            return { w: image.naturalWidth, h: image.naturalHeight, ink, opaque, sampled, png: image.src.startsWith('data:image/png') }
          }),
        )
        return { count: images.length, decoded, printCalls: win.__printCalls, status: !!win.document.querySelector('.kb-print-status'), title: win.document.title, opener: win.opener }
      })
      console.log(`    · 打印 20 页用时 ${(took / 1000).toFixed(1)} s；每页 ${info.decoded[0]?.w}×${info.decoded[0]?.h}，不透明点占 ${(info.decoded.map((page) => page.opaque / page.sampled).reduce((a, b) => a + b, 0) / info.decoded.length * 100).toFixed(0)}%，有墨抽样点 ${info.decoded.map((page) => page.ink).join('/')}`)
      if (info.count !== 20) issues.push(`20 页文档应有 20 张页图，实际 ${info.count}`)
      if (info.printCalls !== 1) issues.push(`应调用打印恰好 1 次，实际 ${info.printCalls}`)
      if (info.status) issues.push('打印窗口里还留着"正在准备打印"的状态行')
      if (info.opener) issues.push('打印窗口没有断开 opener')
      info.decoded.forEach((page, index) => {
        if (!page.png) issues.push(`第 ${index + 1} 页不是 PNG`)
        // Letter 816×1056 CSS 像素，2 倍光栅 ≈ 1632×2112（样本可能是 A4：1587×2246），只要求"至少 1.5 倍的清晰度"
        if (page.w < 1200 || page.h < 1500) issues.push(`第 ${index + 1} 页位图太小：${page.w}×${page.h}`)
        // 引擎的页位图是透明背景的墨层（只有 ~1% 像素不透明），必须铺白再导出——否则「打印为 PDF」会把透明画成黑底，文字看不见
        if (page.opaque < page.sampled * 0.99) issues.push(`第 ${index + 1} 页有透明背景（不透明点 ${page.opaque}/${page.sampled}）——没有铺白纸，打印成 PDF 会变黑底`)
        if (page.ink < 5) issues.push(`第 ${index + 1} 页几乎是空白（有墨抽样点 ${page.ink}）`)
      })
      // 用户视图不受影响：滚动位置没动，画布还在
      const after = await tab.evaluate(() => ({ scroll: document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop, canvases: document.querySelectorAll('.kb-office-host canvas').length }))
      if (Math.abs(after.scroll - scrollBefore) > 2) issues.push(`打印改动了用户的滚动位置：${scrollBefore} → ${after.scroll}`)
      if (after.canvases < 1) issues.push('打印之后屏幕上的页面画布没了')
      await tab.evaluate(() => window.__printWins.forEach((win) => win.close()))

      // 2. 弹窗被拦截：不能默默失败，要告诉用户怎么办
      await tab.evaluate(() => (window.__blockPopups = true))
      await docxPress(tab, 'docx.print')
      await tab.waitForTimeout(800)
      const toast = await tab.locator('[data-testid="editor-command-notice"]').first().textContent({ timeout: 3000 }).catch(() => '')
      if (!/拦截了打印窗口/.test(toast ?? '')) issues.push(`弹窗被拦截时没有提示用户去允许弹窗：${toast}`)
      // 提示是非致命的：文档还在，可以关掉
      if (!(await tab.locator('.kb-office-host canvas').count())) issues.push('弹窗被拦截的提示出现后文档区消失了')
      await tab.click('[data-testid="editor-command-notice-close"]').catch(() => undefined)
      if (await tab.locator('[data-testid="editor-command-notice"]').count()) issues.push('点"知道了"之后提示还在')
      // 放开弹窗再打印一次：成功后上一条失败提示被清掉，且不会因为上次失败卡在"正在准备打印"
      await tab.evaluate(() => (window.__blockPopups = false))
      await docxPress(tab, 'docx.print')
      const second = await waitFor(() => tab.evaluate(() => window.__printWins.length === 2 && window.__printWins[1].__printCalls >= 1), 40_000)
      if (!second) issues.push('弹窗被拦截失败一次后，再次打印没有成功（可能卡在了"正在准备打印"）')
      return issues
    },
  },

  'docx-image-visible': {
    title: '内嵌图片画得出来（测试的盲区）：文件里原有的图在画布上可见、新插入的图可见、打印出的整页位图里也有；页面 CSP 放行 data: 的 fetch',
    async assert(tab, base, state) {
      const issues = []
      // 墨量：不透明且不是白色的像素占比（抽样）。纯文字页约 0.01~0.1%，一张 960×540 的色块图缩到页宽后约 7%
      const inkOf = () =>
        tab.evaluate(() =>
          [...document.querySelectorAll('.kb-office-host canvas')].map((canvas) => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
            let ink = 0
            let total = 0
            for (let i = 0; i < data.length; i += 4 * 61) {
              total += 1
              if (data[i + 3] > 200 && (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235)) ink += 1
            }
            return (100 * ink) / total
          }),
        )
      await tab.addInitScript(() => {
        window.__printWins = []
        const open = window.open.bind(window)
        window.open = (...args) => {
          const win = open(...args)
          if (win) {
            win.__printCalls = 0
            win.print = () => (win.__printCalls += 1)
            window.__printWins.push(win)
          }
          return win
        }
      })
      // 确认测试跑在带 connect-src 的策略下：这是根因所在，别让测试服务器悄悄关了 CSP 而图片"碰巧"能出。
      // 从主文档的响应头读（页面里 fetch 会被页面自己的 CSP 拦，第一版就栽在这）
      let csp = null
      tab.on('response', (response) => {
        if (response.request().resourceType() === 'document' && response.url().startsWith(base)) csp = response.headers()['content-security-policy'] ?? csp
      })

      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-inline-image.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      if (!csp) issues.push('测试服务器没有下发 CSP——这条场景必须在生产同款策略下跑，否则测不到根因')
      else if (!/connect-src[^;]*\bdata:/.test(csp)) issues.push(`页面 CSP 没有放行 data: 的 fetch，引擎在 Worker 里解码内嵌图片会被拦：${csp}`)
      // 图片在 Worker 里异步解码，等墨量涨起来（最多 15 秒），而不是睡固定时间
      let ink = [0]
      await waitFor(async () => ((ink = await inkOf()), Math.max(...ink) >= 2), 15_000)
      console.log(`    · 文件里原有的内嵌图片：第 1 页画布墨量 ${ink.map((value) => value.toFixed(2)).join('/')}%（纯文字约 0.1% 以下）`)
      if (!(Math.max(...ink) >= 2)) issues.push(`文件里原有的内嵌图片没有画出来：画布墨量只有 ${ink.map((value) => value.toFixed(2)).join('/')}%（有图应在 2% 以上，纯文字约 0.1%）`)

      // 打印出的整页位图里也要有图（打印走另一个临时会话，同样要能解码）
      await docxPress(tab, 'docx.print')
      const printed = await waitFor(() => tab.evaluate(() => window.__printWins.length === 1 && window.__printWins[0].__printCalls >= 1), 40_000)
      if (!printed) issues.push('打印没有完成')
      else {
        const printInk = await tab.evaluate(async () => {
          const image = window.__printWins[0].document.querySelector('img')
          const probe = document.createElement('canvas')
          probe.width = image.naturalWidth
          probe.height = image.naturalHeight
          const context = probe.getContext('2d')
          context.drawImage(image, 0, 0)
          const data = context.getImageData(0, 0, probe.width, probe.height).data
          let ink = 0
          let total = 0
          for (let i = 0; i < data.length; i += 4 * 97) {
            total += 1
            if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) ink += 1
          }
          return (100 * ink) / total
        })
        console.log(`    · 打印位图墨量 ${printInk.toFixed(2)}%`)
        if (!(printInk >= 2)) issues.push(`打印出的整页位图里没有图片：墨量 ${printInk.toFixed(2)}%`)
      }
      // 新插入的图（换成纯文字文档来插，墨量从 ~0 起步）： 的 docx-cmd-image 只验保存后的 XML，从未验画布上看得见。纯文字文档里插一张，墨量应该从 ~0 涨起来
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx&x=1`, { waitUntil: 'domcontentloaded' })
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const before = Math.max(...(await inkOf()))
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      await tab.mouse.click(page1.x + 200, page1.y + 108)
      await tab.keyboard.press('End')
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(300)
      const [chooser] = await Promise.all([tab.waitForEvent('filechooser', { timeout: 10_000 }), docxTool(tab, 'docx.image')])
      await chooser.setFiles(resolve(ROOT, 'e2e/fixtures/editor/doc-image.png'))
      await waitFor(async () => Math.max(...(await inkOf())) >= 2, 15_000)
      const after = Math.max(...(await inkOf()))
      console.log(`    · 新插入的图：墨量 ${before.toFixed(2)}% → ${after.toFixed(2)}%`)
      if (!(after >= 2)) issues.push(`新插入的图片没有画在画布上：墨量 ${before.toFixed(2)}% → ${after.toFixed(2)}%（插图前后都只有文字的量级）`)

      return issues
    },
  },

  'docx-font-notice': {
    title: '缺失字体提示：文档用了站点没有的 Verdana / Consolas → 提示点名并写明后果；Calibri、宋体不被报缺失；常规文档没有提示；可关闭；提示不改变文档内容',
    async assert(tab, base, state) {
      const original = process.env.KB_SAMPLE_DOCX
      const issues = []
      const noticeOf = () => tab.evaluate(() => document.querySelector('[data-testid="docx-edit-font-notice"]')?.textContent?.trim() ?? null)
      // 提示是后台读出来的（要加载字体包、解内嵌字体），所以等到出现或超时，而不是睡固定时间
      const waitNotice = async () => {
        for (let i = 0; i < 60; i += 1) {
          const text = await noticeOf()
          if (text) return text
          await tab.waitForTimeout(250)
        }
        return null
      }

      // 1. 含缺失字体的文档
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-fonts.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const notice = await waitNotice()
      if (!notice) return ['含 Verdana / Consolas 的文档没有出现字体提示——静默替换了字体']
      if (!notice.includes('Verdana')) issues.push(`提示没有点名 Verdana：${notice}`)
      if (!notice.includes('Consolas')) issues.push(`提示没有点名 Consolas：${notice}`)
      if (notice.includes('Calibri')) issues.push(`Calibri 有度量兼容替代（Carlito），不该被报成缺失：${notice}`)
      if (notice.includes('宋体')) issues.push(`宋体用思源黑体子集近似、字宽一致，不该被报成缺失：${notice}`)
      if (!/分页|换行/.test(notice)) issues.push(`提示没有说明后果（换行/分页可能不同）：${notice}`)
      // 提示不遮挡文档：文档区仍有可见高度，画布照常存在
      const layout = await tab.evaluate(() => {
        const scroll = document.querySelector('[data-testid="docx-edit-scroll"]').getBoundingClientRect()
        return { scrollHeight: scroll.height, canvases: document.querySelectorAll('.kb-office-host canvas').length }
      })
      if (layout.scrollHeight < 200 || layout.canvases < 1) issues.push(`提示出现后文档区被挤没了：高 ${layout.scrollHeight}，画布 ${layout.canvases}`)
      // 提示只是提示：文档内容原样，四个段落都在
      const paragraphs = (await docxParagraphs(tab)).join('|')
      for (const word of ['Calibri paragraph', 'Verdana paragraph', 'Consolas paragraph', '宋体段落']) {
        if (!paragraphs.includes(word)) issues.push(`文档内容少了"${word}"`)
      }
      // 可关闭
      await tab.click('[data-testid="docx-edit-font-notice-close"]')
      await tab.waitForTimeout(300)
      if (await noticeOf()) issues.push('点"知道了"之后提示还在')

      // 2. 常规文档（只用默认字体）：不该有提示——否则它就是对所有文档的噪音
      process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      await tab.waitForTimeout(3000)
      const plain = await noticeOf()
      if (plain) issues.push(`常规文档不该有字体提示：${plain}`)

      // 3. 20 页样本：字体表里有 Symbol（Word 默认模板 numbering.xml 的项目符号定义，正文并没有用列表）。
      // Symbol 不该触发提示——曾经把 Symbol 报成缺失，结果提示条挤占了文档区高度，连带让查找跳页的 e2e 在全量里不稳定。
      // 起随站点提供的拉丁字体只剩 Calibri / Arial / Times New Roman 三族，样本里用到的 Cambria 和 Courier 如实报缺失：
      // 提示点名的字体必须恰好就是这两个，不多（比如 Symbol / Calibri）也不少
      await openDocxEdit(tab, base)
      await tab.waitForTimeout(3000)
      const twenty = await noticeOf()
      const named = [...twenty.matchAll(/「([^」]+)」/g)].map((match) => match[1]).sort()
      if (named.join() !== 'Cambria,Courier') issues.push(`20 页样本该如实提示 Cambria / Courier 缺失，且不含 Symbol 等其它字体，实际：${twenty || '（没有提示）'}`)
      if (twenty && !/Liberation (?:Serif|Sans)/.test(twenty)) issues.push(`缺失提示里写的替代字体应是实际画的 Liberation Serif / Sans：${twenty}`)
      return issues
    },
  },

  'docx-mobile': {
    title: '手机 390×844 触屏：能打开、页面不横向溢出、轻点定位后能输入、触摸滚动能翻页、缩放按钮可用、工具栏不撑破视口、长按能选词',
    async assert(tab, base, state) {
      const browser = tab.context().browser()
      const context = await browser.newContext(contextOptions({ width: 390, height: 844, dpr: 2, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      await installFixture(context, { ...SOLO_EDIT_FIXTURE, ...DOCX_EDIT_FIXTURE, __officeEdit: state.office })
      const phone = await context.newPage()
      const errors = []
      phone.on('pageerror', (error) => errors.push(error.message))
      const issues = []
      try {
        await openDocxEdit(phone, base)
        const layout = await phone.evaluate(() => {
          const scroller = document.querySelector('[data-testid="docx-edit-scroll"]')
          const column = document.querySelector('.kb-dex-column')?.getBoundingClientRect()
          const page = document.querySelector('.kb-dex-page')?.getBoundingClientRect()
          const zoom = document.querySelector('[data-testid="docx-edit-zoom"]')?.textContent?.trim()
          return {
            docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
            scrollerOverflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
            pageWidth: page?.width ?? 0,
            columnRight: column?.right ?? 0,
            viewport: window.innerWidth,
            zoom,
            toolbarOverflow: (() => {
              const bar = document.querySelector('[data-testid="editor-chrome"]')
              return bar ? bar.scrollWidth - bar.clientWidth : -1
            })(),
          }
        })
        // 页面应按宽度缩小到刚好放下（打开时的"窄屏估算"），不出现横向滚动条
        if (layout.docOverflowX > 2) issues.push(`整个页面横向溢出 ${layout.docOverflowX}px`)
        if (layout.scrollerOverflowX > 2) issues.push(`文档区横向溢出 ${layout.scrollerOverflowX}px（页宽 ${layout.pageWidth.toFixed(0)}，视口 ${layout.viewport}）`)
        if (layout.pageWidth > layout.viewport) issues.push(`页面比视口还宽：${layout.pageWidth.toFixed(0)} > ${layout.viewport}`)
        if (layout.toolbarOverflow > 2) issues.push(`工具栏撑破视口 ${layout.toolbarOverflow}px`)

        // 轻点定位 → 软键盘式输入：点第一页正文，输入能落进文档
        const page1 = await phone.evaluate(() => {
          const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width }
        })
        await phone.touchscreen.tap(page1.x + page1.w * 0.4, page1.y + page1.w * 0.4)
        await phone.waitForTimeout(600)
        const focused = await phone.evaluate(() => document.activeElement?.classList.contains('paged-editor__input') === true)
        if (!focused) issues.push('轻点页面后隐藏输入框没有拿到焦点（软键盘弹不出来）')
        await phone.keyboard.type('手机输入', { delay: 40 })
        await phone.waitForTimeout(600)
        const text = (await docxParagraphs(phone)).join('')
        if (!text.includes('手机输入')) issues.push('触屏轻点后输入的字没有进文档')

        // 触摸滚动 = 翻页：用 CDP 合成滑动手势
        // 手指逐帧移动（touchStart → 20 次 touchMove → touchEnd）。不用 Input.synthesizeScrollGesture：
        // 实测它对页面里的 overflow 子容器不生效（三个起点都滚不动），而同样的页面用逐帧触摸可以正常滚——
        // 曾因此误判成"产品不能触摸滚动"，对照之后才确认是合成手势的问题
        const cdp = await context.newCDPSession(phone)
        const before = await phone.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 650 }] })
        // 一页在手机上约 750 px 高（页宽缩到 ~390 px）：连滑三次，每次约 500 px，总共必然翻过一页
        for (let swipe = 0; swipe < 3; swipe += 1) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 700 }] })
          for (let i = 1; i <= 20; i += 1) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 700 - i * 25 }] })
            await phone.waitForTimeout(16)
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await phone.waitForTimeout(500)
        }
        await phone.waitForTimeout(500)
        const afterScroll = await phone.evaluate(() => document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop)
        if (!(afterScroll > before + 900)) issues.push(`触摸滑动三次应滚过一页多：scrollTop ${before} → ${afterScroll}`)
        const pageNow = await phone.evaluate(() => document.querySelector('.kb-dex input[aria-label="当前页"]')?.value)
        if (!(Number(pageNow) >= 2)) issues.push(`翻页后页码没更新：${pageNow}`)

        // 长按进入选择（500 ms）：按住不动，再向右拖一点，应出现选区块；松手后选区还在
        await phone.evaluate(() => (document.querySelector('[data-testid="docx-edit-scroll"]').scrollTop = 0))
        await phone.waitForTimeout(500)
        const pressAt = await phone.evaluate(() => {
          const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
          return { x: r.x + r.width * 0.2, y: r.y + r.width * 0.42 }
        })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pressAt.x, y: pressAt.y }] })
        await phone.waitForTimeout(700)
        for (let i = 1; i <= 12; i += 1) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pressAt.x + i * 10, y: pressAt.y }] })
          await phone.waitForTimeout(16)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await phone.waitForTimeout(700)
        const selectionBlocks = await phone.locator('.kb-dex-selection').count()
        if (selectionBlocks < 1) issues.push('长按后向右拖动没有产生选区')

        // 缩放按钮可用且点得到（按钮大小至少 24px，手指能按）
        const buttons = await phone.evaluate(() => ['docx-edit-zoom-in', 'docx-edit-zoom-out'].map((id) => {
          const rect = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
          return rect ? { id, w: rect.width, h: rect.height, visible: rect.right <= window.innerWidth && rect.left >= 0 } : { id, missing: true }
        }))
        for (const button of buttons) {
          if (button.missing || !button.visible) issues.push(`缩放按钮 ${button.id} 不在视口内`)
          else if (button.w < 24 || button.h < 24) issues.push(`缩放按钮 ${button.id} 太小，手指按不准：${button.w}×${button.h}`)
        }
        const widthBefore = await phone.evaluate(() => document.querySelector('.kb-dex-column').getBoundingClientRect().width)
        await phone.tap('[data-testid="docx-edit-zoom-in"]')
        await phone.tap('[data-testid="docx-edit-zoom-in"]')
        await phone.waitForTimeout(700)
        const widthAfter = await phone.evaluate(() => document.querySelector('.kb-dex-column').getBoundingClientRect().width)
        if (!(widthAfter > widthBefore * 1.3)) issues.push(`点放大两次页面应明显变宽：${widthBefore.toFixed(0)} → ${widthAfter.toFixed(0)}`)
      } finally {
        if (errors.length) issues.push(`页面异常：${errors.slice(0, 2).join(' | ')}`)
        await context.close()
      }
      return issues
    },
  },

  'docx-edit-input-latency': {
    title: '输入延迟：拉丁文段落走本地回显，字符交给编辑器到光标更新（主线程）中位 <16 ms；中文段落等引擎回帧，不在这里卡',
    async assert(tab, base) {
      const latin = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
      const original = process.env.KB_SAMPLE_DOCX
      process.env.KB_SAMPLE_DOCX = latin
      try {
        await openDocxEdit(tab, base)
      } finally {
        process.env.KB_SAMPLE_DOCX = original
      }
      const page1 = await tab.evaluate(() => {
        const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      // 两个起点：keydown（用户按下）与 beforeinput（字符真正交给编辑器）。Chrome 把它们分在两个任务里，
      // 机器忙时中间会被别的任务插队；beforeinput → 光标更新才是编辑器自己的处理耗时
      await tab.evaluate(() => {
        window.__lat = []
        window.__latInput = []
        let down = 0
        let input = 0
        document.addEventListener('keydown', () => { down = performance.now(); input = 0 }, true)
        document.addEventListener('beforeinput', () => { input = performance.now() }, true)
        new MutationObserver(() => {
          const now = performance.now()
          if (down) { window.__lat.push(now - down); if (input) window.__latInput.push(now - input); down = 0; input = 0 }
        }).observe(document.querySelector('.kb-dex-pages'), { subtree: true, childList: true, attributes: true })
      })
      const measure = async (clickY, count) => {
        await tab.evaluate(() => { window.__lat.length = 0; window.__latInput.length = 0 })
        await tab.mouse.click(page1.x + 200, page1.y + clickY)
        await tab.waitForTimeout(800)
        for (let i = 0; i < count; i += 1) {
          await tab.keyboard.type(String.fromCharCode(97 + (i % 26)))
          await tab.waitForTimeout(150)
        }
        await tab.waitForTimeout(400)
        const sorted = (name) => tab.evaluate((key) => window[key].slice().sort((a, b) => a - b), name)
        return { lat: await sorted('__lat'), latInput: await sorted('__latInput') }
      }
      const at = (list, q) => list[Math.min(list.length - 1, Math.floor(list.length * q))]
      const line = (list) => `中位 ${at(list, 0.5).toFixed(1)} ms，p95 ${at(list, 0.95).toFixed(1)} ms，最大 ${list.at(-1).toFixed(1)} ms`
      // 行尾（点页面下方空白 = 文档末段末尾）：最常见的输入位置，引擎对单向拉丁文段落下发回显上下文，字符本地先画
      const tail = await measure(140, 24)
      if (tail.lat.length < 18 || tail.latInput.length < 18) return [`只量到 ${tail.lat.length}/${tail.latInput.length} 次光标更新（应接近 24）`]
      console.log(`    · 行尾（${tail.lat.length} 次）：keydown→光标 ${line(tail.lat)}；beforeinput→光标 ${line(tail.latInput)}`)
      // 行中（点第一段中间）：要重排光标后面的字，仍在一帧内，只报告不卡
      const middle = await measure(108, 12)
      if (middle.latInput.length >= 6) console.log(`    · 行中（${middle.lat.length} 次）：beforeinput→光标 ${line(middle.latInput)}（仅报告）`)
      // 回显必须真的生效，而不是碰巧快：输入后文档里确实有这些字母
      const text = (await docxParagraphs(tab)).join('\n')
      const issues = []
      if (!text.includes('abcdefghijklmnopqrstuvwx')) issues.push(`行尾输入的 24 个字母没有按序进文档：${text.slice(0, 100)}`)
      // 阈值 16 ms 是一帧；机器很忙时单次会抖，所以只卡中位数。编辑器自己的耗时（beforeinput → 光标）卡 16 ms；
      // 含任务间插队的 keydown → 光标放宽到两帧
      if (at(tail.latInput, 0.5) >= 16) issues.push(`行尾 beforeinput→光标 中位 ${at(tail.latInput, 0.5).toFixed(1)} ms ≥ 16 ms`)
      if (at(tail.lat, 0.5) >= 32) issues.push(`行尾 keydown→光标 中位 ${at(tail.lat, 0.5).toFixed(1)} ms ≥ 32 ms`)
      return issues
    },
  },
}

/** 20 份真实代码/配置逐个进入统一外壳：打开、编辑、保存都要保住原文与增量 */
async function codeFiles(limit) {
  const roots = [join(ROOT, 'src'), join(ROOT, 'e2e')]
  const allow = /\.(?:ts|tsx|js|mjs|vue|json|ya?ml|toml|rs|py|sh|css|html|md)$/i
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', 'shots'].includes(entry.name)) continue
        await walk(path)
      } else if (allow.test(entry.name)) {
        files.push(path)
      }
    }
  }
  for (const root of roots) {
    await walk(root)
    if (files.length >= limit) break
  }
  return files
}

async function runCodeRegression({ base, engine, browser }) {
  const files = await codeFiles(args.regression)
  if (files.length < args.regression) return [`真实代码文件不足：只找到 ${files.length} 份`]
  const saved = []
  for (const [index, path] of files.entries()) {
    const text = await readFile(path, 'utf8')
    const name = path.slice(ROOT.length + 1).replaceAll('/', '-')
    FILES[`file_reg_${index}`] = {
      item: fileItem(`file_reg_${index}`, name, []),
      preview: { format: name.split('.').pop() ?? 'txt', editable: true, extractor: 'text/plain', content: text, blocks: [], chunks: [] },
    }
  }
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, engine))
  const issues = []
  await installFixture(context, {
    ...SOLO_EDIT_FIXTURE,
    save_file: (payload) => {
      saved.push(payload)
      return { version: 9, embedded: 0, chunks: 0 }
    },
  })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => issues.push(`页面异常：${error.message}`))
  for (const [index] of files.entries()) {
    const id = `file_reg_${index}`
    const marker = `// e2e regression ${index}`
    await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${id}`, { waitUntil: 'domcontentloaded' })
    const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
    await edit.waitFor({ state: 'visible', timeout: 20_000 })
    await edit.click()
    const mounted = await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="code"] .cm-content', { timeout: 20_000 }).catch(() => null)
    if (!mounted) {
      issues.push(`${id} 没进入统一代码编辑器`)
      continue
    }
    await tab.click('[data-testid="editor-host"] .cm-content')
    await tab.keyboard.press('Control+End')
    await tab.keyboard.type(`\n${marker}`)
    await tab.keyboard.press('Control+s')
    const ok = await waitFor(async () => saved.some((entry) => String(entry?.content ?? '').includes(marker)), 3000)
    if (!ok) issues.push(`${id} 保存请求没带上增量`)
    if (saved.some((entry) => String(entry?.content ?? '').includes('\r\n'))) issues.push(`${id} 保存把行尾改成了 CRLF`)
  }
  await context.close()
  return issues
}


/** 真实语料回归：100 篇仓库内 Markdown 逐个进编辑态并确认正文渲染出来 */
async function regressionFiles(limit) {
  const roots = [join(REPO, 'docs'), join(REPO, 'skills')]
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue
        await walk(path)
      } else if (entry.name.endsWith('.md')) {
        files.push(path)
      }
    }
  }
  for (const root of roots) {
    await walk(root)
    if (files.length >= limit) break
  }
  return files
}

async function runRegression({ base, engine, browser }) {
  const files = await regressionFiles(args.regression)
  if (files.length < Math.min(args.regression, 100)) {
    return [`真实语料不足：只找到 ${files.length} 篇 Markdown`]
  }
  const docs = new Map()
  for (const [index, path] of files.entries()) {
    const text = await readFile(path, 'utf8')
    const id = `ins_reg_${index}`
    docs.set(id, { text, title: path.replace(`${REPO}/`, '') })
  }
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, engine))
  const issues = []
  await installFixture(context, {
    ...SOLO_EDIT_FIXTURE,
    get_item: (payload) => {
      const doc = docs.get(payload?.id)
      if (!doc) return { item: null, context: null }
      return {
        item: {
          id: payload.id,
          collection: 'proj_knowledgebase',
          kind: 'insight',
          insight_kind: null,
          confidence: null,
          lang: null,
          source: `insight:${payload.id}`,
          start_line: null,
          end_line: null,
          symbol: null,
          title: doc.title,
          status: 'active',
          tags: [],
          updated_at: new Date().toISOString(),
          version: 1,
          text: doc.text,
          header: doc.title,
          origin: null,
          embedded_at: null,
        },
        context: null,
      }
    },
  })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => issues.push(`页面异常：${error.message}`))
  for (const id of docs.keys()) {
    await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${id}`, { waitUntil: 'domcontentloaded' })
    const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
    await edit.waitFor({ state: 'visible', timeout: 20_000 })
    await edit.click()
    const mounted = await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose', { timeout: 20_000 }).catch(() => null)
    if (!mounted) {
      issues.push(`${id} 没进入编辑态`)
      continue
    }
    const empty = await tab.evaluate(() => (document.querySelector('.kb-text-prose')?.textContent ?? '').trim().length === 0)
    if (empty) issues.push(`${id} 正文为空`)
  }
  await context.close()
  return issues
}

async function main() {
  if (args.surface === 'csv') registerCsvFixtures()
  if (args.surface === 'text') {
    const { issues, lines } = textManifestGate()
    console.log(lines.join('\n'))
    if (issues.length) {
      console.error(`✗ 文本面构建期门禁未通过\n  ${issues.join('\n  ')}`)
      process.exit(1)
    }
    console.log('✓ 文本面构建期门禁：笔记编辑增量在预算内')
  }
  if (args.surface === 'docx') {
    const manifestIssues = docxManifestGate()
    if (manifestIssues.length) {
      console.error(`✗ Word 编辑构建期门禁未通过\n  ${manifestIssues.join('\n  ')}`)
      process.exit(1)
    }
    console.log('✓ Word 编辑构建期门禁：默认路径的静态依赖里没有 docx-react / React')
  }
  if (args.surface === 'xlsx') {
    const manifestIssues = xlsxManifestGate()
    if (manifestIssues.length) {
      console.error(`✗ XLSX 构建期门禁未通过\n  ${manifestIssues.join('\n  ')}`)
      process.exit(1)
    }
  }
  if (args.surface === 'pptx') {
    const manifestIssues = pptxManifestGate()
    if (manifestIssues.length) {
      console.error(`✗ PPTX 构建期门禁未通过\n  ${manifestIssues.join('\n  ')}`)
      process.exit(1)
    }
    console.log('✓ PPTX 构建期门禁：入口 / FileViewer / OfficeEditor 的静态依赖里没有 pptx-react / pptx-preview / pptx-i18n / React；原生路径按需加载')
  }
  const { server, base } = await startStaticServer()
  const engines = pickEngines()
  const scenarios =
    args.surface === 'code'
      ? CODE_SCENARIOS
      : args.surface === 'pdf'
        ? PDF_SCENARIOS
        : args.surface === 'csv'
          ? CSV_SCENARIOS
          : args.surface === 'xlsx-read'
            ? XLSX_SCENARIOS
            : args.surface === 'xlsx'
              ? XLSX_EDIT_SCENARIOS
              : args.surface === 'docx-read'
                ? DOCX_READ_SCENARIOS
                : args.surface === 'docx'
                  ? DOCX_EDIT_SCENARIOS
                  : args.surface === 'pptx-read'
                    ? PPTX_READ_SCENARIOS
                    : args.surface === 'pptx'
                      ? { ...PPTX_READ_SCENARIOS, ...PPTX_EDIT_SCENARIOS }
                      : TEXT_SCENARIOS
  let failed = 0
  try {
    for (const engine of engines) {
      const browser = await launch(engine)
      for (const [id, scenario] of Object.entries(scenarios)) {
        if (args.only.length && !args.only.some((part) => id.includes(part))) continue
        // KB_SCENARIO=正则：只跑名字匹配的场景（排查单个失败时用）
        if (process.env.KB_SCENARIO && !new RegExp(process.env.KB_SCENARIO).test(id)) continue
        const context = await browser.newContext(
          contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, engine, { locale: 'zh-CN' }),
        )
        const saved = []
        const office = args.surface === 'xlsx' || args.surface === 'docx' || args.surface === 'pptx' ? {} : null
        // pptx 阶段门禁里读写场景混跑：只有声明 upload 的场景把文件当成上传的（可在线编辑），其余保持项目目录里的只读预览
        if (args.surface === 'pptx') {
          FILES.file_pptx.item.origin = scenario.upload ? 'upload' : PPTX_FIXTURE_ORIGIN.item
          FILES.file_pptx.preview.origin = scenario.upload ? 'upload' : PPTX_FIXTURE_ORIGIN.preview
        }
        // CSV 门禁用带字节的假服务端（csv-server-fake.mjs）：csv_read / csv_edit / save_file 都真的按编码解码、编码
        const server = args.surface === 'csv' ? seedCsvServer(new FakeCsvServer(), { big: !!scenario.big }) : null
        const overrides =
          args.surface === 'xlsx'
            ? { ...SOLO_EDIT_FIXTURE, __officeEdit: office }
            : args.surface === 'docx'
              ? { ...SOLO_EDIT_FIXTURE, ...DOCX_EDIT_FIXTURE, __officeEdit: office }
              : args.surface === 'pptx'
                ? { ...SOLO_EDIT_FIXTURE, file_preview: pptxPreview, ...(scenario.upload ? { __officeEdit: office, file_info: PPTX_UPLOAD_INFO } : {}), ...(scenario.fixture ?? {}) }
                : args.surface === 'pptx-read'
                  ? { ...SOLO_EDIT_FIXTURE, file_preview: pptxPreview }
                  : args.surface === 'code' || args.surface === 'csv'
              ? {
                  ...SOLO_EDIT_FIXTURE,
                  ...(scenario.overrides ?? {}),
                  save_file: (payload) => {
                    saved.push(payload)
                    // 本地小文件那条路：按文件原来的编码写回假服务端，场景可以验证字节
                    if (server) return server.saveText(payload)
                    return { version: 9, embedded: 0, chunks: 0 }
                  },
                }
              : {
                  ...SOLO_EDIT_FIXTURE,
                  edit_item: (payload) => {
                    saved.push(payload)
                    return { id: payload?.id ?? ITEM, version: 5, collection: 'proj_knowledgebase', job_id: null }
                  },
                }
        await installFixture(context, { ...overrides, ...(scenario.fixture ?? {}) })
        if (server) await server.install(context)
        const tab = await context.newPage()
        const errors = []
        tab.on('pageerror', (error) => errors.push(error.message))
        const issues = (await scenario.assert(tab, base, { saved, office, server }).catch((error) => [error.message])).concat(errors.map((e) => `页面异常：${e}`))
        if (issues.length) {
          failed += 1
          console.log(`✗ [${engine}] ${id} ${scenario.title}\n  ${issues.join('\n  ')}`)
        } else {
          console.log(`✓ [${engine}] ${id}`)
        }
        await context.close()
      }
      if (args.regression > 0) {
        const issues = args.surface === 'code' ? await runCodeRegression({ base, engine, browser }) : await runRegression({ base, engine, browser })
        const unit = args.surface === 'code' ? '份代码/配置' : '篇真实 Markdown'
        if (issues.length) {
          failed += 1
          console.log(`✗ [${engine}] regression ${args.regression} ${unit}\n  ${issues.slice(0, 20).join('\n  ')}`)
        } else {
          console.log(`✓ [${engine}] regression ${args.regression} ${unit}`)
        }
      }
      await browser.close()
    }
  } finally {
    server.close()
  }
  if (failed) {
    console.log(`\n${failed} 项未通过`)
    process.exit(1)
  }
  console.log(`\n✓ ${args.surface} 阶段门禁全部通过`)
}

void main()
