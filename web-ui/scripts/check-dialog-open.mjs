// 守卫:页面 / 布局里不能给 <KbDialog> 传 `:open`(组件没有这个 prop,传了会变成“永远挂着的模态”)。
// 用法:node scripts/check-dialog-open.mjs(由 npm run lint 串起来)
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIRS = ['src/pages', 'src/layouts', 'src/components']

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.vue')) yield path
  }
}

const problems = []
for (const dir of DIRS) {
  for await (const file of walk(join(ROOT, dir))) {
    const text = await readFile(file, 'utf8')
    // 找到每个 <KbDialog ...> 的开始标签,检查里面有没有 :open=
    const tags = text.match(/<KbDialog\b[\s\S]*?>/g) ?? []
    for (const tag of tags) {
      if (/:open\s*=/.test(tag)) {
        problems.push(`${file.replace(ROOT + '/', '')}: <KbDialog> 不支持 :open,请用 v-if 挂载`)
      }
    }
  }
}

if (problems.length) {
  console.error('✗ KbDialog 用法有问题:')
  for (const line of problems) console.error('  ' + line)
  process.exit(1)
}
console.log('✓ KbDialog 都用 v-if 挂载,没有误用 :open')
