// 头像的纯逻辑(组件见 components/UserAvatar.vue,后端见 kb-web/src/avatar.rs)。

/**
 * 头像图片地址。`file` 是库里存的头像文件名(每次换头像都会变),拼进 `v` 参数让浏览器缓存跟着失效。
 * 没有头像返回 `null`,调用方画首字母。
 */
export function avatarUrl(userId: string, file: string | null | undefined): string | null {
  if (!file) return null
  return `/api/v1/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(file)}`
}

/** 游客没有账号,也就没有头像:服务端给游客的标识是 `guest:昵称#编号`,统一画一个固定的游客头像。 */
export function isGuestId(userId: string | null | undefined): boolean {
  return !!userId && userId.startsWith('guest:')
}

/** 首字母兜底:取显示名的第一个「字」。按码点切,emoji、生僻字不会被拆成乱码。 */
export function initialOf(name: string | null | undefined, fallback = '?'): string {
  const first = Array.from((name ?? '').trim())[0]
  if (!first) return fallback
  // 拉丁字母显示大写,中文等原样
  return first.toLocaleUpperCase()
}

/** 同一个人在所有地方底色一致:用户 id 哈希到 0–359 的色相。 */
export function hueOf(seed: string): number {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return hash % 360
}

/** 前端选头像时的预检(省得把明显不行的大文件传上去再被拒);规则与后端 `avatar::normalize` 对齐。 */
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function checkAvatarFile(file: { size: number; type: string; name?: string }): string | null {
  if (file.size === 0) return '这个文件是空的'
  if (file.size > AVATAR_MAX_BYTES) return `图片不能超过 ${AVATAR_MAX_BYTES / 1024 / 1024} MB`
  // 浏览器给的 type 来自扩展名,只作提示;真正的判断在服务端按文件内容做
  if (!AVATAR_TYPES.includes(file.type)) return '只支持 PNG、JPEG、WebP、GIF 图片'
  return null
}
