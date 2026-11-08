// 全站时间显示与“按自然日”计算:统一按站点时区(`[site] timezone`,默认 Asia/Shanghai)。
//
// 后端所有时间戳都是 Unix 毫秒,本身不带时区;界面不再用浏览器本地时区,否则同一条记录
// 在不同电脑上会显示成不同日期,和每日额度 / 统计分桶(后端按站点时区)也对不上。
import { ref } from 'vue'

/** 后端默认值;拿不到站点配置时也用这个。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/** 当前站点时区。`authStatus` / 分享页信息拿到后由 `setSiteTimezone` 更新。 */
export const siteTimezone = ref(DEFAULT_TIMEZONE)

/**
 * IANA 名称是否被浏览器认识(不认识就退回默认值,不让页面因为一个配置项整片报错)。
 * 明确拒绝 `+08:00` / `-0500`:浏览器的新版 Intl 能认固定偏移,但后端只存 IANA 名称
 * (固定偏移表达不了夏令时,同一个地区一年里可能有两个偏移)。
 */
export function isValidTimezone(name: string): boolean {
  if (/^[+-]\d{2}(?::?\d{2})?$/.test(name)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(0)
    return true
  } catch {
    return false
  }
}

/** 设置站点时区;空值或非法名称退回上海。 */
export function setSiteTimezone(name?: string | null): void {
  const next = name?.trim()
  siteTimezone.value = next && isValidTimezone(next) ? next : DEFAULT_TIMEZONE
}

/** 给界面看的时区名:默认的上海写成「北京时间」,其它按 IANA 名称显示。 */
export function timezoneLabel(): string {
  return siteTimezone.value === DEFAULT_TIMEZONE ? '北京时间' : siteTimezone.value
}

/** 当前时区相对 UTC 的偏移文字(`UTC+8` / `UTC+5:30`)。 */
export function timezoneOffsetText(at: number = Date.now()): string {
  const minutes = offsetMinutes(at)
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hours = Math.floor(abs / 60)
  const rest = abs % 60
  return rest === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(rest).padStart(2, '0')}`
}

export interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const partCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(withSeconds: boolean): Intl.DateTimeFormat {
  // 缓存键必须带时区:设置页热更新 `site.timezone` 后要立刻换格式,不能继续用旧时区的 formatter
  const key = `${siteTimezone.value}:${withSeconds ? 'datetime' : 'minute'}`
  const cached = partCache.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: siteTimezone.value,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
  partCache.set(key, formatter)
  return formatter
}

/** 某个瞬间在站点时区里的年月日时分秒。 */
export function dateParts(at: number, withSeconds = true): DateParts {
  const values: Record<string, number> = {}
  for (const part of partsFormatter(withSeconds).formatToParts(new Date(at))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  }
}

/** 当前时区里某天相对 UTC 的偏移(分钟,东八区是 480)。 */
export function offsetMinutes(at: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: siteTimezone.value, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((part) => part.type === 'timeZoneName')?.value
  if (!name || name === 'GMT' || name === 'UTC') return 0
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name)
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '-' ? -minutes : minutes
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** `YYYY-MM-DD`(站点时区)。 */
export function dayKey(at: number = Date.now()): string {
  const p = dateParts(at)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** 今天(站点时区)`YYYY-MM-DD`。 */
export const todayKey = (): string => dayKey(Date.now())

/** 从 `YYYY-MM-DD` 前后挪几天;非法输入原样返回。 */
export function shiftDay(day: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return day
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta))
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 站点时区里某一天零点的毫秒值(用来算“今天 / 昨天”和日窗口)。 */
export function dayStart(at: number = Date.now()): number {
  const p = dateParts(at)
  const target = Date.UTC(p.year, p.month - 1, p.day)
  // 先按目标时刻的偏移猜一次,再用猜出的瞬间的偏移校正(夏令时切换那天会差一小时)
  const guess = target - offsetMinutes(target) * 60_000
  return target - offsetMinutes(guess) * 60_000
}

/** 两个瞬间在站点日历里差几天(今天 0,昨天 1)。 */
export function daysAgo(at: number, now: number = Date.now()): number {
  const a = dateParts(at)
  const b = dateParts(now)
  const dayA = Date.UTC(a.year, a.month - 1, a.day)
  const dayB = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((dayB - dayA) / 86_400_000)
}

/** `HH:mm`;`seconds` 为真时 `HH:mm:ss`。 */
export function clockText(at: number, seconds = false): string {
  const p = dateParts(at)
  return seconds ? `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` : `${pad2(p.hour)}:${pad2(p.minute)}`
}

/** `MM-DD`;跨年时带年份。 */
export function monthDayText(at: number, now: number = Date.now()): string {
  const p = dateParts(at, false)
  const n = dateParts(now, false)
  const md = `${pad2(p.month)}-${pad2(p.day)}`
  return p.year === n.year ? md : `${p.year}-${md}`
}

/** `MM-DD HH:mm`(日志 / 运行记录)。 */
export function stampText(at: number): string {
  const p = dateParts(at, false)
  return `${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** `YYYY-MM-DD HH:mm` 或 `YYYY-MM-DD HH:mm:ss`。 */
export function dateTimeText(at: number, seconds = false): string {
  const p = dateParts(at)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}${seconds ? `:${pad2(p.second)}` : ''}`
}

/**
 * `YYYY/MM/DD HH:mm:ss`,对齐原先 `toLocaleString('zh-CN')` 的写法。
 * 只传 `{ hour12: false }` 这类不带日期 / 时间字段的选项时,补成完整的日期 + 时间,
 * 避免 `Intl` 只输出日期、把时刻悄悄丢掉。
 */
export function localeDateTime(at: number, options?: Intl.DateTimeFormatOptions): string {
  const hasDate = !!options && ['year', 'month', 'day', 'dateStyle'].some((key) => key in options)
  const hasTime = !!options && ['hour', 'minute', 'second', 'timeStyle'].some((key) => key in options)
  const resolved: Intl.DateTimeFormatOptions =
    hasDate || hasTime
      ? { ...options }
      : { ...options, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
  return new Intl.DateTimeFormat('zh-CN', { ...resolved, timeZone: siteTimezone.value }).format(new Date(at))
}

/** 星期几(0 = 周日)。 */
export function weekday(at: number): number {
  const p = dateParts(at, false)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** 是不是站点时区里今天的那一天。 */
export const isToday = (at: number, now: number = Date.now()): boolean => dayKey(at) === dayKey(now)

/** 最近 `days` 天的日期标签,最后一个是今天(不依赖浏览器时区)。 */
export function recentDayKeys(days: number, now: number = Date.now()): string[] {
  const today = dayKey(now)
  return Array.from({ length: Math.max(0, days) }, (_, index) => shiftDay(today, index - days + 1))
}
