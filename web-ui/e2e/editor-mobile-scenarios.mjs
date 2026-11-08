// 手机上的编辑器(设计规范;两条路径都跑):由 viewer-shots.mjs 引入,在设备矩阵 × 引擎(Chromium / WebKit)下跑。
//   1. 输入法组字不误触发:组字过程中的 / 、[[ 、Markdown 快捷转换、回车、方向键、Esc 都归输入法,组字结束才按最终文本判断;
//   2. 工具栏贴键盘上沿;
//   3. 斜杠菜单与 `[[` 选择器在手机上是贴键盘的底部面板。
// 真机弹不出软键盘:键盘用假的 window.visualViewport 模拟,输入法在 Chromium 用 CDP,在 WebKit 用合成事件(见 editor-helpers.mjs)。
//
// 两条路径(翻默认后):
//   - 默认(场景名不带后缀)= 新文本面(统一外壳 + ProseMirror),量用户真实打开的那条路;
// - 起旧编辑器(Milkdown / Crepe)与 `-legacy` 变体已删除，只剩统一外壳这一条路径。
// 同一个场景的断言意图一致,只是选择器不同:PATHS 里集中列出。
import {
  COLLECTION,
  FAKE_VISUAL_VIEWPORT,
  SOLO_EDIT_FIXTURE,
  blocksOf,
  fillLines,
  imeCommit,
  imeCompose,
  imeKey,
  isPhoneLike,
  keyboardHeight,
  rectOf,
  setKeyboard,
  settled,
  focusState,
  roomForCaretAbove,
  tapCenter,
  wantsSheet,
} from './editor-helpers.mjs'

/** 正文节点：阅读态是 MarkdownRead 的正文，编辑态是文本面的 .ProseMirror */
const PM = ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)'

export const PATHS = {
  native: {
    id: 'native',
    suffix: '',
    query: '',
    label: '新文本面',
    slash: '.kb-slash-menu',
    slashItem: '.kb-slash-item',
    picker: '.kb-text-picker',
    pickerItem: '.kb-text-picker-item',
    pickerTitle: '.kb-text-picker-title',
    pickerInput: '.kb-text-picker-input',
    pickerList: '.kb-text-picker-list',
    find: '[data-testid="editor-find-bar"]',
    findInput: '[data-testid="editor-find-input"]',
    bar: '.kb-editor-chrome-tools',
    dockRoot: '.kb-editor-chrome',
    spacer: '.kb-editor-chrome-spacer',
    body: '.kb-text-prose',
    undockedPosition: 'static',
    /** 工具栏放不下的按钮收进「更多」,不横向滚动 */
    scrolls: false,
  },
}

/** 斜杠菜单当前是否在显示,以及高亮项的文字 */
export const slashStateOf = (tab, P) =>
  tab.evaluate(() => {
    const menu = document.querySelector('.kb-slash-menu')
    return { shown: !!menu, hover: menu?.querySelector('.kb-slash-item.is-active')?.textContent?.trim() ?? '' }
  }, P)

const waitSlash = (tab, P, issues, message = '输入 / 没有弹出菜单') =>
  tab
    .waitForFunction(
      () => !!document.querySelector('.kb-slash-menu'),
      P,
      { timeout: 3000 },
    )
    .catch(() => issues.push(message))

/** 工具栏上的某个动作按钮:够宽时在工具栏上直接点,放不下时在「更多」菜单里 */
async function clickTool(tab, P, action) {
  const direct = tab.locator(`[data-testid="editor-toolbar-slot"] [data-action="${action}"]`)
  if (await direct.count()) return direct.click()
  await tab.click('[data-testid="editor-toolbar-more"]')
  return tab.click(`[data-testid="editor-toolbar-more-menu"] [data-action="${action}"]`)
}

/** 打开「插入」菜单,返回它的选择器与菜单项选择器 */
async function openInsertMenu(tab, P) {
  const direct = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="insertMore"]')
  if (await direct.count()) {
    await direct.click()
    return { menu: '[data-testid="editor-dropdown-insertMore"]', item: '[data-testid="editor-dropdown-insertMore"] .kb-editor-chrome-menu-item' }
  }
  await tab.click('[data-testid="editor-toolbar-more"]')
  return { menu: '[data-testid="editor-toolbar-more-menu"]', item: '[data-testid="editor-toolbar-more-menu"] .kb-editor-chrome-menu-item' }
}

/**
 * 新建一篇笔记并把光标放进正文(空文档,避免被样例正文里的链接 / 列表干扰)。
 * 与 editor-helpers 的 openNewDoc 同一流程,路径选择器通用。
 */
