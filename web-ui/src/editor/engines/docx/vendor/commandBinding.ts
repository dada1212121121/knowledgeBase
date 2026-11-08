/**
 * 来源：BetterOffice（Apache-2.0）@betteroffice/docx-react 0.5.1 源码 `packages/docx-react/src/components/DocxEditor/peerless/commandBinding.ts`，
 * 为在 Vue 里复用上游「Worker 编辑会话 + 画布帧 + 回显 + 输入准入」这一层而原样收编（只改了 import 路径）。
 * 为什么收编而不是重写：这一层是输入法组合、回显画笔与引擎命令围栏相互配合的状态机，行为正确性来自上游的长期验证；
 * 上游把它放在 React 组件包里、没有作为框架无关包导出，所以只能放进 engines/（唯一允许 import @betteroffice/* 的目录）。
 * 许可与署名见仓库 NOTICE。升级 @betteroffice/docx* 时对照上游同名文件。
 */
import type {
  PeerlessAdmissionOptions,
  PeerlessAdmissionResult,
  PeerlessFormattingIntent,
  PeerlessInputAdmission,
} from './inputAdmission';
import type { PeerlessInputIntent } from './inputEvents';
import { admitIntent, submitFormattingIntent } from './inputAdmission';

/** @internal Toolbar and keyboard entry points share the admission tail. */
export interface PeerlessCommandBinding {
  submit(intent: PeerlessInputIntent, options?: PeerlessAdmissionOptions): PeerlessAdmissionResult;
  format(intent: PeerlessFormattingIntent, options?: PeerlessAdmissionOptions): PeerlessAdmissionResult;
}

/** @internal */
export function createPeerlessCommandBinding(_admission: PeerlessInputAdmission): PeerlessCommandBinding {
  return {
    submit: (intent, options) => admitIntent(_admission, intent, options),
    format: (intent, options) => submitFormattingIntent(_admission, intent, options),
  };
}
