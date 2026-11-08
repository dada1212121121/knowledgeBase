/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/pictureResize.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：剪贴板读写、图片拖拽缩放这些是与引擎命令围栏和版本校验配合的纯逻辑，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { PeerlessPropertyIntent } from './inputEvents';
import type { PictureDragTarget } from './pictureDrag';

export type PictureResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface PictureResize {
  target: PictureDragTarget & { noChangeAspect?: boolean };
  handle: PictureResizeHandle;
  startX: number;
  startY: number;
  rect: PictureDragTarget['rect'];
}

export function beginPictureResize(target: PictureResize['target'], handle: PictureResizeHandle, clientX: number, clientY: number): PictureResize {
  return { target, handle, startX: clientX, startY: clientY, rect: target.rect };
}

export function movePictureResize(resize: PictureResize, clientX: number, clientY: number, zoom: number, shift: boolean): PictureResize {
  if (!Number.isFinite(zoom) || zoom <= 0) return resize;
  const { handle, target: { rect, noChangeAspect } } = resize;
  const horizontal = handle.includes('w') || handle.includes('e');
  const vertical = handle.includes('n') || handle.includes('s');
  let width = horizontal ? rect.width + (clientX - resize.startX) / zoom * (handle.includes('w') ? -1 : 1) : rect.width;
  let height = vertical ? rect.height + (clientY - resize.startY) / zoom * (handle.includes('n') ? -1 : 1) : rect.height;
  if (horizontal && vertical && (noChangeAspect === true || shift)) {
    const widthScale = width / rect.width;
    const heightScale = height / rect.height;
    const dragScale = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale;
    const scale = Math.max(dragScale, 1 / rect.width, 1 / rect.height);
    width = rect.width * scale;
    height = rect.height * scale;
  } else {
    width = Math.max(1, width);
    height = Math.max(1, height);
  }
  return { ...resize, rect: {
    x: handle.includes('w') ? rect.x + rect.width - width : rect.x,
    y: handle.includes('n') ? rect.y + rect.height - height : rect.y,
    width, height,
  } };
}

export function pictureResizeIntent(resize: PictureResize): PeerlessPropertyIntent | null {
  const widthEmu = Math.round(resize.rect.width * 9525);
  const heightEmu = Math.round(resize.rect.height * 9525);
  if (widthEmu === Math.round(resize.target.rect.width * 9525) && heightEmu === Math.round(resize.target.rect.height * 9525)) return null;
  const position = resize.target.floating && (resize.rect.x !== resize.target.rect.x || resize.rect.y !== resize.target.rect.y) ? {
    hOffsetEmu: Math.round(resize.rect.x * 9525), vOffsetEmu: Math.round(resize.rect.y * 9525),
  } : {};
  return { kind: 'resizeObject', payload: { handle: resize.target.handle, expectVersion: resize.target.version, widthEmu, heightEmu, ...position } };
}
