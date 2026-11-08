# 备份与恢复

> 面向运维:从一份 `kb-<时间>.tar.gz` 把知识库恢复到可用状态。
> 下面命令里的 `<KB_HOME>` 换成真实数据目录(默认 `~/.kb`),`<归档名>` 换成 `kb backup list` 里的名字。

一句话:**停守护进程 → 校验归档 → 解包到临时目录 → 覆盖 `<KB_HOME>` → 启动 → 自检 + 重建索引。**

`kb backup` **故意不提供** `restore` 子命令:恢复要覆盖守护进程正在使用的数据库,
做成一条命令后,路径或顺序写错一次就是"把好数据也一起覆盖掉"。所以这里给的是可跟做、
可验收的手工流程,配套两个只读工具:`kb backup verify`(校验)与设置页的「恢复步骤」。

---

## 1. 归档里有什么

| 归档成员 | 说明 |
|---|---|
| `manifest.json` | 生成时间、kb 版本、是否含原件、文件数、被跳过的文件 |
| `meta.db` | SQLite `VACUUM INTO` 一致性快照(项目 / 集合 / 条目 / 任务 / 反馈 / 登录密码哈希 / 令牌哈希) |
| `config.toml` | 配置(全新实例可能还没有) |
| `skills/**` | 声明式 skills |
| `eval/**` | 黄金集与评测历史 |
| `sources/**` | 原件(只有 `include_sources = true` 的备份才有) |
| `system.db` | 多用户:账号库快照(账号、角色、会话、令牌、好友、通知、授权、分享链接、两步验证、用量记账) |
| `spaces/<id>/meta.db` | 多用户:每个用户知识库的元数据库快照(笔记、批注、版本、协作草稿、项目、任务) |
| `spaces/<id>/sources/**` | 多用户:各用户的原件(同样只有含原件的备份才有) |
| `avatars/**` | 用户头像 |

**不在归档里**:`lance/` 与 `spaces/<id>/lance/`(向量与全文索引,重建即可)、`models/`(模型缓存)、
`uploads/`(未完成的分片)、`spaces/<id>/agent-workspace/`(AI 代理的临时工作区)、`exports/`(24 小时后自删的导出包)、
`secrets.toml`(API key)、`logs/`、`run/`。

因此:恢复之后**所有账号的登录密码、令牌、各人的笔记、授权与分享链接、项目与条目都回来了**,
但**LLM 的 key 与向量索引不会**。

多用户部署里,**任何一个库拍不下快照都会让整次备份失败**(并进失败告警):宁可这次没有备份,
也不要一份「成功」却悄悄少了某个人全部数据的备份。`kb backup verify` 会核对 manifest 登记的
`system.db` 与每个 `spaces/<id>/meta.db` 都在归档里,缺任何一个都判定为损坏。
没有任何用户空间的老部署(单用户)归档里就没有这几项,照常能校验、能恢复。

---

## 2. 恢复前:先校验

```bash
kb backup list                                  # 找到要恢复的归档
kb backup verify kb-20261024-101500.tar.gz      # 只读校验(Web 上也能点「校验」)
```

`verify` 会做五件事:

1. 把整份 gzip 解压一遍 —— gzip 的 CRC32 由 zlib 在流末尾校验,能抓到截断与位翻转;
2. 逐个检查 tar 头的 ustar 魔数与校验和;
3. 确认 `manifest.json` 能解析,且它记的文件数与归档里的实际条目数一致;
4. 确认 `meta.db` 在、且文件头是 SQLite(`SQLite format 3\0`);
5. 确认成员里没有绝对路径或 `..` 段(这种归档解包时会写到 `<KB_HOME>` 之外)。

它**不做** SQLite 的 `integrity_check`(那要真的打开数据库)。想更保险,先解到临时目录再查:

```bash
sqlite3 /tmp/kb-restore/meta.db "PRAGMA integrity_check;"
```

**每份归档写完之后会自动跑一遍上面这套检查**(`backup_status.last_check` / `kb backup list` 的
「最近校验」/ 设置页的「最近校验」行),所以通常不需要手动点。校验没过时归档**不会**被删掉
(留作现场证据),但会记一条 `verify` 失败告警,页面横幅上写着
`定时备份的校验在 … 失败:…` —— 这种归档别拿去恢复,换一份更早的。

