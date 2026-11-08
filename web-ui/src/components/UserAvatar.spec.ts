// 头像的来源:库里的头像文件、游客的固定头像,都没有就画首字母。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UserAvatar from './UserAvatar.vue'

describe('UserAvatar', () => {
  it('有头像文件:画图片,地址带版本参数', () => {
    const wrapper = mount(UserAvatar, { props: { userId: 'usr_1', name: '小明', file: 'a1.png' } })
    expect(wrapper.find('img').attributes('src')).toBe('/api/v1/users/usr_1/avatar?v=a1.png')
  })

  it('指定了 src:用它,不再按 file 拼 /users/{id}/avatar(游客看分享页时那个地址是 401)', () => {
    const wrapper = mount(UserAvatar, { props: { userId: 'usr_1', name: '小明', file: 'a1.png', src: '/api/v1/share/tok/owner-avatar?v=a1.png' } })
    expect(wrapper.find('img').attributes('src')).toBe('/api/v1/share/tok/owner-avatar?v=a1.png')
  })

  it('src 是 null:退回按 file 拼的地址;file 也没有就画首字母', () => {
    expect(mount(UserAvatar, { props: { userId: 'usr_1', name: '小明', file: 'a1.png', src: null } }).find('img').attributes('src')).toBe('/api/v1/users/usr_1/avatar?v=a1.png')
    expect(mount(UserAvatar, { props: { userId: 'usr_1', name: '小明', src: null } }).find('img').exists()).toBe(false)
  })

  it('什么来源都没有:画名字的首字母', () => {
    const wrapper = mount(UserAvatar, { props: { userId: 'usr_1', name: '小明' } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('小')
  })

  it('游客标识 guest:… 自动画固定的游客头像,不请求图片,也不画首字母', () => {
    const wrapper = mount(UserAvatar, { props: { userId: 'guest:访客1234#7', name: '访客1234' } })
    expect(wrapper.find('[data-testid=avatar-guest]').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    expect(wrapper.classes()).toContain('is-guest')
  })

  it('不同游客的头像完全一样(固定头像,不随名字变色)', () => {
    const a = mount(UserAvatar, { props: { userId: 'guest:甲#1', name: '甲' } })
    const b = mount(UserAvatar, { props: { userId: 'guest:乙#2', name: '乙' } })
    expect(a.html().replace(/--avatar-hue: \d+/, '')).toBe(b.html().replace(/--avatar-hue: \d+/, ''))
  })

  it('显式 guest:没有 guest: 前缀的游客(评论里的匿名作者)也画游客头像', () => {
    const wrapper = mount(UserAvatar, { props: { userId: '匿名', name: '匿名', guest: true } })
    expect(wrapper.find('[data-testid=avatar-guest]').exists()).toBe(true)
  })

  it('游客即使带了头像文件也不取图(游客没有账号)', () => {
    const wrapper = mount(UserAvatar, { props: { userId: 'guest:x#1', name: 'x', file: 'a.png' } })
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
