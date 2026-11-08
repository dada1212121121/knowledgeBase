// 搜索页的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 简单模式是默认(调试项折进「高级选项」,手机上放底部弹层)、共享范围与来源标注、点结果去哪、报错可重试。
import { PEOPLE, shareFixture } from './share-fixture.mjs'
import { SHARED_ITEMS, SHARED_SPACES, smallTargets } from './share-scenarios.mjs'
import { overflowIssues } from './admin-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const texts = (tab, selector) => tab.locator(selector).allInnerTexts().then((list) => list.map((item) => item.replace(/\s+/g, ' ').trim()))

/**
 * 共享检索的假回答(命中形状与后端 shared_search.rs 一致)。命中必须落在 SHARED_ITEMS 的真实授权上:
 * 张三分享了笔记 ins_s1(部署清单)和文件夹 docs,点进去才打得开;命中不在任何授权里时知识库页会提示「可能已被取消分享」。
 */
const sharedHit = (id, kind, extra) => ({
  collection: '_global',
  kind,
  start_line: null,
  end_line: null,
  symbol: null,
  snippet: '发布前先备份数据库,再跑冒烟测试,最后切流量。',
  score: 0.8,
  related: [],
  explain: null,
  id,
  ...extra,
})
const sharedSearchReply = (args) => ({
  hits: [
    sharedHit('own_1', 'insight', { source: 'mine/own_1.md', title: '我自己的笔记', space_id: 'sp_primary', role: 'owner' }),
    sharedHit('ins_s1', 'insight', { source: 'ins_s1', title: '部署清单', space_id: 'sp_alice', owner: PEOPLE.zhangsan, role: 'viewer' }),
    sharedHit('c1', 'doc', { source: 'docs/runbook.md', title: '运维手册', space_id: 'sp_alice', owner: PEOPLE.zhangsan, role: 'editor' }),
  ].filter((hit) => args?.scope === 'all' || hit.role !== 'owner'),
  sources: [],
  query: args?.query ?? '',
})

const withShared = (extra = {}) => shareFixture({ sharedWithMe: structuredClone(SHARED_ITEMS), spaces: structuredClone(SHARED_SPACES) }, { search_shared: sharedSearchReply, ...extra })

/** 点开范围下拉并选一项 */
async function pickScope(tab, name) {
  await tab.locator('[data-testid=search-scope]').click()
  await tab.getByRole('option', { name }).click()
}

