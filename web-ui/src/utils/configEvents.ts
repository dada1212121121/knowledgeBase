// 配置热重载事件的解析:守护进程在重载后推 `config.changed` / `config.error` /
// `config.migration`。这里把三种事件的载荷整理成“要弹什么”,外壳只负责展示 —— 逻辑抽出来
// 才能单测(WS 在比对环境里连不上)。

export interface MigrationPlan {
  from: string
  to: string
  same_compat_group: boolean
  collections: string[]
}

export type ConfigNotice =
  /** 配置文件写坏了:旧配置继续生效 */
  | { kind: 'error'; message: string }
  /** embed 改动:整份未生效,需要先停服、迁移、再启动 */
  | { kind: 'migration'; plan: MigrationPlan; keys: string[] }
  /** 说了要迁移但没给计划(理论上不该出现,退化成一句提示) */
  | { kind: 'migration-unknown' }
  /** 已热更新(可能还有几项要重启) */
  | { kind: 'changed'; hot: string[]; restart: string[]; notes: string[] }

/** 事件名是否属于配置类。 */
export function isConfigEvent(type: string): boolean {
  return type.startsWith('config.')
}

/** 把一条 WS 事件整理成提示;不认识的类型返回 `null`。 */
export function readConfigEvent(
  type: string,
  data: Record<string, unknown>,
): ConfigNotice | null {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

  if (type === 'config.error') {
    const message = typeof data.error === 'string' && data.error ? data.error : '解析失败'
    return { kind: 'error', message }
  }
  if (type === 'config.migration') {
    const plan = data.plan as MigrationPlan | null | undefined
    if (!plan || typeof plan.to !== 'string') return { kind: 'migration-unknown' }
    return {
      kind: 'migration',
      plan: {
        from: plan.from ?? '',
        to: plan.to,
        same_compat_group: plan.same_compat_group === true,
        collections: strings(plan.collections),
      },
      keys: strings(data.migration),
    }
  }
  if (type === 'config.changed') {
    return { kind: 'changed', hot: strings(data.hot), restart: strings(data.restart_required), notes: strings(data.notes) }
  }
  return null
}

/**
 * 迁移提示里的命令。
 *
 * 顺序是 **停服 → 迁移 → 启动**,不是“重启后再迁移”:
 * - `kb migrate` 是嵌入式写命令,要抢 `run/daemon.lock`,守护进程在跑时会直接退出(码 3);
 * - 停服时 `kb migrate` 读的是磁盘上**已经改过**的 config.toml,所以 `--to` 与配置一致,
 *   `ensure_target` 能通过;
 * - 迁移完再启动,守护进程起来时集合已经指向新表。
 *
 * unit 名用 `kb service install` 生成的那个(`kb.service`,见 `crates/kb-cli/src/commands/service.rs`);
 * 用户级安装要在 `systemctl` 后面加 `--user`。
 */
export function migrationCommands(plan: MigrationPlan): string {
  const lines = [
    '# 1) 停守护进程(kb migrate 要拿 run/daemon.lock,守护进程在跑时会直接退出)',
    'systemctl stop kb.service    # 用户级安装用 systemctl --user stop kb.service',
  ]
  if (plan.same_compat_group) {
    lines.push('# 同一兼容组:可以只切换 embedder_id,不必重嵌入(先用 kb eval 确认 hit@5 下降 ≤ 0.02)')
  }
  lines.push('# 2) 逐个 collection 迁移(会同时搬 chunks 与 insight 行)')
  for (const collection of plan.collections) {
    lines.push(`kb migrate ${collection} --to ${plan.to}`)
  }
  lines.push('# 3) 启动守护进程,新的 embed 配置生效')
  lines.push('systemctl start kb.service')
  return lines.join('\n')
}
