/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/frameDeltas.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import { decodeFrameDelta, type DecodedFrameDelta } from '@betteroffice/docx/layout/render';
import type { DocxCommandFrame } from '@betteroffice/docx/worker';

interface FrameDecodeCache {
  readonly revision: number;
  readonly buffers: readonly ArrayBuffer[];
  readonly byteLengths: readonly number[];
  readonly deltas: Map<ArrayBuffer, DecodedFrameDelta>;
}

const decodedFrames = new WeakMap<DocxCommandFrame, FrameDecodeCache>();

export function decodeCommandFrameDeltas(
  frame: DocxCommandFrame,
  skipEmpty = false
): readonly DecodedFrameDelta[] {
  const buffers = [...(frame.payload.pageFrames ?? []), frame.payload.frame];
  const previous = decodedFrames.get(frame);
  const cache: FrameDecodeCache = previous && previous.revision === frame.revision &&
    previous.buffers.length === buffers.length && buffers.every((bytes, index) =>
      bytes === previous.buffers[index] && bytes.byteLength === previous.byteLengths[index])
    ? previous
    : { revision: frame.revision, buffers, byteLengths: buffers.map((bytes) => bytes.byteLength), deltas: new Map() };
  if (cache !== previous) decodedFrames.set(frame, cache);
  return buffers.filter((bytes) => !skipEmpty || bytes.byteLength > 0).map((bytes) => {
    let delta = cache.deltas.get(bytes);
    if (!delta) {
      delta = decodeFrameDelta(bytes);
      cache.deltas.set(bytes, delta);
    }
    return delta;
  });
}
