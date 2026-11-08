// 二维码生成器(ISO/IEC 18004),只实现「两步验证绑定」用得到的那一部分:
//   字节模式、纠错等级 M、版本 1–15(最多 412 字节)。
//
// 为什么自己写而不是装一个库:
//   - 项目有主包体积预算(gzip ≤ 250 KB),而依赖要走共享的 node_modules,多个分支同时开发时装包会互相踩;
//   - 绑定用的 otpauth:// 地址全是 ASCII(后端把非 ASCII 都做了百分号编码),字节模式够用,
//     不需要数字 / 字母数字 / 汉字模式,也不需要 ECI 和版本 16 以上,所以实现很小;
//   - 生成发生在浏览器里:密钥不经过任何第三方服务,也不会因为「在线二维码接口」而泄露。
//
// 对不上规范会直接扫不出来,所以 qr.spec.ts 里有一个**独立写的解码器**(读格式信息、去掩码、
// 拆块、校验 Reed-Solomon、读回文字)来回读,每个版本都测;另外手工用 zbarimg / OpenCV 扫过截图。
//
// 本文件只能被动态 import(见 components/TotpQr.vue),不要在主包里静态引用。

/** 支持的最高版本(版本 15 = 77×77 个模块)。 */
export const MAX_VERSION = 15

// 纠错等级 M 的参数,下标是版本号(0 不用)。来自规范表 9;每块纠错码字数 × 块数 + 数据码字数 = 总码字数。
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10]

export interface QrCode {
  version: number
  /** 边长(模块数)。 */
  size: number
  /** modules[y][x] 为 true 表示深色模块。 */
  modules: boolean[][]
}

const sizeOf = (version: number) => 17 + 4 * version

/** 对齐图案中心坐标(规范附录 E 的公式化写法)。 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = sizeOf(version) - 7; result.length < count; position -= step) result.splice(1, 0, position)
  return result
}

/** 一个版本里能放数据的模块总数(去掉功能图案之后),除以 8 取整就是总码字数。 */
function totalCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2
    modules -= (25 * count - 10) * count - 55
    if (version >= 7) modules -= 36
  }
  return Math.floor(modules / 8)
}

const dataCodewords = (version: number) => totalCodewords(version) - EC_PER_BLOCK[version]! * BLOCKS[version]!

/** 字节模式的字符计数位数:版本 1–9 是 8 位,10 以上是 16 位。 */
const countBits = (version: number) => (version < 10 ? 8 : 16)

// ---------------------------------------------------------------- GF(256) 与 Reed-Solomon

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1(0x11D)
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!)

/** 次数为 degree 的生成多项式 ∏(x − α^i) 的系数(最高次项系数恒为 1,省略)。 */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = mul(result[j]!, root)
      if (j + 1 < degree) result[j]! ^= result[j + 1]!
    }
    root = mul(root, 2)
  }
  return result
}

/** 数据除以生成多项式的余数,就是这一块的纠错码字。 */
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i]! ^= mul(coef, factor)
    })
  }
  return result
}

// ---------------------------------------------------------------- 编码

/** 文字 → 数据码字(模式、长度、内容、结束符、填充)。放不下返回 null。 */
function dataBits(bytes: Uint8Array, version: number): number[] | null {
  const capacity = dataCodewords(version) * 8
  if (4 + countBits(version) + bytes.length * 8 > capacity) return null
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  return bits
}

/** 拆块、算纠错码、按规范交织:先按列交织数据码字,再按列交织纠错码字。 */
function interleave(data: number[], version: number): number[] {
  const blocks = BLOCKS[version]!
  const ecLength = EC_PER_BLOCK[version]!
  const total = totalCodewords(version)
  const shortBlocks = blocks - (total % blocks)
  const shortLength = Math.floor(total / blocks) - ecLength
  const divisor = rsDivisor(ecLength)
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  for (let i = 0, offset = 0; i < blocks; i += 1) {
    const length = shortLength + (i < shortBlocks ? 0 : 1)
    const block = data.slice(offset, offset + length)
    offset += length
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, divisor))
  }
  const out: number[] = []
  for (let i = 0; i <= shortLength; i += 1) for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  for (let i = 0; i < ecLength; i += 1) for (const block of ecBlocks) out.push(block[i]!)
  return out
}

// ---------------------------------------------------------------- 画矩阵

class Grid {
  readonly modules: boolean[][]
  /** 功能图案(定位、对齐、时序、格式 / 版本信息):放数据和加掩码时都要跳过。 */
  readonly reserved: boolean[][]

  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  fixed(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.reserved[y]![x] = true
  }
}

const bit = (value: number, index: number) => ((value >>> index) & 1) === 1

