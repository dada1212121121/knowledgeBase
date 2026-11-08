<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 应用外壳:侧栏 + 顶栏 + 内容区 + 页脚 + 手机底部标签栏。
// 结构与 class 取自 设计稿(视觉基线 79e5405),数据来自能力层。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  KbButton,
  KbCommandPalette,
  KbConfirmHost,
  KbDialog,
  KbDropOverlay,
  KbIcon,
  KbToastStack,
  useAppearance,
  useToast,
  type IconName,
} from '@kb-ui/index'

import DuplicatesDialog from '@/components/DuplicatesDialog.vue'
import FolderPreview from '@/components/FolderPreview.vue'
import UploadIndicator from '@/components/UploadIndicator.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import ShellSidebar from '@/layouts/shell/ShellSidebar.vue'
import ShellTabbar, { type TabEntry } from '@/layouts/shell/ShellTabbar.vue'
import { buildNavGroups, compact, isActivePath } from '@/layouts/shell/navModel'
import { PATHS } from '@/router/paths'
import type { NavGroup, SystemAlert } from '@/layouts/shell/types'
import AssistantDrawer from '@/components/AssistantDrawer.vue'
import ShellTopbar from '@/layouts/shell/ShellTopbar.vue'
import ShellAccountMenu from '@/layouts/shell/ShellAccountMenu.vue'
import NotificationDrawer from '@/layouts/shell/NotificationDrawer.vue'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { callCapability, logout } from '@/api/client'
import { useShellStore } from '@/stores/shell'
import { useUploadStore } from '@/stores/upload'
import { useSessionStore } from '@/stores/session'
import { useNavStore } from '@/stores/nav'
import { useUiStore } from '@/stores/ui'
import { usePanelsStore } from '@/stores/panels'
import { useNotificationsStore } from '@/stores/notifications'
import { useActiveDocStore } from '@/stores/activeDoc'
import { useFeature } from '@/composables/useFeature'
import { useViewport } from '@/composables/useViewport'
import { useVisualViewport } from '@/composables/useVisualViewport'
import { interceptExternalLinks, useStandalone } from '@/composables/useStandalone'
import { canCancelDeletion, deletionCountdown } from '@/utils/accountForms'
import { UPLOAD_REQUEST_EVENT, type DedupStrategy, type UploadRequestDetail } from '@/api/upload'
import { isConfigEvent, migrationCommands, readConfigEvent, type MigrationPlan } from '@/utils/configEvents'
import { BACKUP_SETTLED_EVENT, failureText, type BackupFailure } from '@/utils/backup'
import { visibleInterval } from '@/utils/visibleInterval'
import { buildSystemAlerts } from '@/utils/systemAlerts'
import { gotoTargets, isHelpKey, shortcutRows } from '@/utils/guide'
import { normalizeFolder, withFolderPrefix } from '@/utils/uploadFolder'

// 常驻外壳:整个应用只挂载一次(侧栏 / 顶栏 / 页脚 / 全局浮层),页面通过 <router-view> 换内容。
// 页面里的 <AppShell>(见 PageFrame 的说明)把面包屑和操作区「传送」到这里的 #kb-slot-* 插槽。
const route = useRoute()
const router = useRouter()
// 侧栏计数 / 项目树 / 底栏遥测都在 shell store 里(切页不重取、不闪占位值)
const shell = useShellStore()

/** 退出登录:清掉会话后整页回到登录页(顺带清空内存里的页面状态)。 */
async function signOut() {
  try {
    await logout()
  } catch {
    // 会话已经失效时也照样回登录页
  }
  window.location.href = '/login'
}
const { version, drafts, items, sources, projects, telemetry, online, activeJobs, collectionNames, projectColors, diskUsedRatio } = storeToRefs(shell)


// --- 全局拖放、文件夹预览、重复处理、批次完成 ---
const uploads = useUploadStore()
const dropTarget = ref('')

