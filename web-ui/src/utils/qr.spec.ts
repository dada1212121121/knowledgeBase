import { describe, expect, it } from 'vitest'
import { encodeQr, MAX_VERSION, qrPath, type QrCode } from './qr'

// ---------------------------------------------------------------- 独立写的解码器
// 这里**不复用** qr.ts 里的任何函数或表:GF(256) 乘法用逐位算法(实现里是查表),块结构用规范表 9 的
// 「组 1 / 组 2」写法(实现里是「块数 × 每块纠错码字」),对齐图案坐标写成常量(实现里是公式)。
// 两边各算各的再对账,实现里抄错一个数字这里就会读不回来。

const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
}
/** 等级 M 的每块纠错码字数与块分组 [块数, 每块数据码字数]。 */
const EC_M: Record<number, { ec: number; groups: [number, number][] }> = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
  11: { ec: 30, groups: [[1, 50], [4, 51]] },
  12: { ec: 22, groups: [[6, 36], [2, 37]] },
  13: { ec: 22, groups: [[8, 37], [1, 38]] },
  14: { ec: 24, groups: [[4, 40], [5, 41]] },
  15: { ec: 24, groups: [[5, 41], [5, 42]] },
}

function gfMul(a: number, b: number): number {
  let result = 0
  while (b) {
    if (b & 1) result ^= a
    a <<= 1
    if (a & 0x100) a ^= 0x11d
    b >>= 1
  }
  return result
}

/** 15 位格式信息是不是合法的 BCH(15,5) 码字(去掉 0x5412 掩码后能被 0x537 整除)。 */
function formatIsValid(bits: number): boolean {
  let value = bits ^ 0x5412
  for (let i = 14; i >= 10; i -= 1) if ((value >> i) & 1) value ^= 0x537 << (i - 10)
  return value === 0
}

function readFormat(modules: boolean[][]): { ec: number; mask: number } {
  const size = modules.length
  const at = (x: number, y: number) => (modules[y]![x] ? 1 : 0)
  // 第一份:左上角。bit i 的位置依规范图 25(i = 0 是最低位)
  let first = 0
  const topLeft: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  topLeft.forEach(([x, y], i) => (first |= at(x, y) << i))
  // 第二份:右上角(低 8 位,从右往左)+ 左下角(高 7 位,从上往下)
  let second = 0
  for (let i = 0; i < 8; i += 1) second |= at(size - 1 - i, 8) << i
  for (let i = 8; i < 15; i += 1) second |= at(8, size - 15 + i) << i
  if (first !== second) throw new Error('两份格式信息不一致')
  if (!formatIsValid(first)) throw new Error('格式信息纠错校验失败')
  const data = (first ^ 0x5412) >> 10
  return { ec: data >> 3, mask: data & 7 }
}

function isFunction(version: number, size: number, x: number, y: number): boolean {
  if (x <= 8 && y <= 8) return true // 左上定位 + 分隔 + 格式信息
  if (x >= size - 8 && y <= 8) return true // 右上
  if (x <= 8 && y >= size - 8) return true // 左下(含固定的深色模块)
  if (x === 6 || y === 6) return true // 时序线
  if (version >= 7 && ((x >= size - 11 && x <= size - 9 && y <= 5) || (y >= size - 11 && y <= size - 9 && x <= 5))) return true
  const positions = ALIGN[version]!
  for (const cx of positions) {
    for (const cy of positions) {
      const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === positions[positions.length - 1]) || (cy === 6 && cx === positions[positions.length - 1])
      if (!corner && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true
    }
  }
  return false
}

const MASK_FUNCTIONS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x * y) % 3) + ((x + y) % 2)) % 2 === 0,
]

/** 读回二维码里的文字;任何一步对不上(格式、纠错校验、模式)都抛错。 */
function decode(code: QrCode): string {
  const { modules, size, version } = code
  expect(size).toBe(17 + 4 * version)
  const format = readFormat(modules)
  if (format.ec !== 0) throw new Error(`纠错等级应是 M(00),读到 ${format.ec}`)
  // 按蛇形顺序读出所有数据位
  const bits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (isFunction(version, size, x, y)) continue
        bits.push(modules[y]![x]! !== MASK_FUNCTIONS[format.mask]!(x, y) ? 1 : 0)
      }
    }
  }
  const spec = EC_M[version]!
  const blockLengths = spec.groups.flatMap(([count, data]) => Array<number>(count).fill(data))
  const total = blockLengths.reduce((sum, length) => sum + length + spec.ec, 0)
  expect(Math.floor(bits.length / 8)).toBe(total)
  const words: number[] = []
  for (let i = 0; i < total; i += 1) words.push(bits.slice(i * 8, i * 8 + 8).reduce((acc, b) => (acc << 1) | b, 0))
  // 拆交织:先按列取数据码字,再按列取纠错码字
  const blocks = blockLengths.map(() => [] as number[])
  let cursor = 0
  for (let i = 0; i < Math.max(...blockLengths); i += 1) blockLengths.forEach((length, b) => i < length && blocks[b]!.push(words[cursor++]!))
  for (let i = 0; i < spec.ec; i += 1) blocks.forEach((block) => block.push(words[cursor++]!))
  // 每一块的 RS 校验子都必须是 0:S_j = r(α^j), j = 0..ec-1
  const data: number[] = []
  blocks.forEach((block, b) => {
    for (let j = 0; j < spec.ec; j += 1) {
      let alpha = 1
      for (let k = 0; k < j; k += 1) alpha = gfMul(alpha, 2)
      let syndrome = 0
      for (const word of block) syndrome = gfMul(syndrome, alpha) ^ word
      if (syndrome !== 0) throw new Error(`第 ${b} 块纠错校验失败(S${j} = ${syndrome})`)
    }
    data.push(...block.slice(0, blockLengths[b]!))
  })
  const stream = data.flatMap((word) => Array.from({ length: 8 }, (_, i) => (word >> (7 - i)) & 1))
  const read = (from: number, length: number) => stream.slice(from, from + length).reduce((acc, b) => (acc << 1) | b, 0)
  if (read(0, 4) !== 0b0100) throw new Error('不是字节模式')
  const countLength = version < 10 ? 8 : 16
  const count = read(4, countLength)
  const bytes = Uint8Array.from({ length: count }, (_, i) => read(4 + countLength + i * 8, 8))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** 确定性的伪随机可打印 ASCII(LCG),不同版本、不同长度读回的内容不会碰巧一样。 */
