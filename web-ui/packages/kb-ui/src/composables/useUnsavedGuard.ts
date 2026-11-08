// 「有未保存的修改时离开要确认」(设计规范表单):路由切换和关闭 / 刷新页面两条路都拦。
//
// 路由切换用 vue-router 的 onBeforeRouteLeave + 调用方提供的确认函数(通常是 useConfirm);
// 关闭 / 刷新标签页只能用浏览器自带的 beforeunload 提示(文案不可自定义)。
import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

export function useUnsavedGuard(dirty: Ref<boolean>, confirmLeave: () => boolean | Promise<boolean>) {
  onBeforeRouteLeave(async () => {
    if (!dirty.value) return true
    return (await confirmLeave()) ? true : false
  })
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value) return
    event.preventDefault()
    // 部分浏览器要求设置 returnValue 才会弹提示
    event.returnValue = ''
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
}
