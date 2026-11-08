// 外观设置:主题 / 强调色 / 布局 / 宽度 / 密度 / 圆角 / 字号 / 动效(设计规范)。
//
// 通过 <html> 上的 data-* 属性切换,token 层用属性选择器取值;
// 持久化到 localStorage,首屏由 index.html 的内联脚本先写一次,避免闪烁。
import { reactive, watch } from 'vue'

export interface Appearance {
  theme: 'dark' | 'oled' | 'slate' | 'light' | 'paper' | 'system'
  accent: string
  layout: 'rail' | 'sidebar' | 'topnav'
  width: 'fluid' | 'centered'
  // 取值必须与 token 层的属性选择器一致(component.css / motion-tokens.css):
  // density = default | compact | comfortable;radius = default | sharp | round;
  // font = s | m | l;motion = mac | crisp | lively | reduce
  density: 'default' | 'compact' | 'comfortable'
  radius: 'default' | 'sharp' | 'round'
  font: 's' | 'm' | 'l'
  motion: 'mac' | 'crisp' | 'lively' | 'reduce'
}

const STORAGE_KEY = 'kb.appearance'

const DEFAULTS: Appearance = {
  theme: 'dark',
  accent: 'indigo',
  // 默认值与 设计稿的设计稿一致(仪表盘设计稿 用的是 sidebar + 默认密度/圆角)
  layout: 'sidebar',
  width: 'fluid',
  density: 'default',
  radius: 'default',
  font: 'm',
  motion: 'mac',
}

const ATTRS: Record<keyof Appearance, string> = {
  theme: 'data-theme',
  accent: 'data-accent',
  layout: 'data-layout',
  width: 'data-width',
  density: 'data-density',
  radius: 'data-radius',
  font: 'data-font',
  motion: 'data-motion',
}

function load(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

const state = reactive<Appearance>(load())

/** token 层真正定义了的主题(semantic.css 里的 [data-theme=...])。 */
const THEMES = ['dark', 'oled', 'slate', 'light', 'paper'] as const

/**
 * 把设置里的主题解析成 token 层认识的主题:
 *   - 「跟随系统」(system)按 prefers-color-scheme 落到 dark / light;
 *   - 未知值(旧版本存下的、手改的)一律落到 dark。
 * 不能把 system 原样写到 data-theme:token 层没有这个主题,所有颜色变量都会变成空值,
 * 文字和输入框里的字会变成黑色,在深色背景上看不见(曾经在登录页出现过)。
 */
export function resolveTheme(theme: string): (typeof THEMES)[number] {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return (THEMES as readonly string[]).includes(theme) ? (theme as (typeof THEMES)[number]) : 'dark'
}

/**
 * 各主题的浏览器 / 系统栏颜色(<meta name=theme-color>):等于该主题的页面底色 --bg-canvas,
 * 这样独立窗口的标题栏 / 手机状态栏和顶栏连成一片。数值必须和 semantic.css 一致(useAppearance.spec.ts 逐个核对)。
 */
export const THEME_COLORS: Record<(typeof THEMES)[number], string> = {
  dark: '#08080a',
  oled: '#000000',
  slate: '#0a0e16',
  light: '#fafafa',
  paper: '#f6f3ec',
}

function syncThemeColor(theme: (typeof THEMES)[number]) {
  const color = THEME_COLORS[theme]
  const metas = document.querySelectorAll('meta[name="theme-color"]')
  if (metas.length) {
    // 静态页里可能还有带 media 的版本:统一成当前主题,并去掉 media(应用内的主题选择比系统深浅色更准)
    metas.forEach((meta) => {
      meta.setAttribute('content', color)
      meta.removeAttribute('media')
    })
    return
  }
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = color
  document.head.appendChild(meta)
}

function apply(next: Appearance) {
  const root = document.documentElement
  for (const key of Object.keys(ATTRS) as (keyof Appearance)[]) {
    root.setAttribute(ATTRS[key], key === 'theme' ? resolveTheme(next.theme) : next[key])
  }
  // 自定义强调色必须落到 data-accent=custom:semantic.css 只有 [data-accent=custom] 这组选择器
  // 会读 --accent-custom。把 #rrggbb 原样写到 data-accent 不会命中任何规则,强调色会静默失效。
  const custom = next.accent.startsWith('#')
  if (custom) root.setAttribute(ATTRS.accent, 'custom')
  // 原始选择另存一份,外观页据此高亮「跟随系统」
  root.setAttribute('data-theme-pref', next.theme)
  if (custom) {
    root.style.setProperty('--accent-custom', next.accent)
  } else {
    root.style.removeProperty('--accent-custom')
  }
  const effective = resolveTheme(next.theme)
  root.setAttribute('data-tone', effective === 'light' || effective === 'paper' ? 'light' : 'dark')
  syncThemeColor(effective)
}

apply(state)
watch(state, (next) => {
  apply(next)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}, { deep: true })

// 跟随系统:theme=system 时按 prefers-color-scheme 选 dark / light
const media = window.matchMedia?.('(prefers-color-scheme: light)')
if (media) {
  media.addEventListener('change', () => {
    if (state.theme === 'system') apply(state)
  })
}

/** 全局唯一的外观设置(响应式)。 */
export function useAppearance() {
  return state
}
