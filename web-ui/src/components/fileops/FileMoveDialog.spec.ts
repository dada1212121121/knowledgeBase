// 移动弹窗:目标知识库 + 该库已有目录的下拉选项,不靠用户猜路径;新建目录时才展开输入。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { FileActions } from './types'
import FileMoveDialog from './FileMoveDialog.vue'

vi.mock('@/api/client', () => ({
  callCapability: vi.fn().mockResolvedValue({ kinds: [], dirs: ['target-dir'] }),
}))

const actions = (path: string, folder = false): FileActions => ({
  collection: '_global',
  path,
  origin: 'upload',
  managed: true,
  folder,
  files: 1,
  fingerprint: { value: 'fp', files: 1 },
  delete: { allowed: true, reason: '' },
  move: { allowed: true, reason: '' },
})

function mountDialog(path = 'e2e-docs/a.md', folder = false, dirs = ['archive', 'archive/2026', 'docs', 'docs/sub', 'docs2'], collections: string[] = []) {
  return mount(FileMoveDialog, {
    props: { actions: actions(path, folder), dirs, collections, busy: false, error: '', result: null },
    attachTo: document.body,
  })
}

enableAutoUnmount(afterEach)

const options = (wrapper: ReturnType<typeof mountDialog>) =>
  (wrapper.findComponent({ name: 'KbSelect' }).props('options') as { value: string; label: string }[])
const byTestId = (id: string) => document.querySelector(`[data-testid=${id}]`) as HTMLElement | null

describe('FileMoveDialog', () => {
  it('下拉里是当前知识库的目录:根目录 / 已有目录 / 新建目录', () => {
    const wrapper = mountDialog()
    expect(options(wrapper).map((entry) => entry.value)).toEqual(['', 'archive', 'archive/2026', 'docs', 'docs/sub', 'docs2', '__kb_new_dir__'])
    expect(options(wrapper).map((entry) => entry.label)).toContain('知识库根目录')
  })

  it('移动文件夹时,不把文件夹自己和它的子目录列进目标', () => {
    const wrapper = mountDialog('docs', true)
    expect(options(wrapper).map((entry) => entry.value)).toEqual(['', 'archive', 'archive/2026', 'docs2', '__kb_new_dir__'])
  })

  it('选中已有目录后确认,提交目录和新名字', async () => {
    const wrapper = mountDialog()
    wrapper.findComponent({ name: 'KbSelect' }).vm.$emit('update:modelValue', 'archive/2026')
    await nextTick()
    byTestId('file-move-confirm')!.click()
    await nextTick()
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['_global', 'archive/2026', ''])
  })

  it('选「新建目录」才出现输入框;空路径不提交', async () => {
    const wrapper = mountDialog()
    expect(byTestId('file-move-new-dir')).toBeNull()
    wrapper.findComponent({ name: 'KbSelect' }).vm.$emit('update:modelValue', '__kb_new_dir__')
    await nextTick()
    expect(byTestId('file-move-new-dir')).not.toBeNull()
    byTestId('file-move-confirm')!.click()
    await nextTick()
    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(byTestId('file-move-dialog')!.textContent).toContain('请选择已有目录')
    const input = byTestId('file-move-new-dir') as HTMLInputElement
    input.value = 'moved/2026'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    byTestId('file-move-confirm')!.click()
    await nextTick()
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['_global', 'moved/2026', ''])
  })

  it('有多个知识库时可选目标库,切换后按目标库目录提交', async () => {
    const wrapper = mountDialog('e2e-docs/a.md', false, ['archive'], ['_global', 'proj_other'])
    expect(byTestId('file-move-collection')).not.toBeNull()
    const selects = wrapper.findAllComponents({ name: 'KbSelect' })
    selects[0]!.vm.$emit('update:modelValue', 'proj_other')
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    // 目录列表由 item_facets 拉取;测试里固定返回 target-dir
    selects[1]!.vm.$emit('update:modelValue', '')
    await nextTick()
    byTestId('file-move-confirm')!.click()
    await nextTick()
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['proj_other', '', ''])
  })
})