async function openNewDoc(tab) {
  await tab.getByRole('button', { name: /新建/ }).first().click()
  await tab.waitForSelector('.kb-dp textarea.kb-dp-title', { timeout: 15_000 })
  await tab.waitForSelector(`${PM}[contenteditable="true"]`, { timeout: 15_000 })
  await tab.fill('.kb-dp textarea.kb-dp-title', '输入法与手机编辑')
  await tab.keyboard.press('Enter')
  await tab.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), null, { timeout: 5000 })
}

const text = (blocks) => blocks.join('|')
/** 输入法与键盘无关,选一个手机和一个桌面尺寸就够 */
const IME_SIZES = ['390x844', '1440x900']

/** 一条路径下的全部场景(场景名 = 基名 + 路径后缀);断言意图两条路径一致 */
function scenariosFor(P) {
  const NEW_DOC = {
    fixture: SOLO_EDIT_FIXTURE,
    route: `/kb?collection=${COLLECTION}${P.query ? `&${P.query.replace(/^&/, '')}` : ''}`,
    ready: '.kb-workspace-main, .kb-sidebar',
    prepare: openNewDoc,
    settle: 300,
  }
  const name = (base) => `${base}${P.suffix}`

  return {
    [name('editor-ime-slash')]: {
      // 斜杠菜单打开后开始组字:选词用的回车 / 方向键 / Esc 是输入法的,菜单不能响应;上屏之后按最终文本过滤
      ...NEW_DOC,
      sizes: IME_SIZES,
      assert: async (tab) => {
        const issues = []
        await tab.keyboard.type('/')
        await waitSlash(tab, P, issues)
        const before = await slashStateOf(tab, P)
        await imeCompose(tab, '标题')
        await tab.waitForTimeout(150)
        await imeKey(tab, 'ArrowDown')
        const afterDown = await slashStateOf(tab, P)
        if (afterDown.hover !== before.hover) issues.push(`组字中按↓选词,菜单高亮被移走了:${before.hover} → ${afterDown.hover}`)
        await imeKey(tab, 'Escape')
        await tab.waitForTimeout(100)
        if (!(await slashStateOf(tab, P)).shown) issues.push('组字中按 Esc(取消组字),菜单被关掉了')
        await imeKey(tab, 'Enter')
        await tab.waitForTimeout(150)
        const mid = text(await blocksOf(tab))
        if (!mid.includes('/标题')) issues.push(`组字中按回车(上屏),菜单项被执行、正文被清掉了:${mid}`)
        await imeCommit(tab, '标题')
        await tab.waitForTimeout(300)
        const filtered = await tab.evaluate((sel) => [...document.querySelectorAll(sel)].map((li) => li.textContent?.trim()), P.slashItem)
        if (!filtered.length || !filtered.every((label) => label?.includes('标题'))) issues.push(`上屏后菜单应按最终文本「标题」过滤:${filtered.join(',')}`)
        // 组字结束后的回车才执行菜单项
        await tab.keyboard.press('Enter')
        await tab.waitForTimeout(200)
        const after = text(await blocksOf(tab))
        if (!after.includes('<h1>')) issues.push(`上屏后按回车应执行「标题 1」:${after}`)
        return issues
      },
    },
    [name('editor-ime-markdown')]: {
      // 组字过程中输入的 `- ` / `# ` 先不转换;组字结束(compositionend)后按最终文本转换
      ...NEW_DOC,
      sizes: IME_SIZES,
      assert: async (tab) => {
        const issues = []
        await imeCompose(tab, '- ')
        await tab.waitForTimeout(200)
        let blocks = text(await blocksOf(tab))
        if (blocks.includes('<ul>') || blocks.includes('<li>')) issues.push(`组字中的 "- " 不该变成列表:${blocks}`)
        await imeCommit(tab, '- ')
        await tab.waitForFunction((sel) => !!document.querySelector(`${sel} li`), PM, { timeout: 3000 }).catch(() => issues.push('组字结束后 "- " 应转换成列表'))
        // 离开列表,新起一段再试标题
        await tab.keyboard.press('Enter')
        await tab.keyboard.press('Enter')
        await tab.waitForTimeout(200)
        await imeCompose(tab, '# ')
        await tab.waitForTimeout(200)
        blocks = text(await blocksOf(tab))
        if (blocks.includes('<h1>')) issues.push(`组字中的 "# " 不该变成标题:${blocks}`)
        await imeCommit(tab, '# ')
        await tab.waitForFunction((sel) => !!document.querySelector(`${sel} h1`), PM, { timeout: 3000 }).catch(() => issues.push('组字结束后 "# " 应转换成标题'))
        return issues
      },
    },
    [name('editor-ime-wikilink')]: {
      // 组字中凑出的 `[[` 不弹笔记选择器(它会抢走焦点、打断组字);组字结束后才按最终文本判断
      ...NEW_DOC,
      sizes: IME_SIZES,
      assert: async (tab) => {
        const issues = []
        await tab.keyboard.type('[')
        await imeCompose(tab, '[')
        await tab.waitForTimeout(400)
        if (await tab.locator(P.picker).count()) issues.push('组字过程中凑出 [[ 就弹出了笔记选择器')
        await imeCommit(tab, '[')
        const open = await tab.waitForSelector(P.picker, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!open) issues.push('组字结束后文本是 [[ ,应弹出笔记选择器')
        return issues
      },
    },
    [name('editor-ime-picker')]: {
      // 笔记选择器的搜索框里组字:方向键 / Esc / 回车归输入法,不能移动选中项、关掉选择器或插入引用
      ...NEW_DOC,
      sizes: IME_SIZES,
      assert: async (tab) => {
        const issues = []
        await tab.keyboard.type('[[')
        const open = await tab.waitForSelector(P.picker, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!open) return ['输入 [[ 没有弹出笔记选择器']
        await tab.waitForSelector(P.pickerItem, { timeout: 4000 }).catch(() => issues.push('选择器没有结果'))
        await tab.waitForFunction((cls) => document.activeElement?.classList.contains(cls), P.pickerInput.slice(1), { timeout: 2000 }).catch(() => issues.push('选择器的搜索框没有拿到焦点'))
        const active = () => tab.evaluate((sel) => [...document.querySelectorAll(sel)].findIndex((li) => li.classList.contains('is-on')), P.pickerItem)
        const first = await active()
        await imeCompose(tab, '部署')
        await imeKey(tab, 'ArrowDown')
        if ((await active()) !== first) issues.push('组字中按↓选词,选择器的高亮项被移走了')
        await imeKey(tab, 'Escape')
        await tab.waitForTimeout(250)
        if (!(await tab.locator(P.picker).count())) issues.push('组字中按 Esc,选择器被关掉了')
        await imeKey(tab, 'Enter')
        await tab.waitForTimeout(250)
        if (!(await tab.locator(P.picker).count())) issues.push('组字中按回车(上屏),选择器把当前项当成选择插入了')
        const body = text(await blocksOf(tab))
        if (/\[\[[^\]]*\|/.test(body)) issues.push(`组字中按回车不该插入引用:${body}`)
        return issues
      },
    },
    [name('editor-ime-find')]: {
      // 查找框里组字:Esc 是取消组字,不是关闭查找条
      ...NEW_DOC,
      sizes: IME_SIZES,
      assert: async (tab) => {
        const issues = []
        await tab.keyboard.type('一段文字')
        await tab.keyboard.press('Control+f')
        await tab.waitForSelector(P.find, { timeout: 3000 }).catch(() => issues.push('Ctrl+F 没有打开查找条'))
        await tab.waitForFunction((cls) => document.activeElement?.classList.contains(cls) || document.activeElement?.getAttribute('data-testid') === cls, P.findInput.replace(/^\./, '').replace(/^\[data-testid="(.*)"\]$/, '$1'), { timeout: 2000 }).catch(() => undefined)
        await imeCompose(tab, '文字')
        await imeKey(tab, 'Escape')
        await tab.waitForTimeout(150)
        if (!(await tab.locator(P.find).count())) issues.push('查找框里组字时按 Esc,查找条被关掉了')
        return issues
      },
    },
    [name('editor-toolbar-dock')]: {
      // 手机:软键盘弹出后格式工具栏贴在键盘正上方、单行、按钮 ≥44px、正文不上跳、光标行不被盖住、下拉菜单往上展开;
      // 平板 / 桌面:保持顶部工具栏。截图停在键盘打开的状态。
      // 旧编辑器放不下的按钮横向滑动;新文本面收进「更多」(设计),所以不要求可横滑。
      ...NEW_DOC,
      init: FAKE_VISUAL_VIEWPORT,
      assert: async (tab, size) => {
        const issues = []
        const phone = isPhoneLike(size)
        const kb = keyboardHeight(size)
        await fillLines(tab, 30)
        await tab.keyboard.press('Control+Home')
        const probe = () =>
          tab.evaluate((p) => {
            const bar = document.querySelector(p.bar)
            const body = document.querySelector(p.body)
            return {
              position: getComputedStyle(bar).position,
              docked: document.querySelector(p.dockRoot)?.classList.contains('is-docked') ?? false,
              bodyOffset: body.offsetTop,
              kbd: document.documentElement.dataset.kbd,
              reserve: document.documentElement.style.getPropertyValue('--kbd-reserve'),
            }
          }, P)
        const before = await probe()
        if (before.position === 'fixed') issues.push(`键盘没开时工具栏不该是贴键盘的 fixed,实际 ${before.position}`)
        await setKeyboard(tab, kb)
        const open = await probe()
        if (open.kbd !== 'open') issues.push(`假键盘打开后 data-kbd 应是 open,实际 ${open.kbd}`)
        if (!phone) {
          if (open.docked || open.position === 'fixed') issues.push(`平板 / 桌面不该把工具栏贴到键盘上:docked=${open.docked} position=${open.position}`)
          return issues
        }
        if (!open.docked || open.position !== 'fixed') issues.push(`手机键盘打开后工具栏应贴键盘:docked=${open.docked} position=${open.position}`)
        const bar = await settled(tab, P.bar)
        const visibleBottom = size.height - kb
        if (!bar || Math.abs(bar.bottom - visibleBottom) > 1) issues.push(`工具栏下沿应等于可视视口下沿 ${visibleBottom},实际 ${bar?.bottom}`)
        if (bar && (Math.abs(bar.left) > 1 || Math.abs(bar.right - size.width) > 1)) issues.push(`工具栏应铺满屏宽:${bar.left}–${bar.right}`)
        if (bar && bar.height > 64) issues.push(`工具栏应是单行(≤64px 高),实际 ${bar.height}px`)
        if (open.bodyOffset !== before.bodyOffset) issues.push(`键盘弹出后正文不该上跳:偏移 ${before.bodyOffset} → ${open.bodyOffset}`)
        if (bar && Math.abs(Number.parseFloat(open.reserve) - bar.height) > 1) issues.push(`--kbd-reserve 应等于工具栏高度 ${bar.height},实际 ${open.reserve}`)
        const tools = await tab.evaluate((p) => {
          const bar = document.querySelector(p.bar)
          const small = [...bar.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5 }).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
          return { small, scrollable: bar.scrollWidth > bar.clientWidth + 1, overflowX: getComputedStyle(bar).overflowX, wrap: getComputedStyle(bar).flexWrap, coarse: matchMedia('(pointer: coarse)').matches, more: !!bar.querySelector('[data-testid="editor-toolbar-more"]') }
        }, P)
        if (tools.coarse && tools.small.length) issues.push(`触屏工具栏按钮不足 44px:${tools.small.join(',')}`)
        if (tools.wrap !== 'nowrap') issues.push(`工具栏应单行:wrap=${tools.wrap}`)
        if (size.width < 600 && !tools.more) issues.push('窄屏上一行放不下,多出来的按钮应收进「更多」')
        // 光标行不被盖住:在文末新起一行,最后一段的下沿要在工具栏上沿之上、上沿要在屏内
        await tab.keyboard.press('Control+End')
        await tab.keyboard.insertText('光标行在这里')
        await tab.keyboard.press('Enter')
        await tab.keyboard.insertText('最后一行')
        await tab.waitForTimeout(400)
        const last = await rectOf(tab, `${PM} > p:last-of-type`)
        const barNow = await rectOf(tab, P.bar)
        if (!last || !barNow) issues.push('找不到最后一段或工具栏')
        else {
          if (last.bottom > barNow.top + 0.5) issues.push(`光标行被工具栏盖住:最后一段下沿 ${last.bottom} > 工具栏上沿 ${barNow.top}`)
          if (last.top < 0) issues.push(`光标行滚出了屏幕上方:${last.top}`)
        }
        // 下拉菜单往上展开,整个落在工具栏上方、屏幕之内
        const opened = await openInsertMenu(tab, P)
        const menu = await settled(tab, opened.menu)
        if (!menu) issues.push('点「插入」没有弹出菜单')
        else {
          if (menu.bottom > barNow.top + 1) issues.push(`菜单应在工具栏上方:菜单下沿 ${menu.bottom} > 工具栏上沿 ${barNow.top}`)
          if (menu.top < -0.5) issues.push(`菜单顶部超出屏幕:${menu.top}`)
          if (menu.right > size.width + 0.5 || menu.left < -0.5) issues.push(`菜单横向超出屏幕:${menu.left}–${menu.right}`)
          // 菜单比可见区高(横屏键盘弹出后只剩一小截)时要能在菜单内部滚到最后一项,不能被裁掉
          const reach = await tab.evaluate((o) => {
            const el = document.querySelector(o.menu)
            const tall = el.scrollHeight > el.clientHeight + 1
            el.scrollTop = el.scrollHeight
            const last = [...el.querySelectorAll(o.item.slice(o.menu.length).trim())].at(-1).getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return { tall, overflowY: getComputedStyle(el).overflowY, lastBottom: last.bottom, boxBottom: box.bottom }
          }, opened)
          if (reach.tall && !/auto|scroll/.test(reach.overflowY)) issues.push(`菜单比可见区高,应能在内部滚动:overflow-y=${reach.overflowY}`)
          if (reach.lastBottom > reach.boxBottom + 1) issues.push(`滚到底后最后一项仍被裁掉:${reach.lastBottom} > ${reach.boxBottom}`)
          const items = await tab.evaluate((sel) => [...document.querySelectorAll(sel)].map((i) => i.getBoundingClientRect().height), opened.item)
          if (tools.coarse && items.some((h) => h < 43.5)) issues.push(`菜单项应 ≥44px 高:${items.map(Math.round)}`)
        }
        await tab.keyboard.press('Escape')
        return issues
      },
    },
    [name('editor-toolbar-release')]: {
      // 键盘收起:工具栏回到顶部,占位消失,标签栏回来
      ...NEW_DOC,
      init: FAKE_VISUAL_VIEWPORT,
      assert: async (tab, size) => {
        const issues = []
        const kb = keyboardHeight(size)
        await fillLines(tab, 12)
        await tab.keyboard.press('Control+Home')
        const probe = () =>
          tab.evaluate((p) => ({
            position: getComputedStyle(document.querySelector(p.bar)).position,
            spacer: !!document.querySelector(p.spacer),
            bodyOffset: document.querySelector(p.body).offsetTop,
            reserve: document.documentElement.style.getPropertyValue('--kbd-reserve'),
          }), P)
        const before = await probe()
        await setKeyboard(tab, kb)
        const during = await probe()
        await setKeyboard(tab, 0)
        const after = await probe()
        if (isPhoneLike(size) && (during.position !== 'fixed' || !during.spacer)) issues.push(`手机键盘打开时应贴键盘并留占位:${JSON.stringify(during)}`)
        if (after.position === 'fixed' || after.spacer) issues.push(`键盘收起后应回到顶栏、占位消失:${JSON.stringify(after)}`)
        if (after.bodyOffset !== before.bodyOffset) issues.push(`收起后正文偏移应还原:${before.bodyOffset} → ${after.bodyOffset}`)
        if (Number.parseFloat(after.reserve) !== 0) issues.push(`收起后 --kbd-reserve 应归零,实际 ${after.reserve}`)
        return issues
      },
    },
    [name('editor-sheet-slash')]: {
      // 斜杠菜单:手机(宽度 <600 或触屏)上是贴键盘上沿的底部面板——不超过可视高度的 40%、行高 ≥44px、可滚到最后一项、光标行在它上面;
      // 点一项后焦点仍在编辑器、键盘不收起。有鼠标的桌面保持跟随光标的浮层。
      ...NEW_DOC,
      init: FAKE_VISUAL_VIEWPORT,
      assert: async (tab, size) => {
        const issues = []
        const sheet = await wantsSheet(tab)
        const kb = keyboardHeight(size)
        await fillLines(tab, 14)
        if (sheet) await setKeyboard(tab, kb)
        await tab.keyboard.type('/')
        await waitSlash(tab, P, issues)
        const menu = await settled(tab, P.slash)
        if (!menu) return [...issues, '找不到斜杠菜单']
        const info = await tab.evaluate((p) => {
          const el = document.querySelector(p.slash)
          const rows = [...el.querySelectorAll('.kb-slash-item')].map((li) => li.getBoundingClientRect().height)
          // 整个菜单就是滚动容器、没有分组页签
          const groups = el
          const root = document.querySelector(p.dockRoot)
          const bar = document.querySelector(p.bar)
          return {
            position: getComputedStyle(el).position,
            sheetClass: el.classList.contains('is-sheet'),
            rows,
            tabs: 'none',
            scrollable: groups.scrollHeight > groups.clientHeight + 1,
            overflowY: getComputedStyle(groups).overflowY,
            barTop: root.classList.contains('is-docked') ? bar.getBoundingClientRect().top : null,
          }
        }, P)
        if (!sheet) {
          if (info.sheetClass || info.position !== 'fixed') issues.push(`有鼠标的桌面菜单应跟随光标浮动:class=${info.sheetClass} position=${info.position}`)
          if (menu.width >= size.width - 2) issues.push(`桌面菜单不该铺满屏宽:${menu.width}`)
        } else {
          const visibleBottom = size.height - kb
          const expectBottom = info.barTop ?? visibleBottom
          if (!info.sheetClass || info.position !== 'fixed') issues.push(`手机 / 触屏菜单应是底部面板:class=${info.sheetClass} position=${info.position}`)
          if (Math.abs(menu.bottom - expectBottom) > 1) issues.push(`面板下沿应贴在${info.barTop === null ? '键盘' : '工具栏'}上沿 ${expectBottom},实际 ${menu.bottom}`)
          if (Math.abs(menu.left) > 1 || Math.abs(menu.right - size.width) > 1) issues.push(`面板应铺满屏宽:${menu.left}–${menu.right}`)
          if (menu.top < -0.5) issues.push(`面板顶部超出屏幕:${menu.top}`)
          // 最多占可视高度的 40%;横屏键盘弹出后可视高度太小(<250),至少给 100px 才放得下两行
          const cap = Math.max(100, visibleBottom * 0.4)
          if (menu.height > cap + 1) issues.push(`面板高 ${Math.round(menu.height)} 超过可视高度 ${visibleBottom} 的 40%(${Math.round(cap)})`)
          if (!info.rows.length || info.rows.some((h) => h < 43.5)) issues.push(`菜单项应 ≥44px 高:${info.rows.map(Math.round)}`)
          if (info.tabs !== 'none') issues.push('底部面板里分组页签应省掉(给菜单项让高度)')
          if (!/auto|scroll/.test(info.overflowY)) issues.push(`菜单项应能在面板内滚动:overflow-y=${info.overflowY}`)
          // 菜单项只能在面板里滚,不能溢出面板;工具栏(坐在面板下面)的中心点上最上层必须是工具栏自己
          const reach = await tab.evaluate((p) => {
            const el = document.querySelector(p.slash)
            const groups = el
            groups.style.scrollBehavior = 'auto'
            const frame = el.getBoundingClientRect()
            const clip = groups.getBoundingClientRect()
            const out = { frameBottom: frame.bottom, clipBottom: clip.bottom, clipTop: clip.top, frameTop: frame.top, scrollable: groups.scrollHeight > groups.clientHeight + 1 }
            groups.scrollTop = groups.scrollHeight
            const last = [...el.querySelectorAll('.kb-slash-item')].at(-1).getBoundingClientRect()
            out.lastBottom = last.bottom
            const bar = document.querySelector(`${p.dockRoot}.is-docked ${p.bar}`) ?? document.querySelector(`.is-docked ${p.bar}`)
            if (bar) {
              const b = bar.getBoundingClientRect()
              const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
              out.barCovered = !bar.contains(top) ? `${top?.tagName}.${String(top?.className).slice(0, 30)}` : ''
            }
            return out
          }, P)
          if (reach.clipBottom > reach.frameBottom + 1 || reach.clipTop < reach.frameTop - 1) issues.push(`菜单项列表溢出了面板外框:列表 ${Math.round(reach.clipTop)}–${Math.round(reach.clipBottom)},外框 ${Math.round(reach.frameTop)}–${Math.round(reach.frameBottom)}`)
          if (!reach.scrollable) issues.push('菜单项比面板高,列表应能滚动')
          if (reach.lastBottom > reach.frameBottom + 1) issues.push(`滚到底后最后一项仍在面板之外:${Math.round(reach.lastBottom)} > ${Math.round(reach.frameBottom)}`)
          if (reach.barCovered) issues.push(`菜单盖住了下面的工具栏,最上层是 ${reach.barCovered}`)
          await tab.evaluate((p) => (document.querySelector(p.slash).scrollTop = 0), P)
          // 光标行(刚输入 / 的那一段)在面板上面,没被盖住
          await tab.waitForTimeout(250)
          const caret = await rectOf(tab, `${PM} > p:last-of-type`)
          const menuNow = await rectOf(tab, P.slash)
          if (!caret) issues.push('找不到光标所在段落')
          else if (await roomForCaretAbove(tab, menuNow.top)) {
            if (caret.bottom > menuNow.top + 0.5) issues.push(`光标行被菜单盖住:光标行下沿 ${caret.bottom} > 面板上沿 ${menuNow.top}`)
            if (caret.top < 0) issues.push(`光标行滚出了屏幕上方:${caret.top}`)
          }
        }
        // 点「标题 1」:执行、菜单收起、焦点仍在编辑器(键盘不收起)
        await tapCenter(tab, tab.locator(P.slashItem, { hasText: '一级标题' }).first())
        await tab.waitForTimeout(300)
        if ((await slashStateOf(tab, P)).shown) issues.push('点选菜单项后菜单应收起')
        if (!text(await blocksOf(tab)).includes('<h1>')) issues.push(`点「标题 1」应把当前段变成一级标题:${text(await blocksOf(tab)).slice(-80)}`)
        const focus = await focusState(tab)
        if (!focus.inEditor) issues.push(`选中菜单项后焦点应仍在编辑器里,实际 ${focus.active}`)
        if (sheet && focus.kbd !== 'open') issues.push(`选中菜单项后键盘不该收起(data-kbd=${focus.kbd})`)
        return issues
      },
    },
    [name('editor-sheet-picker')]: {
      // `[[` 笔记选择器:手机(宽度 <600 或触屏)上是贴键盘上沿的底部面板;搜索框在输入、结果行 ≥44px、可滚;选一项后焦点回到编辑器、键盘不收起。
      ...NEW_DOC,
      init: FAKE_VISUAL_VIEWPORT,
      assert: async (tab, size) => {
        const issues = []
        const sheet = await wantsSheet(tab)
        const kb = keyboardHeight(size)
        await fillLines(tab, 14)
        if (sheet) await setKeyboard(tab, kb)
        await tab.keyboard.type('参见 [[')
        const open = await tab.waitForSelector(P.picker, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!open) return ['输入 [[ 没有弹出笔记选择器']
        await tab.waitForSelector(P.pickerItem, { timeout: 4000 }).catch(() => issues.push('选择器没有结果'))
        const picker = await settled(tab, P.picker)
        const info = await tab.evaluate((p) => {
          const el = document.querySelector(p.picker)
          const input = el.querySelector(p.pickerInput)
          const list = el.querySelector(p.pickerList)
          const root = document.querySelector(p.dockRoot)
          const bar = document.querySelector(p.bar)
          return {
            position: getComputedStyle(el).position,
            sheetClass: el.classList.contains('is-sheet'),
            rows: [...el.querySelectorAll(p.pickerItem)].map((li) => li.getBoundingClientRect().height),
            inputHeight: input.getBoundingClientRect().height,
            inputFocused: document.activeElement === input,
            overflowY: getComputedStyle(list).overflowY,
            barTop: root.classList.contains('is-docked') ? bar.getBoundingClientRect().top : null,
          }
        }, P)
        if (!info.inputFocused) issues.push('选择器的搜索框应拿到焦点(接着打字就是搜索)')
        if (!sheet) {
          if (info.sheetClass || info.position !== 'fixed' || picker.width >= size.width - 2) issues.push(`桌面选择器应是跟随光标的浮层:sheet=${info.sheetClass} width=${picker.width}`)
          // 浮层必须整个在视口里(旧编辑器的选择器贴着窗口下沿时会被挤出视口,够不着)
          if (picker.bottom > size.height + 0.5 || picker.top < -0.5) issues.push(`选择器超出了视口:${Math.round(picker.top)}–${Math.round(picker.bottom)} / ${size.height}`)
        } else {
          const visibleBottom = size.height - kb
          const expectBottom = info.barTop ?? visibleBottom
          if (!info.sheetClass) issues.push('手机 / 触屏选择器应是底部面板')
          if (Math.abs(picker.bottom - expectBottom) > 1) issues.push(`面板下沿应贴在${info.barTop === null ? '键盘' : '工具栏'}上沿 ${expectBottom},实际 ${picker.bottom}`)
          if (Math.abs(picker.left) > 1 || Math.abs(picker.right - size.width) > 1) issues.push(`面板应铺满屏宽:${picker.left}–${picker.right}`)
          if (picker.top < -0.5) issues.push(`面板顶部超出屏幕:${picker.top}`)
          const cap = Math.max(100, visibleBottom * 0.4)
          if (picker.height > cap + 1) issues.push(`面板高 ${Math.round(picker.height)} 超过可视高度 ${visibleBottom} 的 40%(${Math.round(cap)})`)
          if (!info.rows.length || info.rows.some((h) => h < 43.5)) issues.push(`结果行应 ≥44px 高:${info.rows.map(Math.round)}`)
          if (info.inputHeight < 43.5 && (await tab.evaluate(() => matchMedia('(pointer: coarse)').matches))) issues.push(`搜索框应 ≥44px 高:${info.inputHeight}`)
          if (!/auto|scroll/.test(info.overflowY)) issues.push(`结果应能在面板内滚动:overflow-y=${info.overflowY}`)
          await tab.waitForTimeout(250)
          const caret = await rectOf(tab, `${PM} > p:last-of-type`)
          const pickerNow = await rectOf(tab, P.picker)
          if (!caret) issues.push('找不到光标所在段落')
          else if (await roomForCaretAbove(tab, pickerNow.top)) {
            if (caret.bottom > pickerNow.top + 0.5) issues.push(`光标行被选择器盖住:光标行下沿 ${caret.bottom} > 面板上沿 ${pickerNow.top}`)
            if (caret.top < 0) issues.push(`光标行滚出了屏幕上方:${caret.top}`)
          }
        }
        // 点第二项:插入双链、选择器收起、焦点回到编辑器
        const title = (await tab.locator(`${P.pickerItem} ${P.pickerTitle}`).nth(1).innerText()).trim()
        await tapCenter(tab, tab.locator(P.pickerItem).nth(1))
        await tab.waitForTimeout(300)
        if (await tab.locator(P.picker).count()) issues.push('点选结果后选择器应收起')
        const body = text(await blocksOf(tab))
        if (!/\[\[[^|\]]+\|[^\]]+\]\]/.test(body) || !body.includes(title.slice(0, 4))) issues.push(`应插入所点那一项的双链(${title}):${body.slice(-100)}`)
        const focus = await focusState(tab)
        if (!focus.inEditor) issues.push(`选中后焦点应回到编辑器,实际 ${focus.active}`)
        if (sheet && focus.kbd !== 'open') issues.push(`选中后键盘不该收起(data-kbd=${focus.kbd})`)
        return issues
      },
    },
    [name('editor-sheet-shot')]: {
      // 只为截图:手机上打开斜杠菜单后停住(editor-sheet-slash 的断言最后会点掉菜单)。同时验证没有横向溢出。
      ...NEW_DOC,
      init: FAKE_VISUAL_VIEWPORT,
      sizes: ['390x844', '844x390', '820x1180'],
      assert: async (tab, size) => {
        const issues = []
        await fillLines(tab, 8)
        await setKeyboard(tab, keyboardHeight(size))
        await tab.keyboard.type('/')
        await waitSlash(tab, P, issues, '没有弹出菜单')
        await settled(tab, P.slash)
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        if (overflow > 1) issues.push(`打开菜单后整页横向溢出 ${overflow}px`)
        return issues
      },
    },
    [name('editor-link-tool')]: {
      // 工具栏「链接」:选中文字点它 → 打开链接输入框,输入地址回车 → 变成链接;再选中链接 → 移除。不能抛错
      // 旧编辑器是 Crepe 的浮层(再点一下移除);新文本面是外壳里的链接条(光标在链接里时回填地址,有「移除链接」)
      ...NEW_DOC,
      sizes: ['390x844', '1440x900'],
      assert: async (tab) => {
        const issues = []
        await tab.keyboard.type('链接文字')
        await tab.keyboard.press('Shift+Home')
        await clickTool(tab, P, 'link')
        const input = '[data-testid="editor-link-input"]'
        const edit = await tab.waitForSelector(input, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!edit) {
          issues.push('点「链接」没有打开链接输入框')
          return issues
        }
        // 输入框出现不等于已经拿到焦点:机器忙时现在就打字,字会进到编辑器里
        const focused = await tab.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'editor-link-input', null, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!focused) issues.push('链接输入框出现后应自动拿到焦点')
        await tab.locator(input).fill('https://example.com/a')
        await tab.keyboard.press('Enter')
        await tab.waitForFunction((sel) => !!document.querySelector(`${sel} a[href="https://example.com/a"]`), PM, { timeout: 3000 }).catch(() => issues.push('输入地址回车后正文里没有出现链接'))
        const linkText = await tab.evaluate((sel) => document.querySelector(`${sel} a`)?.textContent ?? '', PM)
        if (linkText !== '链接文字') issues.push(`链接文字应是「链接文字」,实际「${linkText}」`)
        // 选中链接 → 移除。上一步只等到 <a> 出现;机器忙时它的文字可能还没就绪,先等 <a> 稳定存在再选
        const linked = await tab.waitForSelector(`${PM} a`, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!linked) {
          issues.push('找不到刚建好的链接,无法继续验证「移除」')
          return issues
        }
        await tab.evaluate((sel) => {
          const a = document.querySelector(`${sel} a`)
          if (!a) throw new Error('链接在选中前消失了')
          const range = document.createRange()
          range.selectNodeContents(a)
          const selection = getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
        }, PM)
        await clickTool(tab, P, 'link')
        // 光标在已有链接里:链接条回填现有地址,点「移除链接」去掉(保留文字)
        const prefilled = await tab.waitForFunction(() => document.querySelector('[data-testid="editor-link-input"]')?.value === 'https://example.com/a', null, { timeout: 3000 }).then(() => true).catch(() => false)
        if (!prefilled) issues.push('光标在链接里点「链接」,输入框应回填现有地址')
        await tab.click('[data-testid="editor-link-remove"]')
        await tab.waitForFunction((sel) => !document.querySelector(`${sel} a`), PM, { timeout: 3000 }).catch(() => issues.push('选中链接后应能移除链接'))
        const kept = await tab.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', PM)
        if (!kept.includes('链接文字')) issues.push(`移除链接应保留文字:${kept}`)
        return issues
      },
    },
  }
}

/** 统一外壳文本面的手机 / 平板场景（场景名不带后缀） */
export const EDITOR_MOBILE_SCENARIOS = {
  ...scenariosFor(PATHS.native),
}
