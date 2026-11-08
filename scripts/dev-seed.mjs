// 开发实例种子数据:登录后灌入一批通用示例笔记(不含任何生产内容),覆盖标题、列表、表格、提示块、双链、代码。
// 用法: scripts/dev-instance.sh seed   (需要 daemon 已启动、已设密码)
// 多用户版本会在这里加入示例用户、好友和分享;现在的单用户版本只建笔记。

const BASE = process.env.KB_DEV_BASE ?? 'http://127.0.0.1:27878'
const PASSWORD = process.env.KB_DEV_PASSWORD ?? 'dev-pass-123'
const COLLECTION = process.env.KB_DEV_COLLECTION ?? '_global'

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kb-csrf': '1' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok) {
  console.error(`登录失败(${login.status}):先运行 scripts/dev-instance.sh passwd`)
  process.exit(1)
}
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

async function call(name, args) {
  const response = await fetch(`${BASE}/api/v1/capabilities/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kb-csrf': '1', cookie },
    body: JSON.stringify(args),
  })
  const body = await response.json()
  if (!body.ok) throw new Error(`${name}: ${body.error?.message ?? response.status}`)
  return body.data
}

const NOTES = [
  {
    title: '欢迎使用知识库',
    kind: 'note',
    tags: ['入门'],
    body: `## 这是什么\n\n一个本地优先的知识库:把笔记、文档、代码索引起来,检索时按语义和关键词一起找。\n\n> [!TIP]\n> 在笔记里输入 \`/\` 可以插入标题、表格、提示块和图片。\n\n## 常用操作\n\n- 新建笔记:左上角「新建」\n- 搜索:顶部搜索框或 ⌘K\n- 分享:文档右上角「分享」(多用户版本)\n`,
  },
  {
    title: '会议纪要模板',
    kind: 'howto',
    tags: ['模板', '会议'],
    body: `## 基本信息\n\n| 项目 | 内容 |\n|---|---|\n| 时间 | 2026-01-01 10:00 |\n| 参与人 | 张三、李四 |\n\n## 结论\n\n1. 确认上线时间\n2. 指定负责人\n\n## 待办\n\n- [ ] 整理需求清单\n- [x] 发出会议纪要\n`,
  },
  {
    title: '部署清单',
    kind: 'convention',
    tags: ['运维'],
    body: `## 发布前\n\n- 备份数据库\n- 在预发环境跑一遍冒烟测试\n\n> [!WARNING]\n> 生产环境发布前必须先确认回滚步骤。\n\n## 发布命令\n\n\`\`\`bash\nscripts/deploy.sh main\n\`\`\`\n`,
  },
  {
    title: '检索调优记录',
    kind: 'decision',
    tags: ['检索', '性能'],
    body: `## 背景\n\n中文查询召回偏低。\n\n## 决定\n\n关键词检索使用中文分词,与向量检索按 RRF 融合。\n\n## 影响\n\n- 召回提升\n- 索引体积略增\n`,
  },
  {
    title: '常见问题:连不上服务',
    kind: 'pitfall',
    tags: ['排错'],
    body: `## 现象\n\n页面一直转圈,刷新后提示登录过期。\n\n## 原因\n\n守护进程重启期间连接被断开。\n\n## 做法\n\n等待 10 秒后刷新;仍不行时查看日志。\n`,
  },
  {
    title: '读书笔记:信息架构',
    kind: 'note',
    tags: ['读书'],
    body: `## 要点\n\n信息架构关心的是**怎么组织、怎么命名、怎么找到**。\n\n- 分类要互斥\n- 命名要用用户的词\n- 导航不超过两层\n\n## 摘录\n\n> 让人找得到,比让页面好看更重要。\n`,
  },
  {
    title: '周报:第 1 周',
    kind: 'note',
    tags: ['周报'],
    body: `## 本周完成\n\n- 完成登录页改版\n- 修复上传失败的问题\n\n## 下周计划\n\n- 开始多用户开发\n`,
  },
  {
    title: '术语表',
    kind: 'convention',
    tags: ['规范'],
    body: `| 术语 | 含义 |\n|---|---|\n| 笔记 | 一篇可编辑的文档 |\n| 知识库 | 一个用户的全部内容 |\n| 集合 | 知识库里的分组 |\n| 协作者 | 被授权访问文档的人 |\n`,
  },
]

let created = 0
for (const note of NOTES) {
  try {
    await call('create_item', { collection: COLLECTION, title: note.title, body: note.body, kind: note.kind, tags: note.tags })
    created += 1
  } catch (error) {
    console.error(`创建「${note.title}」失败:${error.message}`)
  }
}
console.log(`已创建 ${created}/${NOTES.length} 条示例笔记(集合 ${COLLECTION})`)
