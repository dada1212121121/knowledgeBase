// 单测:jsdom 环境(组件与 fetch 打桩都按浏览器语义跑)。
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@kb-ui': fileURLToPath(new URL('./packages/kb-ui/src', import.meta.url)),
      // 与 vite.config.ts 同一条：PPTX 引擎 WASM 的资源地址（engines/pptxWasm.ts 用 `?url` 取）
      '@pptx-wasm': fileURLToPath(new URL('./node_modules/@betteroffice/pptx/dist/generated', import.meta.url)),
      // 与 vite.config.ts 同一条：Word 引擎 WASM 的资源地址（engines/docxWasm.ts 用 `?url` 取）
      '@docx-wasm': fileURLToPath(new URL('./node_modules/@betteroffice/docx/dist/generated', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test-setup-codemirror.ts', 'src/test-setup-motion.ts'],
    include: ['src/**/*.spec.ts', 'packages/**/*.spec.ts'],
    // vitest 默认把所有 .css(含 ?raw 导入)替换成空串。离线版指南的单测要读 styles/guide.css 的真实内容
    // 来核对色板,所以只放行这一个文件,其它样式保持原样(不处理)
    css: { include: [/styles\/guide\.css/] },
  },
})