### 2.1 本机的归档没了,从异地副本恢复

配了 `[backup] mirror_dirs` 时,每份归档在 `<KB_HOME>/backups/` 落盘后还会**再复制一份**到那些目录
(移动硬盘 / NAS / 另一个数据盘)。本机磁盘坏掉、`backups/` 目录被误删时,用副本走同一套流程:

```bash
kb backup list                                  # 每个异地目录一行:几份、最新一份在不在、上次复制时间
ls /mnt/usb/kb-backups                          # 副本与本机归档同名
kb backup verify /mnt/usb/kb-backups/kb-20261024-101500.tar.gz   # 直接校验副本(只读)
mkdir -p /tmp/kb-restore && tar -xzf /mnt/usb/kb-backups/kb-20261024-101500.tar.gz -C /tmp/kb-restore --no-same-owner
```

副本的字节数与本机归档一致(复制是先写 `.part` 再改名,断电不会留下半份);复制完还会**回读比对
sha256**,内容对不上的副本会被删掉并记 `异地副本` 告警 —— 所以异地目录里留着的副本都是验过的。
校验通过就可以按 §3 恢复。

---

## 3. 恢复步骤

### 3.1 停服

```bash
kb service status
sudo systemctl stop kb.service        # 用户级安装去掉 sudo,并把 systemctl 换成 systemctl --user
pgrep -af "kb daemon"                 # 应当没有输出
```

> 别用 `pkill -f "kb daemon"` 一把梭:上一阶段的收尾就误杀过生产守护进程。
> 要停哪个进程,先 `pgrep -af` 看清命令行,再按 pid 停。

### 3.2 先给当前数据留底

```bash
kb backup create --include-sources    # 归档落在 <KB_HOME>/backups/
```

这就是回滚点,别跳过。停服之后 `kb backup create` 仍然可用(它只读数据库、写归档)。

### 3.3 校验要恢复的那份归档

见 §2。校验不过就换一份,**不要**拿坏归档去覆盖。

### 3.4 解包到临时目录

```bash
rm -rf /tmp/kb-restore && mkdir -p /tmp/kb-restore
tar -xzf <KB_HOME>/backups/kb-20261024-101500.tar.gz -C /tmp/kb-restore --no-same-owner
ls -la /tmp/kb-restore
```

应当看到 `manifest.json` / `meta.db` / `config.toml` / `skills` / `eval`(含原件时还有 `sources`);
多用户部署还有 `system.db`、`spaces/`、`avatars/`。

`--no-same-owner`:归档里不携带 uid/gid(写入时固定为 0),以 root 解包时不加这个参数会报
`Cannot change ownership`(解包其实成功,只是满屏噪音)。

### 3.5 覆盖数据目录

```bash
rm -f <KB_HOME>/meta.db-wal <KB_HOME>/meta.db-shm    # 旧 WAL 必须删,否则会和恢复的 meta.db 拼在一起
# 多用户部署:账号库和每个用户的库同理
rm -f <KB_HOME>/system.db-wal <KB_HOME>/system.db-shm
rm -f <KB_HOME>/spaces/*/meta.db-wal <KB_HOME>/spaces/*/meta.db-shm
cp -a /tmp/kb-restore/. <KB_HOME>/
```

- `secrets.toml` 不在归档里,**不要删**它(LLM key 还要用);
- `lance/` 不要动(见 §4);
- 想保留当前配置时,也可以只覆盖 `meta.db`(`config.toml` 留在原地)。

### 3.6 启动并自检

```bash
sudo systemctl start kb.service
kb service status
curl -fsS http://127.0.0.1:7878/api/v1/health    # 端口取 [server] listen;期望 {"status":"ok"}
kb doctor
kb backup list
```

自检口径:健康检查 `ok`、`kb doctor` 没有新增失败项、Web 端能用**恢复那份 `meta.db` 里的密码**登录、
项目列表与条目数与归档时间点一致。

---

## 4. 恢复后:向量索引要重建

