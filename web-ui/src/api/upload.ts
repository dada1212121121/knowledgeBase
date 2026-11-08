// 分片上传客户端:预检去重 → 建上传 → 逐片上传(失败重试 3 次)→ 完成。
//
// 断点续传靠两处:
// 1. 服务端返回“已收分片”,客户端只补缺的;
// 2. 本机 localStorage 记住 upload_id(按 文件指纹 = 名字+大小+修改时间+相对路径),
//    刷新页面后先 `GET /uploads/{id}` 拿回已收分片,拿不到(404 / 已完成)再重新建。
//
// 单片重试策略与 `kb-service` 的 `RetryPolicy` 一致:3 次、指数退避(200 ms 起)。

/** 分片重试次数(与服务端 `RetryPolicy::attempts` 一致)。 */
/** 页面内「选择文件 / 选择文件夹」选好之后,交给全局上传流程(预览 / 预检 / 重复处理)的事件名。 */
export const UPLOAD_REQUEST_EVENT = 'kb:upload-request'
export interface UploadRequestDetail {
  files: File[]
  /** 目标集合;不传则用全局拖放当前选的集合 */
  collection?: string
  tags?: string[]
  /** 已经在对话框里逐个确认过的文件:不再弹目录预览,直接预检上传 */
  skipPreview?: boolean
}
export function requestUpload(
  files: File[],
  options: { collection?: string; tags?: string[]; skipPreview?: boolean } = {},
): void {
  if (files.length) {
    window.dispatchEvent(new CustomEvent<UploadRequestDetail>(UPLOAD_REQUEST_EVENT, { detail: { files, ...options } }))
  }
}

export const PART_ATTEMPTS = 3
/** 第一次重试前的等待(毫秒),之后每次翻倍。 */
export const RETRY_BASE_MS = 200

export interface PrecheckItem {
  rel_path: string
  size: number
  sha256: string
}

export interface PrecheckResult {
  rel_path: string
  size: number
  sha256: string
  /** same_content(秒传)/ same_name_diff_content / new */
  status: 'same_content' | 'same_name_diff_content' | 'new'
  existing: { id: string; rel_path: string; size: number; state: string } | null
}

export type DedupStrategy = 'skip' | 'overwrite' | 'keep_both'

export interface UploadSession {
  upload_id: string
  batch_id: string
  name: string
  rel_path: string
  chunk_size: number
  parts_total: number
  received: number[]
  received_bytes: number
  dedup: 'same_content' | 'same_name_diff_content' | 'new'
  existing: PrecheckResult['existing']
}

export interface CompletedUpload {
  upload_id: string
  batch_id: string
  collection: string
  files: { id: string; rel_path: string; state: string }[]
  skipped: { rel_path: string; reason: string; existing: PrecheckResult['existing'] }[]
  job_id: string | null
}

export interface UploadRequest {
  name: string
  rel_path?: string
  size: number
  sha256?: string
  collection: string
  tags?: string[]
  batch?: string
  strategy?: DedupStrategy
}

/** 一个文件上传经过的阶段:算指纹 → 问服务端要不要传(预检 / 建上传)→ 传分片 → 服务端合并校验。 */
export type UploadPhase = 'hashing' | 'checking' | 'sending' | 'merging'

export interface UploadOptions {
  collection: string
  tags?: string[]
  /** 同名不同内容的策略(不传 = 服务端默认 skip)。 */
  strategy?: DedupStrategy
  /** 同一个文件夹的多个文件共用一个批次。 */
  batch?: string
  /** 进度回调(0–99:传完、服务端合并校验通过后才会收到 100)。 */
  onProgress?: (percent: number) => void
  /**
   * 字节级进度:已送出的字节 / 总字节。给了它,分片就改用 XMLHttpRequest 发送,
   * 一个分片传到一半也会不断回调(fetch 拿不到上传进度);不给就保持 fetch,行为和以前一样。
   */
  onBytes?: (sent: number, total: number) => void
  /** 阶段变化回调,界面上用来说清「现在在干什么」,而不是停在 0% 不动。 */
  onPhase?: (phase: UploadPhase) => void
  /** 服务端提示需要人工选择策略时回调(重复文件处理的提示)。 */
  onDuplicate?: (result: PrecheckResult) => void
  /** 指定集合内的存放路径(笔记附件用);不给就用文件名 / 文件夹相对路径。 */
  relPath?: string
}

interface UploadErrorBody {
  ok?: boolean
  error?: { code?: string; message?: string }
}

class UploadHttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UploadHttpError'
    this.status = status
  }
}

const CSRF_HEADERS = { 'x-kb-csrf': '1' }

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  const body = text ? (JSON.parse(text) as { ok?: boolean; data?: T; error?: UploadErrorBody['error'] }) : {}
  if (!response.ok || body.ok === false) {
    const message = body.error?.message ?? `HTTP ${response.status}`
    throw new UploadHttpError(message, response.status)
  }
  return body.data as T
}

