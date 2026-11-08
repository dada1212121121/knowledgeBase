#!/usr/bin/env node
/**
 * 编辑器换代的最终审计：把散在各处的门禁按顺序全跑一遍，汇总成一份报告。
 *
 * 为什么要一个总入口：每张卡验收时只跑了自己的门禁，跨卡的回归（例如 PPTX 改了 OfficeEditor，
 * 把 xlsx 编辑弄坏）只有全量复跑才看得到。这里不重复实现任何检查，只编排已有脚本，
 * 以退出码为准（0 = 通过），并留下每项的耗时与输出末尾，方便写 实测报告。
 *
 * 用法（先 npm run build）：
 *   node e2e/editor-final-audit.mjs                 # 默认：静态检查 + 全部内容面门禁 + 协同 / 扩展 / 视觉 / 无障碍 / 性能
 *   node e2e/editor-final-audit.mjs --engines=chromium,webkit,firefox   # 内容面门禁按浏览器各跑一遍
 *   node e2e/editor-final-audit.mjs --rust          # 追加真实守护进程端到端（cargo test -p kb-cli --test e2e_ui）
 *   node e2e/editor-final-audit.mjs --only=lint,docx  # 只跑名字里含这些词的项
 *
 * 结果：e2e/out/final-audit.json 与 e2e/out/final-audit.md；任何一项失败退出码为 1。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cpus, loadavg } from 'node:os'

const WEB = resolve(import.meta.dirname, '..')
const REPO = resolve(WEB, '..')
const OUT = join(WEB, 'e2e/out')
const args = process.argv.slice(2)
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const engines = opt('engines', 'chromium').split(',').filter(Boolean)
const only = opt('only', '').split(',').filter(Boolean)
const withRust = args.includes('--rust')

const MIN = 60_000
/** 一项检查：name 唯一；cmd 走 bash -lc（要 source env.sh 拿代理与 cargo 环境） */
const gate = (name, cmd, { cwd = WEB, timeout = 15 * MIN, env = {} } = {}) => ({ name, cmd, cwd, timeout, env })

/** 场景模块只导出数据（不像 viewer-shots.mjs 那样一 import 就开跑），可以安全读取场景名 */
async function scenarioNames(file, exportName) {
  try {
    const module = await import(join(WEB, 'e2e', file))
    return Object.keys(module[exportName] ?? {})
  } catch {
    return []
  }
}
const mobileNames = [
  ...(await scenarioNames('editor-mobile-scenarios.mjs', 'EDITOR_MOBILE_SCENARIOS')),
  ...(await scenarioNames('tablet-scenarios.mjs', 'TABLET_SCENARIOS')),
]

const SURFACES = ['text', 'code', 'pdf', 'csv', 'xlsx-read', 'xlsx', 'docx-read', 'docx', 'pptx-read', 'pptx']
const gates = [
  // 静态检查
  gate('vue-tsc', 'npx vue-tsc --noEmit'),
  gate('lint', 'npm run -s lint'),
  gate('vitest', 'npx vitest run', { timeout: 40 * MIN }),
  gate('licenses', 'node scripts/check-licenses.mjs'),
  // 运行时依赖不得有 high / critical 漏洞（moderate 只记录）
  gate('npm-audit', 'npm audit --omit=dev --audit-level=high', { timeout: 5 * MIN }),
  gate('dist-budget', 'node scripts/dist-report.mjs'),
  // 内容面阶段门禁（每个浏览器一遍）
  ...engines.flatMap((engine) =>
    SURFACES.map((surface) => gate(`native:${surface}:${engine}`, `node e2e/editor-native.mjs --surface=${surface}`, { env: { KB_ENGINE: engine }, timeout: 25 * MIN })),
  ),
  // 真实语料回归
  gate('native:text:regression100', 'node e2e/editor-native.mjs --surface=text --regression=100', { timeout: 30 * MIN }),
  gate('native:code:regression20', 'node e2e/editor-native.mjs --surface=code --regression=20', { timeout: 20 * MIN }),
  // 协同与房间格式
  gate('collab:text', 'node e2e/editor-text-collab.mjs'),
  gate('collab:code', 'node e2e/editor-code-collab.mjs'),
  gate('collab:csv', 'node e2e/editor-csv-collab.mjs'),
  gate('collab:xlsx', 'node e2e/editor-xlsx-collab.mjs'),
  gate('xlsx:edit', 'node e2e/editor-xlsx-edit.mjs'),
  // Office 编辑专项
  gate('docx:ime', 'node e2e/docx-edit-ime.mjs'),
  gate('docx:lossless', 'node e2e/docx-lossless.mjs', { timeout: 50 * MIN }),
  gate('pptx:edit', 'node e2e/editor-pptx-edit.mjs', { timeout: 25 * MIN }),
  gate('pptx:collab', 'node e2e/editor-pptx-collab.mjs', { timeout: 25 * MIN }),
  // 扩展、视觉、无障碍、版面
  gate('extensions', 'node e2e/editor-extensions.mjs'),
  gate('shots:text', 'node e2e/editor-shots.mjs --surface=text'),
  gate('shots:code', 'node e2e/editor-shots.mjs --surface=code'),
  gate('shots:pdf', 'node e2e/editor-shots.mjs --surface=pdf'),
  gate('axe', 'node e2e/axe.mjs', { timeout: 30 * MIN }),
  // 手机 / 平板上的编辑器场景（输入法、工具栏贴键盘、底部面板、旋转）：场景名从场景模块里读，新增场景自动纳入
  ...(mobileNames.length ? [gate('mobile+tablet', `node e2e/viewer-shots.mjs ${mobileNames.join(' ')}`, { timeout: 60 * MIN })] : []),
  // 性能
  gate('perf-budget', 'node e2e/perf-budget.mjs'),
  gate('editor-bench', 'node e2e/editor-bench.mjs --enforce', { timeout: 30 * MIN }),
  // 服务端
  gate('office-worker', 'npm test', { cwd: join(REPO, 'office-worker'), timeout: 10 * MIN }),
  ...(withRust ? [gate('rust:e2e_ui', 'cargo test -p kb-cli --test e2e_ui -- --nocapture', { cwd: REPO, timeout: 60 * MIN })] : []),
]

