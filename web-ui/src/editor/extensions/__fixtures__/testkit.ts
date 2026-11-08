/**
 * 扩展测试的公共夹具
 *
 * `manifestFor` 造出规范化清单（等价于 `parseManifest` 的输出）；`fakeBinding` 是一个脱离 Host 的
 * 假编辑器：有正文、选区、只读开关，并记录收到的命令，足够驱动文档 API 的所有路径。
 */
import { EDITOR_API_VERSION, type ExtensionManifest, type ManifestContributes, type Permission } from '../api'
import type { HostBinding } from '../registry'
import type { CommandResult, EditorCommand } from '../../types'

export interface ManifestInit {
  id?: string
  name?: string
  version?: string
  permissions?: Permission[]
  contributes?: Partial<ManifestContributes>
}

export function manifestFor(init: ManifestInit = {}): ExtensionManifest {
  const id = init.id ?? 'kb.test'
  return {
    id,
    name: init.name ?? '测试扩展',
    version: init.version ?? '1.0.0',
    apiVersion: EDITOR_API_VERSION,
    entry: 'index.js',
    permissions: init.permissions ?? [],
    contributes: { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [], ...init.contributes },
  }
}

export interface FakeBinding extends HostBinding {
  text: string
  selection: string
  readonly executed: EditorCommand[]
  setReadonly(value: boolean): void
  /** 下一次 execute 返回的结果（缺省 ok） */
  nextResult?: CommandResult
}

export function fakeBinding(init: { text?: string; selection?: string; readonly?: boolean; kind?: HostBinding['kind']; format?: string } = {}): FakeBinding {
  let readonly = init.readonly ?? false
  const binding: FakeBinding = {
    kind: init.kind ?? 'text',
    format: init.format ?? 'md',
    text: init.text ?? '',
    selection: init.selection ?? '',
    executed: [],
    isReadonly: () => readonly,
    setReadonly(value) {
      readonly = value
    },
    readText: async () => binding.text,
    selectionText: () => binding.selection,
    execute: async (command) => {
      binding.executed.push(command)
      return binding.nextResult ?? { ok: true }
    },
  }
  return binding
}

/** 等所有已排队的微任务跑完。 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}
