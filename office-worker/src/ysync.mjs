// y-sync 帧的最小编解码(与 y-protocols、betteroffice 的 CollaborationProvider 一致):
// 一帧可以连着放多条消息;消息 = varUint 类型 + 内容。
// 类型 0 sync(子类型 0 step1 = 状态向量 / 1 step2 = 更新 / 2 update = 更新),1 awareness,2 auth,3 queryAwareness。
// betteroffice 会在 sync 载荷末尾附「文档指纹」(标签 + 32 字节),解码时剥掉;编码时不加(对方允许没有)。
export const SYNC = 0
export const AWARENESS = 1
export const AUTH = 2
export const QUERY_AWARENESS = 3
export const STEP1 = 0
export const STEP2 = 1
export const UPDATE = 2
const TAG = new TextEncoder().encode('\0betteroffice-document-fingerprint-v1\0')

function readVarUint(bytes, state) {
  let value = 0
  let mult = 1
  for (let i = 0; ; i++) {
    if (state.offset >= bytes.length) throw new Error('varUint 被截断')
    if (i > 7) throw new Error('varUint 太长')
    const byte = bytes[state.offset++]
    value += (byte & 127) * mult
    if ((byte & 128) === 0) return value
    mult *= 128
  }
}

function readBytes(bytes, state) {
  const length = readVarUint(bytes, state)
  if (state.offset + length > bytes.length) throw new Error('字节串被截断')
  const out = bytes.subarray(state.offset, state.offset + length)
  state.offset += length
  return out
}

function writeVarUint(out, value) {
  while (value > 127) {
    out.push((value & 127) | 128)
    value = Math.floor(value / 128)
  }
  out.push(value)
}

/** 去掉 betteroffice 附在 sync 载荷末尾的文档指纹。 */
export function stripFingerprint(payload) {
  const suffix = TAG.length + 32
  if (payload.length < suffix) return payload
  const start = payload.length - suffix
  for (let i = 0; i < TAG.length; i++) if (payload[start + i] !== TAG[i]) return payload
  return payload.subarray(0, start)
}

/** 拆一帧:[{ type, sub?, payload? }]。认不出的类型抛错(调用方丢掉这一帧)。 */
export function decode(frame) {
  const state = { offset: 0 }
  const out = []
  while (state.offset < frame.length) {
    const type = readVarUint(frame, state)
    if (type === SYNC) {
      const sub = readVarUint(frame, state)
      if (sub > UPDATE) throw new Error(`未知的 sync 子类型 ${sub}`)
      out.push({ type, sub, payload: readBytes(frame, state) })
    } else if (type === AWARENESS) {
      out.push({ type, payload: readBytes(frame, state) })
    } else if (type === QUERY_AWARENESS) {
      out.push({ type })
    } else if (type === AUTH) {
      const sub = readVarUint(frame, state)
      out.push({ type, sub, payload: sub === 0 ? readBytes(frame, state) : new Uint8Array(0) })
    } else {
      throw new Error(`未知的消息类型 ${type}`)
    }
  }
  return out
}

/** 编一条 sync 消息。 */
export function encodeSync(sub, payload) {
  const head = []
  writeVarUint(head, SYNC)
  writeVarUint(head, sub)
  writeVarUint(head, payload.length)
  const out = new Uint8Array(head.length + payload.length)
  out.set(head)
  out.set(payload, head.length)
  return out
}

/** 一帧里有没有会改文档的消息(只读连接的这类消息要丢掉)。 */
export function carriesEdits(messages) {
  return messages.some((message) => message.type === SYNC && (message.sub === STEP2 || message.sub === UPDATE))
}
