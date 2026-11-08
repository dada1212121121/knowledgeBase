import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFeature, useFeatures } from './useFeature'
import { useSessionStore } from '@/stores/session'

beforeEach(() => setActivePinia(createPinia()))

describe('useFeature', () => {
  it('没加载完时按「有」处理,入口不会先消失再出现', () => {
    expect(useFeature('ai.assistant').value).toBe(true)
  })
  it('加载后按功能表判断,并随功能表变化(AI 总开关关掉后入口立刻消失)', () => {
    const session = useSessionStore()
    session.features = new Set(['ai.assistant', 'docs.notes'])
    session.loaded = true
    const flag = useFeature('ai.assistant')
    expect(flag.value).toBe(true)
    session.features = new Set(['docs.notes'])
    expect(flag.value).toBe(false)
  })
  it('不传功能点表示不限制', () => {
    const session = useSessionStore()
    session.loaded = true
    expect(useFeature().value).toBe(true)
  })
  it('useFeatures 要求全部具备', () => {
    const session = useSessionStore()
    session.features = new Set(['ai.assistant'])
    session.loaded = true
    expect(useFeatures(['ai.assistant', 'ai.acp']).value).toBe(false)
    session.features = new Set(['ai.assistant', 'ai.acp'])
    expect(useFeatures(['ai.assistant', 'ai.acp']).value).toBe(true)
  })
})
