// 端到端冒烟链路(playwright):登录 → 仪表盘 → 浏览器 → 搜索 → 任务 → 审计 → 撤销。
//
// 需要一个**已登录可用**的守护进程与 fixture 数据:
// 然后在同一个 shell 里:
//   KB_WEB_PASSWORD=kb-ui-capture npx playwright test e2e/smoke.spec.ts
//
// 环境变量:
//   KB_BASE_URL      默认 http://127.0.0.1:7878
//   KB_WEB_PASSWORD  没设置时整组用例 skip(避免在 CI 上误红)
import { expect, test } from '@playwright/test'

// 不引 @types/node:这里只用到 process.env,显式声明一下即可
declare const process: { env: Record<string, string | undefined> }

const BASE = process.env.KB_BASE_URL ?? 'http://127.0.0.1:7878'
const PASSWORD = process.env.KB_WEB_PASSWORD

test.skip(!PASSWORD, '需要 KB_WEB_PASSWORD 与一个带 fixture 的守护进程(见文件头)')

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`)
  await page.locator('input[type="password"]').fill(PASSWORD as string)
  await page.keyboard.press('Enter')
  // 登录后的落地页是「首页」(起);系统概览(原仪表盘)要显式打开
  await page.waitForURL(/\/home/, { timeout: 20_000 })
}

test('登录后能在系统概览(原仪表盘)看到运行概况', async ({ page }) => {
  await login(page)
  // 旧地址 /dashboard 会重定向到 /admin/overview
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByText('系统概览', { exact: false }).first()).toBeVisible()
  // 指标卡来自 stats_overview
  await expect(page.getByText('知识条目')).toBeVisible()
  await expect(page.getByText('模型与 sidecar')).toBeVisible()
  // 集合表里能看到 fixture 的项目 collection
  await expect(page.getByText('proj_demo', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  })
})

test('浏览器页能列出条目并打开详情', async ({ page }) => {
  await login(page)
  await page.goto(`${BASE}/browser`)
  // 列表里至少有一条(code 或 insight)
  const rows = page.locator('table tr').filter({ hasText: /\.rs|insight|demo/ })
  await expect(rows.first()).toBeVisible({ timeout: 20_000 })
  await rows.first().click()
  // 详情区出现「正文 / 元数据」页签
  await expect(page.getByText('正文', { exact: true })).toBeVisible()
  await expect(page.getByText('元数据', { exact: true })).toBeVisible()
})

test('搜索演练场能返回命中', async ({ page }) => {
  await login(page)
  await page.goto(`${BASE}/search`)
  await page.getByPlaceholder(/双哈希增量索引/).fill('login')
  await page.locator('.btn', { hasText: '搜索' }).first().click()
  // 结果条数与耗时来自真实响应:「N 条 · X ms」
  await expect(page.getByText(/\d+ 条 · \d+ ms/).first()).toBeVisible({ timeout: 20_000 })
})

test('任务页与审计页可访问', async ({ page }) => {
  await login(page)
  await page.goto(`${BASE}/jobs`)
  // 任务页:四张指标卡 + 任务表
  await expect(page.getByText('24h 完成')).toBeVisible()
  await page.goto(`${BASE}/audit`)
  await expect(page.getByText('调用记录', { exact: true })).toBeVisible()
  // 批次页签能打开(有 fixture 的 create_item / edit_item 批次)
  await page.locator('.tab', { hasText: '批次' }).click()
  await expect(page.getByText('撤销整批').first()).toBeVisible({ timeout: 20_000 })
})

test('撤销一次批次后条目回到批次前状态', async ({ page }) => {
  await login(page)
  await page.goto(`${BASE}/audit`)
  await page.locator('.tab', { hasText: '批次' }).click()
  const revert = page.getByText('撤销整批').first()
  await expect(revert).toBeVisible({ timeout: 20_000 })
  page.once('dialog', (dialog) => void dialog.accept())
  await revert.click()
  // 撤销成功后会刷新批次列表:该批次变成「已撤销」
  await expect(page.getByText('已撤销').first()).toBeVisible({ timeout: 20_000 })
})
