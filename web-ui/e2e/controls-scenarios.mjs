// 控件在各主题下看得清吗:开关关闭态的轨道边、输入框的边,相对它可能坐落的每一层背景 ≥ 3:1(WCAG 1.4.11 非文本对比度)。
// 回归自真机反馈:深色下开关、输入框几乎看不见。令牌表(check-contrast)只证明 --control-line 这个值够,
// 这里量的是浏览器里**真正渲染出来的颜色**,CSS 规则被别处覆盖、写错变量名都会在这里红。
// 由 viewer-shots.mjs 引入。

const THEMES = [
  ['dark', 'dark'],
  ['oled', 'dark'],
  ['slate', 'dark'],
  ['light', 'light'],
  ['paper', 'light'],
]

/** 在页面里切主题并量两类控件;返回每个主题最差的对比度 */
async function measure(tab, theme, tone, kind) {
  return tab.evaluate(
    ([name, mode, what]) => {
      document.documentElement.setAttribute('data-theme', name)
      document.documentElement.setAttribute('data-tone', mode)
      const parse = (value) => {
        const match = String(value).match(/rgba?\(([^)]+)\)/)
        if (!match) return null
        const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number)
        return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 }
      }
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
      // 控件可能坐落的所有背景:读渲染后的颜色(令牌可能是 var 引用,直接读变量值不准)
      const surfaces = ['--bg-canvas', '--bg-sidebar', '--surface-1', '--surface-2', '--surface-3', '--surface-sunken'].map((token) => {
        const probe = document.createElement('div')
        probe.style.background = `var(${token})`
        document.body.appendChild(probe)
        const color = parse(getComputedStyle(probe).backgroundColor)
        probe.remove()
        return color?.rgb
      }).filter(Boolean)
      // 半透明的描边要先按透明度叠到背景上,再和背景比;直接拿它的 RGB 去比会把 rgba(白,.1) 当成纯白,得出 17:1 的假高分
      const worstAgainst = (color) =>
        Math.min(...surfaces.map((surface) => ratio(color.rgb.map((v, index) => v * color.alpha + surface[index] * (1 - color.alpha)), surface)))

      const out = {}
      if (what === 'switch') {
        const off = document.querySelector('.sw:not(.on)')
        if (off) {
          // box-shadow 的计算值形如 "rgb(105, 105, 110) 0px 0px 0px 1px inset"
          const ring = parse(getComputedStyle(off).boxShadow)
          out.ring = ring ? { alpha: ring.alpha, worst: worstAgainst(ring) } : null
        }
      } else {
        const input = document.querySelector('.kb-input')
        if (input) {
          const border = parse(getComputedStyle(input).borderTopColor)
          out.ring = border ? { alpha: border.alpha, worst: worstAgainst(border) } : null
        }
      }
      return out
    },
    [theme, tone, kind],
  )
}

/** 逐主题量一类控件,返回问题列表,同时把实测数值打出来(留证据,不只看通过 / 不通过) */
async function check(tab, kind, label) {
  const issues = []
  const seen = []
  for (const [theme, tone] of THEMES) {
    const { ring } = await measure(tab, theme, tone, kind)
    if (!ring) {
      issues.push(`${theme}:找不到${label}或读不到它的描边`)
      continue
    }
    seen.push(`${theme} ${ring.worst.toFixed(2)}`)
    if (ring.alpha < 1) issues.push(`${theme}:${label}的描边是半透明的,对比度会随背景变,要用不透明色`)
    if (ring.worst < 3) issues.push(`${theme}:${label}的描边对比度 ${ring.worst.toFixed(2)} < 3`)
  }
  console.log(`[控件对比度 ${label}] ${seen.join(' · ')}`)
  return issues
}

/** 纯图标按钮里,图标的中心偏离按钮中心超过 2px 的(触屏下 min-width 把按钮撑宽、内容却靠左,图标就偏了) */
async function offCenterIcons(tab) {
  return tab.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' }
    const out = []
    for (const btn of document.querySelectorAll('button, a.btn, [role=button]')) {
      if (!vis(btn)) continue
      const icons = [...btn.querySelectorAll('svg')].filter(vis)
      if (icons.length !== 1) continue
      const words = [...btn.querySelectorAll('*')].filter((el) => el.children.length === 0 && !el.closest('svg') && vis(el) && (el.textContent ?? '').trim()).length + [...btn.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length
      if (words) continue
      const b = btn.getBoundingClientRect(), i = icons[0].getBoundingClientRect()
      const dx = i.left + i.width / 2 - (b.left + b.width / 2), dy = i.top + i.height / 2 - (b.top + b.height / 2)
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) out.push(`${btn.getAttribute('aria-label') ?? btn.className} ${Math.round(b.width)}×${Math.round(b.height)} 偏 ${dx.toFixed(1)},${dy.toFixed(1)}`)
    }
    return out
  })
}

export const CONTROLS_SCENARIOS = {
  'controls-switch': {
    route: '/search?q=uds',
    ready: '.kb-hit',
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: (tab) => check(tab, 'switch', '关闭态开关'),
  },
  'controls-input': {
    // 导入页的「粘贴网址」是普通的 .kb-input;搜索页的搜索框边框是强调色,不归 --control-line 管
    route: '/import',
    ready: '[data-testid=import]',
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: (tab) => check(tab, 'input', '输入框'),
  },
  'controls-icon-centered': {
    // 纯图标按钮(文档顶栏的分享 / 更多操作等)里图标要在按钮正中。回归自真机截图:手机上「分享」按钮的图标偏左 7px
    route: '/kb?collection=knowledgeBase%2Finsights&item=ins_8f21',
    ready: '.kb-workspace-bar',
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const bad = await offCenterIcons(tab)
      return bad.map((entry) => `图标不在按钮中心:${entry}`)
    },
  },
}
