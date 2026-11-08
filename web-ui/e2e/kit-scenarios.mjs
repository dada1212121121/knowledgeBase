// 组件包(响应式表格 / 批量条 / 表单字段 / 操作条 / 底部弹层 / 可滑动标签页)的 Playwright 场景。
// 宿主是示例页 /dev/kit(src/pages/KitGallery.vue)。由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
import { rect } from './shell-scenarios.mjs'

const isPhone = (size) => size.width < 600

/** 浏览器里发一个触屏指针事件(Playwright 的 mouse 是 pointerType=mouse,长按多选要触屏)。 */
const touch = (tab, selector, type, init = {}) =>
  tab.evaluate(
    ([sel, kind, extra]) => {
      const el = document.querySelector(sel)
      const box = el.getBoundingClientRect()
      el.dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: box.left + 20, clientY: box.top + 20, ...extra }))
    },
    [selector, type, init],
  )

export const KIT_SCENARIOS = {
  'kit-table': {
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const cards = await tab.locator('[data-testid=rt-card]').count()
      const rows = await tab.locator('[data-testid=rt-row]').count()
      if (isPhone(size)) {
        if (cards !== 5 || rows) issues.push(`手机应是 5 张卡片、没有表格,实际 卡片 ${cards} / 表格行 ${rows}`)
        const card = await tab.locator('[data-testid=rt-card]').first().innerText()
        if (!card.includes('部署清单') || !card.includes('所有者') || card.includes('清单.md')) issues.push(`卡片内容不对:${card.replace(/\n/g, ' | ')}`)
      } else if (rows !== 5 || cards) {
        issues.push(`桌面 / 平板应是 5 行表格,实际 表格行 ${rows} / 卡片 ${cards}`)
      }
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      // 长名字在卡片 / 单元格里不能撑破容器
      const tableBox = await rect(tab, '.kb-rt')
      const longName = await tab.locator('text=一个名字特别特别').first().boundingBox()
      if (tableBox && longName && longName.x + longName.width > tableBox.right + 1) issues.push('长名字超出了表格 / 卡片容器')

      if (isPhone(size)) {
        // 「选择」按钮进入多选 → 点卡片选中 → 批量条 → 删除
        await tab.getByRole('button', { name: '选择', exact: true }).click()
        if ((await tab.locator('.kb-rt-check').count()) !== 5) issues.push('进入多选后每张卡片应有复选框')
        await tab.locator('[data-testid=rt-card]').nth(1).click()
        await tab.locator('[data-testid=rt-card]').nth(3).click()
      } else {
        await tab.locator('[data-testid=rt-row] .kb-rt-check').nth(1).check()
        await tab.locator('[data-testid=rt-row] .kb-rt-check').nth(3).check()
      }
      const bar = tab.locator('[data-testid=batchbar]')
      if (!(await bar.isVisible())) return [...issues, '选中后应出现批量条']
      if (!(await bar.innerText()).includes('已选 2 项')) issues.push(`批量条应写「已选 2 项」,实际 ${await bar.innerText()}`)
      const barBox = await rect(tab, '[data-testid=batchbar]')
      const tabbar = await rect(tab, '.kb-tabbar')
      if (barBox.bottom > size.height + 1 || barBox.left < -1 || barBox.right > size.width + 1) issues.push(`批量条超出屏幕:${JSON.stringify(barBox)}`)
      if (tabbar && barBox.bottom > tabbar.top + 1) issues.push('批量条被底部标签栏盖住')
      for (const control of await bar.locator('button').all()) {
        const box = await control.boundingBox()
        // 触屏上小按钮视觉 36px、可点区域靠伪元素撑到 44px:这里量视觉高度 ≥36
        if (box && size.touch && box.height < 35.5) issues.push(`批量条按钮太矮:${box.height}`)
      }
      await bar.getByRole('button', { name: '删除' }).click()
      if ((await tab.locator('[data-testid=rt-row], [data-testid=rt-card]').count()) !== 3) issues.push('删除 2 项后应剩 3 项')
      if (await bar.isVisible().catch(() => false)) issues.push('删除后批量条应消失')
      return issues
    },
  },
  'kit-table-longpress': {
    // 手机:长按卡片进入多选并选中这一张;移动手指(在滚动)不触发;「完成」退出
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    sizes: ['390x844', '360x780', '430x932'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const sel = '[data-testid=rt-card]:nth-child(2)'
      await touch(tab, sel, 'pointerdown')
      await tab.waitForTimeout(150)
      await touch(tab, sel, 'pointermove', { clientY: 400 })
      await tab.waitForTimeout(600)
      if (await tab.locator('[data-testid=batchbar]').isVisible()) issues.push('手指移动(在滚动)不该触发长按多选')
      await touch(tab, sel, 'pointerup')
      await touch(tab, sel, 'pointerdown')
      await tab.waitForTimeout(600)
      await touch(tab, sel, 'pointerup')
      if (!(await tab.locator('[data-testid=batchbar]').isVisible())) return [...issues, '长按应进入多选并出现批量条']
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 1 项')) issues.push('长按应选中这一张')
      if ((await tab.locator('[data-testid=rt-card].is-selected').count()) !== 1) issues.push('被选中的卡片应高亮')
      return issues
    },
  },
  'kit-sheet': {
    // 底部弹层:从底部升起、有把手、安全区;下滑关闭(不依赖边缘手势);Esc / 遮罩 / 关闭按钮;焦点管理
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const opener = tab.getByRole('button', { name: '打开底部弹层' })
      await opener.click()
      await tab.waitForSelector('[data-testid=sheet]')
      await tab.waitForTimeout(100)
      const sheet = await rect(tab, '[data-testid=sheet]')
      if (Math.round(sheet.bottom) !== size.height) issues.push(`弹层应贴底,下缘 ${sheet.bottom} / ${size.height}`)
      if (sheet.width > 641) issues.push(`弹层太宽:${sheet.width}`)
      if (sheet.height > size.height - 40) issues.push(`弹层太高:${sheet.height} / ${size.height}`)
      const x = sheet.left + sheet.width / 2
      const grab = await rect(tab, '[data-testid=sheet-grab]')
      // 拖一小段(不够关闭)→ 弹回
      // 慢慢拖 40px(总共约 400ms,速度远低于「轻扫」阈值)→ 不关闭;瞬间拖 40px 就是轻扫,会关闭——所以这里要有停顿
      await tab.mouse.move(x, grab.top + 6)
      await tab.mouse.down()
      for (const dy of [10, 20, 30, 40]) {
        await tab.mouse.move(x, grab.top + 6 + dy)
        await tab.waitForTimeout(100)
      }
      await tab.mouse.up()
      await tab.waitForTimeout(50)
      if (!(await tab.locator('[data-testid=sheet]').count())) issues.push('只拖了一小段不该关闭')
      // 拖远 → 关闭
      const again = await rect(tab, '[data-testid=sheet-grab]')
      await tab.mouse.move(x, again.top + 6)
      await tab.mouse.down()
      // 拖 130px:远超 96px 的关闭阈值,又不会把鼠标拖出窗口。原来拖 220px,弹层贴底时鼠标会被带到窗口下边缘之外,
      // Firefox 对窗口外的鼠标不再送 pointerup(最后一个 pointermove 的 clientY 变成负数),手势没有收尾,弹层不关,
      // 后面的点击全被没关掉的遮罩挡住,报出来的却是看不懂的「locator.click 超时」。触屏上手指滑出屏幕边缘浏览器会照常送 pointerup / pointercancel,不受影响
      await tab.mouse.move(x, again.top + 130, { steps: 8 })
      await tab.mouse.up()
      await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('向下拖远应关闭弹层'))
      // 弹层没关的话,后面每一次 opener.click 都会被没关掉的遮罩挡住,等满 30 秒报一个看不懂的 locator.click 超时;
      // 这里直接收尾,让报出来的是根因「向下拖远应关闭弹层」
      if (issues.length) return issues
      // 焦点回到打开它的按钮
      if (!(await tab.evaluate(() => document.activeElement?.textContent?.includes('打开底部弹层')))) issues.push('关闭后焦点应回到打开弹层的按钮')
      // Esc 与遮罩
      await opener.click()
      await tab.waitForSelector('[data-testid=sheet]')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭'))
      await opener.click()
      await tab.waitForSelector('[data-testid=sheet]')
      await tab.mouse.click(size.width / 2, 8)
      await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点遮罩应关闭'))
      return issues
    },
  },
  'kit-dialog': {
    // 对话框:桌面居中;手机变成贴底弹层
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.getByRole('button', { name: '打开对话框' }).click()
      await tab.waitForSelector('.kb-dialog')
      await tab.waitForTimeout(150)
      const dialog = await rect(tab, '.kb-dialog')
      if (isPhone(size)) {
        if (Math.round(dialog.bottom) !== size.height) issues.push(`手机上对话框应贴底,下缘 ${dialog.bottom}`)
        if (Math.round(dialog.width) !== size.width) issues.push(`手机上对话框应占满宽度,实际 ${dialog.width}`)
      } else {
        const centered = Math.abs(dialog.left + dialog.width / 2 - size.width / 2) < 2 && Math.abs(dialog.top + dialog.height / 2 - size.height / 2) < 2
        if (!centered) issues.push(`桌面 / 平板上对话框应居中:${JSON.stringify(dialog)}`)
      }
      await tab.keyboard.press('Escape')
      return issues
    },
  },
  'kit-dialog-long': {
    // 内容很长的对话框:页头和底部按钮必须一直在屏幕里,只有中间的正文滚动。
    // 回归自「整张卡片一起滚」:内容一长,底部的「确定 / 取消」跟着滚到屏幕外,要先滚到底才找得到。
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.getByRole('button', { name: '打开对话框' }).click()
      await tab.waitForSelector('.kb-dialog')
      await tab.waitForTimeout(200)
      // 往正文里塞很多段,撑到比屏幕高
      await tab.evaluate(() => {
        const body = document.querySelector('.kb-dialog-body')
        for (let index = 0; index < 60; index += 1) {
          const p = document.createElement('p')
          p.textContent = `第 ${index + 1} 段:很长的内容,用来把对话框撑得比屏幕还高。`
          body.appendChild(p)
        }
      })
      await tab.waitForTimeout(100)
      const measure = () =>
        tab.evaluate(() => {
          const box = (selector) => {
            const el = document.querySelector(selector)
            const r = el?.getBoundingClientRect()
            return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null
          }
          const body = document.querySelector('.kb-dialog-body')
          return { vh: innerHeight, dialog: box('.kb-dialog'), head: box('.kb-dialog-head'), foot: box('.kb-dialog-foot'), bodyScrolls: body.scrollHeight > body.clientHeight + 4, bodyTop: body.scrollTop }
        })
      const before = await measure()
      if (!before.foot) return ['找不到对话框底部(夹具里的对话框应该带 footer)']
      if (before.dialog.bottom > before.vh + 1 || before.dialog.top < -1) issues.push(`对话框超出屏幕:${before.dialog.top}~${before.dialog.bottom} / ${before.vh}`)
      if (before.head.top < -1) issues.push(`页头被滚出屏幕上方:${before.head.top}`)
      if (before.foot.bottom > before.vh + 1) issues.push(`底部按钮在屏幕外(下缘 ${before.foot.bottom} > 屏高 ${before.vh}):内容一长,按钮要滚到底才看得见`)
      if (!before.bodyScrolls) issues.push('正文应该是滚动的那一块(整张卡片一起滚会连页头、按钮一起带走)')
      // 滚正文:页头和按钮不动
      await tab.evaluate(() => { document.querySelector('.kb-dialog-body').scrollTop = 400 })
      await tab.waitForTimeout(100)
      const after = await measure()
      if (after.bodyTop < 100) issues.push('正文没有滚动起来')
      if (after.head.top !== before.head.top || after.foot.top !== before.foot.top) issues.push(`滚动正文时页头 / 按钮动了:页头 ${before.head.top}→${after.head.top},按钮 ${before.foot.top}→${after.foot.top}`)
      await tab.keyboard.press('Escape')
      return issues
    },
  },
  'kit-tabs': {
    // 可滑动标签页:放不下时右侧渐隐提示、滑到头换成左侧;超过 maxVisible 的收进「更多」,当前页签永远可见
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const narrow = tab.locator('[data-testid=kit-narrow-tabs] .kb-tabs')
      if (!(await narrow.evaluate((el) => el.classList.contains('has-fade-right')))) issues.push('窄容器里放不下的页签,右侧应有渐隐提示')
      if (await narrow.evaluate((el) => el.classList.contains('has-fade-left'))) issues.push('起始位置左侧不该渐隐')
      await narrow.evaluate((el) => (el.scrollLeft = el.scrollWidth))
      await tab.waitForTimeout(150)
      if (!(await narrow.evaluate((el) => el.classList.contains('has-fade-left')))) issues.push('滑到头后左侧应渐隐')
      if (await narrow.evaluate((el) => el.classList.contains('has-fade-right'))) issues.push('滑到头后右侧不该再渐隐')
      // 「更多」
      const more = tab.locator('[data-testid=tabs-more]')
      // 页面上还有别处的 tablist(图表的时间范围页签等,位置会变):只在「可滑动标签页」这一块里找,第 0 个是窄容器那组,第 1 个才是 maxVisible=5 的
      const block = tab.locator('section', { has: tab.locator('[data-testid=kit-narrow-tabs]') })
      const maxTabs = block.locator('[role=tablist]').nth(1)
      const visibleTabs = async () => (await maxTabs.locator('[role=tab]:not(.kb-tabs-more)').allInnerTexts()).map((text) => text.trim())
      if (JSON.stringify(await visibleTabs()) !== JSON.stringify(['概览', '用户', '角色', '邀请码'])) issues.push(`maxVisible=5 应直接显示 4 个 + 更多,实际 ${JSON.stringify(await visibleTabs())}`)
      await more.click()
      const menu = await tab.locator('.kb-tabs-menu-item').allInnerTexts()
      if (JSON.stringify(menu.map((text) => text.trim())) !== JSON.stringify(['审计', '设置', '备份'])) issues.push(`「更多」菜单应是 审计 / 设置 / 备份,实际 ${JSON.stringify(menu)}`)
      const menuBox = await rect(tab, '.kb-tabs-menu')
      if (menuBox && (menuBox.right > size.width + 1 || menuBox.bottom > size.height + 1)) issues.push('「更多」菜单超出屏幕')
      await tab.locator('.kb-tabs-menu-item', { hasText: '备份' }).click()
      if (!(await visibleTabs()).includes('备份')) issues.push('选了「更多」里的页签后,它应出现在可见区')
      if (!(await maxTabs.locator('[aria-selected=true]').innerText()).includes('备份')) issues.push('选中的应是「备份」')
      if (!(await tab.locator('text=当前:备份').count())) issues.push('选中后页面内容应跟着变')
      return issues
    },
  },
  'kit-form': {
    // 表单字段:标签关联控件、就近报错(role=alert + aria-describedby)、未保存提示与固定的操作条;触屏输入框 ≥16px 且 ≥44px 高
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const email = tab.getByLabel('邮箱')
      await email.fill('abc')
      await tab.waitForTimeout(100)
      const alert = tab.locator('.kb-field-error')
      if (!(await alert.count())) return [...issues, '邮箱格式不对时应就近显示报错']
      if ((await alert.getAttribute('role')) !== 'alert') issues.push('报错应是 role=alert')
      const describedby = await email.getAttribute('aria-describedby')
      if (!describedby || !describedby.includes((await alert.getAttribute('id')) ?? '?')) issues.push(`输入框的 aria-describedby 应指向报错:${describedby}`)
      if ((await email.getAttribute('aria-invalid')) !== 'true') issues.push('输入框应标记 aria-invalid')
      await email.fill('a@b.co')
      await tab.waitForTimeout(100)
      if (await tab.locator('.kb-field-error').count()) issues.push('改对后报错应消失')
      // 昵称改动 → 操作条出现未保存提示;保存后消失
      const name = tab.getByLabel('昵称')
      if (await tab.locator('.kb-actionbar-note').count()) issues.push('没改动时不该有未保存提示')
      await name.fill('林二')
      await tab.waitForSelector('.kb-actionbar-note')
      if (!(await tab.locator('.kb-actionbar-note').innerText()).includes('未保存')) issues.push('改动后应提示有未保存的修改')
      if (size.touch) {
        const box = await name.boundingBox()
        const fontSize = await name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
        if (box.height < 43.5) issues.push(`触屏输入框高度应 ≥44,实际 ${box.height}`)
        if (fontSize < 16) issues.push(`触屏输入框字号应 ≥16px(否则 iOS 聚焦会放大页面),实际 ${fontSize}`)
      }
      await tab.getByRole('button', { name: '保存' }).click()
      await tab.waitForTimeout(100)
      if (await tab.locator('.kb-actionbar-note').count()) issues.push('保存后未保存提示应消失')
      // 操作条是 sticky:滚动内容区时仍在可视区底部附近。
      // 先把整张表单滚进可视区再量:演示页的表单卡片有一半在首屏之外,而 Playwright 点按钮时的"滚到可见"
      // 在 Chromium 和 WebKit 里滚的距离不同,不固定下来的话这条断言在某个视口上只在一个引擎里偶然不过
      await tab.locator('.kb-actionbar').scrollIntoViewIfNeeded()
      await tab.waitForTimeout(100)
      const bar = await rect(tab, '.kb-actionbar')
      if (bar.bottom > size.height + 1) issues.push(`操作条超出屏幕底部:${bar.bottom}`)
      return issues
    },
  },
  'kit-states': {
    // 空状态与骨架屏:不溢出;空状态有一个可点的下一步;骨架屏对读屏是 status
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.getByRole('button', { name: '新建笔记' }).isVisible())) issues.push('空状态应有可点的「新建笔记」')
      if ((await tab.locator('.kb-empty[role=status]').count()) < 2) issues.push('空状态应是 role=status')
      if ((await tab.locator('.kb-skel[aria-busy=true]').count()) < 3) issues.push('三种骨架屏都应存在并标记 aria-busy')
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      return issues
    },
  },
}
