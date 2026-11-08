// 上传区:电脑 / 平板保持「选择文件 / 选择文件夹」;手机触屏出底部弹层(拍照 / 从相册选 / 选择文件),
// 三个来源的 input 属性要对(capture / accept / multiple),选完都走同一个 files 事件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import KbDropzone from './KbDropzone.vue'
import { TOUCH_PHONE_QUERY } from '../composables/useMedia'

let wrapper: VueWrapper | null = null

/** 手机触屏:只有 TOUCH_PHONE_QUERY 命中;其它查询都不命中 */
function setMedia(touchPhone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: touchPhone && query === TOUCH_PHONE_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}

function mountZone(props: Record<string, unknown> = {}) {
  wrapper = mount(KbDropzone, { props: { title: '标题', ...props }, attachTo: document.body })
  return wrapper
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)

/** 把一批文件塞进 input 并触发 change,和用户选完文件后的浏览器行为一致 */
async function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
  await Promise.resolve()
}

beforeEach(() => setMedia(false))
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('KbDropzone 电脑 / 平板', () => {
  it('保持「选择文件」「选择文件夹」两个按钮,没有来源弹层,也没有相机 / 相册 input', () => {
    const zone = mountZone()
    expect(zone.findAll('.kb-drop-actions button').map((item) => item.text())).toEqual(['选择文件', '选择文件夹'])
    expect(zone.find('[data-testid=drop-pick]').exists()).toBe(false)
    expect(zone.find('[data-testid=pick-camera]').exists()).toBe(false)
    expect(zone.find('[data-testid=pick-album]').exists()).toBe(false)
    expect(zone.find('[data-testid=pick-folder]').attributes()).toHaveProperty('webkitdirectory')
  })

  it('folder=false 不给「选择文件夹」', () => {
    const zone = mountZone({ folder: false })
    expect(zone.findAll('.kb-drop-actions button').map((item) => item.text())).toEqual(['选择文件'])
  })

  it('选完文件:files 事件带出这批文件', async () => {
    const zone = mountZone()
    const file = new File(['a'], 'a.md')
    await pick(zone.find<HTMLInputElement>('[data-testid=pick-file]').element, [file])
    expect(zone.emitted('files')?.[0]).toEqual([[file]])
  })

  it('小窗口但用鼠标(宽 <600、pointer: fine):也是电脑的两个按钮', () => {
    setMedia(false) // TOUCH_PHONE_QUERY 要求触屏,鼠标不命中
    const zone = mountZone()
    expect(zone.find('[data-testid=drop-pick]').exists()).toBe(false)
  })
})

