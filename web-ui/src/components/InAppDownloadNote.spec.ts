// 微信 / QQ 内置浏览器里下载按钮旁的提示:只在内置浏览器里出现;说清楚怎么办;「复制链接」复制的是当前页地址。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import InAppDownloadNote from './InAppDownloadNote.vue'

const WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.40'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'

function withUserAgent(value: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(value)
}
afterEach(() => vi.restoreAllMocks())

describe('InAppDownloadNote', () => {
  it('微信里:写明怎么办,并有「复制链接」', () => {
    withUserAgent(WECHAT)
    const wrapper = mount(InAppDownloadNote)
    const note = wrapper.get('[data-testid=inapp-download]')
    expect(note.attributes('role')).toBe('note')
    expect(note.text()).toContain('在微信里不能直接下载文件')
    expect(note.text()).toContain('点右上角「⋯」→「在浏览器中打开」,即可下载')
    expect(wrapper.get('button').text()).toContain('复制链接')
  })

  it('普通浏览器里什么都不渲染', () => {
    withUserAgent(SAFARI)
    const wrapper = mount(InAppDownloadNote)
    expect(wrapper.find('[data-testid=inapp-download]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('点「复制链接」复制当前页面的地址(不是文件直链:没登录 / 没带链接 cookie 的浏览器打不开直链)', async () => {
    withUserAgent(WECHAT)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mount(InAppDownloadNote)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(window.location.href)
  })
})