function resolveActiveCollection(): string {
  if (dropTarget.value && collectionNames.value.includes(dropTarget.value)) {
    return dropTarget.value
  }
  const queryCol = typeof route.query.collection === 'string' ? route.query.collection : ''
  if (queryCol && collectionNames.value.includes(queryCol)) {
    return queryCol
  }
  try {
    const saved = localStorage.getItem('kb.import.targetCollection')
    if (saved && collectionNames.value.includes(saved)) {
      return saved
    }
  } catch {}
  return collectionNames.value[0] || '_global'
}

watch(
  () => route.query.collection,
  (queryCol) => {
    if (typeof queryCol === 'string' && queryCol && collectionNames.value.includes(queryCol)) {
      dropTarget.value = queryCol
    }
  },
  { immediate: true },
)
/** 「添加数据」对话框里填的标签(全局拖放没有标签) */
const dropTags = ref<string[]>([])
const dropFiles = ref<File[]>([])
const showPreview = ref(false)
const showDuplicates = ref(false)
const pendingFiles = ref<File[]>([])
const duplicates = ref<{ relPath: string; result: import('@/api/upload').PrecheckResult }[]>([])
// 一个批次传完:弹一条 toast 说明(解析结果在「数据源 › 队列」里看,批次完成后有总结页)
watch(
  () => uploads.completed.length,
  () => {
    for (const entry of [...uploads.completed]) {
      const problems = entry.failed
      useToast().push(
        problems ? `上传完成:${entry.files} 个文件,${problems} 个失败` : `上传完成:${entry.files} 个文件,正在解析`,
        problems ? 'warning' : 'success',
      )
      uploads.dismissBatch(entry.batch)
    }
  },
)

/** 全局拖放:没有标签,沿用当前选的集合,并考虑导入页指定子目录 */
function onOverlayDrop(files: File[]) {
  dropTags.value = []
  let effectiveFiles = files
  if (route.path === PATHS.import || route.path.startsWith('/import')) {
    try {
      const folder = localStorage.getItem('kb.import.targetFolder') || ''
      const norm = normalizeFolder(folder)
      if (norm.ok && norm.folder) {
        effectiveFiles = withFolderPrefix(files, norm.folder)
      }
    } catch {}
  }
  void onDrop(effectiveFiles)
}

