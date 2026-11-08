// 外观设置:默认值与 token 层的 data-* 轴一致,切换后写到 <html> 上。
import { describe, expect, it } from 'vitest'
import { readText } from '../../../../scripts/lib/files.mjs'
import { THEME_COLORS, resolveTheme, useAppearance } from './useAppearance'

describe('useAppearance', () => {
  it('默认值与设计稿一致(sidebar + 默认密度/圆角 + mac 动效)', () => {
    const appearance = useAppearance()
    expect(appearance.layout).toBe('sidebar')
    expect(appearance.density).toBe('default')
    expect(appearance.radius).toBe('default')
    expect(appearance.motion).toBe('mac')
  })

  it('切换后写到 html 的 data-* 属性上', async () => {
    const appearance = useAppearance()
    appearance.theme = 'light'
    appearance.layout = 'rail'
    await Promise.resolve()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-layout')).toBe('rail')
    // 还原,避免影响其它用例
    appearance.theme = 'dark'
    appearance.layout = 'sidebar'
  })

  it('「跟随系统」不会把 system 原样写到 data-theme(token 层没有这个主题,文字会变成看不见的黑色)', async () => {
    const appearance = useAppearance()
    appearance.theme = 'system'
    await Promise.resolve()
    const written = document.documentElement.getAttribute('data-theme')
    expect(['dark', 'light']).toContain(written)
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system')
    expect(['dark', 'light']).toContain(document.documentElement.getAttribute('data-tone'))
    appearance.theme = 'dark'
  })

  it('resolveTheme:按系统深浅色解析,未知值回落到深色', () => {
    expect(['dark', 'light']).toContain(resolveTheme('system'))
    expect(resolveTheme('paper')).toBe('paper')
    expect(resolveTheme('不存在的主题')).toBe('dark')
  })

  it('自定义 hex 强调色写成 data-accent=custom,并清掉残留的 --accent-custom', async () => {
    const appearance = useAppearance()
    appearance.accent = '#ff8800'
    await Promise.resolve()
    expect(document.documentElement.getAttribute('data-accent')).toBe('custom')
    expect(document.documentElement.style.getPropertyValue('--accent-custom')).toBe('#ff8800')

    appearance.accent = 'indigo'
    await Promise.resolve()
    expect(document.documentElement.getAttribute('data-accent')).toBe('indigo')
    expect(document.documentElement.style.getPropertyValue('--accent-custom')).toBe('')
  })

  it('首屏脚本把已保存的自定义强调色还原成 custom(不能把 hex 原样写到 data-accent)', () => {
    localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'dark', accent: '#ff8800' }))
    new Function(readText('public/appearance-boot.js'))()
    expect(document.documentElement.getAttribute('data-accent')).toBe('custom')
    expect(document.documentElement.style.getPropertyValue('--accent-custom')).toBe('#ff8800')
    localStorage.removeItem('kb.appearance')
    // 还原单例状态,避免污染后面的用例
    const appearance = useAppearance()
    appearance.accent = 'indigo'
    appearance.theme = 'dark'
  })
})

describe('主题色(<meta name=theme-color>)', () => {
  const semantic = readText('packages/kb-ui/src/tokens/semantic.css')

  it('每个主题的颜色等于 semantic.css 里该主题的 --bg-canvas(顶栏用它,系统栏才能和顶栏连成一片)', () => {
    for (const [theme, color] of Object.entries(THEME_COLORS)) {
      // 取该主题的块:从 [data-theme=xxx] 到下一个 [data-theme=
      const start = semantic.indexOf(`[data-theme=${theme}]`)
      expect(start, theme).toBeGreaterThanOrEqual(0)
      const block = semantic.slice(start, start + 600)
      expect(block.match(/--bg-canvas:(#[0-9a-f]{6})/i)?.[1], theme).toBe(color)
    }
  })
  it('首屏脚本 appearance-boot.js 里的颜色表和这里一致', () => {
    const boot = readText('public/appearance-boot.js')
    for (const [theme, color] of Object.entries(THEME_COLORS)) expect(boot).toContain(`${theme}: '${color}'`)
  })
  it('切换主题后同步 meta;带 media 的静态版本被统一成当前主题', async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">'
    const appearance = useAppearance()
    appearance.theme = 'paper'
    await Promise.resolve()
    const metas = [...document.querySelectorAll('meta[name=theme-color]')]
    expect(metas.map((meta) => meta.getAttribute('content'))).toEqual([THEME_COLORS.paper, THEME_COLORS.paper])
    expect(metas.every((meta) => !meta.hasAttribute('media'))).toBe(true)
    appearance.theme = 'dark'
    await Promise.resolve()
    expect(document.querySelector('meta[name=theme-color]')?.getAttribute('content')).toBe(THEME_COLORS.dark)
  })
  it('页面里没有 theme-color 时自己补一个', async () => {
    document.head.innerHTML = ''
    const appearance = useAppearance()
    appearance.theme = 'light'
    await Promise.resolve()
    expect(document.querySelectorAll('meta[name=theme-color]')).toHaveLength(1)
    expect(document.querySelector('meta[name=theme-color]')?.getAttribute('content')).toBe(THEME_COLORS.light)
    appearance.theme = 'dark'
  })
})