/** 去重预检:一次问一批文件。 */
export async function precheck(collection: string, files: PrecheckItem[]): Promise<PrecheckResult[]> {
  const response = await fetch('/api/v1/uploads/precheck', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify({ collection, files }),
  })
  const data = await readJson<{ results: PrecheckResult[] }>(response)
  return data.results
}

/** 新建(或续传)一次上传。 */
export async function createUpload(request: UploadRequest): Promise<UploadSession> {
  const response = await fetch('/api/v1/uploads', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify(request),
  })
  return readJson<UploadSession>(response)
}

/** 续传信息。 */
export async function uploadStatus(uploadId: string): Promise<UploadSession> {
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
    credentials: 'same-origin',
  })
  return readJson<UploadSession>(response)
}

/** 取消上传。 */
export async function abortUpload(uploadId: string): Promise<void> {
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: CSRF_HEADERS,
  })
  await readJson<unknown>(response)
}

/**
 * 用 XMLHttpRequest 发一个分片并汇报已送出的字节。fetch 没有上传进度事件,
 * 一个分片(几 MB)要等整片发完才有动静,大文件在慢网络上看起来就是卡住了。
 * 返回值是 Response,这样后面的错误处理、重试和 readJson 与 fetch 路径完全共用。
 */
function putWithProgress(url: string, bytes: Blob, onSent: (sent: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    request.withCredentials = true
    for (const [name, value] of Object.entries({ ...CSRF_HEADERS, 'content-type': 'application/octet-stream' })) {
      request.setRequestHeader(name, value)
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onSent(Math.min(bytes.size, event.loaded))
    }
    request.onload = () => {
      // 101 / 204 / 205 / 304 按规范不能带响应体,给 Response 一个空串会直接抛错
      const bodiless = [101, 204, 205, 304].includes(request.status)
      resolve(
        new Response(bodiless ? null : request.responseText, {
          status: request.status,
          headers: { 'content-type': request.getResponseHeader('content-type') ?? 'application/json' },
        }),
      )
    }
    request.onerror = () => reject(new Error('网络中断,分片没有传完'))
    request.ontimeout = () => reject(new Error('分片传输超时'))
    request.onabort = () => reject(new Error('分片传输被中止'))
    request.send(bytes)
  })
}

/**
 * 写一个分片(带 3 次重试)。
 * 给了 `onSent` 就按字节汇报这一片已送出多少(每次重试从 0 重新算);不给就用 fetch。
 */
export async function putPart(
  uploadId: string,
  partNo: number,
  bytes: Blob,
  onSent?: (sent: number) => void,
): Promise<{ part_no: number; parts_received: number; parts_total: number }> {
  let delay = RETRY_BASE_MS
  let lastError: unknown
  const url = `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}`
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt += 1) {
    try {
      onSent?.(0)
      const response = onSent
        ? await putWithProgress(url, bytes, onSent)
        : await fetch(url, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { ...CSRF_HEADERS, 'content-type': 'application/octet-stream' },
            body: bytes,
          })
      return await readJson(response)
    } catch (error) {
      lastError = error
      // 4xx(参数 / 分片越界)重试也没用,直接抛
      if (error instanceof UploadHttpError && error.status >= 400 && error.status < 500) {
        throw error
      }
      if (attempt < PART_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay *= 2
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('分片上传失败')
}

/** 完成上传(合并 + 校验 + 入解析队列)。 */
export async function completeUpload(uploadId: string): Promise<CompletedUpload> {
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: CSRF_HEADERS,
  })
  return readJson<CompletedUpload>(response)
}

// 同一个文件对象只算一次指纹:加入队列前的重复预检会算一遍,真正上传时又会算一遍,
// 大文件要把整个文件读进内存算 SHA-256(WebCrypto 不支持边读边算),重复算一遍等于白等一次。
// 键是 File / Blob 对象本身,文件对象被回收时缓存跟着没;内容变了就是新的 File 对象,不会读到旧值。
const shaCache = new WeakMap<Blob, Promise<string>>()

/** 文件内容的 sha256(十六进制)。 */
export function sha256Hex(blob: Blob): Promise<string> {
  const cached = shaCache.get(blob)
  if (cached) return cached
  const pending = (async () => {
    const buffer = await blob.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  })()
  shaCache.set(blob, pending)
  // 失败的不缓存:读文件出错(权限、文件被移走)后重试要能重新来过
  pending.catch(() => shaCache.delete(blob))
  return pending
}

/** 本机记住的“未完成上传”(刷新后续传用)。 */
interface StoredUpload {
  uploadId: string
  collection: string
  sha256: string
  size: number
  updatedAt: number
}

const STORE_PREFIX = 'kb-upload:'

