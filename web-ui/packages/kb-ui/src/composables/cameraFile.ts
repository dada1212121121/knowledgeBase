// 相机拍的照片改个能区分的名字。
// iOS Safari 对 capture 拍出来的照片一律给 image.jpg:连拍两张就是两个同名、内容不同的文件,
// 进到上传流程会被当成「同名但内容不同」逐个问覆盖还是保留。拍照的文件按拍摄时间重命名,只改这种通用名,
// 相册里选的(IMG_1234.HEIC 之类的原名)和别的浏览器给的名字原样保留。
const GENERIC = /^image\.(jpe?g|png|heic|heif|webp)$/i

const two = (value: number) => String(value).padStart(2, '0')

export function cameraFiles(files: File[], now: Date = new Date()): File[] {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  return files.map((file, index) => {
    const match = GENERIC.exec(file.name)
    if (!match) return file
    const serial = files.length > 1 ? `-${index + 1}` : ''
    return new File([file], `拍照-${stamp}${serial}.${match[1]!.toLowerCase()}`, { type: file.type, lastModified: file.lastModified })
  })
}
