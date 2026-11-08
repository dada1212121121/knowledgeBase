import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
const [aPath, ePath, x0, y0, x1, y1] = process.argv.slice(2)
const a = PNG.sync.read(readFileSync(aPath)); const e = PNG.sync.read(readFileSync(ePath))
const [X0, Y0, X1, Y1] = [x0, y0, x1, y1].map(Number)
let diff = 0, total = 0
for (let y = Y0; y < Math.min(Y1, a.height, e.height); y++) {
  for (let x = X0; x < Math.min(X1, a.width, e.width); x++) {
    const ia = (y * a.width + x) * 4, ie = (y * e.width + x) * 4
    const d = Math.abs(a.data[ia]-e.data[ie]) + Math.abs(a.data[ia+1]-e.data[ie+1]) + Math.abs(a.data[ia+2]-e.data[ie+2])
    total++; if (d > 30) diff++
  }
}
console.log(`crop ${X0},${Y0}-${X1},${Y1}: ${(diff/total*100).toFixed(2)}%`)
