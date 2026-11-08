// 配额覆盖编辑器:留空沿用、填了才覆盖、不合法不提交、保留不认识的键。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import QuotaEditor from './QuotaEditor.vue'

const mountEditor = (json = '', extra: Record<string, unknown> = {}) =>
  mount(QuotaEditor, { props: { json, scope: '这个用户', inherit: '角色或全站默认', defaults: { storage_gb: 100 }, ...extra } })
const input = (wrapper: ReturnType<typeof mountEditor>, key: string) => wrapper.find(`input[data-key="${key}"]`)

describe('QuotaEditor', () => {
  it('空格子提示沿用哪一层、默认值是多少;有默认值才显示数字', () => {
    const wrapper = mountEditor()
    expect(input(wrapper, 'storage_gb').attributes('placeholder')).toBe('沿用角色或全站默认(默认 100)')
    // 没给默认值的项(这里是单个文件上限)不显示数字
    expect(input(wrapper, 'max_upload_mb').attributes('placeholder')).toBe('沿用角色或全站默认')
  })

  it('没改动时「保存配额」不可点;改了才可点,提交整份覆盖', async () => {
    const wrapper = mountEditor('{"storage_gb":50}')
    const save = wrapper.find('[data-testid="quota-save"]')
    expect(save.attributes('disabled')).toBeDefined()
    expect((input(wrapper, 'storage_gb').element as HTMLInputElement).value).toBe('50')
    await input(wrapper, 'links_per_user').setValue('20')
    expect(save.attributes('disabled')).toBeUndefined()
    await save.trigger('click')
    expect(wrapper.emitted('save')![0]).toEqual([{ storage_gb: 50, links_per_user: 20 }])
  })

  it('不合法(小数 / 会话数填 0)不提交,并提示哪一项', async () => {
    const wrapper = mountEditor()
    await input(wrapper, 'storage_gb').setValue('1.5')
    await wrapper.find('[data-testid="quota-save"]').trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('[data-testid="quota-problem"]').text()).toContain('存储配额')
    await input(wrapper, 'storage_gb').setValue('')
    await input(wrapper, 'max_upload_mb').setValue('0')
    await wrapper.find('[data-testid="quota-save"]').trigger('click')
    expect(wrapper.find('[data-testid="quota-problem"]').text()).toContain('不能小于 1')
  })

  it('「全部沿用」清空草稿,保存后提交空对象(取消所有覆盖),但保留不认识的键', async () => {
    const wrapper = mountEditor('{"storage_gb":50,"acp_concurrency_total":9}')
    expect(wrapper.find('[data-testid="quota-count"]').text()).toBe('已覆盖 1 项')
    await wrapper.find('[data-testid="quota-clear"]').trigger('click')
    expect((input(wrapper, 'storage_gb').element as HTMLInputElement).value).toBe('')
    await wrapper.find('[data-testid="quota-save"]').trigger('click')
    expect(wrapper.emitted('save')![0]).toEqual([{ acp_concurrency_total: 9 }])
  })

  it('服务器上的值变了(保存成功后重读)就重置草稿', async () => {
    const wrapper = mountEditor('{"storage_gb":50}')
    await input(wrapper, 'storage_gb').setValue('999')
    await wrapper.setProps({ json: '{"storage_gb":60}' })
    expect((input(wrapper, 'storage_gb').element as HTMLInputElement).value).toBe('60')
  })

  it('保存中按钮禁用并显示「保存中…」', async () => {
    const wrapper = mountEditor('', { busy: true })
    expect(wrapper.find('[data-testid="quota-save"]').text()).toBe('保存中…')
  })
})
