// 在线状态(awareness)更新的解析:varUint 条数,每条 varUint clientId、varUint clock、varString 状态 JSON。
// 房间据此记住每条连接对应的 clientId,连接断开时替它广播「离开」(clock + 1、状态 null),别人马上看到他走了,
// 而不是等 45 秒超时。

function readVarUint(bytes, state) {
  let value = 0
  let mult = 1
  for (let i = 0; ; i++) {
    if (state.offset >= bytes.length || i > 7) throw new Error('awareness 被截断')
    const byte = bytes[state.offset++]
    value += (byte & 127) * mult
    if ((byte & 128) === 0) return value
    mult *= 128
  }
}

function writeVarUint(out, value) {
  while (value > 127) {
    out.push((value & 127) | 128)
    value = Math.floor(value / 128)
  }
  out.push(value)
}

/** [{ clientId, clock, state }];`state` 是原始 JSON 字符串(`null` 表示离开)。 */
export function parseAwareness(update) {
  const state = { offset: 0 }
  const count = readVarUint(update, state)
  const out = []
  for (let i = 0; i < count; i++) {
    const clientId = readVarUint(update, state)
    const clock = readVarUint(update, state)
    const length = readVarUint(update, state)
    if (state.offset + length > update.length) throw new Error('awareness 被截断')
    const json = new TextDecoder().decode(update.subarray(state.offset, state.offset + length))
    state.offset += length
    out.push({ clientId, clock, state: json })
  }
  return out
}

/** 一条完整的 awareness 消息(类型 1 + 载荷),内容是这些 clientId 离开了。 */
export function encodeAwarenessRemoval(entries) {
  const body = []
  writeVarUint(body, entries.length)
  const nullJson = new TextEncoder().encode('null')
  for (const { clientId, clock } of entries) {
    writeVarUint(body, clientId)
    writeVarUint(body, clock + 1)
    writeVarUint(body, nullJson.length)
    body.push(...nullJson)
  }
  const head = []
  writeVarUint(head, 1)
  writeVarUint(head, body.length)
  return Uint8Array.from([...head, ...body])
}
