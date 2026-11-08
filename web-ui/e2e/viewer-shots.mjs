#!/usr/bin/env node
// 查看器 / 编辑器的多分辨率截图 + 行为断言(不做原型像素比对,因为这批改动有意偏离设计稿)。
//
// 用 fixture 拦 /api/v1/**(真实样本文件见 e2e/fixtures/sample.*),所以不需要守护进程:
//   npm run build && node e2e/viewer-shots.mjs                # 全部场景 × 五个尺寸
//   node e2e/viewer-shots.mjs pdf docx                        # 只跑几个场景
//   KB_SIZES=390x844,1440x900 node e2e/viewer-shots.mjs pdf   # 只跑几个尺寸
//   KB_ENGINE=webkit node e2e/viewer-shots.mjs read-md        # 换浏览器引擎(chromium / webkit / firefox / all)
//   KB_DEVICE_GROUP=phone node e2e/viewer-shots.mjs read-md   # 按设备组(core / phone / tablet / desktop / all)
// 输出:e2e/shots/viewer/<场景>-<尺寸>.png,以及每格的断言结果;任何断言失败 → 退出码 1。
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { contextOptions, engineSuffix, launch, pickDevices, pickEngines } from './devices.mjs'
import { ALL_FEATURES, adminMe, dynamicResponses, gradientPng, installFixture, NOW } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { SHELL_SCENARIOS } from './shell-scenarios.mjs'
import { KIT_SCENARIOS } from './kit-scenarios.mjs'
import { DEVICE_SCENARIOS } from './device-scenarios.mjs'
import { PWA_SCENARIOS } from './pwa-scenarios.mjs'
import { SECURITY_SCENARIOS } from './security-scenarios.mjs'
import { FRIENDS_SCENARIOS } from './friends-scenarios.mjs'
import { NOTIFICATION_SCENARIOS } from './notifications-scenarios.mjs'
import { SHARE_SCENARIOS } from './share-scenarios.mjs'
import { ADMIN_SCENARIOS } from './admin-scenarios.mjs'
import { COLLAB_SCENARIOS } from './collab-scenarios.mjs'
import { HOME_SCENARIOS } from './home-scenarios.mjs'
import { SEARCH_SCENARIOS } from './search-scenarios.mjs'
import { TASKS_SCENARIOS } from './tasks-scenarios.mjs'
import { REVIEW_SCENARIOS } from './review-scenarios.mjs'
import { STATUS_SCENARIOS } from './status-scenarios.mjs'
import { IMPORT_SCENARIOS } from './import-scenarios.mjs'
import { ASSISTANT_SCENARIOS } from './assistant-scenarios.mjs'
import { ADMIN_PAGES_SCENARIOS } from './admin-pages-scenarios.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { EDITOR_MOBILE_SCENARIOS } from './editor-mobile-scenarios.mjs'
import { TABLET_SCENARIOS } from './tablet-scenarios.mjs'
import { UPLOAD_SCENARIOS } from './upload-scenarios.mjs'
import { INAPP_SCENARIOS } from './inapp-scenarios.mjs'
import { SETTINGS_SCENARIOS } from './settings-scenarios.mjs'
import { CAMERA_SCENARIOS } from './camera-scenarios.mjs'
import { AXE_SCENARIOS } from './axe-scenarios.mjs'
import { ADMIN_FLOW_SCENARIOS } from './admin-flow-scenarios.mjs'
import { FLOW_SCENARIOS } from './flow-scenarios.mjs'
import { CORE_SCENARIOS } from './core-scenarios.mjs'
import { ACCOUNT_SCENARIOS } from './account-scenarios.mjs'
import { KEYS_EXTRA_SCENARIOS } from './keys-extra-scenarios.mjs'
import { DENSITY_SCENARIOS } from './density-scenarios.mjs'
import { TREE_SCENARIOS } from './tree-scenarios.mjs'
import { CONTROLS_SCENARIOS } from './controls-scenarios.mjs'
import { AVATAR_SCENARIOS } from './avatar-scenarios.mjs'
import { STICKY_SCENARIOS } from './sticky-scenarios.mjs'
import { SPACING_SCENARIOS } from './spacing-scenarios.mjs'
import { GUIDE_SCENARIOS } from './guide-scenarios.mjs'
import { CHARTS_SCENARIOS } from './charts-scenarios.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'e2e/shots/viewer')
const COLLECTION = 'knowledgeBase%2Finsights'
const route = (item, extra = '') => `/kb?collection=${COLLECTION}&item=${item}${extra}`

// 尺寸与引擎来自 e2e/devices.mjs:KB_SIZES / KB_DEVICE_GROUP 选尺寸(默认 core 五个),KB_ENGINE=chromium|webkit|firefox|all 选引擎
const SIZES = pickDevices()
const ENGINE_NAMES = pickEngines()

/** 笔记 / Markdown 默认走统一外壳的新文本面:正文是 .kb-text-prose,工具栏在 .kb-editor-chrome。
 *  工具栏按钮用稳定的 data-action(动作 id)认,不用带图标前缀的 aria-label;窄屏放不下的按钮会收进「更多」菜单,
 *  「插入」下拉里的子项(附件、代码块……)在菜单打开时才进 DOM,所以要把三处都展开读一遍 */
const NATIVE_HOST = '[data-testid="editor-host"]'
async function nativeToolIds(tab) {
  const slot = `${NATIVE_HOST} [data-testid="editor-toolbar-slot"]`
  const ids = new Set(await tab.locator(`${slot} [data-action]`).evaluateAll((els) => els.map((el) => el.getAttribute('data-action'))))
  const collect = async (trigger) => {
    await trigger.click()
    for (const id of await tab.locator('[role="menu"] [data-action]').evaluateAll((els) => els.map((el) => el.getAttribute('data-action')))) ids.add(id)
    // 下拉与「更多」都是点一下开、再点一下关;焦点在编辑器里时 Escape 关不掉它们
    await trigger.click()
  }
  const insert = tab.locator(`${slot} button[data-action="insertMore"]`)
  if (await insert.count()) await collect(insert)
  // 「引用」和正文 / 各级标题在同一个「段落格式」下拉里(下拉按钮显示当前段落样式)
  const heading = tab.locator(`${slot} button[data-action="heading"]`)
  if (await heading.count()) await collect(heading)
  const more = tab.locator(`${NATIVE_HOST} [data-testid="editor-toolbar-more"]`)
  if (await more.count()) await collect(more)
  return ids
}
/** 点工具栏上的某个动作:直接在工具栏上、在「插入」下拉里,或(放不下时)在「更多」菜单里。
 *  工具栏会随状态条文字、菜单开合重新测量宽度(同一个动作可能在两轮测量之间从「更多」里变回直接按钮),
 *  所以「它在哪」不能判断一次就定死:每一轮都重新找,找不到再逐个展开可能装着它的菜单,最多重试几轮 */
async function clickNativeTool(tab, id) {
  const slot = `${NATIVE_HOST} [data-testid="editor-toolbar-slot"]`
  const target = tab.locator(`${slot} [data-action="${id}"]`).first()
  const triggers = [tab.locator(`${slot} button[data-action="insertMore"]`), tab.locator(`${NATIVE_HOST} [data-testid="editor-toolbar-more"]`)]
  for (let round = 0; round < 6; round++) {
    if (await target.isVisible()) return target.click({ timeout: 5000 })
    for (const trigger of triggers) {
      if (!(await trigger.count())) continue
      await trigger.click({ timeout: 5000 })
      await tab.waitForTimeout(150)
      if (await target.isVisible()) return target.click({ timeout: 5000 })
      await trigger.click({ timeout: 5000 }).catch(() => undefined) // 没找到:收起,换下一个
    }
    await tab.waitForTimeout(200)
  }
  throw new Error(`工具栏里找不到动作 ${id}`)
}

/** 新文本面的正文节点,与 {@link NATIVE_HOST} 配套 */
const NPM = `${NATIVE_HOST} .kb-text-prose`
/** 点「编辑」进入新外壳的编辑态,等工具栏和可写的正文都就绪(协同没连上时正文是只读的,要用 SOLO_EDIT_FIXTURE) */
async function enterNativeEdit(tab) {
  await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
  await tab.waitForSelector(`${NATIVE_HOST} [data-testid="editor-chrome"]`, { timeout: 15_000 })
  await tab.waitForSelector(`${NPM}[contenteditable="true"]`, { timeout: 15_000 })
}

/** 每个场景:路由、等待就绪的选择器、额外断言。assert 返回字符串数组(问题列表,空 = 通过)。 */
/** 等某个 <img> 加载完成并且宽度达到 `width`(0 = 只要加载出来)。图片元素一插入就能选到,但字节还在路上,
 *  立刻读 complete 会在机器忙时误报,所以要等。 */
async function imageLoaded(tab, selector, width = 0, timeout = 8000) {
  return tab
    .waitForFunction(
      ([sel, wanted]) => {
        const img = document.querySelector(sel)
        return !!img && img.complete && img.naturalWidth > 0 && (wanted === 0 || img.naturalWidth === wanted)
      },
      [selector, width],
      { timeout },
    )
    .then(() => true)
    .catch(() => false)
}