/** 门禁脚本不存在就记为「缺失」（同样算失败：最终审计要求每一项都在） */
function scriptOf(cmd) {
  const match = /node (e2e\/[\w.-]+\.mjs|scripts\/[\w.-]+\.mjs)/.exec(cmd)
  return match ? match[1] : null
}

function run(item) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn('bash', ['-lc', `source ${join(REPO, 'scripts/env.sh')} >/dev/null 2>&1; ${item.cmd}`], {
      cwd: item.cwd,
      env: { ...process.env, ...item.env, NODE_NO_WARNINGS: '1' },
    })
    const lines = []
    const keep = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim() || /UNDICI|trace-warnings/.test(line)) continue
        lines.push(line.slice(0, 300))
        if (lines.length > 400) lines.splice(0, lines.length - 400)
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      lines.push(`（超时 ${Math.round(item.timeout / MIN)} 分钟，已终止）`)
      child.kill('SIGKILL')
    }, item.timeout)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ name: item.name, cmd: item.cmd, ok: code === 0, code, seconds: Math.round((Date.now() - started) / 1000), tail: lines.slice(-15) })
    })
  })
}

mkdirSync(OUT, { recursive: true })
const selected = gates.filter((item) => !only.length || only.some((word) => item.name.includes(word)))
const startedAt = new Date().toISOString()
const results = []
for (const item of selected) {
  const script = scriptOf(item.cmd)
  if (script && !existsSync(join(item.cwd, script))) {
    results.push({ name: item.name, cmd: item.cmd, ok: false, code: null, seconds: 0, tail: [`缺失：${script} 不存在`] })
    console.log(`✗ ${item.name}（缺失 ${script}）`)
    continue
  }
  const result = await run(item)
  results.push(result)
  console.log(`${result.ok ? '✓' : '✗'} ${result.name}  ${result.seconds}s${result.ok ? '' : `  退出码 ${result.code}`}`)
  if (!result.ok) console.log(`    ${result.tail.slice(-6).join('\n    ')}`)
}

const failed = results.filter((item) => !item.ok)
const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  machine: { cpus: cpus().length, model: cpus()[0]?.model, loadavg: loadavg().map((value) => +value.toFixed(2)) },
  engines,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((item) => item.name),
  results,
}
writeFileSync(join(OUT, 'final-audit.json'), JSON.stringify(summary, null, 2))
const md = [
  `# 编辑器最终审计结果`,
  ``,
  `开始 ${startedAt}，结束 ${summary.finishedAt}；机器 ${summary.machine.cpus} 核 ${summary.machine.model}，负载 ${summary.machine.loadavg.join(' / ')}；浏览器 ${engines.join(', ')}。`,
  ``,
  `通过 ${summary.passed} / ${summary.total}${failed.length ? `，失败：${failed.map((item) => item.name).join('、')}` : ''}。`,
  ``,
  `| 项 | 结果 | 耗时 | 命令 |`,
  `|---|---|---|---|`,
  ...results.map((item) => `| ${item.name} | ${item.ok ? '✓' : `✗（${item.code}）`} | ${item.seconds}s | \`${item.cmd.replace(/\|/g, '\\|').slice(0, 120)}\` |`),
  ``,
  ...failed.flatMap((item) => [`## ${item.name}`, '', '```', ...item.tail, '```', '']),
].join('\n')
writeFileSync(join(OUT, 'final-audit.md'), md)
console.log(`\n通过 ${summary.passed} / ${summary.total}；报告 e2e/out/final-audit.md`)
process.exit(failed.length ? 1 : 0)
