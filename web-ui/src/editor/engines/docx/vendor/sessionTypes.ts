/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/../../../../shared/office-session/commands/types.ts（裁剪）`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
export type CommandOutcome = {
  seq: number;
  status: 'applied' | 'noop' | 'refused' | 'cancelled' | 'duplicate';
  reason?: string;
  committed?: false;
  affectedSeqs?: number[];
};


/** @internal Full or incremental frame identified by command coverage and revision. */
export type FrameEnvelope<F> = {
  coversThroughSeq: number;
  revision: number;
  baseRevision?: number;
  payload: F;
};

/** @internal Local outcome; unsent cancellations have no sequence. */
export type TicketOutcome = Omit<CommandOutcome, 'seq'> & { seq?: number };

/** @internal Non-rejecting presentation settlement for tickets and coverage waiters. */
export type PresentationStatus = 'presented' | 'dropped';

/** @internal Immediate local identity with a live send-time sequence getter. */
export type CommandTicket = {
  readonly id: number;
  readonly seq: number | undefined;
  readonly ack: Promise<TicketOutcome>;
  readonly presented: Promise<PresentationStatus>;
};

/** @internal Main-side command lane, distinct from resident scheduler lanes. */
export type CommandLane = 'input' | 'collab' | 'background';

/** @internal Submission metadata, causal ticket dependency, and optional local echo. */
export type SubmitOptions<X> = {
  lane?: CommandLane;
  after?: CommandTicket;
  expectVersion?: boolean;
  inputTime?: number;
  lastInputTime?: number;
  group?: string;
  coalesceKey?: string;
  fence?: boolean;
  echo?: X;
};

/** @internal Unsent command accepted by the outbox and coalescing hook. */
export type CommandDraft<P, X> = {
  kind: string;
  payload: P;
  options: SubmitOptions<X>;
};

/** @internal Format-owned echo associated with a local ticket and optional sent sequence. */
export type EchoEntry<X> = {
  ticket: CommandTicket;
  seq?: number;
  value: X;
};

/** @internal Synchronous painters; present installs, retires, and redraws atomically. */
export type EchoHooks<X, F> = {
  paint(pending: readonly EchoEntry<X>[]): void;
  drop(entries: readonly EchoEntry<X>[], reason: string): void;
  present(
    frame: FrameEnvelope<F>,
    retired: readonly EchoEntry<X>[],
    remaining: readonly EchoEntry<X>[]
  ): void | boolean;
};

/** @internal Painter timing within one synchronous submit, acknowledgement, or frame event. */
export type EchoOverrunSample = {
  hook: keyof EchoHooks<unknown, unknown>;
  elapsedMs: number;
  eventTotalMs: number;
};

/** @internal Latest confirmed worker state and installed frame coverage. */
export type EditSessionState<S, E> = {
  epoch: number;
  version: number;
  throughSeq: number;
  presentedThroughSeq: number;
  selection: S | undefined;
  editState: E | undefined;
};