function drawFinder(grid: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue
      const ring = Math.max(Math.abs(dx), Math.abs(dy))
      // 7×7 的回字 + 外面一圈白色分隔带
      grid.fixed(x, y, ring !== 2 && ring !== 4)
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid
  for (let i = 0; i < size; i += 1) {
    grid.fixed(6, i, i % 2 === 0)
    grid.fixed(i, 6, i % 2 === 0)
  }
  drawFinder(grid, 3, 3)
  drawFinder(grid, size - 4, 3)
  drawFinder(grid, 3, size - 4)
  const positions = alignmentPositions(version)
  positions.forEach((px, i) => {
    positions.forEach((py, j) => {
      // 三个角上有定位图案,不画对齐图案
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) return
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) grid.fixed(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    })
  })
  drawFormat(grid, 0)
  if (version >= 7) {
    // 版本信息:6 位版本号 + 12 位 BCH(18,6) 纠错,在右上和左下各放一份
    let rest = version
    for (let i = 0; i < 12; i += 1) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25)
    const bits = (version << 12) | rest
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      grid.fixed(a, b, bit(bits, i))
      grid.fixed(b, a, bit(bits, i))
    }
  }
}

/** 格式信息:纠错等级 M(00)+ 掩码编号,BCH(15,5) 纠错后与 0x5412 异或,放两份。 */
function drawFormat(grid: Grid, mask: number) {
  const { size } = grid
  const data = (0b00 << 3) | mask
  let rest = data
  for (let i = 0; i < 10; i += 1) rest = (rest << 1) ^ ((rest >>> 9) * 0x537)
  const bits = ((data << 10) | rest) ^ 0x5412
  for (let i = 0; i <= 5; i += 1) grid.fixed(8, i, bit(bits, i))
  grid.fixed(8, 7, bit(bits, 6))
  grid.fixed(8, 8, bit(bits, 7))
  grid.fixed(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i += 1) grid.fixed(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i += 1) grid.fixed(size - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i += 1) grid.fixed(8, size - 15 + i, bit(bits, i))
  grid.fixed(8, size - 8, true) // 固定的深色模块
}

/** 沿「两列一组、自下而上再自上而下」的蛇形路线放码字,跳过功能图案和竖直时序线所在的列。 */
function placeCodewords(grid: Grid, codewords: number[]) {
  const { size } = grid
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!grid.reserved[y]![x] && index < codewords.length * 8) {
          grid.modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7))
          index += 1
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function applyMask(grid: Grid, mask: number) {
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.reserved[y]![x] && MASKS[mask]!(x, y)) grid.modules[y]![x] = !grid.modules[y]![x]
    }
  }
}

/** 规范里的四条罚分规则(同色连续、2×2 同色块、类定位图案、深浅比例);分数越低越容易扫。 */
function penalty(grid: Grid): number {
  const { size, modules } = grid
  let score = 0
  const lines: boolean[][] = []
  for (let a = 0; a < size; a += 1) {
    lines.push(modules[a]!)
    lines.push(modules.map((row) => row[a]!))
  }
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    // 1:1:3:1:1 的类定位图案,前后任意一侧有 4 个浅色模块
    for (let i = 0; i + 11 <= size; i += 1) {
      const slice = line.slice(i, i + 11).map((v) => (v ? 1 : 0)).join('')
      if (slice === '10111010000' || slice === '00001011101') score += 40
    }
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const v = modules[y]![x]
      if (v === modules[y]![x + 1] && v === modules[y + 1]![x] && v === modules[y + 1]![x + 1]) score += 3
    }
  }
  let dark = 0
  for (const row of modules) for (const v of row) if (v) dark += 1
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * 把文字编成二维码。文字太长(超出版本 15 的容量)返回 `null`:调用方要给出退路(手动输入密钥)。
 * 文字按 UTF-8 编码;otpauth 地址本身是 ASCII,不受影响。
 */
export function encodeQr(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text)
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const bits = dataBits(bytes, version)
    if (!bits) continue
    const data: number[] = []
    for (let i = 0; i < bits.length; i += 8) data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2))
    const grid = new Grid(sizeOf(version))
    drawFunctionPatterns(grid, version)
    placeCodewords(grid, interleave(data, version))
    // 八种掩码都试一遍,取罚分最低的
    let best = 0
    let bestScore = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(grid, mask)
      drawFormat(grid, mask)
      const score = penalty(grid)
      if (score < bestScore) {
        best = mask
        bestScore = score
      }
      applyMask(grid, mask) // 异或两次还原
    }
    applyMask(grid, best)
    drawFormat(grid, best)
    return { version, size: grid.size, modules: grid.modules }
  }
  return null
}

/**
 * 生成 SVG `<path>` 的 d 属性:每一行连续的深色模块合并成一个矩形,比逐格画小得多。
 * `quiet` 是四周留白的模块数(规范要求至少 4,扫码器靠它找到边界)。
 */
export function qrPath(code: QrCode, quiet = 4): { viewBox: string; d: string } {
  const parts: string[] = []
  for (let y = 0; y < code.size; y += 1) {
    const row = code.modules[y]!
    for (let x = 0; x < code.size; x += 1) {
      if (!row[x]) continue
      let end = x
      while (end + 1 < code.size && row[end + 1]) end += 1
      parts.push(`M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`)
      x = end
    }
  }
  const full = code.size + quiet * 2
  return { viewBox: `0 0 ${full} ${full}`, d: parts.join('') }
}
