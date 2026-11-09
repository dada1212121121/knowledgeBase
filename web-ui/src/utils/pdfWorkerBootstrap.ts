// PDF.js 的 worker 是独立全局环境，主线程装的 polyfill 传不进来。
// legacy worker 自带 core-js，仍会直接调用 Promise.withResolvers / Promise.try；
// 这个模块在真正的 worker 代码之前执行，负责先把这两个 API 补上。
import { installPromiseCompat } from './promiseCompat'

installPromiseCompat()

// 导出哨兵并被 pdfWorker.ts 引用，防止打包器把整个模块当纯副作用裁掉。
export const bootstrapReady = true