**经验条目(笔记)会自动补**:守护进程启动、以及每个用户的知识库第一次被打开时,会检查每个集合的向量表在不在;
缺了就补一张空表,并把该集合里所有经验条目重新投递嵌入(日志里有 `向量表缺失(多半是从备份恢复)` 一条,
带条数),几分钟内陆续恢复可检索,期间条目的正文从元数据库直接读,不受影响。

**项目文件的向量补不回来**(要读原件),需要手工重建。

`lance/` 不在归档里。恢复一份旧的 `meta.db` 之后,向量表里可能还留着 `meta.db` 已经不认识的块
(反过来也可能),检索会出现"命中一条点开却查不到"的情况。

```bash
kb project list                       # 看有哪些项目
kb index <项目名> --full               # 全量重建这个项目(慢,但结果最干净)
kb index --global <目录> --tag <标签>  # 重新导入过 _global 的文档(如果用过 --global)
```

不知道哪些受影响时,就全部 `--full` 一遍。重建只读原件,不碰归档。

---

## 5. 回滚

§3.2 那份归档就是回滚点:按同样的步骤恢复它。**所以 3.2 不能省**。

---

## 6. 常见问题

**`kb backup verify` 报「归档校验失败」** —— 归档坏了(传输截断 / 磁盘位翻转 / 根本不是 kb 的归档)。
换一份,不要拿它恢复。

**`tar` 报 `Cannot change ownership`** —— 忘了 `--no-same-owner`。解包本身是成功的。

**恢复后登录不了 / 项目都不见了** —— 十有八九是没删 `meta.db-wal` / `meta.db-shm`,SQLite 把旧 WAL
重放到新库上了。停服、删掉这两个文件、再启动。

**恢复后检索结果对不上** —— 见 §4,向量表没重建。

**恢复后 LLM 能力失效** —— `secrets.toml` 不在归档里,确认它还在 `<KB_HOME>/`。

**恢复后 Web 页面 401 / 令牌全失效** —— 令牌哈希来自恢复的 `meta.db`;如果归档比当前令牌旧,
重新 `kb auth token create` 一个即可。

**能不能不停服恢复?** —— 不能。守护进程持有 `meta.db` 的连接与 LanceDB 表句柄,热替换会读到半页数据,
或让后续写入落到旧文件上。这也是 `kb backup` 不提供 `restore` 子命令的原因。

---

## 7. 备份失败之后

失败分四处,进的是**同一套告警通道**(`<KB_HOME>/backups/.failures.json` 最多留 20 条 + Web
**任意页面**的横幅 + WS 的 `backup.failed`):

| 环节 | 什么情况会失败 | 横幅上的说法 |
|---|---|---|
| 打包 | 取数据库快照失败、磁盘写满、同名归档已存在 | `定时备份在 … 失败:…` |
| 清理 | 旧归档删不掉(只读挂载、权限、外接盘掉线) | `定时备份的清理在 … 失败:删不掉 N 份:…` |
| 异地副本 | 外部目录建不出来 / 写不进去、副本回读比对 sha256 不一致、清理副本时删不掉 | `定时备份的异地副本在 … 失败:<目录>:<原因>` |
| 校验 | 写完自动校验没通过(归档截断 / 位翻转 / manifest 与实际条目对不上) | `定时备份的校验在 … 失败:自动校验 <归档> 没通过:…` |

- 四处**各自**判定“解决了没有”:之后只要该环节成功一次,这条告警就消失,别的环节成功不会把它冲掉
  (失败历史仍留在设置页「最近的失败记录」里);
- 异地副本失败**不会**让这次备份失败 —— 本机已经有一份,只是少了一份异地副本;
- 自动校验失败**不会**删归档(留作现场证据),但这份归档不该拿去恢复;
- 自动备份失败后按 `min(间隔, 1 小时)` 退避重试,不会每一拍都试;
- 打包过程中设置页有进度条(百分比 / 文件数 / 字节数 / 当前文件 / 复制到异地 / 校验),
  同一份进度也能通过 `backup_state` 能力读到(WS 断开时页面每秒轮询一次)。

---

## 8. 相关命令速查

