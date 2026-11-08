/**
 * 工具栏测试小工具（仅供 *.spec.ts）。
 * 标题级别是一个下拉（编辑器栏通常只有 600 多像素宽，平铺 5 个标题按钮会把“插入”“查找”“源码”挤进“更多”），
 * 测试里“点二级标题”就是：先开下拉，再点里面的项——和用户操作一致。
 */
import type { VueWrapper } from '@vue/test-utils'

type Wrapper = Pick<VueWrapper, 'find'>

/** 在工具栏上选一个标题级别（heading.1 … heading.4，或 paragraph） */
export async function pickHeading(wrapper: Wrapper, id: 'paragraph' | 'heading.1' | 'heading.2' | 'heading.3' | 'heading.4'): Promise<void> {
  await wrapper.find('[data-action="heading"]').trigger('click')
  await wrapper.find(`[role^="menuitem"][data-action="${id}"]`).trigger('click')
}