describe('KbDropzone 手机触屏', () => {
  beforeEach(() => setMedia(true))

  it('只有一个「上传文件」按钮,没有「选择文件夹」(手机不支持 webkitdirectory)', () => {
    const zone = mountZone()
    expect(zone.findAll('.kb-drop-actions button').map((item) => item.text())).toEqual(['上传文件'])
    expect(zone.text()).not.toContain('选择文件夹')
    expect(zone.find('[data-testid=pick-folder]').exists()).toBe(false)
  })

  it('三个 input 的属性:拍照 image/* + capture=environment;相册 image/*,video/* + multiple;文件不限类型 + multiple', () => {
    const zone = mountZone()
    const camera = zone.find('[data-testid=pick-camera]')
    expect(camera.attributes('accept')).toBe('image/*')
    expect(camera.attributes('capture')).toBe('environment')
    const album = zone.find('[data-testid=pick-album]')
    expect(album.attributes('accept')).toBe('image/*,video/*')
    expect(album.attributes()).toHaveProperty('multiple')
    expect(album.attributes()).not.toHaveProperty('capture')
    const file = zone.find('[data-testid=pick-file]')
    expect(file.attributes('accept') ?? '').toBe('')
    expect(file.attributes()).toHaveProperty('multiple')
    expect(file.attributes()).not.toHaveProperty('capture')
  })

  it('点「上传文件」弹出底部弹层,三项依次是 拍照 / 从相册选 / 选择文件', async () => {
    const zone = mountZone()
    expect($('[data-testid=sheet]')).toBeNull()
    await zone.find('[data-testid=drop-pick]').trigger('click')
    expect($('[data-testid=sheet]')).not.toBeNull()
    const rows = [...document.body.querySelectorAll('[data-testid=drop-sheet] .kb-drop-opt')].map((item) => item.querySelector('b')?.textContent)
    expect(rows).toEqual(['拍照', '从相册选', '选择文件'])
  })

  it('点空白处同样先出弹层,不是直接弹系统选择器', async () => {
    const zone = mountZone()
    const click = vi.spyOn(zone.find<HTMLInputElement>('[data-testid=pick-file]').element, 'click')
    await zone.find('.kb-drop').trigger('click')
    expect($('[data-testid=sheet]')).not.toBeNull()
    expect(click).not.toHaveBeenCalled()
  })

  it.each([
    ['opt-camera', 'pick-camera'],
    ['opt-album', 'pick-album'],
    ['opt-file', 'pick-file'],
  ])('点「%s」:收起弹层并唤起对应的 input(%s),其它两个不动', async (option, inputId) => {
    const zone = mountZone()
    const clicks = Object.fromEntries(
      ['pick-camera', 'pick-album', 'pick-file'].map((id) => [id, vi.spyOn(zone.find<HTMLInputElement>(`[data-testid=${id}]`).element, 'click')]),
    )
    await zone.find('[data-testid=drop-pick]').trigger('click')
    $<HTMLButtonElement>(`[data-testid=${option}]`)!.click()
    await zone.vm.$nextTick()
    for (const [id, spy] of Object.entries(clicks)) expect(spy, id).toHaveBeenCalledTimes(id === inputId ? 1 : 0)
    expect($('[data-testid=sheet]'), '选完后弹层应收起').toBeNull()
  })

  it('三个来源选完都走同一个 files 事件;相册和文件的名字原样保留', async () => {
    const zone = mountZone()
    const photo = new File(['p'], 'IMG_0001.HEIC', { type: 'image/heic' })
    const doc = new File(['d'], '合同.pdf', { type: 'application/pdf' })
    await pick(zone.find<HTMLInputElement>('[data-testid=pick-album]').element, [photo])
    await pick(zone.find<HTMLInputElement>('[data-testid=pick-file]').element, [doc])
    expect(zone.emitted('files')).toEqual([[[photo]], [[doc]]])
  })

  it('拍照得到 iOS 的通用名 image.jpg:按拍摄时间改名,免得连拍两张撞名', async () => {
    const zone = mountZone()
    await pick(zone.find<HTMLInputElement>('[data-testid=pick-camera]').element, [new File(['x'], 'image.jpg', { type: 'image/jpeg' })])
    const sent = (zone.emitted('files')![0] as [File[]])[0][0]!
    expect(sent.name).toMatch(/^拍照-\d{8}-\d{6}\.jpg$/)
    expect(sent.type).toBe('image/jpeg')
  })

  it('给了 accept(例如只收 .zip):没有相机和相册可言,不出来源弹层,仍是普通的「选择文件」', () => {
    const zone = mountZone({ accept: '.zip', folder: false })
    expect(zone.find('[data-testid=drop-pick]').exists()).toBe(false)
    expect(zone.findAll('.kb-drop-actions button').map((item) => item.text())).toEqual(['选择文件'])
    expect(zone.find('[data-testid=pick-camera]').exists()).toBe(false)
    expect(zone.find('[data-testid=pick-file]').attributes('accept')).toBe('.zip')
  })

  it('picker=false:页面明确不要来源弹层时回到普通按钮', () => {
    const zone = mountZone({ picker: false })
    expect(zone.find('[data-testid=drop-pick]').exists()).toBe(false)
    expect(zone.findAll('.kb-drop-actions button').map((item) => item.text())).toContain('选择文件')
  })

  it('弹层开着按 Esc:只关弹层,抢在外层对话框的 Esc 监听之前接住', async () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true) // 模拟 KbDialog:更早注册的 document 捕获监听
    try {
      const zone = mountZone()
      await zone.find('[data-testid=drop-pick]').trigger('click')
      expect($('[data-testid=sheet]')).not.toBeNull()
      // 事件从 body 发出:先经过 window 的捕获阶段,再到 document 的捕获监听(外层对话框就挂在那里)
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await zone.vm.$nextTick()
      expect($('[data-testid=sheet]')).toBeNull()
      // 这一次 Esc 在 window 就被截住了,没有走到 document 上的外层监听
      expect(outer).not.toHaveBeenCalled()
      // 弹层关了以后,Esc 恢复正常交给外层
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(outer).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', outer, true)
    }
  })
})
