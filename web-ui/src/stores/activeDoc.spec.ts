// 当前文档登记板：编辑器命令桥只认最后登记的那一份，撤销时不能把后来者清掉（UI-5）。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useActiveDocStore, type EditorPaletteBridge } from './activeDoc'

const bridge = (label: string): EditorPaletteBridge => ({ commands: () => [{ id: label, label }], run: () => {} })

beforeEach(() => setActivePinia(createPinia()))

describe('activeDoc.registerEditor', () => {
  it('登记后外壳能拿到命令；撤销自己那份就清空', () => {
    const store = useActiveDocStore()
    const off = store.registerEditor(bridge('a'))
    expect(store.editor?.commands().map((command) => command.id)).toEqual(['a'])
    off()
    expect(store.editor).toBeNull()
  })

  it('旧文档卸载晚于新文档登记时，撤销旧桥不能清掉新桥', () => {
    const store = useActiveDocStore()
    const offOld = store.registerEditor(bridge('old'))
    const offNew = store.registerEditor(bridge('new'))
    offOld()
    expect(store.editor?.commands().map((command) => command.id)).toEqual(['new'])
    offNew()
    expect(store.editor).toBeNull()
  })
})
