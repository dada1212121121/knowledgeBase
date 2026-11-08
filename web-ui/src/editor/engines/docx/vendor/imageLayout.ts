/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx 0.5.1 源码 `packages/docx/src/docx/imageLayout.ts` 与 `wrapTypes.ts`（合并为一个文件）。
 * 图片版式（嵌入 / 四周型 / 紧密型 / 上下型 / 衬于文字下方 / 浮于文字上方）到引擎对象属性补丁的纯逻辑，
 * 不依赖 React 与引擎；为了在 Vue 里做「环绕」命令而原样收编（只改了 import 路径，见 NOTICE）。
 */
export type AnchorWrapType = Exclude<WrapType, 'inline'>;
export type ImageLayoutTarget = AnchorWrapType | 'squareLeft' | 'squareRight' | 'inline';

export type ImageResizeHandle = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w';

const MIN_IMAGE_PX = 20;
const MAX_IMAGE_PX = 2000;

/** Compute the preview dimensions for an image resize gesture. */
export function calculateResizedImageDimensions(
  handle: ImageResizeHandle,
  deltaX: number,
  deltaY: number,
  startWidth: number,
  startHeight: number,
  lockAspect: boolean
): { width: number; height: number } {
  const drivesWidth = handle.includes('w') || handle.includes('e');
  const drivesHeight = handle.includes('n') || handle.includes('s');
  const signX = handle.includes('w') ? -1 : 1;
  const signY = handle.includes('n') ? -1 : 1;
  let width = drivesWidth ? startWidth + deltaX * signX : startWidth;
  let height = drivesHeight ? startHeight + deltaY * signY : startHeight;
  if (drivesWidth && drivesHeight && lockAspect) {
    const scale = Math.max(width / startWidth, height / startHeight);
    width = startWidth * scale;
    height = startHeight * scale;
  }
  const clamp = (value: number) => Math.max(MIN_IMAGE_PX, Math.min(MAX_IMAGE_PX, value));
  return {
    width: drivesWidth ? clamp(width) : startWidth,
    height: drivesHeight ? clamp(height) : startHeight,
  };
}

export interface SetImageWrapTypeOptions {
  initialPositionEmu?: { horizontalEmu: number; verticalEmu: number };
}

export interface ImageLayoutPosition {
  horizontal?: { relativeTo?: string; posOffset?: number; align?: string };
  vertical?: { relativeTo?: string; posOffset?: number; align?: string };
}

export interface ImageLayoutCurrentAttrs {
  wrapType?: string | null;
  cssFloat?: string | null;
  position?: ImageLayoutPosition | null;
}

export interface ImageLayoutAttrs extends Record<string, unknown> {
  wrapType: WrapType;
  displayMode: 'inline' | 'float' | 'block';
  cssFloat: 'left' | 'right' | 'none';
  wrapText?: 'bothSides' | 'left' | 'right' | 'largest';
  position?: ImageLayoutPosition;
  distTop?: number;
  distBottom?: number;
  distLeft?: number;
  distRight?: number;
}

/** Resolve the authored image attributes for one Word-style wrap choice. */
export function resolveImageLayoutAttrs(
  target: ImageLayoutTarget,
  current: ImageLayoutCurrentAttrs,
  opts?: SetImageWrapTypeOptions
): ImageLayoutAttrs {
  const buildAnchorPosition = (): ImageLayoutPosition => {
    if (current.position?.horizontal && current.position.vertical) return current.position;
    if (opts?.initialPositionEmu) {
      return {
        horizontal: {
          relativeTo: 'column',
          posOffset: opts.initialPositionEmu.horizontalEmu,
        },
        vertical: {
          relativeTo: 'paragraph',
          posOffset: opts.initialPositionEmu.verticalEmu,
        },
      };
    }
    return {
      horizontal: { relativeTo: 'column', posOffset: 0 },
      vertical: { relativeTo: 'paragraph', posOffset: 0 },
    };
  };

  switch (target) {
    case 'inline':
      return {
        wrapType: 'inline',
        displayMode: 'inline',
        cssFloat: 'none',
        wrapText: undefined,
        position: undefined,
        distTop: undefined,
        distBottom: undefined,
        distLeft: undefined,
        distRight: undefined,
      };
    case 'squareLeft':
    case 'squareRight': {
      const cssFloat = target === 'squareLeft' ? 'left' : 'right';
      return {
        wrapType:
          current.wrapType === 'tight' || current.wrapType === 'through'
            ? current.wrapType
            : 'square',
        displayMode: 'float',
        cssFloat,
        wrapText: cssFloat === 'left' ? 'right' : 'left',
        position: {
          ...buildAnchorPosition(),
          horizontal: { relativeTo: 'margin', align: cssFloat },
        },
      };
    }
    case 'square':
    case 'tight':
    case 'through': {
      const cssFloat =
        current.cssFloat === 'left' || current.cssFloat === 'right'
          ? current.cssFloat
          : 'left';
      return {
        wrapType: target,
        displayMode: 'float',
        cssFloat,
        wrapText: cssFloat === 'left' ? 'right' : 'left',
        position: buildAnchorPosition(),
      };
    }
    case 'topAndBottom':
      return {
        wrapType: 'topAndBottom',
        displayMode: 'block',
        cssFloat: 'none',
        wrapText: 'bothSides',
        position: buildAnchorPosition(),
      };
    case 'behind':
    case 'inFront':
      return {
        wrapType: target,
        displayMode: 'float',
        cssFloat: 'none',
        wrapText: 'bothSides',
        position: buildAnchorPosition(),
      };
  }
}

