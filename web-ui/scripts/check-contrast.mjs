#!/usr/bin/env node
// 对比度守卫(颜色规范):五个主题 × 全部背景 × 文字 token、八个强调色的文字色,都要达标。
// 规则与阈值见 scripts/lib/contrast.mjs;校准值在 packages/kb-ui/src/tokens/contrast.css(由 calibrate-contrast.mjs 生成)。
// 跑法:node scripts/check-contrast.mjs(由 `npm run lint` 调用)。
import { matrix, tintMatrix } from './lib/contrast.mjs'

// 实心背景上的文字 + 强调色 / 状态色淡色底上的文字(标签、选中的药丸、提示条),后者是 axe color-contrast 暴露的缺口
const rows = [...matrix(), ...tintMatrix()]
const bad = rows.filter((row) => !row.ok)
if (bad.length) {
  console.error(`✗ ${bad.length} 项对比度不达标(共 ${rows.length} 项):`)
  for (const row of bad) console.error(`  ${row.theme} ${row.token}: ${row.worst.toFixed(2)}:1,需要 ≥ ${row.need}:1`)
  console.error('  运行 node scripts/calibrate-contrast.mjs 重新生成 contrast.css')
  process.exit(1)
}
console.log(`✓ 对比度:${rows.length} 项(5 个主题 × 正文 7:1 / 次要 4.5:1 / 弱化 3:1 / 状态与强调色 4.5:1,含淡色底上的强调色与状态色文字)全部达标`)
