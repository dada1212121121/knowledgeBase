/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/printPages.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：剪贴板读写、图片拖拽缩放这些是与引擎命令围栏和版本校验配合的纯逻辑，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { DocxCommandFrame } from '@betteroffice/docx/yrs';
import type { DocxEditSessionBinding as PeerlessEditSessionBinding } from '../session';

export function createWorkerPrintCapture(binding: PeerlessEditSessionBinding,
  render: (bitmap: ImageBitmap) => string, isCurrent: () => boolean) {
  let version: number | undefined;
  let failure: Error | null = null;
  const images = new Map<number, string>();
  const assertCurrent = () => {
    if (!isCurrent() || binding.viewStore.getSnapshot().version !== version) throw new Error('Document changed while printing');
    if (failure) throw failure;
  };
  return {
    assertCurrent,
    accept(frame: DocxCommandFrame) {
      if (version === undefined) return;
      try {
        assertCurrent();
        for (const { page, bitmap } of frame.payload.stagedPresentation?.pages ?? []) images.set(page.pageIndex, render(bitmap));
      } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
    },
    async collect(
      buildPages: (pages: number[], frameEpoch: number) => Promise<unknown>,
      complete: (frameEpoch: number) => Promise<unknown>,
    ) {
      await binding.admission.whenCompositionSettled?.();
      await binding.session.flush();
      if (!isCurrent()) throw new Error('Document changed while printing');
      const frameEpoch = () => binding.viewStore.getSnapshot().geometry?.frameEpoch ?? 0;
      if (binding.viewStore.getSnapshot().geometry?.layoutProvisional) {
        await complete(frameEpoch());
        // The completed frame lands before the next page build answers.
        await buildPages([0], frameEpoch());
        if (!isCurrent()) throw new Error('Document changed while printing');
      }
      const snapshot = binding.viewStore.getSnapshot();
      version = snapshot.version;
      const pages = snapshot.geometry?.pages;
      if (!pages?.length || snapshot.geometry?.layoutProvisional) throw new Error('Worker print layout is unavailable');
      for (const { page } of pages) {
        assertCurrent();
        await buildPages([page.pageIndex], frameEpoch());
        assertCurrent();
        if (!images.has(page.pageIndex)) throw new Error(`Worker print pixels are unavailable for page ${page.pageIndex + 1}`);
      }
      return pages.map(({ page }) => images.get(page.pageIndex)!);
    },
  };
}

export function printBitmap(bitmap: ImageBitmap): string {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Print canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  } finally { canvas.width = 0; canvas.height = 0; }
}
