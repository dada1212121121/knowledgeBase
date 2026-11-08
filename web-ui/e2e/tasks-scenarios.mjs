// 任务页(.6)的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 手机上表格变任务卡(以前是一排排深色格子)、「+ 新任务」手机上点得到(以前被挤出页签栏)、点卡看详情(底部弹层)、报错可重试。
import { jobsStory } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

export const TASKS_SCENARIOS = {
  'tasks-list': {
    // 任务列表:手机是任务卡,平板 / 电脑是表格;筛选和「+ 新任务」都在屏内;没有横向溢出
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: jobsStory,
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const cards = await tab.locator('[data-testid=job-card]').count()
      const rows = await tab.locator('.kb-jobs-table [data-testid=rt-row]').count()
      if (phone && (cards !== 8 || rows !== 0)) issues.push(`手机上应是 8 张任务卡且没有表格行,实际卡 ${cards} 行 ${rows}`)
      if (!phone && (rows !== 8 || cards !== 0)) issues.push(`平板 / 电脑上应是 8 行表格且没有任务卡,实际行 ${rows} 卡 ${cards}`)
      // 运行中的排最前
      const first = await tab.locator('.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]').first().innerText()
      if (!first.includes('重建索引')) issues.push(`运行中的「重建索引」应排第一,实际「${first.replace(/\s+/g, ' ').slice(0, 40)}」`)
      // 失败的任务先说原因
      const failed = (await tab.locator('.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]').filter({ hasText: '建立索引' }).first().innerText()).replace(/\s+/g, ' ')
      if (!failed.includes('sidecar timeout')) issues.push(`失败的任务应显示失败原因 sidecar timeout,实际「${failed.slice(0, 80)}」`)
      // 筛选条和「+ 新任务」都在屏内
      const bar = await tab.locator('[data-testid=jobs-bar]').boundingBox()
      if (!bar || bar.x < -1 || bar.x + bar.width > size.width + 1) issues.push(`筛选条应完整在屏幕内,实际 x=${bar?.x} w=${bar?.width}`)
      const add = await tab.getByRole('button', { name: '新任务' }).boundingBox()
      if (!add || add.x + add.width > size.width + 1 || add.x < 0) issues.push(`「+ 新任务」应在屏幕内,实际 x=${add?.x} w=${add?.width}`)
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) for (const item of await smallTargets(tab, '.kb-jobs-bar button')) issues.push(`触屏可点区域不足 44px:${item}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-detail': {
    // 点一个任务看详情:手机是底部弹层(带取消 / 关闭),平板 / 电脑是表格下面的详情卡;失败的任务整段写出原因和出错的文件
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: jobsStory,
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      if (phone) {
        await tab.locator('[data-testid=rt-card]').nth(1).click()
        await tab.waitForSelector('.kb-sheet [data-testid=job-detail-sheet] .kb-srows')
        // 弹层升起约 0.3 秒:等位置稳定了再量
        await tab.waitForFunction(() => {
          const top = document.querySelector('.kb-sheet')?.getBoundingClientRect().top
          const last = window.__sheetTop
          window.__sheetTop = top
          return top !== undefined && top === last
        }, null, { polling: 120 })
        const box = await tab.locator('.kb-sheet').boundingBox()
        if (!box || box.y < 0 || box.y + box.height > size.height + 1) issues.push(`详情弹层应完整在屏幕内,实际 y=${box?.y} h=${box?.height}`)
        const text = await tab.locator('.kb-sheet').innerText()
        for (const word of ['自动提炼', '取消任务', '关闭', '排队']) if (!text.includes(word)) issues.push(`详情弹层缺少「${word}」`)
        await tab.locator('.kb-sheet').getByRole('button', { name: '关闭', exact: true }).last().click()
        await tab.waitForFunction(() => !document.querySelector('.kb-sheet'))
      } else {
        await tab.locator('.kb-jobs-table [data-testid=rt-row]').filter({ hasText: 'job_4409' }).click()
        await tab.waitForSelector('[data-testid=job-detail-card] [data-testid=job-failure]')
        const card = tab.locator('[data-testid=job-detail-card]')
        // 上面有指标、图表和一整页表格:详情卡要按内容撑高,不能被「铺满剩余高度」压成一条线
        const box = await card.boundingBox()
        if (!box || box.height < 200) issues.push(`详情卡应按内容撑高,实际高 ${box?.height}`)
        const title = await card.locator('.ch').innerText()
        if (!title.includes('job_4409')) issues.push(`详情卡标题应显示所选任务的编号,实际「${title}」`)
        const text = (await card.innerText()).replace(/\s+/g, ' ')
        for (const word of ['sidecar timeout', '出错的文件', 'docs/big.pdf: 抽取超时', '1284 个文件']) if (!text.includes(word)) issues.push(`详情卡缺少「${word}」`)
        if (await tab.locator('.kb-sheet').count()) issues.push('平板 / 电脑上不该弹底部弹层')
      }
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-pages': {
    // 历史任务很多(生产上 1.4 万):表格一页 50 个,分页条在屏内;翻页向服务端要下一页,不在前端整份切
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: {
      ...jobsStory,
      job_list: {
        jobs: Array.from({ length: 1234 }, (_, index) => ({
          id: `job_${String(9000 - index).padStart(4, '0')}`, kind: index % 7 ? 'index' : 'ingest', collection: 'proj_knowledgebase', state: index % 50 ? 'done' : 'failed',
          progress_done: 10, progress_total: 10, rate: null, error: index % 50 ? null : '句柄耗尽', detail: null,
          created_at: Date.UTC(2026, 9, 20, 16, 0, 0) - index * 60_000, started_at: Date.UTC(2026, 9, 20, 16, 0, 0) - index * 60_000, finished_at: Date.UTC(2026, 9, 20, 16, 0, 5) - index * 60_000,
        })),
      },
    },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const count = () => tab.locator(phone ? '[data-testid=job-card]' : '.kb-jobs-table [data-testid=rt-row]').count()
      if ((await count()) !== 50) issues.push(`一页应是 50 个任务,实际 ${await count()}`)
      const pager = tab.locator('[data-testid=jobs-pager]')
      if (!(await pager.count())) issues.push('任务超过一页时应有分页条')
      else {
        const text = await pager.innerText()
        if (!text.includes('1234 条中第 1–50 条')) issues.push(`分页条应写「1234 条中第 1–50 条」,实际「${text.replace(/\s+/g, ' ')}」`)
        const next = pager.getByRole('button', { name: '下一页' })
        await next.scrollIntoViewIfNeeded()
        const box = await next.boundingBox()
        if (!box || box.x < 0 || box.x + box.width > size.width + 1) issues.push(`「下一页」应在屏内,实际 x=${box?.x}`)
        await next.click()
        await tab.waitForFunction(() => document.querySelector('[data-testid=jobs-pager]')?.textContent?.includes('第 51–100 条'))
      }
      // 卡片标题旁的「共 N 个」在手机和平板上是藏起来的,看环形图中心的总数
      const center = (await tab.locator('[data-testid=jobs-state-chart] .kb-donut-value .kb-countup').getAttribute('data-value')) ?? ''
      if (center !== '1234') issues.push(`状态图应按全部任务计数(1234),实际「${center}」`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-audit': {
    // 审计日志、批次两个页签:手机也是卡片 / 可折行的行,没有横向溢出
    route: '/admin/audit',
    ready: '[data-testid=audit-panel] .kb-ap-card',
    fixture: jobsStory,
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const cards = await tab.locator('[data-testid=rt-card]').count()
      const rows = await tab.locator('[data-testid=rt-row]').count()
      if (phone && rows) issues.push(`手机上审计日志不该是表格行,实际 ${rows} 行`)
      if (!phone && cards) issues.push(`平板 / 电脑上审计日志不该是卡片,实际 ${cards} 张`)
      issues.push(...(await overflowIssues(tab)))
      await tab.getByRole('tab', { name: /批次/ }).click()
      await tab.waitForSelector('[data-testid=batch-row]')
      if ((await tab.locator('[data-testid=batch-row]').count()) < 5) issues.push('批次页签应列出批次')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-error': {
    // 取不到任务:整块报错 + 重新加载,点了恢复
    route: '/tasks',
    ready: '[data-testid=jobs-error]',
    fixture: { ...jobsStory, __capabilityError: { job_list: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=jobs-error]').innerText()
      if (!text.includes('没能读取任务') || !text.includes('重新加载')) issues.push(`报错应说清楚并给「重新加载」,实际「${text.replace(/\s+/g, ' ')}」`)
      await tab.locator('[data-testid=jobs-error] button').click()
      await tab.waitForSelector('.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]')
      if (await tab.locator('[data-testid=jobs-error]').count()) issues.push('重新加载成功后报错应消失')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-empty': {
    // 没有任务:表格位置给「没有符合条件的任务」,页面不空白
    route: '/tasks',
    ready: '[data-testid=jobs-bar]',
    fixture: { ...jobsStory, job_list: { jobs: [] }, batch_list: { total: 0, page_size: 20, offset: 0, batches: [] } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=jobs]').innerText()
      if (!text.includes('没有符合条件的任务')) issues.push('应写「没有符合条件的任务」')
      if (!text.includes('还没有写入批次')) issues.push('批次小表应写「还没有写入批次」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'tasks-light': {
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: jobsStory,
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