/** 拖进来的文件:多个 / 文件夹 → 先预览;单个 → 直接预检上传。 */
async function onDrop(files: File[]) {
  const target = dropTarget.value || resolveActiveCollection()
  if (!target) {
    useToast().push('还没有可用的集合,先添加一个项目', 'danger')
    return
  }
  dropTarget.value = target
  if (files.length > 1 || files.some((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath)) {
    dropFiles.value = files
    showPreview.value = true
    return
  }
  await uploadAfterPrecheck(files)
}

/** 预检:有同名不同内容就先问策略(重复文件),否则直接入队。 */
async function uploadAfterPrecheck(files: File[]) {
  try {
    const { results, conflicts } = await uploads.inspect(files, dropTarget.value)
    if (conflicts.length) {
      pendingFiles.value = files
      // 弹窗里同时列出「内容完全相同」(会被秒传跳过)和「同名内容不同」(需要选策略)
      duplicates.value = results.filter((result) => result.status !== 'new').map((result) => ({ relPath: result.rel_path, result }))
      showDuplicates.value = true
      return
    }
  } catch {
    // 预检失败(例如没有登录)时按默认策略直接上传,服务端会再校验一次
  }
  uploads.enqueue(files, { collection: dropTarget.value, tags: dropTags.value })
}

function onPreviewConfirm(files: File[], options: { collection: string; tags: string[] }) {
  showPreview.value = false
  dropTarget.value = options.collection
  dropTags.value = options.tags
  void uploadAfterPrecheck(files)
}

function onDuplicateApply(strategies: Record<string, DedupStrategy>) {
  showDuplicates.value = false
  uploads.enqueue(pendingFiles.value, { collection: dropTarget.value, tags: dropTags.value, strategies })
  pendingFiles.value = []
}

// 主侧栏严格对齐 仪表盘设计稿 等设计稿的 9 个标准导航项;计数全部来自真实数据,没有数据就不显示
const session = useSessionStore()
// 账号正在注销时的横幅:剩余时间每分钟刷新一次
const deletionDeadline = computed(() => session.user?.delete_after ?? null)
const deletionTick = ref(Date.now())
const deletionTimer = setInterval(() => (deletionTick.value = Date.now()), 60_000)
onUnmounted(() => clearInterval(deletionTimer))
session.start()

// 导航清单(侧栏、「我的」页共用一份):按功能表过滤,没有权限的入口不出现
const navGroups = computed<NavGroup[]>(() =>
  buildNavGroups({
    has: (feature) => session.has(feature),
    route,
    counts: { items: items.value, sources: sources.value, drafts: drafts.value, jobs: activeJobs.value },
  }),
)
/** 旧版顶部导航条(外观里的 topnav 布局)只要一排扁平的主入口 */
const navFlat = computed(() => navGroups.value.flatMap((group) => group.items).slice(0, 8))

// ---- 统一外壳的侧栏状态(三态 / ⌘B / 拖动边缘 / 按用户记住)----
const navState = useNavStore()
const ui = useUiStore()
// 文档工作台(浏览器页)自带顶栏;侧栏状态和其它页面一样,不会因为进了这个页面自己收起
watch(
  () => route.meta.chrome === 'workbench',
  (value) => (navState.workbench = value),
  { immediate: true },
)
// 外观里的「导航布局」:rail 只改默认状态,topnav 用顶部导航条(不要侧栏)
const appearance = useAppearance()
watch(() => appearance.layout, (value) => (navState.layout = value), { immediate: true })
const viewport = useViewport()
// 软键盘:写 --kbd-inset / data-kbd,键盘打开时标签栏让位、输入框滚到可见
useVisualViewport()
// 独立窗口(装成 PWA)里没有地址栏:外部链接改成新开,并告诉用户去了哪
const { standalone } = useStandalone()
let stopExternalLinks: (() => void) | null = null
watch(
  standalone,
  (value) => {
    stopExternalLinks?.()
    stopExternalLinks = value ? interceptExternalLinks(() => useToast().push('外部链接已在浏览器中打开,这个窗口留在知识库')) : null
  },
  { immediate: true },
)
onUnmounted(() => stopExternalLinks?.())
const isPhone = computed(() => viewport.tier.value === 'phone')

// 右侧抽屉:AI 助手(顶栏按钮 / ⌘J)与通知(顶栏铃铛)。AI 总开关关掉或账号没有 ai.assistant 时,按钮和抽屉都不渲染
const panels = usePanelsStore()
const notifications = useNotificationsStore()
const hasAssistant = useFeature('ai.assistant')
const showShortcuts = ref(false)
// 快捷键表的内容和「G 然后 X」跳转表都在 utils/guide.ts(按键处理与表里的说明用同一份,不会漏写);
// 两者都按这个账号的功能点过滤(AI 关闭后没有「呼出 AI 助手」,也不会 G R 跳进一个没开通的审核页)
const shortcutList = computed(() => shortcutRows((feature) => session.has(feature)))

const sidebarGroups = navGroups

// 手机底部标签栏:首页、知识库、搜索、通知、我的。通知是抽屉(按钮),其余是页面;没有权限的入口不出现。
// 「我的」是兜底:当前页不属于前三个标签时(例如从「我的」页进入的任务、设置),高亮「我的」。
const tabEntries = computed<TabEntry[]>(() => {
  const onHome = route.path === PATHS.home
  const onKb = route.path === PATHS.kb || route.path.startsWith(`${PATHS.kb}/`)
  const onSearch = route.path === PATHS.search
  const list: TabEntry[] = [
    { id: 'home', label: '首页', icon: 'home', to: PATHS.home, active: onHome },
    { id: 'kb', label: '知识库', icon: 'book', to: PATHS.kb, active: onKb },
  ]
  if (session.has('search.basic')) list.push({ id: 'search', label: '搜索', icon: 'search', to: PATHS.search, active: onSearch })
  list.push({ id: 'notify', label: '通知', icon: 'bell', active: panels.notificationsOpen, count: notifications.unread || undefined })
  list.push({ id: 'mine', label: '我的', icon: 'user', to: PATHS.mine, active: !onHome && !onKb && !onSearch && !panels.notificationsOpen })
  return list
})
function onTabAction(id: string) {
  if (id === 'notify') panels.toggleNotifications()
}
// 登录后用服务端保存的偏好覆盖本地的(侧栏状态、宽度、密度换设备也一样)
watch(
  () => session.user?.id,
  (id) => {
    if (id) void ui.syncFromServer()
  },
  { immediate: true },
)
// 页面切到后台 / 关闭时把还没发出的偏好写出去
function flushPrefs() {
  if (document.visibilityState === 'hidden') void ui.flush({ keepalive: true })
}
onMounted(() => document.addEventListener('visibilitychange', flushPrefs))
onUnmounted(() => document.removeEventListener('visibilitychange', flushPrefs))

const isActive = (to: string) => isActivePath(route, to)

/**
 * 「跳到主要内容」:键盘用户一进页面 Tab,第一站是它(侧栏有近 20 个入口,不跳过的话每次要按 20 多下才到页面内容)。
 * 不用 href="#kb-main" 的默认锚点跳转:路由是 history 模式,改地址栏的 hash 会触发路由,所以手动把焦点放到内容区。
 */
function focusMain() {
  document.getElementById('kb-main')?.focus()
}

/** 展开哪个项目:当前浏览的集合所属项目;没有就取最近索引过的那个 */
const openProject = computed(() => {
  const current = typeof route.query.collection === 'string' ? route.query.collection : ''
  const hit = projects.value.find((project) => current === `proj_${project.slug}` || current.startsWith(`${project.name}/`))
  if (hit) return hit.slug
  const latest = [...projects.value].sort((left, right) => right.lastIndexedAt - left.lastIndexedAt)[0]
  return latest?.slug ?? ''
})

// ===== 备份失败的全局告警(定时 / 手动都算):任意页面都要看得见,不只靠设置页的徽标 =====
// 数据源两条:WS 的 `backup.failed` / `backup.done`(实时),以及打开页面时问一次
// `backup_state`(失败发生在没有页面打开的时候)。它很轻:不统计磁盘占用,只读两个小文件加一次目录列表。
const backupAlert = ref<BackupFailure | null>(null)
/** 用户点了「忽略」就先不弹;下一次失败会重新出现 */
const backupAlertMuted = ref(false)

/**
 * 系统告警 = 管理员头像上小圆点的原因。以前这些信息写在人人可见的底部状态栏里
 * (套接字路径、监听地址……),多用户后不该暴露给普通用户,所以只给有系统功能的账号看:
 * 后台连不上、备份失败、磁盘快满了。
 */
const systemAlerts = computed<SystemAlert[]>(() =>
  buildSystemAlerts({
    privileged: session.has('sys.ops') && session.isAdmin,
    online: online.value,
    backup: backupAlert.value,
    diskUsedRatio: diskUsedRatio.value,
  }),
)

async function loadBackupAlert() {
  try {
    const state = await callCapability<{ alert: BackupFailure | null }>('backup_state')
    backupAlert.value = state.alert ?? null
  } catch {
    // 未登录 / 旧后端没有这个能力:横幅只是锦上添花,不该挡住页面
  }
}

const stopTimers: Array<() => void> = []
onMounted(() => window.addEventListener(BACKUP_SETTLED_EVENT, loadBackupAlert))
onUnmounted(() => window.removeEventListener(BACKUP_SETTLED_EVENT, loadBackupAlert))

/**
 * 外壳的计数(侧栏、状态栏):页面可见时每 15 秒一次,切到后台就停,回到前台立刻刷新一次(useLiveRefresh)。
 * 常规刷新顺带重读一次备份告警:WS 断开、或备份是在别的标签页 / 定时任务里做完的,横幅也能自己消失
 * (有 WS 时由 `backup.done` 立即撤掉,不用等这一拍)。
 * 任务结束、条目变化的推送合并后强制刷新一次计数;进度推送不改计数,不再触发刷新
 * (以前每个进度事件都在 800ms 后整套重读 5 个接口,索引高峰时几乎不停)。
 */
useLiveRefresh({
  load: (reason) => (reason === 'event' ? shell.refresh(true) : Promise.all([shell.refresh(reason === 'visible' || reason === 'manual'), loadBackupAlert()])),
  interval: 15_000,
  events: ['job.done', 'item.changed'],
})
onMounted(() => {
  void notifications.refreshUnread()
  // 通知靠 WebSocket 推送;推送丢了(断线重连)时每分钟对一次未读数。标签页在后台时跳过,回到前台立刻补一次
  stopTimers.push(visibleInterval(() => void notifications.refreshUnread(), 60_000))
})
onUnmounted(() => {
  stopTimers.splice(0).forEach((stop) => stop())
})

// 通知、配置热重载、备份结果走 WS 推送（设计规范）;任务与条目变更由上面的 useLiveRefresh 合并处理
useLiveEvents((event) => {
  // 新通知:角标立刻变(数字以服务端给的为准)
  if (event.type === 'notify') {
    notifications.onLive(event)
    return
  }
  // 配置热重载的结果:热更新 / 要重启 / 要迁移 / 配置写坏,四种都要让用户看见
  if (isConfigEvent(event.type)) {
    onConfigEvent(event)
    return
  }
  // 备份失败:立刻弹提示并挂出横幅;成功一次就把横幅撤掉
  if (event.type === 'backup.failed') {
    const failure = event.data as unknown as BackupFailure
    backupAlert.value = failure
    backupAlertMuted.value = false
    useToast().push(failureText(failure), 'danger')
    return
  }
  if (event.type === 'backup.done') {
    backupAlert.value = null
    backupAlertMuted.value = false
    return
  }
})

// ===== 配置热重载的提示(Web 侧):事件由守护进程在重载后推过来 =====
// 载荷解析在 utils/configEvents.ts(纯函数,可单测),这里只负责弹提示 / 弹窗。
/** 需要先迁移的 embed 改动(整份配置未生效,弹窗说明怎么处理) */
const configMigration = ref<MigrationPlan | null>(null)
const configMigrationKeys = ref<string[]>([])
const configMigrationCommands = computed(() =>
  configMigration.value ? migrationCommands(configMigration.value) : '',
)

function onConfigEvent(event: { type: string; data: Record<string, unknown> }) {
  const notice = readConfigEvent(event.type, event.data)
  if (!notice) return
  const toast = useToast()
  if (notice.kind === 'error') {
    toast.push(`配置没生效,继续用当前配置:${notice.message}`, 'danger')
    return
  }
  if (notice.kind === 'migration') {
    configMigration.value = notice.plan
    configMigrationKeys.value = notice.keys
    return
  }
  if (notice.kind === 'migration-unknown') {
    toast.push('嵌入配置有改动:要先停服、迁移各 collection,再启动守护进程', 'warning')
    return
  }
  if (notice.restart.length) {
    toast.push(`配置已更新;${notice.restart.length} 项要重启守护进程才生效:${notice.restart.join(' / ')}`, 'warning')
  } else if (notice.hot.length) {
    const suffix = notice.notes.length ? `(${notice.notes.join(';')})` : ''
    toast.push(`配置已热更新:${notice.hot.length} 项立即生效${suffix}`, 'success')
  }
}

const paletteOpen = computed(() => route.query.palette === '1')
/** 命令面板里「重建索引 / 运行进化」作用的项目:正在看的项目,没有就取最近索引过的(与侧栏展开的项目一致) */
const paletteProject = computed(() => projects.value.find((project) => project.slug === openProject.value)?.name ?? '')
/** 命令面板里「浏览器」项显示的上下文:当前正在看的集合(没有就不显示) */
const paletteCollection = computed(() => (typeof route.query.collection === 'string' ? route.query.collection : ''))

const openPalette = () => {
  if (!paletteOpen.value) void router.replace({ query: { ...route.query, palette: '1' } })
}
const closePalette = () => {
  const next = { ...route.query }
  delete next.palette
  // 返回 Promise:编辑器命令要等面板真正收起、焦点回到正文后再执行(否则查找框刚聚焦又被抢走)
  return router.replace({ query: next })
}

/** ⌘K 里的编辑器命令(UI-5):文档页正在编辑时登记的桥;不编辑时为空,面板恢复成纯导航 */
const activeDoc = useActiveDocStore()
const editorCommands = computed(() => {
  const bridge = activeDoc.editor
  if (!bridge) return []
  return bridge.commands().map((command) => {
    const icon: IconName = command.id === 'save' ? 'check' : command.id === 'undo' ? 'back' : command.id === 'redo' ? 'forward' : command.id === 'find' ? 'search' : command.id.startsWith('ai.') ? 'sparkles' : 'edit'
    return {
      id: `editor:${command.id}`,
      label: command.label,
      icon,
      hint: command.hint,
      keywords: command.keywords,
      section: '编辑器',
      run: async () => {
        // 先收起面板(等路由替换完成、焦点还给正文),再执行;插入 / 加粗才不会作用在面板输入框上
        await closePalette()
        await nextTick()
        await bridge.run(command.id)
      },
    }
  })
})

// 「G 然后 S」式的跳转快捷键(在输入框里不触发),跳转表见 utils/guide.ts 的 GOTO_TARGETS
let gPressedAt = 0
const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
}
const shortcut = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteOpen.value ? closePalette() : openPalette()
    return
  }
  // ⌘B / Ctrl+B:收起 / 展开侧栏。只有富文本 / 代码编辑区里 Ctrl+B 是「加粗」,让给编辑器;
  // 普通输入框(例如搜索页自动聚焦的那个)里没有别的含义,照常响应
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
    const target = event.target as HTMLElement | null
    if (target?.isContentEditable || target?.closest?.('.cm-editor, .ProseMirror')) return
    event.preventDefault()
    navState.cycle()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
  // ? 打开快捷键表(手机没有键盘,不响应)
  if (isHelpKey(event) && !isPhone.value) {
    event.preventDefault()
    showShortcuts.value = true
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'g') {
    gPressedAt = Date.now()
  } else if (gPressedAt && Date.now() - gPressedAt < 1200) {
    const target = gotoTargets((feature) => session.has(feature)).find((entry) => entry.key === key)
    if (target) {
      gPressedAt = 0
      event.preventDefault()
      void router.push(target.to)
    }
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))
onUnmounted(() => window.removeEventListener('keydown', shortcut))