const SCENARIOS = {
  pdf: {
    route: route('file_pdf', '&highlight=ck_p7_3'),
    ready: '.kb-pv .pdfViewer .page .canvasWrapper canvas',
    settle: 900,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({
        pages: document.querySelectorAll('.kb-pv .pdfViewer .page').length,
        textLayer: document.querySelector('.kb-pv .textLayer')?.textContent?.length ?? 0,
        painted: [...document.querySelectorAll('.kb-pv .pdfViewer .page canvas')].some((canvas) => canvas.width > 0),
        hit: document.querySelectorAll('.kb-pv .textLayer .highlight').length,
        hitChip: !!document.querySelector('.kb-pv-hit'),
        page: document.querySelector('.kb-pv-page')?.value,
      }))
      if (info.pages < 8) issues.push(`页数 ${info.pages} < 8`)
      if (!info.painted) issues.push('画布没有画出内容')
      if (!info.hitChip) issues.push('命中提示条缺失')
      if (info.page !== '7') issues.push(`应翻到第 7 页,实际 ${info.page}`)
      return issues
    },
  },
  docx: {
    route: route('file_docx', '&highlight=ck_docx_2'),
    ready: '.kb-pgs .kbdocx-wrapper section.kbdocx',
    settle: 700,
    assert: async (tab) => {
      const info = await tab.evaluate(() => {
        const section = document.querySelector('.kb-pgs section.kbdocx')
        const scroller = document.querySelector('.kb-pgs-scroll')
        return {
          text: section?.textContent?.includes('混合检索') ?? false,
          table: !!document.querySelector('.kb-pgs table'),
          overflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
          hit: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('kb-hit') : null,
        }
      })
      const issues = []
      if (!info.text) issues.push('文档正文没渲染')
      if (!info.table) issues.push('表格没渲染')
      if (info.overflowX > 2) issues.push(`文档区横向滚动 ${info.overflowX}px(应按宽度缩放)`)
      if (info.hit === false) issues.push('命中句子没高亮')
      return issues
    },
  },
  // 默认预览是统一外壳的幻灯片面：命中第 3 张 → 画布出来、缩略图都在；文字在 canvas 里，不在 DOM
  pptx: {
    route: route('file_pptx', '&highlight=ck_sl3'),
    ready: '[data-testid="editor-host"][data-surface-kind="slide"] [data-testid="slide-canvas"]',
    settle: 900,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({
        thumbs: document.querySelectorAll('[data-testid="slide-thumb"]').length,
        total: document.querySelector('[data-testid="slide-total"]')?.textContent?.trim() ?? '',
        switcher: !!document.querySelector('[data-testid="editor-host"] .kb-fv-switch'),
      }))
      const issues = []
      if (info.thumbs < 3) issues.push(`缩略图 ${info.thumbs} < 3`)
      if (!/\d/.test(info.total)) issues.push(`页数指示不对：${info.total}`)
      if (!info.switcher) issues.push('没有「文字层」切换按钮')
      return issues
    },
  },
  // 默认预览是原生只读网格：命中 → 切到「评测汇总」并选中 A2
  xlsx: {
    route: route('file_xlsx', '&highlight=ck_s_r2'),
    ready: '[data-testid="editor-host"] .kb-xg .kb-xg-canvas',
    settle: 800,
    assert: async (tab) => {
      await tab.waitForFunction(() => !document.querySelector('.kb-xg-loading'), null, { timeout: 15_000 }).catch(() => undefined)
      const info = await tab.evaluate(() => ({
        tabs: [...document.querySelectorAll('.kb-xg-tab')].map((t) => t.textContent?.trim()),
        active: document.querySelector('.kb-xg-tab[aria-selected="true"]')?.textContent?.trim(),
        cell: document.querySelector('.kb-xg-cellname')?.textContent?.trim(),
        old: !!document.querySelector('.kb-sg'),
        switcher: !!document.querySelector('.kb-fv-switch'),
      }))
      const issues = []
      if (info.tabs.length !== 2) issues.push(`工作表页签 ${info.tabs.length} != 2`)
      if (info.active !== '评测汇总') issues.push(`命中工作表 ${info.active}`)
      if (info.cell !== 'A2') issues.push(`命中格应为 A2,实际 ${info.cell}`)
      if (info.old) issues.push('默认路径还挂着旧表格视图')
      if (!info.switcher) issues.push('没有「文字层」切换按钮')
      return issues
    },
  },
  csv: {
    route: route('file_csv', '&highlight=ck_csv_2'),
    ready: '.kb-sg .kb-sg-row',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({ cell: document.querySelector('.kb-sg-row .kb-sg-cell:nth-child(3)')?.textContent, hit: document.querySelectorAll('.kb-sg-row.is-hit').length }))
      if (!info.cell) issues.push('CSV 没解析出单元格')
      if (info.hit !== 1) issues.push(`命中行 ${info.hit} != 1`)
      // 引号里带逗号的字段不能被拆开
      const quoted = await tab.evaluate(() => [...document.querySelectorAll('.kb-sg-row .kb-sg-cell')].some((cell) => cell.textContent?.includes('UDS 断线, 第')))
      if (!quoted) issues.push('带引号的逗号字段被拆开了')
      return issues
    },
  },
  code: {
    route: route('file_rs', '&highlight=ck_rs_1'),
    ready: '.kb-ce .cm-line',
    settle: 700,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({
        lines: document.querySelectorAll('.kb-ce .cm-line').length,
        hits: document.querySelectorAll('.kb-ce .cm-line.kb-ce-hit').length,
        coloured: document.querySelectorAll('.kb-ce .cm-line span[class]').length,
        lang: document.querySelector('.kb-ce-lang')?.textContent,
        readonly: document.querySelector('.kb-ce.is-readonly') !== null,
        gutter: !!document.querySelector('.kb-ce .cm-lineNumbers'),
      }))
      const issues = []
      if (info.lines < 15) issues.push(`行数 ${info.lines}`)
      if (info.hits !== 7) issues.push(`命中行高亮 ${info.hits} != 7`)
      if (info.coloured < 10) issues.push('没有语法高亮')
      if (info.lang !== 'Rust') issues.push(`语言应为 Rust,实际 ${info.lang}`)
      if (!info.readonly || !info.gutter) issues.push('应为只读且带行号')
      return issues
    },
  },
  ocr: {
    route: route('file_png', '&highlight=ck_i3'),
    ready: '.kb-iv img',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({ w: document.querySelector('.kb-iv img')?.getBoundingClientRect().width ?? 0, tools: !!document.querySelector('.kb-iv-tools') }))
      if (info.w < 50) issues.push('图片没显示')
      if (!info.tools) issues.push('缺少缩放工具条')
      return issues
    },
  },
  'edit-code': {
    // 单人编辑路径:默认夹具带 collab.edit,会去连假后端没有的协作房间,.cm-content 一直是 contenteditable=false
    fixture: SOLO_EDIT_FIXTURE,
    route: route('file_rs'),
    ready: '.kb-workspace-bar-right',
    prepare: async (tab) => {
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      // 等到真正可写:.is-readonly 只反映 readonly 属性,协作未连上时的锁定不会加这个类,旧选择器会在只读状态下提前通过
      await tab.waitForSelector('.kb-ce .cm-content[contenteditable="true"]', { timeout: 15_000 })
      await tab.waitForTimeout(500)
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.click('.kb-ce .cm-content')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('\n// 新增的一行')
      const typed = await tab.evaluate(() => document.querySelector('.kb-ce .cm-content')?.textContent?.includes('新增的一行'))
      if (!typed) issues.push('键盘输入没进编辑器')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/save_file'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('Ctrl+S 没触发 save_file')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        if (!String(body.content ?? '').includes('新增的一行')) issues.push('保存内容里没有新输入')
      }
      return issues
    },
  },
  'read-md': {
    // 打开经验条目:语雀式阅读页(标题 + 元信息 + 正文 + 宽屏目录),没有编辑器工具栏
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2',
    settle: 500,
    assert: async (tab, size) => {
      const info = await tab.evaluate(() => {
        const prose = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')
        const title = document.querySelector('.kb-dp-title')
        return {
          toolbar: !!document.querySelector('.kb-doc-bar'),
          editable: prose?.getAttribute('contenteditable'),
          title: title?.textContent?.trim(),
          titleTag: title?.tagName,
          wikilink: document.querySelectorAll('.kb-dp .kb-wikilink').length,
          toc: !!document.querySelector('.kb-dp-toc'),
          tocBtn: !!document.querySelector('.kb-dp-toc-btn'),
          fontSize: prose ? parseFloat(getComputedStyle(prose).fontSize) : 0,
          lineHeight: prose ? parseFloat(getComputedStyle(prose.querySelector('p') ?? prose).lineHeight) : 0,
          width: prose?.getBoundingClientRect().width ?? 0,
          crumb: document.querySelector('.kb-crumb')?.textContent?.replace(/\s+/g, ''),
          idInBar: (document.querySelector('.kb-workspace-bar')?.textContent ?? '').includes('insight:'),
        }
      })
      const issues = []
      if (info.toolbar) issues.push('阅读视图里不该出现编辑工具栏')
      if (info.editable === 'true') issues.push('阅读视图正文不该可编辑')
      if (info.titleTag !== 'H1' || !info.title?.includes('UDS')) issues.push(`标题 ${info.titleTag} ${info.title}`)
      if (info.wikilink !== 1) issues.push(`双链 ${info.wikilink}`)
      if (info.idInBar) issues.push('顶栏不该显示 insight:id')
      if (info.fontSize < 15) issues.push(`正文字号 ${info.fontSize}px 太小`)
      if (info.lineHeight / info.fontSize < 1.6) issues.push(`行高 ${info.lineHeight}/${info.fontSize} 太挤`)
      if (info.width > 780) issues.push(`正文行宽 ${Math.round(info.width)}px 太宽`)
      // 大纲：没选过时只有版心右边留白放得下卡片才默认展开（1920 宽放得下，1440 宽放不下）
      if (size.width >= 1920 && !info.toc) issues.push('1920 宽、右边留白足够时应默认展开大纲')
      if (size.width === 1440 && info.toc) issues.push('1440 宽留白放不下大纲卡片，默认应收起（不压正文）')
      if (size.width < 820 && !info.tocBtn) issues.push('窄屏应显示「大纲」按钮')
      if (size.width < 820 && info.toc) issues.push('窄屏不该常驻大纲')
      return issues
    },
  },
  'read-light': {
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2',
    sizes: ['390x844', '1440x900'],
    prepare: async (tab) => {
      await tab.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light')
        document.documentElement.setAttribute('data-tone', 'light')
      })
    },
    settle: 400,
    assert: async (tab) => {
      // 正文文字与背景的对比度 ≥ 7(WCAG AAA 正文)
      const ratio = await tab.evaluate(() => {
        const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
        const p = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')
        let node = p
        let bg = 'rgba(0, 0, 0, 0)'
        while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(node).backgroundColor; node = node.parentElement }
        const a = lum(parse(getComputedStyle(p).color)), b = lum(parse(bg))
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
      return ratio >= 7 ? [] : [`浅色主题正文对比度 ${ratio.toFixed(2)} < 7`]
    },
  },
  'read-backlinks': {
    // 文末「引用了这篇文档」+ 右侧栏「关系」页签:数据都来自 doc_links,不再只读正文里的 [[双链]]。
    // 入链按来源文档归并(同一篇引用两次只占一行,处数记在「等 N 处」),点一行就打开来源。
    fixture: {
      doc_links: (args) => {
        // 服务端按「一处链接一行」返回;同一篇 ins_8c55 引了两次,页面应归并成一行
        const noteIn = (id, title, line) => ({ source_kind: 'note', source_collection: 'knowledgeBase/insights', source_id: id, source_title: title, href: `kb://note/${id}`, line })
        // 文件的 source_title 在真实索引里是文件名(见 index 的 refresh_doc_links),source_id 才是路径
        const fileIn = (path, line) => ({ source_kind: 'file', source_collection: 'knowledgeBase', source_id: path, source_title: path.split('/').pop(), href: path, line })
        const noteOut = (id, line) => ({ target_kind: 'note', target_collection: 'knowledgeBase/insights', target_id: id, label: '', line })
        const fileOut = (path, line) => ({ target_kind: 'file', target_collection: 'knowledgeBase', target_id: path, label: path, line })
        const byNote = {
          ins_8f21: {
            inbound: [
              noteIn('ins_8c55', 'clap 子命令别名与 MCP 工具名需一一对应', 4),
              noteIn('ins_8c55', 'clap 子命令别名与 MCP 工具名需一一对应', 19),
              fileIn('docs/规范.md', 7),
            ],
            outbound: [noteOut('ins_8e07', 8), fileOut('src/kb-cli/src/client.rs', 12)],
          },
          ins_8c55: {
            inbound: [noteIn('ins_8e07', 'kb search 输出 --json 时 stderr 不能混入进度条', 3)],
            outbound: [noteOut('ins_8f21', 8), noteOut('ins_8e07', 12)],
          },
        }
        const rows = byNote[args?.note_id] ?? { inbound: [], outbound: [] }
        // 阅读页只要入链(direction: to);右侧栏要两边
        return args?.direction === 'to' ? { inbound: rows.inbound } : rows
      },
    },
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '[data-testid="doc-backlinks"]',
    sizes: ['390x844', '1440x900'],
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const readBacklinks = () =>
        tab.evaluate(() => ({
          heading: document.querySelector('[data-testid="doc-backlinks"] h2')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          rows: [...document.querySelectorAll('[data-testid="doc-backlinks"] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
          button: document.querySelector('[data-testid="doc-links-button"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          // 文末块要接在正文下面、和正文左对齐,标题字号不能大过正文(否则会被当成文章的一节)
          box: (() => {
            const section = document.querySelector('[data-testid="doc-backlinks"]')
            const body = document.querySelector('.kb-md-read-body')
            if (!section || !body) return null
            const a = section.getBoundingClientRect()
            const b = body.getBoundingClientRect()
            return { left: Math.round(a.left - b.left), below: a.top >= b.bottom - 2, titleSize: parseFloat(getComputedStyle(section.querySelector('h2')).fontSize) }
          })(),
        }))
      const first = await readBacklinks()
      if (first.heading !== '引用了这篇文档 2') issues.push(`文末标题「${first.heading}」`)
      if (first.rows.length !== 2) issues.push(`文末入链 ${first.rows.length} 行(应为 2:笔记归并 1 + 文件 1)`)
      if (!first.rows[0]?.includes('clap 子命令别名')) issues.push(`第一条应是来源笔记:${first.rows[0]}`)
      if (!first.rows[0]?.includes('笔记 · 第 4 行 · 等 2 处')) issues.push(`来源笔记的说明「${first.rows[0]}」`)
      if (!first.rows[1]?.includes('规范.md')) issues.push(`文件来源应只显示文件名:${first.rows[1]}`)
      if (first.rows[1]?.includes('docs/规范.md')) issues.push('文件来源不该显示整条路径')
      if (first.button !== '引用 2') issues.push(`元信息行按钮「${first.button}」`)
      if (first.overflowX > 1) issues.push(`页面横向溢出 ${first.overflowX}px`)
      if (!first.box) issues.push('文末入链块没接在正文后面')
      else {
        if (Math.abs(first.box.left) > 1) issues.push(`文末入链块和正文没对齐(差 ${first.box.left}px)`)
        if (!first.box.below) issues.push('文末入链块跑到正文上面了')
        if (first.box.titleSize > 14) issues.push(`文末小标题字号 ${first.box.titleSize}px 太大`)
      }
      // 点文末的来源笔记:应打开那一篇,并刷新成它的入链(不是留在上一页)
      await tab.click('[data-testid="doc-backlinks"] li button')
      await tab
        .waitForFunction(() => new URLSearchParams(location.search).get('item') === 'ins_8c55', null, { timeout: 5000 })
        .catch(() => {})
      if (!tab.url().includes('item=ins_8c55')) issues.push('点文末入链没有打开来源笔记')
      await tab.waitForSelector('[data-testid="doc-backlinks"] li', { timeout: 5000 }).catch(() => {})
      const second = await readBacklinks()
      if (second.rows.length !== 1 || !second.rows[0]?.includes('stderr')) issues.push(`换笔记后入链没换:${second.rows.join(' / ')}`)
      if (second.button !== '引用 1') issues.push(`换笔记后按钮「${second.button}」`)
      // 宽屏右侧栏的「关系」页签:出链 / 入链分组,点出链回到目标笔记(窄屏是浮层,不在这里测)
      if (size.width >= 1024) {
        if (!(await tab.locator('.kb-inspector-panel').count())) {
          await tab.click('button[aria-label="属性"]')
          await tab.waitForSelector('.kb-inspector-panel', { timeout: 3000 }).catch(() => {})
        }
        await tab.getByRole('tab', { name: /关系/ }).first().click()
        await tab.waitForSelector('[data-testid="doc-relations"] .kb-rel-row', { timeout: 5000 }).catch(() => {})
        const rail = await tab.evaluate(() => ({
          groups: [...document.querySelectorAll('[data-testid="doc-relations"] .kb-rel-title')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
          rows: [...document.querySelectorAll('[data-testid="doc-relations"] .kb-rel-row')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
        }))
        if (rail.groups[0] !== '这篇引用了 2' || rail.groups[1] !== '引用了这篇 1') issues.push(`关系分组「${rail.groups.join(' / ')}」`)
        if (rail.rows.length !== 3) issues.push(`关系行 ${rail.rows.length}(应为 3)`)
        if (!rail.rows[0]?.includes('第 8 行')) issues.push(`出链第一行应带行号:${rail.rows[0]}`)
        await tab.locator('[data-testid="doc-relations"] .kb-rel-row').first().click()
        await tab
          .waitForFunction(() => new URLSearchParams(location.search).get('item') === 'ins_8f21', null, { timeout: 5000 })
          .catch(() => {})
        if (!tab.url().includes('item=ins_8f21')) issues.push('点关系页签的出链没有打开目标笔记')
      }
      return issues
    },
  },
  'toc-mobile': {
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-dp-toc-btn',
    sizes: ['390x844', '820x1180'],
    prepare: async (tab) => {
      await tab.click('.kb-dp-toc-btn')
      await tab.waitForSelector('.kb-dp-sheet', { timeout: 3000 })
    },
    settle: 300,
    assert: async (tab) => {
      const items = await tab.evaluate(() => [...document.querySelectorAll('.kb-dp-sheet .kb-dp-toc-item')].map((item) => item.textContent?.trim()))
      const issues = []
      if (items.join() !== '现象,做法,关联') issues.push(`大纲项 ${items}`)
      await tab.click('.kb-dp-sheet .kb-dp-toc-item:nth-child(3)')
      await tab.waitForTimeout(600)
      const closed = await tab.evaluate(() => !document.querySelector('.kb-dp-sheet'))
      if (!closed) issues.push('点大纲项后抽屉没关')
      return issues
    },
  },
  'edit-md': {
    // 点「编辑」原地进入所见即所得(统一外壳的新文本面);工具栏、加粗、斜杠菜单、表格、Ctrl+S 保存且不退出编辑。
    fixture: SOLO_EDIT_FIXTURE,
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-workspace-bar-right',
    prepare: async (tab) => {
      await tab.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('kb.draft.')).forEach((key) => localStorage.removeItem(key)))
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(`${NATIVE_HOST} [data-testid="editor-chrome"]`, { timeout: 15_000 })
      await tab.waitForSelector(`${NATIVE_HOST} .kb-text-prose[contenteditable="true"]`, { timeout: 15_000 })
    },
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const body = `${NATIVE_HOST} .kb-text-prose`
      // 旧工具栏的每个入口在新外壳里都要有:上传图片 = 「图片」(开文件选择),上传附件 = 「插入」下拉里的「附件」,插入表格 = 「表格」
      // 工具栏放不下的按钮会收进「更多」,布局还在重排时可能一时读不全:缺项时多读几轮,仍缺才算缺
      const wanted = { bold: '加粗', italic: '斜体', color: '文字颜色', link: '链接', quote: '引用', bullet: '无序列表', task: '任务列表', image: '上传图片', attachment: '上传附件', table: '插入表格', find: '查找替换' }
      const missing = (ids) => [...Object.keys(wanted).filter((id) => !ids.has(id)), ...(ids.has('insertMore') || ids.has('codeblock') ? [] : ['insertMore'])]
      let ids = await nativeToolIds(tab)
      for (let round = 0; round < 8 && missing(ids).length; round++) {
        await tab.waitForTimeout(250)
        ids = await nativeToolIds(tab)
      }
      for (const [id, label] of Object.entries(wanted)) if (!ids.has(id)) issues.push(`工具栏缺「${label}」(${id})`)
      // 窄屏「插入」下拉会被平铺进「更多」菜单,这时由它的子项(代码块、附件)证明「插入」入口在
      if (!ids.has('insertMore') && !ids.has('codeblock')) issues.push('工具栏缺「插入」')
      if (!(await tab.locator(`${NATIVE_HOST} [data-testid="editor-undo"]`).count())) issues.push('工具栏缺「撤销」')
      // 页面不画可编辑的大标题,名字跟着正文开头的一级标题;这篇正文从「## 现象」开始、没有一级标题,
      // 编辑时和阅读时一样把名字画成只读大标题(不是输入框),进出编辑版面不跳
      const title = await tab.evaluate(() => {
        const el = document.querySelector('.kb-dp-title')
        return { tag: el?.tagName, text: el?.textContent?.trim() ?? '' }
      })
      if (title.tag !== 'H1' || !title.text.includes('UDS')) issues.push(`正文开头没有一级标题时,编辑态应显示只读的名字:${title.tag} ${title.text}`)
      // 在最后一段末尾输入文字
      await tab.click(`${body} > p:last-of-type`)
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 追加一句')
      // 加粗:选中刚输入的「一句」并点 B
      for (let i = 0; i < 2; i++) await tab.keyboard.press('Shift+ArrowLeft')
      await clickNativeTool(tab, 'bold')
      const bold = await tab.evaluate((sel) => [...document.querySelectorAll(`${sel} strong`)].some((n) => n.textContent === '一句'), body)
      if (!bold) issues.push('加粗按钮没生效')
      // 斜杠菜单:先收起选区(否则回车会替换掉选中的字),再在文末新起一段输入 /
      await tab.keyboard.press('ArrowRight')
      await tab.keyboard.press('Control+End')
      // 浏览器移动光标后,ProseMirror 要等 selectionchange 才同步选区(editor-text-scenarios 的 caretToEnd 同理):
      // 紧接着按回车会作用在旧选区上,把刚加粗的「一句」替换成换行。真人按键不会这么快,这里模拟真人节奏
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('/')
      const slash = await tab.waitForSelector('.kb-slash-menu', { timeout: 3000 }).then(() => true).catch(() => false)
      if (!slash) issues.push('输入 / 没有弹出插入菜单')
      else {
        const labels = await tab.evaluate(() => document.querySelector('.kb-slash-menu')?.textContent ?? '')
        // 新文本面的标题项叫「一级标题」(旧编辑器叫「标题 1」),其余同名
        for (const label of ['一级标题', '无序列表', '表格', '代码块']) if (!labels.includes(label)) issues.push(`斜杠菜单缺「${label}」`)
        await tab.keyboard.press('Escape')
        await tab.keyboard.press('Backspace')
      }
      // 插入表格:「表格」按钮弹出 Word 式的大小网格,点第 3 行第 3 列插入 3 × 3
      await clickNativeTool(tab, 'table')
      await tab.locator('[data-testid="table-cell-3-3"]').first().click({ timeout: 3000 }).catch(() => issues.push('「表格」没有弹出大小网格'))
      await tab.waitForTimeout(300)
      const tables = await tab.evaluate((sel) => document.querySelectorAll(`${sel} table`).length, body)
      if (tables < 1) issues.push('插入表格失败')
      const state = await tab.evaluate(() => document.querySelector('.kb-save-state')?.textContent)
      // 改动还没保存到库里:页头写「未保存」;本机草稿自动存好后(去抖几百毫秒,时机不固定)改写成「草稿已自动保存」(Browser.vue saveStateText),
      // 两种都表示「改动没落库」。不能是「已保存」或空
      if (state !== '未保存' && state !== '草稿已自动保存') issues.push(`保存状态应为「未保存」或「草稿已自动保存」,实际 ${state}`)
      // Ctrl+S:发出 edit_item,内容是 Markdown(加粗写成 **一句**,表格写成 |---|),保存后仍在编辑
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/edit_item'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('Ctrl+S 没有保存')
      else {
        const body = String(JSON.parse(sent.postData() ?? '{}').body ?? '')
        if (!body.includes('**一句**')) issues.push(`保存的 Markdown 里没有 **一句**:${JSON.stringify(body.split('\n').filter((l) => l.includes('追加') || l.includes('一句')))}`)
        if (!/\|:?-{3,}:?\|/.test(body.replace(/ /g, ''))) issues.push('保存的 Markdown 里没有表格分隔行')
        if (body.includes('\\[\\[')) issues.push('双链被转义了')
      }
      await tab.waitForTimeout(800)
      const still = await tab.evaluate(() => !!document.querySelector('[data-testid="editor-host"] [data-testid="editor-chrome"]') && document.querySelector('[data-testid="editor-host"] .kb-text-prose')?.getAttribute('contenteditable') === 'true')
      if (!still) issues.push('保存后不该退出编辑')
      return issues
    },
  },
  'new-doc': {
    route: `/kb?collection=${COLLECTION}`,
    ready: '.kb-workspace-main, .kb-sidebar',
    prepare: async (tab) => {
      await tab.getByRole('button', { name: /新建/ }).first().click()
      await tab.waitForSelector('.kb-dp textarea.kb-dp-title', { timeout: 15_000 })
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.fill('.kb-dp textarea.kb-dp-title', '新的一篇笔记')
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('## 第一节')
      await tab.keyboard.press('Enter')
      // 先等「- 」变成列表再继续输入,和真人一样:WebKit 上转换后 30 ms 内的第一个字符会让光标回到行首(abc → bca)
      await tab.keyboard.type('- ')
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) li', { timeout: 3000 })
      await tab.waitForTimeout(100)
      await tab.keyboard.type('要点一')
      const html = await tab.evaluate(() => ({ h2: document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h2')?.textContent, li: document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) li').length }))
      if (html.h2 !== '第一节') issues.push(`Markdown 快捷输入 ## 没变成标题:${html.h2}`)
      if (html.li < 1) issues.push('Markdown 快捷输入 - 没变成列表')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/create_item'), { timeout: 5000 }).catch(() => null)
      await tab.getByRole('button', { name: '保存' }).click()
      const sent = await request
      if (!sent) issues.push('新建笔记点「保存」没有创建')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        if (body.title !== '新的一篇笔记') issues.push(`标题 ${body.title}`)
        if (!String(body.body).includes('## 第一节') || !String(body.body).includes('- 要点一')) issues.push(`正文 ${JSON.stringify(body.body)}`)
      }
      return issues
    },
  },
  'md-file': {
    // 笔记 / Markdown 的编辑默认走统一外壳的新文本面,协同开着时要等房间第一次同步才可写;
    // 夹具没有 ws,所以用单人编辑夹具把协同功能点关掉,否则编辑器永远只读(旧编辑器同样,见 0760879e)
    fixture: SOLO_EDIT_FIXTURE,
    route: route('file_md'),
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h2',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const title = await tab.evaluate(() => document.querySelector('.kb-dp-title')?.textContent)
      if (title !== 'README.md') issues.push(`标题 ${title}`)
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 10_000 })
      await tab.click(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) > p:last-of-type')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 新内容')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/save_file'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('Markdown 文件 Ctrl+S 没保存')
      else if (!String(JSON.parse(sent.postData() ?? '{}').content).includes('新内容')) issues.push('保存内容不对')
      return issues
    },
  },

  'legacy-doc': {
    route: route('file_doc'),
    ready: '.kb-rd-article p',
    settle: 400,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({
        text: document.querySelector('.kb-rd-article')?.textContent ?? '',
        table: document.querySelectorAll('.kb-rd-article table tr').length,
        banner: document.querySelector('.kb-rd-banner')?.textContent ?? '',
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }))
      const issues = []
      if (!info.text.includes('倒数排名融合')) issues.push('正文没显示')
      if (info.table < 2) issues.push(`表格行 ${info.table} < 2`)
      if (!info.banner.includes('旧版')) issues.push('缺少旧版格式提示')
      return issues
    },
  },
  'legacy-ppt': {
    route: route('file_ppt'),
    ready: '.kb-rd-article h2',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({ title: document.querySelector('.kb-rd-article h2')?.textContent, quote: !!document.querySelector('.kb-rd-article blockquote'), no: document.querySelector('.kb-rd-no')?.textContent }))
      if (!info.title?.includes('产品路线图')) issues.push(`第一张标题 ${info.title}`)
      if (!info.quote) issues.push('备注没显示')
      if (!info.no?.includes('1 / 3')) issues.push(`节数 ${info.no}`)
      await tab.click('button[aria-label="下一节"]')
      await tab.waitForTimeout(300)
      const second = await tab.evaluate(() => document.querySelector('.kb-rd-article h2')?.textContent)
      if (!second?.includes('检索质量')) issues.push(`翻页后标题 ${second}`)
      return issues
    },
  },
  xls: {
    route: route('file_xls'),
    ready: '.kb-sg .kb-sg-row',
    settle: 500,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ rows: document.querySelectorAll('.kb-sg-row').length, tabs: [...document.querySelectorAll('.kb-sg-tab')].map((t) => t.textContent?.trim()), label: document.querySelector('.kb-sg-label')?.textContent }))
      const issues = []
      if (info.rows < 5) issues.push(`可见行 ${info.rows}`)
      if (info.tabs.join() !== '评测汇总,指标') issues.push(`工作表 ${info.tabs}`)
      if (info.label !== '编号') issues.push(`表头 ${info.label}`)
      return issues
    },
  },
  ods: {
    route: route('file_ods'),
    ready: '.kb-sg .kb-sg-row',
    settle: 500,
    assert: async (tab) => {
      const tabs = await tab.evaluate(() => [...document.querySelectorAll('.kb-sg-tab')].map((t) => t.textContent?.trim()))
      return tabs.join() === '评测汇总,指标' ? [] : [`工作表 ${tabs}`]
    },
  },
  odt: {
    route: route('file_odt'),
    ready: '.kb-rd-article h1',
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ bold: !!document.querySelector('.kb-rd-article b'), li: document.querySelectorAll('.kb-rd-article li').length, tr: document.querySelectorAll('.kb-rd-article tr').length }))
      const issues = []
      if (!info.bold) issues.push('粗体没转出来')
      if (info.li !== 2) issues.push(`列表项 ${info.li}`)
      if (info.tr !== 3) issues.push(`表格行 ${info.tr}`)
      return issues
    },
  },
  odp: {
    route: route('file_odp'),
    ready: '.kb-rd-article h2',
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ no: document.querySelector('.kb-rd-no')?.textContent, quote: !!document.querySelector('.kb-rd-article blockquote') }))
      return [...(info.no?.includes('1 / 3') ? [] : [`节数 ${info.no}`]), ...(info.quote ? [] : ['备注没显示'])]
    },
  },
  rtf: {
    route: route('file_rtf'),
    ready: '.kb-rd-article p',
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ text: document.querySelector('.kb-rd-article')?.textContent ?? '', tr: document.querySelectorAll('.kb-rd-article tr').length, i: !!document.querySelector('.kb-rd-article i') }))
      const issues = []
      if (!info.text.includes('倒数排名融合（RRF）')) issues.push(`中文/Unicode 转义不对:${info.text.slice(0, 40)}`)
      if (info.tr !== 2) issues.push(`表格行 ${info.tr}`)
      if (!info.i) issues.push('斜体丢了')
      return issues
    },
  },
  epub: {
    route: route('file_epub'),
    ready: '.kb-rd-article h1',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const items = await tab.evaluate(() => [...document.querySelectorAll('.kb-rd-item-title')].map((n) => n.textContent?.trim()))
      if (items.join() !== '第 1 章,第 2 章,第 3 章') issues.push(`目录 ${items}`)
      await tab.click('button[aria-label="下一节"]')
      await tab.waitForFunction(() => document.querySelector('.kb-rd-article h1')?.textContent?.includes('第 2 章'), null, { timeout: 5000 }).catch(() => issues.push('翻章失败'))
      return issues
    },
  },
  eml: {
    route: route('file_eml'),
    ready: '.kb-rd-article h2',
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ h: document.querySelector('.kb-rd-article h2')?.textContent, text: document.querySelector('.kb-rd-article')?.textContent ?? '', img: document.querySelector('.kb-rd-article img')?.getAttribute('src')?.slice(0, 22), att: document.querySelectorAll('.kb-rd-article li').length }))
      const issues = []
      if (!info.h?.includes('周会纪要')) issues.push(`主题 ${info.h}`)
      if (!info.text.includes('张三')) issues.push('发件人没解码')
      if (info.img !== 'data:image/png;base64,') issues.push(`cid 图片 ${info.img}`)
      if (info.att !== 1) issues.push(`附件 ${info.att}`)
      return issues
    },
  },
  mbox: {
    route: route('file_mbox'),
    ready: '.kb-rd-article h2',
    settle: 300,
    assert: async (tab) => {
      const items = await tab.evaluate(() => [...document.querySelectorAll('.kb-rd-item-title')].map((n) => n.textContent?.trim()))
      return items.join() === 'first,second' ? [] : [`邮件列表 ${items}`]
    },
  },
  ipynb: {
    route: route('file_ipynb'),
    ready: '.kb-nb-cell',
    settle: 500,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ cells: document.querySelectorAll('.kb-nb-cell').length, h1: !!document.querySelector('.kb-nb-md h1'), tok: document.querySelectorAll('.kb-nb-code [class^="tok-"]').length, img: !!document.querySelector('.kb-nb-img'), err: document.querySelector('.kb-nb-text.is-error')?.textContent ?? '' }))
      const issues = []
      if (info.cells !== 5) issues.push(`单元格 ${info.cells}`)
      if (!info.h1) issues.push('Markdown 没渲染')
      if (info.tok < 3) issues.push('代码没高亮')
      if (!info.img) issues.push('图片输出没显示')
      if (!info.err.includes('ZeroDivisionError') || info.err.includes('[0;31m')) issues.push(`报错输出不对:${JSON.stringify(info.err)}`)
      return issues
    },
  },
  zip: {
    route: route('file_zip'),
    ready: '.kb-av-row',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const rows = await tab.evaluate(() => [...document.querySelectorAll('.kb-av-name')].map((n) => n.textContent?.trim()))
      if (!rows.includes('main.rs') || !rows.includes('src')) issues.push(`目录树 ${rows}`)
      await tab.click('.kb-av-row:has-text("main.rs")')
      await tab.waitForSelector('.kb-av-text', { timeout: 5000 })
      const tok = await tab.evaluate(() => document.querySelectorAll('.kb-av-text [class^="tok-"]').length)
      if (tok < 2) issues.push('条目预览没有语法高亮')
      if (size.width < 760) {
        await tab.click('.kb-av-phead button')
        await tab.waitForSelector('.kb-av-row', { timeout: 3000 }).catch(() => issues.push('窄屏返回列表失败'))
      }
      return issues
    },
  },
  tgz: {
    route: route('file_tgz'),
    ready: '.kb-av-row',
    settle: 300,
    assert: async (tab) => {
      const rows = await tab.evaluate(() => [...document.querySelectorAll('.kb-av-name')].map((n) => n.textContent?.trim()))
      return rows.includes('notes.txt') && rows.includes('app.toml') ? [] : [`tar.gz 条目 ${rows}`]
    },
  },
  html: {
    route: route('file_html'),
    ready: '.kb-rd-article h1',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({ text: document.querySelector('.kb-rd-article')?.textContent ?? '', js: document.querySelector('.kb-rd-article a[href^="javascript"]'), nav: (document.querySelector('.kb-rd-article')?.textContent ?? '').includes('导航不该出现'), alert: !!window.__pwned }))
      if (info.js) issues.push('javascript: 链接没被清掉')
      if (info.nav) issues.push('阅读视图里还有导航')
      await tab.getByRole('tab', { name: '网页' }).click()
      await tab.waitForSelector('iframe.kb-hv-frame', { timeout: 3000 })
      const frame = await tab.evaluate(() => ({ sandbox: document.querySelector('iframe.kb-hv-frame')?.getAttribute('sandbox'), hasScript: (document.querySelector('iframe.kb-hv-frame')?.getAttribute('srcdoc') ?? '').includes('<script') }))
      if (frame.sandbox !== '') issues.push(`iframe sandbox 属性 ${JSON.stringify(frame.sandbox)}`)
      if (frame.hasScript) issues.push('iframe srcdoc 里还有 script')
      await tab.getByRole('tab', { name: '源码' }).click()
      await tab.waitForSelector('.kb-hv .cm-content', { timeout: 5000 })
      return issues
    },
  },
  svg: {
    route: route('file_svg'),
    ready: '.kb-iv img',
    settle: 400,
    assert: async (tab) => {
      const w = await tab.evaluate(() => document.querySelector('.kb-iv img')?.naturalWidth ?? 0)
      return w > 0 ? [] : ['SVG 没加载出来']
    },
  },
  binary: {
    route: route('file_dat'),
    ready: '.kb-bv-dump',
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ dump: document.querySelector('.kb-bv-dump')?.textContent ?? '', tag: document.querySelector('.kb-bv-head .tag')?.textContent }))
      const issues = []
      if (!info.dump.startsWith('00000000')) issues.push('十六进制视图格式不对')
      if (info.tag !== '二进制') issues.push(`标签 ${info.tag}`)
      return issues
    },
  },
  unknown: {
    route: route('file_weird'),
    ready: '.kb-ce .cm-line',
    settle: 500,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({ text: document.querySelector('.kb-ce .cm-content')?.textContent ?? '', ro: !!document.querySelector('.kb-ce.is-readonly') }))
      const issues = []
      if (!info.text.includes('扩展名没人认识')) issues.push('未知扩展名的文本没读出来')
      if (!info.ro) issues.push('应为只读')
      return issues
    },
  },
  'edit-any': {
    // 测的是单人编辑 + Ctrl+S 保存;默认夹具带协作功能点,纯文本文件也会去连假后端没有的协作房间,永远只读
    fixture: SOLO_EDIT_FIXTURE,
    route: route('file_cs'),
    ready: '.kb-workspace-bar-right',
    prepare: async (tab) => {
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector('.kb-ce:not(.is-readonly) .cm-content', { timeout: 15_000 })
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.click('.kb-ce .cm-content')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('// edited')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/save_file'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('.cs 文件 Ctrl+S 没触发保存')
      else if (!String(JSON.parse(sent.postData() ?? '{}').content ?? '').includes('// edited')) issues.push('保存内容里没有新输入')
      return issues
    },
  },
  attach: {
    // 编辑态上传附件和图片(按钮 + 拖入),卡片 / 图片出现,保存的 Markdown 写自包含的 kb:// 原件地址(bb3912b2 统一文档引用语法后,
    // 笔记里不再写显示用的 /api/v1/raw 地址:换域名、导出离线就失效),显示时再解析成本站原件地址
    // 夹具里这篇笔记的集合名 knowledgeBase/insights 不符合真实的命名规则(_global / proj_* / ext_*,后端 ids.rs 与 utils/links.ts 同规则):
    // 上传后写进正文的 kb://集合/路径 解析不了,卡片出不来、图片被 CSP 拦成破图(新旧两条路径一样,camera-scenarios 同理)。给它一个合法的集合名
    fixture: {
      ...SOLO_EDIT_FIXTURE,
      get_item: (args) => {
        const reply = dynamicResponses.get_item(args)
        return { ...reply, item: { ...reply.item, collection: 'proj_knowledgebase' } }
      },
    },
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-workspace-bar-right',
    sizes: ['390x844', '1440x900'],
    prepare: enterNativeEdit,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.click(`${NPM} > p:last-of-type`)
      await tab.keyboard.press('Control+End')
      // 附件按钮在新外壳里是个隐藏的文件框(工具栏「插入」→「附件」会点它),直接给它文件
      await tab.locator('[data-testid="pick-attach"]').setInputFiles(join(ROOT, 'e2e/fixtures/sample.pdf'))
      const card = await tab.waitForSelector('.kb-dp .kb-attach', { timeout: 8000 }).then(() => true).catch(() => false)
      if (!card) issues.push('附件卡片没出现')
      // 拖一张图片进正文
      await tab.evaluate(async (sel) => {
        const target = document.querySelector(sel)
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
        const file = new File([bytes], '架构图.png', { type: 'image/png' })
        const data = new DataTransfer()
        data.items.add(file)
        const rect = target.getBoundingClientRect()
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: rect.left + 20, clientY: rect.bottom - 10, bubbles: true, cancelable: true }))
      }, NPM)
      // 正文里的 <img> 要显示出来:kb:// 地址必须被解析成本站原件地址,否则会被 CSP 拦成破图
      const image = await tab.waitForFunction((sel) => [...document.querySelectorAll(`${sel} img`)].some((img) => img.getAttribute('src')?.startsWith('/api/v1/raw?')), NPM, { timeout: 8000 }).then(() => true).catch(() => false)
      if (!image) issues.push('拖入的图片没插进正文')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/edit_item'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('没有保存')
      else {
        const body = String(JSON.parse(sent.postData() ?? '{}').body ?? '')
        if (!/\[📎 sample\.pdf\]\(kb:\/\/proj_knowledgebase\/_attachments\/\d{4}-\d{2}\/[a-z0-9]{8}-sample\.pdf "[\d.]+ KB"\)/.test(body)) issues.push(`附件 Markdown 不对:${body.split('\n').filter((l) => l.includes('📎'))}`)
        if (!/!\[架构图\]\(kb:\/\/proj_knowledgebase\/_attachments\/\d{4}-\d{2}\/[a-z0-9]{8}-%E6%9E%B6%E6%9E%84%E5%9B%BE\.png\)/.test(body)) issues.push(`图片 Markdown 不对:${body.split('\n').filter((l) => l.includes('!['))}`)
        if (body.includes('/api/v1/raw')) issues.push('显示用的原件地址不该被写进正文')
      }
      return issues
    },
  },
  'rich-format': {
    // 文字颜色、提示块、流程图(真实 CSP 下渲染)、查找替换。旧编辑器(?editor=legacy)的同款流程见 rich-format-legacy
    fixture: SOLO_EDIT_FIXTURE,
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-workspace-bar-right',
    sizes: ['390x844', '1440x900'],
    prepare: enterNativeEdit,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      // 选中「守护进程」四个字,上红色(用键盘选,和用户一样)
      await tab.click(`${NPM} h2`)
      await tab.keyboard.press('End')
      await tab.keyboard.press('ArrowRight')
      for (let i = 0; i < 4; i++) await tab.keyboard.press('Shift+ArrowRight')
      await tab.waitForTimeout(150)
      await clickNativeTool(tab, 'color')
      await tab.click('[data-testid="editor-color-fg-red"]')
      const red = await tab.evaluate((sel) => document.querySelector(`${sel} .kb-color.is-fg-red`)?.textContent, NPM)
      if (red !== '守护进程') issues.push(`字色没生效:${red}`)
      // 文末插入提示块与流程图(光标移动后等 150ms 让 ProseMirror 同步选区,再回车)
      await tab.click(`${NPM} > p:last-of-type`)
      await tab.keyboard.press('Control+End')
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Enter')
      await clickNativeTool(tab, 'callout.warning')
      const callout = await tab.waitForSelector('.kb-dp blockquote.kb-callout.is-warning', { timeout: 3000 }).then(() => true).catch(() => false)
      if (!callout) issues.push('提示块没有渲染')
      await tab.keyboard.press('Control+End')
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Enter')
      await tab.keyboard.press('Enter')
      await clickNativeTool(tab, 'diagram')
      const svg = await tab.waitForSelector('.kb-dp .kb-mermaid svg', { timeout: 15000 }).then(() => true).catch(() => false)
      if (!svg) issues.push(`流程图没渲染出来:${await tab.evaluate(() => document.querySelector('.kb-mermaid')?.textContent ?? '无预览')}`)
      // 查找替换:把「双写」全部换成「重复写入」
      await tab.click(`${NPM} h2`)
      await tab.keyboard.press('Control+f')
      await tab.waitForSelector('[data-testid="editor-find-bar"]', { timeout: 3000 })
      await tab.fill('[data-testid="editor-find-input"]', '双写')
      await tab.waitForTimeout(150)
      const count = (await tab.textContent('[data-testid="editor-find-count"]'))?.trim()
      if (count !== '1/1') issues.push(`查找计数 ${count}`)
      await tab.click('[data-testid="editor-find-toggle-replace"]')
      await tab.fill('[data-testid="editor-find-replace-input"]', '重复写入')
      await tab.click('[data-testid="editor-find-replace-all"]')
      const replaced = await tab.evaluate((sel) => document.querySelector(sel)?.textContent?.includes('避免重复写入'), NPM)
      if (!replaced) issues.push('全部替换没生效')
      await tab.keyboard.press('Escape')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/edit_item'), { timeout: 5000 }).catch(() => null)
      await tab.click(`${NPM} h2`)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) issues.push('没有保存')
      else {
        const body = String(JSON.parse(sent.postData() ?? '{}').body ?? '')
        if (!body.includes('<span style="color: #e5484d">守护进程</span>')) issues.push('颜色没写成 span')
        if (!/^> \[!WARNING\]$/m.test(body)) issues.push(`提示块 Markdown 不对:${JSON.stringify(body.split('\n').filter((l) => l.startsWith('>')))}`)
        if (!body.includes('```mermaid')) issues.push('流程图代码块没保存')
        if (!body.includes('避免重复写入')) issues.push('替换结果没保存')
      }
      return issues
    },
  },
  'wikilink-picker': {
    // 输入 [[ 弹出笔记选择器,回车插入双链;保存退出编辑后,阅读态的双链不露出 [[ 。旧编辑器的同款流程见 wikilink-picker-legacy
    fixture: SOLO_EDIT_FIXTURE,
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-workspace-bar-right',
    sizes: ['390x844', '1440x900'],
    prepare: enterNativeEdit,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.click(`${NPM} > p:last-of-type`)
      await tab.keyboard.press('Control+End')
      // 浏览器移动光标后 ProseMirror 要等 selectionchange 才同步选区,立刻回车会落在旧位置
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('参见 [[')
      const open = await tab.waitForSelector('.kb-text-picker', { timeout: 3000 }).then(() => true).catch(() => false)
      if (!open) return ['输入 [[ 没有弹出笔记选择器']
      await tab.waitForSelector('.kb-text-picker-item', { timeout: 4000 }).catch(() => issues.push('选择器没有结果'))
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(200)
      const text = await tab.evaluate((sel) => document.querySelector(`${sel} > p:last-of-type`)?.textContent ?? '', NPM)
      if (!/参见 \[\[[^|\]]+\|[^\]]+\]\]/.test(text)) issues.push(`插入的双链不对:${text}`)
      // 保存并退出编辑后,阅读态显示成标题
      const save = tab.waitForRequest((req) => req.url().includes('/capabilities/edit_item'), { timeout: 5000 }).catch(() => null)
      await tab.getByRole('button', { name: '保存' }).click()
      const sent = await save
      if (!sent) issues.push('点保存没有发出请求')
      else if (!/参见 \[\[[^|\]]+\|[^\]]+\]\]/.test(String(JSON.parse(sent.postData() ?? '{}').body ?? ''))) issues.push('保存的 Markdown 里没有 [[id|标题]] 双链')
      // 保存后回到阅读态(轻量阅读:正文不再是可编辑的编辑器)
      await tab.waitForSelector(`${NATIVE_HOST} [data-testid="editor-chrome"]`, { state: 'detached', timeout: 5000 }).catch(() => issues.push('保存后没有退出编辑'))
      await tab.waitForTimeout(500)
      // 夹具的 get_item 返回固定正文(不保存),这里检查原有的 [[ins_8b10]] 在阅读态显示成标题而不是 [[id]]
      const chips = await tab.evaluate(() => [...document.querySelectorAll('.kb-dp .kb-wikilink')].map((n) => n.textContent ?? ''))
      if (!chips.length || chips.some((chip) => chip.includes('[['))) issues.push(`阅读态双链没显示成标题:${chips}`)
      return issues
    },
  },
  'doc-layout': {
    // 语雀式三段:图标导航 + 目录栏 + 文档;没有页脚;更多菜单里能导出 Markdown。
    // 顶栏:桌面与平板保留全站统一顶栏(面包屑、搜索、AI 助手、通知、头像),文档自己的顶栏另算一条,共 2 条(7fd46935,
    // 同一提交已把 shell-workbench-chrome 改成「应保留顶栏」);手机(≤599px)进文档后全站顶栏让位,只剩文档顶栏 1 条
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h2',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const info = await tab.evaluate(() => {
        const visible = (selector) => { const el = document.querySelector(selector); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0 }
        return {
          top: visible('.kb-topbar'),
          foot: visible('.foot'),
          side: document.querySelector('.kb-nav-slot')?.getBoundingClientRect().width ?? 0,
          sidebar: visible('.kb-sidebar'),
          items: document.querySelectorAll('.kb-sidebar-item .kb-sidebar-item-dir').length,
          bars: [...document.querySelectorAll('.kb-workspace-bar, .kb-topbar, .mbar')].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).length,
        }
      })
      const phone = size.width < 600
      if (phone && info.top) issues.push('手机进文档页后全站顶栏应让位给文档顶栏')
      if (!phone && !info.top) issues.push('桌面 / 平板的文档页应保留全站顶栏')
      if (info.foot) issues.push('文档页不该有页脚状态栏')
      const wantBars = phone ? 1 : 2
      if (info.bars !== wantBars) issues.push(`顶部横条 ${info.bars} 条(应有 ${wantBars} 条:${phone ? '只有文档顶栏' : '全站顶栏 + 文档顶栏'})`)
      if (size.width >= 1280 && info.side <= 64) issues.push(`进文档页侧栏不该自己收起,实际宽 ${info.side}`)
      if (size.width >= 1024 && !info.sidebar) issues.push('宽屏应显示目录栏')
      await tab.click('.kb-more-trigger')
      const items = await tab.evaluate(() => [...document.querySelectorAll('.kb-more-item')].map((b) => b.textContent?.trim()))
      for (const label of ['导出 Markdown', '复制 Markdown', '打印 / 存为 PDF', '宽屏模式']) if (!items.some((item) => item?.startsWith(label))) issues.push(`更多菜单缺「${label}」`)
      const download = tab.waitForEvent('download', { timeout: 5000 }).catch(() => null)
      await tab.click('.kb-more-item:has-text("导出 Markdown")')
      const file = await download
      if (!file) issues.push('导出 Markdown 没有下载')
      else if (!file.suggestedFilename().endsWith('.md')) issues.push(`导出文件名 ${file.suggestedFilename()}`)
      return issues
    },
  },
  'shell-others': {
    // 图标栏 / 隐藏顶栏只作用于文档页:其它页面仍有完整导航和顶栏
    route: '/',
    ready: '.kb-nav-slot',
    sizes: ['1440x900'],
    settle: 300,
    assert: async (tab) => {
      const info = await tab.evaluate(() => ({
        top: !!document.querySelector('.kb-topbar') && getComputedStyle(document.querySelector('.kb-topbar')).display !== 'none',
        side: document.querySelector('.kb-nav-slot')?.getBoundingClientRect().width ?? 0,
      }))
      const issues = []
      if (!info.top) issues.push('仪表盘丢了顶栏')
      if (info.side < 120) issues.push(`仪表盘侧栏被收成图标栏(${info.side})`)
      return issues
    },
  },
  pristine: {
    // 进编辑后什么都不改就点「完成」:不能把编辑器规范化后的 Markdown(标题后补空行等)写回去
    fixture: SOLO_EDIT_FIXTURE,
    route: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    ready: '.kb-workspace-bar-right',
    sizes: ['1440x900'],
    prepare: async (tab) => {
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
    },
    settle: 600,
    assert: async (tab) => {
      const bodies = []
      tab.on('request', (req) => { if (req.url().includes('/capabilities/edit_item')) bodies.push(String(JSON.parse(req.postData() ?? '{}').body ?? '')) })
      await tab.getByRole('button', { name: '保存' }).click()
      await tab.waitForTimeout(800)
      const changed = bodies.filter((body) => !body.startsWith('## 现象\n守护进程'))
      return changed.length ? [`未修改却改写了原文:${JSON.stringify(changed[0].slice(0, 40))}`] : []
    },
  },
  'ai-on': {
    // 管理员 + AI 开着:AI 相关入口都在
    route: '/search',
    ready: 'body',
    sizes: ['390x844', '1440x900'],
    settle: 1500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (!text.includes('深度检索')) issues.push('AI 开着时搜索页应有「深度检索」开关')
      // AI 助手入口现在是顶栏按钮(带 data-feature),悬浮球已移除
      const assistant = await tab.locator('[data-feature="ai.assistant"]').count()
      if (!assistant) issues.push('AI 开着时应有 AI 助手入口')
      if (await tab.locator('.kb-fab').count()) issues.push('悬浮球应已移除')
      if (size.width >= 1024 && !text.includes('审核收件箱')) issues.push('AI 开着时侧栏应有「审核收件箱」')
      if (size.width < 600) {
        await tab.goto(new URL('/mine', tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('[data-testid=mine]')
        const mine = await tab.locator('[data-testid=mine]').innerText()
        if (!mine.includes('审核收件箱')) issues.push('AI 开着时「我的」页应有审核收件箱')
        if (!(await tab.locator('[data-testid=mine-assistant]').count())) issues.push('AI 开着时「我的」页应有 AI 助手入口')
      }
      return issues
    },
  },
  'ai-off': {
    // AI 总开关关掉:所有 AI 入口整体消失(搜索页深度检索、AI 助手悬浮按钮、审核收件箱),其它照常
    route: '/search',
    ready: 'body',
    sizes: ['390x844', '1440x900'],
    fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } },
    settle: 1500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('深度检索')) issues.push('AI 关闭后不该出现「深度检索」')
      if (size.width >= 1024 && text.includes('审核收件箱')) issues.push('AI 关闭后侧栏不该有「审核收件箱」')
      if (size.width < 600) {
        // 手机没有侧栏:其余入口都在「我的」页里,AI 关闭后那里也不该有审核收件箱;标签栏也不该有
        if (await tab.locator('.kb-tabbar >> text=审核').count()) issues.push('AI 关闭后手机标签栏不该有「审核」')
        await tab.goto(new URL('/mine', tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('[data-testid=mine]')
        if ((await tab.locator('[data-testid=mine]').innerText()).includes('审核收件箱')) issues.push('AI 关闭后「我的」页不该有审核收件箱')
        if (await tab.locator('[data-testid=mine-assistant]').count()) issues.push('AI 关闭后「我的」页不该有 AI 助手')
      }
      const assistant = await tab.locator('[data-feature="ai.assistant"], .kb-fab, .kb-agent-widget').count()
      if (assistant) issues.push('AI 关闭后不该有 AI 助手入口 / 抽屉')
      if (!text.includes('知识库') && size.width >= 1024) issues.push('非 AI 入口应照常')
      return issues
    },
  },
  'plain-user': {
    // 普通用户(没有 sys.* 功能):看不到评测 / 系统类入口
    route: '/search',
    ready: 'body',
    sizes: ['1440x900'],
    fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('sys.') && id !== 'sources.local' && id !== 'search.tune'), true) } },
    settle: 800,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('评测')) issues.push('没有 search.tune 的账号不该看到「评测」')
      if (!text.includes('审核收件箱')) issues.push('有 ai.extract 的账号应看到「审核收件箱」')
      return issues
    },
  },
  'users-roles': {
    // 用户与权限 · 角色:选中角色、按分组展开功能开关;开一个普通功能会保存;开危险功能要确认;管理员角色不可改
    route: '/admin/users',
    ready: '.kb-ut-detail',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['普通用户', '管理员', '删除笔记', '深度检索', '自动提炼']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 手机上角色列表是横向药丸,不是占满一列的侧栏
      const roleBox = await tab.evaluate(() => document.querySelector('.kb-ut-roles')?.getBoundingClientRect().width ?? 0)
      if (size.width < 1024 && roleBox > size.width) issues.push(`角色列表比屏幕宽 ${roleBox}`)
      // 开一个普通功能 → 发出 role_update,带上新勾选
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/role_update'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-ut-feature', { hasText: '编码代理' }).locator('.sw').click()
      const sent = await request
      if (!sent) issues.push('开关一个功能没有保存')
      else if (!(JSON.parse(sent.postData() ?? '{}').features ?? []).includes('ai.acp')) issues.push('保存的功能里没有 ai.acp')
      // 管理员角色:开关全部禁用
      await tab.locator('.kb-ut-role', { hasText: '管理员' }).click()
      const disabled = await tab.locator('.kb-ut-feature .sw.is-disabled').count()
      if (!disabled) issues.push('管理员角色的开关应全部禁用')
      return issues
    },
  },
  'users-list': {
    // 用户列表 + 详情对话框(角色、状态、逐项例外、重设密码)
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    sizes: ['390x844', '1440x900'],
    prepare: async (tab) => {
      await tab.getByRole('tab', { name: '用户' }).click()
      await tab.waitForSelector('.kb-ut-list')
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const rows = await tab.locator('.kb-ut-row').count()
      if (rows !== 3) issues.push(`应有 3 个用户,实际 ${rows}`)
      const text = await tab.evaluate(() => document.body.innerText)
      if (!text.includes('已停用')) issues.push('停用的用户应有「已停用」标记')
      await tab.locator('.kb-ut-row', { hasText: 'alice' }).click()
      await tab.waitForSelector('.kb-dlg, [role=dialog]', { timeout: 5000 })
      const dialog = await tab.evaluate(() => document.body.innerText)
      for (const word of ['单独调整功能', '重设密码', '停用账号']) if (!dialog.includes(word)) issues.push(`详情里缺「${word}」`)
      // 「跟随角色」是例外下拉里的选项:WebKit 的 innerText 不含未展开下拉的选项文字,所以按 option 元素找
      const followOptions = await tab.locator('option', { hasText: '跟随角色' }).count()
      if (!followOptions) issues.push('例外下拉里缺「跟随角色」选项')
      // 例外:把「编码代理」改成禁止 → 发出 user_feature
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/user_feature'), { timeout: 5000 }).catch(() => null)
      await tab.locator('select[aria-label="编码代理(ACP):例外"]').selectOption('deny')
      const sent = await request
      if (!sent) issues.push('改例外没有发出 user_feature')
      else if (JSON.parse(sent.postData() ?? '{}').effect !== 'deny') issues.push('例外应是 deny')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'system-params': {
    // 系统参数:分组导航、AI 总开关关掉后子项置灰、只提交改过的键、不合法的值不提交
    route: '/admin/params',
    ready: '.kb-sp-body',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['启用 AI 功能', '每人存储配额', '允许游客编辑', '站点名称', '开放注册']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 改存储配额:出现保存条,保存只提交 quota.storage_gb
      await tab.locator('.kb-sp-row', { hasText: '每人存储配额' }).locator('input').fill('500')
      await tab.waitForSelector('.kb-sp-save')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/update_config'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-sp-save .kb-btn.is-primary').click()
      const sent = await request
      if (!sent) issues.push('保存没有发出 update_config')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        if (JSON.stringify(body.patch) !== JSON.stringify({ quota: { storage_gb: 500 } })) issues.push(`补丁应只含 quota.storage_gb:${JSON.stringify(body.patch)}`)
        if (body.confirm !== true) issues.push('管理级能力缺少 confirm')
      }
      // 关掉 AI 总开关:子项置灰
      await tab.locator('.kb-sp-row', { hasText: '启用 AI 功能' }).locator('.sw').click()
      const dimmed = await tab.locator('.kb-sp-row.is-off').count()
      if (dimmed < 5) issues.push(`AI 关闭后子项应置灰,实际 ${dimmed} 项`)
      // 不合法的值:提示且保存按钮不可点
      await tab.locator('.kb-sp-row', { hasText: '单个文件上限' }).locator('input').fill('abc')
      const disabledSave = await tab.locator('.kb-sp-save .kb-btn.is-primary[disabled]').count()
      if (!disabledSave) issues.push('值不合法时保存按钮应禁用')
      return issues
    },
  },
  login: {
    // 登录页:没有假截图和写死的服务器地址;用户名不预填;「忘记密码」「立即注册」按站点状态出现;密码可显示
    route: '/login',
    ready: '.auth-box',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['欢迎回来', '用户名或邮箱', '忘记密码', '立即注册']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      for (const word of ['127.0.0.1:7070', '保持登录 7 天']) if (text.includes(word)) issues.push(`不该出现「${word}」`)
      if ((await tab.locator('#login-user').inputValue()) !== '') issues.push('用户名不该预填')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 品牌介绍只在宽屏出现,手机上改成顶部小品牌条
      const paneShown = await tab.locator('.auth-pane').isVisible()
      if (paneShown !== size.width >= 1024) issues.push(`品牌介绍区在 ${size.width}px 宽度下${paneShown ? '不该' : '应该'}显示`)
      // 眼睛按钮真的切换密码可见
      await tab.locator('#login-pass').fill('secret')
      await tab.locator('.login-eye').click()
      if ((await tab.locator('#login-pass').getAttribute('type')) !== 'text') issues.push('点眼睛后密码应可见')
      // 回车提交:发出登录请求
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/login'), { timeout: 5000 }).catch(() => null)
      await tab.locator('#login-pass').press('Enter')
      if (!(await request)) issues.push('在密码框按回车没有提交登录')
      return issues
    },
  },
  'login-closed': {
    // 管理员关了注册、邮件也没配:登录页不显示注册入口,忘记密码改成「联系管理员」
    route: '/login',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __status: { registration_open: false, mail_ready: false } },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('立即注册')) issues.push('注册关闭时不该显示「立即注册」')
      if (await tab.locator('a:has-text("忘记密码")').count()) issues.push('邮件没配好时不该有「忘记密码」链接')
      if (!text.includes('请联系管理员重设')) issues.push('应提示联系管理员重设密码')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'login-setup': {
    // 首次使用:引导在终端设置管理密码,页面如实说「每 3 秒检测」
    route: '/login?setup=1',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __status: { password_set: false, logged_in: false } },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['设置管理密码', 'kb auth set-password', '每 3 秒']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  register: {
    // 注册:要验证码(倒计时)→ 填表 → 密码强度与用户名即时提示 → 提交带上全部字段并登录
    route: '/register',
    ready: '#reg-email',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const submit = tab.locator('.auth-submit')
      if (!(await submit.isDisabled())) issues.push('表单没填完时「注册」应禁用')
      if (await tab.locator('#reg-invite').count()) issues.push('不要求邀请码时不该显示邀请码框')
      // 属性:验证码框用 one-time-code + 数字键盘,邮箱用邮箱键盘
      const attrs = await tab.evaluate(() => ({
        code: [document.querySelector('#reg-code')?.getAttribute('autocomplete'), document.querySelector('#reg-code')?.getAttribute('inputmode')],
        email: document.querySelector('#reg-email')?.getAttribute('inputmode'),
        pass: document.querySelector('#reg-pass')?.getAttribute('autocomplete'),
      }))
      if (attrs.code.join() !== 'one-time-code,numeric') issues.push(`验证码框属性不对:${attrs.code}`)
      if (attrs.email !== 'email') issues.push('邮箱框应弹出邮箱键盘')
      if (attrs.pass !== 'new-password') issues.push('密码框应是 new-password')
      // 要验证码
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('.auth-inline .kb-btn').click()
      await tab.waitForSelector('text=验证码已发送到 user@example.com')
      const label = (await tab.locator('.auth-inline .kb-btn').innerText()).trim()
      if (!/^\d+ 秒后重发$/.test(label)) issues.push(`发送后按钮应显示倒计时,实际「${label}」`)
      if (!(await tab.locator('.auth-inline .kb-btn').isDisabled())) issues.push('倒计时内不能再点')
      // 即时提示
      await tab.locator('#reg-user').fill('a')
      if (!(await tab.evaluate(() => document.body.innerText)).includes('用户名需要 3–20 位')) issues.push('用户名太短应即时提示')
      await tab.locator('#reg-pass').fill('12345678')
      if (!(await tab.evaluate(() => document.body.innerText)).includes('这个密码太常见了')) issues.push('弱密码应即时提示原因')
      // 填对之后可提交
      await tab.locator('#reg-code').fill('481039')
      await tab.locator('#reg-user').fill('user_yi')
      await tab.locator('#reg-pass').fill('Correct-Horse-9')
      if (await submit.isDisabled()) issues.push('全部填对后「注册」应可点')
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/register'), { timeout: 5000 }).catch(() => null)
      await submit.click()
      const sent = await request
      if (!sent) issues.push('点注册没有发出请求')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        if (body.email !== 'user@example.com' || body.code !== '481039' || body.username !== 'user_yi' || body.password !== 'Correct-Horse-9') issues.push(`注册请求体不对:${JSON.stringify(body)}`)
        if (sent.headers()['x-kb-csrf'] !== '1') issues.push('注册请求缺 x-kb-csrf')
      }
      return issues
    },
  },
  'register-invite': {
    // 要求邀请码:出现必填的邀请码框,填完即时核对,没填前不能提交,提交时带上邀请码
    route: '/register?invite=KB-7H2K-AAAA',
    ready: '#reg-invite',
    sizes: ['390x844', '1440x900'],
    fixture: { __status: { require_invite: true } },
    settle: 700,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (!text.includes('(必填)')) issues.push('邀请码应标注必填')
      if ((await tab.locator('#reg-invite').inputValue()) !== 'KB-7H2K-AAAA') issues.push('链接里的 ?invite= 应预填到邀请码框')
      await tab.waitForSelector('text=邀请码有效', { timeout: 3000 }).catch(() => issues.push('预填的邀请码没有自动核对'))
      await tab.locator('#reg-invite').fill('')
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('#reg-code').fill('481039')
      await tab.locator('#reg-user').fill('user_yi')
      await tab.locator('#reg-pass').fill('Correct-Horse-9')
      if (!(await tab.locator('.auth-submit').isDisabled())) issues.push('要求邀请码时,没填邀请码「注册」应禁用')
      // 半截输入不该向服务端核对(会被记成一次失败尝试)
      let checks = 0
      tab.on('request', (req) => {
        if (req.url().includes('/api/v1/auth/invite-check')) checks += 1
      })
      await tab.locator('#reg-invite').pressSequentially('KB-ZZZ', { delay: 30 })
      await tab.waitForTimeout(800)
      if (checks !== 0) issues.push(`邀请码没输完就发了 ${checks} 次核对请求`)
      await tab.locator('#reg-invite').fill('KB-ZZZZ-ZZZZ')
      await tab.waitForSelector('text=邀请码无效', { timeout: 3000 }).catch(() => issues.push('无效邀请码应提示'))
      await tab.locator('#reg-invite').fill('KB-7H2K-BBBB')
      await tab.waitForSelector('text=邀请码有效', { timeout: 3000 }).catch(() => issues.push('有效邀请码应提示有效'))
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/register'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.auth-submit').click()
      const sent = await request
      if (!sent) issues.push('点注册没有发出请求')
      else if (JSON.parse(sent.postData() ?? '{}').invite !== 'KB-7H2K-BBBB') issues.push('注册请求没带邀请码')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'register-closed': {
    // 注册关闭:不显示表单,说明原因并给回登录的入口
    route: '/register',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __status: { registration_open: false } },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (!text.includes('暂未开放注册')) issues.push('应显示「暂未开放注册」')
      if (await tab.locator('#reg-email').count()) issues.push('关闭时不该有注册表单')
      if (!(await tab.locator('a:has-text("返回登录")').count())) issues.push('应有返回登录的入口')
      return issues
    },
  },
  'register-ratelimit': {
    // 被限频:显示服务端的话,并按 Retry-After 倒计时;邮件功能没开时给明确提示
    route: '/register',
    ready: '#reg-email',
    sizes: ['390x844'],
    expectConsole: /status of 429/,
    fixture: {
      __account: (path) =>
        path.endsWith('/email-code') ? { status: 429, headers: { 'retry-after': '42' }, body: { code: 'rate_limited', message: '请 42 秒后再获取验证码' } } : undefined,
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('.auth-inline .kb-btn').click()
      await tab.waitForSelector('text=请 42 秒后再获取验证码')
      const label = (await tab.locator('.auth-inline .kb-btn').innerText()).trim()
      if (!/^4[12] 秒后重发$/.test(label)) issues.push(`限频后应按 Retry-After 倒计时,实际「${label}」`)
      return issues
    },
  },
  'register-filled': {
    // 只填不提交:看填好后的排版(强度条、倒计时、提示文字),以及各种出错提示的样子
    route: '/register',
    ready: '#reg-email',
    sizes: ['390x844', '820x1180', '1440x900'],
    prepare: async (tab) => {
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('.auth-inline .kb-btn').click()
      await tab.waitForSelector('text=验证码已发送到 user@example.com')
      await tab.locator('#reg-code').fill('481039')
      await tab.locator('#reg-user').fill('user_yi')
      await tab.locator('#reg-pass').fill('Correct-Horse-9')
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('.auth-submit').isDisabled()) issues.push('填好后「注册」应可点')
      if ((await tab.locator('.auth-strength i.on').count()) < 3) issues.push('强密码应点亮至少 3 格')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'register-errors': {
    // 各种出错提示:邮箱不对、用户名太短、弱密码、服务端拒绝
    route: '/register',
    ready: '#reg-email',
    sizes: ['390x844', '1440x900'],
    fixture: {
      __account: (path) =>
        path.endsWith('/register') ? { status: 400, body: { code: 'invalid_input', message: '验证码已过期,或还没有获取' } } : undefined,
    },
    expectConsole: /status of 400/,
    prepare: async (tab) => {
      await tab.locator('#reg-email').fill('bad@example')
      await tab.locator('#reg-user').fill('a')
      await tab.locator('#reg-pass').fill('12345678')
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('#reg-code').fill('000000')
      await tab.locator('#reg-user').fill('user_yi')
      await tab.locator('#reg-pass').fill('Correct-Horse-9')
      await tab.locator('.auth-submit').click()
      await tab.waitForSelector('.auth-error')
      await tab.locator('#reg-user').fill('a')
      await tab.locator('#reg-pass').fill('12345678')
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['验证码已过期', '用户名需要 3–20 位', '这个密码太常见了']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'me-avatar': {
    // 个人资料 · 头像:选图 → 本地预览 → 确认才上传;取消不发请求;非图片 / 超大在前端就拦;服务端拒绝时保留预览并给人话;移除要确认
    // 场景里故意让服务端返回 400(假图片、旧密码不对),浏览器会把它打进控制台
    expectConsole: /status of 400/,
    route: '/me',
    ready: '.kb-me-avatar',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const text = () => tab.evaluate(() => document.body.innerText)
      for (const word of ['个人资料', '修改密码', '登录设备', '@admin', '已验证', '更换头像']) if (!(await text()).includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 没有头像时显示昵称首字母
      if (!(await tab.locator('.kb-me-avatar .kb-avatar-initial').innerText()).includes('管')) issues.push('没有头像时应显示昵称首字母「管」')
      if (await tab.locator('.kb-me-avatar img').count()) issues.push('没有头像时不该有图片')
      if (await tab.getByRole('button', { name: '移除' }).count()) issues.push('没有头像时不该有「移除」')
      const puts = []
      tab.on('request', (req) => {
        if (req.url().includes('/api/v1/me/avatar') && req.method() === 'PUT') puts.push(req)
      })
      const png = gradientPng(300, 'green')
      const input = tab.locator('input[type=file][aria-label="选择头像图片"]')

      // 1) 非图片:前端就拦
      await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
      await tab.waitForSelector('text=只支持 PNG、JPEG、WebP、GIF')
      await input.setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload=alert(1)></svg>') })
      await tab.waitForTimeout(150)
      if (await tab.locator('.kb-me-preview').count()) issues.push('SVG 不该进入预览')
      // 2) 超过 8 MB:前端拦
      await input.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) })
      await tab.waitForSelector('text=不能超过 8 MB')
      if (puts.length) issues.push('被前端拦住的文件不该发请求')

      // 3) 选一张好图 → 预览 → 取消
      await input.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
      await tab.waitForSelector('.kb-me-preview')
      if (!(await text()).includes('使用这张')) issues.push('预览时应有「使用这张」')
      if (!(await imageLoaded(tab, '.kb-me-preview'))) issues.push('预览图没有渲染出来')
      if (await tab.locator('.kb-me-avatar .kb-avatar').count()) issues.push('预览时不该同时显示旧头像')
      await tab.getByRole('button', { name: '取消' }).click()
      if (await tab.locator('.kb-me-preview').count()) issues.push('取消后预览应消失')
      if (puts.length) issues.push('取消不该发请求')

      // 4) 服务端拒绝(类型对、内容不是图片):提示服务端的话,不带 invalid input 前缀,预览保留可重试
      await tab.evaluate(() => fetch('/api/v1/__fixture/avatar-reject', { method: 'POST', body: '1' }))
      await input.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not really a png') })
      await tab.waitForSelector('.kb-me-preview')
      await tab.getByRole('button', { name: '使用这张' }).click()
      await tab.waitForSelector('text=只支持 PNG、JPEG、WebP、GIF 图片')
      if ((await text()).includes('invalid input')) issues.push('错误提示里不该有 invalid input: 前缀')
      if (!(await tab.locator('.kb-me-preview').count())) issues.push('上传失败后应保留预览,方便重试')
      await tab.getByRole('button', { name: '取消' }).click()

      // 5) 真正上传(夹具恢复成接受)
      await tab.evaluate(() => fetch('/api/v1/__fixture/avatar-reject', { method: 'POST', body: '0' }))
      puts.length = 0
      await input.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
      await tab.waitForSelector('.kb-me-preview')
      await tab.getByRole('button', { name: '使用这张' }).click()
      await tab.waitForSelector('.kb-me-avatar .kb-avatar img')
      if (puts.length !== 1) issues.push(`应只上传 1 次,实际 ${puts.length}`)
      else {
        const request = puts[0]
        if (request.headers()['content-type'] !== 'application/octet-stream') issues.push(`类型应是 octet-stream:${request.headers()['content-type']}`)
        if (request.headers()['x-kb-csrf'] !== '1') issues.push('缺 x-kb-csrf')
        // Playwright 的 WebKit 读不到二进制请求体(返回 null),这条只在读得到时才断言;
        // 后端收到的字节是否原样,另由 kb-web 的 HTTP 测试和真实守护进程的 e2e 保证
        const body = request.postDataBuffer()
        if (body && (!body.subarray(0, 8).equals(png.subarray(0, 8)) || body.length !== png.length)) issues.push('请求体应是原始图片字节')
      }
      if (await tab.locator('.kb-me-preview').count()) issues.push('上传成功后预览应消失')
      await tab.waitForSelector('text=头像已更新')
      // 页面头像、侧栏 / 顶栏的头像都换成了图片
      // 图片元素一插入就能选到,字节还在加载:要等它加载完再看尺寸(机器忙时不等会误报)
      const loaded = await imageLoaded(tab, '.kb-me-avatar .kb-avatar img', 256)
      if (!loaded) issues.push('新头像应渲染成 256×256 的图片')
      const shellImages = await tab.locator('.kb-top-avatar img, .kb-me-link img').count()
      if (size.width >= 1024 && shellImages < 1) issues.push('保存后顶栏 / 侧栏的头像也应变成图片')
      if (!(await tab.getByRole('button', { name: '移除' }).count())) issues.push('有头像后应出现「移除」')

      // 6) 移除:要确认
      await tab.getByRole('button', { name: '移除' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      const del = tab.waitForRequest((req) => req.url().includes('/api/v1/me/avatar') && req.method() === 'DELETE', { timeout: 5000 }).catch(() => null)
      await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
      if (!(await del)) issues.push('确认移除后没有发出 DELETE')
      await tab.waitForSelector('.kb-me-avatar .kb-avatar-initial')
      return issues
    },
  },
  'me-preview': {
    // 只做到「选好图、出现预览」就停,用来目视排版:预览圆形、文件名、按钮;长文件名不能撑破布局
    route: '/me',
    ready: '.kb-me-avatar',
    sizes: ['390x844', '1440x900'],
    prepare: async (tab) => {
      await tab.locator('input[type=file][aria-label="选择头像图片"]').setInputFiles({
        name: 'IMG_20261028_a-very-long-photo-file-name-from-my-phone-camera-roll-final-final.png',
        mimeType: 'image/png',
        buffer: gradientPng(300, 'blue'),
      })
      await tab.waitForSelector('.kb-me-preview')
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('长文件名撑出了横向滚动')
      const box = await tab.locator('.kb-me-avatar').boundingBox()
      const actions = await tab.locator('.kb-me-avatar-actions').boundingBox()
      if (box && actions && actions.x + actions.width > box.x + box.width + 1) issues.push('按钮区超出了卡片')
      return issues
    },
  },
  'me-devices-view': {
    // 只看不点:滚到「登录设备」看排版(me-devices 场景最后会退出当前设备、跳走,截图拍不到列表)
    route: '/me',
    ready: '.kb-me-devices',
    sizes: ['390x844', '820x1180'],
    prepare: async (tab) => {
      await tab.locator('.kb-me-devices').scrollIntoViewIfNeeded()
      await tab.evaluate(() => document.querySelector('#me-devices')?.scrollIntoView({ block: 'start' }))
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      // 每台设备那行:名字、标记、说明和「退出」按钮都在行内,不溢出
      for (const row of await tab.locator('.kb-me-devices li').all()) {
        const box = await row.boundingBox()
        const button = await row.getByRole('button', { name: '退出' }).boundingBox()
        if (box && button && button.x + button.width > box.x + box.width + 1) issues.push('「退出」按钮超出了行')
      }
      return issues
    },
  },
  'me-password-view': {
    // 只看不点:滚到「修改密码」,填一个强密码,看强度条和提示的排版
    route: '/me',
    ready: 'form.kb-me-form',
    sizes: ['390x844', '820x1180'],
    prepare: async (tab) => {
      const form = tab.locator('form.kb-me-form')
      await form.locator('label').filter({ hasText: /^\s*新密码/ }).locator('input').fill('Correct-Horse-9')
      await form.locator('label').filter({ hasText: /^\s*确认新密码/ }).locator('input').fill('Correct-Horse-8')
      await tab.evaluate(() => document.querySelector('#me-security-top')?.scrollIntoView({ block: 'start' }))
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('form.kb-me-form').innerText()
      for (const word of ['强度:', '两次输入的新密码不一致']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      return issues
    },
  },
  'me-delete': {
    // 注销账号:要输密码确认;输错不关窗口且不残留密码;成功后卡片和全站横幅出现;撤销后恢复;/me 页自己不重复显示横幅
    route: '/me',
    ready: '.kb-me-danger',
    sizes: ['390x844', '1440x900'],
    expectConsole: /status of 400/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = () => tab.evaluate(() => document.body.innerText)
      if (!(await text()).includes('永久删除,无法恢复')) issues.push('注销卡片应说明后果')
      if (await tab.locator('.kb-deletion-alert').count()) issues.push('没在注销时不该有横幅')
      await tab.getByRole('button', { name: /注销账号…/ }).click()
      await tab.waitForSelector('.kb-me-consequences')
      const dialog = await tab.locator('.kb-me-consequences').innerText()
      for (const word of ['笔记', '无法恢复', '随时在这里撤销']) if (!dialog.includes(word)) issues.push(`后果说明里缺「${word}」`)
      const submit = tab.getByRole('button', { name: '申请注销' })
      if (!(await submit.isDisabled())) issues.push('没输密码时「申请注销」应禁用')
      const field = tab.locator('.kb-ut-form label', { hasText: '输入当前密码确认' }).locator('input')
      if ((await field.getAttribute('type')) !== 'password') issues.push('确认密码必须是密码框')
      // 输错:提示、窗口不关、密码被清空
      await field.fill('wrong-password')
      await submit.click()
      await tab.waitForSelector('text=密码不正确')
      if ((await field.inputValue()) !== '') issues.push('提交后密码框应清空,不残留')
      if (!(await tab.locator('.kb-me-consequences').count())) issues.push('输错密码不该关掉对话框')
      // 输对
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/me/deletion') && req.method() === 'POST', { timeout: 5000 }).catch(() => null)
      await field.fill('old-password-1')
      await submit.click()
      const sent = await request
      if (!sent) issues.push('没有发出申请')
      else if (JSON.stringify(sent.postDataJSON()) !== '{"password":"old-password-1"}') issues.push(`请求体不对:${sent.postData()}`)
      await tab.waitForSelector('text=已申请注销')
      if (await tab.locator('.kb-me-consequences').count()) issues.push('成功后对话框应关闭')
      const card = await tab.locator('.kb-me-danger').innerText()
      for (const word of ['被永久删除', '随时撤销']) if (!card.includes(word)) issues.push(`注销中的卡片缺「${word}」`)
      // 夹具给的是整整 7 天,但页面时钟在加载过程中走了几百毫秒,向下取整就是 6 天 23 小时;两种都是正确的「一周」
      if (!/还剩 (7 天|6 天 23 小时)/.test(card)) issues.push(`倒计时应是一周左右:${card}`)
      if (!(await tab.getByRole('button', { name: '撤销注销' }).count())) issues.push('应有「撤销注销」')
      if (await tab.locator('.kb-deletion-alert').count()) issues.push('/me 页自己有卡片,不该再重复显示横幅')
      // 去别的页面:顶部横幅
      await tab.evaluate(() => (window.history.pushState({}, '', '/params'), window.dispatchEvent(new PopStateEvent('popstate'))))
      await tab.waitForSelector('.kb-deletion-alert')
      const banner = await tab.locator('.kb-deletion-alert').innerText()
      if (!banner.includes('被永久删除') || !banner.includes('去撤销')) issues.push(`横幅内容不对:${banner}`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 回 /me 撤销
      await tab.locator('.kb-deletion-alert a', { hasText: '去撤销' }).click()
      await tab.waitForSelector('.kb-me-danger')
      const undo = tab.waitForRequest((req) => req.url().includes('/api/v1/me/deletion') && req.method() === 'DELETE', { timeout: 5000 }).catch(() => null)
      await tab.getByRole('button', { name: '撤销注销' }).click()
      if (!(await undo)) issues.push('没有发出撤销')
      await tab.waitForSelector('text=已撤销注销')
      if (!(await tab.getByRole('button', { name: /注销账号…/ }).count())) issues.push('撤销后应恢复成可申请状态')
      return issues
    },
  },
  'me-delete-expired': {
    // 冷静期已过(清理任务还没来得及扫):如实说明,不再给撤销按钮,也不暗示还能撤销
    route: '/me',
    ready: '.kb-me-danger',
    sizes: ['390x844', '1440x900'],
    fixture: { __profile: { deleteAfter: Date.UTC(2026, 9, 20, 16, 42, 0) - 3_600_000 } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const card = await tab.locator('.kb-me-danger').innerText()
      if (!card.includes('冷静期已经结束') || !card.includes('即将被删除')) issues.push(`应如实说明已结束:${card}`)
      if (card.includes('随时撤销')) issues.push('已到期不该再说「可以随时撤销」')
      if (await tab.getByRole('button', { name: '撤销注销' }).count()) issues.push('已到期不该有撤销按钮')
      await tab.evaluate(() => (window.history.pushState({}, '', '/params'), window.dispatchEvent(new PopStateEvent('popstate'))))
      await tab.waitForSelector('.kb-deletion-alert')
      const link = await tab.locator('.kb-deletion-alert a').innerText()
      if (link.trim() !== '查看') issues.push(`已到期的横幅按钮应是「查看」,实际「${link}」`)
      return issues
    },
  },
  'me-delete-dialog': {
    // 只看不点:注销确认对话框的排版(后果列表、密码框、红色按钮)
    route: '/me',
    ready: '.kb-me-danger',
    sizes: ['390x844', '1440x900'],
    prepare: async (tab) => {
      await tab.getByRole('button', { name: /注销账号…/ }).click()
      await tab.waitForSelector('.kb-me-consequences')
      await tab.locator('.kb-ut-form input[type=password]').fill('old-password-1')
    },
    settle: 500,
    assert: async () => [],
  },
  'me-deleting-banner': {
    // 只看不点:注销中的账号在别的页面顶部看到的横幅
    route: '/admin/params',
    ready: '.kb-sp-body',
    sizes: ['390x844', '1440x900'],
    fixture: { __profile: { deleteAfter: Date.UTC(2026, 9, 20, 16, 42, 0) + 4 * 86_400_000 + 5 * 3_600_000 } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const banner = await tab.locator('.kb-deletion-alert').innerText()
      if (!/还剩 4 天 (4|5) 小时/.test(banner)) issues.push(`横幅倒计时不对:${banner}`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'me-email': {
    // 更换邮箱:两步(新邮箱 + 密码 → 验证码);密码错、验证码错各有提示;密码用完即清;成功后页面上的邮箱变成新的
    route: '/me',
    ready: '.kb-me-facts',
    sizes: ['390x844', '1440x900'],
    expectConsole: /status of 400/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = () => tab.evaluate(() => document.body.innerText)
      if (!(await text()).includes('admin@example.com')) issues.push('应显示当前邮箱')
      await tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }).click()
      await tab.waitForSelector('.kb-ut-form')
      const send = tab.getByRole('button', { name: '发送验证码' })
      if (!(await send.isDisabled())) issues.push('没填新邮箱和密码时「发送验证码」应禁用')
      const field = (label) => tab.locator('.kb-ut-form label', { hasText: label }).locator('input')
      if ((await field('当前密码').getAttribute('type')) !== 'password') issues.push('当前密码必须是密码框')
      if ((await field('新邮箱').getAttribute('inputmode')) !== 'email') issues.push('新邮箱应弹出邮箱键盘')
      // 邮箱格式不对
      await field('新邮箱').fill('not-an-email')
      await field('当前密码').fill('old-password-1')
      await send.click()
      await tab.waitForSelector('text=请输入正确的邮箱地址')
      // 密码错:提示、密码被清、留在第一步
      await field('新邮箱').fill('New.Me@Example.com')
      await field('当前密码').fill('wrong-password')
      await send.click()
      await tab.waitForSelector('text=密码不正确')
      if ((await field('当前密码').inputValue()) !== '') issues.push('提交后密码框应清空')
      // 密码对:进入第二步
      await field('当前密码').fill('old-password-1')
      const ask = tab.waitForRequest((req) => req.url().includes('/api/v1/me/email-code'), { timeout: 5000 }).catch(() => null)
      await send.click()
      const sent = await ask
      if (!sent) issues.push('没有请求验证码')
      else if (JSON.stringify(sent.postDataJSON()) !== '{"new_email":"New.Me@Example.com","password":"old-password-1"}') issues.push(`请求体不对:${sent.postData()}`)
      // 用第二步独有的输入框当信号,而不是靠文字(第一步的说明文字里也有「验证码」)
      await tab.waitForSelector('.kb-ut-form input[autocomplete=one-time-code]')
      const second = await tab.locator('.kb-ut-form').innerText()
      if (!second.includes('秒后可以') && !second.includes('现在可以')) issues.push(`第二步应说明多久能重发:${second}`)
      const attrs = await tab.locator('.kb-ut-form input').first().evaluate((el) => [el.getAttribute('autocomplete'), el.getAttribute('inputmode'), el.getAttribute('maxlength')])
      if (attrs.join() !== 'one-time-code,numeric,6') issues.push(`验证码框属性不对:${attrs}`)
      const confirm = tab.getByRole('button', { name: '确认更换' })
      if (!(await confirm.isDisabled())) issues.push('没填验证码时「确认更换」应禁用')
      // 验证码错:提示服务端的话(没有 invalid input 前缀)
      await tab.locator('.kb-ut-form input').first().fill('000000')
      await confirm.click()
      await tab.waitForSelector('text=验证码不正确')
      if ((await text()).includes('invalid input')) issues.push('不该出现 invalid input: 前缀')
      // 验证码对
      await tab.locator('.kb-ut-form input').first().fill('123456')
      await confirm.click()
      await tab.waitForSelector('text=邮箱已更换')
      if (await tab.locator('.kb-ut-form').count()) issues.push('成功后对话框应关闭')
      const facts = await tab.locator('.kb-me-facts').innerText()
      if (!facts.includes('new.me@example.com') || facts.includes('admin@example.com')) issues.push(`页面上的邮箱应变成新的:${facts}`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'me-email-no-mail': {
    // 管理员没配发信邮箱:「更换」按钮禁用并说明原因,而不是点进去才失败
    route: '/me',
    ready: '.kb-me-facts',
    sizes: ['390x844'],
    fixture: { __status: { mail_ready: false } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const button = tab.locator('.kb-me-facts').getByRole('button', { name: '更换' })
      if (!(await button.isDisabled())) issues.push('邮件没配好时「更换」应禁用')
      if (!((await button.getAttribute('title')) ?? '').includes('管理员')) issues.push('应说明是管理员还没配置发信邮箱')
      return issues
    },
  },
  'me-email-step2': {
    // 只看不点:更换邮箱第二步(输入验证码)的排版
    route: '/me',
    ready: '.kb-me-facts',
    sizes: ['390x844', '1440x900'],
    prepare: async (tab) => {
      await tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }).click()
      await tab.waitForSelector('.kb-ut-form')
      const field = (label) => tab.locator('.kb-ut-form label', { hasText: label }).locator('input')
      await field('新邮箱').fill('someone.with.a.fairly.long.address@subdomain.example-university.edu.cn')
      await field('当前密码').fill('old-password-1')
      await tab.getByRole('button', { name: '发送验证码' }).click()
      await tab.waitForSelector('.kb-ut-form input[autocomplete=one-time-code]')
      await tab.locator('.kb-ut-form input').first().fill('12')
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('长邮箱撑出了横向滚动')
      const dialog = tab.locator('[role=dialog], .kb-dlg').first()
      const box = await dialog.boundingBox()
      const vw = await tab.evaluate(() => innerWidth)
      if (box && box.x + box.width > vw + 1) issues.push('对话框超出了屏幕宽度')
      // 长地址不能出现在副标题里(会折行压到关闭按钮上);它在正文里单独一行,且完整落在对话框内
      const address = 'someone.with.a.fairly.long.address@subdomain.example-university.edu.cn'
      const header = await dialog.locator('.kb-dlg-head, header').first().innerText().catch(() => '')
      if (header.includes('someone.with')) issues.push('长邮箱地址不该放在对话框副标题里')
      const line = await tab.locator('.kb-me-addr').boundingBox()
      if (!line || !box || line.x < box.x - 1 || line.x + line.width > box.x + box.width + 1) issues.push('地址那一行应完整落在对话框内')
      if (!(await tab.locator('.kb-me-addr').innerText()).includes(address)) issues.push('正文里应完整显示新邮箱地址')
      return issues
    },
  },
  'me-export': {
    // 导出我的数据:开始 → 进度推进 → 完成可下载(带跳过说明)→ 重新导出 / 删除;今天次数用完时给人话
    route: '/me',
    ready: '#me-export',
    sizes: ['390x844', '1440x900'],
    expectConsole: /status of 403/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const card = tab.locator('.kb-me-card', { has: tab.locator('#me-export') })
      const text = () => card.innerText()
      if (!(await text()).includes('今天还可以导出 3 次')) issues.push(`应显示剩余次数:${await text()}`)
      for (const word of ['笔记', '原始文件', 'notes/', 'sources/', '被系统隔离的可疑文件不会导出']) if (!(await text()).includes(word)) issues.push(`说明里缺「${word}」`)
      const post = tab.waitForRequest((req) => req.url().endsWith('/api/v1/me/export') && req.method() === 'POST', { timeout: 5000 }).catch(() => null)
      await card.getByRole('button', { name: '开始导出' }).click()
      if (!(await post)) issues.push('没有发出开始导出')
      await card.locator('[role=progressbar]').waitFor({ timeout: 5000 })
      if (!(await text()).includes('可以离开这个页面')) issues.push('进度中应告诉用户可以离开')
      // 轮询推进到完成(夹具每次轮询推进 1/3)
      await card.getByRole('link', { name: '下载' }).waitFor({ timeout: 15000 })
      const done = await text()
      // 夹具:12 条笔记、7 个文件、压缩后 4200000 字节(= 4.0 MB)、23 小时后过期、1 项被跳过。
      // 页面时钟在加载和轮询期间已经走了几秒,向下取整就是 22 小时;22 / 23 都对
      for (const word of ['12 条笔记', '7 个文件', '4.0 MB', '有 1 项没有导出']) if (!done.includes(word)) issues.push(`完成态缺「${word}」:${done.replace(/\n+/g, ' / ')}`)
      if (!/保留 2[23] 小时/.test(done)) issues.push(`应显示保留约 23 小时:${done.replace(/\n+/g, ' / ')}`)
      const link = card.getByRole('link', { name: '下载' })
      if ((await link.getAttribute('href')) !== '/api/v1/me/export/download') issues.push('下载链接不对')
      if ((await link.getAttribute('download')) === null) issues.push('下载链接应带 download 属性')
      await card.locator('summary').click()
      if (!(await text()).includes('符号链接,已跳过')) issues.push('展开后应列出被跳过的项')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 删除要确认
      const del = tab.waitForRequest((req) => req.url().endsWith('/api/v1/me/export') && req.method() === 'DELETE', { timeout: 5000 }).catch(() => null)
      await card.getByRole('button', { name: '删除' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
      if (!(await del)) issues.push('确认后没有发出 DELETE')
      await card.getByRole('button', { name: '开始导出' }).waitFor({ timeout: 5000 })
      if (!(await text()).includes('今天还可以导出 2 次')) issues.push(`用掉一次后应显示 2 次:${await text()}`)
      return issues
    },
  },
  'me-export-limit': {
    // 今天次数用完:按钮禁用,而不是点了才报错;服务端拒绝时显示它的话
    route: '/me',
    ready: '#me-export',
    sizes: ['390x844'],
    fixture: { __export: { state: 'idle', left: 0, polls: 0 } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const card = tab.locator('.kb-me-card', { has: tab.locator('#me-export') })
      if (!(await card.getByRole('button', { name: '开始导出' }).isDisabled())) issues.push('次数用完时「开始导出」应禁用')
      if (!(await card.innerText()).includes('今天还可以导出 0 次')) issues.push('应显示 0 次')
      return issues
    },
  },
  'me-export-failed': {
    // 导出失败:显示原因和「重试」
    route: '/me',
    ready: '#me-export',
    sizes: ['390x844'],
    fixture: { __export: { state: 'failed', left: 2, polls: 0, reason: '导出没有成功,请稍后再试' } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const card = tab.locator('.kb-me-card', { has: tab.locator('#me-export') })
      if (!(await card.innerText()).includes('导出没有成功')) issues.push('应显示失败原因')
      if (!(await card.getByRole('button', { name: '重试' }).count())) issues.push('应有「重试」')
      return issues
    },
  },
  'me-export-running': {
    // 只看不点:导出进行到一半的样子(进度条、已处理 / 总量)
    route: '/me',
    ready: '#me-export',
    sizes: ['390x844', '1440x900'],
    fixture: { __export: { state: 'running', left: 2, polls: 1 } },
    prepare: async (tab) => {
      await tab.evaluate(() => document.querySelector('#me-export')?.scrollIntoView({ block: 'start' }))
    },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const card = tab.locator('.kb-me-card', { has: tab.locator('#me-export') })
      const text = (await card.innerText()).replace(/\n+/g, ' / ')
      if (!/\(\d+%\)/.test(text) || !text.includes('7 个文件') || !text.includes('12 条笔记')) issues.push(`进度文字不对:${text}`)
      const width = await card.locator('.kb-me-progress i').evaluate((el) => el.getBoundingClientRect().width)
      if (!(width > 0)) issues.push('进度条应有宽度')
      return issues
    },
  },
  'me-export-ready': {
    // 只看不点:导出完成后的样子(下载 / 删除 / 跳过说明 / 重新导出)
    route: '/me',
    ready: '#me-export',
    sizes: ['390x844', '820x1180'],
    fixture: { __export: { state: 'ready', left: 2, polls: 0, size: 4_200_000, files: 7, notes: 12, skipped: ['符号链接,已跳过:old/link.txt', '文件名不是合法的 UTF-8,已跳过:bad-name'], expires_at: Date.UTC(2026, 9, 20, 16, 42, 0) + 23 * 3_600_000 } },
    prepare: async (tab) => {
      await tab.locator('summary').click()
      await tab.evaluate(() => document.querySelector('#me-export')?.scrollIntoView({ block: 'start' }))
    },
    settle: 400,
    assert: async () => [],
  },
  'me-avatar-existing': {
    // 已有头像的账号:直接显示图片;图片地址带版本参数;加载失败时退回首字母
    route: '/me',
    ready: '.kb-me-avatar',
    sizes: ['390x844', '1440x900'],
    fixture: { __profile: { avatar: 'usr_admin-0123abcd.png', display_name: '林一' } },
    expectConsole: /status of 404/,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const img = tab.locator('.kb-me-avatar .kb-avatar img')
      if (!(await img.count())) return ['已有头像时应显示图片']
      const src = await img.getAttribute('src')
      if (src !== '/api/v1/users/usr_admin/avatar?v=usr_admin-0123abcd.png') issues.push(`图片地址不对:${src}`)
      if (!(await imageLoaded(tab, '.kb-me-avatar .kb-avatar img', 256))) issues.push('头像图片没有加载成功')
      const nameBox = tab.locator('.kb-me-form label', { hasText: '昵称' }).locator('input')
      if ((await nameBox.inputValue()) !== '林一') issues.push(`昵称框应是「林一」,实际「${await nameBox.inputValue()}」`)
      // 头像图片 404(比如刚被删)时退回首字母,而不是一个破图标
      await tab.route('**/api/v1/users/usr_admin/avatar**', (route) => route.fulfill({ status: 404, body: '' }))
      await tab.reload()
      await tab.waitForSelector('.kb-me-avatar')
      await tab.waitForTimeout(500)
      if (await tab.locator('.kb-me-avatar .kb-avatar img').count()) issues.push('图片加载失败后应退回首字母')
      if (!(await tab.locator('.kb-me-avatar .kb-avatar-initial').innerText()).includes('林')) issues.push('失败后应显示昵称首字「林」')
      return issues
    },
  },
  'me-name': {
    // 个人资料 · 昵称:没改动时不能保存;非法输入当场提示;保存后顶栏 / 侧栏的名字跟着变
    route: '/me',
    ready: '.kb-me-form',
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const save = tab.getByRole('button', { name: '保存昵称' })
      const input = tab.locator('.kb-me-form label', { hasText: '昵称' }).locator('input')
      if ((await input.inputValue()) !== '管理员') issues.push(`昵称框应预填当前昵称,实际「${await input.inputValue()}」`)
      if (!(await save.isDisabled())) issues.push('没改动时「保存昵称」应禁用')
      // 非法:尖括号、空、超长、冒充用的方向覆盖字符
      for (const [bad, word] of [['<b>x</b>', '不能包含'], ['', '不能为空'], ['字'.repeat(31), '最多 30'], ['\u202enimda', '不能包含']]) {
        await input.fill(bad)
        if (bad !== '' && !(await tab.locator('.kb-me-bad').count())) issues.push(`「${JSON.stringify(bad)}」应有错误提示`)
        else if (bad !== '' && !(await tab.locator('.kb-me-bad').first().innerText()).includes(word)) issues.push(`「${JSON.stringify(bad)}」的提示应含「${word}」`)
        if (bad !== '' && !(await save.isDisabled())) issues.push(`「${JSON.stringify(bad)}」时保存应禁用`)
      }
      // 合法:保存,请求体带去掉空白的新名字
      await input.fill('  林一  ')
      if (await save.isDisabled()) issues.push('合法的新昵称应可保存')
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/me/profile'), { timeout: 5000 }).catch(() => null)
      await save.click()
      const sent = await request
      if (!sent) issues.push('保存昵称没有发出请求')
      else {
        if (sent.method() !== 'PATCH') issues.push(`应是 PATCH,实际 ${sent.method()}`)
        if (JSON.stringify(sent.postDataJSON()) !== '{"display_name":"林一"}') issues.push(`请求体不对:${sent.postData()}`)
      }
      await tab.waitForSelector('text=昵称已保存')
      if ((await input.inputValue()) !== '林一') issues.push('保存后输入框应是服务端返回的(去掉空白的)名字')
      if (!(await save.isDisabled())) issues.push('保存后「保存昵称」应再次禁用')
      // 昵称不再常驻侧栏:头像菜单顶部显示名字,保存后应是新昵称
      if (size.width >= 1024) {
        await tab.locator('[data-testid=account-trigger]').click()
        const menu = await tab.locator('[data-testid=account-menu]').innerText()
        if (!menu.includes('林一')) issues.push('头像菜单应显示新昵称')
        await tab.keyboard.press('Escape')
      }
      return issues
    },
  },
  'me-password': {
    // 改密码:前端校验的各种提示;旧密码不对时显示服务端的话;成功后设备列表只剩当前设备
    // 场景里故意让服务端返回 400(假图片、旧密码不对),浏览器会把它打进控制台
    expectConsole: /status of 400/,
    route: '/me',
    ready: '.kb-me-form',
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const form = tab.locator('form.kb-me-form')
      // 「新密码」是「确认新密码」的子串:用精确的文字匹配,免得一个选择器命中两个输入框
      const field = (label) => form.locator('label').filter({ hasText: new RegExp(`^\\s*${label}`) }).locator('input')
      const submit = form.getByRole('button', { name: '修改密码' })
      if (!(await submit.isDisabled())) issues.push('什么都没填时「修改密码」应禁用')
      // 浏览器密码管理器靠隐藏的用户名字段把新密码存到正确的账号
      const hidden = await form.locator('input[autocomplete=username]').inputValue()
      if (hidden !== 'admin') issues.push(`隐藏的用户名字段应是 admin,实际「${hidden}」`)
      const attrs = await tab.evaluate(() => [...document.querySelectorAll('form.kb-me-form input[type=password]')].map((el) => el.getAttribute('autocomplete')))
      if (attrs.join() !== 'current-password,new-password,new-password') issues.push(`密码框的 autocomplete 不对:${attrs}`)
      // 「两次不一致」不该被「还没填当前密码」遮住:当前密码留空时也要当场提示
      await field('新密码').fill('Correct-Horse-9')
      await field('确认新密码').fill('Correct-Horse-8')
      if (!(await form.innerText()).includes('两次输入的新密码不一致')) issues.push('当前密码为空时,两次不一致也应立即提示')
      await field('确认新密码').fill('')
      await field('新密码').fill('')
      await field('当前密码').fill('old-password-1')
      await field('新密码').fill('12345678')
      if (!(await form.innerText()).includes('太常见')) issues.push('弱密码应即时提示')
      await field('确认新密码').fill('12345678')
      if (!(await submit.isDisabled())) issues.push('弱密码不能提交')
      await field('新密码').fill('Correct-Horse-9')
      await field('确认新密码').fill('Correct-Horse-8')
      if (!(await form.innerText()).includes('两次输入的新密码不一致')) issues.push('两次不一致应提示')
      if (!(await submit.isDisabled())) issues.push('两次不一致不能提交')
      await field('确认新密码').fill('Correct-Horse-9')
      if ((await form.locator('.kb-me-strength i.on').count()) < 3) issues.push('强密码应点亮至少 3 格')
      if (await submit.isDisabled()) issues.push('都填对了应可提交')

      // 旧密码不对:显示服务端的话(没有 invalid input 前缀),表单内容保留
      await field('当前密码').fill('wrong-old-password')
      await submit.click()
      await tab.waitForSelector('text=旧密码不正确')
      if ((await tab.evaluate(() => document.body.innerText)).includes('invalid input')) issues.push('不该出现 invalid input: 前缀')
      if ((await field('新密码').inputValue()) !== 'Correct-Horse-9') issues.push('失败后不该清空表单')

      // 正确:发出请求,成功后清空表单并提示其它设备已退出,设备列表只剩当前设备
      await field('当前密码').fill('old-password-1')
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/change-password'), { timeout: 5000 }).catch(() => null)
      await submit.click()
      const sent = await request
      if (!sent) issues.push('没有发出 change-password')
      else if (JSON.stringify(sent.postDataJSON()) !== '{"old_password":"old-password-1","new_password":"Correct-Horse-9"}') issues.push(`请求体不对:${sent.postData()}`)
      await tab.waitForSelector('text=其它设备上的登录已退出')
      if ((await field('新密码').inputValue()) !== '') issues.push('成功后应清空表单')
      await tab.waitForTimeout(400)
      if ((await tab.locator('.kb-me-devices li').count()) !== 1) issues.push(`改密码后设备列表应只剩当前设备,实际 ${await tab.locator('.kb-me-devices li').count()}`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'me-devices': {
    // 登录设备:当前设备有标记;不识别的设备显示「未知设备」;退出一台要确认;退出其它所有;退出当前设备回登录页
    route: '/me',
    ready: '.kb-me-devices',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const rows = () => tab.locator('.kb-me-devices li').count()
      if ((await rows()) !== 3) issues.push(`应有 3 台设备,实际 ${await rows()}`)
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['Chrome · macOS', 'Safari · iPhone', '未知设备', '当前设备', '203.0.113.7', '退出其它 2 台']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (/<script|Mozilla\/5\.0/.test(text)) issues.push('不该显示 User-Agent 原文')
      if ((await tab.locator('.kb-me-devices .tag', { hasText: '当前设备' }).count()) !== 1) issues.push('恰好一台应标成当前设备')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      const confirmDanger = async () => {
        await tab.waitForSelector('[role=alertdialog]')
        await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
      }
      // 退出手机那台
      const one = tab.waitForRequest((req) => /\/api\/v1\/me\/sessions\/2b3c4d5e6f708192$/.test(req.url()) && req.method() === 'DELETE', { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-me-devices li', { hasText: 'Safari · iPhone' }).getByRole('button', { name: '退出' }).click()
      await confirmDanger()
      if (!(await one)) issues.push('没有对手机那台发出 DELETE')
      await tab.waitForFunction(() => document.querySelectorAll('.kb-me-devices li').length === 2)
      // 只看设备列表本身:整页文字里还可能有正在淡出的确认弹窗(标题里写着这台设备的名字)
      if ((await tab.locator('.kb-me-devices').innerText()).includes('Safari · iPhone')) issues.push('退出后这台应从列表消失')
      // 退出其它所有
      const others = tab.waitForRequest((req) => req.url().includes('/api/v1/me/sessions/revoke-others') && req.method() === 'POST', { timeout: 5000 }).catch(() => null)
      await tab.getByRole('button', { name: /退出其它 1 台/ }).click()
      await confirmDanger()
      if (!(await others)) issues.push('没有发出 revoke-others')
      await tab.waitForFunction(() => document.querySelectorAll('.kb-me-devices li').length === 1)
      if (await tab.getByRole('button', { name: /退出其它/ }).count()) issues.push('只剩当前设备时不该再有「退出其它」')
      // 退出当前设备:确认文案提醒,确认后回登录页
      await tab.locator('.kb-me-devices li').getByRole('button', { name: '退出' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      if (!(await tab.locator('[role=alertdialog]').innerText()).includes('正在用的设备')) issues.push('退出当前设备的确认应提醒这是正在用的设备')
      await confirmDanger()
      await tab.waitForURL(/\/login/, { timeout: 5000 }).catch(() => issues.push('退出当前设备后应回到登录页'))
      return issues
    },
  },
  forgot: {
    // 找回密码:提示话术固定(不透露邮箱是否注册),重置成功后让用户回登录
    route: '/forgot',
    ready: '#fg-email',
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('#fg-email').fill('user@example.com')
      await tab.locator('.auth-inline .kb-btn').click()
      await tab.waitForSelector('text=如果这个邮箱已注册,验证码已发送')
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('验证码已发送到 user@example.com')) issues.push('找回密码的提示不该点名邮箱已发送(会暗示它注册过)')
      await tab.locator('#fg-code').fill('123456')
      await tab.locator('#fg-pass').fill('12345678')
      if (!(await tab.locator('.auth-submit').isDisabled())) issues.push('弱密码不能提交')
      await tab.locator('#fg-pass').fill('A-brand-new-pass')
      const request = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/password/reset'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.auth-submit').click()
      const sent = await request
      if (!sent) issues.push('点重置没有发出请求')
      else if (JSON.parse(sent.postData() ?? '{}').new_password !== 'A-brand-new-pass') issues.push('重置请求体不对')
      await tab.waitForSelector('text=密码已重置')
      if (!(await tab.evaluate(() => document.body.innerText)).includes('其它设备上的登录已全部退出')) issues.push('应说明其它设备会退出')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
  'forgot-no-mail': {
    // 管理员没配邮件:不假装能找回,直接说联系管理员
    route: '/forgot',
    ready: '.auth-box',
    sizes: ['390x844'],
    fixture: { __status: { mail_ready: false } },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (!text.includes('请联系管理员为你重设密码')) issues.push('应提示联系管理员')
      if (await tab.locator('#fg-email').count()) issues.push('邮件没配好时不该显示表单')
      return issues
    },
  },
  invites: {
    // 邀请码管理:列表(状态/用量/有效期/角色)、使用记录、撤销要确认、生成后明文只在弹窗里出现一次
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    sizes: ['390x844', '820x1180', '1440x900'],
    prepare: async (tab) => {
      await tab.getByRole('tab', { name: '邀请码' }).click()
      await tab.waitForSelector('.kb-inv-list')
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const rows = await tab.locator('.kb-inv-list > li').count()
      if (rows !== 4) issues.push(`应有 4 个邀请码,实际 ${rows}`)
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['KB-7H2K', '内测第一批', '可用', '已用完', '已撤销', '31 / 50 次', '不过期', '天后过期']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (/KB-[A-Z0-9]{4}-[A-Z0-9]{4}/.test(text)) issues.push('列表里不该有完整邀请码明文')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 使用记录
      await tab.locator('.kb-inv-list > li', { hasText: '读书会' }).getByRole('button', { name: '使用记录' }).click()
      await tab.waitForSelector('.kb-inv-uses li b')
      if (!(await tab.locator('.kb-inv-uses').innerText()).includes('alice')) issues.push('使用记录里应有 alice')
      // 撤销要确认
      const revoke = tab.waitForRequest((req) => req.url().includes('/capabilities/invite_revoke'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-inv-list > li', { hasText: '内测第一批' }).getByRole('button', { name: '撤销' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
      const revoked = await revoke
      if (!revoked) issues.push('确认撤销后没有发出 invite_revoke')
      else if (JSON.parse(revoked.postData() ?? '{}').id !== 'inv_1') issues.push('撤销了错误的邀请码')
      // 生成:可选项 → 请求体 → 明文弹窗
      await tab.getByRole('button', { name: '生成邀请码' }).click()
      await tab.waitForSelector('.kb-ut-form')
      await tab.locator('.kb-ut-form label', { hasText: '备注' }).locator('input').fill('读书会二期')
      await tab.locator('.kb-ut-form label', { hasText: '一次生成几个' }).locator('input').fill('2')
      await tab.locator('.kb-ut-form label', { hasText: '存储配额' }).locator('input').fill('5')
      await tab.locator('.kb-ut-form label', { hasText: '有效期' }).locator('select').selectOption('30')
      const create = tab.waitForRequest((req) => req.url().includes('/capabilities/invite_create'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-ut-actions .kb-btn.is-primary').click()
      const sent = await create
      if (!sent) issues.push('生成没有发出 invite_create')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        const want = { max_uses: 1, count: 2, note: '读书会二期', expires_days: 30, quota: { storage_gb: 5 } }
        if (JSON.stringify(body) !== JSON.stringify(want)) issues.push(`生成请求体不对:${JSON.stringify(body)}`)
      }
      await tab.waitForSelector('.kb-inv-codes')
      if ((await tab.locator('.kb-inv-codes code').count()) !== 2) issues.push('应显示 2 个新邀请码明文')
      if (!(await tab.evaluate(() => document.body.innerText)).includes('关闭后不再显示明文')) issues.push('应提醒明文只显示一次')
      await tab.getByRole('button', { name: '我已保存' }).click()
      if (await tab.locator('.kb-inv-codes').count()) issues.push('关闭后明文弹窗应消失')
      return issues
    },
  },
  'mail-settings': {
    // 邮件设置:预设套用、授权码只写不读(保存后输入框清空、请求带 confirm)、测试发信结果、发信记录
    route: '/admin/params',
    ready: '.kb-mail',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['主账号', '备用账号', '最近发信', '已配置', '注册验证码', '找回密码验证码']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      const primary = tab.locator('.kb-mail-slot[aria-label="主账号"]')
      const backup = tab.locator('.kb-mail-slot[aria-label="备用账号"]')
      // 已设置授权码:占位提示「已设置」,输入框是空的
      const pw = primary.locator('input[type=password]')
      if ((await pw.inputValue()) !== '') issues.push('授权码输入框永远应是空的')
      if (!((await pw.getAttribute('placeholder')) ?? '').includes('已设置')) issues.push('已设置授权码时占位应提示「已设置」')
      // 备用账号没配:测试按钮禁用
      if (!(await backup.getByRole('button', { name: '发送测试邮件' }).isDisabled())) issues.push('没配好的备用账号不能测试')
      // 选预设:服务器/端口随预设变化,并随「保存账号设置」提交
      await primary.locator('.kb-select > .btn').click()
      await tab.getByRole('option', { name: '163 邮箱' }).click()
      if (!(await primary.innerText()).includes('smtp.163.com:465')) issues.push('选 163 后应显示 smtp.163.com:465')
      await primary.locator('label', { hasText: '登录名' }).locator('input').fill('hello@163.com')
      const save = tab.waitForRequest((req) => req.url().includes('/capabilities/update_config'), { timeout: 5000 }).catch(() => null)
      await primary.getByRole('button', { name: '保存账号设置' }).click()
      const saved = await save
      if (!saved) issues.push('保存账号没有发出 update_config')
      else {
        const body = JSON.parse(saved.postData() ?? '{}')
        const want = { mail: { primary: { preset: '163', host: 'smtp.163.com', port: 465, security: 'tls', username: 'hello@163.com' } } }
        if (JSON.stringify(body.patch) !== JSON.stringify(want)) issues.push(`账号补丁不对:${JSON.stringify(body.patch)}`)
        if (body.confirm !== true) issues.push('update_config 缺 confirm')
      }
      // 授权码:保存后输入框清空,请求带 confirm
      await pw.fill('my-auth-code')
      const pwRequest = tab.waitForRequest((req) => req.url().includes('/capabilities/mail_password'), { timeout: 5000 }).catch(() => null)
      await primary.getByRole('button', { name: '保存授权码' }).click()
      const pwSent = await pwRequest
      if (!pwSent) issues.push('保存授权码没有发出 mail_password')
      else {
        const body = JSON.parse(pwSent.postData() ?? '{}')
        if (body.slot !== 'primary' || body.password !== 'my-auth-code' || body.confirm !== true) issues.push(`授权码请求不对:${JSON.stringify({ ...body, password: '***' })}`)
      }
      await tab.waitForTimeout(300)
      if ((await pw.inputValue()) !== '') issues.push('保存授权码后输入框应清空')
      // 测试发信
      await primary.getByRole('button', { name: '发送测试邮件' }).click()
      await tab.waitForSelector('.kb-mail-ok')
      if (!(await primary.locator('.kb-mail-ok').innerText()).includes('测试邮件已发到')) issues.push('测试成功应提示已发到哪里')
      // 发信记录:失败行带原因
      const failed = tab.locator('.kb-mail-log li', { hasText: 'alice@163.com' })
      if (!(await failed.innerText()).includes('535')) issues.push('失败的发信记录应显示原因')
      return issues
    },
  },
  // 统一外壳:侧栏三态、顶栏、标签栏、抽屉等,见 e2e/shell-scenarios.mjs
  ...SHELL_SCENARIOS,
  // 组件包(响应式表格 / 批量条 / 表单字段 / 弹层 / 标签页),宿主是 /dev/kit,见 e2e/kit-scenarios.mjs
  ...KIT_SCENARIOS,
  // 多设备基础(安全区 / 软键盘 / 触屏可点区域 / 悬停之外的入口 / 横屏低高度 / :has 兜底),见 e2e/device-scenarios.mjs
  ...DEVICE_SCENARIOS,
  // PWA(manifest / 图标 / 主题色 / service worker / 独立窗口),见 e2e/pwa-scenarios.mjs
  ...PWA_SCENARIOS,
  // F1 账号安全(登录两步验证 / 个人设置的两步验证与令牌 / 管理员重置),见 e2e/security-scenarios.mjs
  ...SECURITY_SCENARIOS,
  // 好友与通知:好友页的列表 / 添加 / 四种状态 / 导航入口,见 e2e/friends-scenarios.mjs
  ...FRIENDS_SCENARIOS,
  // 通知抽屉:分类筛选 / 点击跳转 / 已读 / 实时 / 加载更多 / 四种状态,见 e2e/notifications-scenarios.mjs
  ...NOTIFICATION_SCENARIOS,
  // F3 分享与协作(分享面板 / 入口 / 共享给我 / 公开页),见 e2e/share-scenarios.mjs
  ...SHARE_SCENARIOS,
  // 管理端:存储与用量、AI 额度排行、分享治理、系统参数补齐、用户管理补充、系统概览指标、我的用量,见 e2e/admin-scenarios.mjs
  ...ADMIN_SCENARIOS,
  // 多人在线编辑:同步状态 / 断线重连 / 权限收回 / 文档换代 / 只读降级 / 握手被拒,假房间见 e2e/collab-room.mjs
  ...COLLAB_SCENARIOS,
  // 首页(个人工作台):最近编辑 / 共享动态 / 待处理 / 用量,正常、空、部分报错、AI 关闭、没有功能
  ...HOME_SCENARIOS,
  // 搜索:简单模式默认、高级选项折叠(手机底部弹层)、共享范围与来源、点结果去哪、报错重试
  ...SEARCH_SCENARIOS,
  // 任务:手机任务卡、筛选与新任务在屏内、点卡看日志(底部弹层)、审计 / 批次、报错重试
  ...TASKS_SCENARIOS,
  // 审核收件箱:卡片层次、驳回收进「⋯」、多选批量、折叠、只读状态、报错重试
  ...REVIEW_SCENARIOS,
  // 错误与状态页:404、服务不可用(自动重试后回原页面)、快捷键表、新用户引导
  ...STATUS_SCENARIOS,
  // 导入(数据源 + 队列合并):拖入区 / 粘贴网址 / 指标 / 导入记录与数据来源页签;服务器目录与 Git 在管理组
  ...IMPORT_SCENARIOS,
  // AI 助手:独立页面与抽屉同一组件、全屏打开、排队提示、工作目录满了、AI 关闭
  ...ASSISTANT_SCENARIOS,
  // 管理组三页整理:评测、系统状态、项目与集合的 正常 / 空 / 报错重试 / 无权限 / 手机卡片 / 浅色 / AI 关闭
  ...ADMIN_PAGES_SCENARIOS,
  // 手机上的编辑器:输入法组字不误触发、工具栏贴键盘、斜杠菜单与 [[ 选择器的底部面板,见 e2e/editor-mobile-scenarios.mjs
  ...EDITOR_MOBILE_SCENARIOS,
  // 知识库页的平板版面:两栏(600–839,目录栏自动收起)/ 三栏(840–1279)/ 旋转不丢内容,见 e2e/tablet-scenarios.mjs
  ...TABLET_SCENARIOS,
  // 上传选「拍照 / 相册 / 文件」:手机底部弹层、三个 input 的属性、选完进入上传流程;电脑 / 平板保持原样,见 e2e/upload-scenarios.mjs
  ...UPLOAD_SCENARIOS,
  // 微信 / QQ 内置浏览器:下载提示(分享页、知识库页)、登录、分享页安全区与键盘,用换 UA 模拟,见 e2e/inapp-scenarios.mjs
  ...INAPP_SCENARIOS,
  // 系统设置:十个分区的无溢出、改值保存与校验、需要重启、四种状态、AI 关闭、旧链接,以及各分区自己的关键交互
  ...SETTINGS_SCENARIOS,
  // 编辑器「上传图片」的来源面板:手机出 拍照 / 从相册选,触屏平板和电脑直接选文件,见 e2e/camera-scenarios.mjs
  ...CAMERA_SCENARIOS,
  ...AXE_SCENARIOS,
  // 补充:首页、好友页的键盘(Enter 提交、Esc 关闭后焦点回到按钮、Tab 每个停靠点都看得出焦点)
  ...KEYS_EXTRA_SCENARIOS,
  ...DENSITY_SCENARIOS,
  // 目录树:点击分工(原地展开 / 去看文档)、箭头可点区域、别的集合的箭头、方向键,见 e2e/tree-scenarios.mjs
  ...TREE_SCENARIOS,
  // 控件(开关关闭态、输入框)在五个主题下的真实渲染对比度 ≥ 3:1,见 e2e/controls-scenarios.mjs
  ...CONTROLS_SCENARIOS,
  // 多人编辑的头像:有照片的显示照片、没有的首字母、游客固定头像,没头像的人不产生 404,见 e2e/avatar-scenarios.mjs
  ...AVATAR_SCENARIOS,
  // 筛选条 / 页签条 / 搜索条滚动时钉在滚动区顶部,不跟着内容滚走,见 e2e/sticky-scenarios.mjs
  ...STICKY_SCENARIOS,
  // 组件间距:手机卡片内边距 16、列表行不多占、不叠 margin,见 e2e/spacing-scenarios.mjs
  ...SPACING_SCENARIOS,
  // 使用指南 /guide:目录与正文、截图、下载链接、锚点、两个入口、AI 关闭,见 e2e/guide-scenarios.mjs
  ...GUIDE_SCENARIOS,
  // 图表(环形图 / 折线图 / 横向条):无溢出、渲染出来的颜色对比度、键盘逐期查看、回落标记、空状态,见 e2e/charts-scenarios.mjs
  ...CHARTS_SCENARIOS,
  ...ADMIN_FLOW_SCENARIOS,
  // flow 组逐页检查的横切场景:AI 关闭无「AI」字样、触屏 44px、键盘、浅色、批次详情 / 文件时间线,见 e2e/flow-scenarios.mjs
  ...FLOW_SCENARIOS,
  // 逐页检查(首页 / 知识库 / 搜索)补的场景:读取状态、操作失败、触屏、文案、AI 关闭、浅色、键盘,见 e2e/core-scenarios.mjs
  ...CORE_SCENARIOS,
  // 账号与分享页面组的补充场景:触屏 44px / AI 关闭 / 出错重试 / 浅色 / 键盘,见 e2e/account-scenarios.mjs
  ...ACCOUNT_SCENARIOS,
}


const only = process.argv.slice(2)
const names = only.length ? only : Object.keys(SCENARIOS)
const unknown = names.filter((name) => !SCENARIOS[name])
if (unknown.length) {
  console.error(`未知场景:${unknown.join(', ')}(可用:${Object.keys(SCENARIOS).join(', ')})`)
  process.exit(2)
}

await mkdir(OUT, { recursive: true })
// KB_BASE=https://… 时直接打线上站点(API 仍由 fixture 拦截),验证部署后的包在真实 CDN / CSP 下能跑
const local = process.env.KB_BASE ? null : await startStaticServer('http://127.0.0.1:1')
const base = process.env.KB_BASE ?? local.base
const server = local?.server ?? { close() {} }
const rows = []
let failed = false

for (const engine of ENGINE_NAMES) {
const browser = await launch(engine)
for (const name of names) {
  const scenario = SCENARIOS[name]
  for (const size of SIZES.filter((item) => !scenario.sizes || scenario.sizes.includes(item.name))) {
    const context = await browser.newContext(
      contextOptions(size, engine, {
        reducedMotion: 'reduce',
        timezoneId: 'Asia/Shanghai',
        locale: 'zh-CN',
        // 默认不让页面注册 service worker:它会缓存资源、影响别的场景的确定性;只有 PWA 场景显式打开
        serviceWorkers: (typeof scenario.serviceWorkers === 'function' ? scenario.serviceWorkers(engine) : scenario.serviceWorkers) ?? 'block',
      }),
    )
    await installFixture(context, scenario.fixture)
    // 场景需要在页面脚本之前就生效的东西(覆盖 matchMedia、假的 visualViewport 等)
    if (scenario.init) await context.addInitScript(scenario.init)
    const tab = await context.newPage()
    await tab.clock.install({ time: NOW })
    const errors = []
    tab.on('pageerror', (error) => {
      if (/sandboxed|The operation is insecure/.test(error.message)) return // 沙箱 iframe 里 fixture 的 init script 读 localStorage 被拒:隔离生效的证据
      // 同下面 console 里的那一条:WebKit 把这个无害通知当成页面错误(pageerror)上报而不是打进控制台。只放行这一条原话,别的 pageerror 照常算错误
      if (/^ResizeObserver loop completed with undelivered notifications\.?$/.test(error.message.trim())) return
      errors.push(error.message)
    })
    tab.on('console', (message) => {
      const text = message.text()
      // 沙箱 iframe 里被拦的脚本 / localStorage(fixture 的 init script 会注入每个 frame)恰恰说明隔离生效,不算错误
      if (/sandboxed|about:srcdoc|The operation is insecure/.test(text)) return
      // Cloudflare 在线上页面注入的统计脚本被站点 CSP 拦截:与本项目无关
      if (/cloudflareinsights/.test(text)) return
      // 浏览器自己的无害告警:ResizeObserver 的回调里又改了布局,通知留到下一帧补发。规范里不算错误,WebKit 会把它打进控制台,
      // 每次出现的场景和尺寸都不固定;只放行这一条原话,别的 ResizeObserver 报错照常算错误
      if (/^ResizeObserver loop completed with undelivered notifications\.?$/.test(text.trim())) return
      // 场景自己模拟出来的失败(例如 429),浏览器会把它打进控制台;只放行场景声明过的这一类
      if (scenario.expectConsole && scenario.expectConsole.test(text)) return
      if (/Content Security Policy|Refused to/i.test(text)) errors.push(`CSP 违规:${text.slice(0, 160)}`)
      // 静态测试服务器没有 WebSocket 服务(页面连实时通道会失败,这是预期的)。Chromium / WebKit 的文案里带 WebSocket,
      // Firefox 的文案是「Firefox can't establish a connection to the server at ws://…/api/v1/ws」(协作通道是 /api/v1/collab/ws),没有这个词,要单独认
      else if (message.type() === 'error' && !text.includes('WebSocket') && !/establish a connection to the server at wss?:\/\/\S+\/api\/v1\/(collab\/)?ws/.test(text)) errors.push(text.slice(0, 200))
    })
    const issues = []
    try {
      await tab.goto(`${base}${scenario.route}`, { waitUntil: 'networkidle' })
      if (scenario.ready) await tab.waitForSelector(scenario.ready, { timeout: 20_000 })
      if (scenario.prepare) await scenario.prepare(tab, size)
      await tab.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
      await tab.waitForTimeout(scenario.settle ?? 400)
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      if (scenario.assert) issues.push(...(await scenario.assert(tab, size)))
    } catch (error) {
      issues.push(`异常:${String(error.message).split('\n')[0]}`)
    }
    if (errors.length) issues.push(`控制台错误:${errors.slice(0, 2).join(' | ')}`)
    await tab.screenshot({ path: join(OUT, `${name}-${size.name}${engineSuffix(engine)}.png`) })
    await context.close()
    rows.push({ name, size: size.name, issues })
    if (issues.length) failed = true
    console.log(`${issues.length ? '✗' : '✓'} ${name} ${size.name}${engine === 'chromium' ? '' : ` [${engine}]`}${issues.length ? `\n    - ${issues.join('\n    - ')}` : ''}`)
  }
}
await browser.close()
}

server.close()
console.log(`\n截图:${OUT}`)
process.exit(failed ? 1 : 0)
