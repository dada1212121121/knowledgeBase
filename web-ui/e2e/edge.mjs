import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
const png = PNG.sync.read(readFileSync(process.argv[2]))
const { width, height, data } = png
// 统计最右侧 8 列里与背景不同的像素占比,判断是否被裁切(内容贴边)
const at = (x, y) => {
  const i = (y * width + x) * 4
  return [data[i], data[i + 1], data[i + 2]]
}
const bg = at(2, 2)
let edge = 0
for (let y = 0; y < height; y++) {
  for (let x = width - 8; x < width; x++) {
    const [r, g, b] = at(x, y)
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) edge++
  }
}
console.log(`${process.argv[2].split('/').pop()} 尺寸 ${width}x${height} 右边缘非背景占比 ${(edge / (height * 8) * 100).toFixed(1)}% 背景色 rgb(${bg.join(',')})`)
