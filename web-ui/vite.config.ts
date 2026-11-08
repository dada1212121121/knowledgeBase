// Vite 配置:开发时把 /api 与 ws 代理到守护进程。
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

/**
 * 不让上游 `@betteroffice/fonts` 把整包字体打进 dist。
 *
 * 上游的入口把 72 个字体登记在一张 `new URL('../assets/x.ttf', import.meta.url)` 表里，Vite 会把表里每个文件都当资源输出
 * （拉丁 14.7 MB），再加上它按需 import 的 `@betteroffice/fonts-cjk`（5 个完整 CJK OTF，33.2 MB），
 * 光这一项就让 dist 的字体总量到 57 MB。我们只用它的「族名 → 度量兼容字体」解析函数，字节由
 * `src/editor/engines/fonts/docxFonts.ts` 自己的提供器从精选的一小组文件里取，所以这里把资源表清空、
 * 把 CJK 附加包换成空表。找不到要替换的文本就让构建失败：宁可构建红灯，也不能悄悄回到 57 MB
 * （`scripts/dist-report.mjs` 的字体预算是第二道闸）。
 */
function pruneBetterofficeFonts(): Plugin {
  return {
    name: 'kb-prune-betteroffice-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@betteroffice[\\/]fonts[\\/]dist[\\/]index\.js$/.test(id.split('?')[0]!)) return null
      const assetTable = /var FONT_ASSET_URLS = \{[\s\S]*?\n\};/
      const cjkImport = /await import\("@betteroffice\/fonts-cjk"\)/
      if (!assetTable.test(code) || !cjkImport.test(code)) {
        this.error('@betteroffice/fonts 的入口文件结构变了：kb-prune-betteroffice-fonts 找不到资源表或 CJK 附加包的 import，请先更新 vite.config.ts 里的替换规则，再升级这个包')
      }
      return { code: code.replace(assetTable, 'var FONT_ASSET_URLS = {};').replace(cjkImport, '({ CJK_FONT_ASSET_URLS: {} })'), map: null }
    },
  }
}

/**
 * KaTeX 的样式表给每个字体写了 woff2 / woff / ttf 三份 `src`，Vite 会把三份都输出（共 1.03 MB，其中 woff + ttf 占 0.78 MB），
 * 而浏览器只用第一个能解的 woff2（Chrome 36+ / Firefox 39+ / Safari 12+，本项目本来就要求现代浏览器）。
 * 构建时把 woff / ttf 两份 `src` 去掉；找不到要去掉的内容就让构建失败，免得上游改了写法后悄悄多出 0.78 MB。
 */
function pruneKatexFonts(): Plugin {
  return {
    name: 'kb-prune-katex-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id.split('?')[0]!)) return null
      const legacy = /,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g
      if (!legacy.test(code)) this.error('katex.min.css 里找不到 woff / ttf 的 src：kb-prune-katex-fonts 的替换规则需要随 KaTeX 升级更新')
      return { code: code.replace(legacy, ''), map: null }
    },
  }
}

/**
 * 把随产物分发的字体的许可文本（SIL OFL 1.1）和仓库根的 NOTICE 一起输出到 dist/licenses/：
 * OFL 要求再分发字体时附带版权声明与许可全文，而 dist 会被整个嵌进二进制对外提供。
 */
function emitLicenses(): Plugin {
  const fontsDir = fileURLToPath(new URL('./src/editor/engines/fonts', import.meta.url))
  return {
    name: 'kb-emit-licenses',
    generateBundle() {
      for (const name of readdirSync(fontsDir).filter((file) => /^OFL-.*\.txt$/.test(file))) {
        this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: readFileSync(join(fontsDir, name)) })
      }
      this.emitFile({ type: 'asset', fileName: 'licenses/NOTICE.txt', source: readFileSync(fileURLToPath(new URL('../NOTICE', import.meta.url))) })
    },
  }
}

