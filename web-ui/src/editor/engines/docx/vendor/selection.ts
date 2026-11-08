/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/selection.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type {
  DocxNavigationIntent,
  DocxCommandSelection,
  DocxCommandPayloads,
  DocxSelectionPointIntent,
} from '@betteroffice/docx/yrs';
import type { PeerlessFrameGeometry } from './viewStore';

const pageIdentities = new WeakMap<PeerlessFrameGeometry['pages'], ReadonlyMap<string, DocxSelectionPointIntent['page']>>();

/** @internal */
export type PeerlessSelectionIntent =
  | { kind: 'select'; payload: { selection: DocxCommandSelection } }
  | { kind: 'select'; payload: { object: { handle: string; expectVersion: string } } }
  | { kind: 'navigateCell'; payload: DocxCommandPayloads['navigateCell'] }
  | { kind: 'selectTableCells'; payload: DocxCommandPayloads['selectTableCells'] }
  | { kind: 'navigate'; payload: DocxNavigationIntent }
  | { kind: 'selectPoint'; payload: DocxSelectionPointIntent }
  | { kind: 'extendSelection'; payload: DocxSelectionPointIntent };

/** @internal Gestures use installed page geometry, never echo hit-testing. */
export type PeerlessSelectionGesture =
  | { kind: 'navigation'; navigation: DocxNavigationIntent }
  | { kind: 'point' | 'drag'; point: DocxSelectionPointIntent };

/** @internal */
export function captureSelectionIntent(
  gesture: PeerlessSelectionGesture,
  geometry: PeerlessFrameGeometry | null
): PeerlessSelectionIntent {
  if (gesture.kind === 'navigation') return { kind: 'navigate', payload: { ...gesture.navigation } };
  const point = gesture.point;
  let page = point.page;
  if (geometry) {
    let identities = pageIdentities.get(geometry.pages);
    if (!identities) {
      identities = new Map<string, DocxSelectionPointIntent['page']>(geometry.pages.map(({ page }) => [page.pageId, page]));
      pageIdentities.set(geometry.pages, identities);
    }
    page = identities.get(point.page.pageId) ?? page;
  }
  return {
    kind: gesture.kind === 'drag' ? 'extendSelection' : 'selectPoint',
    payload: {
      ...point, page: { ...page }, modifiers: { ...point.modifiers },
      frameEpoch: geometry?.frameEpoch ?? point.frameEpoch,
      layoutRevision: geometry?.layoutRevision ?? point.layoutRevision,
    },
  };
}
