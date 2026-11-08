/**
 * 权限判定
 *
 * 为什么抛错而不是返回 undefined：权限不足是扩展作者的编程错误或用户拒绝的结果，
 * 静默返回会让扩展「看起来没反应」，排错极难；抛带权限名的 `PermissionDeniedError`，
 * 错误信息能直接告诉作者该在 manifest.toml 里加哪一项。
 */
import { PERMISSIONS, type ExtensionManifest, type Permission } from './api'

export { PERMISSIONS }

/** 权限不足 / 被用户拒绝。 */
export class PermissionDeniedError extends Error {
  readonly permission: Permission
  readonly extensionId: string
  /** 被拒的动作，如 `document.replaceSelection`。 */
  readonly action: string

  constructor(extensionId: string, permission: Permission, action: string, reason?: string) {
    super(
      reason ??
        `扩展 ${extensionId} 没有「${permission}」权限，不能调用 ${action}（需要在 manifest.toml 的 permissions 里声明 "${permission}"）`,
    )
    this.name = 'PermissionDeniedError'
    this.permission = permission
    this.extensionId = extensionId
    this.action = action
  }
}

/** 是不是已知权限名。 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

/** 清单是否声明了某项权限（`document.write` 的「声明」只是前提，还要用户确认，见 registry）。 */
export function hasPermission(manifest: ExtensionManifest, permission: Permission): boolean {
  return manifest.permissions.includes(permission)
}

/** 断言清单声明了权限，否则抛 `PermissionDeniedError`。 */
export function assertPermission(manifest: ExtensionManifest, permission: Permission, action: string): void {
  if (!hasPermission(manifest, permission)) throw new PermissionDeniedError(manifest.id, permission, action)
}

/** 一次断言多项（全部具备才通过；错误里报第一项缺失的）。 */
export function assertPermissions(manifest: ExtensionManifest, permissions: readonly Permission[], action: string): void {
  for (const permission of permissions) assertPermission(manifest, permission, action)
}
