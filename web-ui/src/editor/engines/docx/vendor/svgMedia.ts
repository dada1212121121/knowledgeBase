/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/svgMedia.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
/** Longest edge of one decoded picture, in pixels. */
const MAX_EDGE = 4096;
/** Pixels all decoded pictures of one document may hold together. */
const MAX_PIXELS = 48 * 1024 * 1024;

export interface DecodedSvgMedia {
  source: string;
  image: ImageBitmap;
}

export interface SvgMediaDecode {
  /** The pictures decoded since the last call, now owned by the caller. */
  take(): DecodedSvgMedia[];
  /** Transfers pending pictures immediately, throttled, and once more when decoding finishes. */
  flushTo(receive: (batch: DecodedSvgMedia[]) => void, intervalMs?: number): void;
  /** Settles once every picture is decoded or left out. */
  done: Promise<void>;
  /** Closes the pictures nobody took and drops the ones still decoding. */
  close(): void;
}

/**
 * Rasterizes SVG pictures for the document worker, which has no SVG decoder,
 * in document order: at twice their size times the device pixel ratio, within
 * per-picture and per-document pixel caps. A picture that fails to decode is
 * left out.
 */
export function decodeSvgMedia(
  media: readonly { source: string; url: string }[] | undefined,
  pixelRatio = globalThis.devicePixelRatio || 1,
): SvgMediaDecode {
  const decoded: DecodedSvgMedia[] = [];
  let closed = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receive: ((batch: DecodedSvgMedia[]) => void) | undefined;
  let intervalMs = 250;
  let lastFlush = -Infinity;
  const take = () => decoded.splice(0);
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!closed && decoded.length && receive) {
      lastFlush = Date.now();
      receive(take());
    }
  };
  const scheduleFlush = () => {
    if (closed || !decoded.length || !receive) return;
    const remaining = intervalMs - (Date.now() - lastFlush);
    if (finished || remaining <= 0) flush();
    else if (timer === undefined) timer = setTimeout(flush, remaining);
  };
  const flushTo = (callback: (batch: DecodedSvgMedia[]) => void, interval = 250) => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    receive = callback;
    intervalMs = interval;
    scheduleFlush();
  };
  const close = () => {
    closed = true;
    clearTimeout(timer);
    receive = undefined;
    for (const { image } of take()) image.close();
  };
  const done = (async () => {
    if (!media?.length || typeof Image === 'undefined' || typeof createImageBitmap !== 'function') return;
    let budget = MAX_PIXELS;
    for (let index = 0; index < media.length; index++) {
      if (index > 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (closed) break;
      const { source, url } = media[index]!;
      try {
        const picture = new Image();
        picture.src = url;
        await picture.decode();
        if (closed) break;
        const { naturalWidth: width, naturalHeight: height } = picture;
        if (width <= 0 || height <= 0) continue;
        const scale = Math.min(2 * Math.max(1, pixelRatio), MAX_EDGE / Math.max(width, height), Math.sqrt(budget / (width * height)));
        const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
        if (target.width * target.height > budget) continue;
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.drawImage(picture, 0, 0, target.width, target.height);
        const image = await createImageBitmap(canvas);
        if (closed) {
          image.close();
          break;
        }
        decoded.push({ source, image });
        budget -= target.width * target.height;
        scheduleFlush();
      } catch {
        // A picture the host cannot rasterize stays undecoded.
      }
    }
  })().then(() => {
    finished = true;
    clearTimeout(timer);
    flush();
  });
  return { take, flushTo, done, close };
}
