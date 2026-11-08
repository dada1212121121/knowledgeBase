// 添加数据 · 上传时的"目标文件夹(可不填)":不填放根目录,填了每个文件的路径带上前缀,写错的不能提交。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { KbDropzone } from '@kb-ui/index'

const requestUpload = vi.fn()
vi.mock('@/api/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/upload')>()),
  requestUpload: (...args: unknown[]) => requestUpload(...args),
}))

import { relativePathOf } from '@/api/upload'
import AddDataDialog from './AddDataDialog.vue'

let wrapper: VueWrapper | null = null
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)

async function open() {
  wrapper = mount(AddDataDialog, {
    props: { collections: ['_global', 'proj_demo'], kinds: ['upload', 'archive', 'web'], initialKind: 'upload' },
    attachTo: document.body,
  })
  await flushPromises()
  const file = new File(['内容'], 'a.md', { type: 'text/markdown' })
  wrapper.findComponent(KbDropzone).vm.$emit('files', [file])
  await flushPromises()
}
const submit = async () => {
  ;[...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('开始解析'))!.click()
  await flushPromises()
}
const typeFolder = async (value: string) => {
  const input = $<HTMLInputElement>('[data-testid=add-folder] input, input[data-testid=add-folder]')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  requestUpload.mockReset()
})

describe('添加数据 · 目标文件夹', () => {
  it('不填:放在集合根目录,文件路径不变', async () => {
    await open()
    await submit()
    const [files, options] = requestUpload.mock.calls[0] as [File[], { collection: string }]
    expect(files.map(relativePathOf)).toEqual(['a.md'])
    expect(options.collection).toBe('_global')
  })

  it('填了:文件放进这个文件夹(规整掉多余的斜杠),并提示会放到哪里', async () => {
    await open()
    await typeFolder(' /手册//2026/ ')
    expect(document.body.textContent).toContain('文件会放进 手册/2026/')
    await submit()
    const [files] = requestUpload.mock.calls[0] as [File[]]
    expect(files.map(relativePathOf)).toEqual(['手册/2026/a.md'])
  })

  it('写成 ../ 这种会跳出集合的:标出原因,「开始解析」不可点,不会发起上传', async () => {
    await open()
    await typeFolder('a/../../b')
    expect($('[data-testid=add-folder-error]')!.textContent).toContain('..')
    const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.includes('开始解析'))!
    expect(button.disabled).toBe(true)
    button.click()
    await flushPromises()
    expect(requestUpload).not.toHaveBeenCalled()
  })

  it('只有上传 / 压缩包有这一项,网页来源没有', async () => {
    await open()
    expect($('[data-testid=add-folder]')).not.toBeNull()
    ;[...document.body.querySelectorAll<HTMLButtonElement>('button.stype')].find((entry) => entry.textContent?.includes('网页'))!.click()
    await flushPromises()
    expect($('[data-testid=add-folder]')).toBeNull()
  })
})
