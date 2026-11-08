// 和守护进程之间的帧:u32(大端)总长 N,u32(大端)JSON 长度 J,J 字节 JSON(UTF-8),其余 N-4-J 字节是二进制载荷。
// 走标准输入输出:不用开监听端口,也不用 socket 文件;子进程跟着守护进程生死。

/** 编码一帧。 */
export function encodeFrame(meta, body = new Uint8Array(0)) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8')
  const out = Buffer.allocUnsafe(8 + json.length + body.length)
  out.writeUInt32BE(4 + json.length + body.length, 0)
  out.writeUInt32BE(json.length, 4)
  json.copy(out, 8)
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(out, 8 + json.length)
  return out
}

/** 从字节流里切帧:喂进去任意大小的块,吐出完整的 { meta, body }。单帧超过上限直接报错(防内存被撑爆)。 */
export class FrameReader {
  constructor(maxFrameBytes = 256 * 1024 * 1024) {
    this.max = maxFrameBytes
    this.chunks = []
    this.length = 0
  }

  push(chunk) {
    this.chunks.push(chunk)
    this.length += chunk.length
    const frames = []
    for (;;) {
      if (this.length < 4) break
      const head = this.#peek(4)
      const total = head.readUInt32BE(0)
      if (total > this.max) throw new Error(`帧太大:${total} 字节`)
      if (this.length < 4 + total) break
      const frame = this.#take(4 + total)
      const jsonLength = frame.readUInt32BE(4)
      if (jsonLength > total - 4) throw new Error('坏帧:JSON 长度越界')
      const meta = JSON.parse(frame.subarray(8, 8 + jsonLength).toString('utf8'))
      const body = new Uint8Array(frame.buffer, frame.byteOffset + 8 + jsonLength, total - 4 - jsonLength)
      frames.push({ meta, body })
    }
    return frames
  }

  #peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0]
    const merged = Buffer.concat(this.chunks)
    this.chunks = [merged]
    return merged
  }

  #take(n) {
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    const frame = merged.subarray(0, n)
    const rest = merged.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.length -= n
    return frame
  }
}
