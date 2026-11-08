// 配置热重载事件的解析:三种事件各自该弹什么,以及迁移提示里的命令。
// 抽成纯函数是因为 WS 在比对 / 单测环境里连不上,只有这样才能守住“事件载荷变了页面别静默”。
import { describe, expect, it } from 'vitest'
import { isConfigEvent, migrationCommands, readConfigEvent } from './configEvents'

describe('readConfigEvent', () => {
  it('配置写坏时给出原因', () => {
    expect(readConfigEvent('config.error', { error: '第 3 行: k 必须是整数', generation: 4 })).toEqual({
      kind: 'error',
      message: '第 3 行: k 必须是整数',
    })
    // 没有 error 字段时也要有话说,不能显示 undefined
    expect(readConfigEvent('config.error', {})).toEqual({ kind: 'error', message: '解析失败' })
  })

  it('热更新带上立即生效与要重启的键', () => {
    const notice = readConfigEvent('config.changed', {
      hot: ['search.k', 'log.level'],
      restart_required: ['server.listen'],
      notes: ['listen 改动要重启'],
      generation: 5,
    })
    expect(notice).toEqual({
      kind: 'changed',
      hot: ['search.k', 'log.level'],
      restart: ['server.listen'],
      notes: ['listen 改动要重启'],
    })
  })

  it('embed 改动给出迁移计划与未生效的键', () => {
    const notice = readConfigEvent('config.migration', {
      migration: ['embed.model'],
      plan: {
        from: 'fastembed:bge-m3-int8',
        to: 'fastembed:bge-m3',
        same_compat_group: true,
        collections: ['proj_a', 'proj_b'],
      },
    })
    expect(notice).toEqual({
      kind: 'migration',
      plan: {
        from: 'fastembed:bge-m3-int8',
        to: 'fastembed:bge-m3',
        same_compat_group: true,
        collections: ['proj_a', 'proj_b'],
      },
      keys: ['embed.model'],
    })
  })

  it('缺计划时退化成一句提示,不崩', () => {
    expect(readConfigEvent('config.migration', { migration: ['embed.model'] })).toEqual({
      kind: 'migration-unknown',
    })
  })

  it('非配置事件返回 null,且只有 config. 前缀算配置事件', () => {
    expect(readConfigEvent('job.progress', {})).toBeNull()
    expect(isConfigEvent('config.changed')).toBe(true)
    expect(isConfigEvent('configuration')).toBe(false)
    expect(isConfigEvent('job.done')).toBe(false)
  })

  it('载荷里的怪字段被忽略,不会把非字符串塞进列表', () => {
    const notice = readConfigEvent('config.changed', { hot: ['search.k', 42, null], restart_required: 'x' })
    expect(notice).toEqual({ kind: 'changed', hot: ['search.k'], restart: [], notes: [] })
  })
})

describe('migrationCommands', () => {
  it('顺序是 停服 → 迁移 → 启动,unit 名用 kb service 生成的那个', () => {
    const text = migrationCommands({
      from: 'a:1',
      to: 'a:2',
      same_compat_group: true,
      collections: ['proj_x', 'proj_y'],
    })
    const stop = text.indexOf('systemctl stop kb.service')
    const migrateX = text.indexOf('kb migrate proj_x --to a:2')
    const migrateY = text.indexOf('kb migrate proj_y --to a:2')
    const start = text.indexOf('systemctl start kb.service')
    // kb migrate 要抢 daemon.lock:必须停服之后再迁移,**所有**迁移做完才启动
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(migrateX).toBeGreaterThan(stop)
    expect(migrateY).toBeGreaterThan(migrateX)
    expect(start).toBeGreaterThan(migrateY)
    expect(text).toContain('kb migrate proj_y --to a:2')
    expect(text).toContain('同一兼容组')
    // 不再出现“重启后再迁移”的错误顺序,也不写死本机 deploy 的 unit 名
    expect(text).not.toContain('restart')
    expect(text).not.toContain('kbd.service')
    // 用户级安装的提示
    expect(text).toContain('--user')
  })

  it('跨兼容组时不写“可免重嵌入”那句', () => {
    const text = migrationCommands({ from: 'a:1', to: 'b:1', same_compat_group: false, collections: ['proj_x'] })
    expect(text).not.toContain('同一兼容组')
    expect(text).toContain('kb migrate proj_x --to b:1')
  })
})