/** Map current OOXML image attrs to the shared menu choice vocabulary. */
export function deriveLayoutChoice(
  wrapType: WrapType,
  cssFloat?: string | null
): ImageLayoutTarget | null {
  if (wrapType === 'inline') return 'inline';
  if (wrapType === 'behind') return 'behind';
  if (wrapType === 'inFront') return 'inFront';
  if (wrapType === 'square' || wrapType === 'tight' || wrapType === 'through') {
    return cssFloat === 'right' ? 'squareRight' : 'squareLeft';
  }
  return null;
}

export type ImageLayoutIconHint = 'inline' | 'squareLeft' | 'squareRight' | 'behind' | 'inFront';

export interface ImageLayoutOptionDef {
  choice: ImageLayoutTarget;
  i18nLabelKey: string;
  i18nDescKey: string;
  iconHint: ImageLayoutIconHint;
}

/** Word's five directional Wrap Text menu entries. */
export const IMAGE_LAYOUT_OPTIONS: readonly ImageLayoutOptionDef[] = [
  {
    choice: 'inline',
    i18nLabelKey: 'inLineWithText',
    i18nDescKey: 'inLineWithText',
    iconHint: 'inline',
  },
  {
    choice: 'squareLeft',
    i18nLabelKey: 'squareLeft',
    i18nDescKey: 'squareLeft',
    iconHint: 'squareLeft',
  },
  {
    choice: 'squareRight',
    i18nLabelKey: 'squareRight',
    i18nDescKey: 'squareRight',
    iconHint: 'squareRight',
  },
  {
    choice: 'behind',
    i18nLabelKey: 'behindText',
    i18nDescKey: 'behindText',
    iconHint: 'behind',
  },
  {
    choice: 'inFront',
    i18nLabelKey: 'inFrontOfText',
    i18nDescKey: 'inFrontOfText',
    iconHint: 'inFront',
  },
] as const;

export function isImageLayoutOptionEnabled(
  _option: ImageLayoutOptionDef,
  _currentWrapType: WrapType
): boolean {
  return true;
}

/** Map legacy toolbar wrap values onto the shared image command target. */
export function toolbarValueToLayoutTarget(value: string): ImageLayoutTarget | undefined {
  switch (value) {
    case 'inline':
      return 'inline';
    case 'square':
    case 'tight':
    case 'through':
      return 'squareLeft';
    case 'topAndBottom':
      return 'topAndBottom';
    case 'behind':
      return 'behind';
    case 'inFront':
      return 'inFront';
    case 'wrapRight':
      return 'squareLeft';
    case 'wrapLeft':
      return 'squareRight';
    default:
      return undefined;
  }
}

export type WrapType =
  | 'inline'
  | 'square'
  | 'tight'
  | 'through'
  | 'topAndBottom'
  | 'behind'
  | 'inFront';

const WRAPS_AROUND_TEXT = ['square', 'tight', 'through'] as const satisfies readonly WrapType[];
const WRAPS_NONE = ['behind', 'inFront'] as const satisfies readonly WrapType[];
const FLOATING = [...WRAPS_AROUND_TEXT, ...WRAPS_NONE];

/** True for wrap types that anchor at a position (i.e. not `inline`, not `topAndBottom`). */
export function isFloatingWrapType(wrapType: string | undefined): boolean {
  return !!wrapType && (FLOATING as readonly string[]).includes(wrapType);
}

/** True for `wp:wrapNone` variants (`behind` / `inFront`) — positioned but ignore text-flow. */
export function isWrapNone(wrapType: string | undefined): boolean {
  return wrapType === 'behind' || wrapType === 'inFront';
}

/** True for wrap types where text flows around the image (`square` / `tight` / `through`). */
export function wrapsAroundText(wrapType: string | undefined): boolean {
  return !!wrapType && (WRAPS_AROUND_TEXT as readonly string[]).includes(wrapType);
}
