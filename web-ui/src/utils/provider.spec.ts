// 组件状态合成的回归测试:此前「当前」与「未安装」会同时出现,画面自相矛盾。
import { describe, expect, it } from 'vitest'
import { onlineCount, providerState, shortNote } from './provider'

const base = { installed: false, ready: false, current: false, detail: null }

describe('providerState', () => {
  it('已选用且就绪 → 使用中', () => {
    expect(providerState({ ...base, installed: true, ready: true, current: true })).toMatchObject({ key: 'active', tone: 'success', broken: false })
  })
  it('已选用但没装 → 一个状态「已选用 · 缺运行时」,而不是「当前」+「未安装」并排', () => {
    const state = providerState({ ...base, current: true })
    expect(state.label).toBe('已选用 · 缺运行时')
    expect(state.tone).toBe('warning')
    expect(state.broken).toBe(true)
  })
  it('已选用、已装但没就绪 → 未就绪', () => {
    expect(providerState({ ...base, installed: true, current: true }).label).toBe('已选用 · 未就绪')
  })
  it('没选用也没装 → 灰色「未安装」,不是故障', () => {
    expect(providerState(base)).toMatchObject({ key: 'missing', tone: 'neutral', broken: false })
  })
  it('没选用但就绪 → 可用', () => {
    expect(providerState({ ...base, installed: true, ready: true }).key).toBe('available')
  })
})

describe('onlineCount', () => {
  it('只数正在使用的组件:没装的备选后端不算故障', () => {
    const list = [
      { ...base, installed: true, ready: true, current: true },
      { ...base, current: true },
      { ...base }, // 备选后端 tesseract:没装、没选用
    ]
    expect(onlineCount(list)).toEqual({ ok: 1, total: 2 })
  })
})

describe('shortNote', () => {
  it('短说明原样显示,长诊断文案收成状态词', () => {
    expect(shortNote({ ...base, installed: true, ready: true, current: true, detail: 'iGPU' })).toBe('iGPU')
    expect(shortNote({ ...base, current: true, detail: '找不到命令 rapidocr;装 rapidocr-onnxruntime 或指向薄封装脚本' })).toBe('已选用 · 缺运行时')
  })
})
