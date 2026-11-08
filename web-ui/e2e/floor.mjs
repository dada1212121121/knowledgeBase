import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFileSync } from 'node:fs'
const [a, e] = process.argv.slice(2)
const A = PNG.sync.read(readFileSync(a)), E = PNG.sync.read(readFileSync(e))
if (A.width !== E.width || A.height !== E.height) { console.log('size mismatch'); process.exit(0) }
const diff = new PNG({ width: A.width, height: A.height })
const pixels = pixelmatch(A.data, E.data, diff.data, A.width, A.height, { threshold: 0.1 })
console.log(`${(pixels / (A.width * A.height) * 100).toFixed(2)}%`)
