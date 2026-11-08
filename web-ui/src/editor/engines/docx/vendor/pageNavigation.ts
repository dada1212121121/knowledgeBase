/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/pageNavigation.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { PeerlessFrameGeometry } from './viewStore';

export function workerPageAtViewport(pages: PeerlessFrameGeometry['pages'], scrollTop: number, height: number, zoom: number) {
  if (!pages.length) return 1;
  const middle = (scrollTop + height / 2) / zoom;
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const index = (low + high) >> 1;
    const bounds = pages[index]!.bounds;
    if (bounds.y + bounds.height > middle) high = index; else low = index + 1;
  }
  return pages[low]!.page.pageIndex + 1;
}
