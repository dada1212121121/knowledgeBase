import { describe, expect, it } from 'vitest'
import { cameraFiles } from './cameraFile'

const at = new Date(2026, 9, 29, 3, 5, 9)
const file = (name: string, body = 'x', type = 'image/jpeg') => new File([body], name, { type, lastModified: 123 })
// jsdom 的 File 没有 text:用 FileReader 读回内容
const read = (item: File) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(item)
  })

describe('cameraFiles 拍照文件重命名', () => {
  it('iOS 的通用名 image.jpg 按拍摄时间改名,内容与类型不变', async () => {
    const [renamed] = cameraFiles([file('image.jpg', 'abc')], at)
    expect(renamed!.name).toBe('拍照-20261029-030509.jpg')
    expect(renamed!.type).toBe('image/jpeg')
    expect(renamed!.lastModified).toBe(123)
    expect(await read(renamed!)).toBe('abc')
  })

  it('扩展名统一小写;heic / png 也认', () => {
    expect(cameraFiles([file('image.JPEG')], at)[0]!.name).toBe('拍照-20261029-030509.jpeg')
    expect(cameraFiles([file('image.HEIC', 'x', 'image/heic')], at)[0]!.name).toBe('拍照-20261029-030509.heic')
    expect(cameraFiles([file('image.png', 'x', 'image/png')], at)[0]!.name).toBe('拍照-20261029-030509.png')
  })

  it('一次给了多张时加序号,不会再撞名', () => {
    const names = cameraFiles([file('image.jpg'), file('image.jpg')], at).map((item) => item.name)
    expect(names).toEqual(['拍照-20261029-030509-1.jpg', '拍照-20261029-030509-2.jpg'])
  })

  it('不是通用名的原样保留(同一对象,不复制)', () => {
    const own = file('IMG_1234.JPG')
    const other = file('我的照片.jpg')
    const out = cameraFiles([own, other], at)
    expect(out[0]).toBe(own)
    expect(out[1]).toBe(other)
  })

  it('只匹配整个文件名:my-image.jpg / image.jpg.bak 不动', () => {
    for (const name of ['my-image.jpg', 'image.jpg.bak', 'image.gif', 'xx-image.png']) {
      const item = file(name)
      expect(cameraFiles([item], at)[0]).toBe(item)
    }
  })
})
