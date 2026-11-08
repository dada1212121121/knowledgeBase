// 逐页检查(core 组:首页 /home、知识库 /kb、搜索 /search)补的场景。
// 已有场景覆盖不到的格子在这里补:知识库页的 加载 / 空 / 出错(重试)/ 无权限、操作失败提示、触屏可点区域、文案术语、AI 关闭的深查、浅色、键盘。
// 约定同其它场景文件:assert 返回问题数组(空 = 通过);由 viewer-shots.mjs 引入并展开。
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const LIST = `/kb?collection=${COLLECTION}`
const DOC = `${LIST}&item=ins_8f21`
const FILE_RS = `${LIST}&item=file_rs`

/** 页面没有横向溢出(整页宽度 ≤ 视口) */
const overflowIssues = async (tab) => {
  const over = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  return over > 1 ? [`整页横向溢出 ${over}px`] : []
}

/** 这个浏览器当前是不是触屏输入(pointer: coarse):问浏览器,不按宽度猜 */
const isCoarse = (tab) => tab.evaluate(() => window.matchMedia('(pointer: coarse)').matches)

/** 元素(含 ::before 外扩)的可点区域是否 ≥ 44px;返回不够的描述,够了返回 null */
const tapSize = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    let width = r.width
    let height = r.height
    const before = getComputedStyle(el, '::before')
    if (before.content !== 'none' && before.position === 'absolute') {
      width = Math.max(width, Number.parseFloat(before.width) || 0)
      height = Math.max(height, Number.parseFloat(before.height) || 0)
    }
    return width < 43.5 || height < 43.5 ? `${Math.round(width)}×${Math.round(height)}` : null
  })

/** 站内跳转(不重新加载页面):直接 goto 的话,等页面「网络空闲」时慢请求已经回来,看不到加载中 */
const goInApp = (tab, path) => tab.evaluate((to) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(to), path)

/** 点开「更多操作」菜单(顶栏右侧的 ⋯) */
async function openMore(tab) {
  await tab.locator('[aria-label=更多操作]').first().click()
  await tab.waitForSelector('[role=menu]', { timeout: 3000 })
}

/** 打开右侧的属性面板:更多菜单里有「属性…」就点它;宽屏文件页默认已经展开(菜单里写的是「收起属性面板」),这时只要关掉菜单 */
async function showInspector(tab) {
  const item = tab.getByRole('menuitem', { name: /^属性/ })
  if (await item.count()) await item.click()
  else await tab.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))) // 点菜单外面关菜单
  await tab.waitForTimeout(400)
}

/**
 * 文案巡检:收集当前屏幕上看得见的文字和 title / aria-label / placeholder / alt,找术语表「不要用」的词和英文键名。
 * 用户自己的内容(笔记标题 / 正文 / 搜索结果 / 评论 / 抽取出来的文字)不查——那是数据,不是界面文案;集合名 knowledgeBase/insights 同理(只拦单数的 insight)。
 */
const COPY_FORBIDDEN = /\binsight\b|条目|经验|[Cc]hunks?\b|分块|嵌入|数据源|落库|进化|演进|批注|\bcollection\b|\bstatus\b|\bactive\b|superseded|deprecated|\b(?:decision|pitfall|howto|convention|pattern)\b|\brerank\b|top-?k|\btoken\b|\bnull\b|undefined|\[object/i
// .kb-md-read-body:笔记阅读态的轻量阅读器里的正文,和编辑态的 .ProseMirror 是同一份用户数据
const USER_CONTENT = '.kb-sidebar-item, .kb-dp-title, .kb-doc, .kb-md-read-body, .ProseMirror, .cm-content, .kb-hit, .kb-fm-text, .kb-doc-tag, .tag, .kb-home-t, .kb-home-s, .kb-iv-ocr, .kb-dv-ocr, .kb-pv-text, .textLayer, .kb-dx, .kb-px, .kb-sg, .kb-av-preview, .kb-rd, .kb-cmt, .kb-comment, .kb-hit-snippet, .kb-mn-item'
async function copyIssues(tab, where) {
  const hits = await tab.evaluate(
    ([source, excludeSelector]) => {
      const re = new RegExp(source, 'i')
      const out = new Set()
      const shown = (el) => {
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || node.getAttribute('data-open') === 'false') return false
        }
        return true
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim()
        const el = walker.currentNode.parentElement
        if (!text || !el || !re.test(text) || el.closest('script,style') || el.closest(excludeSelector) || !shown(el)) continue
        out.add(`文字「${text.slice(0, 40)}」`)
      }
      for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
        if (el.closest(excludeSelector) || !shown(el)) continue
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
          const value = el.getAttribute(attr)
          if (value && re.test(value)) out.add(`${attr}「${value.slice(0, 40)}」`)
        }
      }
      return [...out]
    },
    [COPY_FORBIDDEN.source, USER_CONTENT],
  )
  return hits.map((hit) => `${where}:文案不合术语表 ${hit}`)
}

/**
 * 触屏可点区域巡检(检查项 5):当前屏幕上看得见的可点元素,高 / 宽都要 ≥44px。
 * 口径同 device.css:元素本身的框和它 ::before(绝对定位外扩)的并集;复选框 / 单选框本体小,可点区域是外面的 label。
 * 正文里的内联链接(用户内容、HTML 预览)不查——WCAG 也豁免句子里的链接。
 */
