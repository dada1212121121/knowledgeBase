/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/pagePoint.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { DisplayPage } from '@betteroffice/docx/layout/render';
import type { PeerlessFrameGeometry } from './viewStore';

type PageGeometry = PeerlessFrameGeometry['pages'][number];
type PageIndex = { bounds: PageGeometry['bounds']; page?: PageGeometry; children?: readonly [PageIndex, PageIndex] };
const indexes = new WeakMap<readonly PageGeometry[], PageIndex | null>();

function indexPages(pages: readonly PageGeometry[]): PageIndex | null {
  if (!pages.length) return null;
  if (pages.length === 1) return { bounds: pages[0]!.bounds, page: pages[0]! };
  const sorted = [...pages].sort((a, b) => a.bounds.y - b.bounds.y);
  const middle = Math.floor(sorted.length / 2);
  const left = indexPages(sorted.slice(0, middle))!;
  const right = indexPages(sorted.slice(middle))!;
  const x = Math.min(left.bounds.x, right.bounds.x);
  const y = Math.min(left.bounds.y, right.bounds.y);
  return { bounds: {
    x, y,
    width: Math.max(left.bounds.x + left.bounds.width, right.bounds.x + right.bounds.width) - x,
    height: Math.max(left.bounds.y + left.bounds.height, right.bounds.y + right.bounds.height) - y,
  }, children: [left, right] };
}

function nearestPage(index: PageIndex, x: number, y: number): PageGeometry | undefined {
  const distance = ({ bounds }: PageIndex) => Math.hypot(
    Math.max(bounds.x - x, 0, x - bounds.x - bounds.width),
    Math.max(bounds.y - y, 0, y - bounds.y - bounds.height),
  );
  let nearest: PageGeometry | undefined;
  let best = Infinity;
  const visit = (node: PageIndex) => {
    const gap = distance(node);
    if (gap >= best) return;
    if (node.page) {
      if (node.bounds.width > 0 && node.bounds.height > 0) {
        best = gap;
        nearest = node.page;
      }
      return;
    }
    const [left, right] = node.children!;
    if (distance(left) <= distance(right)) { visit(left); visit(right); }
    else { visit(right); visit(left); }
  };
  visit(index);
  return nearest;
}

export function clientPointToPage(clientX: number, clientY: number, host: Pick<DOMRectReadOnly, 'left' | 'top'>,
  zoom: number, pages: readonly PageGeometry[]) {
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  const x = (clientX - host.left) / zoom;
  const y = (clientY - host.top) / zoom;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let index = indexes.get(pages);
  if (index === undefined) { index = indexPages(pages); indexes.set(pages, index); }
  const page = index && nearestPage(index, x, y);
  return page ? { page, x: x - page.bounds.x, y: y - page.bounds.y } : null;
}

/** The body y nearest a header or footer band press, outside every header, footer and note area; null when the page is not built. */
export function bodyEdgeY(page: Pick<DisplayPage, 'contentBounds' | 'header' | 'footer' | 'noteAreas' | 'unbuilt'>, band: 'header' | 'footer') {
  const body = page.contentBounds;
  if (!body || page.unbuilt) return null;
  const blocks = [page.header, page.footer, ...(page.noteAreas ?? [])].flatMap(block =>
    block?.y !== undefined && block.height !== undefined && block.height > 0 ? [{ top: block.y, bottom: block.y + block.height }] : []);
  let y = band === 'header' ? body.y + 1 : body.y + body.height - 1;
  for (let moved = true; moved;) {
    moved = false;
    for (const block of blocks) {
      if (y < block.top || y > block.bottom) continue;
      y = band === 'header' ? block.bottom + 1 : block.top - 1;
      moved = true;
    }
  }
  return y > body.y && y < body.y + body.height ? y : null;
}