// 页面里的「选择文件 / 选择文件夹」与拖放走同一条流程(文件夹预览 → 预检 → 重复处理 → 入队)
function onUploadRequest(event: Event) {
  const detail = (event as CustomEvent<UploadRequestDetail>).detail
  if (!detail) return
  if (detail.collection) dropTarget.value = detail.collection
  else if (!dropTarget.value) dropTarget.value = resolveActiveCollection()
  dropTags.value = detail.tags ?? []
  if (detail.skipPreview && dropTarget.value) void uploadAfterPrecheck(detail.files)
  else void onDrop(detail.files)
}
onMounted(() => window.addEventListener(UPLOAD_REQUEST_EVENT, onUploadRequest))
onUnmounted(() => window.removeEventListener(UPLOAD_REQUEST_EVENT, onUploadRequest))
</script>

<template>
  <div class="kb-app" :data-chrome="navState.workbench ? (navState.workbenchDetail ? 'workbench-detail' : 'workbench') : undefined"
    :data-tabbar="viewport.navKind.value === 'tabbar' ? '' : undefined"
    :style="{ '--shell-left': `${navState.slotWidth}px` }"
    style-allow="侧栏当前宽度(可拖动),页面里的固定定位元素据此对齐">
    <a class="kb-skip-link" href="#kb-main" data-testid="skip-link" @click.prevent="focusMain">跳到主要内容</a>
    <ShellSidebar :groups="sidebarGroups" @search="openPalette" />

    <div class="main">
      <div class="tnav">
        <div class="ws row">
          <div class="logo">kb</div>
          knowledgeBase
        </div>
        <RouterLink
          v-for="item in navFlat"
          :key="item.id"
          class="ni"
          :class="{ on: item.active }"
          :to="item.to"
        >
          <KbIcon :name="item.icon" /><span class="lbl2">{{ item.label }}</span>
        </RouterLink>
        <RouterLink class="ni" :class="{ on: isActive(PATHS.settings) }" :to="PATHS.settings">
          <KbIcon name="settings" /><span class="lbl2">系统设置</span>
        </RouterLink>
        <div class="srch" @click="openPalette">
          <span>搜索或跳转…</span><span class="kbd">⌘K</span>
        </div>
      </div>

      <ShellTopbar
        :alerts="systemAlerts"
        :show-shortcuts="!isPhone"
        @search="openPalette"
        @signout="signOut"
        @shortcuts="showShortcuts = true"
      />

      <!-- 与后台断开:对所有人可见(底部状态栏没有了,断线不能没人知道)-->
      <div v-if="!online" class="kb-backup-alert" role="alert" data-testid="offline-banner">
        <KbIcon name="failed" />
        <span class="kb-backup-alert-text">与服务器的连接中断,正在重试…</span>
      </div>

      <!-- 备份失败横幅:只在有未解决的失败时出现(正常状态下不占位,不影响任何页面的版式) -->
      <div v-if="backupAlert && !backupAlertMuted" class="kb-backup-alert" role="alert">
        <KbIcon name="failed" />
        <span class="kb-backup-alert-text">{{ failureText(backupAlert) }}</span>
        <RouterLink class="btn sm" :to="`${PATHS.settings}?tab=backup`">去备份设置</RouterLink>
        <button type="button" class="btn sm" @click="backupAlertMuted = true">忽略</button>
      </div>

      <!-- 账号正在注销:在任何页面都提醒,免得忘了、到期被删才发现。/me 页自己有更详细的卡片,不重复 -->
      <div v-if="deletionDeadline !== null && route.path !== PATHS.me" class="kb-backup-alert kb-deletion-alert" role="alert">
        <KbIcon name="failed" />
        <span class="kb-backup-alert-text">
          账号将于 {{ localeDateTime(deletionDeadline, { hour12: false, dateStyle: 'long' }) }} 被永久删除({{ deletionCountdown(deletionDeadline, deletionTick) }})
        </span>
        <RouterLink class="btn sm" :to="PATHS.me">{{ canCancelDeletion(deletionDeadline, deletionTick) ? '去撤销' : '查看' }}</RouterLink>
      </div>

      <!-- tabindex=-1:只让「跳到主要内容」能把焦点放进来,不进 Tab 顺序 -->
      <div id="kb-main" class="body-row" tabindex="-1">
        <slot />
      </div>

      <ShellTabbar v-if="viewport.navKind.value === 'tabbar'" :tabs="tabEntries" @action="onTabAction" />
    </div>

    <Transition name="kb-pal">
      <KbCommandPalette
        v-if="paletteOpen"
        :call="callCapability"
        :paths="PATHS"
        :drafts="drafts"
        :collection="paletteCollection"
        :project="paletteProject"
        :has="(feature) => session.has(feature)"
        :extra-commands="editorCommands"
        :admin="session.isAdmin"
        @close="closePalette"
      />
    </Transition>
    <!-- 全局:Toast 容器与确认弹窗(useToast / useConfirm 驱动) -->
    <!-- 后台上传:页脚中间的胶囊 + 浮层(后台上传) -->
    <UploadIndicator />
    <AssistantDrawer v-if="hasAssistant" />
    <NotificationDrawer v-if="panels.notificationsOpen" @close="panels.toggleNotifications(false)" />
    <KbToastStack />
    <KbConfirmHost />

    <!-- 全局拖放遮罩:任意页面拖入文件 / 文件夹,松开即上传 -->
    <KbDropOverlay
      :disabled="uploads.captureDrops"
      :collection="dropTarget || resolveActiveCollection()"
      :collections="collectionNames"
      @update:collection="(value: string) => (dropTarget = value)"
      @drop="onOverlayDrop"
    />

    <!-- 文件夹上传预览 -->
    <FolderPreview
      v-if="showPreview"
      :files="dropFiles"
      :collection="dropTarget"
      :collections="collectionNames"
      @confirm="onPreviewConfirm"
      @close="showPreview = false"
    />

    <!-- 重复文件处理 -->
    <DuplicatesDialog
      v-if="showDuplicates"
      :duplicates="duplicates"
      :total="pendingFiles.length"
      :collection="dropTarget"
      @apply="onDuplicateApply"
      @close="showDuplicates = false"
    />


    <KbDialog v-if="showShortcuts" title="快捷键" width="480px" @close="showShortcuts = false">
      <div class="kb-stack kb-shortcuts" data-testid="shortcuts">
        <div v-for="row in shortcutList" :key="row.label" class="kb-row-between">
          <span>{{ row.label }}</span>
          <span class="kb-row"><span v-for="key in row.keys" :key="key" class="kbd">{{ key }}</span></span>
        </div>
      </div>
      <template #footer><KbButton size="sm" @click="showShortcuts = false">知道了</KbButton></template>
    </KbDialog>

    <!-- :embed 改动需要先迁移 —— 说明清楚,不在页面上假装能一键迁移 -->
    <KbDialog
      v-if="configMigration"
      title="嵌入配置有改动,需要先迁移"
      width="620px"
      @close="configMigration = null"
    >
      <div v-if="configMigration" class="kb-stack">
        <div class="kb-row">
          <span class="kb-hint">嵌入器</span>
          <span class="kb-mono">{{ configMigration.from }}</span>
          <span class="kb-hint">→</span>
          <span class="kb-mono">{{ configMigration.to }}</span>
        </div>
        <div class="kb-row">
          <span class="kb-hint">受影响的 collection</span>
          <span class="kb-spacer"></span>
          <span class="kb-mono">{{ configMigration.collections.join('、') || '—' }}</span>
        </div>
        <div v-if="configMigrationKeys.length" class="kb-hint">
          未生效的键:{{ configMigrationKeys.join(' / ') }}
        </div>
        <div class="kb-hint">
          新配置整份没有生效(进程里还是旧嵌入器)。顺序是「停服 → 迁移 → 启动」:
          <span class="kb-mono">kb migrate</span> 要拿 <span class="kb-mono">run/daemon.lock</span>,
          守护进程在跑时会直接退出;迁移会同时搬 chunks 与 insight 行。
        </div>
        <div v-if="!configMigration.collections.length" class="kb-hint">
          还没有需要迁移的 collection(新库或还没建集合),启动守护进程即可。
        </div>
        <pre v-else class="kb-mono kb-migrate-cmds">{{ configMigrationCommands }}</pre>
      </div>
      <template #footer>
        <KbButton size="sm" @click="configMigration = null">知道了</KbButton>
      </template>
    </KbDialog>
  </div>
</template>

<style scoped>
/* 备份失败横幅:一行放不下时省略中间的文字,按钮始终可见 */
.kb-backup-alert {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-2) var(--sp-3) 0;
  padding: var(--sp-2) var(--sp-3);
  border: var(--hl) solid var(--r);
  border-radius: var(--r2);
  background: var(--panel2);
  color: var(--r);
  font-size: var(--text-12);
}

.kb-backup-alert-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--t2);
}

/* 迁移提示里的命令块:等宽、可选中复制、换行显示 */
.kb-migrate-cmds {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border-radius: var(--r2);
  font-size: var(--text-12);
  line-height: var(--lh-body);
  white-space: pre-wrap;
  user-select: text;
}
</style>
