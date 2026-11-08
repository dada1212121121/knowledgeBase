// 无障碍守卫场景(.11,严重问题为 0):每一类 axe critical / serious 问题修掉之后,留一个场景守住,
// 防止回退。整站巡检用 `node e2e/axe.mjs`;这里按「规则 id × 关键页」精确断言,红了能直接看出是哪一类坏了。
// 由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎,深浅两套主题都查。
import { axeIssues } from './axe-helpers.mjs'
import { ALL_FEATURES, adminMe } from './fixture.mjs'

/**
 * 只查「某一页上的某几条规则」的场景:等 ready 出现再查(它就是曾经出问题的那个节点),深浅色各跑一遍。
 * note 写这条场景守的是什么,方便红了的时候看懂。
 */
const guard = (route, ready, rules, note) => ({
  route,
  ready,
  settle: 600,
  note,
  assert: async (tab) => axeIssues(tab, { rules }),
})

export const AXE_SCENARIOS = {
  'axe-shell-names': {
    // 外壳的按钮:可访问名称必须包含屏幕上看得见的文字(WCAG 2.5.3,axe label-content-name-mismatch)。
    // 以前侧栏的「搜索」「收起」和顶栏的搜索按钮写了和可见文字不同的 aria-label(少了 ⌘K / ⌘B 提示),
    // 语音控制用户念出屏幕上的字却点不到。/home 上侧栏是展开的,文字和快捷键提示都看得见。
    route: '/home',
    ready: '[data-testid=topbar]',
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      // 展开侧栏只在 ≥1280 出现;窄屏是图标栏 / 标签栏,可见文字被隐藏,这条规则本来就无从触发,
      // 所以宽屏上要先确认被守的按钮真的在屏幕上,免得场景空转得像通过了
      if (size.width >= 1280) {
        for (const selector of ['.kb-nav-collapse', '.kb-topbar-search']) {
          if (!(await tab.locator(selector).isVisible())) issues.push(`宽屏应能看到 ${selector},否则这条守卫没有检查到任何东西`)
        }
      }
      issues.push(...(await axeIssues(tab, { rules: ['label-content-name-mismatch'] })))
      return issues
    },
  },

  'axe-nav-badge-names': {
    // 知识库页的侧栏自动收成图标栏:文字被隐藏,只剩「审核」「任务」上的红点 / 数字角标可见。
    // 以前这两项的名称只有「审核收件箱」,而可见的是数字,语音控制和读屏对不上;
    // 现在名称是「审核收件箱 N 项待处理」,角标本身不再带 aria-label。
    route: '/kb',
    // 知识库页没有顶栏,没有统一的就绪标志;宽屏上由下面的断言等角标出现
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      // <840 是底部标签栏,没有侧栏
      if (size.width >= 840) {
        // 角标由接口数据驱动,晚一点才出来;不出来就说明场景没覆盖到被守的东西
        const badge = tab.locator('[data-nav-id=review] .kb-nav-badge')
        if (!(await badge.waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false))) {
          issues.push('审核收件箱的角标没有出现,这条守卫没有检查到任何东西')
        } else {
          const name = await tab.locator('[data-nav-id=review]').getAttribute('aria-label')
          if (!name?.includes('待处理')) issues.push(`带角标的导航项名称应包含「N 项待处理」,实际「${name}」`)
        }
      }
      issues.push(...(await axeIssues(tab, { rules: ['label-content-name-mismatch'] })))
      return issues
    },
  },

  // ---- color-contrast(WCAG 1.4.3):文字与背景对比度 ≥ 4.5:1 ----
  // 根因分两类:① 淡色底(强调色 / 状态色 14%)上的强调色、状态色文字,按实心背景校准的 token 在淡色底上不够 → contrast.css 重新校准;
  // ② 拿「实心状态色」或「弱化档」当文字色(--g / --y / --r / --m2 是给图标、圆点、占位符用的)→ 改用 -text 档或 --m。
  // 每个场景的 ready 都选「曾经不达标的那个节点」,等到它出现才查,免得页面没渲染完就空转通过。
  'axe-contrast-kb': {
    // 知识库页:选中的药丸(含计数)、选中行的辅助文字、文档类型标签、目录高亮、双链
    route: '/kb',
    ready: '.kb-sidebar-pill.is-active .kb-pill-count',
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },
  'axe-contrast-tags': {
    // 「外观」页里的 .tag.ac(强调色标签)与 .tag.y(警告标签)
    route: '/me/appearance',
    ready: '.tag.ac',
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },
  'axe-contrast-stat': {
    // 指标卡的「警告」说明文字(KbStat tone=warning)
    route: '/home',
    ready: 'text=有事等你处理',
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },
  'axe-contrast-overview': {
    // 管理总览:任务状态(成功 / 失败)、最近事件的时间戳、指标卡说明
    // (概览重做后事件时间的类名从 .kb-event-time 变成 .kb-ov-time)
    route: '/admin/overview',
    ready: '.kb-ov-event .kb-ov-time',
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },
  'axe-contrast-usage': {
    // 存储与用量:超额提示条(警告色文字叠在警告色淡色底上)
    route: '/admin/usage',
    ready: '.kb-su-alert > b',
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },
  'axe-contrast-users': {
    // 用户与权限:选中角色下面的小字(手机上角色变成横排药丸,小字被隐藏,所以只在能看到它的宽度上查)
    route: '/admin/users',
    ready: '.kb-ut-role.on small',
    sizes: ['1180x820', '1440x900', '1920x1080'],
    settle: 600,
    assert: async (tab) => axeIssues(tab, { rules: ['color-contrast'] }),
  },

  'axe-kb-controls': {
    // 知识库侧栏顶部的两个图标式下拉(排序方式 / 状态筛选):按钮上只有图标,文字被样式隐藏,必须有 aria-label(critical 的 button-name)
    route: '/kb',
    ready: '.kb-sidebar-pills',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const names = await tab.locator('button[aria-haspopup=listbox]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
      for (const word of ['排序方式', '状态筛选']) if (!names.some((name) => name.startsWith(word))) issues.push(`缺少名为「${word}」的下拉按钮,实际 ${JSON.stringify(names)}`)
      issues.push(...(await axeIssues(tab, { rules: ['button-name'] })))
      return issues
    },
  },

  // 文档编辑区的可访问性语义（只剩统一外壳这一条路径）：根节点（role=textbox）要有名字，列表要被读屏认成列表。
  // 以前这个场景直接打开 /kb 等 .ProseMirror 出现，依赖“默认就开着编辑态”的旧夹具状态，基线上就已经等不到；
  // 现在显式打开一篇有列表的笔记并进入编辑态。
  ...Object.fromEntries(
    [
      ['axe-editor-semantics', ''],
    ].map(([name, query]) => [
      name,
      {
        route: `/kb?collection=knowledgeBase%2Finsights&item=ins_8f21${query}`,
        ready: '.kb-workspace-bar-right',
        sizes: ['1180x820', '1440x900', '1920x1080'],
        settle: 800,
        fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) } },
        prepare: async (tab) => {
          await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
          await tab.waitForSelector('.kb-dp .ProseMirror[contenteditable="true"]', { timeout: 20_000 })
        },
        assert: async (tab) => {
          const issues = []
          const name = await tab.locator('.kb-dp .ProseMirror').first().getAttribute('aria-label')
          if (name !== '文档正文') issues.push(`编辑区应叫「文档正文」，实际「${name}」`)
          // 示例文档里要真的有列表，否则下面的 list / listitem 检查什么也没量到
          const items = await tab.locator('.kb-dp .ProseMirror li').count()
          if (!items) issues.push('示例文档里没找到列表项，list / listitem 的守卫没有检查到任何东西')
          // 文本面直接用原生 <ul><li>，不需要补 ARIA；检查它没被改坏：每个 li 的父级必须是 ul / ol
          const bad = await tab.locator('.kb-dp .ProseMirror li').evaluateAll((els) => els.filter((el) => !['UL', 'OL'].includes(el.parentElement?.tagName ?? '')).length)
          if (bad) issues.push(`${bad} 个 <li> 的父级不是 <ul> / <ol>`)
          issues.push(...(await axeIssues(tab, { rules: ['aria-input-field-name', 'list', 'listitem'] })))
          return issues
        },
      },
    ]),
  ),

  // ---- aria-toggle-field-name(role=switch 必须有名字)/ label / aria-progressbar-name:表单控件的可访问名称 ----
  'axe-switch-labelled': {
    // 搜索页的开关带着旁边的文字(KbSwitch 的 label 形态)。以前文字只是并排摆着,读屏只念「开关」;
    // 现在开关用 aria-labelledby 指向文字。先读出实际名称再让 axe 查,免得 axe 通过但名字是错的。
    route: '/search?q=uds',
    ready: '[role=switch]',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const names = await tab.locator('[role=switch]').evaluateAll((els) =>
        els.map((el) => {
          const id = el.getAttribute('aria-labelledby')
          return (id ? document.getElementById(id)?.textContent?.trim() : el.getAttribute('aria-label')) ?? ''
        }),
      )
      if (!names.includes('只看笔记')) issues.push(`搜索页的开关应读作「只看笔记」,实际 ${JSON.stringify(names)}`)
      issues.push(...(await axeIssues(tab, { rules: ['aria-toggle-field-name'] })))
      return issues
    },
  },

  'axe-names-appearance': guard('/me/appearance', '[role=switch]', ['aria-toggle-field-name'], '外观页的「减少动效」开关'),
  'axe-names-users': guard('/admin/users', '[role=switch]', ['aria-toggle-field-name'], '用户与权限页每个功能一个开关,名字是功能名'),
  'axe-names-params': guard('/admin/params', '[role=switch]', ['aria-toggle-field-name', 'label'], '系统参数页的开关与数字 / 文本输入框(critical 的 label:表单控件没标签)'),

  'axe-progressbar-default': {
    // 导入记录页的总体进度条:role=progressbar 必须有名字,读屏念「总体进度」才知道在说什么
    route: '/import',
    ready: '[role=progressbar]',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const name = await tab.locator('[role=progressbar]').first().getAttribute('aria-label')
      if (name !== '总体进度') issues.push(`导入页的进度条应叫「总体进度」,实际「${name}」`)
      issues.push(...(await axeIssues(tab, { rules: ['aria-progressbar-name'] })))
      return issues
    },
  },

  // ---- scrollable-region-focusable:可滚动区域键盘要够得到 ----
  'axe-scroll-settings-nav': {
    // 设置分区导航在手机 / 窄屏上是横向滚动的一排。以前导航项是只绑了 click 的 <span>:Tab 够不到,滚动区里没有可聚焦的东西。
    // 现在是 <button>:既满足 axe,也真的能用键盘走到并按回车切换。
    route: '/me/appearance',
    ready: '.kb-settings-nav .ni',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const tags = await tab.locator('.kb-settings-nav .ni').evaluateAll((els) => els.map((el) => el.tagName))
      if (!tags.length || tags.some((name) => name !== 'BUTTON')) issues.push(`分区导航项应都是 <button>,实际 ${JSON.stringify(tags)}`)
      await tab.locator('.kb-settings-nav .ni').first().focus()
      if (!(await tab.evaluate(() => document.activeElement?.matches('.kb-settings-nav .ni')))) issues.push('分区导航项应能被键盘聚焦')
      const current = await tab.locator('.kb-settings-nav .ni[aria-current]').count()
      if (current !== 1) issues.push(`应有且只有一个导航项标着 aria-current,实际 ${current}`)
      issues.push(...(await axeIssues(tab, { rules: ['scrollable-region-focusable'] })))
      return issues
    },
  },
  'axe-scroll-settings-page': guard('/admin/settings', '.kb-settings-nav .ni', ['scrollable-region-focusable'], '系统设置页(同一个 KbSettingsLayout)'),

  'axe-scroll-audit': {
    // 审计页签里的可滚动区域必须能被键盘聚焦(否则键盘用户滚不动宽表格)。
    // 管理组把这个页签重写成了 AuditPanel(KbResponsiveTable):窄屏是卡片、没有横向滚动区;
    // 宽度不够放下整张表时 .kb-scroll 溢出,useScrollFocus 给它 tabindex=0 和名字。意图不变,断言改到新结构
    route: '/admin/audit',
    ready: '[data-testid=audit-panel] .kb-rt, [data-testid=audit-panel] .kb-scroll, [data-testid=audit-panel] table',
    // 只有 640~850 宽附近表格才比容器宽(探针:390 是卡片、820 及以上放得下);其它尺寸没有横向滚动区,断言会空转。
    // 这几个尺寸在 fold / tablet / phone(横屏)设备组里,默认的 core 五个尺寸里没有:要跑用 KB_SIZES 显式选
    sizes: ['673x841', '744x1133', '800x1280', '844x390'],
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const scrollers = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=audit-panel] .kb-scroll')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({ tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? '' })),
      )
      // 前置:这个宽度下必须真的有溢出的滚动区,否则下面的断言什么都没量(假绿)
      if (!scrollers.length) issues.push('这个宽度下审计表应比容器宽(出现横向滚动区),场景前提不成立')
      for (const item of scrollers) {
        if (item.tabindex !== '0') issues.push('溢出的滚动区应能被键盘聚焦(tabindex=0)')
        if (!item.label) issues.push('可聚焦的滚动区应有名字')
      }
      issues.push(...(await axeIssues(tab, { rules: ['scrollable-region-focusable'] })))
      return issues
    },
  },

  'axe-chart-hit': {
    // 管理总览的堆叠柱图:每列热区能聚焦、有名字,所以必须有角色(aria-prohibited-attr);根节点不是 img
    route: '/admin/overview',
    ready: '.kb-chart-svg',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => ({
        root: document.querySelector('.kb-chart-svg')?.getAttribute('role'),
        hits: [...document.querySelectorAll('.kb-chart-hit')].map((el) => `${el.getAttribute('role')}|${el.getAttribute('aria-label')}`),
      }))
      if (info.root !== 'group') issues.push(`图表根节点应是 group,实际 ${info.root}`)
      if (!info.hits.length) issues.push('没找到图表热区,这条守卫没有检查到任何东西')
      if (info.hits.some((item) => !item.startsWith('graphics-symbol|') || item.endsWith('|null'))) issues.push(`每个热区都应有角色和名字,实际 ${JSON.stringify(info.hits.slice(0, 2))}`)
      issues.push(...(await axeIssues(tab, { rules: ['aria-prohibited-attr'] })))
      return issues
    },
  },
}
