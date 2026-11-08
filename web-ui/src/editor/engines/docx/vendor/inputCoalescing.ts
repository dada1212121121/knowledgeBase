/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/inputCoalescing.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { CommandDraft } from './sessionTypes';
import type { DocxCommandPayload } from '@betteroffice/docx/worker';
import type { PeerlessEchoIntent } from './echoPainter';

/** @internal Merging preserves original-intent counts and requires identical predecessors. */
export type PeerlessCommandDraft = CommandDraft<DocxCommandPayload, PeerlessEchoIntent>;

const UNDO_CAPTURE_GAP_MS = 500;

/** @internal Undefined retains both drafts through the existing shared outbox hook. */
export function coalesceInputDrafts(
  _previous: PeerlessCommandDraft,
  _next: PeerlessCommandDraft
): PeerlessCommandDraft | undefined {
  const a = _previous.options;
  const b = _next.options;
  if (_previous.kind !== 'insertText' || _next.kind !== 'insertText' ||
    a.fence || b.fence || a.coalesceKey === undefined || a.coalesceKey !== b.coalesceKey ||
    a.after !== b.after || a.group !== b.group || (a.lane ?? 'input') !== (b.lane ?? 'input') ||
    (a.expectVersion ?? false) !== (b.expectVersion ?? false)) return undefined;
  const previousInput = a.lastInputTime ?? a.inputTime;
  if (previousInput !== undefined && b.inputTime !== undefined && b.inputTime - previousInput >= UNDO_CAPTURE_GAP_MS) return undefined;
  const previous = _previous.payload;
  const next = _next.payload;
  if (!('text' in previous) || !('text' in next) || 'selection' in previous || 'selection' in next ||
    'suggesting' in previous || 'suggesting' in next) return undefined;
  if (!!a.echo !== !!b.echo || (a.echo && b.echo &&
    (a.echo.contextFrameEpoch !== b.echo.contextFrameEpoch ||
      a.echo.intent.kind !== 'insertText' || b.echo.intent.kind !== 'insertText'))) return undefined;
  const payload = { text: previous.text + next.text };
  const lastInputTime = b.lastInputTime ?? b.inputTime;
  return {
    kind: 'insertText', payload,
    options: {
      ...a,
      ...(lastInputTime !== undefined ? { lastInputTime } : {}),
      echo: a.echo && b.echo ? {
        intent: { kind: 'insertText', payload },
        originalIntentCount: a.echo.originalIntentCount + b.echo.originalIntentCount,
        contextFrameEpoch: a.echo.contextFrameEpoch,
      } : undefined,
    },
  };
}

/** @internal Typing waits behind an in-flight insertText so the rest of a burst lands as one command. */
export function holdInputForCoalescing(draft: PeerlessCommandDraft): boolean {
  return draft.kind === 'insertText' && draft.options.coalesceKey !== undefined && !draft.options.fence;
}
