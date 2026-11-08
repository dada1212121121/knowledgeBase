// playwright 配置:冒烟用例默认单 worker(它们共享同一个守护进程与 fixture)。
import { defineConfig } from '@playwright/test'

declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.KB_BASE_URL ?? 'http://127.0.0.1:7878',
    // 容器里以 root 跑,chromium 的 sandbox 起不来
    launchOptions: { chromiumSandbox: false },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
})
