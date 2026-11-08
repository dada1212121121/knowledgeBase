// 办公文档在线编辑的接口:无损检查 + 替换原件。请求体是整份文件的字节(上限 64 MB),不走分片。

const CSRF_HEADERS = { 'x-kb-csrf': '1' }

/** 编辑器没改内容就保存出来的字节和原件比的结果(服务端 `RoundtripReport`)。 */
export interface RoundtripReport {
  valid: boolean
  reason: string | null
  lossless: boolean
  changed_parts: string[]
  removed_parts: string[]
  added_parts: string[]
  text_equal: boolean
}

export interface ReplaceResult {
  version: number
  sha256: string
  size: number
  embedded: number
  chunks: number
  unchanged: boolean
  /** 原件里有、新文件里没有的部件(编辑器清理了没人引用的图片之类,也可能是丢了东西) */
  parts_removed: string[]
}

/** 服务端回的错误:带上 HTTP 状态和错误码,界面据此区分「冲突」和「别的错」。 */
export class OfficeEditError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'OfficeEditError'
    this.status = status
    this.code = code
  }
}

async function readData<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // 不是 JSON(网关错误页之类):按状态码报
  }
  if (!response.ok || body.ok === false) {
    throw new OfficeEditError(body.error?.message ?? `HTTP ${response.status}`, response.status, body.error?.code ?? '')
  }
  return body.data as T
}

/** 把编辑器「不改直接保存」出来的字节交给服务端,和原件比。 */
export async function roundtripCheck(collection: string, path: string, bytes: Uint8Array): Promise<RoundtripReport> {
  const query = new URLSearchParams({ collection, path })
  const response = await fetch(`/api/v1/files/roundtrip-check?${query.toString()}`, {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: bytes as BodyInit,
  })
  return readData<RoundtripReport>(response)
}

/** 编辑权的持有者(服务端 `LockHolder`)。 */
export interface LockHolder {
  actor: string
  session: string
  since_ms: number
  /** 最近一次心跳距今多少秒 */
  idle_secs: number
}

/** 申请 / 续上编辑权的结果。 */
export interface LockResult {
  /** 这个窗口现在持有编辑权 */
  held: boolean
  /** 多久没有心跳编辑权就自动失效(秒);界面据此定心跳间隔 */
  ttl_secs: number
  /** 没拿到时:持有者是不是同一个账号(在另一个窗口 / 设备上) */
  same_user?: boolean
  /** 没拿到时:现在持有的人 */
  holder?: LockHolder
  /** 接手成功时:被接手的原持有者 */
  took_over_from?: LockHolder | null
}

/** 每个编辑器窗口一个随机编号(同一个编号再次申请 = 心跳)。 */
export function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 申请编辑权;同一个 `session` 再次调用就是心跳。`takeOver` 为真时别人持有着也强行接手。 */
export async function acquireLock(collection: string, path: string, session: string, takeOver = false): Promise<LockResult> {
  const response = await fetch('/api/v1/files/lock', {
    method: 'POST',
    headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ collection, path, session, take_over: takeOver }),
  })
  return readData<LockResult>(response)
}

/** 交还编辑权。关页面时也要能发出去(`keepalive`),失败不打扰用户——没交还的最多 45 秒后自己失效。 */
export async function releaseLock(collection: string, path: string, session: string): Promise<void> {
  const query = new URLSearchParams({ collection, path, session })
  try {
    await fetch(`/api/v1/files/lock?${query.toString()}`, { method: 'DELETE', headers: CSRF_HEADERS, keepalive: true })
  } catch {
    // 忽略:编辑权会因为没有心跳而自己失效
  }
}

/** 用新字节替换原件。`expectedSha256` 是打开时原件的哈希:之后被别人改过就会被拒绝;
 * `session` 是这个编辑器窗口的编号:文件的编辑权在别的窗口手里时会被拒绝(409)。 */
export async function replaceFile(collection: string, path: string, bytes: Uint8Array, expectedSha256: string, session?: string): Promise<ReplaceResult> {
  const query = new URLSearchParams({ collection, path, expected_sha256: expectedSha256 })
  if (session) query.set('session', session)
  const response = await fetch(`/api/v1/files/replace?${query.toString()}`, {
    method: 'PUT',
    headers: CSRF_HEADERS,
    body: bytes as BodyInit,
  })
  return readData<ReplaceResult>(response)
}

/** 多人协同的准备结果(服务端 `OfficeCollab::prepare`)。 */
export interface OfficeSession {
  /** collab = 多人实时协同;single = 退回单人编辑(原因在 reason) */
  mode: 'collab' | 'single'
  reason?: string
  format?: 'xlsx' | 'pptx' | 'docx'
  /** 房间底稿的内容哈希:所有人都从这份字节打开 */
  base_sha?: string
  size?: number
  /** 这个人现在能不能改 */
  writable?: boolean
  /** 房间是否已经放开编辑(无损,或有人确认了「仍然编辑」) */
  room_writable?: boolean
  lossless?: boolean
  /** 不无损但文字没少:可以确认后编辑 */
  forceable?: boolean
  report?: { valid: boolean; reason: string | null; changed_parts: string[]; removed_parts: string[]; added_parts: string[] } | null
  participants?: number
}

/** 打开前问服务端:能不能多人协同、房间底稿是哪一份。`force`:不无损但文字没少时确认继续编辑。 */
export async function prepareOfficeSession(doc: string, force = false): Promise<OfficeSession> {
  const response = await fetch('/api/v1/office/session', {
    method: 'POST',
    headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ doc, force }),
  })
  return readData<OfficeSession>(response)
}

/** 房间底稿的原字节。按内容寻址:浏览器缓存里有就不再下载(服务端给的是 immutable)。 */
export async function fetchOfficeBase(doc: string, sha: string): Promise<Uint8Array> {
  const query = new URLSearchParams({ doc, sha })
  const response = await fetch(`/api/v1/office/base?${query.toString()}`, { credentials: 'same-origin', cache: 'force-cache' })
  if (!response.ok) throw new OfficeEditError(`读取底稿失败(HTTP ${response.status})`, response.status, '')
  return new Uint8Array(await response.arrayBuffer())
}

/** docx 的初始状态(xlsx / pptx 不需要)。 */
export async function fetchOfficeSeed(doc: string): Promise<Uint8Array> {
  const response = await fetch(`/api/v1/office/seed?${new URLSearchParams({ doc }).toString()}`, { credentials: 'same-origin' })
  if (!response.ok) throw new OfficeEditError(`读取初始状态失败(HTTP ${response.status})`, response.status, '')
  return new Uint8Array(await response.arrayBuffer())
}

/** 协同的 WebSocket 地址。 */
export function officeCollabUrl(doc: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/api/v1/office/collab?${new URLSearchParams({ doc }).toString()}`
}
