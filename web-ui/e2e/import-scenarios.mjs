// 导入页(.5)的页面场景:数据源 + 解析队列 + 批次入口合成一页。由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 拖入区(手机是「选择文件」)+ 粘贴网址 + 指标卡 + 导入记录 / 数据来源两个页签;服务器目录与 Git 在管理组的「项目与集合」。
import { ingestStory, projectsStory } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

async function touchIssues(tab, selector) {
  const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) return []
  return (await smallTargets(tab, selector)).map((item) => `触屏可点区域不足 44px:${item}`)
}

export const IMPORT_SCENARIOS = {
  'import-merged': {
    // 一页里有 拖入区 / 粘贴网址 / 四个指标 / 两个页签;默认在「导入记录」且带着批次进度;手机变卡片
    route: '/import',
    ready: '[data-testid=import-records]',
    fixture: ingestStory,
    settle: 700,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      for (const id of ['import-drop', 'import-web', 'import-metrics', 'import-records']) if (!(await tab.locator(`[data-testid=${id}]`).count())) issues.push(`缺少 ${id}`)
      const drop = await tab.locator('[data-testid=import-drop]').innerText()
      if (phone && (drop.includes('拖入') || drop.includes('选择文件夹'))) issues.push(`手机上拖入区不该写「拖入」或给「选择文件夹」:${drop.replace(/\s+/g, ' ').slice(0, 60)}`)
      if (!phone && !drop.includes('拖入文件或文件夹')) issues.push('电脑上拖入区应写「拖入文件或文件夹即可添加」')
      const cards = await tab.locator('[data-testid=record-card]').count()
      const rows = await tab.locator('[data-testid=import-records] [data-testid=rt-row]').count()
      if (phone && (cards !== 10 || rows)) issues.push(`手机上导入记录应是 10 张卡片,实际卡 ${cards} 行 ${rows}`)
      if (!phone && (rows !== 10 || cards)) issues.push(`平板 / 电脑上导入记录应是 10 行表格,实际行 ${rows} 卡 ${cards}`)
      if (!(await tab.locator('[data-testid=records-overall]').innerText()).includes('总体进度')) issues.push('应显示总体进度')
      issues.push(...(await touchIssues(tab, '[data-testid=import] button:not(.kb-imp-metric), [data-testid=import] summary')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'import-legacy-queue': {
    // 旧的 /import/queue 地址(书签、通知、上传提示里的链接)仍然能用,落在「导入记录」
    route: '/import/queue?batch=all&filter=failed',
    ready: '[data-testid=import-records]',
    fixture: ingestStory,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (!new URL(tab.url()).pathname.startsWith('/import')) issues.push('旧地址应仍在 /import 下')
      const shown = (await tab.locator('[data-testid=record-card], [data-testid=import-records] [data-testid=rt-row]').allInnerTexts()).join('\n')
      if (!shown.includes('失败')) issues.push('?filter=failed 应只显示失败的文件')
      if (shown.includes('成功')) issues.push('?filter=failed 不该混进成功的文件')
      return issues
    },
  },

  'import-sources': {
    // 数据来源页签:只有网页 / 上传 / 压缩包 / 笔记;服务器目录和 Git 不在这里;点一行看详情(手机是底部弹层)
    route: '/import?tab=sources',
    ready: '[data-testid=import-sources]',
    fixture: ingestStory,
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const text = await tab.locator('[data-testid=import-sources]').innerText()
      if (/knowledgeBase 文档|\/data\/dev|git@/.test(text)) issues.push('服务器目录 / Git 来源不该出现在导入页')
      const count = await tab.locator(phone ? '[data-testid=source-card]' : '[data-testid=import-sources] [data-testid=rt-row]').count()
      if (count < 1) issues.push('应至少有一个自己的数据来源')
      // 手机卡片上的状态徽标(「抓取中」)不能被名字挤成竖排
      if (phone) {
        const lines = await tab.locator('[data-testid=source-card] .kb-srct-state').first().evaluate((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
        })
        if (lines > 1) issues.push(`状态徽标被挤成了 ${lines} 行`)
      }
      await tab.locator(phone ? '[data-testid=source-card]' : '[data-testid=import-sources] [data-testid=rt-row]').first().click()
      await tab.waitForSelector('[data-testid=source-detail]', { timeout: 8000 }).catch(() => issues.push('点一行应打开详情'))
      if (!(await tab.locator('[data-testid=source-detail-remove]').count())) issues.push('详情里应有「移除」')
      if (phone) {
        await tab.waitForSelector('.kb-sheet')
        if (await tab.locator('.kb-drawer').count()) issues.push('手机上详情应是底部弹层,不是侧边抽屉')
      } else if (await tab.locator('.kb-sheet').count()) {
        issues.push('电脑上详情应是侧边抽屉')
      }
      return issues
    },
  },

  'import-web-url': {
    // 粘贴网址:不像网址就提示;像网址就带着它打开「添加数据」(类型已选网页),不静默提交
    route: '/import',
    ready: '[data-testid=import-web]',
    fixture: ingestStory,
    assert: async (tab) => {
      const issues = []
      await tab.locator('#import-web-url').fill('hello world')
      await tab.locator('[data-testid=import-web-go]').click()
      if (!(await tab.locator('[data-testid=import-web-error]').count())) issues.push('不像网址应提示')
      await tab.locator('#import-web-url').fill('docs.example.com/guide')
      await tab.locator('[data-testid=import-web-go]').click()
      await tab.waitForSelector('.kb-add-types', { timeout: 8000 }).catch(() => issues.push('像网址应打开「添加数据」'))
      const types = await tab.locator('.kb-add-types .stype').allInnerTexts()
      if (types.length !== 4 || types.some((type) => /服务器目录|Git/.test(type))) issues.push(`添加数据只该给 4 种用户级类型,实际 ${types.join('|')}`)
      const selected = await tab.locator('.kb-add-types .stype.on').innerText()
      if (!selected.includes('网页')) issues.push(`类型应预选网页,实际「${selected}」`)
      const filled = await tab.locator('.kb-add-fields input').first().inputValue()
      if (filled !== 'https://docs.example.com/guide') issues.push(`网址应补全协议并预填,实际「${filled}」`)
      return issues
    },
  },

  'import-metrics': {
    // 点「解析失败」指标:直接看全部批次里失败的文件(不再跳去另一页)
    route: '/import?tab=sources',
    ready: '[data-testid=import-sources]',
    fixture: ingestStory,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=metric-failed]').click()
      await tab.waitForSelector('[data-testid=import-records]', { timeout: 8000 }).catch(() => issues.push('点指标应回到导入记录'))
      const url = new URL(tab.url())
      if (url.pathname !== '/import') issues.push(`应留在 /import,实际 ${url.pathname}`)
      if (url.searchParams.get('filter') !== 'failed' || url.searchParams.get('batch') !== 'all') issues.push(`地址应带 batch=all&filter=failed,实际 ${url.search}`)
      return issues
    },
  },

  'import-empty': {
    // 全新账号:没有来源也没有文件,各处给下一步,不是空白
    route: '/import',
    ready: '[data-testid=import-records]',
    fixture: {
      list_sources: { sources: [], items: [] },
      list_ingest: { total: 0, files: [] },
    },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=import-records]').innerText()
      if (!text.includes('导入记录是空的')) issues.push('导入记录为空时应给下一步说明')
      if (!(await tab.locator('[data-testid=import-sync-all]').isDisabled())) issues.push('没有来源时「全部同步」应置灰')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'import-error': {
    // 读不到数据来源 / 导入记录:各自整块报错并给「重新加载」
    route: '/import?tab=sources',
    ready: '[data-testid=sources-error]',
    fixture: { __capabilityError: { list_sources: { status: 503, message: '服务暂时不可用', times: 2 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=sources-error]').innerText()).includes('重新加载')) issues.push('应给「重新加载」')
      await tab.locator('[data-testid=sources-error] button').click()
      await tab.waitForSelector('[data-testid=sources-error]', { state: 'detached', timeout: 8000 }).catch(() => issues.push('重新加载成功后报错应消失'))
      return issues
    },
  },

  'import-admin-sources': {
    // 管理 → 项目与集合:服务器目录与 Git 来源在这里(只列这两类),能添加(只给这两类)
    route: '/admin/projects',
    ready: '[data-testid=server-sources]',
    fixture: { ...projectsStory, ...ingestStory, list_collections: projectsStory.list_collections },
    settle: 700,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=server-sources]').innerText()
      if (!text.includes('只有管理员能添加')) issues.push('应说明这是管理员的事')
      // 夹具里服务器类来源是 knowledgeBase / sampleproj(服务器目录)和 SampleApp(Git),网页 / 上传 / 压缩包不该出现
      const names = (await tab.locator('[data-testid=server-sources] .kb-srct-title').allInnerTexts()).map((item) => item.trim()).sort()
      if (names.join('|') !== 'SampleApp|knowledgeBase|sampleproj') issues.push(`应只列 SampleApp|knowledgeBase|sampleproj,实际 ${names.join('|')}`)
      if (/Rust 异步手册|论文与报告|Confluence/.test(text)) issues.push('网页 / 上传 / 压缩包来源不该出现在管理页的服务器来源里')
      await tab.locator('[data-testid=server-add]').click()
      await tab.waitForSelector('.kb-add-types')
      const types = await tab.locator('.kb-add-types .stype').allInnerTexts()
      if (types.length !== 2 || !/服务器目录/.test(types[0]) || !/Git/.test(types[1])) issues.push(`添加来源只该给 服务器目录 / Git,实际 ${types.join('|')}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'import-light': {
    route: '/import',
    ready: '[data-testid=import-records]',
    fixture: ingestStory,
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
