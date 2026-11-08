/**
 * 懒加载的前端文件（流程图、公式、各种编辑器）拿不到时的识别与文案。
 *
 * 页面是旧版本：部署后构建产物的文件名都带内容哈希，旧页面还记着旧文件名，而旧文件已经不在服务器上（或被新版本替换），
 * 动态 import 就会报 "Failed to fetch dynamically imported module"。把它原样当成「流程图语法有误」显示给人，
 * 人会去检查自己的流程图，而真正要做的只是刷新页面
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk .* failed/i.test(message)
}

/** 流程图渲染失败时给人看的一句话 */
export function mermaidFailureText(error: unknown): string {
  if (isChunkLoadError(error)) return '流程图组件没能加载：这个页面是旧版本。刷新页面后就能看到（点页面顶部的「刷新」，或按 F5）'
  return `流程图语法有误:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
}
