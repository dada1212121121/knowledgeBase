// 首屏防闪烁:在样式生效之前把外观设置写到 <html>(视觉基线规范)
;(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('kb.appearance') || '{}')
    const keys = ['theme', 'accent', 'layout', 'width', 'density', 'radius', 'font', 'motion']
    const attrs = {
      theme: 'data-theme',
      accent: 'data-accent',
      layout: 'data-layout',
      width: 'data-width',
      density: 'data-density',
      radius: 'data-radius',
      font: 'data-font',
      motion: 'data-motion',
    }
    keys.forEach((key) => {
      if (saved[key]) document.documentElement.setAttribute(attrs[key], saved[key])
    })
    const themes = ['dark', 'oled', 'slate', 'light', 'paper']
    const pref = saved.theme || 'dark'
    const theme =
      pref === 'system'
        ? window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : themes.indexOf(pref) >= 0
          ? pref
          : 'dark'
    document.documentElement.setAttribute('data-theme', theme)
    // 浏览器 / 系统栏颜色跟页面底色一致(数值与 useAppearance.ts 的 THEME_COLORS 相同,spec 里核对)
    const colors = { dark: '#08080a', oled: '#000000', slate: '#0a0e16', light: '#fafafa', paper: '#f6f3ec' }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', colors[theme])
    document.documentElement.setAttribute(
      'data-tone',
      theme === 'light' || theme === 'paper' ? 'light' : 'dark',
    )
    if (saved.accent && saved.accent.indexOf('#') === 0) {
      // 和 useAppearance.apply 保持一致:hex 必须配合 data-accent=custom,
      // 否则首屏样式找不到 --accent-custom 的消费者,会先闪一下默认靛蓝。
      document.documentElement.setAttribute('data-accent', 'custom')
      document.documentElement.style.setProperty('--accent-custom', saved.accent)
    }
  } catch {
    /* 外观读不到就保持 HTML 上的默认值 */
  }
  // 界面偏好(列表密度):和外观同理,在样式生效前写好,避免首屏先按默认密度画一遍再跳变
  try {
    const ui = JSON.parse(localStorage.getItem('kb.ui') || '{}')
    document.documentElement.setAttribute('data-ui-density', ui.density === 'compact' ? 'compact' : 'comfortable')
  } catch {
    document.documentElement.setAttribute('data-ui-density', 'comfortable')
  }
})()
