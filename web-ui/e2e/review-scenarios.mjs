// 审核收件箱(.4)的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 卡片有内边距和层次、主操作与次要操作分开、驳回收进「⋯」、手机上按钮整行排满、多选批量、报错重试。
import { overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'
import { NOW } from './fixture.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

/** 夹具里只有两条待审;再补几条,好测多选、折叠和分页 */
const more = (id, extra = {}) => ({
  id: `drf_${id}`,
  collection: 'proj_sampleapp',
  project: 'SampleApp',
  title: `草稿 ${id}:一个标题比较长的候选经验,用来看窄屏上标题折行以后版面还稳不稳`,
  body_md: '这是一段比较长的正文。'.repeat(30),
  kind: 'howto',
  tags: ['示例', '版面'],
  related_paths: ['backend/some/very/long/path/to/a/file_with_a_long_name.rs'],
  evidence: ['+ let a = 1;', '- let a = 2;'],
  state: 'pending',
  score: 0.64,
  decision: 'revise',
  reasons: ['结论成立但表述偏笼统', '证据只有一处'],
  duplicate_of: null,
  insight_id: null,
  created_at: NOW - 5 * 3_600_000,
  decided_at: null,
  ...extra,
})
const COUNTS = { pending: 5, approved: 11, rejected: 3, duplicate: 4 }

export const REVIEW_SCENARIOS = {
  'review-list': {
    // 卡片:有内边距、有层次;通过 / 修订后通过在一行,驳回收在「⋯」;长正文折叠;依据折叠;窄屏单列、按钮排满
    route: '/review',
    ready: '[data-testid=draft-card]',
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const card = tab.locator('[data-testid=draft-card]').first()
      const box = await card.boundingBox()
      const pad = await card.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft))
      if (!(pad >= 12)) issues.push(`卡片应有内边距(≥12px),实际 ${pad}px(变量不存在时会变成 0)`)
      if (!box || box.x + box.width > size.width + 1) issues.push('卡片不该超出屏幕')
      const text = (await card.innerText()).replace(/\s+/g, ' ')
      for (const word of ['待审', '决策', 'SampleApp', 'AI 86 分', 'AI 建议通过', '通过', '修订后通过']) if (!text.includes(word)) issues.push(`卡片缺少「${word}」`)
      if (text.includes('驳回')) issues.push('驳回不该和「通过」并排(应收在「⋯」里)')
      if (await card.locator('[data-testid=draft-evidence]').evaluate((el) => el.open)) issues.push('依据应默认折叠')
      // 状态徽标不能被长标题挤成竖排:「待审」两个字应在同一行(文字区域高度不超过 1.6 个行高)
      const wrapped = await card.locator('header [class*=badge], header .kb-badge, header > span').last().evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
        return { lines: lines.size, text: el.textContent.trim() }
      })
      if (wrapped.lines > 1) issues.push(`状态徽标「${wrapped.text}」被挤成了 ${wrapped.lines} 行`)
      // 操作行:主操作在前,「⋯」菜单里有驳回
      await card.locator('[data-testid=draft-more]').click()
      const options = await tab.locator('[role=option]').allInnerTexts()
      if (!options.includes('驳回') || !options.includes('驳回并不再提炼')) issues.push(`「⋯」里应有 驳回 / 驳回并不再提炼,实际 ${options.join('|')}`)
      await tab.keyboard.press('Escape')
      if (phone) {
        const approve = await card.locator('[data-testid=draft-approve]').boundingBox()
        const revise = await card.locator('[data-testid=draft-revise]').boundingBox()
        if (approve && revise && Math.abs(approve.width - revise.width) > 4) issues.push(`手机上「通过」和「修订后通过」应等宽排满,实际 ${Math.round(approve.width)} / ${Math.round(revise.width)}`)
        if (approve && revise && Math.abs(approve.y - revise.y) > 2) issues.push('手机上两个主要按钮应在同一行')
      }
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) for (const item of await smallTargets(tab, '[data-testid=draft-card] button, [data-testid=draft-card] summary')) issues.push(`触屏可点区域不足 44px:${item}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'review-batch': {
    // 多选:勾几条 → 批量条出现 → 批量通过;批量条不遮住最后一张卡的操作;窄屏也可用
    route: '/review',
    ready: '[data-testid=draft-card]',
    fixture: {
      list_drafts: (args) => ({ total: 5, counts: COUNTS, drafts: [more('a'), more('b'), more('c'), more('d'), more('e')].slice(0, 5).map((d, i) => ({ ...d, id: `drf_${'abcde'[i]}` })).filter(() => args?.state !== 'approved') }),
      review_draft: () => ({ insight_id: 'ins_new', batch_id: 'b1' }),
    },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=draft-check]').nth(0).check()
      await tab.locator('[data-testid=draft-check]').nth(1).check()
      await tab.waitForSelector('[data-testid=batchbar]')
      const bar = await tab.locator('[data-testid=batchbar]').innerText()
      if (!bar.includes('已选 2 项')) issues.push(`批量条应写「已选 2 项」,实际「${bar.replace(/\s+/g, ' ')}」`)
      const box = await tab.locator('[data-testid=batchbar]').boundingBox()
      if (!box || box.x < -1 || box.x + box.width > size.width + 1) issues.push('批量条应完整在屏幕内')
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) for (const item of await smallTargets(tab, '[data-testid=batchbar] button')) issues.push(`触屏可点区域不足 44px:${item}`)
      await tab.locator('[data-testid=review-all]').check()
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 5 项')) issues.push('全选本页后应是已选 5 项')
      await tab.locator('[data-testid=batch-approve]').click()
      await tab.waitForFunction(() => document.body.innerText.includes('已通过 5 条'), null, { timeout: 8000 }).catch(() => issues.push('批量通过后应提示「已通过 5 条」'))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'review-expand': {
    // 长正文折叠,点「展开全文」展开,再点收起;依据点开能看到全部
    route: '/review',
    ready: '[data-testid=draft-card]',
    fixture: { list_drafts: { total: 1, counts: COUNTS, drafts: [more('long')] } },
    assert: async (tab) => {
      const issues = []
      const body = tab.locator('.kb-rv-body').first()
      const folded = await body.evaluate((el) => el.getBoundingClientRect().height)
      await tab.locator('[data-testid=draft-expand]').click()
      const open = await body.evaluate((el) => el.getBoundingClientRect().height)
      if (!(open > folded * 1.5)) issues.push(`展开后正文应明显变高,实际 ${Math.round(folded)} → ${Math.round(open)}`)
      await tab.locator('[data-testid=draft-expand]').click()
      const again = await body.evaluate((el) => el.getBoundingClientRect().height)
      if (Math.abs(again - folded) > 2) issues.push('收起后应回到折叠高度')
      await tab.locator('[data-testid=draft-evidence] summary').click()
      if ((await tab.locator('[data-testid=draft-evidence] blockquote').count()) !== 2) issues.push('点开依据应列出全部 2 处')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'review-states': {
    // 其它状态页签:已通过的只读(没有操作 / 勾选);空状态给下一步
    route: '/review',
    ready: '[data-testid=draft-card]',
    fixture: {
      list_drafts: (args) =>
        args?.state === 'approved'
          ? { total: 1, counts: COUNTS, drafts: [{ ...more('ok'), state: 'approved', insight_id: 'ins_77' }] }
          : args?.state === 'rejected'
            ? { total: 0, counts: COUNTS, drafts: [] }
            : { total: 1, counts: COUNTS, drafts: [more('p')] },
    },
    assert: async (tab) => {
      const issues = []
      await tab.getByRole('tab', { name: /已通过/ }).click().catch(async () => tab.getByText(/已通过/).first().click())
      await tab.waitForFunction(() => document.body.innerText.includes('已转正为 ins_77'))
      if (await tab.locator('[data-testid=draft-approve]').count()) issues.push('已通过的候选笔记不该有「通过」按钮')
      if (await tab.locator('[data-testid=draft-check]').count()) issues.push('已通过的候选笔记不该能勾选')
      // 页面顶部的「审核结果」图例里也有「已驳回」,所以按页签的角色点,不按文字找第一个
      await tab.getByRole('tab', { name: /已驳回/ }).click()
      await tab.waitForSelector('[data-testid=review-empty]')
      if (!(await tab.locator('[data-testid=review-empty]').innerText()).includes('没有已驳回的候选笔记')) issues.push('空状态应写「没有已驳回的候选笔记」')
      return issues
    },
  },

  'review-error': {
    // 读取失败:说清楚并给「重新加载」,点了恢复
    route: '/review',
    ready: '[data-testid=review-error]',
    fixture: { __capabilityError: { list_drafts: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=review-error]').innerText()).includes('重新加载')) issues.push('报错应给「重新加载」')
      await tab.locator('[data-testid=review-error] button').click()
      await tab.waitForSelector('[data-testid=draft-card]')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'review-light': {
    route: '/review',
    ready: '[data-testid=draft-card]',
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
