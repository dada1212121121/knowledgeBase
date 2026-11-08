// 知识库页的平板版面(设计规范)场景。由 viewer-shots.mjs 引入。
//   <600 单栏(列表 / 文档分两屏) · 600–839 两栏(目录栏可收起,选中文档后自动收起) · 840–1279 三栏(目录 | 文档 | 右侧栏)
// 默认跑 core 尺寸里的 820×1180 / 1180×820;完整的平板组:KB_DEVICE_GROUP=tablet(744×1133、800×1280、820×1180、1180×820、1024×1366),
// 折叠屏 673×841 用 KB_SIZES=673x841。两个引擎都要跑:KB_ENGINE=webkit。
import { overflowIssues } from './admin-scenarios.mjs'
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { smallTargets } from './share-scenarios.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const LIST = `/kb?collection=${COLLECTION}`
const DOC = `${LIST}&item=ins_8f21`

/** 元素当前的位置;不存在或被藏起来(display:none / 0 大小)返回 null */
const box = (tab, selector) =>
  tab.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const style = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) return null
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }, selector)

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance

async function touchIssues(tab, selector, label) {
  const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) return []
  return (await smallTargets(tab, selector)).map((item) => `${label}触屏可点区域不足 44px:${item}`)
}

/** 文档标题(阅读态是 h1,编辑态是 textarea) */
const docTitle = (tab) =>
  tab.evaluate(() => {
    const el = document.querySelector('.kb-dp-title')
    return (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el?.textContent ?? '').trim()
  })

const waitDoc = (tab) => tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h2', { timeout: 15_000 })

/**
 * 旋转 / 分屏 / 拖窗口场景（只剩统一外壳这一条路径；原来的 `-legacy` 变体跑的是已删除的旧编辑器）。
 * 断言只看“正文还在、滚动位置还在、没有溢出”。
 */
