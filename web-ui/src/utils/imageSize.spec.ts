import { describe, expect, it } from 'vitest'
import { clampImageWidth, exportImageSizes, joinImageWidth, splitImageWidth } from './imageSize'

describe('图片宽度（地址片段 #w=）', () => {
  it('拆出宽度，地址不带片段；没有 / 不合法的值原样返回', () => {
    expect(splitImageWidth('/api/v1/raw?p=a.png#w=320')).toEqual({ src: '/api/v1/raw?p=a.png', width: 320 })
    expect(splitImageWidth('a.png')).toEqual({ src: 'a.png', width: null })
    expect(splitImageWidth('a.png#w=12')).toEqual({ src: 'a.png#w=12', width: null })
    expect(splitImageWidth('a.png#w=99999')).toEqual({ src: 'a.png#w=99999', width: null })
    expect(splitImageWidth('a.png#section')).toEqual({ src: 'a.png#section', width: null })
  })
  it('拼回去：自动（null / 太小）不写片段；往返不变', () => {
    expect(joinImageWidth('a.png', null)).toBe('a.png')
    expect(joinImageWidth('a.png', 20)).toBe('a.png')
    expect(joinImageWidth('a.png', 320.4)).toBe('a.png#w=320')
    const split = splitImageWidth('x/y.png#w=640')
    expect(joinImageWidth(split.src, split.width)).toBe('x/y.png#w=640')
  })
  it('拖拽出来的宽度限制在 [最小, 上限]', () => {
    expect(clampImageWidth(10, 700)).toBe(48)
    expect(clampImageWidth(900, 700)).toBe(700)
    expect(clampImageWidth(333.6, 700)).toBe(334)
    expect(clampImageWidth(100, 20)).toBe(48)
  })
  it('导出：带宽度的图片换成 <img width>，没宽度的不动，标题和特殊字符转义', () => {
    expect(exportImageSizes('前 ![图](a.png#w=300) 后')).toBe('前 <img src="a.png" alt="图" width="300"> 后')
    expect(exportImageSizes('![图](a.png "说明")')).toBe('![图](a.png "说明")')
    expect(exportImageSizes('![a"b](a.png#w=200 "t<1>")')).toBe('<img src="a.png" alt="a&quot;b" title="t&lt;1&gt;" width="200">')
    expect(exportImageSizes('[链接](a.png#w=300)')).toBe('[链接](a.png#w=300)')
  })
})
