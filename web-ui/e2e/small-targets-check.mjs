// smallTargets(触屏可点区域 ≥ 44px 的判据,share-scenarios.mjs)自己的对照检查:判据改了,这里要能看出改对还是改松了。
// 用法:node e2e/small-targets-check.mjs   有不符的退出码 1
//   被 44px 高的 <label> 包着的 36px 输入框 → 不报(点 label 任何位置都等于点输入框);
//   单独的 36px 输入框、label 本身也太小的、被普通 span 包着的、label 里还有别的按钮的 → 照报。
import { chromium } from '@playwright/test'
import { smallTargets } from './share-scenarios.mjs'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent(`
  <label style="display:flex;height:44px;width:200px"><input id="in-label" style="height:36px;width:150px"></label>
  <input id="alone" style="height:36px;width:150px">
  <label style="display:flex;height:30px;width:200px"><input id="in-small-label" style="height:24px;width:150px"></label>
  <span style="display:flex;height:44px;width:200px"><input id="in-span" style="height:36px;width:150px"></span>
  <label style="display:flex;height:44px;width:260px"><input id="in-two" style="height:36px;width:150px"><button type="button">清除</button></label>
`)
const cases = [
  ['被 44px label 包着的 36px 输入框', '#in-label', 0],
  ['单独的 36px 输入框', '#alone', 1],
  ['被 30px label 包着的 24px 输入框', '#in-small-label', 1],
  ['被普通 span 包着的 36px 输入框', '#in-span', 1],
  ['被 44px label 包着、但 label 里还有别的按钮的 36px 输入框', '#in-two', 1],
]
let bad = 0
for (const [name, selector, want] of cases) {
  const got = (await smallTargets(page, selector)).length
  console.log(`${got === want ? '✓' : '✗'} ${name}:期望报 ${want} 个,实际 ${got} 个`)
  if (got !== want) bad += 1
}
await browser.close()
process.exit(bad ? 1 : 0)
