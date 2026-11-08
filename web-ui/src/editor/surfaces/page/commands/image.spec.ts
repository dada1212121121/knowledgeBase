/** 插入图片的纯函数单测：缩放到版心宽度、载荷形状。文件读取走真实浏览器的 e2e。 */
import { describe, expect, it } from 'vitest'
import { fitImageSize, imagePayload, loadImageFile, MAX_IMAGE_BYTES, MAX_INSERT_WIDTH } from './image'

describe('fitImageSize', () => {
  it('不超过版心的原样保留（取整）', () => {
    expect(fitImageSize(300, 200)).toEqual({ width: 300, height: 200 })
    expect(fitImageSize(MAX_INSERT_WIDTH, 100)).toEqual({ width: MAX_INSERT_WIDTH, height: 100 })
  })

  it('超宽按比例缩到版心宽度，高度跟着缩', () => {
    expect(fitImageSize(1224, 612)).toEqual({ width: 612, height: 306 })
    expect(fitImageSize(4000, 3000)).toEqual({ width: 612, height: 459 })
  })

  it('极扁的图高度至少 1px，不会缩成 0', () => {
    expect(fitImageSize(100000, 1)).toEqual({ width: 612, height: 1 })
  })

  it('无效尺寸返回 null', () => {
    for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [Number.NaN, 5], [5, Infinity]]) expect(fitImageSize(w!, h!)).toBeNull()
  })
})

describe('imagePayload', () => {
  it('嵌入式、四周边距 0（与上游插入图片的载荷一致）', () => {
    expect(imagePayload('data:x', 'a.png', { width: 10, height: 20 })).toEqual({
      src: 'data:x', alt: 'a.png', width: 10, height: 20, wrapType: 'inline', displayMode: 'inline', distTop: 0, distBottom: 0, distLeft: 0, distRight: 0,
    })
  })
})

describe('loadImageFile 的拒绝路径', () => {
  it('不是图片', async () => {
    await expect(loadImageFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).rejects.toThrow('不是图片文件')
  })

  it('超过大小上限', async () => {
    const big = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
    await expect(loadImageFile(big)).rejects.toThrow('超过')
  })
})
