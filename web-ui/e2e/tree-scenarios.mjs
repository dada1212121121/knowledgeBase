// 知识库页「目录」树的交互场景。由 viewer-shots.mjs 引入。
// 回归自真机反馈:目录树点击经常没反应、展开不了。
//   - 点有子目录的类型:留在树里原地展开(以前一点就跳去列表,子目录看不到);
//   - 点没有子目录的类型:直接去看这一类的文档,也不再画一个点了没东西的展开箭头;
//   - 箭头可点区域撑满行高,别的集合的箭头也能用(以前点了什么都不发生);
//   - 方向键在行之间移动。
const COLLECTION = 'knowledgeBase%2Finsights'
const LIST = `/kb?collection=${COLLECTION}`

/** 窄屏的列表 / 文档是二选一或目录栏会自动收起,先确保目录栏在眼前,再切到「目录」页签 */
async function openTree(tab, size) {
  if (size.width < 1024) {
    const back = tab.locator('[aria-label=返回列表]')
    const dir = tab.locator('[data-testid=dir-toggle]')
    if (await back.isVisible()) await back.click()
    else if (await dir.isVisible()) await dir.click()
  }
  await tab.locator('.kb-sidebar-tab-btn', { hasText: '目录' }).click()
  await tab.waitForSelector('[data-testid=tree-facet-pitfall]', { timeout: 10_000 })
}

const expandedOf = (tab, testid) => tab.locator(`[data-testid="${testid}"]`).getAttribute('aria-expanded')
const visible = (tab, testid) => tab.locator(`[data-testid="${testid}"]`).isVisible()