const TAP_SELECTOR = 'a[href], button, [role=button], [role=tab], [role=menuitem], [role=switch], input:not([type=hidden]), select, textarea, summary, [tabindex="0"]'
const TAP_SKIP = '.ProseMirror, .kb-doc, .kb-rd-article, .textLayer, .kb-hit-snippet, .kb-dx .kbdocx-wrapper, .kb-pgs .kbdocx-wrapper, .kb-px-mount, .kb-sg-grid, .kb-av-text, .kb-nb-code, .cm-content'
async function tapIssues(tab, where) {
  if (!(await isCoarse(tab))) return []
  const small = await tab.evaluate(
    ([selector, skip]) => {
      const shown = (el) => {
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || node.hasAttribute('inert') || node.getAttribute('data-open') === 'false') return false
        }
        return true
      }
      const out = []
      for (const el of document.querySelectorAll(selector)) {
        const box = el.closest('label')
        // 复选框 / 单选框:可点区域是外面的 label。文本输入框也一样 —— 被 <label> 包着、label 里只有它一个可交互控件时,
        // 点 label 的任何位置浏览器都会把焦点交给它(搜索页手机上 44px 的搜索条里放 36px 的输入框就是这样,实测点输入框上下各 3px 处都能聚焦)
        const alone = box && box.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]').length === 1
        const target = (el.matches('input[type=checkbox], input[type=radio]') && box) || (el.matches('input:not([type=hidden]), select, textarea') && alone && box) || el
        const r = target.getBoundingClientRect()
        if (r.width === 0 || r.height === 0 || !shown(el) || el.closest(skip)) continue
        // 屏幕外的(横向滚动区里还没滚到的)不算
        if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight * 3) continue
        let width = r.width
        let height = r.height
        const before = getComputedStyle(target, '::before')
        if (before.content !== 'none' && before.position === 'absolute') {
          width = Math.max(width, Number.parseFloat(before.width) || 0)
          height = Math.max(height, Number.parseFloat(before.height) || 0)
        }
        if (height < 43.5 || width < 43.5) out.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 14)}[${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}] ${Math.round(width)}×${Math.round(height)}`)
      }
      return out
    },
    [TAP_SELECTOR, TAP_SKIP],
  )
  return small.slice(0, 6).map((item) => `${where}:触屏可点区域不足 44px ${item}`)
}

/** 整页重新加载到另一个地址:知识库页内换 ?item= 不会重新读文档(见 a7-kb-inapp-open),需要「打开另一个文件」时用它 */
const visit = (tab, path) => tab.goto(new URL(path, tab.url()).toString(), { waitUntil: 'networkidle' })

/**
 * 按 Tab 走一遍页面,收集每一站:是什么、焦点有没有看得见的样式。
 * 看得见 = outline 有宽度或 box-shadow 非空(全站的焦点环是 :focus-visible 的 outline / --accent-ring 阴影)。
 * 返回 { stops, issues }:issues 里是「焦点丢了(回到 body)」「焦点卡住(连续两次同一个)」「没有焦点样式」。
 */
async function tabWalk(tab, steps, where) {
  const stops = []
  const issues = []
  for (let i = 0; i < steps; i += 1) {
    await tab.keyboard.press('Tab')
    const stop = await tab.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const style = getComputedStyle(el)
      const ring = (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
      // 有些控件把焦点环画在外层(包住输入框的容器 / 伪元素),看父级一层
      const parent = el.parentElement ? getComputedStyle(el.parentElement) : null
      const parentRing = !!parent && ((parent.outlineStyle !== 'none' && Number.parseFloat(parent.outlineWidth) > 0) || parent.boxShadow !== 'none')
      // 有些控件用伪元素画焦点指示(侧栏拖动条:聚焦时 ::after 是一条 2px 的强调色竖线)。只认「聚焦前后真的变了」的伪元素:
      // 读 ::before / ::after 的 底色 / 描边 / 阴影,把焦点临时移开再读一遍,不一样才算焦点指示(一直画着的装饰不算)
      const pseudoLook = () => ['::before', '::after'].map((pseudo) => {
        const p = getComputedStyle(el, pseudo)
        return [p.content, p.backgroundColor, p.boxShadow, p.outlineStyle, p.outlineWidth, p.borderTopColor].join('|')
      }).join('||')
      let pseudoRing = false
      if (!ring && !parentRing) {
        const focusedLook = pseudoLook()
        el.blur()
        pseudoRing = focusedLook !== pseudoLook()
        el.focus({ preventScroll: true })
      }
      const rect = el.getBoundingClientRect()
      return { name: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}「${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12)}」`, ring: ring || parentRing || pseudoRing, inView: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth }
    })
    if (!stop) {
      // 走到页面末尾焦点会交给浏览器自己的界面,activeElement 回到 body——这是正常的;太早就丢了才是问题(由调用方检查站数)
      break
    }
    if (stops.length && stops.at(-1).name === stop.name && stops.length > 1 && stops.at(-2).name === stop.name) {
      issues.push(`${where}:焦点卡在 ${stop.name} 上出不去`)
      break
    }
    stops.push(stop)
    if (!stop.ring) issues.push(`${where}:${stop.name} 获得焦点时没有看得见的焦点样式`)
    if (!stop.inView) issues.push(`${where}:${stop.name} 获得焦点后没有滚进可见区`)
  }
  return { stops, issues }
}

/** 浅色主题:和 home-light / search-light 同一个办法,在页面脚本之前写进外观偏好 */
const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

/**
 * 浅色主题巡检(检查项 2):
 * - 看得见的文字,字色和实际背景(沿祖先找到第一个不透明背景)的对比度 ≥3(大字标准;正文 7:1 由 lint 的 check-contrast 管 token,这里管「具体页面上有没有人写死了颜色」);
 * - 面积 ≥120×40 的元素不能是接近黑色的背景(写死的深色块),图片 / 画布 / 视频 / iframe 除外(那是内容本身)。
 * 用户内容里自带颜色的(Word / PPT 渲染出来的页面、PDF 画布、图片)不查。
 */
const LIGHT_SKIP = '.kb-dx .kbdocx-wrapper, .kb-pgs .kbdocx-wrapper, .kb-px-mount, canvas, img, video, iframe, svg, .textLayer, .kb-iv, .kb-pv-pages, .pdfViewer'
async function lightIssues(tab, where) {
  const found = await tab.evaluate((skip) => {
    // computed color 在 color-mix / oklch 下不是 rgb(…) 字符串,直接抠数字会读错(0~1 的小数当成 0~255,于是「白色」成了黑色)。
    // 交给 canvas 换算成 RGBA:任何 CSS 颜色写法都能处理
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const parse = (value) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    // 实际背景:沿祖先找第一个不透明的纯色;中途遇到渐变 / 背景图就说不准了,返回 null(调用方跳过)
    const bgOf = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.backgroundImage !== 'none') return null
        const [r, g, b, a] = parse(style.backgroundColor)
        if (a > 0.5) return [r, g, b]
      }
      return [255, 255, 255]
    }
    const shown = (el) => {
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || node.getAttribute('data-open') === 'false') return false
      }
      return true
    }
    const out = { text: new Set(), dark: new Set() }
    const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}`
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const el = node.parentElement
      const label = node.textContent.trim()
      if (!label || !el || el.closest(skip) || el.closest('script,style') || !shown(el) || el.disabled || el.closest('[disabled],[aria-disabled=true]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight * 4) continue
      const color = parse(getComputedStyle(el).color)
      const back = bgOf(el)
      if (!back) continue
      const fg = lum(color)
      const bg = lum(back)
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      if (ratio < 3 && (color[3] ?? 1) > 0.6) out.text.add(`${name(el)}「${label.slice(0, 14)}」${ratio.toFixed(1)}:1`)
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(skip) || !shown(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 120 || r.height < 40 || r.bottom < 0 || r.top > innerHeight * 4) continue
      const [red, green, blue, alpha] = parse(getComputedStyle(el).backgroundColor)
      if (alpha > 0.8 && lum([red, green, blue]) < 0.05) out.dark.add(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`)
    }
    return { text: [...out.text].slice(0, 6), dark: [...out.dark].slice(0, 6) }
  }, LIGHT_SKIP)
  return [...found.text.map((item) => `${where}:浅色下字看不清 ${item}`), ...found.dark.map((item) => `${where}:浅色下有写死的深色块 ${item}`)]
}

/** 能力失败(只失败前 times 次,之后恢复,用来测「点重试」) */
const failing = (name, status, message, times, code) => ({ __capabilityError: { [name]: { status, message, ...(times ? { times } : {}), ...(code ? { code } : {}) } } })

const EMPTY_LIST = { items: [], total: 0, page: 1, page_size: 16 }

