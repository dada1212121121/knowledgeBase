import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
const [aP, eP, x0, y0, x1, y1] = process.argv.slice(2)
const a = PNG.sync.read(readFileSync(aP)), e = PNG.sync.read(readFileSync(eP))
const [X0, Y0, X1, Y1] = [x0, y0, x1, y1].map(Number)
function ratio(dx, dy) {
  let diff = 0, total = 0
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const ax = x + dx, ay = y + dy
    if (ax < 0 || ay < 0 || ax >= a.width || ay >= a.height) { diff++; total++; continue }
    const ia = (ay * a.width + ax) * 4, ie = (y * e.width + x) * 4
    const d = Math.abs(a.data[ia]-e.data[ie]) + Math.abs(a.data[ia+1]-e.data[ie+1]) + Math.abs(a.data[ia+2]-e.data[ie+2])
    total++; if (d > 30) diff++
  }
  return diff / total
}
let best = [1, 0, 0]
for (let dy = -20; dy <= 20; dy += 2) for (let dx = -20; dx <= 20; dx += 2) {
  const r = ratio(dx, dy); if (r < best[0]) best = [r, dx, dy]
}
console.log(`base ${(ratio(0,0)*100).toFixed(2)}% | best dx=${best[1]} dy=${best[2]} → ${(best[0]*100).toFixed(2)}%`)
