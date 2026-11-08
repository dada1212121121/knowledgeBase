// 监控类图表共用的格式化:字节、速率、时长、百分比、横轴的时间刻度。
// 都是纯函数,和组件分开方便单测;数字的写法统一在这里,各页面不再各写一份。

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 字节 → 1.5 GB。小于 10 的保留一位小数,其余取整;负数和非数写 —。 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  let size = value
  let at = 0
  while (size >= 1024 && at < UNITS.length - 1) {
    size /= 1024
    at += 1
  }
  const text = at === 0 || size >= 10 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/, '')
  return `${text} ${UNITS[at]}`
}

/** 每秒字节数 → 3.2 MB/s。 */
export const formatRate = (value: number): string => (Number.isFinite(value) && value >= 0 ? `${formatBytes(value)}/s` : '—')

/** 0–1 的比例 → 63%。`digits` 默认 0 位;不在 0–1 之外截断,让异常值看得见。 */
export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 毫秒 → 850ms / 12s / 3m 20s / 2h 5m。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 横轴上的时间刻度粒度:跨度越大,标签越粗。 */
export type TimeGrain = 'minute' | 'hour' | 'day'

/** 按图覆盖的时间跨度选粒度:不到 3 小时写 时:分,不到 3 天写 日 时,更长写 月-日。 */
export function timeGrain(spanMs: number): TimeGrain {
  if (spanMs <= 3 * 3_600_000) return 'minute'
  if (spanMs <= 3 * 86_400_000) return 'hour'
  return 'day'
}

/**
 * 时间戳 → 横轴标签:minute → 14:05;hour → 14:00(跨天时前面带 日);day → 11-01。
 *
 * 传 `timeZone`(IANA 名称)时按这个时区取年月日时分;不传沿用浏览器本地时区,
 * 让这个包单独用在别处时也有确定行为。应用内一律传站点时区,和后端统计分桶对齐。
 */
export function timeLabel(at: number, grain: TimeGrain, timeZone?: string): string {
  const date = new Date(at)
  if (timeZone) {
    const values: Record<string, string> = {}
    for (const part of new Intl.DateTimeFormat('en-GB', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)) {
      if (part.type !== 'literal') values[part.type] = part.value
    }
    const month = values.month ?? '01'
    const day = values.day ?? '01'
    if (grain === 'minute') return `${values.hour ?? '00'}:${values.minute ?? '00'}`
    if (grain === 'hour') return `${month}-${day} ${values.hour ?? '00'}:00`
    return `${month}-${day}`
  }
  if (grain === 'minute') return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (grain === 'hour') return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一组时间戳 → 横轴标签,粒度按首尾跨度自动选;`timeZone` 同上。 */
export function timeLabels(times: number[], timeZone?: string): string[] {
  if (!times.length) return []
  const grain = timeGrain(times[times.length - 1]! - times[0]!)
  return times.map((at) => timeLabel(at, grain, timeZone))
}

/** 环比:本期相对上期的变化。上期为 0 或缺失时返回 null(不写「+∞%」这种没意义的数)。 */
export function deltaRatio(current: number, previous: number | null | undefined): number | null {
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous === 0 || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

/** 环比的文字:↑ 12% / ↓ 3% / 持平。变化不到 0.5% 算持平。 */
export function deltaText(ratio: number | null): string {
  if (ratio === null) return ''
  if (Math.abs(ratio) < 0.005) return '持平'
  return `${ratio > 0 ? '↑' : '↓'} ${Math.round(Math.abs(ratio) * 100)}%`
}

/** 阈值着色:超过 90% 危险,超过 80% 警告,其余正常(和系统状态页的磁盘 / 内存提示用同一套线)。 */
export type Level = 'ok' | 'warn' | 'danger'
export function levelOf(ratio: number, warn = 0.8, danger = 0.9): Level {
  if (!Number.isFinite(ratio)) return 'ok'
  return ratio >= danger ? 'danger' : ratio >= warn ? 'warn' : 'ok'
}
