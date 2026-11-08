// 笔记新文本面的功能场景：旧编辑器有、新文本面原来没有的功能，在真实浏览器里走一遍用户路径。
// 由 editor-native.mjs 的 --surface=text 引入。每个场景都从用户动作出发（点、输入、粘贴、快捷键），
// 断言页面上看得见的结果和最终落盘的正文（edit_item 的 body），不碰内部状态。
//
// 用一篇“什么都有”的样本笔记（ins_rich）：提示块、任务、表格、代码块、流程图、公式、双链、坏链接、附件、相对路径图片。
import { COLLECTION } from './editor-helpers.mjs'
import { axeIssues } from './axe-helpers.mjs'
import { ALL_FEATURES, adminMe, fileItem } from './fixture.mjs'

export const RICH_ID = 'ins_rich'
const RICH_COLLECTION = 'proj_knowledgebase'

export const RICH_BODY = [
  '# 富文本样本',
  '',
  '> [!NOTE]',
  '> 这是一个说明',
  '',
  '## 任务',
  '',
  '- [ ] 买菜',
  '- [x] 做饭',
  '',
  '## 表格',
  '',
  '| 甲 | 乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '## 代码',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '行内公式 $a^2$ 在这里。',
  '',
  '## 链接',
  '',
  '见 [[ins_9c01|另一篇]]，还有 [缺失文件](./missing.md) 和 [本地](C:\\Users\\me\\a.md)。',
  '',
  '![架构](./img/arch.png)',
  '',
  '[📎 合同.pdf](./files/合同.pdf "2 KB")',
  '',
].join('\n')

/** 样本笔记的夹具：get_item 只认 ins_rich；体检把 missing.md 报成“不在”；文件选择器给两个候选 */
export const RICH_FIXTURE = {
  get_item: (payload) => {
    // 样本笔记之外的 id（比如双链跳过去的那篇）也给一个最小的笔记，页面才能真的打开它
    const id = payload?.id ?? RICH_ID
    const rich = id === RICH_ID
    return {
      item: {
        id,
        collection: RICH_COLLECTION,
        kind: 'insight',
        insight_kind: null,
        confidence: null,
        lang: null,
        source: `insight:${id}`,
        start_line: null,
        end_line: null,
        symbol: null,
        title: rich ? '富文本样本' : '另一篇',
        status: 'active',
        tags: [],
        updated_at: new Date().toISOString(),
        version: 1,
        text: rich ? RICH_BODY : '# 另一篇\n\n被双链打开的笔记。\n',
        header: rich ? '富文本样本' : '另一篇',
        origin: null,
        embedded_at: null,
      },
      context: null,
    }
  },
  check_links: (payload) => ({
    items: (payload?.targets ?? []).map((target) =>
      target.note_id
        ? { kind: 'note', note_id: target.note_id, state: 'ok' }
        : { kind: 'file', collection: target.collection, path: target.path, state: target.path === 'missing.md' ? 'missing' : 'ok' },
    ),
  }),
  list_files: (payload) => ({
    items: [
      { collection: payload?.collection ?? RICH_COLLECTION, path: 'img/a.png', name: 'a.png', size: 10 },
      { collection: payload?.collection ?? RICH_COLLECTION, path: 'docs/说明.pdf', name: '说明.pdf', size: 2048 },
    ],
  }),
}

