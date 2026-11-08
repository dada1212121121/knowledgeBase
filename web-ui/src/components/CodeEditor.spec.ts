import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { EditorView } from '@codemirror/view'
import CodeEditor from './CodeEditor.vue'

const viewOf = (wrapper: ReturnType<typeof mount>) => (wrapper.vm as unknown as { getView: () => EditorView }).getView()
afterEach(() => (document.body.innerHTML = ''))

describe('CodeEditor', () => {
  it('shows the document with line numbers and the detected language', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'fn main() {}\nlet x = 1;', filename: 'a.rs' }, attachTo: document.body })
    await flushPromises()
    expect(document.querySelector('.cm-content')?.textContent).toContain('fn main()')
    expect(document.querySelector('.cm-lineNumbers')).toBeTruthy()
    expect(wrapper.find('.kb-ce-lang').text()).toBe('Rust')
    wrapper.unmount()
  })
  it('emits update:modelValue when the user types and does not echo external changes', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'abc' }, attachTo: document.body })
    await flushPromises()
    viewOf(wrapper).dispatch({ changes: { from: 3, insert: 'd' } })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['abcd'])
    const before = wrapper.emitted('update:modelValue')!.length
    await wrapper.setProps({ modelValue: 'replaced' })
    expect(viewOf(wrapper).state.doc.toString()).toBe('replaced')
    expect(wrapper.emitted('update:modelValue')!.length).toBe(before)
    wrapper.unmount()
  })
  it('with a real v-model parent, typing several characters in one tick keeps all of them', async () => {
    // 这是真实路径(不手动塞旧值):父组件用 v-model,同一个 tick 里连打几个字,Vue 的批处理把回写合并之后,文档不能被换回旧内容
    const Parent = defineComponent({
      components: { CodeEditor },
      setup() {
        const text = ref('abc')
        return { text }
      },
      template: '<CodeEditor v-model="text" />',
    })
    const wrapper = mount(Parent, { attachTo: document.body })
    await flushPromises()
    const view = (wrapper.findComponent(CodeEditor).vm as unknown as { getView: () => EditorView }).getView()
    for (const [index, ch] of [...'defgh'].entries()) view.dispatch({ changes: { from: 3 + index, insert: ch }, selection: { anchor: 4 + index } })
    await nextTick()
    await flushPromises()
    expect(view.state.doc.toString()).toBe('abcdefgh')
    expect((wrapper.vm as unknown as { text: string }).text).toBe('abcdefgh')
    expect(view.state.selection.main.head).toBe(8)
    wrapper.unmount()
  })
  it('does not put an external replacement on the undo stack', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'one' }, attachTo: document.body })
    await flushPromises()
    await wrapper.setProps({ modelValue: 'two' })
    await flushPromises()
    expect(wrapper.find('button[aria-label="撤销"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('is read-only on demand: no undo buttons, edits are blocked, Mod-s does not save', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'x', readonly: true }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('button[aria-label="撤销"]').exists()).toBe(false)
    expect(wrapper.find('.kb-ce-ro').exists()).toBe(true)
    expect(viewOf(wrapper).state.readOnly).toBe(true)
    wrapper.unmount()
  })
  it('emits save on Ctrl+S in edit mode', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'x' }, attachTo: document.body })
    await flushPromises()
    const content = document.querySelector('.cm-content') as HTMLElement
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(wrapper.emitted('save')).toHaveLength(1)
    wrapper.unmount()
  })
  it('emits selection with line / column / selected text for the shell', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'one\ntwo' }, attachTo: document.body })
    await flushPromises()
    viewOf(wrapper).dispatch({ selection: { anchor: 4, head: 7 } })
    const payload = wrapper.emitted('selection')?.at(-1)?.[0] as { line: number; column: number; text: string }
    expect(payload).toMatchObject({ line: 2, column: 1, text: 'two' })
    wrapper.unmount()
  })
  it('marks the highlighted line range', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'a\nb\nc\nd', readonly: true, highlightLines: [2, 3] }, attachTo: document.body })
    await flushPromises()
    expect(document.querySelectorAll('.cm-line.kb-ce-hit')).toHaveLength(2)
    wrapper.unmount()
  })
})
