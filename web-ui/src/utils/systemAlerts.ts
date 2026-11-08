// 系统告警清单(管理员头像上的小圆点背后的原因)。纯函数,便于单测。
//
// 以前这些信息写在人人可见的底部状态栏里(套接字路径、监听地址……);多用户后不能把服务器内部
// 信息给普通用户看,所以只对有系统功能的账号计算告警:后台连不上、备份失败、磁盘快满了。
import { failureText, type BackupFailure } from '@/utils/backup'

export interface SystemAlert {
  id: 'offline' | 'backup' | 'disk'
  text: string
}

/** 磁盘用到这个比例就告警。 */
export const DISK_ALERT_RATIO = 0.9

export function buildSystemAlerts(input: {
  /** 账号有系统功能(sys.ops)——没有就一律不告警 */
  privileged: boolean
  online: boolean
  backup: BackupFailure | null
  diskUsedRatio: number | null
}): SystemAlert[] {
  if (!input.privileged) return []
  const list: SystemAlert[] = []
  if (!input.online) list.push({ id: 'offline', text: '与后台服务的连接中断' })
  if (input.backup) list.push({ id: 'backup', text: failureText(input.backup) })
  if (input.diskUsedRatio !== null && input.diskUsedRatio >= DISK_ALERT_RATIO) {
    list.push({ id: 'disk', text: `磁盘已用 ${Math.round(input.diskUsedRatio * 100)}%,快满了` })
  }
  return list
}
