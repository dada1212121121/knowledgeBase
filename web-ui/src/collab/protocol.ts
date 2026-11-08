// 多人在线编辑的线上协议(后端 crates/kb-collab 的 y-sync 变体,不是标准 y-websocket)。
//
// 帧里的消息和 y-protocols 一致:0 = 同步、1 = 在线状态、2 = 鉴权、3 = 查询在线状态;
// 额外两种自定义消息(消息类型 100 / 101),后面跟一段 JSON:
//   100 服务端 → 客户端:hello / role / lander / ready / land_now / saved / rejected / closing
//   101 客户端 → 服务端:init_done / land / save_point
// 这个文件只做编码解码,不碰网络和时钟,方便单测。
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_AUTH = 2
export const MSG_QUERY_AWARENESS = 3
/** 服务端 → 客户端的控制消息 */
export const MSG_CTRL_SERVER = 100
/** 客户端 → 服务端的控制消息 */
export const MSG_CTRL_CLIENT = 101

/** 笔记(所见即所得)在 Yjs 里的根节点名,Milkdown 默认值 */
export const RICH_ROOT = 'prosemirror'
/** 文本文件在 Yjs 里的根节点名 */
export const TEXT_ROOT = 'text'

/** 文档结构:笔记是节点树(`rich`),文件是纯文本(`text`) */
export type DocKind = 'text' | 'rich'

/** 服务端认定的身份。光标和头像条上显示的一律是它,客户端自称的名字和颜色不采信。 */
export interface Identity {
  id: string
  name: string
  color: string
}

export interface HelloCtrl {
  type: 'hello'
  you: Identity
  writable: boolean
  kind: string
  /** 内容就绪了吗。false = 先别输入,等 ready */
  ready: boolean
  /** 只发给被指定的初始化者:用这段 Markdown 初始化文档 */
  init: string | null
  lander: boolean
  /** 房间被锁成只读的原因(比如文档太大) */
  readonly_reason: string | null
}

export type ServerCtrl =
  | HelloCtrl
  | { type: 'role'; writable: boolean }
  | { type: 'lander'; you: boolean }
  | { type: 'ready' }
  | { type: 'land_now' }
  | { type: 'saved'; savepoint: boolean }
  | { type: 'rejected'; reason: string }
  | { type: 'closing'; reason: string }

export type ClientCtrl =
  | { type: 'init_done' }
  | { type: 'land'; markdown: string; sv: string }
  | { type: 'save_point' }

/** 帧里的一条消息 */
export type Incoming =
  | { kind: 'sync'; decoder: decoding.Decoder }
  | { kind: 'awareness'; update: Uint8Array }
  | { kind: 'query-awareness' }
  | { kind: 'auth' }
  | { kind: 'ctrl'; ctrl: ServerCtrl }

const CTRL_TYPES = new Set(['hello', 'role', 'lander', 'ready', 'land_now', 'saved', 'rejected', 'closing'])
const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

/** 解析服务端控制消息的 JSON;格式不对(或不认识的种类)返回 null,由调用方忽略 */
export function parseServerCtrl(bytes: Uint8Array): ServerCtrl | null {
  try {
    const value = JSON.parse(textDecoder.decode(bytes)) as unknown
    if (!value || typeof value !== 'object') return null
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string' || !CTRL_TYPES.has(type)) return null
    return value as ServerCtrl
  } catch {
    return null
  }
}

/**
 * 把一帧拆成消息。同步消息要交给 y-protocols 读,所以把解码器原样带出去(读完这一条再继续)。
 * `onMessage` 返回 false 表示这帧到此为止(比如连接已经被关掉)。
 */
export function readFrame(data: Uint8Array, onMessage: (message: Incoming) => boolean | void): void {
  const decoder = decoding.createDecoder(data)
  while (decoding.hasContent(decoder)) {
    const type = decoding.readVarUint(decoder)
    let message: Incoming
    switch (type) {
      case MSG_SYNC:
        message = { kind: 'sync', decoder }
        break
      case MSG_AWARENESS:
        message = { kind: 'awareness', update: decoding.readVarUint8Array(decoder) }
        break
      case MSG_QUERY_AWARENESS:
        message = { kind: 'query-awareness' }
        break
      case MSG_AUTH:
        // 权限被拒的原因(服务端目前不发):读掉,别让后面的消息错位
        if (decoding.readVarUint(decoder) === 0) decoding.readVarString(decoder)
        message = { kind: 'auth' }
        break
      case MSG_CTRL_SERVER: {
        const ctrl = parseServerCtrl(decoding.readVarUint8Array(decoder))
        if (!ctrl) continue
        message = { kind: 'ctrl', ctrl }
        break
      }
      default:
        // 不认识的消息种类无法知道长度,放弃这一帧剩下的部分
        return
    }
    // 同步消息的长度要等调用方用 y-protocols 读完才知道:回调是同步的,返回时解码器正好停在下一条的开头
    if (onMessage(message) === false) return
  }
}

/** 客户端控制消息 → 帧 */
export function encodeClientCtrl(ctrl: ClientCtrl): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_CTRL_CLIENT)
  encoding.writeVarUint8Array(encoder, textEncoder.encode(JSON.stringify(ctrl)))
  return encoding.toUint8Array(encoder)
}

/** 服务端控制消息 → 帧(假服务端和测试用) */
export function encodeServerCtrl(ctrl: ServerCtrl): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_CTRL_SERVER)
  encoding.writeVarUint8Array(encoder, textEncoder.encode(JSON.stringify(ctrl)))
  return encoding.toUint8Array(encoder)
}

/** 标准 base64(带填充)。落地提交里的状态向量用它传,和后端 `base64_decode` 对应。 */
export function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** 后端把 `kind` 序列化成 `rich` / `text`;后端内部存的名字是 `prosemirror`,两种写法都认 */
export function parseKind(kind: string): DocKind | null {
  if (kind === 'text') return 'text'
  if (kind === 'rich' || kind === 'prosemirror') return 'rich'
  return null
}
