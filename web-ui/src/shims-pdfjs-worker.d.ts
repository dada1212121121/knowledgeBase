// PDF.js 只为主库提供了类型声明，worker 入口没有 .d.ts。
// 这里只是 side-effect 注册消息处理器，不需要导出类型。
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
