// 文件操作的共享状态:取菜单可用性、确认删除、移动、回收站恢复 / 彻底删除。
// 页面只负责把「哪一行、哪个位置」交进来;权限与原因一律以服务端 `file_actions` 为准,
// 前端不自己推断(否则会把「本地目录只移索引」之类的规则复制一遍,迟早对不上)。
import { ref } from 'vue'
import { callCapability, CapabilityError } from '@/api/client'
import { useToast } from '@kb-ui/index'
import type { FileActions, FileOp, FileTarget } from '@/components/fileops/types'

export interface MenuState {
  target: FileTarget
  actions: FileActions
  /** 桌面:鼠标位置;手机:走底部弹层,不用坐标 */
  point: { x: number; y: number } | null
}

export function useFileActions(options: { onChanged?: (target: FileTarget) => void | Promise<void> } = {}) {
  const toast = useToast()
  const menu = ref<MenuState | null>(null)
  const actions = ref<FileActions | null>(null)
  const target = ref<FileTarget | null>(null)
  const dialog = ref<'delete' | 'move' | null>(null)
  const busy = ref(false)
  const result = ref<FileOp | null>(null)
  const error = ref('')

  function messageOf(err: unknown): string {
    if (err instanceof CapabilityError) {
      if (err.isConflict) return '文件已经变了(可能被同步或别人改过),请刷新后再试'
      return err.message || '操作失败'
    }
    return err instanceof Error ? err.message : '操作失败'
  }

  /** 打开菜单前先问服务端:能删吗、能移吗、指纹是什么。 */
  async function open(item: FileTarget, point: MenuState['point']) {
    error.value = ''
    try {
      const loaded = await callCapability<FileActions>('file_actions', { collection: item.collection, path: item.path })
      menu.value = { target: item, actions: loaded, point }
    } catch (err) {
      toast.push(messageOf(err), 'danger')
    }
  }

  function openAt(event: MouseEvent, item: FileTarget) {
    event.preventDefault()
    event.stopPropagation()
    void open(item, { x: event.clientX, y: event.clientY })
  }

  function openSheet(item: FileTarget) {
    void open(item, null)
  }

  /** 从顶栏菜单直接进某个动作(不先显示右键菜单)。 */
  async function openAnd(kind: 'delete' | 'move', item: FileTarget) {
    await open(item, null)
    if (menu.value) start(kind)
  }

  function closeMenu() {
    menu.value = null
  }

  function start(kind: 'delete' | 'move') {
    const current = menu.value
    if (!current) return
    const availability = kind === 'delete' ? current.actions.delete : current.actions.move
    if (!availability.allowed) {
      toast.push(availability.reason || '这个操作当前不可用', 'warning')
      return
    }
    target.value = current.target
    actions.value = current.actions
    result.value = null
    error.value = ''
    dialog.value = kind
    menu.value = null
  }

  async function confirmDelete() {
    if (!target.value || !actions.value || busy.value) return
    const current = target.value
    const snapshot = actions.value
    busy.value = true
    error.value = ''
    try {
      const capability = snapshot.folder ? 'delete_folder' : 'delete_file'
      result.value = await callCapability<FileOp>(capability, {
        collection: current.collection,
        path: current.path,
        fingerprint: snapshot.fingerprint.value,
      })
      const op = result.value
      if (op.state === 'partial') {
        toast.push(`部分删除成功:${op.done}/${op.total} 项,${op.error || '有文件没能处理'}`, 'warning', 6000)
        await options.onChanged?.(current)
      } else if (op.state === 'failed') {
        error.value = op.error || '删除失败'
      } else {
        if (snapshot.folder) {
          toast.push(
            snapshot.origin === 'upload' || snapshot.origin === 'archive'
              ? `文件夹已移到回收站(${op.done} 个文件),30 天内可以恢复`
              : snapshot.origin === 'unknown'
                ? `文件夹已删除(${op.done} 个文件):上传 / 压缩包副本在回收站,其余只移除了索引`
                : `文件夹已从索引移除(${op.done} 个文件),原件没有改动`,
            'success',
            6000,
          )
        } else {
          toast.push(
            snapshot.origin === 'upload' || snapshot.origin === 'archive'
              ? '已移到回收站,30 天内可以恢复'
              : '已从索引移除,原件没有改动',
          )
        }
        await options.onChanged?.(current)
        dialog.value = null
      }
    } catch (err) {
      error.value = messageOf(err)
    } finally {
      busy.value = false
    }
  }

  async function confirmMove(targetCollection: string, targetDir: string, newName: string) {
    if (!target.value || !actions.value || busy.value) return
    const current = target.value
    const snapshot = actions.value
    busy.value = true
    error.value = ''
    try {
      const capability = snapshot.folder ? 'move_folder' : 'move_file'
      const cross = targetCollection !== current.collection
      const payload: Record<string, unknown> = {
        collection: current.collection,
        path: current.path,
        target_dir: targetDir,
        new_name: newName.trim() || undefined,
        fingerprint: snapshot.fingerprint.value,
      }
      if (cross) payload.target_collection = targetCollection
      result.value = await callCapability<FileOp>(capability, payload)
      const op = result.value
      if (op.state === 'rolled_back') {
        error.value = op.error || '移动失败,已经恢复到原来的位置'
      } else if (op.state === 'failed' || op.state === 'partial') {
        error.value = op.error || '移动没有全部完成'
      } else {
        toast.push(
          cross
            ? snapshot.folder
              ? `文件夹已移动到「${targetCollection}」(${op.done} 个文件)`
              : `已移动到「${targetCollection}」`
            : snapshot.folder
              ? `文件夹已移动(${op.done} 个文件)`
              : '已移动',
        )
        await options.onChanged?.(current)
        dialog.value = null
      }
    } catch (err) {
      error.value = messageOf(err)
    } finally {
      busy.value = false
    }
  }

  function closeDialog() {
    if (busy.value) return
    dialog.value = null
    error.value = ''
    result.value = null
  }

  return {
    menu,
    target,
    actions,
    dialog,
    busy,
    result,
    error,
    openAt,
    openSheet,
    openAnd,
    closeMenu,
    start,
    confirmDelete,
    confirmMove,
    closeDialog,
  }
}