/** 按文件列的守卫要看到页面发过的每一次 list_items 请求 */
const listCalls = []
const manualRow = {
  id: 'chunk_first', collection: 'knowledgeBase/insights', kind: 'doc', lang: 'markdown', source: 'docs/使用手册.md',
  start_line: null, end_line: null, symbol: null, title: '使用手册', status: 'active', tags: ['手册'],
  updated_at: Date.UTC(2026, 9, 20, 16, 0, 0), version: null, chunks: 44,
}


/**
 * 办公文档(这里用 .odt)点「编辑」:改的是转出来的 Markdown 副本。
 * existing = true:副本早就在了,直接打开它,不再确认也不重新转换(重新转换会盖掉改过的内容)。
 */
function officeCopyFixture({ existing }) {
  let converted = existing
  const item = (id, source) => ({
    id, collection: 'knowledgeBase/insights', kind: 'doc', insight_kind: null, confidence: null, lang: null, source,
    start_line: null, end_line: null, symbol: null, title: source, status: 'active', tags: [], updated_at: 1_792_000_000_000,
    text: '', header: source, origin: null, embedded_at: 1_792_000_000_000,
  })
  return {
    // 副本是 Markdown 文件,打开后要能直接编辑:协同功能点开着而夹具没有 ws 时编辑器会一直只读(见 0760879e),所以用单人编辑夹具
    ...SOLO_EDIT_FIXTURE,
    list_items: (args) => {
      const hit = args?.path_prefix === '向量检索综述.md' && converted
      return { items: hit ? [item('file_odt_md', '向量检索综述.md')] : [], total: hit ? 1 : 0, page: 1, page_size: Number(args?.page_size ?? 12) }
    },
    get_item: (args) => {
      if (args?.id === 'file_odt' && !existing) converted = false
      return { item: args?.id === 'file_odt_md' ? item('file_odt_md', '向量检索综述.md') : item('file_odt', '向量检索综述.odt'), context: null }
    },
    file_preview: (args) =>
      String(args?.path).endsWith('.md')
        ? { format: 'md', editable: true, extractor: null, read_error: null, blocks: [], chunks: [], content: '# 向量检索综述\n\n副本正文。\n' }
        : { format: 'odt', editable: false, extractor: null, read_error: null, blocks: [], chunks: [] },
    convert_to_markdown: () => {
      converted = true
      return { path: '向量检索综述.md', chunks: 3, images: 2, exported_images: 2, original: '向量检索综述.odt' }
    },
  }
}

