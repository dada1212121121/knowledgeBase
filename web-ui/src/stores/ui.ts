// 界面偏好:侧栏状态与宽度、列表密度。
//
// 存放规则(任务约定):
//   - 先读 localStorage(`kb.ui`)立即渲染,避免等网络造成闪烁;
//   - 登录后用服务端的 `prefs.ui` 覆盖(换设备也一样);
//   - 每次变更立刻写 localStorage,并防抖 500ms 后整体 PUT 回服务端,失败静默。
// 「没选过」和「选了默认值」是两回事:`sidebar` 为 null 表示用户没动过,
// 这时由页面类型和屏幕宽度决定默认状态(电脑展开,平板是图标栏)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchPrefs, savePrefs, type PrefsObject } from '@/api/prefs'

export type SidebarState = 'expanded' | 'rail' | 'hidden'
export type UiDensity = 'comfortable' | 'compact'

export const SIDEBAR_STATES: readonly SidebarState[] = ['expanded', 'rail', 'hidden']
export const DENSITIES: readonly UiDensity[] = ['comfortable', 'compact']

/** 展开宽度的范围与默认值(px)。图标栏固定 64。 */
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
export const SIDEBAR_DEFAULT = 240
export const RAIL_WIDTH = 64
/** 拖动边缘时的吸附阈值:小于 SNAP_HIDE 收成「隐藏」,小于 SNAP_RAIL 收成图标栏,否则按宽度展开。 */
export const SNAP_HIDE = 40
export const SNAP_RAIL = 140

const STORAGE_KEY = 'kb.ui'
const SAVE_DELAY_MS = 500

export interface UiPrefs {
  sidebar?: SidebarState
  sidebarWidth?: number
  density?: UiDensity
  /**
   * 用户手动收起的导航分组(组 id)。
   * 不写这个键 = 没选过,按「整列放不放得下」自动决定;写了空数组 = 手动展开过,以后不再自动收。
   */
  navCollapsed?: string[]
}

export function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)))
}

/** 把任意来源(localStorage / 服务端)的值洗成合法的偏好;不认识的键和值直接丢掉。 */
export function sanitizeUi(raw: unknown): UiPrefs {
  const out: UiPrefs = {}
  if (!raw || typeof raw !== 'object') return out
  const source = raw as Record<string, unknown>
  if (typeof source.sidebar === 'string' && (SIDEBAR_STATES as readonly string[]).includes(source.sidebar)) {
    out.sidebar = source.sidebar as SidebarState
  }
  if (typeof source.sidebarWidth === 'number' && Number.isFinite(source.sidebarWidth)) {
    out.sidebarWidth = clampSidebarWidth(source.sidebarWidth)
  }
  if (typeof source.density === 'string' && (DENSITIES as readonly string[]).includes(source.density)) {
    out.density = source.density as UiDensity
  }
  // 分组 id 只可能是 navModel.ts 里的那几个('mine' / 'admin');认不出来的直接丢掉,不让偏好变成垃圾场
  if (Array.isArray(source.navCollapsed)) {
    const ids = source.navCollapsed.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id))
    out.navCollapsed = [...new Set(ids)].slice(0, 8)
  }
  return out
}

function readLocal(): UiPrefs {
  try {
    return sanitizeUi(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

function writeLocal(prefs: UiPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 隐私模式 / 配额满:本次会话照常工作,只是下次不记得
  }
}

/** 密度写到 <html>,新的列表 / 卡片 token 据此取值(见 tokens/ui.css)。 */
export function applyDensity(density: UiDensity) {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-ui-density', density)
}

export const useUiStore = defineStore('ui', () => {
  const initial = readLocal()
  /** null = 用户没选过,由上下文决定默认值。 */
  const sidebar = ref<SidebarState | null>(initial.sidebar ?? null)
  const sidebarWidth = ref<number>(initial.sidebarWidth ?? SIDEBAR_DEFAULT)
  const density = ref<UiDensity>(initial.density ?? 'comfortable')
  /** null = 用户没讲过分组的事,侧栏自己按能不能放下决定;[] = 手动展开过,别自作主张。 */
  const navCollapsed = ref<string[] | null>(initial.navCollapsed ?? null)
  applyDensity(density.value)

  /** 服务端偏好的完整副本(整体替换式 PUT 要原样带回其它键);null = 还没成功取到。 */
  let serverPrefs: PrefsObject | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false

  function current(): UiPrefs {
    const out: UiPrefs = { sidebarWidth: sidebarWidth.value, density: density.value }
    if (sidebar.value) out.sidebar = sidebar.value
    // 只有用户真的点过分组才写这个键(空数组也要写:它代表「就是要展开」)
    if (navCollapsed.value) out.navCollapsed = navCollapsed.value
    return out
  }

  /** 立刻写本地,防抖后写服务端。 */
  function persist() {
    writeLocal(current())
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  /** 把待写的偏好发给服务端。没取到过服务端偏好时先取一次,取不到就放弃(宁可不写也不冲掉别的键)。 */
  async function flush(options: { keepalive?: boolean } = {}) {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!dirty) return
    if (!serverPrefs) {
      serverPrefs = await fetchPrefs()
      if (!serverPrefs) return
    }
    dirty = false
    const ok = await savePrefs({ ...serverPrefs, ui: current() }, options)
    if (ok) serverPrefs = { ...serverPrefs, ui: current() }
    else dirty = true
  }

  /** 登录后调用:服务端有 `ui` 就以它为准;没有而本地有选择,就把本地的推上去。 */
  async function syncFromServer() {
    const prefs = await fetchPrefs()
    if (!prefs) return
    serverPrefs = prefs
    const remote = sanitizeUi(prefs.ui)
    if (Object.keys(remote).length === 0) {
      if (sidebar.value || navCollapsed.value) persist()
      return
    }
    // 服务端覆盖本地;没有的键保持本地值(例如老版本只存过密度)
    // 服务端有 ui 对象就以它为准:它没写 sidebar 说明用户在别的设备上恢复了「自动」
    sidebar.value = remote.sidebar ?? null
    if (remote.sidebarWidth !== undefined) sidebarWidth.value = remote.sidebarWidth
    navCollapsed.value = remote.navCollapsed ?? null
    if (remote.density) {
      density.value = remote.density
      applyDensity(remote.density)
    }
    writeLocal(current())
  }

  function setSidebar(next: SidebarState) {
    sidebar.value = next
    persist()
  }
  /** 恢复「按屏幕自动」:清掉用户的侧栏选择(电脑展开,平板图标栏)。 */
  function resetSidebar() {
    sidebar.value = null
    persist()
  }
  function setSidebarWidth(value: number) {
    sidebarWidth.value = clampSidebarWidth(value)
    persist()
  }
  function setDensity(next: UiDensity) {
    density.value = next
    applyDensity(next)
    persist()
  }
  /** 记下用户对导航分组的显式选择(空数组 = 全部展开,以后不再自动收起)。 */
  function setNavCollapsed(ids: string[]) {
    navCollapsed.value = [...new Set(ids)].sort()
    persist()
  }

  return { sidebar, sidebarWidth, density, navCollapsed, setSidebar, resetSidebar, setSidebarWidth, setDensity, setNavCollapsed, syncFromServer, flush }
})
