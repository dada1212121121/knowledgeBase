/**
 * 插入图片：选文件 → 读成 data URL → 量尺寸 → 交给引擎
 *
 * 图片载荷形状来自上游 `useWorkerFileIO.imageChange`：`src` 是 data URL，宽高按 96dpi 的 CSS 像素，
 * 默认嵌入式（inline），四周边距 0。宽度超过版心就等比缩到 `MAX_INSERT_WIDTH`：一张 4000 px 的截图
 * 直接插进去会撑出页面，Word 也是这么缩的。
 */

/** 版心宽度的保守上限（Letter 纸 8.5in − 左右各 1in = 6.5in ≈ 624px；上游取 612） */
export const MAX_INSERT_WIDTH = 612
/** 单张图片上限：data URL 会进引擎状态，过大的图拖慢每一次保存 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function fitImageSize(width: number, height: number, maxWidth = MAX_INSERT_WIDTH): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) }
  return { width: maxWidth, height: Math.max(1, Math.round(height * (maxWidth / width))) }
}

export interface DocxImagePayload {
  src: string
  alt: string
  width: number
  height: number
  wrapType: 'inline'
  displayMode: 'inline'
  distTop: 0
  distBottom: 0
  distLeft: 0
  distRight: 0
}

export function imagePayload(src: string, alt: string, size: { width: number; height: number }): DocxImagePayload {
  return { src, alt, ...size, wrapType: 'inline', displayMode: 'inline', distTop: 0, distBottom: 0, distLeft: 0, distRight: 0 }
}

/** 读文件并量出尺寸；不是图片或读不出来时抛带中文原因的错 */
export async function loadImageFile(file: File): Promise<DocxImagePayload> {
  if (!file.type.startsWith('image/')) throw new Error(`「${file.name}」不是图片文件`)
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`图片有 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限`)
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败')))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
  const natural = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error(`「${file.name}」无法解码，可能已损坏`))
    image.src = src
  })
  const size = fitImageSize(natural.width, natural.height)
  if (!size) throw new Error(`「${file.name}」的尺寸无效`)
  return imagePayload(src, file.name, size)
}

/** 弹出系统文件选择框；取消返回 null */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp'
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    input.setAttribute('data-testid', 'docx-image-input')
    const done = (file: File | null) => {
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true })
    // 取消选择：新浏览器有 cancel 事件；旧的没有，最多留一个无害的隐藏 input，随页面销毁
    input.addEventListener('cancel', () => done(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}