export const CORE_SCENARIOS = {
  'a7-kb-edit-office-copy': {
    // docx / odt / xlsx / pdf 这类不能直接改的文件,顶栏有「编辑」:先说清楚会生成什么、丢什么,确认后转成 Markdown 副本,
    // 副本打开后直接进入编辑(不用再找副本、再点一次编辑);原文件不动
    route: `${LIST}&item=file_odt`,
    ready: '[data-testid=edit-as-markdown]',
    fixture: officeCopyFixture({ existing: false }),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const converts = []
      tab.on('request', (req) => req.url().includes('/capabilities/convert_to_markdown') && converts.push(JSON.parse(req.postData() ?? '{}')))
      const button = tab.getByTestId('edit-as-markdown')
      if (!(await button.innerText()).includes('编辑')) issues.push('顶栏按钮应叫「编辑」')
      await button.click()
      const notice = tab.getByText('转成 Markdown 副本再编辑')
      await notice.waitFor({ timeout: 5000 }).catch(() => issues.push('点编辑后应先弹出说明'))
      const body = await tab.locator('body').innerText()
      if (!body.includes('向量检索综述.odt 本身不会被改动')) issues.push('说明里应写明原文件不会被改动')
      if (!body.includes('向量检索综述.md')) issues.push('说明里应写明副本叫什么')
      if (converts.length) issues.push('确认之前不该已经发起转换')
      await tab.getByRole('button', { name: '生成副本并编辑' }).click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 10_000 }).catch(() => issues.push('转换后应自动进入副本的编辑态'))
      if (converts.length !== 1 || converts[0].path !== '向量检索综述.odt') issues.push(`应对原文件发起一次转换,实际:${JSON.stringify(converts)}`)
      const text = await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').innerText().catch(() => '')
      if (!text.includes('副本正文')) issues.push(`编辑器里应是副本的内容,实际:${text}`)
      return issues
    },
  },

  'a7-kb-edit-office-copy-existing': {
    // 副本已经存在:直接打开它进入编辑,不确认、不重新转换(重新转换会盖掉里面改过的内容)
    route: `${LIST}&item=file_odt`,
    ready: '[data-testid=edit-as-markdown]',
    fixture: officeCopyFixture({ existing: true }),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const converts = []
      tab.on('request', (req) => req.url().includes('/capabilities/convert_to_markdown') && converts.push(req.url()))
      await tab.getByTestId('edit-as-markdown').click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 10_000 }).catch(() => issues.push('已有副本时应直接进入它的编辑态'))
      if (converts.length) issues.push('已有副本不该重新转换')
      if (await tab.getByText('转成 Markdown 副本再编辑').count()) issues.push('已有副本不该再弹说明')
      return issues
    },
  },

  'a7-kb-md-relative-images': {
    // 项目里的 .md 用相对路径引用图片(![架构](./img/arch.png)):预览和编辑里都要能显示(解析成集合里的原件地址),
    // 但保存时写回去的仍是作者写的原样,不能把显示用的 /api/v1/raw 地址写进文件;绝对地址、集合外的路径不动
    route: `${LIST}&item=file_md`,
    // 不能写成 `img`:ProseMirror 自己会放隐藏的占位 <img class="ProseMirror-separator">,它排在前面,永远等不到可见
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) img:not(.ProseMirror-separator)',
    fixture: {
      // 笔记 / Markdown 的编辑默认走统一外壳的新文本面,协同开着时要等房间第一次同步才可写;
      // 夹具没有 ws,所以用单人编辑夹具把协同功能点关掉,否则编辑器永远只读(旧编辑器同样,见 0760879e)
      ...SOLO_EDIT_FIXTURE,
      file_preview: () => ({
        format: 'md', editable: true, extractor: null, read_error: null, blocks: [], chunks: [],
        content: '# 手册\n\n## 架构\n\n![架构](./img/arch.png)\n\n![内联](data:image/gif;base64,R0lGODlhAQABAAAAACw=)\n\n![集合外](../up.png)\n\n结尾。\n',
      }),
    },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const real = ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) img:not(.ProseMirror-separator)'
      const srcs = async () => tab.locator(real).evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
      const check = async (label) => {
        const list = await srcs()
        const rel = list.find((src) => src?.includes('arch.png'))
        if (!rel?.startsWith('/api/v1/raw?') || !rel.includes('collection=knowledgeBase%2Finsights') || !rel.includes('path=img%2Farch.png')) issues.push(`${label}:相对图片应解析成原件地址,实际 ${rel}`)
        if (!list.includes('data:image/gif;base64,R0lGODlhAQABAAAAACw=')) issues.push(`${label}:带协议的图片地址不该被改:${list.join(' | ')}`)
        if (!list.includes('../up.png')) issues.push(`${label}:跑到集合外面的相对路径不该被解析:${list.join(' | ')}`)
      }
      await check('预览')
      const loaded = await tab.locator(real).first().evaluate((img) => img.complete && img.naturalWidth > 0)
      if (!loaded) issues.push('预览:相对路径的图片没有加载出来')
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 10_000 })
      await check('编辑')
      await tab.click(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) > p:last-of-type')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 新内容')
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/save_file'), { timeout: 5000 }).catch(() => null)
      await tab.keyboard.press('Control+s')
      const sent = await request
      if (!sent) return [...issues, '保存没有发出']
      const content = String(JSON.parse(sent.postData() ?? '{}').content)
      if (!content.includes('](./img/arch.png)')) issues.push(`保存时应写回作者写的相对路径,实际:${content}`)
      if (content.includes('/api/v1/raw')) issues.push('显示用的原件地址不该被写进文件')
      return issues
    },
  },

  'a7-kb-query-highlight': {
    // 从检索结果点进文档(地址带 hq):整篇文档里命中的词都高亮(CSS Custom Highlight 的 kb-query),
    // 不改 DOM、不进正文;不带 hq 的入口没有高亮;换去别的文档后 hq 被清掉
    route: `${LIST}&item=file_md&hq=${encodeURIComponent('安装 "kb search"')}`,
    ready: '.kb-workspace-content',
    settle: 1200,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => {
        const highlights = globalThis.CSS?.highlights
        if (!highlights) return { supported: false }
        const entry = highlights.get('kb-query')
        return { supported: true, count: entry ? entry.size : 0, texts: entry ? [...entry].map((range) => range.toString()) : [] }
      })
      if (!info.supported) return issues // 浏览器没有 CSS Custom Highlight API(旧版 Firefox):不画也不报错,只确认页面没崩
      if (!info.count) return ['整篇文档里应有高亮的命中词(kb-query 里没有范围)']
      if (!info.texts.some((text) => text.includes('安装'))) issues.push(`应高亮「安装」,实际:${info.texts.join('|')}`)
      // 引号里的短语整句高亮,不拆成 kb / search 两个词
      if (!info.texts.some((text) => text.replace(/\s+/g, '').toLowerCase() === 'kbsearch')) issues.push(`引号里的短语「kb search」应整句高亮,实际:${info.texts.join('|')}`)
      // 高亮不改正文:没有任何 <mark> 或额外节点混进文档
      const marks = await tab.locator('.kb-workspace-content mark').count()
      if (marks) issues.push(`不该往文档里插 <mark>(会进编辑内容):${marks} 个`)
      return issues
    },
  },

  'a7-kb-no-query-no-highlight': {
    // 不是从检索进来的(地址没有 hq):文档里不画任何查询高亮
    route: `${LIST}&item=file_md`,
    ready: '.kb-workspace-content',
    settle: 1000,
    assert: async (tab) => {
      const count = await tab.evaluate(() => globalThis.CSS?.highlights?.get('kb-query')?.size ?? 0)
      return count ? [`没有 hq 时不该有查询高亮,实际 ${count} 处`] : []
    },
  },

  'a7-kb-list-one-row-per-file': {
    // 知识库列表一个文件一行:请求带 group_by_file(浏览的单位是文件,不是向量库里的块),
    // 行上写明这个文件有多少段;用代表块的 id 打开(打开它就是打开整份文件)
    route: LIST,
    ready: '[data-testid^=list-row-]',
    fixture: {
      list_items: (args) => {
        listCalls.push(args)
        return { items: [manualRow], total: 1, page: 1, page_size: 16 }
      },
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (!listCalls.length) issues.push('页面应该请求过 list_items')
      const chunkLevel = listCalls.filter((args) => args.group_by_file !== true)
      if (chunkLevel.length) issues.push(`浏览器的列表和分类计数都应带 group_by_file,漏了 ${chunkLevel.length} 次:${JSON.stringify(chunkLevel[0])}`)
      const rows = await tab.locator('[data-testid^=list-row-]').count()
      if (rows !== 1) issues.push(`一个文件应只有一行,实际 ${rows} 行`)
      const text = await tab.locator('[data-testid=list-row-chunk_first]').innerText()
      if (!text.includes('使用手册')) issues.push(`行上应是文档的总标题「使用手册」:${text}`)
      if (!text.includes('44 段')) issues.push(`行上应写明这个文件有 44 段:${text}`)
      return issues
    },
  },

  'a7-kb-file-never-shown-as-a-fragment': {
    // 整份文件读不到时(太大 / 不是 UTF-8),页面不能拿向量库里的某一个片段冒充整份文档显示——
    // 那样用户以为看到的是全文,其实丢了内容;也不能给「编辑」(保存会把整个文件覆盖成那一小段)
    route: `${LIST}&item=file_md`,
    ready: '[data-testid=kb-doc-loading], .kb-workspace-content',
    fixture: {
      get_item: (args) => ({
        item: {
          id: args?.id ?? 'file_md', collection: 'knowledgeBase/insights', kind: 'doc', insight_kind: null, confidence: null, lang: 'markdown',
          source: 'docs/大文件.md', start_line: 120, end_line: 130, symbol: null, title: '大文件 › 第三章', status: 'active', tags: [],
          updated_at: Date.UTC(2026, 9, 20, 16, 0, 0), text: '只是第三章里的一个片段文字', header: '大文件 › 第三章', origin: null, embedded_at: null,
        },
        context: null,
      }),
      file_preview: () => ({
        format: 'md', editable: false, extractor: null, read_error: null, content: '', blocks: [],
        chunks: [{ id: 'c3', ordinal: 3, anchor: null, start_line: 120, end_line: 130, title: '大文件 › 第三章', text: '只是第三章里的一个片段文字' }],
      }),
    },
    // 读不到全文时原文查看器会去取原件字节来嗅探;夹具里这份原件不存在,/api/v1/download 回 404(预期的,页面不该因此报错)
    expectConsole: /status of 404/,
    settle: 800,
    assert: async (tab) => {
      const issues = []
      const main = await tab.locator('.kb-workspace-content').innerText()
      // 片段文字可以出现在「内容片段」列表里,但不能出现在文档正文(DocPage)里
      const asDocument = await tab.locator('.kb-doc, [data-testid=doc-page], .kb-md').filter({ hasText: '只是第三章里的一个片段文字' }).count()
      if (asDocument) issues.push('片段被当成整份文档渲染了')
      if (await tab.getByRole('button', { name: '编辑', exact: true }).count()) issues.push('读不到全文时不该给「编辑」')
      if (!main.trim()) issues.push('读不到全文时也应有明确的显示(原文查看器),而不是一片空白')
      return issues
    },
  },

  'a7-kb-list-error': {
    // 列表读取失败:不能伪装成「没有内容」(以前侧栏显示「暂无匹配条目」,计数 0,错误被吞掉);说清原因并给重试,重试后列表回来
    route: LIST,
    ready: '[data-testid=kb-list-error]',
    fixture: failing('list_items', 500, 'internal: boom', 1),
    expectConsole: /status of 500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=kb-list-error]')
      const text = await box.innerText()
      if (!text.includes('没能读取列表')) issues.push(`应写明没能读取列表,实际:${text}`)
      if (!text.includes('重试')) issues.push('读取失败应给「重试」')
      if (/internal|boom|500/.test(text)) issues.push(`不该露出英文异常 / 状态码:${text}`)
      if (await tab.locator('[data-testid=kb-list-empty]').count()) issues.push('读取失败时不该同时显示「没有内容」')
      if (await isCoarse(tab)) {
        const small = await tapSize(box.getByRole('button', { name: '重试' }))
        if (small) issues.push(`触屏上「重试」可点区域不足 44px:${small}`)
      }
      issues.push(...(await overflowIssues(tab)))
      await box.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('[data-testid^=list-row-]')
      if (await tab.locator('[data-testid=kb-list-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'a7-kb-list-forbidden': {
    // 列表读取被拒(账号没开通):说没开通并让用户去找管理员,不给没有意义的「重试」
    route: LIST,
    ready: '[data-testid=kb-list-error]',
    fixture: failing('list_items', 403, '你的账号没有开通这个功能', 0, 'forbidden'),
    expectConsole: /status of 403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=kb-list-error]')
      const text = await box.innerText()
      if (!text.includes('没有开通这个功能') || !text.includes('管理员')) issues.push(`应说明没开通并让用户联系管理员,实际:${text}`)
      if (await box.getByRole('button', { name: '重试' }).count()) issues.push('没开通功能时重试没有意义,不该给「重试」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7-kb-list-empty': {
    // 真空列表给下一步(新建 / 导入),不是一句「暂无匹配条目」;筛选后为空则给「清除筛选」,点了列表回来
    route: LIST,
    ready: '[data-testid=kb-list-empty]',
    fixture: { list_items: () => EMPTY_LIST },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=kb-list-empty]')
      const text = await box.innerText()
      if (/暂无|条目/.test(text)) issues.push(`空状态不该写「暂无 / 条目」:${text}`)
      for (const name of ['新建笔记', '导入文件']) if (!(await box.getByRole('button', { name }).count())) issues.push(`空列表应给下一步「${name}」`)
      if (await isCoarse(tab)) {
        for (const name of ['新建笔记', '导入文件']) {
          const small = await tapSize(box.getByRole('button', { name }))
          if (small) issues.push(`触屏上「${name}」可点区域不足 44px:${small}`)
        }
      }
      issues.push(...(await overflowIssues(tab)))
      await box.getByRole('button', { name: '新建笔记' }).click()
      await tab.waitForSelector('.kb-dp textarea.kb-dp-title', { timeout: 10_000 }).catch(() => issues.push('点「新建笔记」应进入新建表单'))
      return issues
    },
  },

  'a7-kb-list-filtered-empty': {
    // 筛选(切到「文档」)后没有结果:说明是筛选造成的,给「清除筛选」,点了回到全部
    route: LIST,
    ready: '[data-testid^=list-row-]',
    fixture: {
      list_items: (args) =>
        args?.page_size === 1
          ? { items: [], total: 5, page: 1, page_size: 1 } // 类型药丸上的计数(每类取 1 条看 total):三类都有,药丸才都显示
          : args?.kind === 'doc'
            ? EMPTY_LIST
            : {
                items: [{ id: 'ins_8f21', kind: 'insight', insight_kind: 'pitfall', title: 'UDS 断线后 CLI 自动降级为直读 SQLite', source: 'insight:ins_8f21', status: 'active', version: 3, updated_at: Date.UTC(2026, 9, 21), tags: ['uds'], collection: 'knowledgeBase/insights' }],
                total: 1,
                page: 1,
                page_size: 16,
              },
    },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.getByRole('button', { name: /^文档/ }).first().click()
      await tab.waitForSelector('[data-testid=kb-list-empty]')
      const box = tab.locator('[data-testid=kb-list-empty]')
      const text = await box.innerText()
      if (!text.includes('没有符合条件的内容')) issues.push(`筛选后为空应说明是筛选造成的,实际:${text}`)
      await box.getByRole('button', { name: '清除筛选' }).click()
      await tab.waitForSelector('[data-testid^=list-row-]', { timeout: 5000 }).catch(() => issues.push('点「清除筛选」后列表应回来'))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7-kb-list-loading': {
    // 列表加载中:骨架屏(不是空白,也不是「没有内容」)。从搜索页站内跳转过去:直接打开页面的话,等「网络空闲」时数据已经到了
    route: '/search',
    ready: '[data-testid=topbar], [data-testid=tabbar]',
    fixture: { __hold: { list_items: 3000 } },
    settle: 200,
    assert: async (tab) => {
      const issues = []
      await goInApp(tab, LIST)
      await tab.waitForSelector('[data-testid=kb-list-loading]', { timeout: 3000 }).catch(() => issues.push('列表还没返回时应显示骨架屏'))
      if (await tab.locator('[data-testid=kb-list-empty], [data-testid=kb-list-error]').count()) issues.push('加载中不该显示空状态或报错')
      if ((await tab.locator('[data-testid=kb-list-loading]').count()) && (await tab.locator('[data-testid=kb-list-loading]').getAttribute('aria-busy')) !== 'true') issues.push('加载中的骨架屏应标 aria-busy')
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('[data-testid^=list-row-]', { timeout: 8000 }).catch(() => issues.push('列表返回后应显示条目'))
      if (await tab.locator('[data-testid=kb-list-loading]').count()) issues.push('列表出来以后骨架屏应消失')
      return issues
    },
  },

  'a7-kb-doc-error': {
    // 打开笔记失败:主区不能还是「知识工作台」占位(像什么都没选),要说没能打开并给重试;重试后文档出来
    route: DOC,
    ready: '[data-testid=kb-doc-error]',
    fixture: failing('get_item', 500, 'internal: boom', 1),
    expectConsole: /status of 500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=kb-doc-error]')
      const text = await box.innerText()
      if (!text.includes('没能打开这篇文档')) issues.push(`应写明没能打开,实际:${text}`)
      if (/internal|boom|500/.test(text)) issues.push(`不该露出英文异常 / 状态码:${text}`)
      if ((await tab.locator('body').innerText()).includes('知识工作台')) issues.push('打不开时主区不该是「知识工作台」占位')
      if (await isCoarse(tab)) {
        const small = await tapSize(box.getByRole('button', { name: '重试' }))
        if (small) issues.push(`触屏上「重试」可点区域不足 44px:${small}`)
      }
      issues.push(...(await overflowIssues(tab)))
      await box.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2', { timeout: 10_000 }).catch(() => issues.push('重试后文档应出来'))
      if (await tab.locator('[data-testid=kb-doc-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'a7-kb-doc-loading': {
    // 打开笔记还在读:骨架屏,不是「知识工作台」占位(站内跳转,理由同上)
    route: '/search',
    ready: '[data-testid=topbar], [data-testid=tabbar]',
    fixture: { __hold: { get_item: 3000 } },
    settle: 200,
    assert: async (tab) => {
      const issues = []
      await goInApp(tab, DOC)
      await tab.waitForSelector('[data-testid=kb-doc-loading]', { timeout: 3000 }).catch(() => issues.push('文档还没返回时应显示骨架屏'))
      if (await tab.locator('[data-testid=kb-doc-error]').count()) issues.push('加载中不该显示报错')
      if ((await tab.locator('body').innerText()).includes('知识工作台')) issues.push('读取中主区不该是「知识工作台」占位')
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2', { timeout: 8000 }).catch(() => issues.push('文档返回后应显示正文'))
      if (await tab.locator('[data-testid=kb-doc-loading]').count()) issues.push('文档出来以后骨架屏应消失')
      return issues
    },
  },

  'a7-kb-file-error': {
    // 文件打开了但读不到内容(预览失败):不能留一个空的占位;说清楚并给重试,重试后查看器出来
    route: FILE_RS,
    ready: '[data-testid=kb-preview-error]',
    fixture: failing('file_preview', 500, 'internal: boom', 1),
    expectConsole: /status of 500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=kb-preview-error]')
      const text = await box.innerText()
      if (!text.includes('没能读取这个文件的内容')) issues.push(`应写明没能读取文件内容,实际:${text}`)
      if (/internal|boom|500/.test(text)) issues.push(`不该露出英文异常 / 状态码:${text}`)
      if ((await tab.locator('body').innerText()).includes('知识工作台')) issues.push('读不到内容时主区不该是「知识工作台」占位')
      issues.push(...(await overflowIssues(tab)))
      await box.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('.kb-ce .cm-content', { timeout: 10_000 }).catch(() => issues.push('重试后代码查看器应出来'))
      return issues
    },
  },

  'a7-search-error-copy': {
    // 搜索失败的文案:服务端原话常是英文前缀 + 中文(internal: …)或纯英文,界面不能露出来;说「发生了什么 + 怎么办」,重试后出结果
    route: '/search?q=uds',
    ready: '[data-testid=search-error]',
    fixture: failing('search_knowledge', 500, 'internal: boom', 1),
    expectConsole: /status of 500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=search-error]')
      const text = await box.innerText()
      if (/internal|boom|500/.test(text)) issues.push(`不该露出英文异常 / 状态码:${text}`)
      if (!text.includes('搜索失败')) issues.push(`应写明搜索失败,实际:${text}`)
      if (!text.includes('重试')) issues.push('搜索失败应给「重试」')
      issues.push(...(await overflowIssues(tab)))
      await box.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('.kb-hit', { timeout: 10_000 }).catch(() => issues.push('重试后应出结果'))
      return issues
    },
  },

  'a7-search-forbidden': {
    // 搜索被拒(账号没开通):说没开通并让用户联系管理员,不给没有意义的「重试」;服务端中文原话前面的英文前缀不露
    route: '/search?q=uds',
    ready: '[data-testid=search-error]',
    fixture: failing('search_knowledge', 403, 'forbidden: 你的账号没有开通这个功能', 0, 'forbidden'),
    expectConsole: /status of 403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const box = tab.locator('[data-testid=search-error]')
      const text = await box.innerText()
      if (/forbidden/i.test(text)) issues.push(`不该露出英文前缀:${text}`)
      if (!text.includes('没有开通这个功能') || !text.includes('管理员')) issues.push(`应说明没开通并让用户联系管理员,实际:${text}`)
      if (await box.getByRole('button', { name: '重试' }).count()) issues.push('没开通功能时重试没有意义,不该给「重试」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7-search-loading': {
    // 搜索进行中:结果区是骨架屏、按钮写「检索中」且不可再点,不是空白也不是「还没搜索」。搜索由页面内触发(直接带 ?q= 打开会等到网络空闲)
    route: '/search',
    ready: '.kb-search-start',
    fixture: { __hold: { search_knowledge: 3000 } },
    settle: 200,
    assert: async (tab) => {
      const issues = []
      await tab.locator('input').first().fill('uds')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[data-testid=search-loading]', { timeout: 3000 }).catch(() => issues.push('搜索进行中应显示骨架屏'))
      if (await tab.locator('.kb-search-start').count()) issues.push('搜索进行中不该还显示「还没有搜索」')
      const go = tab.locator('.kb-search-go')
      if (!(await go.innerText()).includes('检索中')) issues.push('搜索进行中按钮应写「检索中」')
      if (!(await go.isDisabled())) issues.push('搜索进行中按钮应不可再点')
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('.kb-hit', { timeout: 8000 }).catch(() => issues.push('搜索返回后应出结果'))
      if (await tab.locator('[data-testid=search-loading]').count()) issues.push('结果出来以后骨架屏应消失')
      return issues
    },
  },

  'a7-copy-doc': {
    // 文案对照术语表(检查项 6):笔记阅读页、更多菜单、属性面板各页签、编辑态与斜杠菜单里,界面文字和 title / aria-label / placeholder
    // 不出现「条目 / 经验 / insight / 分块 / Chunks / 嵌入 / 进化链 / 批注」和英文键名(decision / active / collection …)
    route: DOC,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2',
    fixture: SOLO_EDIT_FIXTURE,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await copyIssues(tab, '笔记阅读页')))
      await openMore(tab)
      issues.push(...(await copyIssues(tab, '更多菜单')))
      await showInspector(tab)
      for (const name of ['信息', '关系', '历史版本', '评论']) {
        const tabButton = tab.getByRole('tab', { name: new RegExp(`^${name}`) }).first()
        if (!(await tabButton.count())) {
          issues.push(`属性面板缺少「${name}」页签`)
          continue
        }
        await tabButton.click()
        await tab.waitForTimeout(250)
        issues.push(...(await copyIssues(tab, `属性面板·${name}`)))
      }
      // 手机上属性面板盖在正文上面:先收起再编辑
      const close = tab.locator('[data-testid=inspector-close]')
      if (await close.count()) await close.click()
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('/')
      await tab.waitForTimeout(500)
      issues.push(...(await copyIssues(tab, '编辑态·斜杠菜单')))
      return issues
    },
  },

  'a7-copy-files': {
    // 文件页(代码 / PDF / Word / 表格 / 压缩包 / 图片 / 邮件 / 未知格式 / Markdown 文件)的信息栏、更多菜单、内容片段 / 评论 / 历史版本页签
    route: '/search',
    ready: '[data-testid=topbar], [data-testid=tabbar]',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const id of ['file_rs', 'file_pdf', 'file_docx', 'file_xlsx', 'file_zip', 'file_png', 'file_eml', 'file_dat', 'file_md', 'file_doc']) {
        await visit(tab, `${LIST}&item=${id}`)
        await tab.waitForSelector('.kb-workspace-bar-right', { timeout: 15_000 })
        await tab.waitForTimeout(900)
        issues.push(...(await copyIssues(tab, `文件 ${id}`)))
        await openMore(tab)
        issues.push(...(await copyIssues(tab, `文件 ${id}·更多菜单`)))
        await showInspector(tab)
        for (const name of ['内容片段', '评论', '历史版本']) {
          const tabButton = tab.getByRole('tab', { name: new RegExp(`^${name}`) }).first()
          if (!(await tabButton.count())) {
            issues.push(`文件 ${id} 的属性面板缺少「${name}」页签`)
            continue
          }
          await tabButton.click()
          await tab.waitForTimeout(250)
          issues.push(...(await copyIssues(tab, `文件 ${id}·${name}`)))
        }
      }
      return issues
    },
  },

  'a7-copy-list': {
    // 知识库列表:搜索框占位、目录页签、新建笔记表单(种类下拉)、表格视图
    route: LIST,
    ready: '[data-testid^=list-row-]',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await copyIssues(tab, '列表')))
      const treeTab = tab.getByText('目录', { exact: true }).first()
      if (await treeTab.count()) {
        await treeTab.click()
        await tab.waitForTimeout(400)
        // 展开集合,让类型行(原来露出 insight / code / doc)出来
        const rows = tab.locator('.kb-tree-item')
        if (await rows.count()) await rows.first().click().catch(() => undefined)
        await tab.waitForTimeout(300)
        issues.push(...(await copyIssues(tab, '目录页签')))
      }
      await tab.getByRole('button', { name: /新建/ }).first().click().catch(() => undefined)
      await tab.waitForSelector('.kb-dp textarea.kb-dp-title', { timeout: 10_000 }).catch(() => undefined)
      issues.push(...(await copyIssues(tab, '新建笔记')))
      return issues
    },
  },

  'a7-copy-home-search': {
    // 首页与搜索页(含搜索结果、高级选项展开)
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await copyIssues(tab, '首页')))
      await goInApp(tab, '/search?q=uds')
      await tab.waitForSelector('.kb-hit', { timeout: 10_000 })
      issues.push(...(await copyIssues(tab, '搜索结果')))
      await tab.locator('[data-testid=search-adv-toggle]').click()
      await tab.waitForTimeout(500)
      issues.push(...(await copyIssues(tab, '搜索·高级选项')))
      return issues
    },
  },

  'a7-touch-viewers': {
    // 触屏可点区域(检查项 5):各种文件查看器的工具栏 / 页签 / 列表行 / 缩放百分比,在触屏设备上都 ≥44px(电脑尺寸不查,pointer: fine)
    route: '/search',
    ready: '[data-testid=topbar], [data-testid=tabbar]',
    // 只跑触屏尺寸:电脑尺寸是三栏、目录常驻,没有「目录」按钮,也不该按触屏标准量
    sizes: ['390x844', '820x1180', '1180x820'],
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const seen = new Set()
      // 每种查看器要等到自己的工具栏 / 列表出来再量(表格、PDF 等是异步解析的,量早了什么都没有,就成了假绿)
      const READY = {
        ins_8f21: '.kb-dp-toc-btn',
        file_rs: '.kb-ce .cm-content',
        file_pdf: '.kb-pv-zoom',
        file_docx: '.kb-pgs-zoom',
        file_xlsx: '.kb-xg-tab', // 默认原生只读网格()
        file_csv: '.kb-sg-check',
        file_pptx: '.kb-px-item',
        file_png: '.kb-iv-pct',
        file_svg: '.kb-iv-pct',
        file_zip: '.kb-av-row',
        file_tgz: '.kb-av-row',
        file_epub: '.kb-rd-item',
        file_mbox: '.kb-rd-item',
        file_odp: '.kb-rd-item',
        file_ppt: '.kb-rd-item',
        file_ods: '.kb-sg-tab',
        file_md: '.kb-dp',
      }
      for (const [id, ready] of Object.entries(READY)) {
        await visit(tab, `${LIST}&item=${id}`)
        await tab.waitForSelector('.kb-workspace-bar-right', { timeout: 15_000 })
        await tab.waitForSelector(ready, { state: 'attached', timeout: 15_000 }).catch(() => issues.push(`${id}:查看器没有渲染出来(等不到 ${ready})`))
        await tab.waitForTimeout(400)
        // 同一个元素在每个页面上都有时只报一次(报第一个出现的页面)
        for (const line of await tapIssues(tab, id)) {
          const key = line.split(' 44px ')[1]
          if (!seen.has(key)) {
            seen.add(key)
            issues.push(line)
          }
        }
      }
      return issues
    },
  },

  'a7-kb-inapp-open': {
    // 已经在知识库页时,在页内换地址(通知 / 助手里的文档引用就是这样跳的)要真的打开那篇文档;以前只在页面挂载时读一次 ?item=,
    // 地址变了、屏幕上还是原来那篇
    route: DOC,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await goInApp(tab, FILE_RS)
      await tab.waitForSelector('.kb-ce .cm-content', { timeout: 10_000 }).catch(() => issues.push('页内跳到代码文件(?item=file_rs)后应打开它'))
      const leaf = async () => (await tab.locator('.kb-crumb-leaf').first().innerText().catch(() => '')).trim()
      if (!(await leaf()).includes('degrade.rs')) issues.push(`面包屑应换成 degrade.rs,实际:${await leaf()}`)
      await goInApp(tab, `${LIST}&item=ins_7d02`)
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror))', { timeout: 10_000 }).catch(() => issues.push('页内跳回另一篇笔记后应打开它'))
      await tab.waitForFunction(() => !document.querySelector('.kb-ce'), null, { timeout: 5000 }).catch(() => issues.push('跳到笔记后代码查看器应收起'))
      if ((await leaf()).includes('degrade.rs')) issues.push('面包屑还停在上一个文件')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7-touch-pages': {
    // 触屏可点区域(检查项 5):首页、搜索(结果 / 高级选项)、知识库列表(选择模式 / 排序与筛选下拉 / 更多菜单 / 属性面板)里看得见的可点元素都 ≥44px
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await tapIssues(tab, '首页')))
      await visit(tab, '/search?q=uds')
      await tab.waitForSelector('.kb-hit', { timeout: 10_000 })
      issues.push(...(await tapIssues(tab, '搜索结果')))
      await tab.locator('[data-testid=search-adv-toggle]').click()
      await tab.waitForTimeout(600)
      issues.push(...(await tapIssues(tab, '搜索·高级选项')))
      await visit(tab, LIST)
      await tab.waitForSelector('[data-testid^=list-row-]', { timeout: 10_000 })
      issues.push(...(await tapIssues(tab, '知识库列表')))
      await visit(tab, DOC)
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2', { timeout: 10_000 })
      issues.push(...(await tapIssues(tab, '笔记阅读页')))
      await openMore(tab)
      issues.push(...(await tapIssues(tab, '更多菜单')))
      await showInspector(tab)
      issues.push(...(await tapIssues(tab, '属性面板')))
      return issues
    },
  },

  'a7-keys-doc': {
    // 键盘(检查项 5):笔记页按 Tab 能依次走过工具栏和属性面板,每一站都有看得见的焦点样式;「更多操作」菜单能用 Enter 打开、Esc 关闭并把焦点还给按钮
    route: DOC,
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const walk = await tabWalk(tab, 14, '笔记页')
      issues.push(...walk.issues)
      if (walk.stops.length < 6) issues.push(`笔记页按 Tab 只走到 ${walk.stops.length} 站,应能走过工具栏和列表`)
      const trigger = tab.locator('[aria-label=更多操作]').first()
      await trigger.focus()
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[role=menu]', { timeout: 3000 }).catch(() => issues.push('「更多操作」按钮上按 Enter 应打开菜单'))
      await tab.keyboard.press('Escape')
      await tab.waitForTimeout(250)
      if (await tab.locator('[role=menu]').count()) issues.push('菜单打开时按 Esc 应关闭菜单')
      const focused = await tab.evaluate(() => document.activeElement?.getAttribute('aria-label'))
      if (focused !== '更多操作') issues.push(`Esc 关掉菜单后焦点应回到「更多操作」按钮,实际:${focused}`)
      return issues
    },
  },

  'a7-keys-list': {
    // 键盘(检查项 5):知识库列表里 Tab 能走到每一行、有焦点样式,在行上按 Enter 打开那篇文档
    route: LIST,
    ready: '[data-testid^=list-row-]',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const walk = await tabWalk(tab, 18, '列表')
      issues.push(...walk.issues)
      const second = tab.locator('[data-testid^=list-row-]').nth(1)
      const id = ((await second.getAttribute('data-testid')) ?? '').replace('list-row-', '')
      await second.focus()
      await tab.keyboard.press('Enter')
      await tab.waitForFunction((wanted) => location.search.includes(`item=${wanted}`), id, { timeout: 8000 }).catch(() => issues.push('在列表行上按 Enter 应打开这篇文档'))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7-keys-search': {
    // 键盘(检查项 5):搜索页 Tab 顺序合理(搜索框 → 范围 → 开关 → 高级选项 → 结果),焦点有样式;输入后 Enter 提交;高级选项弹层(手机)Esc 能关
    route: '/search',
    ready: '.kb-search-start',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const input = tab.locator('input').first()
      await input.focus()
      await input.fill('uds')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('.kb-hit', { timeout: 10_000 }).catch(() => issues.push('搜索框里按 Enter 应提交搜索'))
      const walk = await tabWalk(tab, 12, '搜索页')
      issues.push(...walk.issues)
      await tab.locator('[data-testid=search-adv-toggle]').focus()
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(500)
      const opened = (await tab.locator('[data-testid=search-advanced]').count()) > 0
      if (!opened) issues.push('高级选项按钮上按 Enter 应展开高级选项')
      if (await tab.evaluate(() => location.pathname !== '/search')) issues.push(`焦点在按钮上按 Enter 不该顺手打开选中的结果(现在在 ${await tab.evaluate(() => location.pathname)})`)
      if (opened) {
        await tab.keyboard.press('Escape')
        await tab.waitForTimeout(400)
        if (size.width < 600 && (await tab.locator('.kb-sheet').count())) issues.push('手机上高级选项弹层打开时按 Esc 应关闭')
      }
      return issues
    },
  },

  'a7-light-kb': {
    // 浅色主题(检查项 2):知识库的各种界面里没有看不清的字、没有写死的深色块——列表、笔记阅读 / 编辑、属性面板、更多菜单、新建表单、各种文件页
    route: LIST,
    ready: '[data-testid^=list-row-]',
    fixture: SOLO_EDIT_FIXTURE,
    init: lightTheme,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await lightIssues(tab, '列表')))
      await visit(tab, DOC)
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp :is(.kb-doc .kb-md-read-body, .kb-doc .ProseMirror)) h2', { timeout: 10_000 })
      issues.push(...(await lightIssues(tab, '笔记阅读页')))
      await openMore(tab)
      issues.push(...(await lightIssues(tab, '更多菜单')))
      await showInspector(tab)
      for (const name of ['信息', '关系', '历史版本', '评论']) {
        await tab.getByRole('tab', { name: new RegExp(`^${name}`) }).first().click()
        await tab.waitForTimeout(250)
        issues.push(...(await lightIssues(tab, `属性面板·${name}`)))
      }
      const close = tab.locator('[data-testid=inspector-close]')
      if (await close.count()) await close.click()
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('/')
      await tab.waitForTimeout(500)
      issues.push(...(await lightIssues(tab, '编辑态·斜杠菜单')))
      return issues
    },
  },

  'a7-light-files': {
    // 浅色主题:各种文件页(代码 / PDF / Word / 表格 / 演示 / 压缩包 / 图片 / 邮件 / 阅读器)
    route: '/search',
    ready: '[data-testid=topbar], [data-testid=tabbar]',
    init: lightTheme,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const seen = new Set()
      for (const [id, ready] of [['file_rs', '.kb-ce .cm-content'], ['file_pdf', '.kb-pv-zoom'], ['file_docx', '.kb-pgs-zoom'], ['file_xlsx', '.kb-xg-tab'], ['file_csv', '.kb-sg-check'], ['file_pptx', '.kb-px-item'], ['file_zip', '.kb-av-row'], ['file_png', '.kb-iv-pct'], ['file_epub', '.kb-rd-item'], ['file_eml', '.kb-workspace-bar-right'], ['file_md', '.kb-dp']]) {
        await visit(tab, `${LIST}&item=${id}`)
        await tab.waitForSelector('.kb-workspace-bar-right', { timeout: 15_000 })
        await tab.waitForSelector(ready, { state: 'attached', timeout: 15_000 }).catch(() => issues.push(`${id}:查看器没有渲染出来(等不到 ${ready})`))
        await tab.waitForTimeout(500)
        for (const line of await lightIssues(tab, id)) {
          const key = line.split(' ').slice(1).join(' ')
          if (!seen.has(key)) {
            seen.add(key)
            issues.push(line)
          }
        }
      }
      return issues
    },
  },

  'a7-light-home-search': {
    // 浅色主题:首页、搜索结果、高级选项里同样没有看不清的字和写死的深色块(home-light / search-light 只查了溢出)
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    init: lightTheme,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await lightIssues(tab, '首页')))
      await visit(tab, '/search?q=uds')
      await tab.waitForSelector('.kb-hit', { timeout: 10_000 })
      issues.push(...(await lightIssues(tab, '搜索结果')))
      await tab.locator('[data-testid=search-adv-toggle]').click()
      await tab.waitForTimeout(600)
      issues.push(...(await lightIssues(tab, '搜索·高级选项')))
      return issues
    },
  },

  'a7-kb-save-error': {
    // 保存笔记失败:界面要有提示条(以前错误只写进一个不渲染的变量,点保存没反应),说人话、不丢已写的内容
    route: DOC,
    ready: '.kb-workspace-bar-right',
    fixture: { ...SOLO_EDIT_FIXTURE, ...failing('edit_item', 500, 'internal: boom') },
    expectConsole: /status of 500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 新增的一句')
      await tab.getByRole('button', { name: '保存', exact: true }).first().click()
      await tab.waitForSelector('[data-testid=kb-error]', { timeout: 8000 }).catch(() => issues.push('保存失败后应出现提示条'))
      const text = (await tab.locator('[data-testid=kb-error]').count()) ? await tab.locator('[data-testid=kb-error]').innerText() : ''
      if (!text.includes('保存失败')) issues.push(`提示应写明保存失败,实际:${text}`)
      if (/internal|boom|500/.test(text)) issues.push(`不该露出英文异常 / 状态码:${text}`)
      const body = await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').innerText()
      if (!body.includes('新增的一句')) issues.push('保存失败后不该丢掉已经写的内容')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },
}
