import { clockText, timezoneOffsetText } from '@/utils/time'
// 应用外壳的数据层(侧栏计数 / 项目树 / 底栏遥测)。
// 每个页面都自己包一层 <AppShell>,切页就会卸载再挂载外壳;如果外壳自己取数,
// 每次导航都会重发 3 个请求并闪一下占位值。放进 store:第一次取数后常驻,
// 重新挂载时同步拿到缓存,过期才在后台静默刷新(不清空旧值 → 导航不闪、不卡)。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { callCapability, health } from '@/api/client'

export interface ShellProject {
  name: string
  slug: string
  /** 可浏览的条目数(文件 + 笔记),不是向量库的块数 */
  items: number
  /** 最近一次索引的时间戳(没有索引过为 0),用来决定侧栏默认展开哪个项目 */
  lastIndexedAt: number
}

interface Telemetry {
  uptime?: string
  socket?: string
  listen?: string
  disk?: string
  /** 后端暂未提供时为 undefined,界面不显示这一项 */
  mcpSessions?: number
  host?: string
  syncTime?: string
}

const STALE_MS = 10_000

/** 14:05 (UTC+8);没有索引记录返回空串(底栏就不显示这一项) */
function formatSync(at: number): string {
  if (!at) return ''
  return `${clockText(at)} (${timezoneOffsetText(at)})`
}

export const useShellStore = defineStore('shell', () => {
  const version = ref('')
  const jobs = ref({ queued: 0, running: 0 })
  const drafts = ref(0)
  const items = ref(0)
  /** 我的笔记(insight)条数,首页的统计卡用;老后端没有这个字段就是 0 */
  const insights = ref(0)
  const sources = ref<number | null>(null)
  /** 近 7 天每个集合每天新增的 insight(stats_overview.activity_7d),右栏热力格用 */
  const activity = ref<{ day: string; collection: string; insights: number }[]>([])
  const projects = ref<ShellProject[]>([])
  const collectionNames = ref<string[]>([])
  const telemetry = ref<Telemetry>({})
  const online = ref(true)
  /** 磁盘已用比例(0–1);拿不到(没有 sys.ops 功能)为 null。管理员头像上的告警据此判断。 */
  const diskUsedRatio = ref<number | null>(null)
  /** 所有集合里最近一次索引完成的时间(底栏“同步于”) */
  const lastIndexedAt = ref(0)
  const loaded = ref(false)
  let fetchedAt = 0
  let inflight: Promise<void> | null = null

  const activeJobs = computed(() => jobs.value.queued + jobs.value.running)
  /**
   * 项目 → 图表色:最近索引过的项目拿第一个色,其余顺延;侧栏圆点与仪表盘图例 / 柱图 / 环形图共用。
   * 用固定色板 --viz-1…3 而不是原来的 --chart-1…3:后者的第一个跟着强调色走,第三个是写死的橙色,
   * 浅色 / 纸张主题下对表面的对比度只有 2.5–2.7(强调色换成黄、绿、橙时更低,低到 1.8),图上的色块看不清;
   * --viz-* 在五个主题的所有表面上都 ≥ 3:1(见 src/styles/charts.spec.ts)。
   */
  const projectColors = computed(() => {
    const ranked = [...projects.value].sort((left, right) => right.lastIndexedAt - left.lastIndexedAt)
    const map: Record<string, string> = {}
    ranked.forEach((project, index) => {
      map[project.name] = `var(--viz-${(index % 3) + 1})`
    })
    return map
  })

  async function load() {
    let names = collectionNames.value
    try {
      const stats = await callCapability<{
        totals: { rows: number; items: number; insights?: number }
        jobs: { queued: number; running: number }
        drafts_pending: number
        collections: { name: string; last_indexed_at: number | null }[]
        activity_7d?: { day: string; collection: string; insights: number }[]
      }>('stats_overview')
      jobs.value = { queued: stats.jobs.queued, running: stats.jobs.running }
      drafts.value = stats.drafts_pending
      items.value = stats.totals.items
      insights.value = stats.totals.insights ?? 0
      activity.value = stats.activity_7d ?? []
      names = (stats.collections ?? []).map((collection) => collection.name)
      collectionNames.value = names
      lastIndexedAt.value = Math.max(0, ...(stats.collections ?? []).map((collection) => collection.last_indexed_at ?? 0))
      online.value = true
    } catch {
      online.value = false
    }

    const [info, listed, listedSources, sys] = await Promise.all([
      health().catch(() => null),
      callCapability<{ projects: { project: { name: string; slug: string; last_indexed_at: number | null }; items: number }[] }>(
        'list_projects',
      ).catch(
        () => null,
      ),
      callCapability<{ sources: unknown[] }>('list_sources').catch(() => null),
      callCapability<{
        overview?: { service?: { version?: string; uptime_seconds?: number | null; listen?: string; host?: string } }
        network?: { socket?: string; listen?: string; mcp_sessions?: number }
        resources?: { disk?: { mount?: string; free_gb?: number; used_ratio?: number } }
      }>('system_status').catch(() => null),
    ])

    if (info?.version) version.value = info.version
    if (listed) {
      // 侧栏按名称排序(稳定、好找);配色另按最近索引排序,见 projectColors
      projects.value = [...listed.projects]
        .sort((left, right) => left.project.name.localeCompare(right.project.name, undefined, { sensitivity: 'base' }))
        .map((item) => ({
        name: item.project.name,
        slug: item.project.slug,
        items: item.items,
        lastIndexedAt: item.project.last_indexed_at ?? 0,
      }))
    }
    if (listedSources) sources.value = listedSources.sources.length

    if (sys) {
      const seconds = sys.overview?.service?.uptime_seconds
      let uptime = ''
      if (typeof seconds === 'number') {
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h`
      }
      const disk = sys.resources?.disk
      diskUsedRatio.value = typeof disk?.used_ratio === 'number' ? disk.used_ratio : null
      const diskText =
        disk?.used_ratio != null && disk.free_gb != null
          ? `${disk.mount || '/'} ${(disk.used_ratio * 100).toFixed(0)}% · ${disk.free_gb.toFixed(0)} GB 可用`
          : ''
      telemetry.value = {
        uptime,
        socket: sys.network?.socket,
        listen: sys.network?.listen || sys.overview?.service?.listen,
        disk: diskText,
        mcpSessions: sys.network?.mcp_sessions,
        host: sys.overview?.service?.host,
        syncTime: formatSync(lastIndexedAt.value),
      }
      if (sys.overview?.service?.version) version.value = sys.overview.service.version
    }
    loaded.value = true
    fetchedAt = Date.now()
  }

  /** 取数;并发合并成一次。`force` 忽略缓存(收到服务端推送时用)。 */
  function refresh(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && loaded.value && Date.now() - fetchedAt < STALE_MS) return Promise.resolve()
    inflight = load().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    version,
    jobs,
    drafts,
    items,
    insights,
    sources,
    activity,
    projects,
    collectionNames,
    telemetry,
    online,
    diskUsedRatio,
    loaded,
    activeJobs,
    projectColors,
    refresh,
  }
})
