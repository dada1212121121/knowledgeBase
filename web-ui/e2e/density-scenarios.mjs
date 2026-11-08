// 版式与空间利用(设计稿)的 Playwright 场景。
// 由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
import { rect } from './shell-scenarios.mjs'
import { STANDALONE_INIT } from './pwa-scenarios.mjs'
import { jobsStory } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { homeFixture } from './home-scenarios.mjs'

/**
 * 让浏览器"谎报"安全区:只有 Chromium 的 CDP 能做到(WebKit / Firefox 没有这个接口,场景在那两个引擎里跳过这一项)。
 * 真机上的现象:部分安卓浏览器把状态栏高度报成 safe-area-inset-top,但页面其实在地址栏下面。
 */
async function lieAboutSafeArea(tab, top) {
  const cdp = await tab.context().newCDPSession(tab)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, left: 0, bottom: 0, right: 0 } })
}

// 真机反馈的那篇笔记的缩略版:一张 4 列、带长路径行内代码的表。390 宽里这张表有 855px
const WIDE_TABLE_NOTE = `# 项目清单

> 来源:\`/srv/kb/demo-project-inventory.md\`

## 活跃项目

| 项目 | 路径 | 栈摘要 | 索引注意 |
|---|---|---|---|
| knowledgeBase | \`/srv/kb\` | Rust \`kb\` + Vue3 | 排除 \`target/\`、\`models/\`、\`logs/\`、\`.kb*\` |
| sampleproj | \`/srv/sampleproj\` | Go \`sample-web\` + Vue Vben | 排除 \`build_artifacts/\`、大截图、logs、凭据 |
| SampleApp | \`/srv/sampleapp\` | Go + React/Vite | 体量小,可较全量 |
`

