import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelsStore } from './panels'

beforeEach(() => setActivePinia(createPinia()))

describe('usePanelsStore', () => {
  it('助手和通知抽屉互斥:开一个会关掉另一个', () => {
    const panels = usePanelsStore()
    panels.toggleAssistant()
    expect(panels.assistantOpen).toBe(true)
    panels.toggleNotifications()
    expect(panels.notificationsOpen).toBe(true)
    expect(panels.assistantOpen).toBe(false)
    panels.toggleAssistant()
    expect(panels.assistantOpen).toBe(true)
    expect(panels.notificationsOpen).toBe(false)
  })
  it('可以显式开 / 关,再点一次是切换', () => {
    const panels = usePanelsStore()
    panels.toggleAssistant(true)
    panels.toggleAssistant(true)
    expect(panels.assistantOpen).toBe(true)
    panels.toggleAssistant()
    expect(panels.assistantOpen).toBe(false)
    panels.toggleNotifications(false)
    expect(panels.notificationsOpen).toBe(false)
  })
  it('closeAll 全关', () => {
    const panels = usePanelsStore()
    panels.toggleNotifications(true)
    panels.closeAll()
    expect(panels.assistantOpen || panels.notificationsOpen).toBe(false)
  })
})
