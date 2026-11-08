// 「选来源」弹层:选项按传入的顺序渲染、点哪项就 emit 哪项、关闭的几种方式,以及 Esc 抢在外层对话框之前。
// 这个组件只负责「问」,不碰 input 也不碰上传;唤起系统选择器的行为由调用方(KbDropzone / DocEditor)各自的单测验证。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import KbSourceSheet, { type SourceOption } from './KbSourceSheet.vue'

let wrapper: VueWrapper | null = null

const THREE: SourceOption[] = [
  { id: 'camera', title: '拍照', hint: '用相机拍一张' },
  { id: 'album', title: '从相册选', hint: '可以多选' },
  { id: 'file', title: '选择文件', hint: '文档、压缩包' },
]

function mountSheet(options: SourceOption[] = THREE) {
  wrapper = mount(KbSourceSheet, { props: { title: '上传图片', options }, attachTo: document.body })
  return wrapper
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const rows = () => [...document.body.querySelectorAll('[data-testid=drop-sheet] .kb-drop-opt')]

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('KbSourceSheet', () => {
  it('弹层标题取自 title;选项按传入顺序渲染,每项有标题和说明', () => {
    mountSheet()
    expect($('[data-testid=sheet] .kb-sheet-title')?.textContent).toBe('上传图片')
    expect(rows().map((row) => row.querySelector('b')?.textContent)).toEqual(['拍照', '从相册选', '选择文件'])
    expect(rows().map((row) => row.querySelector('.m')?.textContent)).toEqual(['用相机拍一张', '可以多选', '文档、压缩包'])
  })

  it('只传两项(编辑器插图:没有「选择文件」)时就只有两行', () => {
    mountSheet(THREE.slice(0, 2))
    expect(rows().map((row) => row.querySelector('b')?.textContent)).toEqual(['拍照', '从相册选'])
    expect($('[data-testid=opt-file]')).toBeNull()
  })

  it.each(['camera', 'album', 'file'] as const)('点「%s」:只 emit 这一项的 id,不自己关(收不收弹层由调用方决定)', (id) => {
    const sheet = mountSheet()
    $<HTMLButtonElement>(`[data-testid=opt-${id}]`)!.click()
    expect(sheet.emitted('choose')).toEqual([[id]])
    expect(sheet.emitted('close')).toBeUndefined()
    expect($('[data-testid=sheet]')).not.toBeNull()
  })

  it('每项都是带图标的按钮,有可读的文字(不是只靠图标)', () => {
    mountSheet()
    for (const row of rows()) {
      expect(row.tagName).toBe('BUTTON')
      expect(row.querySelector('svg')).not.toBeNull()
      expect(row.textContent?.trim().length).toBeGreaterThan(2)
    }
  })

  it('点右上角关闭 / 点遮罩:emit close', () => {
    const sheet = mountSheet()
    $<HTMLButtonElement>('[aria-label=关闭]')!.click()
    $<HTMLElement>('.kb-sheet-scrim')!.click()
    expect(sheet.emitted('close')).toHaveLength(2)
  })

  it('Esc:emit close,并且抢在 document 捕获阶段更早注册的外层监听(模拟对话框)之前接住', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true)
    try {
      const sheet = mountSheet()
      const press = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      document.body.dispatchEvent(press)
      expect(sheet.emitted('close')).toHaveLength(1)
      expect(press.defaultPrevented).toBe(true)
      expect(outer).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outer, true)
    }
  })

  it('不是 Esc 的键不拦', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true)
    try {
      const sheet = mountSheet()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(sheet.emitted('close')).toBeUndefined()
      expect(outer).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', outer, true)
    }
  })

  it('卸载以后 Esc 不再被它接住(监听要撤掉,不然页面上永远有人吞 Esc)', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true)
    try {
      mountSheet()
      wrapper!.unmount()
      wrapper = null
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(outer).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', outer, true)
    }
  })
})