/**
 * Vite 开发服务器的 `/api` 反向代理目标。
 *
 * 默认连开发实例的守护进程(scripts/dev-instance.sh,固定 27878);它自己也会在 28600 提供一份
 * 构建产物,但改界面时走 5173 的 HMR 更快。要连别的守护进程(例如默认配置的 7878、
 * 或临时端口的 e2e)就设 `KB_API_PROXY`(和 `e2e/serve.mjs` 一样,`KB_DAEMON_URL` 也认),不要把端口写死在命令里。
 */
const apiProxyTarget = process.env.KB_API_PROXY ?? process.env.KB_DAEMON_URL ?? 'http://127.0.0.1:27878'

export default defineConfig({
  plugins: [vue(), pruneBetterofficeFonts(), pruneKatexFonts(), emitLicenses()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@kb-ui': fileURLToPath(new URL('./packages/kb-ui/src', import.meta.url)),
      // @betteroffice/docx 自带的 Worker 入口 dist/docxWorker.mjs 没有对应
      // exports 子路径（只导出 ./worker 等主线程 API），但上游内部是用
      // `new Worker(new URL('./docxWorker.mjs', import.meta.url), { type: 'module' })`
      // 自己拉起的。裸路径会被 exports map 拦下，这里给一个显式 alias，
      // 让我们的 engines/docx/docx.worker.ts 能以 `?worker` 方式把它整张图
      // 打包成单个同源 ES 模块文件（CSP worker-src 'self'，不用 blob:/data:）。
      '@betteroffice/docx/worker-entry': fileURLToPath(
        new URL('./node_modules/@betteroffice/docx/dist/docxWorker.mjs', import.meta.url),
      ),
      // PPTX 引擎的 WASM 资源：引擎的 exports 里没有这条子路径，只能显式别名到它的 generated 目录，
      // 再以 `@pptx-wasm/pptx_wasm_bg.wasm?url` 取资源地址（别名按「目录」匹配，才能带 ?url 查询串），
      // 让 engines/pptxWasm.ts 能自己下载并编译一次，主线程与编辑 Worker 共用（见该文件的说明）。
      '@pptx-wasm': fileURLToPath(new URL('./node_modules/@betteroffice/pptx/dist/generated', import.meta.url)),
      // Word 编辑引擎的 WASM 资源（同上：exports 里没有 generated 子路径）。`@docx-wasm/edit/docx_edit_bg.wasm?url` 取资源地址，
      // 让 engines/docxWasm.ts 不 import 引擎就能在悬停 / 点击时开始下载，并编译一次给所有 Worker 共用（见该文件的说明）。
      '@docx-wasm': fileURLToPath(new URL('./node_modules/@betteroffice/docx/dist/generated', import.meta.url)),
    },
  },
  server: {
    // 使用指南页直接 import 仓库根目录 docs/guide 下的 Markdown(只维护一份),开发服务器默认只放行 web-ui 自己
    fs: { allow: ['..'] },
    port: 5173,
    proxy: {
      // 目标端口必须和真正在跑的守护进程一致:指错了页面只会拿到 500 / 空列表,
      // Vite 日志里是 `http proxy error ... ECONNREFUSED 127.0.0.1:<port>`。
      // 不要用 changeOrigin: 它会把 Host 改写成上游端口,而守护进程的 CSRF 校验要求
      // Origin 与 Host 一致(见 kb-web/src/auth/csrf.rs),改写后所有写请求都会 403
      // 「Origin(127.0.0.1:5173)与 Host(127.0.0.1:27878)不一致」。保留浏览器的
      // Host(127.0.0.1:5173)与 28600 的 serve.mjs 做法一致。
      '/api': { target: apiProxyTarget, changeOrigin: false, ws: true },
    },
  },
  // 办公文档编辑引擎(Word 的排版 / 文档 worker)用 ES 模块 worker 并带代码分割,默认的 iife 格式不支持
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // e2e/editor-bench.mjs 按产出的 manifest 静态算「读一篇笔记要下多少 JS」;
    // 运行时统计会被空闲预取、缓存命中搅乱,manifest 的依赖图是确定的。
    manifest: true,
  },
})