export const DENSITY_SCENARIOS = {
  'density-kb-list': {
    // 知识库页(手机,设计规范):列表之上的控件区不超过屏高的 30%、第一屏至少露出 4 条;
    // 手机上列表是整页,没有侧栏可收,不该有「收起侧栏」;常用动作的图标按钮要有可见文字;小列表(一页放得下)不画分页条
    route: '/kb?collection=knowledgeBase%2Finsights',
    ready: '.kb-sidebar-item',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const m = await tab.evaluate(() => {
        const vh = innerHeight
        const items = [...document.querySelectorAll('.kb-sidebar-item')].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= vh - 56 })
        const body = document.querySelector('.kb-sidebar-body')
        const firstItem = document.querySelector('.kb-sidebar-item')
        const top = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null }
        const visible = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0 }
        return {
          vh,
          listTop: Math.round((body ?? firstItem).getBoundingClientRect().top),
          firstItemTop: Math.round(firstItem.getBoundingClientRect().top),
          itemsOnFirstScreen: items.length,
          collapseShown: visible('.kb-sidebar-ctrls [aria-label=收起侧栏]'),
          pager: visible('.kb-sidebar-pager'),
          total: document.querySelector('.kb-sidebar-pager-info')?.textContent?.trim(),
          tops: { scope: top('.kb-scope'), head: top('.kb-sidebar-head'), search: top('.kb-sidebar-search-row'), pills: top('.kb-sidebar-pills'), tabs: top('.kb-sidebar-nav-tabs') },
          // 可见文字:textContent 会读到 display:none 的文字,不能用;逐个子节点看有没有真正显示出来的文字
          iconOnly: [...document.querySelectorAll('.kb-sidebar-ctrls .btn, .kb-sidebar-search-row .btn')].filter((b) => b.getBoundingClientRect().height > 0).map((b) => {
            const shown = [...b.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).map((el) => el.textContent.trim()).join('')
            return `${b.getAttribute('aria-label') ?? b.title}:${shown || '(无字)'}`
          }),
        }
      })
      console.log(`[知识库页量测 ${size.width}x${size.height}] 列表起点 ${m.listTop}px = ${Math.round((m.listTop / m.vh) * 100)}%,第一屏 ${m.itemsOnFirstScreen} 条`)
      if (size.width >= 600) return issues
      // 列表之上的控件区(顶栏不算,它每页都有)不超过屏高的 30%
      // 屏高 < 700(iPhone SE 一代 568)时放宽到 40% / 3 条:控件区每一行已经是触屏要求的最小可点高度,
      // 绝对高度(约 233px)在 390x844 上占 28%,在 568 高的屏上必然占到 40% 左右,这是屏幕矮不是排版松
      const short = m.vh < 700
      const controlsPct = ((m.listTop - m.tops.scope) / m.vh) * 100
      const limit = short ? 42 : 30
      if (controlsPct > limit) issues.push(`列表之上的控件区占屏高 ${Math.round(controlsPct)}%(应 ≤ ${limit}%):列表起点 ${m.listTop}px,范围行从 ${m.tops.scope}px 开始`)
      // 手机上控件区是 4 行,不是 5 行:「新建」和范围切换同一行,集合选择和类型药丸同一行(没有单占一行的页头)
      const rows = await tab.evaluate(() => {
        const box = (selector) => {
          const el = document.querySelector(selector)
          const r = el?.getBoundingClientRect()
          return r && r.height > 0 ? { top: r.top, mid: r.top + r.height / 2 } : null
        }
        return {
          head: !!document.querySelector('.kb-sidebar-head'),
          scope: box('.kb-scope .kb-seg'),
          create: box('.kb-scope .kb-new-btn'),
          picker: box('.kb-sidebar-pills > .kb-sidebar-title'),
          pill: box('.kb-sidebar-pill-list .kb-sidebar-pill'),
        }
      })
      if (rows.head) issues.push('手机上不该再有单占一行的页头(.kb-sidebar-head):集合选择已经并进药丸那一行')
      if (!rows.create) issues.push('「新建」应在范围切换那一行里(.kb-scope .kb-new-btn)')
      else if (rows.scope && Math.abs(rows.create.mid - rows.scope.mid) > 3) issues.push(`「新建」和范围切换不在同一行:中线差 ${Math.round(Math.abs(rows.create.mid - rows.scope.mid))}px`)
      if (!rows.picker) issues.push('集合选择应在药丸那一行里(.kb-sidebar-pills > .kb-sidebar-title)')
      else if (rows.pill && Math.abs(rows.picker.mid - rows.pill.mid) > 3) issues.push(`集合选择和药丸不在同一行:中线差 ${Math.round(Math.abs(rows.picker.mid - rows.pill.mid))}px`)
      const need = short ? 3 : 4
      if (m.itemsOnFirstScreen < need) issues.push(`第一屏应至少露出 ${need} 条列表项,实际 ${m.itemsOnFirstScreen}`)
      if (m.collapseShown) issues.push('手机上列表是整页,没有侧栏可收,不该有「收起侧栏」按钮')
      const noText = m.iconOnly.filter((entry) => entry.endsWith(':(无字)'))
      if (noText.length) issues.push(`手机上常用动作的按钮不能只有图标:${noText.map((entry) => entry.split(':')[0]).join('、')}`)
      // 搜索框占位符不被截断(设计规范)
      const ph = await tab.evaluate(() => {
        const el = document.querySelector('.kb-sidebar-search-input')
        const probe = document.createElement('span')
        const style = getComputedStyle(el)
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};letter-spacing:${style.letterSpacing}`
        probe.textContent = el.placeholder
        document.body.appendChild(probe)
        const need = Math.ceil(probe.getBoundingClientRect().width)
        probe.remove()
        // 内容区宽度:getBoundingClientRect 减 padding 和边框(clientWidth 在各引擎对 <input> 的语义不一致)
        const box = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
        return { text: el.placeholder, need, have: Math.floor(box) }
      })
      // ≤340 宽放不下任何占位符时,允许把它整个藏起来(透明),但不能显示半截
      const hidden = await tab.evaluate(() => getComputedStyle(document.querySelector('.kb-sidebar-search-input'), '::placeholder').color).then((color) => /rgba\(0, 0, 0, 0\)|transparent/.test(color))
      if (ph.need > ph.have && !(size.width <= 340 && hidden)) issues.push(`搜索框占位符被截断:「${ph.text}」需要 ${ph.need}px,只有 ${ph.have}px`)
      return issues
    },
  },
  'density-page-pad': {
    // 页面左右边距(设计规范):手机上切换页面,内容的左缘不能跳。<AppShell roomy> 给桌面「设计稿」多留 6px,手机上不该有
    route: '/home',
    ready: '.content',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const pads = {}
      for (const route of ['/home', '/review', '/tasks', '/import', '/me', '/admin/users', '/admin/params', '/friends']) {
        await tab.goto(new URL(route, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('.content', { timeout: 10_000 }).catch(() => issues.push(`${route}:没有 .content`))
        await tab.waitForTimeout(250)
        pads[route] = await tab.evaluate(() => {
          const c = document.querySelector('.content')
          if (!c) return null
          const cs = getComputedStyle(c)
          return `${parseFloat(cs.paddingLeft)}/${parseFloat(cs.paddingRight)}`
        })
      }
      const values = new Set(Object.values(pads).filter(Boolean))
      if (values.size > 1) issues.push(`手机上各页内容区左右边距应一致,实际 ${JSON.stringify(pads)}`)
      return issues
    },
  },
  'density-card-frames': {
    // 响应式表格的卡片形态(设计规范):卡片列表已经装在一个 .card 里时,条目不再画自己的边框(两层同色同圆角的框叠在一起),改用分隔线
    route: '/friends',
    ready: '.kb-fl',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const frames = () =>
        tab.evaluate(() => {
          const out = { inCard: [], free: [] }
          for (const li of document.querySelectorAll('[data-testid=rt-card]')) {
            const c = getComputedStyle(li)
            const row = { border: parseFloat(c.borderTopWidth) + parseFloat(c.borderLeftWidth), radius: c.borderRadius, bg: c.backgroundColor }
            ;(li.closest('.card') ? out.inCard : out.free).push(row)
          }
          return out
        })
      for (const route of ['/friends', '/tasks', '/admin/audit', '/admin/usage']) {
        await tab.goto(new URL(route, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('[data-testid=rt-card]', { timeout: 10_000 }).catch(() => issues.push(`${route}:没有卡片`))
        await tab.waitForTimeout(250)
        const f = await frames()
        if (!f.inCard.length) issues.push(`${route}:卡片应在一个 .card 里`)
        const framed = f.inCard.filter((row) => row.border > 1.5 && row.radius !== '0px')
        if (framed.length) issues.push(`${route}:外层已经是 .card,条目不该再画自己的框(${framed.length} 个条目带边框和圆角)`)
      }
      // 好友页:卡内的搜索框和下面条目的内容在同一条左边线上(搜索条原来用 20px 内边距,条目是 12px)
      await tab.goto(new URL('/friends', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-fl-bar', { timeout: 10_000 }).catch(() => issues.push('/friends:没有搜索条'))
      await tab.waitForTimeout(250)
      const left = await tab.evaluate(() => {
        const input = document.querySelector('.kb-fl-bar input')
        const lead = document.querySelector('[data-testid=rt-card] .kb-avatar, [data-testid=rt-card] .kb-rt-check')
        return input && lead ? { input: Math.round(input.getBoundingClientRect().left), lead: Math.round(lead.getBoundingClientRect().left) } : null
      })
      if (left && Math.abs(left.input - left.lead) > 1) issues.push(`/friends:卡内搜索框左缘 ${left.input} 应和条目内容左缘 ${left.lead} 对齐`)
      return issues
    },
  },
  'density-ph-actions': {
    // 页头操作区(设计规范):手机上操作区换到标题下面并铺满宽度,这对并排的两个按钮是对的(导入「全部同步 / 添加数据」、
    // 评测「返回条数 / 运行评测」)。系统状态的操作区是「更新于 hh:mm:ss」文字 + 一个次要的「刷新」按钮,
    // 刷新被拉成 258px 宽的大按钮,白占一行;应按自己的宽度,靠右
    route: '/admin/system',
    ready: '.kb-ph-actions',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const read = async (route) => {
        await tab.goto(new URL(route, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('.kb-ph-actions', { timeout: 10_000 }).catch(() => issues.push(`${route}:没有页头操作区`))
        await tab.waitForTimeout(250)
        return tab.evaluate(() => {
          const box = document.querySelector('.kb-ph-actions')
          if (!box) return null
          const b = box.getBoundingClientRect()
          return { box: Math.round(b.width), right: Math.round(b.right), kids: [...box.children].filter((el) => el.getBoundingClientRect().width > 0).map((el) => ({ w: Math.round(el.getBoundingClientRect().width), right: Math.round(el.getBoundingClientRect().right), btn: el.tagName === 'BUTTON' })) }
        })
      }
      const sys = await read('/admin/system')
      const refresh = sys?.kids.find((k) => k.btn)
      if (refresh && refresh.w > size.width * 0.4) issues.push(`/admin/system:「刷新」不该拉成大按钮:${refresh.w}px / 屏宽 ${size.width}`)
      if (refresh && Math.abs(refresh.right - sys.right) > 2) issues.push(`/admin/system:「刷新」应靠右:${refresh.right} / ${sys.right}`)
      for (const route of ['/import', '/admin/eval']) {
        const w = await read(route)
        const btns = w?.kids ?? []
        if (btns.length >= 2 && Math.min(...btns.map((k) => k.w)) < w.box * 0.3) issues.push(`${route}:并排的按钮应铺满整行,现在 ${JSON.stringify(btns.map((k) => k.w))} / ${w.box}`)
      }
      return issues
    },
  },
  'density-usage-bar': {
    // 存储与用量的筛选条(手机,设计规范):搜索框独占一行;排序下拉 + 正序按钮一行;只看告警(左)+ 刷新(右)一行。
    // 原来是 flex-wrap:搜索框旁边挤着排序下拉,剩下三个落到第二行,大小不一、右边留空
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-su-bar',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const m = await tab.evaluate(() => {
        const bar = document.querySelector('.kb-su-bar')
        const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), mid: Math.round(b.top + b.height / 2), h: Math.round(b.height), w: Math.round(b.width) } }
        const kids = [...bar.children]
        return { bar: r(bar), kids: kids.map((el) => ({ cls: String(el.className).split(' ')[0] || el.tagName.toLowerCase(), ...r(el) })) }
      })
      const [search, sort, order, onlyAlerts, refresh] = m.kids
      if (!search || m.kids.length !== 5) { issues.push(`筛选条应有 5 个控件,实际 ${m.kids.length}`); return issues }
      if (search.w < m.bar.w * 0.9) issues.push(`搜索框应独占一行:宽 ${search.w} / 条宽 ${m.bar.w}`)
      if (Math.abs(sort.mid - order.mid) > 4) issues.push(`排序下拉与「正序」应在同一行:${sort.mid} / ${order.mid}`)
      if (Math.abs(sort.h - order.h) > 2) issues.push(`排序下拉与「正序」应同高:${sort.h} / ${order.h}`)
      if (Math.abs(onlyAlerts.mid - refresh.mid) > 4) issues.push(`「只看告警」与「刷新」应在同一行:${onlyAlerts.mid} / ${refresh.mid}`)
      if (Math.abs(refresh.right - m.bar.right) > 2) issues.push(`「刷新」应贴右缘:${refresh.right} / ${m.bar.right}`)
      for (const k of m.kids) if (k.left < m.bar.left - 1 || k.right > m.bar.right + 1) issues.push(`${k.cls} 超出了筛选条:${k.left}~${k.right} / ${m.bar.left}~${m.bar.right}`)
      return issues
    },
  },
  'density-mail-log': {
    // 系统参数 · 最近发信记录:失败原因是整段服务器返回的话,放在徽章里会换成两三行;徽章原来是固定 20px 高,
    // 换行后文字溢出徽章,压到下一条的分隔线上。徽章要随内容撑高,文字不超出它自己的盒子,也不超出所在的这一行
    route: '/admin/params',
    ready: '.kb-mail-log',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll('.kb-mail-log li')].map((li) => {
          const tag = li.querySelector('.tag')
          const range = document.createRange()
          range.selectNodeContents(tag)
          const text = range.getBoundingClientRect()
          const box = tag.getBoundingClientRect()
          const row = li.getBoundingClientRect()
          return { label: tag.textContent.trim().slice(0, 14), textTop: Math.round(text.top), textBottom: Math.round(text.bottom), boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom), rowBottom: Math.round(row.bottom) }
        }),
      )
      if (rows.length < 3) issues.push(`夹具里应有至少 3 条发信记录,实际 ${rows.length}`)
      for (const r of rows) {
        if (r.textBottom > r.boxBottom + 1 || r.textTop < r.boxTop - 1) issues.push(`「${r.label}」的文字 ${r.textTop}~${r.textBottom} 超出了徽章 ${r.boxTop}~${r.boxBottom}`)
        if (r.boxBottom > r.rowBottom + 0.5) issues.push(`「${r.label}」的徽章底 ${r.boxBottom} 超出了所在行 ${r.rowBottom}`)
      }
      return issues
    },
  },
  'density-tabs': {
    // 页签(设计规范):手机上同一个 .tabs 组件在各页里首字的位置要一致。
    // 页签条的内边距是 var(--page-pad)(20px),放进已经有 16px 内边距的 .content 里就叠成 36px,首字比内容缩进 32px;
    // 任务、审计页把页签放在 .content 外面所以是 28。统一成 28(= 内容左缘 16 + 按钮自己的 12px 内边距)
    route: '/tasks',
    ready: '.tabs',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const result = {}
      for (const route of ['/tasks', '/friends', '/shares', '/import', '/admin/system', '/admin/audit', '/admin/usage']) {
        await tab.goto(new URL(route, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('.tabs', { timeout: 10_000 }).catch(() => issues.push(`${route}:没有页签`))
        await tab.waitForTimeout(250)
        result[route] = await tab.evaluate(() => {
          const first = document.querySelector('.tabs .tab, .tabs button, .tabs [role=tab]')
          if (!first) return null
          const range = document.createRange()
          range.selectNodeContents(first)
          return Math.round(range.getBoundingClientRect().left)
        })
      }
      const lefts = new Set(Object.values(result).filter((v) => v !== null))
      if (lefts.size > 1) issues.push(`各页页签首字的左缘应一致,实际 ${JSON.stringify(result)}`)
      return issues
    },
  },
  'density-home': {
    // 首页「待处理」(设计规范):行内按钮的文字必须在按钮里(「去处理」比按钮宽会伸出边框);
    // 每一行的文字起点一致(头像和图标同宽,三种行的标题才对得齐)
    route: '/home',
    ready: '[data-testid=home-pending-item]',
    fixture: homeFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=home-pending-item]')].map((row) => {
          const btn = row.querySelector('button')
          const text = row.querySelector('.kb-home-t')
          const lead = row.querySelector('.kb-avatar, .kb-home-ico')
          const b = btn?.getBoundingClientRect()
          const t = text?.getBoundingClientRect()
          const l = lead?.getBoundingClientRect()
          // 按钮里文字有没有超出按钮:用 Range 量文字本身的宽度,和按钮内容区比
          const range = document.createRange()
          range.selectNodeContents(btn)
          const textW = range.getBoundingClientRect().width
          const cs = getComputedStyle(btn)
          return { label: btn?.textContent?.trim(), btnW: Math.round(b.width), textW: Math.round(textW), innerW: Math.round(b.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)), titleLeft: Math.round(t.left), leadW: Math.round(l.width), rowRight: Math.round(row.getBoundingClientRect().right), btnRight: Math.round(b.right) }
        }),
      )
      if (rows.length < 2) issues.push(`夹具里待处理应至少有 2 行,实际 ${rows.length}`)
      for (const r of rows) {
        if (r.textW > r.innerW + 1) issues.push(`「${r.label}」的文字 ${r.textW}px 比按钮内容区 ${r.innerW}px 宽,伸出了按钮`)
        if (r.btnRight > r.rowRight + 0.5) issues.push(`「${r.label}」按钮伸出了行的右缘:${r.btnRight} / ${r.rowRight}`)
      }
      const lefts = new Set(rows.map((r) => r.titleLeft))
      if (lefts.size > 1) issues.push(`各行标题的左缘应对齐,实际 ${[...lefts].join('/')}(头像 / 图标宽度:${rows.map((r) => r.leadW).join('/')})`)
      return issues
    },
  },
  'density-jobs': {
    // 任务页手机卡片(设计规范):排队中的任务还没开始,不画 0% 的进度条,时间行不写「开始 — · 耗时 —」;开始过的照常有进度条
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: jobsStory,
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const cards = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=job-card]')].map((el) => ({
          state: el.querySelector('.kb-job-card-head .tag')?.textContent?.trim() ?? '',
          bar: !!el.querySelector('.kb-job-card-bar'),
          time: el.querySelector('.kb-job-card-time')?.textContent?.trim() ?? '',
          height: Math.round(el.getBoundingClientRect().height),
        })),
      )
      const queued = cards.filter((card) => card.state === '排队')
      if (!queued.length) issues.push(`夹具里应有排队中的任务:${JSON.stringify(cards.map((c) => c.state))}`)
      for (const card of queued) {
        if (card.bar) issues.push('排队中的任务不该画进度条(0% 没有信息)')
        if (card.time.includes('—')) issues.push(`排队中的任务时间行不该写「—」:${card.time}`)
        if (!card.time.startsWith('排队中')) issues.push(`排队中的任务时间行应写「排队中 · 已等 …」:${card.time}`)
      }
      const running = cards.filter((card) => card.state === '运行中')
      if (!running.length) issues.push('夹具里应有运行中的任务')
      for (const card of running) if (!card.bar) issues.push('运行中的任务应有进度条')
      return issues
    },
  },
  'density-review': {
    // 审核收件箱(手机,设计规范):「刷新」不独占一整行;分段控件与下面的卡片左右对齐;
    // 一张卡片不超过屏高的一半,第一屏能看到第一张卡片的「通过」按钮
    route: '/review',
    ready: '[data-testid=draft-card]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const m = await tab.evaluate(() => {
        const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } }
        const tabbar = document.querySelector('[data-testid=tabbar]')
        return { vh: innerHeight, tabbarTop: tabbar ? Math.round(tabbar.getBoundingClientRect().top) : innerHeight, refresh: r('[data-testid=review-refresh]'), all: r('.kb-rv-all'), seg: r('.kb-rv-bar .kb-seg, .kb-rv-bar [role=tablist], .kb-rv-bar > :first-child'), card: r('[data-testid=draft-card]'), approve: r('[data-testid=draft-card] .kb-rv-actions .btn.pri, [data-testid=draft-card] .kb-rv-actions .kb-btn--primary, [data-testid=draft-card] .kb-rv-actions > :first-child'), bar: r('.kb-rv-bar') }
      })
      console.log(`[审核页量测 ${size.width}x${size.height}] ${JSON.stringify(m)}`)
      if (m.refresh && m.refresh.w > size.width * 0.5) issues.push(`「刷新」不该拉成一整行宽的大按钮:宽 ${m.refresh.w} / 屏宽 ${size.width}`)
      if (m.refresh && m.all && Math.abs(m.refresh.top - m.all.top) > 12) issues.push(`「刷新」应和「全选本页」同一行:刷新 top=${m.refresh.top} 全选 top=${m.all.top}`)
      // 第二张卡片的头部要在第一屏里露出来,让人知道下面还有、可以往下滑(用「半屏」这类拍脑袋的数字卡单张卡片高度没有依据)
      const second = await tab.evaluate(() => { const el = document.querySelectorAll('[data-testid=draft-card]')[1]; if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top) } })
      if (second && second.top > m.tabbarTop - 40) issues.push(`第一屏里应露出第二张卡片的头部:第二张 top=${second.top}px,标签栏顶 ${m.tabbarTop}px`)
      if (m.approve && m.approve.bottom > m.tabbarTop) issues.push(`第一屏应能看到第一张卡片的操作按钮:按钮底 ${m.approve.bottom}px,标签栏顶 ${m.tabbarTop}px`)
      return issues
    },
  },
  'density-dup-heading': {
    // 页面标题只出现一次(设计规范):手机顶栏已经写了页面名,页内 KbPageHeader 的标题和它一样时视觉上不再画第二遍;
    // 首页的问候语和顶栏「首页」不同,必须保留。标题仍在 DOM 里(读屏软件要用),只是视觉隐藏
    route: '/review',
    ready: '.kb-topbar',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 600) return issues
      const visibleHeadings = () =>
        tab.evaluate(() => {
          const bar = document.querySelector('#kb-slot-mbar')?.textContent?.trim()
          const shown = [...document.querySelectorAll('.kb-ph-title')].filter((el) => getComputedStyle(el).position !== 'absolute' && el.getBoundingClientRect().height > 2).map((el) => el.textContent.trim())
          const all = [...document.querySelectorAll('.kb-ph-title')].map((el) => el.textContent.trim())
          return { bar, shown, all }
        })
      for (const route of ['/review', '/import', '/friends', '/shares', '/admin/projects', '/admin/eval']) {
        await tab.goto(new URL(route, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('.kb-ph-title', { state: 'attached', timeout: 10_000 }).catch(() => issues.push(`${route}:没有找到页内标题`))
        await tab.waitForTimeout(300)
        const h = await visibleHeadings()
        if (h.shown.includes(h.bar)) issues.push(`${route}:顶栏已写「${h.bar}」,页内还画了同名标题`)
        if (!h.all.includes(h.bar)) issues.push(`${route}:页内标题不该被删掉(读屏软件要用),DOM 里应仍有「${h.bar}」,实际 ${JSON.stringify(h.all)}`)
      }
      // 首页的问候语不同于顶栏,要保留
      await tab.goto(new URL('/home', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-ph-title', { state: 'attached', timeout: 10_000 })
      const home = await visibleHeadings()
      if (!home.shown.length) issues.push('首页的问候语(和顶栏「首页」不同)应保留显示')
      return issues
    },
  },
  'density-kb-small-list': {
    // 知识库列表(设计规范):只有一页时不画分页条(「1 / 1 (9条) 16条▾」占 90px 却什么也翻不了);
    // 有第二页时分页条必须在(默认夹具 38 条分 3 页,上面的 density-kb-list 场景用它)
    route: '/kb?collection=knowledgeBase%2Finsights',
    ready: '.kb-sidebar-item',
    fixture: {
      list_items: (args) => {
        const size = Number(args?.page_size ?? 16)
        const rows = Array.from({ length: 3 }, (_, i) => ({ id: `ins_s${i}`, collection: 'knowledgeBase/insights', kind: 'insight', insight_kind: 'note', confidence: 0.9, lang: null, source: `insight:ins_s${i}`, start_line: null, end_line: null, symbol: null, title: `只有三条的集合 ${i + 1}`, status: 'active', tags: ['uds'], updated_at: 1792514460000 - i * 3_600_000, version: 1 }))
        return { items: rows.slice(0, size), total: 3, page: 1, page_size: size }
      },
    },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const rows = await tab.locator('.kb-sidebar-item').count()
      if (rows !== 3) issues.push(`夹具应列出 3 条,实际 ${rows}`)
      const pager = await tab.evaluate(() => { const el = document.querySelector('.kb-sidebar-pager'); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0 })
      if (pager) issues.push('列表只有一页时不该画分页条')
      return issues
    },
  },
  'density-kb-active-row': {
    // 手机上列表和文档是两个整页:从文档返回列表后,列表里不该留着「当前打开」的高亮(像是被选中了)。
    // 桌面 / 平板两栏时左边是列表、右边是当前文档,高亮是对的,必须保留。多选模式勾选的行(is-selected)不受影响
    route: '/kb?collection=knowledgeBase%2Finsights&item=ins_8f21',
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const active = () => tab.evaluate(() => [...document.querySelectorAll('.kb-sidebar-item.is-active')].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).length)
      if (size.width < 600) {
        await tab.locator('[aria-label=返回列表]').click()
        await tab.waitForSelector('.kb-sidebar-item', { timeout: 8000 })
        await tab.waitForTimeout(300)
        const n = await active()
        if (n !== 0) issues.push(`手机上返回列表后不该有「当前打开」的高亮行,实际 ${n} 行`)
      } else if (size.width >= 1024) {
        const n = await active()
        if (n !== 1) issues.push(`两栏时列表里应高亮当前打开的那一篇(1 行),实际 ${n} 行`)
      }
      return issues
    },
  },
  'density-dup-title': {
    // 标题只出现一次(设计规范):正文第一行是同名的 `# 项目清单` 时,读页面不再画第二遍。
    // 编辑时不藏的断言在 collab-scenarios.mjs 的 collab-dup-title(编辑要走协作房间,这里没有)
    route: '/kb?collection=proj_a&item=ins_8f21',
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)',
    sizes: ['390x844', '1440x900'],
    fixture: {
      get_item: () => ({ item: { id: 'ins_8f21', collection: 'proj_a', kind: 'insight', insight_kind: 'note', title: '项目清单', header: '项目清单', text: WIDE_TABLE_NOTE, tags: [], source: '', updated_at: 1793000000 }, context: null }),
    },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const visibleTitles = () =>
        tab.evaluate(() => [...document.querySelectorAll('.kb-dp h1')].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).map((el) => (el.textContent ?? '').trim()))
      const read = await visibleTitles()
      const same = read.filter((text) => text === '项目清单')
      if (same.length !== 1) issues.push(`读模式下「项目清单」这个一级标题应只出现 1 次,实际 ${same.length}:${JSON.stringify(read)}`)
      // 正文里的内容没被改:藏掉的只是显示,Markdown 原文还在(字数不变)
      const words = await tab.evaluate(() => document.querySelector('.kb-dp-stat')?.textContent ?? '')
      if (!/\d+ 字/.test(words)) issues.push(`字数统计不见了:${words}`)
      return issues
    },
  },
  'density-wide-table': {
    // 手机上宽表格(设计规范):整页不横向溢出;表格在自己的框里滚动,滚动条藏起来,两侧有渐隐提示;能滑到最后一列。
    // 默认路径的阅读态是轻量阅读器:滚动框是包着 <table> 的 .kb-table-scroll;
    // 编辑态(新文本面)里 <table> 自己是滚动框,下面的 density-wide-table-edit 量它
    route: '/kb?collection=proj_a&item=ins_8f21',
    ready: ':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)',
    sizes: ['390x844', '320x568'],
    fixture: {
      get_item: () => ({ item: { id: 'ins_8f21', collection: 'proj_a', kind: 'insight', insight_kind: 'note', title: '项目清单', header: '项目清单', text: WIDE_TABLE_NOTE, tags: [], source: '', updated_at: 1793000000 }, context: null }),
    },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.waitForSelector('.kb-md-read-body .kb-table-scroll', { timeout: 10_000 }).catch(() => issues.push('正文里没有表格'))
      const info = await tab.evaluate(() => {
        const wrap = document.querySelector('.kb-md-read-body .kb-table-scroll')
        if (!wrap) return null
        const c = getComputedStyle(wrap)
        return { sw: wrap.scrollWidth, cw: wrap.clientWidth, scrollbar: c.scrollbarWidth, gradients: (c.backgroundImage.match(/gradient\(/g) ?? []).length, docOverflow: document.documentElement.scrollWidth - innerWidth }
      })
      if (!info) return issues
      if (info.docOverflow > 1) issues.push(`整页不该横向溢出,多出 ${info.docOverflow}px`)
      if (info.sw <= info.cw + 1) issues.push(`测试用的表格应比容器宽(${info.sw} / ${info.cw}),否则测不到滚动`)
      if (size.width <= 640) {
        if (info.scrollbar !== 'none') issues.push(`手机上表格的滚动条应藏起来,scrollbar-width = ${info.scrollbar}`)
        if (info.gradients !== 4) issues.push(`手机上表格两侧应各有渐隐提示和阴影(4 层渐变),实际 ${info.gradients}`)
      }
      // 能滑到最后一列
      const end = await tab.evaluate(() => {
        const wrap = document.querySelector('.kb-md-read-body .kb-table-scroll')
        wrap.scrollLeft = wrap.scrollWidth
        const last = wrap.querySelector('tr th:last-child, tr td:last-child').getBoundingClientRect()
        const box = wrap.getBoundingClientRect()
        return { reachedEnd: Math.abs(wrap.scrollLeft + wrap.clientWidth - wrap.scrollWidth) < 2, lastVisible: last.right <= box.right + 1 }
      })
      if (!end.reachedEnd) issues.push('表格没能滑到最右')
      if (!end.lastVisible) issues.push('滑到最右后最后一列应完整可见')
      return issues
    },
  },
  'density-wide-table-edit': {
    // 同上,编辑态(统一外壳的新文本面):<table> 自己是滚动框(display:block; overflow-x:auto),手机上滚动条藏起来、两侧有渐隐提示、能滑到最后一列
    route: '/kb?collection=proj_a&item=ins_8f21',
    ready: '.kb-workspace-bar-right',
    sizes: ['390x844', '320x568'],
    fixture: {
      // 协同开着而夹具没有 ws 时编辑器会一直只读:用单人编辑夹具(见 0760879e)
      ...SOLO_EDIT_FIXTURE,
      get_item: () => ({ item: { id: 'ins_8f21', collection: 'proj_a', kind: 'insight', insight_kind: 'note', title: '项目清单', header: '项目清单', text: WIDE_TABLE_NOTE, tags: [], source: '', updated_at: 1793000000 }, context: null }),
    },
    prepare: async (tab) => {
      await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
      await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose[contenteditable="true"] table', { timeout: 15_000 })
    },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const info = await tab.evaluate(() => {
        const wrap = document.querySelector('[data-testid="editor-host"] .kb-text-prose table')
        if (!wrap) return null
        const c = getComputedStyle(wrap)
        return { sw: wrap.scrollWidth, cw: wrap.clientWidth, scrollbar: c.scrollbarWidth, gradients: (c.backgroundImage.match(/gradient\(/g) ?? []).length, docOverflow: document.documentElement.scrollWidth - innerWidth }
      })
      if (!info) return ['编辑态正文里没有表格']
      if (info.docOverflow > 1) issues.push(`整页不该横向溢出,多出 ${info.docOverflow}px`)
      if (info.sw <= info.cw + 1) issues.push(`测试用的表格应比容器宽(${info.sw} / ${info.cw}),否则测不到滚动`)
      if (size.width <= 640) {
        if (info.scrollbar !== 'none') issues.push(`手机上表格的滚动条应藏起来,scrollbar-width = ${info.scrollbar}`)
        if (info.gradients !== 4) issues.push(`手机上表格两侧应各有渐隐提示和阴影(4 层渐变),实际 ${info.gradients}`)
      }
      const end = await tab.evaluate(() => {
        const wrap = document.querySelector('[data-testid="editor-host"] .kb-text-prose table')
        wrap.scrollLeft = wrap.scrollWidth
        const last = wrap.querySelector('tr th:last-child, tr td:last-child').getBoundingClientRect()
        const box = wrap.getBoundingClientRect()
        return { reachedEnd: Math.abs(wrap.scrollLeft + wrap.clientWidth - wrap.scrollWidth) < 2, lastVisible: last.right <= box.right + 1 }
      })
      if (!end.reachedEnd) issues.push('表格没能滑到最右')
      if (!end.lastVisible) issues.push('滑到最右后最后一列应完整可见')
      return issues
    },
  },

  'density-search-controls': {
    // 搜索页控件区(设计规范):占位符不被截断;选项行里的控件同高、左缘只落在两条竖线上;「搜索」按钮在手机上不带回车符号
    route: '/search',
    ready: '.kb-search-top',
    sizes: ['390x844', '320x568'],
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      if (size.width >= 640) return issues
      const input = await tab.evaluate(() => {
        const el = document.querySelector('.kb-searchbar-input')
        const probe = document.createElement('span')
        const style = getComputedStyle(el)
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};letter-spacing:${style.letterSpacing}`
        probe.textContent = el.placeholder
        document.body.appendChild(probe)
        const need = probe.getBoundingClientRect().width
        probe.remove()
        // 内容区宽度:不用 clientWidth —— 它在 Chromium / WebKit 里含 padding,在 Firefox 的 <input> 上不含,同一个输入框差出一个 padding
        const box = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
        return { placeholder: el.placeholder, need: Math.ceil(need), have: Math.floor(box) }
      })
      if (input.need > input.have) issues.push(`占位符被截断:「${input.placeholder}」需要 ${input.need}px,输入框只有 ${input.have}px`)
      const go = (await tab.locator('.kb-search-go').innerText()).trim()
      if (/↵/.test(go)) issues.push(`手机没有回车键,「搜索」按钮上不该带 ↵:「${go}」`)
      // 搜索框和右边的按钮要等高(差 ≤2px),否则一高一矮很难看
      const bar = await rect(tab, '.kb-searchbar')
      const goBox = await rect(tab, '.kb-search-go')
      if (Math.abs(bar.height - goBox.height) > 2) issues.push(`搜索框与「搜索」按钮应等高:框 ${Math.round(bar.height)}px / 按钮 ${Math.round(goBox.height)}px`)
      const cells = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=search-options] > *')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { text: (el.textContent ?? '').trim().slice(0, 8), left: Math.round(r.left), top: Math.round(r.top), height: Math.round(r.height), right: Math.round(r.right) }
          }),
      )
      if (cells.length < 3) issues.push(`选项行应至少有 3 个控件,实际 ${cells.length}`)
      const heights = new Set(cells.map((c) => c.height))
      if (Math.max(...heights) - Math.min(...heights) > 1) issues.push(`同一块里的控件高度应一致:${cells.map((c) => `${c.text}=${c.height}`).join(' ')}`)
      const lefts = new Set(cells.map((c) => c.left))
      if (lefts.size > 2) issues.push(`控件左缘应只落在两条竖线上,实际 ${[...lefts].join('/')}:${cells.map((c) => `${c.text}@${c.left}`).join(' ')}`)
      const over = cells.filter((c) => c.right > size.width - 8)
      if (over.length) issues.push(`控件超出卡片右缘:${over.map((c) => c.text).join('、')}`)
      return issues
    },
  },
  'density-safe-top-browser': {
    // 普通浏览器标签页:即使浏览器报了 46px 的顶部安全区,页面也不该为它空出一截(设计规范)
    route: '/search',
    ready: '.kb-topbar',
    sizes: ['390x844'],
    settle: 300,
    prepare: async (tab) => {
      if (tab.context().browser()?.browserType().name() !== 'chromium') return
      await lieAboutSafeArea(tab, 46)
      await tab.waitForTimeout(150)
    },
    assert: async (tab) => {
      const issues = []
      if (tab.context().browser()?.browserType().name() !== 'chromium') return issues // 其他引擎没有覆盖接口
      const top = await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim())
      const pad = await tab.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kb-app')).paddingTop))
      const bar = await rect(tab, '.kb-topbar')
      if (pad > 0.5) issues.push(`普通浏览器里外壳不该给顶部留安全区,padding-top = ${pad}px(--safe-top: ${top})`)
      if (bar.top > 0.5) issues.push(`顶栏应贴着页面顶边,实际 top = ${bar.top}`)
      return issues
    },
  },
  'density-safe-top-standalone': {
    // 已安装的独立窗口:页面真的铺到状态栏下面,这时必须让出(设计规范)
    route: '/search',
    ready: '.kb-topbar',
    sizes: ['390x844'],
    settle: 300,
    init: STANDALONE_INIT,
    prepare: async (tab) => {
      if (tab.context().browser()?.browserType().name() !== 'chromium') return
      await lieAboutSafeArea(tab, 46)
      await tab.waitForTimeout(150)
    },
    assert: async (tab) => {
      const issues = []
      if (tab.context().browser()?.browserType().name() !== 'chromium') return issues
      const mode = await tab.evaluate(() => document.documentElement.dataset.displayMode)
      if (mode !== 'standalone') issues.push(`场景没进独立窗口模式:data-display-mode = ${mode}`)
      const pad = await tab.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kb-app')).paddingTop))
      if (Math.abs(pad - 46) > 0.5) issues.push(`独立窗口里外壳应让出 46px 的顶部安全区,实际 ${pad}px`)
      const bar = await rect(tab, '.kb-topbar')
      if (bar.top < 45.5) issues.push(`独立窗口里顶栏应让开状态栏(top ≥ 46),实际 ${bar.top}`)
      return issues
    },
  },
}
