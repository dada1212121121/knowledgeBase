// 自定义 worker 入口：bootstrap 先装 polyfill，再执行 PDF.js 的 legacy worker。
// 不能改成先 import worker 再调用 polyfill：ES 模块会先求值所有静态依赖，
// worker 代码会在本模块正文之前跑起来。
import { bootstrapReady } from './pdfWorkerBootstrap'
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'

void bootstrapReady