export const SEARCH_SCENARIOS = {
  'search-simple': {
    // 简单模式是默认:没有 rerank / explain / RRF / top-k 这些词,结果只有标题、片段、类型和来源;
    // 展开「高级选项」之前没有排序依据和右侧说明面板
    route: '/search?q=uds',
    ready: '.kb-hit',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      // 只看控件区:结果标题 / 片段是用户自己的内容(夹具里的笔记标题就带 rerank),不归界面文案管
      const body = await tab.locator('.kb-search-top').innerText()
      for (const word of ['rerank', 'explain', 'RRF', 'top-k', '演练场']) if (body.includes(word)) issues.push(`简单模式的控件区不该出现「${word}」`)
      if (!body.includes('高级选项')) issues.push('应有「高级选项」入口')
      if (await tab.locator('.kb-stg-cell').count()) issues.push('默认不该显示各阶段名次')
      if (await tab.locator('.kb-explain').count()) issues.push('默认不该有右侧的排序依据面板')
      const kinds = await texts(tab, '[data-testid=hit-kind]')
      if (!kinds.length || kinds.some((kind) => !/^(笔记|代码|文档|网页|摘要|内容)$/.test(kind))) issues.push(`每条结果都应标类型(中文),实际 ${kinds.join('|')}`)
      const sources = await texts(tab, '[data-testid=hit-source]')
      if (!sources.length || sources.some((source) => source !== '我的')) issues.push(`自己知识库的结果都应标「我的」,实际 ${sources.join('|')}`)
      // 触屏:可点的都 ≥44px
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) {
        const small = await smallTargets(tab, '.kb-search-options button, .kb-hit-actions button, .kb-search-go')
        for (const item of small) issues.push(`触屏可点区域不足 44px:${item}`)
      }
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-preview': {
    // 宽屏(≥1280)右侧给当前结果的预览,窄屏不占一列;反馈按钮只剩图标,不再把「打开」挤下去
    route: '/search?q=uds',
    ready: '.kb-hit',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const preview = tab.locator('[data-testid=search-preview]')
      const count = await preview.count()
      if (size.width >= 1280) {
        if (!count) return ['宽屏应显示结果预览']
        const box = await preview.boundingBox()
        const hits = await tab.locator('.kb-hits').boundingBox()
        if (box && hits && box.x < hits.x + hits.width - 2) issues.push('预览应排在结果列表右边,不能盖住列表')
        if (box && (box.width < 280 || box.width > 340)) issues.push(`预览宽度应在 280–340,实际 ${box?.width}`)
        if (!(await preview.innerText()).includes('预览')) issues.push('预览卡应有标题')
        const useful = tab.locator('[data-testid=hit-useful]').first()
        if (!(await useful.count())) issues.push('自己的结果应有图标反馈按钮')
        else {
          const text = (await useful.innerText()).trim()
          if (text) issues.push(`反馈按钮只放图标,不该有文字「${text}」`)
        }
      } else if (count) issues.push('窄屏不该硬塞预览列,应直接给列表全宽')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-live': {
    // 边输入边搜:停顿后自动出结果并写回地址;没按回车就不记搜索历史
    route: '/search',
    ready: '.kb-searchbar-input',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('.kb-hit').count()) issues.push('还没输入时不该有结果')
      await tab.locator('.kb-searchbar-input').fill('uds')
      await tab.waitForSelector('.kb-hit', { timeout: 3000 }).catch(() => issues.push('输入后应自动出结果(不用回车)'))
      if (!(await tab.locator('.kb-hit').count())) return issues
      const q = await tab.evaluate(() => new URL(location.href).searchParams.get('q'))
      if (q !== 'uds') issues.push(`自动搜索后地址应带上 q=uds,实际 ${q}`)
      const recent = await tab.evaluate(() => localStorage.getItem('kb.search.recent'))
      if (recent) issues.push(`自动搜索不该写历史,实际 ${recent}`)
      // 摘要里的命中词要能高亮;完全没有字面命中的结果用短标签说明是语义匹配
      const hints = await texts(tab, '[data-testid=hit-semantic]')
      if (hints.some((text) => text !== '语义匹配')) issues.push(`语义匹配提示应是一枚短标签,实际 ${hints.join('|')}`)
      // 清空输入:结果与地址一起清掉,不能留一个已经不在输入框里的旧词
      await tab.locator('.kb-searchbar-input').fill('')
      await tab.waitForTimeout(400)
      if (await tab.locator('.kb-hit').count()) issues.push('清空输入后不该还留着上一次的结果')
      if (await tab.evaluate(() => new URL(location.href).searchParams.has('q'))) issues.push('清空输入后地址里不该还有 q')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-advanced': {
    // 高级选项:电脑内联展开,手机在底部弹层;打开「查看排序依据」后下次搜索出现阶段名次和说明面板;设置刷新后还在
    route: '/search?q=uds',
    ready: '.kb-hit',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=search-adv-toggle]').click()
      const phone = size.width < 600
      if (phone) {
        await tab.waitForSelector('.kb-sheet')
        // 弹层是从屏幕下沿升起来的(动画约 0.3 秒):等位置稳定了再量、再点,否则量到的是半路上的位置
        await tab.waitForFunction(() => {
          const el = document.querySelector('.kb-sheet')
          const top = el?.getBoundingClientRect().top
          const last = window.__sheetTop
          window.__sheetTop = top
          return top !== undefined && top === last
        }, null, { polling: 120 })
        const box = await tab.locator('.kb-sheet').boundingBox()
        if (!box || box.y + box.height > size.height + 1 || box.y < 0) issues.push(`手机上高级选项弹层应完整在屏幕内,实际 y=${box?.y} h=${box?.height}`)
        if (await tab.locator('.kb-search-adv').count()) issues.push('手机上不该内联展开')
      } else {
        await tab.waitForSelector('.kb-search-adv')
        if (await tab.locator('.kb-sheet').count()) issues.push('电脑 / 平板上不该用底部弹层')
      }
      const panel = await tab.locator('[data-testid=search-advanced]').innerText()
      for (const word of ['重排', '查看排序依据']) if (!panel.includes(word)) issues.push(`高级选项缺少「${word}」`)
      // 「返回条数」已不在高级选项里:ff79afef 起一次取满,每页几条改到结果下面的翻页条(见 search-pager 场景)
      if (panel.includes('返回条数')) issues.push('高级选项里不该再有「返回条数」(已改成翻页条的每页条数)')
      // 打开「查看排序依据」
      await tab.locator('[data-testid=search-advanced] [role=switch]').nth(1).click()
      // 拨开关后会按新设置自动重搜,不需要再点「搜索」
      // 只要求「出现」(attached):手机上阶段行在第一屏之外,默认等的「可见」会把它当成没出现
      await tab.waitForSelector('.kb-stg-cell', { state: 'attached', timeout: 10_000 }).catch(() => issues.push('打开「查看排序依据」后,结果里应出现各阶段名次'))
      if (!(await tab.locator('.kb-explain').count())) issues.push('打开「查看排序依据」后应有右侧的说明面板')
      if (phone) await tab.getByRole('button', { name: '完成' }).click()
      else await tab.locator('[data-testid=search-adv-toggle]').click()
      if (!(await tab.locator('[data-testid=search-adv-toggle]').innerText()).includes('1')) issues.push('改过的高级选项应在按钮上显示数量角标')
      // 刷新后设置还在
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-hit')
      if (!(await tab.locator('.kb-stg-cell').count())) issues.push('刷新后「查看排序依据」应还开着')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-pager': {
    // 每页几条在结果下面的翻页条里调(ff79afef 把「返回条数」从高级选项搬到这里):结果多于 10 条才出现翻页条;
    // 一次取满、页面里切片,所以翻页和换每页条数都不重新搜索;换每页条数回到第一页;选择会记住(刷新后还在)
    route: '/search?q=uds',
    ready: '.kb-hit',
    fixture: {
      search_knowledge: () => ({
        hits: Array.from({ length: 25 }, (_, index) => ({
          id: `ins_pg${index + 1}`, collection: 'proj_knowledgebase', kind: 'insight', source: `insight:ins_pg${index + 1}`, start_line: null, end_line: null, symbol: null,
          title: `第 ${index + 1} 条结果`, snippet: '连接 kbd.sock 失败 → 回退为只读直连 SQLite', score: 0.9 - index * 0.01, related: [], explain: null,
        })),
        scope: ['proj_knowledgebase', '_global'],
        query_parsed: { text: 'uds', filters: {} },
        degraded: null,
        timings: { parse_ms: 0.3, embed_ms: 8.4, store_ms: 12.1, fts_ms: 3.8, vector_ms: 11.6, fuse_ms: 0.2, rerank_ms: 0, total_ms: 36.4 },
      }),
    },
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const searches = []
      tab.on('request', (req) => { if (req.url().includes('/capabilities/search_knowledge')) searches.push(req.url()) })
      const pager = tab.locator('[data-testid=search-pager]')
      const hits = () => tab.locator('.kb-hit').count()
      const summary = async () => (await pager.locator(':scope > span').first().innerText()).replace(/\s+/g, ' ').trim()
      if (!(await pager.count())) return ['结果多于 10 条时应出现翻页条']
      if ((await summary()) !== '25 条中第 1–10 条' || (await hits()) !== 10) issues.push(`默认每页 10 条:${await summary()},显示 ${await hits()} 条`)
      await pager.getByRole('button', { name: '下一页' }).click()
      if ((await summary()) !== '25 条中第 11–20 条') issues.push(`翻到第 2 页:${await summary()}`)
      // 换每页条数:回到第一页
      await pager.locator('.kb-select > button').click()
      await tab.locator('[role=option]', { hasText: '20 / 页' }).click()
      await tab.waitForTimeout(200)
      if ((await summary()) !== '25 条中第 1–20 条' || (await hits()) !== 20) issues.push(`每页 20 条:${await summary()},显示 ${await hits()} 条`)
      if (searches.length) issues.push(`翻页和换每页条数不该重新搜索,实际又发了 ${searches.length} 次`)
      // 记住:刷新后还是每页 20 条
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-hit')
      if ((await hits()) !== 20) issues.push(`刷新后每页条数应记住,实际显示 ${await hits()} 条`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-shared': {
    // 有人分享内容给我:范围里出现「共享」两项;选了之后结果标出分享人和我的角色,别人的结果没有有用 / 无用;点进去切到「共享给我」
    route: '/search',
    ready: '[data-testid=search-scope]',
    fixture: withShared(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=search-scope]').click()
      const options = await texts(tab, '[role=option]')
      for (const word of ['我的 + 共享给我的', '只搜共享给我的']) if (!options.includes(word)) issues.push(`范围里应有「${word}」,实际 ${options.join('|')}`)
      await tab.keyboard.press('Escape')
      await pickScope(tab, '我的 + 共享给我的')
      await tab.locator('input.kb-searchbar-input').fill('部署')
      await tab.locator('.kb-search-go').click()
      await tab.waitForSelector('.kb-hit')
      const sources = await texts(tab, '[data-testid=hit-source]')
      if (sources.join('|') !== '我的|来自 张三 · 可查看|来自 张三 · 可编辑') issues.push(`来源标注应是 我的|来自 张三 · 可查看|来自 张三 · 可编辑,实际 ${sources.join('|')}`)
      const cards = tab.locator('article.kb-hit')
      if (await cards.nth(1).locator('[data-testid=hit-useful]').count()) issues.push('别人分享的结果不该有「有用 / 无用」')
      if (!(await cards.nth(0).locator('[data-testid=hit-useful]').count())) issues.push('自己的结果应有「有用 / 无用」')
      // 只搜共享:自己的那条消失
      await pickScope(tab, '只搜共享给我的')
      await tab.locator('.kb-search-go').click()
      await tab.waitForFunction(() => document.querySelectorAll('article.kb-hit').length === 2)
      // 点别人分享的笔记:切到「共享给我」,并且真的把那篇文档打开(不是停在空白或「没找到」)
      await tab.locator('[data-testid=hit-open]').first().click()
      await tab.waitForURL(/\/kb\?/)
      const url = new URL(tab.url())
      if (url.searchParams.get('scope') !== 'shared') issues.push(`应切到共享给我,实际 scope=${url.searchParams.get('scope')}`)
      if (url.searchParams.get('space') !== 'sp_alice') issues.push(`应带上来源知识库,实际 space=${url.searchParams.get('space')}`)
      if (url.searchParams.get('item') !== 'ins_s1') issues.push(`笔记应带 item=ins_s1,实际 ${url.searchParams.get('item')}`)
      await tab.waitForSelector('[data-testid=shared-doc-title]', { timeout: 10_000 }).catch(() => issues.push('点进去后应打开那篇共享笔记'))
      const title = await tab.locator('[data-testid=shared-doc-title]').innerText().catch(() => '')
      if (title && !title.includes('部署清单')) issues.push(`打开的应是「部署清单」,实际「${title}」`)
      // 浏览器「后退」回到搜索页:范围和搜索词都在地址里,应恢复成同一批结果(以前范围会被重置成「当前项目」,搜出另一批)
      await tab.goBack()
      await tab.waitForSelector('article.kb-hit')
      await tab.waitForFunction(() => document.querySelectorAll('article.kb-hit').length === 2)
      const back = new URL(tab.url())
      if (back.searchParams.get('scope') !== 'shared:only') issues.push(`后退回来地址里应保留 scope=shared:only,实际 ${back.searchParams.get('scope')}`)
      if (!(await tab.locator('[data-testid=search-scope]').innerText()).includes('只搜共享给我的')) issues.push('后退回来范围应还是「只搜共享给我的」')
      const again = await texts(tab, '[data-testid=hit-source]')
      if (again.join('|') !== '来自 张三 · 可查看|来自 张三 · 可编辑') issues.push(`后退回来应是同一批结果,实际 ${again.join('|')}`)
      // 文件命中(授权是上级文件夹 docs):同样能打开
      await tab.locator('[data-testid=hit-open]').nth(1).click()
      await tab.waitForURL(/\/kb\?/)
      if (new URL(tab.url()).searchParams.get('path') !== 'docs/runbook.md') issues.push('文件命中应带 path=docs/runbook.md')
      await tab.waitForSelector('[data-testid=shared-main]')
      await tab.waitForTimeout(800)
      if (await tab.locator('[data-testid=shared-doc-error]').count()) issues.push('文件命中点进去不该报「这篇文档没有打开」')
      return issues
    },
  },

  'search-no-shared': {
    // 没有人分享内容给我:范围里没有共享选项
    route: '/search',
    ready: '[data-testid=search-scope]',
    fixture: shareFixture({ sharedWithMe: [] }, {}),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=search-scope]').click()
      const options = await texts(tab, '[role=option]')
      if (options.some((option) => option.includes('共享'))) issues.push(`没有共享时范围里不该有共享选项,实际 ${options.join('|')}`)
      return issues
    },
  },

  'search-highlight-cjk': {
    // 中文查询没有空格,整句不能被当成一个词:摘要和标题里命中的词都要高亮,虚词(怎么)不高亮;
    // 命中在摘要很靠后的位置时,摘要要围着它截(以前从开头截 240 字,命中的词根本不在摘要里)
    route: '/search?q=' + encodeURIComponent('rerank 超时怎么降级'),
    ready: '.kb-hit',
    fixture: {
      search_knowledge: {
        hits: [
          {
            id: 'h_far', collection: 'knowledgeBase/insights', kind: 'insight', source: 'insight:h_far', start_line: null, end_line: null, symbol: null,
            title: 'rerank 超时后如何降级', snippet: `${'背景说明。'.repeat(80)}这里讲 rerank 超时后降级为向量序,不再等待重排。${'后续内容。'.repeat(40)}`,
            score: 0.9, related: [], explain: null,
          },
        ],
        scope: ['knowledgeBase'], query_parsed: { text: 'rerank 超时怎么降级', filters: {} }, degraded: null, timings: { total_ms: 1 },
      },
    },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const marks = await tab.locator('.kb-hit-snippet mark').allInnerTexts()
      for (const word of ['rerank', '降级']) if (!marks.some((mark) => mark.toLowerCase().includes(word))) issues.push(`摘要里「${word}」应高亮,实际高亮:${marks.join('|')}`)
      if (marks.some((mark) => mark.includes('怎么'))) issues.push('虚词「怎么」不该高亮')
      if (marks.some((mark) => mark.length > 6)) issues.push(`不该把整句当成一个词高亮:${marks.join('|')}`)
      const snippet = await tab.locator('.kb-hit-snippet').first().innerText()
      if (!snippet.includes('降级为向量序')) issues.push(`摘要应围着命中截,实际:${snippet.slice(0, 60)}…`)
      const titleMarks = await tab.locator('.kb-hit-title mark').allInnerTexts()
      if (!titleMarks.length) issues.push('标题里命中的词也应高亮')
      return issues
    },
  },

  'search-open-carries-query': {
    // 点「打开」:地址里带上查询(hq),文档页据此高亮;不带查询的入口(如最近查看)不带 hq
    route: '/search?q=' + encodeURIComponent('降级 uds'),
    ready: '.kb-hit',
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=hit-open]').first().click()
      await tab.waitForURL(/\/kb\?/, { timeout: 8000 }).catch(() => issues.push('点「打开」应跳到知识库页'))
      const hq = new URL(tab.url()).searchParams.get('hq')
      if (hq !== '降级 uds') issues.push(`地址里应带 hq=降级 uds,实际 ${hq}`)
      return issues
    },
  },

  'search-open-own': {
    // 点自己的结果的「打开」:去知识库页并带上集合 / 路径 / 命中块(以前用不存在的命名路由,点了没反应)
    route: '/search?q=uds',
    ready: '.kb-hit',
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=hit-open]').first().click()
      await tab.waitForURL(/\/kb\?/, { timeout: 8000 }).catch(() => issues.push('点「打开」应跳到知识库页'))
      const url = new URL(tab.url())
      if (url.pathname !== '/kb') issues.push(`应在 /kb,实际 ${url.pathname}`)
      for (const key of ['collection', 'path', 'highlight']) if (!url.searchParams.get(key)) issues.push(`地址里应带 ${key}`)
      return issues
    },
  },

  'search-error': {
    // 搜索失败:说清原因并给「重试」,重试后出结果
    route: '/search?q=uds',
    ready: '[data-testid=search-error]',
    fixture: { __capabilityError: { search_knowledge: { status: 503, message: '检索服务暂时不可用,请稍后重试', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=search-error]').innerText()
      if (!text.includes('重试')) issues.push('报错应给「重试」')
      await tab.locator('[data-testid=search-error] button').click()
      await tab.waitForSelector('.kb-hit')
      if (await tab.locator('[data-testid=search-error]').count()) issues.push('重试成功后报错应消失')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-empty': {
    // 没搜过:给下一步;搜了没结果:给换说法的建议
    route: '/search',
    ready: '.kb-search-start',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('.kb-search-start').innerText()
      if (!text.includes('还没有搜索')) issues.push('应写「还没有搜索」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'search-light': {
    route: '/search?q=uds',
    ready: '.kb-hit',
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
