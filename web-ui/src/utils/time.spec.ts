import { beforeEach, describe, expect, it } from 'vitest'
import {
  clockText,
  dateParts,
  dateTimeText,
  dayKey,
  dayStart,
  daysAgo,
  DEFAULT_TIMEZONE,
  isValidTimezone,
  monthDayText,
  offsetMinutes,
  recentDayKeys,
  setSiteTimezone,
  shiftDay,
  stampText,
  timezoneLabel,
  timezoneOffsetText,
  weekday,
} from './time'

// 2026-10-28 23:59:59 UTC = 2026-10-29 07:59:59 上海
const BEFORE = Date.UTC(2026, 9, 28, 23, 59, 59)
const AFTER = Date.UTC(2026, 9, 29, 0, 0, 0)

beforeEach(() => setSiteTimezone(DEFAULT_TIMEZONE))

describe('站点时区:默认北京时间', () => {
  it('UTC 晚上 8 点前已经算上海的第二天', () => {
    expect(dayKey(BEFORE)).toBe('2026-10-29')
    expect(dayKey(AFTER)).toBe('2026-10-29')
    expect(dayKey(Date.UTC(2026, 9, 28, 15, 59, 59))).toBe('2026-10-28')
  })

  it('时分秒按站点时区显示', () => {
    const parts = dateParts(BEFORE)
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second]).toEqual([2026, 10, 29, 7, 59, 59])
    expect(clockText(BEFORE)).toBe('07:59')
    expect(clockText(BEFORE, true)).toBe('07:59:59')
    expect(dateTimeText(BEFORE, true)).toBe('2026-10-29 07:59:59')
    expect(stampText(BEFORE)).toBe('10-29 07:59')
    expect(monthDayText(BEFORE, BEFORE)).toBe('10-29')
    expect(monthDayText(BEFORE, Date.UTC(2027, 0, 1))).toBe('2026-10-29')
    expect(weekday(BEFORE)).toBe(4) // 2026-10-29 是周四
  })

  it('当天零点与偏移', () => {
    expect(offsetMinutes(BEFORE)).toBe(480)
    expect(timezoneOffsetText(BEFORE)).toBe('UTC+8')
    expect(dayStart(BEFORE)).toBe(Date.UTC(2026, 9, 28, 16, 0, 0))
    expect(daysAgo(Date.UTC(2026, 9, 28, 15, 0, 0), BEFORE)).toBe(1)
    expect(timezoneLabel()).toBe('北京时间')
  })

  it('日期前后挪与最近 N 天', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDay('不是日期', 1)).toBe('不是日期')
    expect(recentDayKeys(3, BEFORE)).toEqual(['2026-10-27', '2026-10-28', '2026-10-29'])
  })

  it('换成别的时区后所有显示一起变;非法名称退回默认', () => {
    setSiteTimezone('America/New_York')
    expect(dayKey(BEFORE)).toBe('2026-10-28')
    expect(clockText(BEFORE)).toBe('19:59')
    expect(timezoneLabel()).toBe('America/New_York')
    expect(timezoneOffsetText(BEFORE)).toBe('UTC-4')
    setSiteTimezone('Mars/Olympus')
    expect(dayKey(BEFORE)).toBe('2026-10-29')
    // 浏览器能认固定偏移,但后端只存 IANA 名称(固定偏移表达不了夏令时),这里必须一起拒
    expect(isValidTimezone('Asia/Shanghai')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('+08:00')).toBe(false)
    expect(isValidTimezone('-0500')).toBe(false)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })
})
