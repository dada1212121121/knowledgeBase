/**
 * 快捷键的显示文字（之后的按钮提示、下拉菜单、快捷键一览共用）。
 *
 * 数据里一律按 Windows / Linux 的写法记（`Ctrl+Shift+X`），显示时再按平台换：macOS 上 Ctrl 对应 ⌘、Alt 对应 ⌥，
 * 写成苹果的习惯顺序 ⌥⇧⌘ + 键（和系统菜单里看到的一样）。`Tab / Shift+Tab` 这种两组键用 ` / ` 分开，各自换。
 */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

function macCombo(combo: string): string {
  const parts = combo.split('+')
  // 最后一段是键本身；`Ctrl++` 这种键是加号的写法用不到，不处理
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((part) => part.trim().toLowerCase()))
  return `${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('ctrl') ? '⌘' : ''}${key}`
}

/** 按平台显示的快捷键文字；mac 参数给单测用 */
export function shortcutLabel(keys: string, mac = MAC): string {
  if (!mac) return keys
  return keys
    .split(' / ')
    .map((combo) => (/^(?:Ctrl|Alt|Shift)\+/.test(combo) ? macCombo(combo) : combo))
    .join(' / ')
}

/**
 * `aria-keyshortcuts` 的标准写法（WAI-ARIA：`Control+Shift+X`，多组用空格分开）。
 * macOS 上 Ctrl 实际是 ⌘，写成 Meta；读屏据此读出真实要按的键。
 */
export function ariaShortcut(keys: string, mac = MAC): string {
  return keys
    .split(' / ')
    .map((combo) =>
      combo
        .split('+')
        .map((part) => (part === 'Ctrl' ? (mac ? 'Meta' : 'Control') : part))
        .join('+'),
    )
    .join(' ')
}
