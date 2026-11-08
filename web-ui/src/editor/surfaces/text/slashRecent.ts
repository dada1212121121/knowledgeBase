/**
 * 斜杠菜单「最近使用」：记在本机（localStorage），最多 3 项，最新的在前。
 * 只是排序上的便利，不是用户数据：读写失败（隐私模式、存满）就当没有，不报错、不影响插入本身。
 */
const KEY = 'kb.slash.recent'
const MAX = 3

export function recentSlashIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(0, MAX) : []
  } catch {
    return []
  }
}

export function recordSlashUse(id: string): void {
  try {
    const next = [id, ...recentSlashIds().filter((item) => item !== id)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式 / 存满：只是少了排序便利 */
  }
}