```bash
kb backup create [--include-sources] [--json]   # 立即备份(复制到 mirror_dirs 并回读比对 sha256,写完自动校验)
kb backup list [--json]                         # 归档、大小、策略、异地副本状态、最近校验
kb backup verify <归档名> [--json]               # 校验(只读,恢复前先跑;也接受异地副本的路径)
kb backup prune [--keep N] [--days N] [--dry-run]  # 按保留策略清理(含异地副本)
kb backup delete <归档名>                       # 删除一份(含异地副本,不可撤销)
```

Web 端「设置 → 备份」是同一套能力,另有:进度条、失败告警、异地副本卡片、最近校验行、每行「校验」、
可复制的「恢复步骤」。

---

## 7. 多用户版本:升级、回滚与预发演练

### 7.1 升级(单用户 → 多用户)是零操作

没有迁移命令。新版本第一次启动时:

- 以根目录里原有的 `meta.db` 为**管理员自己的主知识库**(位置不变,不搬家);
- 用旧的登录密码哈希建出账号 `admin`(角色 admin),旧密码照常能登录;
- 新建 `system.db`(账号库);其余新表随各库的 schema 版本自动升级。

所以升级前**先做一份含原件的备份**(§3.2),并 `kb backup verify` 过。

### 7.2 回滚到旧版本

旧版本不认 `system.db`、`spaces/`,也不会碰它们。回滚步骤:

1. 停服务;
2. 换回旧二进制;
3. 把 `<KB_HOME>/system.db*` 挪走(**不是删**,留着以后再升级时接着用);
4. 启动旧版本。

已用生产上的旧二进制实测(`scripts/rehearse-upgrade.sh`):升级后主知识库的 `meta.db` 从 schema v15 变成 v16,
旧二进制在这个库上照常启动、登录、读到全部旧笔记,不会因为多出来的表而报错。

三个要知道的后果:

- **回滚后的管理员密码是升级前的那个。** 升级时旧密码哈希只是**复制**成 `admin` 账号;
  升级后在新版本里改的密码存在 `system.db`,旧版本看不到。
- **升级期间别人注册的账号和他们空间里的数据**留在 `spaces/` 与 `system.db` 里,回滚期间旧版本看不到它们,
  再升级时(把 `system.db*` 放回去)恢复。
- 回滚期间旧版本写进主知识库的数据,再升级时照常被新版本读到。

回滚前先 `kb backup create --include-sources`:万一旧版本出现没预料到的问题,可以按 §3 回到升级后的状态。

### 7.3 预发演练(上线前在副本上做一遍)

**脚本**:`scripts/rehearse-upgrade.sh <旧二进制> [新二进制]`。它在 `/tmp` 下的临时数据目录里走完
旧版建数据 → 新版升级 → 回滚到旧版 → 再升级,每一步检查旧密码能登录、旧笔记还在,任何一步不对就非零退出。
只读使用旧二进制,不碰生产数据目录(数据目录不在 `/tmp` 或 `/var/tmp` 下时脚本直接拒绝)。

```bash
scripts/rehearse-upgrade.sh /opt/kb/bin/kb target/release/kb
```

脚本覆盖不到、要人工在**生产数据的副本**上再做一遍的:

```bash
# 1. 复制数据目录(守护进程停着,或用含原件的备份归档解包)
mkdir -p /tmp/kb-rehearsal-prod && tar -xzf <含原件的归档> -C /tmp/kb-rehearsal-prod --no-same-owner
# 2. 用新版本起一个守护进程:把 config.toml 里的 [server] listen 改成不冲突的端口
KB_HOME=/tmp/kb-rehearsal-prod kb daemon
# 3. 检查:旧密码能登录、项目与条目数与生产一致、能新建一个用户并共享一条笔记
# 4. 备份 → 解到另一个目录 → 起第二个守护进程 → 每个账号的笔记和分享都在
```

第 4 步已有自动化测试覆盖:`cargo test -p kb-cli --features testkit --test e2e_backup_users`
(真实守护进程里造出账号、笔记、授权与分享链接,备份,解到全新目录起第二个守护进程,
用原密码登录并核对数据、授权关系与分享链接仍然有效)。
