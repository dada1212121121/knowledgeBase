// 图标表完整性:每个图标都必须有 path,避免页面出现空白图标。
import { describe, expect, it } from 'vitest'
import { iconPaths, type IconName } from './icons'

describe('iconPaths', () => {
  it('每个图标至少有一条路径', () => {
    for (const [name, paths] of Object.entries(iconPaths)) {
      expect(paths.length, name).toBeGreaterThan(0)
      for (const path of paths) {
        expect(path.length, `${name} 的 path`).toBeGreaterThan(4)
      }
    }
  })

  it('类型里的名字都在表里', () => {
    const names: IconName[] = ['home', 'database', 'upload', 'search', 'settings', 'refresh']
    for (const name of names) expect(iconPaths[name]).toBeDefined()
  })
})
