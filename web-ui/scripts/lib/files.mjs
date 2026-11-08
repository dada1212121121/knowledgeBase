// 测试里读仓库文件用的小工具(spec 在浏览器类型环境下编译,不直接依赖 node 类型,所以放在这里统一出口)。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 相对 web-ui 根目录读文本。 */
export function readText(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** 读 PNG 头:宽、高、颜色类型;签名不对会抛错。 */
export function pngInfo(relative) {
  const buffer = readFileSync(join(ROOT, relative))
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${relative} 不是 PNG`)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] }
}

/** 在隔离的沙箱里执行脚本(service worker 的测试用)。 */
export function runInSandbox(code, sandbox) {
  vm.runInNewContext(code, sandbox)
}
