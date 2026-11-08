/**
 * 引擎崩溃后的恢复副本
 *
 * 编辑会话崩溃（Worker 异常、WASM 内存不足）时，`PptxEditBackend.recover` 能从主线程里的 peer 抢救出一份当前内容。
 * 抢救出来的字节有两条出路，缺一不可：
 * 1. 页面上给一个下载链接（用户马上能拿走，不依赖任何浏览器存储）；
 * 2. 尽力写进 IndexedDB（用户关掉页面后下次回来还能找到）。第二条失败（隐私模式、配额）不报错，第一条才是兜底。
 */

const DB = 'kb-editor-recovery'
const STORE = 'copies'
/** 每份文件只留最新一份；总共最多留这么多份，免得把用户的磁盘配额吃光 */
const MAX_COPIES = 5

export interface RecoveryCopy {
  key: string
  bytes: Uint8Array
  savedAt: number
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function done<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

/** 记下一份恢复副本；任何失败都吞掉并返回 false */
export async function rememberRecovery(key: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const db = await open()
    if (!db) return false
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    const all = ((await done(store.getAll())) ?? []) as RecoveryCopy[]
    // 超出份数就丢最旧的（同一个 key 会被覆盖，不占额外份数）
    const others = all.filter((copy) => copy.key !== key).sort((a, b) => a.savedAt - b.savedAt)
    for (const stale of others.slice(0, Math.max(0, others.length - (MAX_COPIES - 1)))) store.delete(stale.key)
    await done(store.put({ key, bytes, savedAt: Date.now() } satisfies RecoveryCopy))
    db.close()
    return true
  } catch {
    return false
  }
}

/** 取回某份文件的恢复副本；没有或读不出来返回 null */
export async function recoveryFor(key: string): Promise<RecoveryCopy | null> {
  try {
    const db = await open()
    if (!db) return null
    const copy = (await done(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as RecoveryCopy | null | undefined
    db.close()
    return copy ?? null
  } catch {
    return null
  }
}