export async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 打开样本笔记并进入编辑态（默认路径，不带 editor 参数：量用户真实打开的那条路） */
export async function openRich(tab, base, extra = '') {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${RICH_ID}${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-dp', { timeout: 20_000 })
  const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
  await edit.waitFor({ state: 'visible', timeout: 20_000 })
  await edit.click()
  await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose h1', { timeout: 20_000 })
}

/** 等到落盘的正文满足条件，返回最后一次保存的正文 */
async function savedBody(state, predicate) {
  const ok = await waitFor(() => state.saved.some((entry) => predicate(String(entry?.body ?? ''))))
  return ok ? String([...state.saved].reverse().find((entry) => predicate(String(entry?.body ?? '')))?.body ?? '') : null
}

/** 点进编辑器、光标放到文末 */
async function caretToEnd(tab) {
  await tab.focus('.kb-text-prose')
  await tab.keyboard.press('Control+End')
  // 浏览器移动了光标，ProseMirror 要等 selectionchange 才同步；紧接着按键会落到旧位置（文档开头）
  await tab.waitForTimeout(150)
}

/** 展开工具栏「更多插入」下拉（放不下时它在「更多」菜单里，下拉会被平铺成子项） */
async function openInsertMenu(tab) {
  if (await tab.locator('[data-testid="editor-toolbar-slot"] [data-action="insertMore"]').count()) {
    await tab.click('[data-testid="editor-toolbar-slot"] [data-action="insertMore"]')
    return
  }
  await tab.click('[data-testid="editor-toolbar-more"]')
}
const insertItem = (tab, id) => tab.locator(`[role="menu"] [data-action="${id}"]`).first()

/* ---------------- 选区批注 / 管理员只读巡检 ----------------
 * 批注挂在 Markdown 文件上（笔记没有选区批注）：阅读态选中正文 → 「评论」浮钮 → 右侧评论栏 → 发表 / 回复 / 解决，
 * 正文里的摘录高亮跟着评论走。旧编辑器的浮钮要求编辑器有焦点，只读视图不可聚焦，所以在真实浏览器里从来没出现过；
 * 这里的场景走的是用户真实的路径（真实选字、点浮钮），不是调内部方法。 */
const MD_FILE = 'file_md'
/** 假后端里的批注：每个场景重建（getter 在场景开始时才求值） */
let annotations = null
const SEED_FOUND = { id: 'an_seed1', body: '结尾要补一句总结', author: 'usr_alice', parent_id: null, resolved_at: null, anchor: { kind: 'quote', text: '结尾段落。', prefix: '', suffix: '' }, created_at: 1_792_000_000_000 }
const SEED_LOST = { id: 'an_seed2', body: '这句话已经被改没了', author: 'usr_alice', parent_id: null, resolved_at: null, anchor: { kind: 'quote', text: '早就删掉的那句话', prefix: '', suffix: '' }, created_at: 1_792_000_100_000 }

function annotationFixture(seed = []) {
  annotations = { items: seed.map((item) => ({ ...item })), posted: [], resolved: [], deleted: [], next: 1, listed: 0 }
  const state = annotations
  return {
    list_annotations: () => {
      state.listed += 1
      return { annotations: state.items.map((item) => ({ ...item })), authors: {} }
    },
    add_annotation: (payload) => {
      state.posted.push(payload)
      const id = `an_new${state.next++}`
      state.items.push({ id, body: payload.body, author: 'usr_admin', parent_id: payload.parent_id ?? null, resolved_at: null, anchor: payload.anchor ?? null, created_at: 1_792_000_200_000 + state.next })
      return { id }
    },
    resolve_annotation: (payload) => {
      state.resolved.push(payload)
      const item = state.items.find((entry) => entry.id === payload.id)
      if (item) item.resolved_at = payload.resolved ? 1_792_000_300_000 : null
      return {}
    },
    delete_annotation: (payload) => {
      state.deleted.push(payload)
      state.items = state.items.filter((entry) => entry.id !== payload.id)
      return {}
    },
  }
}

/** 打开 Markdown 文件的阅读页；阅读态（可评论）就在新外壳里，等正文出来 */
async function openMarkdown(tab, base) {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${MD_FILE}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose', { timeout: 20_000 })
}

/** 真实选字：三击选中一个段落，等浮钮出现 */
async function selectParagraph(tab, text) {
  await tab.locator('.kb-text-prose p', { hasText: text }).first().click({ clickCount: 3 })
}

/** 同一条批注的高亮会被行内代码 / 加粗等标记切成几段 span：取全部拼起来 */
const quoteText = (scope, id) => scope.locator(`.kb-text-prose .kb-quote[data-quote-id="${id}"]`).evaluateAll((els) => els.map((el) => el.textContent).join(''))

/** 页面实际下载的 js，用来证明批注 / 巡检没有再把旧编辑器拖进来 */
function watchScripts(tab) {
  const urls = []
  tab.on('request', (request) => {
    if (/\.js(?:\?|$)/.test(request.url())) urls.push(request.url())
  })
  return urls
}
const OLD_EDITOR_CHUNK = /(DocEditor|milkdown|crepe)/i

export const TEXT_FEATURE_SCENARIOS = {
  'rich-render': {
    title: '样本笔记渲染：提示块、任务、表格、代码块、流程图、公式、双链、坏链接、附件卡片、相对路径图片都画出来',
    fixture: RICH_FIXTURE,
    async assert(tab, base) {
      await openRich(tab, base)
      // 流程图 / 公式是按需加载的，等它们真的渲染出来
      await tab.waitForSelector('.kb-code-preview .kb-mermaid svg', { timeout: 20_000 }).catch(() => undefined)
      await tab.waitForSelector('.kb-code-preview .katex', { timeout: 20_000 }).catch(() => undefined)
      await tab.waitForSelector('.kb-link-missing', { timeout: 10_000 }).catch(() => undefined)
      const info = await tab.evaluate(() => {
        const q = (selector) => document.querySelector(`.kb-text-prose ${selector}`)
        const img = q('img:not(.ProseMirror-separator)')
        return {
          callout: q('blockquote.kb-callout.is-note')?.getAttribute('data-label') ?? '',
          boxes: document.querySelectorAll('.kb-text-prose li[data-checked] > input[type="checkbox"]').length,
          checked: [...document.querySelectorAll('.kb-text-prose input[type="checkbox"]')].map((el) => el.checked),
          table: !!q('table'),
          codeLang: q('.kb-code-lang')?.value ?? '',
          mermaid: !!q('.kb-code-preview .kb-mermaid svg'),
          mermaidError: q('.kb-mermaid.is-error')?.textContent ?? '',
          mathBlock: !!q('.kb-code-preview .katex'),
          mathInline: !!q('.kb-text-math .katex'),
          wikilink: q('.kb-wikilink')?.getAttribute('data-id') ?? '',
          missing: !!q('.kb-link-missing'),
          invalid: !!q('.kb-link-invalid'),
          attach: q('.kb-attach')?.className ?? '',
          imgSrc: img?.getAttribute('src') ?? '',
          overflow: document.documentElement.scrollWidth - innerWidth,
        }
      })
      const issues = []
      if (info.callout !== '说明') issues.push(`提示块没画出来：${info.callout}`)
      if (info.boxes !== 2 || info.checked.join() !== 'false,true') issues.push(`任务项复选框不对：${info.boxes} ${info.checked}`)
      if (!info.table) issues.push('表格没画出来')
      if (info.codeLang !== 'js') issues.push(`代码块语言框不对：${info.codeLang}`)
      if (!info.mermaid) issues.push(`流程图没渲染成 SVG：${info.mermaidError}`)
      if (!info.mathBlock) issues.push('公式块没渲染（KaTeX）')
      if (!info.mathInline) issues.push('行内公式没渲染（KaTeX）')
      if (info.wikilink !== 'ins_9c01') issues.push(`双链没画出来：${info.wikilink}`)
      if (!info.missing) issues.push('链接体检：缺失文件没有虚线')
      if (!info.invalid) issues.push('原电脑路径没有标成不可用')
      if (!/is-pdf/.test(info.attach)) issues.push(`附件卡片不对：${info.attach}`)
      // 笔记没有文件路径，相对地址无从解析（旧编辑器同样原样）；相对路径图片的显示在 Markdown 文件场景里验证（md-file-relative-image）
      if (!info.imgSrc) issues.push('图片节点没有画出来')
      if (info.overflow > 1) issues.push(`整页横向溢出 ${info.overflow}px`)
      return issues
    },
  },

  'rich-task-toggle': {
    title: '点任务项复选框：界面勾选、Ctrl+S 后落盘的正文里是 [x]；再点取消',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const boxes = tab.locator('.kb-text-prose li[data-checked] > input[type="checkbox"]')
      await boxes.nth(0).click()
      await tab.waitForFunction(() => document.querySelector('.kb-text-prose input[type="checkbox"]')?.checked === true, null, { timeout: 3000 })
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => text.includes('- [x] 买菜'))
      const issues = body === null ? ['保存的正文里没有 - [x] 买菜'] : []
      // 再点一次取消
      await boxes.nth(0).click()
      await tab.waitForFunction(() => document.querySelector('.kb-text-prose input[type="checkbox"]')?.checked === false, null, { timeout: 3000 }).catch(() => issues.push('再点复选框没有取消勾选'))
      return issues
    },
  },

  'rich-table-ops': {
    title: '表格：光标进表格，工具栏下面出现表格工具条，加一行、加一列、Tab 跳格，保存的 Markdown 表格行列数对',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      await tab.click('.kb-text-prose td')
      await tab.waitForSelector('[data-testid="editor-table-tools"]', { timeout: 3000 })
      await tab.click('[data-testid="editor-table-tools"] [data-action="row-below"]')
      await tab.click('[data-testid="editor-table-tools"] [data-action="col-right"]')
      const issues = []
      const shape = await tab.evaluate(() => {
        const rows = [...document.querySelectorAll('.kb-text-prose table tr')]
        return { rows: rows.length, cols: rows[0]?.children.length ?? 0 }
      })
      if (shape.rows !== 3 || shape.cols !== 3) issues.push(`加一行一列后应是 3×3，实际 ${shape.rows}×${shape.cols}`)
      // Tab 跳到下一格并输入
      await tab.keyboard.type('X')
      await tab.keyboard.press('Tab')
      await tab.keyboard.type('Y')
      await tab.keyboard.press('Control+s')
      // 光标在第一列：“右侧插入列”插在 甲 和 乙 之间，表头变成 3 列；新行里 Tab 跳格输入的 X、Y 要落盘
      const body = await savedBody(state, (text) => /\| 甲 \|\s*\|\s*乙 \|/.test(text) && /\| X \| Y \|/.test(text))
      if (body === null) {
        const saved = state.saved.at(-1)?.body ?? ''
        issues.push(`保存的表格不对（应是 3 列表头 + 新行里有 X、Y）：${saved.slice(saved.indexOf('|'), saved.indexOf('|') + 100)}`)
      }
      return issues
    },
  },

  'rich-code-block': {
    title: '代码块：改语言框写回围栏；复制按钮把代码放进剪贴板；公式块点“编辑源码”露出源码',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      const lang = tab.locator('.kb-code-block').first().locator('.kb-code-lang')
      await lang.fill('typescript')
      await lang.press('Enter')
      await tab.keyboard.press('Control+s')
      if ((await savedBody(state, (text) => text.includes('```typescript\nconst a = 1'))) === null) issues.push('改语言后保存的围栏不是 ```typescript')
      // 复制
      await tab.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined)
      await tab.locator('.kb-code-block').first().locator('.kb-code-copy').click()
      await tab.waitForFunction(() => document.querySelector('.kb-code-copy')?.textContent === '已复制', null, { timeout: 3000 }).catch(() => issues.push('点复制没有出现“已复制”'))
      // 公式块默认只显示渲染结果；点“编辑源码”露出源码
      const math = tab.locator('.kb-code-block.is-previewing', { has: tab.locator('.katex') }).first()
      await math.locator('.kb-code-toggle').click()
      const shown = await tab.evaluate(() => [...document.querySelectorAll('.kb-code-block')].some((el) => el.dataset.language === 'LaTeX' && !el.classList.contains('is-previewing') && el.querySelector('pre')?.hidden === false))
      if (!shown) issues.push('公式块点“编辑源码”后没有露出源码')
      return issues
    },
  },

  'rich-color': {
    title: '字色 / 底色：选中文字点色板里的红色，保存的正文里是 <span style="color: …">；没选中文字点色块有提示',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await tab.click('[data-action="color"]')
      await tab.click('[data-testid="editor-color-fg-red"]')
      await tab.waitForSelector('[data-testid="text-notice"]', { timeout: 3000 }).catch(() => issues.push('没选中文字点色块，没有提示“先选中要上色的文字”'))
      // 三击选中第一个小节标题
      await tab.locator('.kb-text-prose h2').first().click({ clickCount: 3 })
      await tab.click('[data-action="color"]')
      await tab.click('[data-testid="editor-color-fg-red"]')
      await tab.waitForSelector('.kb-text-prose h2 .kb-color.is-fg-red', { timeout: 3000 }).catch(() => issues.push('选中标题点红色后没有出现红字'))
      await tab.click('[data-action="color"]').catch(() => undefined)
      await tab.keyboard.press('Control+s')
      if ((await savedBody(state, (text) => /## <span style="color: #e5484d">任务<\/span>/.test(text))) === null) issues.push('保存的正文里没有 <span style="color: #e5484d">')
      return issues
    },
  },

  'rich-insert-menu': {
    title: '插入下拉：提示块、流程图、公式各插一个，界面出现且流程图渲染成 SVG，保存的 Markdown 对',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await caretToEnd(tab)
      await openInsertMenu(tab)
      await insertItem(tab, 'callout.tip').click()
      await tab.waitForSelector('.kb-text-prose blockquote.kb-callout.is-tip', { timeout: 3000 }).catch(() => issues.push('插入提示块 · 提示 后没有 .is-tip'))
      await caretToEnd(tab)
      await openInsertMenu(tab)
      await insertItem(tab, 'diagram').click()
      await tab.waitForFunction(() => document.querySelectorAll('.kb-code-preview .kb-mermaid svg').length >= 2, null, { timeout: 20_000 }).catch(() => issues.push('新插入的流程图没有渲染成 SVG'))
      await caretToEnd(tab)
      await openInsertMenu(tab)
      await insertItem(tab, 'math').click()
      await tab.waitForFunction(() => document.querySelectorAll('.kb-code-preview .katex').length >= 2, null, { timeout: 20_000 }).catch(() => issues.push('新插入的公式没有渲染'))
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => text.includes('> [!TIP]') && text.split('```mermaid').length === 3 && text.split('$$\nE = mc^2').length === 3)
      if (body === null) issues.push('保存的正文里缺少 > [!TIP] / 第二个 mermaid / 第二个 $$ 公式')
      return issues
    },
  },

  'rich-slash': {
    title: '斜杠菜单：输入 / 能看到图片、附件、引用笔记、流程图、标题 4–6；输入 /警告 过滤出警告提示块，回车插入',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await caretToEnd(tab)
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('/')
      await tab.waitForSelector('[data-testid="editor-slash-menu"]', { timeout: 3000 })
      const all = await tab.evaluate(() => [...document.querySelectorAll('[data-testid="editor-slash-menu"] .kb-slash-label')].map((el) => el.textContent))
      for (const want of ['图片', '附件', '引用笔记', '引用文件 / 模板', '流程图 / 时序图', '公式', '四级标题', '五级标题', '六级标题']) {
        if (!all.includes(want)) issues.push(`斜杠菜单缺少「${want}」：${all.join(',')}`)
      }
      // 斜杠菜单的查询词是 / 后面连续的非空白字符（正文里的 /路径 不该弹菜单），所以一个词：警告
      await tab.keyboard.type('警告')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('.kb-text-prose blockquote.kb-callout.is-caution', { timeout: 3000 }).catch(() => issues.push('/警告 回车后没有插入警告提示块'))
      await tab.keyboard.press('Control+s')
      if ((await savedBody(state, (text) => text.includes('> [!CAUTION]'))) === null) issues.push('保存的正文里没有 > [!CAUTION]')
      return issues
    },
  },

  'rich-wikilink-picker': {
    title: '引用笔记：输入 [[ 弹出选择器，搜到的笔记点一下，正文变成 [[id|标题]] 并画成双链',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await caretToEnd(tab)
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('参见 [[')
      await tab.waitForSelector('[data-testid="note-picker-item"]', { timeout: 5000 })
      const focused = await tab.evaluate(() => document.activeElement?.classList.contains('kb-text-picker-input'))
      if (!focused) issues.push('选择器的搜索框没有拿到焦点')
      const title = (await tab.locator('[data-testid="note-picker-item"] .kb-text-picker-title').first().innerText()).trim()
      await tab.locator('[data-testid="note-picker-item"]').first().click()
      await tab.waitForSelector('[data-testid="note-picker"]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('选中后选择器没有收起'))
      const focusBack = await tab.evaluate(() => !!document.activeElement?.closest('.kb-text-prose'))
      if (!focusBack) issues.push('选中后焦点没有回到正文')
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => /参见 \[\[ins_[^|\]]+\|[^\]]+\]\]/.test(text))
      if (body === null) issues.push(`保存的正文里没有 [[id|标题]]（选了「${title}」）`)
      else if (!body.includes(title.slice(0, 4))) issues.push(`双链标题不是所选的「${title}」`)
      return issues
    },
  },

  'rich-file-picker': {
    title: '引用文件：插入下拉里选“引用文件 / 模板”，勾选两个后一次插入，保存的正文里有图片与附件卡片',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await caretToEnd(tab)
      await openInsertMenu(tab)
      await insertItem(tab, 'filelink').click()
      await tab.waitForSelector('[data-testid="file-picker-item"]', { timeout: 5000 })
      const checks = tab.locator('[data-testid="file-picker-item"] .kb-text-picker-check')
      await checks.nth(0).click()
      await checks.nth(1).click()
      await tab.click('[data-testid="file-picker-insert"]')
      await tab.waitForSelector('[data-testid="file-picker"]', { state: 'detached', timeout: 3000 })
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => text.includes('![a](') && text.includes('[📎 说明.pdf]('))
      if (body === null) issues.push('保存的正文里没有 ![a]( 和 [📎 说明.pdf](')
      return issues
    },
  },

  'rich-paste-upload': {
    title: '粘贴图片 / 拖入附件：走上传，正文写地址（不是 base64 / blob:），出现图片与附件卡片，保存落盘',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await caretToEnd(tab)
      await tab.evaluate(() => {
        const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], '截图.png', { type: 'image/png' })
        const data = new DataTransfer()
        data.items.add(png)
        document.querySelector('.kb-text-prose').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await tab.waitForFunction(() => [...document.querySelectorAll('.kb-text-prose img:not(.ProseMirror-separator)')].some((img) => img.getAttribute('alt') === '截图'), null, { timeout: 15_000 }).catch(() => issues.push('粘贴图片后正文里没有出现图片'))
      await tab.evaluate(() => {
        const pdf = new File([new Uint8Array(2048)], '合同2.pdf', { type: 'application/pdf' })
        const data = new DataTransfer()
        data.items.add(pdf)
        document.querySelector('.kb-text-prose').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
      })
      await tab.waitForFunction(() => document.querySelectorAll('.kb-attach').length >= 2, null, { timeout: 15_000 }).catch(() => issues.push('拖入附件后没有出现附件卡片'))
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => /!\[截图\]\(kb:\/\/[^)]*_attachments\//.test(text) && text.includes('[📎 合同2.pdf]('))
      if (body === null) issues.push('保存的正文里没有 kb:// 的图片地址或附件卡片')
      else if (/base64|blob:/.test(body)) issues.push('正文里出现了 base64 / blob: 地址')
      return issues
    },
  },

  'rich-link-follow': {
    title: 'Ctrl 点击双链跳到那篇笔记；点指向缺失文件的链接给提示（不去 404）；点原电脑路径说明原因',
    fixture: RICH_FIXTURE,
    async assert(tab, base) {
      await openRich(tab, base)
      const issues = []
      await tab.waitForSelector('.kb-link-missing', { timeout: 10_000 })
      // 缺失文件：Ctrl 点击 → 提示
      await tab.locator('.kb-text-prose a', { hasText: '缺失文件' }).click({ modifiers: ['Control'] })
      const toast = await tab.waitForFunction(() => /不在知识库里/.test(document.body.textContent ?? ''), null, { timeout: 3000 }).then(() => true).catch(() => false)
      if (!toast) issues.push('点缺失文件的链接没有提示“不在知识库里”')
      await tab.locator('.kb-text-prose a', { hasText: '本地' }).click({ modifiers: ['Control'] })
      const reason = await tab.waitForFunction(() => /电脑|绝对路径|知识库/.test(document.body.textContent ?? '') , null, { timeout: 3000 }).then(() => true).catch(() => false)
      if (!reason) issues.push('点原电脑路径没有说明原因')
      // 双链：Ctrl 点击 → 地址栏切到那篇笔记
      await tab.locator('.kb-text-prose .kb-wikilink').click({ modifiers: ['Control'] })
      const moved = await waitFor(() => tab.url().includes('ins_9c01'))
      if (!moved) issues.push(`Ctrl 点击双链没有跳到 ins_9c01：${tab.url()}`)
      return issues
    },
  },

  'rich-source-mode': {
    title: '源码模式：工具栏“源码”切到 Markdown 文本框，改源码切回后文档按新源码重建并可保存；看一眼不改不算改动',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      await tab.click('[data-action="source"]')
      const area = tab.locator('[data-testid="text-source"]')
      await area.waitFor({ timeout: 3000 })
      if (!(await area.inputValue()).includes('# 富文本样本')) issues.push('源码文本框里没有当前正文')
      // 格式按钮收起，只剩源码开关
      if (await tab.locator('[data-action="bold"]').count()) issues.push('源码模式下格式按钮应收起')
      await area.fill('# 改过的源码\n\n- 一\n- 二\n')
      await tab.click('[data-action="source"]')
      await tab.waitForSelector('.kb-text-prose h1', { timeout: 3000 })
      const h1 = await tab.locator('.kb-text-prose h1').first().innerText()
      if (h1.trim() !== '改过的源码') issues.push(`切回后标题不对：${h1}`)
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => text.startsWith('# 改过的源码'))
      if (body === null) issues.push('保存的正文不是改后的源码')
      return issues
    },
  },

  'rich-axe': {
    title: 'axe：样本笔记的编辑态（提示块、表格、代码块视图、公式、任务项、附件卡片）+ 打开的下拉 / 色板 / 选择器，深浅两套主题无 critical / serious',
    fixture: RICH_FIXTURE,
    async assert(tab, base) {
      await openRich(tab, base)
      await tab.waitForSelector('.kb-code-preview .katex', { timeout: 20_000 }).catch(() => undefined)
      const issues = (await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 静态编辑态 ${item}`)
      // 打开的各种浮层：插入下拉、标题下拉、色板、引用笔记选择器、表格工具条
      await tab.click('[data-testid="editor-toolbar-slot"] [data-action="insertMore"]')
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 插入下拉 ${item}`))
      await tab.keyboard.press('Escape')
      await tab.click('[data-testid="editor-toolbar-slot"] [data-action="color"]')
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 色板 ${item}`))
      await tab.click('[data-testid="editor-toolbar-slot"] [data-action="color"]').catch(() => undefined)
      // 悬停出现的块手柄也是新增的浮层
      await tab.locator('.kb-text-prose h2').first().hover()
      await tab.waitForSelector('[data-testid="block-handle"]', { timeout: 3000 })
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 块手柄 ${item}`))
      // 点把手打开的块菜单（转换为 / 复制 / 移动 / 删除）
      await tab.click('[data-testid="block-handle"] [data-action="block-grip"]')
      await tab.waitForSelector('[data-testid="block-menu"]', { timeout: 3000 })
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 块菜单 ${item}`))
      await tab.keyboard.press('Escape')
      await tab.click('.kb-text-prose td')
      await tab.waitForSelector('[data-testid="editor-table-tools"]', { timeout: 3000 })
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 表格工具条 ${item}`))
      return issues
    },
  },

  'rich-block-handle': {
    title: '块手柄：悬停出现 ＋ 和拖动把手；拖动「表格」小节标题到「任务」前面，保存的顺序对、Ctrl+Z 能还原；＋ 新起一段并唤出斜杠菜单；Ctrl+Shift+↓ 下移；点把手打开块菜单把段落转成三级标题',
    fixture: RICH_FIXTURE,
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []
      // 1. 悬停第一个二级标题：手柄出现，且在块的左边、在视口里
      const heading = tab.locator('.kb-text-prose h2').first()
      await heading.hover()
      await tab.waitForSelector('[data-testid="block-handle"]', { timeout: 3000 }).catch(() => issues.push('悬停标题后没有出现块手柄'))
      const pos = await tab.evaluate(() => {
        const h = document.querySelector('[data-testid="block-handle"]')?.getBoundingClientRect()
        const b = document.querySelector('.kb-text-prose h2')?.getBoundingClientRect()
        return h && b ? { handleRight: h.right, blockLeft: b.left, top: h.top, blockTop: b.top, bottom: h.bottom, blockBottom: b.bottom } : null
      })
      if (!pos) return [...issues, '量不到手柄位置']
      if (pos.handleRight > pos.blockLeft + 1) issues.push(`手柄应在块的左边：手柄右缘 ${pos.handleRight} > 块左缘 ${pos.blockLeft}`)
      if (pos.top < pos.blockTop - 12 || pos.bottom > pos.blockBottom + 12) issues.push(`手柄应和块的首行对齐：${JSON.stringify(pos)}`)

      // 2. 拖动：把「## 表格」小节标题（第 2 个 h2）拖到「## 任务」标题（第 1 个 h2）上方。
      //    用真实的鼠标移动（按下 → 分步移动 → 松开），和人拖的一样；locator.dragTo 会在拖动中途把目标滚进视野，长文档里坐标就错了
      const headings = tab.locator('.kb-text-prose h2')
      const names = await headings.allInnerTexts()
      await headings.nth(1).hover()
      await tab.waitForSelector('[data-testid="block-handle"] [data-action="block-grip"]', { timeout: 3000 })
      const grip = await tab.locator('[data-testid="block-handle"] [data-action="block-grip"]').boundingBox()
      const target = await headings.first().boundingBox()
      if (!grip || !target) return [...issues, '量不到手柄或目标位置']
      await tab.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await tab.mouse.down()
      await tab.mouse.move(target.x + 30, target.y + 4, { steps: 12 })
      await tab.mouse.up()
      await tab.waitForTimeout(400)
      const after = await headings.allInnerTexts()
      if (after.join('|') !== ['表格', '任务', ...names.slice(2)].join('|')) issues.push(`拖动后「表格」应排到「任务」前面：${after.join(' | ')}`)
      // 被拖的只是标题这一个块：块数不变（不是复制，也没丢内容）
      const total = await tab.evaluate(() => document.querySelectorAll('.kb-text-prose > *').length)
      if (total < 10) issues.push(`拖动后顶层块数量异常：${total}`)
      await tab.keyboard.press('Control+s')
      const saved = await savedBody(state, (text) => text.indexOf('## 表格') >= 0 && text.indexOf('## 表格') < text.indexOf('## 任务'))
      if (saved === null) issues.push('保存的正文里「## 表格」没有排在「## 任务」前面')
      // 撤销一次回到原来的顺序（拖动是一次标准编辑）
      await tab.keyboard.press('Control+z')
      await tab.waitForTimeout(200)
      if ((await headings.allInnerTexts()).join('|') !== names.join('|')) issues.push('Ctrl+Z 之后顺序没有还原')

      // 3. ＋：在悬停的块下面新起一段并唤出斜杠菜单
      await tab.locator('.kb-text-prose h2').nth(1).hover()
      await tab.waitForSelector('[data-testid="block-handle"] [data-action="block-add"]', { timeout: 3000 })
      await tab.click('[data-testid="block-handle"] [data-action="block-add"]')
      await tab.waitForSelector('[data-testid="editor-slash-menu"]', { timeout: 3000 }).catch(() => issues.push('点 ＋ 之后没有唤出斜杠菜单'))
      await tab.keyboard.press('Escape')

      // 4. 键盘：Ctrl+Shift+↓ 把当前块下移一位
      await tab.locator('.kb-text-prose h2').first().click()
      await tab.waitForTimeout(150)
      const before = await tab.locator('.kb-text-prose h2').allInnerTexts()
      await tab.keyboard.press('Control+Shift+ArrowDown')
      await tab.waitForTimeout(150)
      const moved = await tab.evaluate(() => [...document.querySelectorAll('.kb-text-prose > *')].map((el) => el.tagName + ':' + (el.textContent ?? '').slice(0, 3)))
      const headIndex = (list, name) => list.findIndex((item) => item.startsWith('H2:') && item.includes(name))
      if (headIndex(moved, before[0].slice(0, 2)) < 0) issues.push('Ctrl+Shift+↓ 之后找不到被移动的标题')

      // 5. 点 ⠿ 打开块菜单：把第一个段落转换成三级标题；菜单是点出来的（不跟着光标飘），执行后收起、焦点回到正文
      const paragraph = tab.locator('.kb-text-prose > p').first()
      const text = ((await paragraph.innerText()) ?? '').trim()
      await paragraph.hover()
      await tab.waitForSelector('[data-testid="block-handle"] [data-action="block-grip"]', { timeout: 3000 })
      await tab.click('[data-testid="block-handle"] [data-action="block-grip"]')
      const menu = await tab.waitForSelector('[data-testid="block-menu"]', { timeout: 3000 }).then(() => true, () => false)
      if (!menu) return [...issues, '点拖动把手后没有出现块菜单']
      const current = await tab.getAttribute('[data-testid="block-menu"] [data-action="convert-paragraph"]', 'aria-checked')
      if (current !== 'true') issues.push(`块菜单里「正文」应是当前类型（打勾）：${current}`)
      await tab.click('[data-testid="block-menu"] [data-action="convert-heading3"]')
      if (await tab.locator('[data-testid="block-menu"]').count()) issues.push('执行转换后块菜单应收起')
      const converted = await tab.evaluate((wanted) => [...document.querySelectorAll('.kb-text-prose > h3')].some((el) => el.textContent?.trim() === wanted), text)
      if (!converted) issues.push(`块菜单「三级标题」没有把「${text.slice(0, 12)}」变成 h3`)
      await tab.keyboard.press('Control+s')
      if ((await savedBody(state, (body) => body.includes(`### ${text.split('\n')[0]}`))) === null) issues.push('保存的正文里没有转换出来的「### …」')
      return issues
    },
  },

  'quote-annotate-flow': {
    title: '选区批注：阅读态真实选字 → 「评论」浮钮 → 待评论摘录 → 发表 → 正文出现高亮 → 点高亮定位评论 → 回复 → 标记已解决；正文不变、不加载旧编辑器、无障碍通过',
    get fixture() {
      return annotationFixture()
    },
    async assert(tab, base) {
      const scripts = watchScripts(tab)
      await openMarkdown(tab, base)
      const issues = []
      const info = await tab.evaluate(() => ({
        editable: document.querySelector('.kb-text-prose')?.getAttribute('contenteditable'),
        chrome: !!document.querySelector('[data-testid="editor-chrome"]'),
        status: !!document.querySelector('.kb-editor-status'),
        old: !!document.querySelector('.milkdown, .Crepe'),
        text: document.querySelector('.kb-text-prose')?.textContent ?? '',
      }))
      if (info.editable !== 'false') issues.push(`阅读态正文应是只读（contenteditable=false），实际 ${info.editable}`)
      if (info.chrome || info.status) issues.push('阅读页不该多出工具栏 / 状态栏')
      if (info.old) issues.push('批注阅读不该挂旧编辑器')

      // 1. 真实选字：浮钮出现（旧实现在这一步从来不出现）
      await selectParagraph(tab, '运行')
      await tab.waitForSelector('[data-testid="annotate-selection"]', { state: 'visible', timeout: 5000 }).catch(() => issues.push('选中文字后没有出现「评论」浮钮'))
      const box = await tab.locator('[data-testid="annotate-selection"]').boundingBox()
      if (!box) return [...issues, '量不到「评论」浮钮的位置']
      if (box.x < 0 || box.y < 0 || box.x + box.width > 1440 || box.y + box.height > 900) issues.push(`浮钮跑出了视口：${JSON.stringify(box)}`)
      const around = await tab.evaluate(() => {
        const range = getSelection()?.getRangeAt(0).getBoundingClientRect()
        const button = document.querySelector('[data-testid="annotate-selection"]')?.getBoundingClientRect()
        return range && button ? { gap: button.top - range.bottom, overlap: button.top < range.bottom - 1 } : null
      })
      if (!around || around.overlap || around.gap > 40) issues.push(`浮钮应紧挨在选区下方：${JSON.stringify(around)}`)
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe 阅读态+浮钮 ${item}`))

      // 2. 点浮钮 → 右侧评论栏出现“针对这段话”
      await tab.click('[data-testid="annotate-selection"]')
      await tab.waitForSelector('[data-testid="pending-quote"]', { timeout: 5000 }).catch(() => issues.push('点「评论」后评论栏没有出现待评论摘录'))
      const pending = (await tab.textContent('[data-testid="pending-quote"]').catch(() => '')) ?? ''
      if (!pending.includes('运行 npm ci。')) issues.push(`待评论摘录不对：${pending.trim()}`)

      // 3. 发表：落库的是后端的 Quote 锚点（摘录 + 前后文）
      await tab.fill('[data-testid="comment-input"]', '这里要写清楚版本')
      await tab.click('[data-testid="comment-send"]')
      await waitFor(() => annotations.posted.length === 1)
      const posted = annotations.posted[0]
      if (!posted) return [...issues, '没有发出 add_annotation']
      if (posted.source !== 'README.md') issues.push(`评论的 source 不对：${posted.source}`)
      if (posted.anchor?.kind !== 'quote' || posted.anchor.text !== '运行 npm ci。') issues.push(`锚点不对：${JSON.stringify(posted.anchor)}`)
      if (!String(posted.anchor?.prefix).includes('安装') || !String(posted.anchor?.suffix).includes('使用')) issues.push(`前后文不对：${JSON.stringify(posted.anchor)}`)

      // 4. 评论列表刷新后，正文里这段话有高亮
      const mark = tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_new1"]').first()
      await mark.waitFor({ state: 'visible', timeout: 8000 }).catch(() => issues.push('发表后正文里没有出现这段话的高亮'))
      if ((await quoteText(tab, 'an_new1')) !== '运行 npm ci。') issues.push(`高亮盖住的文字不对：${await quoteText(tab, 'an_new1')}`)
      if (await tab.locator('[data-testid="comment-quote-lost"]').count()) issues.push('刚发表的评论不该标“原文已改动”')

      // 5. 点高亮 → 评论栏聚焦到那条评论
      await mark.click()
      await tab.waitForSelector('[data-testid="comment-thread"].is-target', { timeout: 3000 }).catch(() => issues.push('点高亮后评论栏没有聚焦到那条评论'))
      await tab.waitForSelector('.kb-text-prose .kb-quote.is-active', { timeout: 3000 }).catch(() => issues.push('点高亮后高亮没有加重'))

      // 6. 回复
      const thread = tab.locator('[data-testid="comment-thread"]', { hasText: '这里要写清楚版本' })
      await thread.locator('[data-testid="reply-open"]').click()
      await tab.fill('[data-testid="reply-input"]', '已经补了')
      await tab.click('[data-testid="reply-send"]')
      await waitFor(() => annotations.posted.length === 2)
      if (annotations.posted[1]?.parent_id !== 'an_new1') issues.push(`回复应挂在第一条评论下：${JSON.stringify(annotations.posted[1])}`)

      // 7. 标记已解决 → 高亮淡成“已解决”样式（评论栏重新取了列表）
      await thread.locator('[data-testid="thread-resolve"]').click()
      await waitFor(() => annotations.resolved.length === 1)
      await tab.waitForSelector('.kb-text-prose .kb-quote.is-resolved', { timeout: 5000 }).catch(() => issues.push('标成已解决后正文里的高亮没有变成“已解决”样式'))

      // 8. 全程不改正文：没有编辑、没有旧编辑器资源
      const after = await tab.evaluate(() => document.querySelector('.kb-text-prose')?.textContent ?? '')
      if (after !== info.text) issues.push('评论不该改动正文')
      const old = scripts.filter((url) => OLD_EDITOR_CHUNK.test(url))
      if (old.length) issues.push(`批注阅读加载了旧编辑器资源：${old.map((url) => url.split('/').pop()).join(', ')}`)
      return issues
    },
  },

  'quote-existing-lost-and-edit': {
    title: '已有批注：高亮画在原位，原文已被改没的评论标“原文已改动”；进编辑态高亮跟着正文走（前面插字不丢、改到摘录里才消失、Ctrl+Z 找回）；编辑态选字不出现评论入口',
    get fixture() {
      return annotationFixture([SEED_FOUND, SEED_LOST])
    },
    async assert(tab, base) {
      await openMarkdown(tab, base)
      const issues = []
      await tab.waitForSelector('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]', { timeout: 10_000 }).catch(() => issues.push('已有批注的摘录没有高亮'))
      if (await tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed2"]').count()) issues.push('原文已经没有的摘录不该有高亮')

      // 点高亮 → 评论栏打开；找不到原文的那条标“原文已改动”，找得到的可以点着定位
      await tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]').click()
      await tab.waitForSelector('[data-testid="doc-comments"]', { timeout: 5000 })
      await tab.waitForSelector('[data-testid="comment-quote-lost"]', { timeout: 5000 }).catch(() => issues.push('原文已被改没的评论没有标“原文已改动”'))
      if ((await tab.locator('[data-testid="comment-quote-lost"]').count()) !== 1) issues.push('只有一条评论该标“原文已改动”')
      await tab.locator('[data-testid="comment"]', { hasText: '结尾要补一句总结' }).locator('button[data-testid="comment-quote"]').click()
      await tab.waitForSelector('.kb-text-prose .kb-quote.is-active[data-quote-id="an_seed1"]', { timeout: 3000 }).catch(() => issues.push('点评论里的引用，正文高亮没有加重'))

      // 进编辑态：高亮还在；评论栏的“原文已改动”仍只有一条
      await tab.getByRole('button', { name: /^编辑$/ }).first().click()
      await tab.waitForSelector('.kb-text-prose[contenteditable="true"]', { timeout: 15_000 })
      await tab.waitForSelector('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]', { timeout: 5000 }).catch(() => issues.push('进编辑态后批注高亮丢了'))
      // 编辑态下不出现评论入口（批注只在阅读态新建）
      await tab.locator('.kb-text-prose p', { hasText: '运行' }).first().click({ clickCount: 3 })
      await tab.waitForTimeout(400)
      if (await tab.locator('[data-testid="annotate-selection"]:visible').count()) issues.push('编辑态选中文字不该出现评论入口')

      // 前面插字：高亮跟着摘录走，不算“原文已改动”
      await tab.focus('.kb-text-prose')
      await tab.keyboard.press('Control+Home')
      await tab.waitForTimeout(150)
      await tab.keyboard.type('新增的开头')
      await tab.waitForTimeout(300)
      const kept = await tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]').textContent().catch(() => null)
      if (kept !== '结尾段落。') issues.push(`前面插字后高亮应还在原话上：${kept}`)
      if ((await tab.locator('[data-testid="comment-quote-lost"]').count()) !== 1) issues.push('前面插字不该让评论变成“原文已改动”')

      // 改到摘录里面：高亮消失，评论栏标“原文已改动”（评论不丢）
      await tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]').click()
      await tab.keyboard.press('ArrowRight')
      await tab.keyboard.type('Z')
      await tab.waitForTimeout(300)
      if (await tab.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]').count()) issues.push('摘录里被改动后高亮该消失')
      await tab.waitForFunction(() => document.querySelectorAll('[data-testid="comment-quote-lost"]').length === 2, null, { timeout: 5000 }).catch(() => issues.push('摘录被改后评论栏该标“原文已改动”'))
      if (!(await tab.locator('[data-testid="comment"]', { hasText: '结尾要补一句总结' }).count())) issues.push('评论本身不该丢')

      // 撤销：高亮回来（装饰随文档走，不进撤销栈）
      await tab.keyboard.press('Control+z')
      await tab.waitForSelector('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]', { timeout: 5000 }).catch(() => issues.push('Ctrl+Z 之后高亮没有回来'))
      return issues
    },
  },

  'quote-two-windows': {
    title: '另一个窗口：窗口 A 发表批注后，窗口 B 打开同一份文件就看到高亮和评论（批注存在服务端，不进协同房间；已打开的窗口不实时推送，与旧实现一致）',
    get fixture() {
      return annotationFixture()
    },
    async assert(tab, base) {
      await openMarkdown(tab, base)
      const issues = []
      await selectParagraph(tab, '运行')
      await tab.waitForSelector('[data-testid="annotate-selection"]', { state: 'visible', timeout: 5000 })
      await tab.click('[data-testid="annotate-selection"]')
      await tab.fill('[data-testid="comment-input"]', '给另一个窗口看的')
      await tab.click('[data-testid="comment-send"]')
      await waitFor(() => annotations.posted.length === 1)

      const other = await tab.context().newPage()
      await openMarkdown(other, base)
      await other.waitForSelector('.kb-text-prose .kb-quote[data-quote-id="an_new1"]', { timeout: 10_000 }).catch(() => issues.push('另一个窗口打开后没有看到这条批注的高亮'))
      await other.locator('.kb-text-prose .kb-quote[data-quote-id="an_new1"]').first().click().catch(() => undefined)
      await other.waitForSelector('[data-testid="comment"]', { timeout: 5000 }).catch(() => issues.push('另一个窗口的评论栏没有这条评论'))
      if (!((await other.textContent('[data-testid="doc-comments"]').catch(() => '')) ?? '').includes('给另一个窗口看的')) issues.push('另一个窗口的评论内容不对')
      await other.close()
      return issues
    },
  },

  'quote-inspect-readonly': {
    title: '管理员只读巡检：从用户页打开别人的知识库里的 Markdown 文件 → 带批注的正文走新外壳只读打开：能看高亮、能选中文字，但没有评论入口、没有编辑 / 保存，请求都带 X-KB-Admin-View',
    get fixture() {
      return {
        ...annotationFixture([SEED_FOUND, SEED_LOST]),
        __me: { local: false, user: adminMe([...ALL_FEATURES.filter((id) => id !== 'collab.edit'), 'sys.inspect'], true) },
        admin_space_open: () => ({ user_id: 'usr_alice', space_id: 'sp_alice', username: 'alice', display_name: 'Alice', used_bytes: 4096 }),
        list_items: () => ({ items: [fileItem(MD_FILE, 'README.md', [])], total: 1, page: 1, page_size: 12 }),
      }
    },
    async assert(tab, base, state) {
      const views = []
      tab.on('request', (request) => {
        if (/\/capabilities\/list_annotations$/.test(request.url())) views.push(request.headers()['x-kb-admin-view'] ?? '')
      })
      const scripts = watchScripts(tab)
      const issues = []
      await tab.goto(`${base}/admin/users`, { waitUntil: 'domcontentloaded' })
      await tab.getByRole('tab', { name: '用户' }).click({ timeout: 20_000 })
      await tab.waitForSelector('[data-testid="user-inspect-usr_alice"]', { timeout: 20_000 })
      await tab.click('[data-testid="user-inspect-usr_alice"]')
      const dialog = tab.locator('.kb-inspect-dialog')
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByText('README.md').first().click({ timeout: 15_000 })
      await dialog.locator('[data-testid="editor-host"] .kb-text-prose').waitFor({ state: 'visible', timeout: 20_000 })

      const readInfo = () =>
        dialog.evaluate((el) => ({
          editable: el.querySelector('.kb-text-prose')?.getAttribute('contenteditable'),
          edit: [...el.querySelectorAll('button')].some((button) => /^(编辑|保存)$/.test(button.textContent?.trim() ?? '')),
          save: !!el.querySelector('[data-testid="editor-save"]'),
          toolbar: !!el.querySelector('[data-testid="editor-chrome"]'),
          old: !!el.querySelector('.milkdown, .Crepe'),
        }))
      // 机器很忙时，正文在 waitFor 之后、读取之前可能正好被外壳换掉一次（会话随请求重开），读到的是「节点不在」（undefined）。
      // 这时重新等正文出现再读；只重读「节点不在」这一种情况，读到 'true' 照样判失败，断言不放宽
      let info = await readInfo()
      for (let attempt = 0; attempt < 3 && info.editable === undefined; attempt += 1) {
        await dialog.locator('[data-testid="editor-host"] .kb-text-prose').waitFor({ state: 'visible', timeout: 10_000 })
        info = await readInfo()
      }
      if (info.editable !== 'false') issues.push(`巡检的正文应只读，实际 contenteditable=${info.editable}`)
      if (info.edit) issues.push('巡检里不该有「编辑 / 保存」按钮')
      if (info.save || info.toolbar) issues.push('巡检里不该有外壳的保存 / 工具栏')
      if (info.old) issues.push('巡检不该挂旧编辑器')

      // 能看别人的批注高亮
      await dialog.locator('.kb-text-prose .kb-quote[data-quote-id="an_seed1"]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => issues.push('巡检里看不到别人的批注高亮'))
      // 能选中文字（复制、核对），但不出现评论入口
      await dialog.locator('.kb-text-prose p', { hasText: '运行' }).first().click({ clickCount: 3 })
      await tab.waitForTimeout(400)
      const selected = await tab.evaluate(() => String(getSelection()))
      if (!selected.includes('运行')) issues.push(`巡检里应能选中文字，实际选到：${selected}`)
      if (await tab.locator('[data-testid="annotate-selection"]:visible').count()) issues.push('巡检里选中文字不该出现评论入口')
      // Ctrl+S 不会保存任何东西
      await tab.keyboard.press('Control+s')
      await tab.waitForTimeout(300)
      if (state.saved.length) issues.push(`巡检不该保存任何东西：${JSON.stringify(state.saved[0]).slice(0, 80)}`)
      // 评论请求读的是目标用户的库
      if (!views.length || views.some((value) => value !== 'usr_alice')) issues.push(`批注列表请求应带 X-KB-Admin-View: usr_alice，实际 ${JSON.stringify(views)}`)
      if (annotations.posted.length) issues.push('巡检不该发出评论')
      const old = scripts.filter((url) => OLD_EDITOR_CHUNK.test(url))
      if (old.length) issues.push(`巡检加载了旧编辑器资源：${old.map((url) => url.split('/').pop()).join(', ')}`)
      return issues
    },
  },

  // ==================== AI 写作条（UI-3） ====================

  'rich-ai-write': {
    title: 'AI 写作条（UI-3）：通过「插入 → AI 写作…」打开写作条，在输入框填要求点生成，等结果进入 ready 后点「插入」，正文里出现 AI 写入的内容；验证没有结果前不改正文',
    get fixture() {
      // ai_write 能力：收到请求后返回固定的 AI 写作结果，用于断言结果是否写入正文
      return {
        ...RICH_FIXTURE,
        ai_write: (payload) => ({ text: `AI 生成内容：${payload.instruction ?? payload.action ?? '默认'}` }),
      }
    },
    async assert(tab, base, state) {
      await openRich(tab, base)
      const issues = []

      // 1. 「插入」菜单里有 AI 写作入口
      await openInsertMenu(tab)
      const aiWriteBtn = tab.locator('[role="menu"] [data-action="ai.write"]').first()
      const aiWriteVisible = await aiWriteBtn.isVisible().catch(() => false)
      if (!aiWriteVisible) issues.push('「插入」菜单里缺少 data-action="ai.write" 的 AI 写作入口')

      // 2. 点击 AI 写作入口，AI 写作条出现（idle 状态）
      if (aiWriteVisible) await aiWriteBtn.click()
      else await tab.press('Escape').catch(() => undefined)

      const aiBar = tab.locator('[data-testid="editor-ai-bar"]')
      const barAppeared = await aiBar.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
      if (!barAppeared) {
        issues.push('点击「AI 写作…」后 editor-ai-bar 没有出现')
        return issues
      }

      // 3. 初始状态应为 idle（显示快捷动作和输入框）
      const phase = await aiBar.getAttribute('data-phase').catch(() => null)
      if (phase !== 'idle') issues.push(`AI 写作条初始阶段应为 idle，实际为 ${phase}`)

      // 4. 确认「润色」「总结」「翻译」「续写」快捷按钮存在
      for (const label of ['润色', '总结', '翻译', '续写']) {
        const found = await tab.locator(`[data-testid="editor-ai-bar"] button`, { hasText: label }).first().isVisible().catch(() => false)
        if (!found) issues.push(`AI 写作条缺少「${label}」快捷按钮`)
      }

      // 5. 在「写下要求」输入框填写指令，点「生成」
      await tab.fill('[data-testid="editor-ai-input"]', '写一句话总结')
      await tab.click('[data-testid="editor-ai-submit"]')

      // 6. 进入 running 状态（有「停止」按钮）
      const running = await waitFor(async () => {
        const p = await aiBar.getAttribute('data-phase').catch(() => null)
        return p === 'running' || p === 'ready'
      })
      if (!running) issues.push('点生成后 AI 写作条没有进入 running 或 ready 状态')

      // 7. 等待进入 ready 状态（有「插入」按钮）
      const ready = await waitFor(async () => {
        const p = await aiBar.getAttribute('data-phase').catch(() => null)
        return p === 'ready'
      }, 15000)
      if (!ready) issues.push('AI 写作没有进入 ready 状态（结果没回来）')

      // 8. ready 状态下有预览内容
      if (ready) {
        const preview = await tab.locator('[data-testid="editor-ai-preview"]').first().textContent().catch(() => '')
        if (!preview.includes('AI 生成内容')) issues.push(`AI 写作预览内容不对：${preview.slice(0, 100)}`)
      }

      // 9. 点「插入」将结果写入文档光标处（没有选中文字，只有「插入」按钮）
      const insertBtn = tab.locator('[data-testid="editor-ai-insert"]').first()
      const insertVisible = await insertBtn.isVisible().catch(() => false)
      if (!insertVisible) issues.push('ready 状态下没有「插入」按钮')
      else await insertBtn.click()

      // 10. AI 写作条收起
      const barGone = await waitFor(async () => !(await aiBar.isVisible().catch(() => true)))
      if (!barGone) issues.push('点「插入」后 AI 写作条没有收起')

      // 11. 保存并验证正文里有 AI 写入的内容
      await tab.keyboard.press('Control+s')
      const body = await savedBody(state, (text) => text.includes('AI 生成内容'))
      if (body === null) issues.push('保存的正文里没有 AI 写入的内容（期望包含「AI 生成内容」）')

      return issues
    },
  },

  'rich-ai-write-no-feature': {
    title: 'AI 写作条（UI-3）：没有 ai.assistant 能力时，「插入」菜单里不出现 AI 写作入口',
    get fixture() {
      return {
        ...RICH_FIXTURE,
        // 覆盖 __me，关掉 ai.assistant 能力；同时关掉 collab.edit 避免编辑器卡在「正在连接协同」状态
        __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'ai.assistant' && id !== 'collab.edit'), true) },
      }
    },
    async assert(tab, base) {
      await openRich(tab, base)
      const issues = []

      // 打开「插入」下拉
      await openInsertMenu(tab)
      await tab.waitForTimeout(300)

      // 没有 ai.assistant 时，AI 写作入口不应出现
      const aiWriteBtn = tab.locator('[role="menu"] [data-action="ai.write"]').first()
      const hasAiEntry = await aiWriteBtn.isVisible().catch(() => false)
      if (hasAiEntry) issues.push('关掉 ai.assistant 后，「插入」菜单仍有 data-action="ai.write" 入口')

      // AI 写作条不应出现
      const aiBar = tab.locator('[data-testid="editor-ai-bar"]')
      const barVisible = await aiBar.isVisible().catch(() => false)
      if (barVisible) issues.push('关掉 ai.assistant 后，AI 写作条 editor-ai-bar 仍在页面上')

      return issues
    },
  },
}