function sample(length: number, seed: number): string {
  let state = seed
  let out = ''
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out += String.fromCharCode(33 + ((state >>> 16) % 94))
  }
  return out
}

/** 字节模式的容量:版本 1–9 开销 12 位,10 以上 20 位。 */
const CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412]

describe('encodeQr', () => {
  it('每个版本都能被独立的解码器读回原文(纠错校验全部通过)', () => {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      const text = sample(CAPACITY[version]!, version * 7919)
      const code = encodeQr(text)
      expect(code, `版本 ${version}`).not.toBeNull()
      expect(code!.version, `刚好装满应是版本 ${version}`).toBe(version)
      expect(decode(code!), `版本 ${version} 读回`).toBe(text)
    }
  })

  it('多一个字节就升一个版本,放不下版本 15 返回 null', () => {
    for (let version = 1; version < MAX_VERSION; version += 1) {
      const code = encodeQr(sample(CAPACITY[version]! + 1, version))
      expect(code!.version).toBe(version + 1)
    }
    expect(encodeQr(sample(CAPACITY[MAX_VERSION]! + 1, 1))).toBeNull()
  })

  it('短文字、空文字和各种长度都能读回', () => {
    for (const length of [0, 1, 2, 13, 14, 15, 41, 42, 43, 100, 200, 300, 400]) {
      const text = sample(length, length + 1)
      expect(decode(encodeQr(text)!), `长度 ${length}`).toBe(text)
    }
  })

  it('按 UTF-8 编码:中文和表情读回一致', () => {
    const text = '知识库:alice@example.com 🔐'
    expect(decode(encodeQr(text)!)).toBe(text)
  })

  it('真实的 otpauth 地址(中文站点名被百分号编码)读回一致', () => {
    const uri =
      'otpauth://totp/%E7%9F%A5%E8%AF%86%E5%BA%93:alice%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=%E7%9F%A5%E8%AF%86%E5%BA%93&algorithm=SHA1&digits=6&period=30'
    const code = encodeQr(uri)!
    expect(code.version).toBeLessThanOrEqual(10)
    expect(decode(code)).toBe(uri)
  })

  it('三个定位图案、时序线和固定的深色模块都在', () => {
    const { modules, size } = encodeQr('hello')!
    const finder = (ox: number, oy: number) => {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
          expect(modules[oy + dy]![ox + dx], `定位图案 (${dx},${dy})`).toBe(ring !== 2)
        }
      }
    }
    finder(0, 0)
    finder(size - 7, 0)
    finder(0, size - 7)
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0)
      expect(modules[i]![6]).toBe(i % 2 === 0)
    }
    expect(modules[size - 8]![8]).toBe(true)
  })

  it('解码器会发现损坏:翻转一个数据模块后校验失败', () => {
    // 用来证明上面「读回一致」不是空转:读不出的东西必须抛错
    const code = encodeQr(sample(60, 5))!
    const flipped: QrCode = { ...code, modules: code.modules.map((row) => row.slice()) }
    flipped.modules[code.size - 1]![code.size - 1] = !flipped.modules[code.size - 1]![code.size - 1]
    expect(() => decode(flipped)).toThrow()
  })
})

describe('qrPath', () => {
  it('四周留 4 格空白,矩形总宽度等于深色模块数', () => {
    const code = encodeQr('otpauth://totp/x?secret=ABC')!
    const { viewBox, d } = qrPath(code)
    expect(viewBox).toBe(`0 0 ${code.size + 8} ${code.size + 8}`)
    const dark = code.modules.flat().filter(Boolean).length
    const widths = Array.from(d.matchAll(/h(\d+)v1h-\1z/g)).map((match) => Number(match[1]))
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(dark)
    expect(d.startsWith('M')).toBe(true)
  })

  it('每个矩形都落在留白之内', () => {
    const code = encodeQr('hello world')!
    const { d } = qrPath(code, 2)
    for (const match of Array.from(d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g))) {
      const [x, y, width] = [Number(match[1]), Number(match[2]), Number(match[3])]
      expect(x).toBeGreaterThanOrEqual(2)
      expect(y).toBeGreaterThanOrEqual(2)
      expect(x + width).toBeLessThanOrEqual(code.size + 2)
      expect(y).toBeLessThan(code.size + 2)
    }
  })
})
