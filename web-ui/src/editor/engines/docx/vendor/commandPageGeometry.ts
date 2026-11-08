/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/commandPageGeometry.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import { CANVAS_PAGE_GAP_PX, type RetainedFrame } from '@betteroffice/docx/layout/render';
import type { DocxCommandFramePayload } from '@betteroffice/docx/worker';
import type { PeerlessFrameGeometry } from './viewStore';

export function commandPageGeometry(
  frame: RetainedFrame,
  payload: Pick<DocxCommandFramePayload, 'finalizedPages' | 'documentWidth'>
): PeerlessFrameGeometry['pages'] {
  const certified = payload.finalizedPages === undefined
    ? frame.pages : frame.pages.slice(0, payload.finalizedPages);
  const width = Math.max(payload.documentWidth ?? 0,
    ...certified.map(({ page }) => page.width));
  let y = 0;
  return certified.map(({ pageId, pageIndex, page }) => {
    const top = y;
    const left = (width - page.width) / 2;
    y += page.height + CANVAS_PAGE_GAP_PX;
    return {
      page: { pageId: pageId.toString(), pageIndex },
      bounds: { x: left, y: top, width: page.width, height: page.height },
      transform: [1, 0, 0, 1, left, top],
      displayPage: page,
    };
  });
}