function fileKey(file: File, relPath: string): string {
  return `${relPath}|${file.size}|${file.lastModified}`
}

function loadStored(key: string): StoredUpload | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key)
    return raw ? (JSON.parse(raw) as StoredUpload) : null
  } catch {
    return null
  }
}

function saveStored(key: string, value: StoredUpload) {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value))
  } catch {
    // 隐私模式 / 配额满:续传退化成“本次会话内有效”,不影响上传
  }
}

function dropStored(key: string) {
  try {
    localStorage.removeItem(STORE_PREFIX + key)
  } catch {
    // 同上
  }
}

/** 文件夹上传时保留目录结构(`webkitRelativePath`)。 */
export function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  if (relative && relative.length > 0) {
    // 去掉最外层目录名?保留:用户选的是整个文件夹,根目录名本身也是信息
    return relative.replace(/\\/g, '/')
  }
  return file.name
}

/**
 * 上传一个文件:预检 → (续传或新建) → 补传缺失分片 → 完成。
 *
 * 返回服务端的结果;`onProgress` 会按“已收分片 / 总片数”报进度。
 */
export async function uploadFile(file: File, options: UploadOptions): Promise<CompletedUpload> {
  const relPath = options.relPath ?? relativePathOf(file)
  // 已送出的字节同时汇报成字节数和百分比;百分比最高 99,服务端合并校验通过后才给 100,
  // 免得「传完了但还没入库」就被界面当成已完成
  const report = (sent: number) => {
    const clamped = Math.max(0, Math.min(file.size, sent))
    options.onBytes?.(clamped, file.size)
    options.onProgress?.(file.size > 0 ? Math.min(99, Math.floor((clamped / file.size) * 100)) : 0)
  }

  options.onPhase?.('hashing')
  const sha256 = await sha256Hex(file)

  // 1. 预检:同内容直接秒传(不传字节)
  options.onPhase?.('checking')
  const [checked] = await precheck(options.collection, [
    { rel_path: relPath, size: file.size, sha256 },
  ])
  if (checked?.status === 'same_content') {
    report(file.size)
  } else if (checked?.status === 'same_name_diff_content') {
    options.onDuplicate?.(checked)
  }

  // 2. 续传:本机记得的 upload_id 还活着就接着传
  const key = fileKey(file, relPath)
  let session: UploadSession | null = null
  const stored = loadStored(key)
  if (stored && stored.sha256 === sha256 && stored.collection === options.collection) {
    try {
      const resumed = await uploadStatus(stored.uploadId)
      session = { ...resumed, dedup: checked?.status ?? 'new', existing: checked?.existing ?? null }
    } catch {
      dropStored(key)
    }
  }

  // 3. 新建
  if (!session) {
    session = await createUpload({
      name: file.name,
      rel_path: relPath,
      size: file.size,
      sha256,
      collection: options.collection,
      tags: options.tags,
      batch: options.batch,
      strategy: options.strategy,
    })
  }
  saveStored(key, {
    uploadId: session.upload_id,
    collection: options.collection,
    sha256,
    size: file.size,
    updatedAt: Date.now(),
  })

  // 4. 补传缺失分片。秒传(同内容)一片都不用传:服务端直接复用已有字节
  const received = new Set(session.received)
  if (checked?.status !== 'same_content') {
    options.onPhase?.('sending')
    const partSize = (part: number) => Math.min(file.size, (part + 1) * session.chunk_size) - part * session.chunk_size
    // 续传时前面已经收到的分片先算进去,进度从断点开始而不是从 0
    let done = 0
    for (const part of received) done += partSize(part)
    report(done)
    const missing: number[] = []
    for (let part = 0; part < session.parts_total; part += 1) {
      if (!received.has(part)) missing.push(part)
    }
    for (const part of missing) {
      const start = part * session.chunk_size
      const end = Math.min(file.size, start + session.chunk_size)
      // 只有要字节级进度的调用方才走 XHR;其余(附件上传等)保持 fetch
      const onSent = options.onBytes ? (sent: number) => report(done + sent) : undefined
      await putPart(session.upload_id, part, file.slice(start, end), onSent)
      done += end - start
      received.add(part)
      report(done)
    }
  }

  // 5. 完成:服务端合并分片、核对指纹、入解析队列
  options.onPhase?.('merging')
  const completed = await completeUpload(session.upload_id)
  dropStored(key)
  options.onBytes?.(file.size, file.size)
  options.onProgress?.(100)
  return completed
}

/** 一组文件的整体进度(状态栏 / 上传浮层用)。 */
export interface UploadSummary {
  total: number
  done: number
  failed: number
  percent: number
}

export function summarize(percentages: number[], failed: number): UploadSummary {
  const done = percentages.filter((value) => value >= 100).length
  const percent = percentages.length
    ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)
    : 0
  return { total: percentages.length, done, failed, percent }
}
