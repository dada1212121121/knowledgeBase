// 组件间距:卡片内边距是 16(桌面与手机一致,视觉基线规范)、列表行不比触屏要求多占、父级已有 gap 的地方子块不再叠 margin。
// 回归自「有些间距太大,浪费空间」:量到手机上的卡片实际是 20px(规则特异性不够,从来没生效过)、列表行 61px、管理页两处叠成 24px。
// 由 viewer-shots.mjs 引入。
import { rect } from './shell-scenarios.mjs'

const phone = (size) => size.width < 600

export const SPACING_SCENARIOS = {
  'spacing-card-pad': {
    route: '/review',
    ready: '[data-testid=draft-card]',
    settle: 400,
    assert: async (tab, size) => {
      const pad = await tab.evaluate(() => {
        const card = document.querySelector('[data-testid=draft-card]')
        const cs = getComputedStyle(card)
        return { top: parseFloat(cs.paddingTop), left: parseFloat(cs.paddingLeft), token: getComputedStyle(document.documentElement).getPropertyValue('--card-pad-ui').trim() }
      })
      const want = 16
      const issues = []
      if (pad.top !== want || pad.left !== want) issues.push(`卡片内边距应为 ${want}px,实际 ${pad.top}/${pad.left},--card-pad-ui=${pad.token}`)
      return issues
    },
  },
  'spacing-list-row': {
    route: '/kb?collection=knowledgeBase%2Finsights',
    ready: '.kb-sidebar-item',
    settle: 400,
    assert: async (tab, size) => {
      if (!phone(size)) return []
      const h = await tab.evaluate(() => document.querySelector('.kb-sidebar-item').getBoundingClientRect().height)
      const issues = []
      // 两行文字 ~39px + 上下各 8px ≈ 55px;远超触屏要求的 44px,不该再多
      if (h > 57) issues.push(`列表行高 ${h.toFixed(1)}px,应 ≤ 57(两行文字加上下各 8px 内边距)`)
      if (h < 44) issues.push(`列表行高 ${h.toFixed(1)}px,低于触屏要求的 44px`)
      return issues
    },
  },
  'spacing-no-stacked-gap': {
    // 用户页:页签条上下不叠 margin 和 gap(量到 24px);系统概览:账号块和下面的网格之间不叠(量到 24px)
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    settle: 400,
    assert: async (tab) => {
      const gaps = await tab.evaluate(() => {
        const tabs = document.querySelector('.kb-ut-tabs')
        const prev = tabs.previousElementSibling
        const next = tabs.nextElementSibling
        const t = tabs.getBoundingClientRect()
        return { above: prev ? Math.round(t.top - prev.getBoundingClientRect().bottom) : null, below: next ? Math.round(next.getBoundingClientRect().top - t.bottom) : null }
      })
      const issues = []
      for (const [where, gap] of Object.entries(gaps)) if (gap !== null && gap > 16) issues.push(`页签条${where === 'above' ? '上' : '下'}方间距 ${gap}px,应 ≤ 16(父级 gap 已经够了,别再叠 margin)`)
      return issues
    },
  },
  'spacing-search-options-contained': {
    // 手机上搜索卡片拆开后(.kb-search-top{display:contents}),选项区不再属于任何 .card,sweep 的「超出面板」检查管不到它:
    // 这里补一条,选项区里的每个子项都在选项区自己的盒子里,选项区本身不超出屏幕
    route: '/search?q=uds',
    ready: '.kb-search-options',
    sizes: ['390x844', '320x568', '360x780'],
    settle: 400,
    assert: async (tab, size) => {
      const r = await tab.evaluate(() => {
        const box = document.querySelector('.kb-search-options')
        const o = box.getBoundingClientRect()
        const outside = [...box.children].filter((k) => { const b = k.getBoundingClientRect(); return b.width > 0 && (b.right > o.right + 1 || b.left < o.left - 1) }).map((k) => String(k.className).split(' ')[0] || k.tagName.toLowerCase())
        return { left: Math.round(o.left), right: Math.round(o.right), outside }
      })
      const issues = []
      if (r.left < 0 || r.right > size.width + 1) issues.push(`选项区超出屏幕:${r.left}~${r.right} / ${size.width}`)
      if (r.outside.length) issues.push(`选项区里有子项伸出了选项区:${r.outside.join('、')}`)
      return issues
    },
  },
}
