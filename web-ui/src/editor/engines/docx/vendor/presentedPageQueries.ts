/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/presentedPageQueries.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import {
  createDisplayListQueries, displayPageRevision, displayPageNoteAnchorRevision,
  loadedRustDisplayListQueryEngine, type DisplayPage, type DisplayListQueries, type RustDisplayListQueryEngine,
} from '@betteroffice/docx/layout/render';

export function createPresentedPageQueries() {
  type PageQueries = Pick<DisplayListQueries, 'hitTestRegions' | 'caretRect'>;
  let presented: DisplayPage[] = [];
  let cached: {
    revisions: number[]; anchors: number[]; engine: RustDisplayListQueryEngine;
    queries: DisplayListQueries; pages: Map<DisplayPage, PageQueries>;
  } | null = null;
  const release = () => { cached?.queries.dispose(); cached = null; };
  const get = (page: DisplayPage): PageQueries | null => {
    const engine = loadedRustDisplayListQueryEngine();
    const index = presented.indexOf(page);
    if (!engine || page.unbuilt || index < 0) return null;
    if (cached && (cached.engine !== engine || presented.some((entry, slot) =>
      cached!.revisions[slot] !== displayPageRevision(entry) || cached!.anchors[slot] !== displayPageNoteAnchorRevision(entry)))) release();
    if (!cached) cached = {
      revisions: presented.map(displayPageRevision), anchors: presented.map(displayPageNoteAnchorRevision), engine,
      queries: createDisplayListQueries({ pages: presented }, engine), pages: new Map(),
    };
    const existing = cached.pages.get(page);
    if (existing) return existing;
    const queries = cached.queries;
    const rtlRanges = page.primitives.filter((primitive) =>
      ('rtl' in primitive && primitive.rtl) || (primitive.bidiLevel !== undefined && primitive.bidiLevel % 2 === 1))
      .map((primitive) => [primitive.fragmentDocStart ?? primitive.docStart, primitive.fragmentDocEnd ?? primitive.docEnd]);
    const local: PageQueries = {
      hitTestRegions: (_pageIndex, x, y) => queries.hitTestRegions(index, x, y),
      caretRect(pos) {
        if (rtlRanges.some(([start, end]) => (start === undefined || pos >= start) && (end === undefined || pos <= end))) return null;
        if (presented.length === 1) return queries.caretRect(pos);
        const forward = queries.rangeRectsOnPages!(pos, pos + 1, index, index);
        const first = forward[0];
        if (first) return { ...first, pageIndex: 0, width: 0 };
        if (pos <= 0) return null;
        const backward = queries.rangeRectsOnPages!(pos - 1, pos, index, index);
        const last = backward[backward.length - 1];
        return last ? { ...last, pageIndex: 0, x: last.x + last.width, width: 0 } : null;
      },
    };
    cached.pages.set(page, local);
    return local;
  };
  const retain = (pages: readonly DisplayPage[]) => {
    const next = [...new Set(pages)].filter((page) => !page.unbuilt);
    if (next.length === presented.length && next.every((page, index) => page === presented[index])) return;
    release();
    presented = next;
  };
  return { get, retain, dispose: () => { release(); presented = []; } };
}