function tabletRotate(query) {
  return {
    // 旋转 / 分屏 / 拖窗口:布局实时切换,正在编辑的内容、滚动位置、打开的文档都不丢
    route: `${DOC}${query}`,
    ready: '.kb-workspace-bar-right',
    sizes: ['820x1180', '1180x820'],
    // 单人编辑:去掉「多人在线编辑」功能点,编辑器不用等协作房间(本场景只关心版面切换,不关心协作)
    fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) } },
    prepare: async (tab) => {
      await tab.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('kb.draft.')).forEach((key) => localStorage.removeItem(key)))
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
      // 在末尾写一个能认出来的标记,再写足够多的段落让正文能滚动
      await tab.click(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) > p:last-of-type')
      // 点击 / Ctrl+End 移动了浏览器的光标，ProseMirror 要等 selectionchange 才同步；零间隔紧接着按 Enter 会落在旧位置（文档开头）。
      // 真人不会 2ms 内连按，两条路径都等一下
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Control+End')
      await tab.waitForTimeout(150)
      await tab.keyboard.press('Enter')
      await tab.keyboard.insertText('旋转前写下的内容-MARK')
      for (let index = 1; index <= 45; index += 1) {
        await tab.keyboard.press('Enter')
        await tab.keyboard.insertText(`第 ${index} 段:这一段用来撑出滚动条。`)
      }
    },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      // 找到正文外面真正在滚动的那一层,打上标记(用下标定位会被布局切换时增减的节点带偏)
      const marked = await tab.evaluate(() => {
        for (let el = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')?.parentElement; el; el = el.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 40) {
            el.setAttribute('data-test-scroller', '1')
            return true
          }
        }
        return false
      })
      if (!marked) return ['写了 45 段之后正文应该能滚动(找不到可滚动的容器)']
      // 滚到第 30 段居中。切版面时浏览器会按「锚点」微调 scrollTop(页面上方的内容变高变矮),
      // 所以不比数值,比「用户看着的那一段还在不在屏里」;滚动容器被重建的话会回到顶部,第 30 段就不在屏里了
      await tab.evaluate(() => {
        const para = [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')].find((el) => el.textContent?.startsWith('第 30 段'))
        para?.scrollIntoView({ block: 'center' })
      })
      await tab.waitForTimeout(150)
      const inView = () =>
        tab.evaluate(() => {
          const para = [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')].find((el) => el.textContent?.startsWith('第 30 段'))
          const scroller = document.querySelector('[data-test-scroller]')
          if (!para || !scroller) return { found: false, visible: false, top: -1 }
          const p = para.getBoundingClientRect()
          const s = scroller.getBoundingClientRect()
          return { found: true, visible: p.bottom > s.top + 1 && p.top < s.bottom - 1, top: scroller.scrollTop }
        })
      const start = await inView()
      if (!start.visible || start.top < 200) return [`第 30 段没滚到屏里:${JSON.stringify(start)}`]

      // 先把滚到的位置落在「第 30 段居中」,每一步之前都重新居中:各档宽度的换行不同,
      // 同一个 scrollTop 在不同宽度下指向不同的段,所以比的是「读者看着的那一段还在不在屏里」。
      // 其中 744(目录栏展开)→ 390 是 iPad 分屏缩到三分之一:旧写法下那一帧会拿两栏的类名排 390 宽,正文被挤成窄条,阅读位置被浏览器挪走
      const steps = [
        [1180, 820],
        [744, 1133, 'open-dir'],
        [390, 844],
        [1024, 1366],
        [744, 1133, 'open-dir'],
        [820, 1180],
        [599, 1133],
        [size.width, size.height],
      ]
      for (const [width, height, flag] of steps) {
        if (flag === 'open-dir') {
          // 目录栏展开着的两栏:从这里直接缩到手机宽度
          await tab.setViewportSize({ width, height })
          await tab.waitForTimeout(350)
          const toggle = tab.locator('[data-testid=dir-toggle]')
          if (await toggle.count()) await toggle.click()
          await tab.waitForTimeout(250)
          if (!(await box(tab, '.kb-sidebar'))) issues.push('展开目录栏后应看到列表')
          await tab.evaluate(() => [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')].find((el) => el.textContent?.startsWith('第 30 段'))?.scrollIntoView({ block: 'center' }))
          await tab.waitForTimeout(150)
          continue
        }
        await tab.evaluate(() => [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')].find((el) => el.textContent?.startsWith('第 30 段'))?.scrollIntoView({ block: 'center' }))
        await tab.waitForTimeout(100)
        await tab.setViewportSize({ width, height })
        await tab.waitForTimeout(450)
        const where = `${width}×${height}`
        const state = await tab.evaluate(() => {
          const pm = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')
          const r = pm?.getBoundingClientRect()
          return {
            editable: pm?.getAttribute('contenteditable'),
            text: pm?.textContent ?? '',
            left: r?.left ?? -1,
            right: r?.right ?? -1,
            width: r?.width ?? 0,
            item: new URL(location.href).searchParams.get('item'),
            overflow: document.documentElement.scrollWidth - innerWidth,
          }
        })
        if (!state.text.includes('旋转前写下的内容-MARK') || !state.text.includes('第 45 段')) issues.push(`${where}:编辑中的内容丢了`)
        if (state.editable !== 'true') issues.push(`${where}:编辑状态丢了(contenteditable=${state.editable})`)
        if (state.item !== 'ins_8f21') issues.push(`${where}:打开的文档变了(${state.item})`)
        if (state.width < 250 || state.left < -1 || state.right > width + 1) issues.push(`${where}:正文不在屏内 ${Math.round(state.left)}–${Math.round(state.right)}`)
        if (state.overflow > 1) issues.push(`${where}:横向溢出 ${state.overflow}px`)
        const view = await inView()
        if (!view.found) issues.push(`${where}:正文里找不到第 30 段了`)
        else if (!view.visible || view.top < 100) issues.push(`${where}:滚动位置丢了(第 30 段不在屏里,scrollTop=${Math.round(view.top)})`)
        // 每一档该看到的栏
        const side = await box(tab, '.kb-sidebar')
        const back = await box(tab, '[aria-label=返回列表]')
        if (width < 600) {
          if (side) issues.push(`${where}:手机宽度下正在看文档,目录栏不该同屏`)
          if (!back) issues.push(`${where}:手机宽度下文档里应有「返回列表」`)
        } else if (back) issues.push(`${where}:≥600 不该有「返回列表」`)
        if (width >= 1024 && !(await box(tab, '.kb-inspector-panel'))) issues.push(`${where}:平板横屏 / 竖屏应是三栏,右侧栏不见了`)
        if (width < 1024 && (await box(tab, '.kb-inspector-panel'))) issues.push(`${where}:<1024 右侧栏不该自己冒出来盖住正在编辑的文档`)
      }
      // 手机上点「返回列表」能回到列表,再选回同一篇(没有保存也没丢)
      await tab.setViewportSize({ width: 390, height: 844 })
      await tab.waitForTimeout(400)
      await tab.locator('[aria-label=返回列表]').click()
      await tab.waitForTimeout(300)
      if (!(await box(tab, '.kb-sidebar'))) issues.push('手机上点「返回列表」应看到列表')
      await tab.setViewportSize({ width: size.width, height: size.height })
      await tab.waitForTimeout(400)
      const text = await tab.evaluate(() => document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')?.textContent ?? '')
      if (!text.includes('旋转前写下的内容-MARK')) issues.push('回到列表再转回来,编辑中的内容丢了')
      return issues
    },

  }
}

export const TABLET_SCENARIOS = {
  'tablet-two-pane': {
    // 600–839(竖屏小平板 / 折叠屏 / 分屏半宽):目录栏 + 文档两栏;选中文档后目录栏自动收起,「列表」按钮能再展开
    route: LIST,
    ready: '[data-testid^=list-row-]',
    sizes: ['673x841', '744x1133', '800x1280', '820x1180'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const hasCoarse = size.touch
      // 1. 还没打开文档:目录栏 + 空的文档区,并排两栏
      const side = await box(tab, '.kb-sidebar')
      const main = await box(tab, '.kb-workspace-main')
      if (!side || !main) return ['没打开文档时应是目录栏 + 文档区两栏']
      if (side.right > main.left + 1) issues.push(`两栏不该重叠:目录栏右缘 ${side.right},文档区左缘 ${main.left}`)
      if (side.width < 240 || side.width > 301) issues.push(`目录栏宽度应在 240–300,实际 ${Math.round(side.width)}`)
      if (main.width < 300) issues.push(`文档区太窄 ${Math.round(main.width)}`)
      if (await box(tab, '.kb-inspector-panel')) issues.push('两栏版面不该默认展开右侧栏')
      // 全站统一顶栏在平板 / 桌面保留(7fd46935,手机 ≤599px 进文档才隐藏);两栏版面里它和文档自己的顶栏各一条,不该再叠出第三条
      const bars = await tab.evaluate(() => [...document.querySelectorAll('.kb-workspace-bar, .kb-topbar, .mbar')].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).length)
      if (!(await box(tab, '.kb-topbar'))) issues.push('平板两栏版面应保留全站顶栏')
      if (bars !== 2) issues.push(`两栏版面顶部横条应是 全站顶栏 + 文档顶栏 共 2 条,实际 ${bars} 条`)
      if (await tab.locator('[aria-label=返回列表]').count()) issues.push('两栏版面里列表就在旁边,不该有「返回列表」')
      if (hasCoarse) issues.push(...(await touchIssues(tab, '.kb-sidebar button, .kb-sidebar a[href], .kb-sidebar input, .kb-sidebar .kb-sidebar-item', '目录栏')))

      // 2. 选中文档 → 目录栏自动收起,文档独占整宽;「列表」按钮出现
      const rows = tab.locator('[data-testid^=list-row-]')
      await rows.nth(0).click()
      await waitDoc(tab)
      await tab.waitForTimeout(200)
      if (await box(tab, '.kb-sidebar')) issues.push('选中文档后目录栏应自动收起')
      const alone = await box(tab, '.kb-workspace-main')
      if (!alone || !near(alone.left, 0) || !near(alone.right, size.width)) issues.push(`收起目录栏后文档应占满整宽,实际 ${alone?.left}–${alone?.right}`)
      const toggle = await box(tab, '[data-testid=dir-toggle]')
      if (!toggle) return [...issues, '目录栏收起后应有「列表」按钮']
      if (!(await tab.locator('[data-testid=dir-toggle]').innerText()).includes('列表')) issues.push('「列表」按钮应带文字,不能只是个图标')
      if (hasCoarse) issues.push(...(await touchIssues(tab, '.kb-workspace-bar button, .kb-workspace-bar a[href]', '文档顶栏')))
      const first = await docTitle(tab)
      if (!first) issues.push('文档标题没出来')

      // 3. 点「列表」展开 → 并排两栏,文档还在
      await tab.locator('[data-testid=dir-toggle]').click()
      await tab.waitForTimeout(200)
      const reopened = await box(tab, '.kb-sidebar')
      const shrunk = await box(tab, '.kb-workspace-main')
      if (!reopened || !shrunk) issues.push('点「列表」后应展开目录栏')
      else if (!near(shrunk.left, reopened.right) || shrunk.width < 300) issues.push(`展开后应是并排两栏:目录栏 ${reopened.left}–${reopened.right},文档 ${shrunk.left}–${shrunk.right}`)
      if ((await docTitle(tab)) !== first) issues.push('展开目录栏不该换掉正在看的文档')

      // 4. 再选另一篇 → 又自动收起(每次选中都收,不是只收一次)
      await rows.nth(1).click()
      await tab.waitForFunction((was) => (document.querySelector('.kb-dp-title')?.textContent ?? '').trim() !== was, first, { timeout: 8000 }).catch(() => issues.push('选第二篇后文档没有换'))
      await tab.waitForTimeout(200)
      if (await box(tab, '.kb-sidebar')) issues.push('选第二篇后目录栏也应自动收起')

      // 5. 收尾:展开目录栏,让截图是「列表 + 文档」两栏
      await tab.locator('[data-testid=dir-toggle]').click()
      await tab.waitForTimeout(250)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tablet-three-pane': {
    // 840–1279(平板横屏 / 小笔记本 / iPad Pro 竖屏):目录 | 文档 | 右侧栏三栏;右侧栏、目录栏都能收起,选择会记住
    route: DOC,
    ready: '.kb-inspector-panel',
    sizes: ['1024x1366', '1180x820'],
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const nav = await box(tab, '.kb-nav-slot')
      const side = await box(tab, '.kb-sidebar')
      const content = await box(tab, '.kb-workspace-content')
      const insp = await box(tab, '.kb-inspector-panel')
      if (!nav || !side || !content || !insp) return ['平板横屏应是 导航 | 目录 | 文档 | 右侧栏']
      if (nav.width > 65) issues.push(`全局导航应是图标栏(≤64),实际 ${nav.width}`)
      if (side.right > content.left + 1) issues.push(`目录栏与文档重叠:${side.right} > ${content.left}`)
      if (content.right > insp.left + 1) issues.push(`文档与右侧栏重叠(应并排,不是盖住):${content.right} > ${insp.left}`)
      if (!near(insp.right, size.width)) issues.push(`右侧栏应贴着右缘,实际 ${insp.right} / ${size.width}`)
      if (content.width < 400) issues.push(`三栏时文档区只剩 ${Math.round(content.width)}px,读不了`)
      if (side.width > 265) issues.push(`平板上目录栏应封顶 264,实际 ${Math.round(side.width)}`)
      if (insp.width < 255 || insp.width > 321) issues.push(`右侧栏宽度应在 260–320,实际 ${Math.round(insp.width)}`)

      // 右侧栏的页签都要完整可见:评论被挤出去就等于没有右侧栏
      const tabs = await tab.evaluate(() =>
        [...document.querySelectorAll('.kb-inspector-panel [role=tab]')].map((el) => ({ text: (el.textContent ?? '').trim(), right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left })),
      )
      const panelRight = insp.right
      for (const label of ['信息', '关系', '历史版本', '评论']) {
        const found = tabs.find((item) => item.text.startsWith(label))
        if (!found) issues.push(`右侧栏缺「${label}」页签`)
        else if (found.right > panelRight + 1 || found.left < insp.left - 1) issues.push(`右侧栏的「${label}」页签被挤出可视区`)
      }
      issues.push(...(await touchIssues(tab, '.kb-inspector-panel button, .kb-inspector-panel [role=tab], .kb-workspace-bar button, .kb-sidebar button', '三栏')))

      // 属性表的值不能被切在栏外
      const clipped = await tab.evaluate(() => [...document.querySelectorAll('.kb-inspector-panel .kb-form > span')].filter((el) => el.getBoundingClientRect().right > (el.closest('.kb-inspector-panel')?.getBoundingClientRect().right ?? 0) + 1).length)
      if (clipped) issues.push(`右侧栏属性表有 ${clipped} 个值超出栏外`)

      // 收起右侧栏 → 文档区向右撑满;记住这个选择(刷新后仍收起,不会被「平板默认展开」盖掉)
      await tab.locator('[data-testid=inspector-close]').click()
      await tab.waitForTimeout(250)
      if (await box(tab, '.kb-inspector-panel')) issues.push('点「收起右侧栏」后应收起')
      const wide = await box(tab, '.kb-workspace-content')
      if (!wide || !near(wide.right, size.width)) issues.push(`收起右侧栏后文档应撑到右缘,实际 ${wide?.right}`)
      if ((await tab.evaluate(() => localStorage.getItem('kb.browser.inspectorOpen'))) !== '0') issues.push('收起右侧栏应记住(localStorage 写 0)')
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-workspace-bar', { timeout: 15_000 })
      await tab.waitForTimeout(400)
      if (await box(tab, '.kb-inspector-panel')) issues.push('用户收起过右侧栏,刷新后不该又默认展开')

      // 属性按钮再展开
      await tab.getByRole('button', { name: '属性', exact: true }).click()
      await tab.waitForSelector('.kb-inspector-panel', { timeout: 5000 }).catch(() => issues.push('点「属性」应展开右侧栏'))
      // 评论页签能点开
      await tab.locator('.kb-inspector-panel [role=tab]', { hasText: '评论' }).click()
      await tab.waitForTimeout(250)
      if ((await tab.locator('.kb-inspector-panel [role=tab][aria-selected=true]').innerText()).indexOf('评论') < 0) issues.push('点「评论」后该页签应被选中')

      // 目录栏收起 → 两栏(文档 | 右侧栏),再展开
      await tab.getByRole('button', { name: '收起侧栏' }).click()
      await tab.waitForTimeout(250)
      if (await box(tab, '.kb-sidebar')) issues.push('点「收起侧栏」后目录栏应收起')
      const grown = await box(tab, '.kb-workspace-content')
      if (!grown || grown.width <= content.width + 100) issues.push(`目录栏收起后文档应变宽:${content.width} → ${grown?.width}`)
      await tab.getByRole('button', { name: '展开目录' }).click()
      await tab.waitForTimeout(250)
      if (!(await box(tab, '.kb-sidebar'))) issues.push('点「展开目录」后目录栏应回来')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tablet-rotate': tabletRotate(''),
  'workbench-widths': {
    // 其余档位不能被平板改动带坏:手机仍是列表 / 文档二选一,电脑右侧栏默认收起(只有平板档默认展开)
    route: LIST,
    ready: '[data-testid^=list-row-]',
    sizes: ['390x844', '1440x900', '1920x1080'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 600) {
        const side = await box(tab, '.kb-sidebar')
        if (!side || !near(side.width, size.width)) issues.push(`手机:列表应占满整宽,实际 ${side?.width}`)
        if (await box(tab, '.kb-workspace-main')) issues.push('手机:没打开文档时不该同屏显示文档区')
        await tab.locator('[data-testid^=list-row-]').first().click()
        await waitDoc(tab)
        await tab.waitForTimeout(200)
        if (await box(tab, '.kb-sidebar')) issues.push('手机:进了文档,列表应让位')
        if (!(await box(tab, '[aria-label=返回列表]'))) issues.push('手机:文档里应有「返回列表」')
        if (await box(tab, '.kb-inspector-panel')) issues.push('手机:右侧栏不该默认展开')
        await tab.locator('[aria-label=返回列表]').click()
        await tab.waitForTimeout(250)
        if (!(await box(tab, '.kb-sidebar'))) issues.push('手机:点「返回列表」应回到列表')
      } else {
        await waitDoc(tab)
        if (!(await box(tab, '.kb-sidebar'))) issues.push('电脑:应有目录栏')
        if (await box(tab, '.kb-inspector-panel')) issues.push('电脑(≥1280):右侧栏应默认收起,只有平板档默认展开')
        await tab.getByRole('button', { name: '属性', exact: true }).click()
        await tab.waitForSelector('.kb-inspector-panel', { timeout: 5000 }).catch(() => issues.push('电脑:点「属性」应展开右侧栏'))
        const insp = await box(tab, '.kb-inspector-panel')
        const content = await box(tab, '.kb-workspace-content')
        if (insp && content && content.right > insp.left + 1) issues.push('电脑:右侧栏应与文档并排')
        if (insp && !near(insp.width, 320)) issues.push(`电脑:右侧栏宽应是 320,实际 ${insp.width}`)
      }
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },
}
