import { describe, expect, it } from 'vitest'
import { INFO_TTL_MS, MAX_NOTICES, autoDismiss, dismissNotice, pushNotice, type ShownNotice } from './notices'

const warn = (text: string) => ({ tone: 'warn' as const, text })
const info = (text: string) => ({ tone: 'info' as const, text })

describe('协作提示队列', () => {
  it('按先后顺序加入', () => {
    let list: ShownNotice[] = []
    list = pushNotice(list, warn('甲'), 1)
    list = pushNotice(list, info('乙'), 2)
    expect(list.map((entry) => entry.text)).toEqual(['甲', '乙'])
  })

  it('同样的话只留一条:替换旧的,顺序挪到最后,id 换新(重连反复触发时不刷屏)', () => {
    let list: ShownNotice[] = []
    list = pushNotice(list, warn('你现在只有查看权限'), 1)
    list = pushNotice(list, info('别的'), 2)
    list = pushNotice(list, warn('你现在只有查看权限'), 3)
    expect(list.map((entry) => [entry.text, entry.id])).toEqual([
      ['别的', 2],
      ['你现在只有查看权限', 3],
    ])
  })

  it('最多同时显示 3 条,挤掉最老的', () => {
    let list: ShownNotice[] = []
    for (let id = 1; id <= MAX_NOTICES + 2; id += 1) list = pushNotice(list, warn(`第${id}条`), id)
    expect(list).toHaveLength(MAX_NOTICES)
    expect(list[0]?.text).toBe(`第${3}条`)
  })

  it('点掉一条只去掉它', () => {
    let list: ShownNotice[] = []
    list = pushNotice(list, warn('甲'), 1)
    list = pushNotice(list, warn('乙'), 2)
    expect(dismissNotice(list, 1).map((entry) => entry.text)).toEqual(['乙'])
    expect(dismissNotice(list, 99)).toHaveLength(2)
  })

  it('警告不自动收起(丢了修改的话必须用户看过),普通提示会', () => {
    expect(autoDismiss(warn('你的修改没有保存'))).toBe(false)
    expect(autoDismiss(info('你现在可以编辑了'))).toBe(true)
    expect(INFO_TTL_MS).toBeGreaterThan(0)
  })
})
