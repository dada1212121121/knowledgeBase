// 用户详情里「注册方式」的显示。后端写的是内部标识:admin / cli / migrated / email / invite:<邀请码 id>。
export function registeredText(via: string | null | undefined): string {
  const value = (via ?? '').trim()
  if (value === 'admin') return '管理员创建'
  if (value === 'cli') return '命令行创建'
  if (value === 'migrated') return '从单用户版升级'
  if (value === 'email') return '邮箱注册'
  if (value.startsWith('invite:')) return '邀请码注册'
  return '其它方式'
}