export const TREE_SCENARIOS = {
  'tree-expand': {
    route: LIST,
    ready: '.kb-sidebar-tab-btn',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await openTree(tab, size)

      // 1. 箭头的可点区域:至少 24 宽、撑满整行高度(以前只有 12px 的图标)
      const caret = await tab.evaluate(() => {
        const row = document.querySelector('[data-testid=tree-facet-pitfall]')
        const el = row?.querySelector('.kb-tree-caret')
        if (!row || !el) return null
        const c = el.getBoundingClientRect()
        const r = row.getBoundingClientRect()
        return { w: c.width, h: c.height, rowH: r.height }
      })
      if (!caret) issues.push('找不到「决策/坑」类型行的展开箭头')
      else {
        if (caret.w < 24) issues.push(`箭头可点区域太窄:${Math.round(caret.w)}px(应 ≥ 24)`)
        if (caret.h < caret.rowH - 2) issues.push(`箭头可点区域没撑满行高:${Math.round(caret.h)} / ${Math.round(caret.rowH)}px`)
      }

      // 2. 没有子目录的类型不画展开箭头(aria-expanded 不存在);有子目录的有
      if ((await expandedOf(tab, 'tree-facet-decision')) !== null) issues.push('没有子目录的类型不该带 aria-expanded(没有可展开的东西)')
      if ((await expandedOf(tab, 'tree-facet-pitfall')) !== 'false') issues.push('有子目录的类型应是收起状态(aria-expanded=false)')

      // 3. 点有子目录的类型:原地展开,仍在「目录」页签,子目录出现,这一类被选中
      await tab.locator('[data-testid=tree-facet-pitfall]').click()
      await tab.waitForTimeout(250)
      if (!(await visible(tab, 'tree-dir-kb-service/'))) issues.push('点有子目录的类型后,子目录没有出现(应该原地展开)')
      if ((await expandedOf(tab, 'tree-facet-pitfall')) !== 'true') issues.push('展开后 aria-expanded 应为 true')
      if ((await tab.locator('[data-testid=tree-facet-pitfall]').getAttribute('aria-selected')) !== 'true') issues.push('点中的类型应处于选中状态')
      if (await tab.locator('[data-testid^=list-row-]').first().isVisible().catch(() => false)) issues.push('点有子目录的类型不该跳到列表,树就看不到了')

      // 4. 再点一次:收起,并取消这一类的筛选
      await tab.locator('[data-testid=tree-facet-pitfall]').click()
      await tab.waitForTimeout(250)
      if (await visible(tab, 'tree-dir-kb-service/')) issues.push('再点一次已展开的类型,子目录应收起')
      if ((await tab.locator('[data-testid=tree-facet-pitfall]').getAttribute('aria-selected')) === 'true') issues.push('收起时应同时取消这一类的筛选')

      // 5. 点箭头:只展开,不改变选中(这一类之前没被选中,点完仍然没被选中)
      await tab.locator('[data-testid=tree-facet-pitfall] .kb-tree-caret').click()
      await tab.waitForTimeout(250)
      if (!(await visible(tab, 'tree-dir-kb-service/'))) issues.push('点箭头应展开子目录')
      if ((await tab.locator('[data-testid=tree-facet-pitfall]').getAttribute('aria-selected')) === 'true') issues.push('点箭头只展开,不该选中这一类')

      // 6. 点没有子目录的类型:去看这一类的文档(页签切到列表)
      await tab.locator('[data-testid=tree-facet-decision]').click()
      await tab.waitForSelector('.kb-sidebar-item', { timeout: 8_000 }).catch(() => issues.push('点没有子目录的类型后,应切到列表看这一类的文档'))
      return issues
    },
  },

  'tree-other-collection': {
    // 别的集合的箭头以前点了什么都不发生(展开状态记下了,但子项只对当前集合画)
    route: LIST,
    ready: '.kb-sidebar-tab-btn',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await openTree(tab, size)
      const other = tab.locator('[role=treeitem]', { hasText: 'SampleApp/insights' }).first()
      if (!(await other.count())) return ['夹具里没有 SampleApp/insights 集合']
      if ((await other.getAttribute('aria-expanded')) !== 'false') issues.push('不是当前集合的行应是收起状态')
      await other.locator('.kb-tree-caret').click()
      await tab.waitForTimeout(600)
      const row = tab.locator('[role=treeitem]', { hasText: 'SampleApp/insights' }).first()
      if ((await row.getAttribute('aria-expanded')) !== 'true') issues.push('点别的集合的箭头后,它应切为当前集合并展开')
      const old = tab.locator('[role=treeitem]', { hasText: 'knowledgeBase/insights' }).first()
      if ((await old.getAttribute('aria-expanded')) === 'true') issues.push('切走后,原来的集合应收起(分类数据只属于当前集合)')
      return issues
    },
  },

  'tree-keyboard': {
    // 方向键:↓↑ 逐行,→ 展开 / 进入子项,← 收起 / 回父项;Tab 不会陷在树里(行内按钮冒泡的按键不算选中)
    route: LIST,
    ready: '.kb-sidebar-tab-btn',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 600) return issues
      await openTree(tab, size)
      const focused = () => tab.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent?.trim().slice(0, 30) ?? '')
      await tab.locator('[data-testid=tree-facet-decision]').focus()
      await tab.keyboard.press('ArrowDown')
      if ((await focused()) !== 'tree-facet-pitfall') issues.push(`↓ 应移到下一行(决策 → 坑),实际焦点在 ${await focused()}`)
      await tab.keyboard.press('ArrowRight')
      await tab.waitForTimeout(200)
      if (!(await visible(tab, 'tree-dir-kb-service/'))) issues.push('→ 应展开有子目录的类型')
      await tab.keyboard.press('ArrowRight')
      if ((await focused()) !== 'tree-dir-kb-service/') issues.push(`已展开时 → 应进入第一个子项,实际焦点在 ${await focused()}`)
      await tab.keyboard.press('ArrowLeft')
      if ((await focused()) !== 'tree-facet-pitfall') issues.push(`子项上 ← 应回到父项,实际焦点在 ${await focused()}`)
      await tab.keyboard.press('ArrowLeft')
      await tab.waitForTimeout(200)
      if (await visible(tab, 'tree-dir-kb-service/')) issues.push('已展开的类型上 ← 应收起')
      return issues
    },
  },
}
