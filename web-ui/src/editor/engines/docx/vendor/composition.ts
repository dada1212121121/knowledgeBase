/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/composition.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type { CommandTicket } from './sessionTypes';
import type {
  PeerlessAdmissionTarget,
  PeerlessInputAdmission,
} from './inputAdmission';

/** @internal */
export interface PeerlessCompositionState {
  id: number;
  slot: number;
  target: PeerlessAdmissionTarget;
  text: string;
  phase: 'active' | 'committed' | 'cancelled' | 'refused';
  ticket?: CommandTicket;
  recoverableText?: string;
}

/** @internal */
export type PeerlessCompositionEndResult =
  | { status: 'committed'; state: PeerlessCompositionState; ticket: CommandTicket }
  | { status: 'cancelled'; state: PeerlessCompositionState };

type CompositionRecord = {
  state: PeerlessCompositionState;
  result?: PeerlessCompositionEndResult;
};

const records = new WeakMap<PeerlessCompositionState, CompositionRecord>();

function recordFor(state: PeerlessCompositionState): CompositionRecord {
  let record = records.get(state);
  if (!record) {
    record = { state };
    records.set(state, record);
  }
  return record;
}

/** @internal */
export function beginComposition(
  admission: PeerlessInputAdmission,
  id: number
): PeerlessCompositionState {
  const { slot, target } = admission.reserveComposition();
  const state: PeerlessCompositionState = { id, slot, target, text: '', phase: 'active' };
  records.set(state, { state });
  return state;
}

/** @internal */
export function updateComposition(
  state: PeerlessCompositionState,
  text: string
): PeerlessCompositionState {
  const record = recordFor(state);
  if (record.state.phase !== 'active') return record.state;
  const updated = { ...record.state, text };
  record.state = updated;
  records.set(updated, record);
  return updated;
}

/** @internal */
export function endComposition(
  admission: PeerlessInputAdmission,
  state: PeerlessCompositionState,
  text: string
): PeerlessCompositionEndResult {
  const record = recordFor(state);
  if (record.result) return record.result;
  if (record.state.phase !== 'active') {
    const settled = record.state;
    record.result = settled.ticket
      ? { status: 'committed', state: settled, ticket: settled.ticket }
      : { status: 'cancelled', state: settled };
    return record.result;
  }

  const settled: PeerlessCompositionState = { ...record.state, text, phase: 'cancelled' };
  const admissionResult = admission.settleComposition(
    settled.slot,
    text.length ? { text, target: settled.target } : null
  );
  if (admissionResult.status === 'held') {
    throw new Error('composition settlement must release its slot');
  }
  record.state = settled;
  records.set(settled, record);
  if (admissionResult.status === 'ignored') {
    if (text.length) {
      settled.phase = 'refused';
      settled.recoverableText = text;
    }
    record.result = { status: 'cancelled', state: settled };
    return record.result;
  }

  const ticket = admissionResult.ticket;
  settled.phase = 'committed';
  settled.ticket = ticket;
  record.result = { status: 'committed', state: settled, ticket };
  const retainText = () => {
    settled.phase = 'refused';
    settled.recoverableText = settled.text;
  };
  void ticket.ack.then((outcome) => {
    if (outcome.status === 'refused' || outcome.status === 'cancelled' || outcome.committed === false) {
      retainText();
    }
  }, retainText);
  return record.result;
}
