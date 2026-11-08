// 右侧抽屉的开合状态(AI 助手、通知)。
//
// 顶栏按钮、手机标签栏、⌘J、「我的」页都能打开它们,所以状态放在 store 里,
// 而不是某个组件的局部变量。两个抽屉互斥:同时只开一个,免得在窄屏上叠在一起。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const usePanelsStore = defineStore('panels', () => {
  const assistantOpen = ref(false)
  const notificationsOpen = ref(false)
  /** 助手正在回答(顶栏按钮上的小圆点据此脉动);由抽屉组件写入。 */
  const assistantBusy = ref(false)

  function toggleAssistant(force?: boolean) {
    assistantOpen.value = force ?? !assistantOpen.value
    if (assistantOpen.value) notificationsOpen.value = false
  }
  function toggleNotifications(force?: boolean) {
    notificationsOpen.value = force ?? !notificationsOpen.value
    if (notificationsOpen.value) assistantOpen.value = false
  }
  function closeAll() {
    assistantOpen.value = false
    notificationsOpen.value = false
  }

  return { assistantOpen, notificationsOpen, assistantBusy, toggleAssistant, toggleNotifications, closeAll }
})
