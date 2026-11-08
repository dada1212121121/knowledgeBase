// 调试用:分析两张截图的差异分布(定位“差异集中在哪一块”)。
// 用法:node e2e/analyse.mjs <actual.png> <expected.png> [--bands]
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

const [actualPath, expectedPath] = process.argv.slice(2)
const a = PNG.sync.read(readFileSync(actualPath))
const e = PNG.sync.read(readFileSync(expectedPath))
const w = Math.min(a.width, e.width)
const h = Math.min(a.height, e.height)

function differs(x, y) {
  const ia = (y * a.width + x) * 4
  const ie = (y * e.width + x) * 4
  const d =
    Math.abs(a.data[ia] - e.data[ie]) +
    Math.abs(a.data[ia + 1] - e.data[ie + 1]) +
    Math.abs(a.data[ia + 2] - e.data[ie + 2])
  return d > 30
}

let total = 0
const rowDiff = new Array(h).fill(0)
const colDiff = new Array(w).fill(0)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (differs(x, y)) {
      total++
      rowDiff[y]++
      colDiff[x]++
    }
  }
}
console.log('sizes', `${a.width}x${a.height}`, '|', `${e.width}x${e.height}`)
console.log('diff ratio', (total / (w * h)).toFixed(4))

// 差异最集中的 10 个横向条带(按 10px 聚合)与 10 个纵向条带
const bands = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) {
    const sum = arr.slice(i, i + size).reduce((acc, value) => acc + value, 0)
    out.push({ start: i, end: Math.min(i + size, arr.length), sum })
  }
  return out.sort((left, right) => right.sum - left.sum).slice(0, 10)
}
const dpr = a.width / (a.width > 900 ? 1440 : 390)
console.log('top row bands (device px):')
for (const band of bands(rowDiff, 10)) {
  console.log(`  y ${band.start}-${band.end}: ${band.sum} (${(band.sum / (w * (band.end - band.start)) * 100).toFixed(1)}% of band)`)
}
console.log('top col bands (device px):')
for (const band of bands(colDiff, 10)) {
  console.log(`  x ${band.start}-${band.end}: ${band.sum} (${(band.sum / (h * (band.end - band.start)) * 100).toFixed(1)}% of band)`)
}
