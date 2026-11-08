//! [`BackupService`]:打包、校验、删除,以及给界面用的状态查询。
//!
//! 数据库用 SQLite 自己的 `VACUUM INTO` 取一致性快照(经 [`DbSnapshot`] 端口注入),
//! 所以守护进程在跑的时候也能备份,不需要停服。打包与删除都拿一把进程内锁,
//! 避免「手动备份」和「定时备份」同时往同一个目录写。
//!
//! 定时那一半(`run_auto` / `prune` / 失败记账)在 `schedule.rs`,异地复制在 `mirror.rs`,
//! 都是 `impl BackupService`,只是按职责分文件。

use super::*;

/// 进程级互斥:同一时刻只允许一份备份在跑(归档名精确到秒,并发会写同一个 `.part`)。
///
/// 用 tokio 的异步锁:整段 `create` 里要 `.await` 快照与写线程,std 的守卫不能跨 await 持有。
pub(crate) static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 备份服务。
pub struct BackupService {
    pub(crate) paths: KbPaths,
    pub(crate) snapshot: Arc<dyn DbSnapshot>,
    /// 定时备份与保留策略(`[backup]` 热更新时由组装根就地换掉)。
    pub(crate) policy: std::sync::RwLock<BackupPolicy>,
    /// 进度 / 成功 / 失败的观察者(守护进程接到 WS 上;测试与 CLI 不接)。
    pub(crate) observer: Option<Arc<dyn BackupObserver>>,
    /// 多用户:账号库和各用户知识库的快照器。没有就只备份主知识库(单用户部署 / 老用法)。
    pub(crate) extra: Option<Arc<dyn SqliteSnapshotter>>,
}

impl BackupService {
    /// 用数据目录布局与数据库快照端口构造(策略取 [`BackupPolicy::default`])。
    pub fn new(paths: KbPaths, snapshot: Arc<dyn DbSnapshot>) -> Self {
        Self {
            paths,
            snapshot,
            policy: std::sync::RwLock::new(BackupPolicy::default()),
            observer: None,
            extra: None,
        }
    }

    /// 接上账号库与各用户知识库的快照器:之后每份备份还会带上 `system.db`、
    /// `spaces/<id>/meta.db`(以及含原件时的 `spaces/<id>/sources/**`)和头像。
    #[must_use]
    pub fn with_extra_snapshotter(mut self, snapshotter: Arc<dyn SqliteSnapshotter>) -> Self {
        self.extra = Some(snapshotter);
        self
    }

    /// 换一份策略(组装根用)。
    pub fn with_policy(self, policy: BackupPolicy) -> Self {
        self.set_policy(policy);
        self
    }

    /// 挂上观察者(守护进程用:进度 / 成功 / 失败都推给 Web)。
    pub fn with_observer(mut self, observer: Arc<dyn BackupObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// 就地换策略(`[backup]` 是热更新项,守护进程每拍喂一次)。
    pub fn set_policy(&self, policy: BackupPolicy) {
        *self
            .policy
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = policy;
    }

    /// 当前策略的快照。
    pub fn policy(&self) -> BackupPolicy {
        self.policy
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// 归档目录(`<KB_HOME>/backups`)。
    pub fn dir(&self) -> &Path {
        self.paths.backups_dir()
    }

    /// 配置里配好的异地 / 外部存储目录(绝对路径;相对路径按 `KB_HOME` 解析)。
    ///
    /// 与归档目录相同的项**不在这里剔掉**:那是最容易犯的配置错误,要让它在状态页与告警里
    /// 露出来(复制阶段会报「与归档目录相同」),而不是静默地什么都不做。
    pub fn mirror_dirs(&self) -> Vec<PathBuf> {
        self.policy()
            .mirror_dirs
            .iter()
            .map(|dir| dir.trim())
            .filter(|dir| !dir.is_empty())
            .map(|dir| {
                let path = Path::new(dir);
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.paths.home().join(path)
                }
            })
            .collect()
    }

    /// 列出已有归档与各部分占用。
    pub fn status(&self) -> Result<BackupStatus> {
        let entries = self.entries()?;
        let usage = DataUsage {
            meta_db_bytes: file_size(self.paths.meta_db()),
            lance_bytes: dir_size(self.paths.lance_dir()),
            sources_bytes: dir_size(self.paths.sources_dir()),
            uploads_bytes: dir_size(self.paths.uploads_dir()),
            skills_bytes: dir_size(self.paths.skills_dir()),
            eval_bytes: dir_size(self.paths.eval_dir()),
            config_bytes: file_size(self.paths.config_file())
                + file_size(self.paths.secrets_file()),
            backups_bytes: entries.iter().map(|entry| entry.size_bytes).sum(),
        };
        let policy = self.policy();
        // 下次到点时间:以最新一份归档为基准;已经过期就显示“现在”(别把过去的时间说成“下次”)
        let now = now_millis();
        let next_backup_at = policy.enabled.then(|| match entries.first() {
            Some(newest) => (newest.created_at + policy.interval_millis()).max(now),
            None => now,
        });
        let mirrors = self.mirrors_of(entries.first().map(|entry| entry.name.as_str()));
        Ok(BackupStatus {
 home: self.paths.home().display().to_string(),
 dir: self.dir().display().to_string(),
 last_backup_at: entries.iter().map(|entry| entry.created_at).max(),
 entries,
 policy,
 next_backup_at,
 last_auto: self.last_auto(),
 progress: self.progress(),
 alert: self.alert(),
 failures: self.failures(),
 mirrors,
 last_check: self.last_check(),
 usage,
 notes: vec![
 "备份内容:元数据库、config.toml、skills、评测数据;原件(sources)可选".to_owned(),
 "不备份:向量表与模型(重建索引可恢复)、secrets.toml(含 API key)".to_owned(),
 "元数据库里有登录密码哈希、会话与访问令牌的哈希,归档同样要按机密文件保管".to_owned(),
 "定时备份与保留策略见 [backup]:到点自动打包,超过份数 / 天数的旧归档自动删掉(最新一份永远保留)".to_owned(),
 "异地副本见 [backup] mirror_dirs:每份归档再复制一份到外部目录(移动硬盘 / NAS),清理与删除会同步过去".to_owned(),
 "异地副本复制完会回读比对 sha256;每份归档写完后还会自动校验一次,结果显示在「最近校验」".to_owned(),
 "恢复前先校验归档(kb backup verify 或页面上的「校验」),再按下面「恢复步骤」停服 → 解包 → 启动;完整说明见 docs/BACKUP_RESTORE.md".to_owned(),
 ],
 })
    }

    /// 轻量状态(外壳横幅 / 打包中的轮询):只读进度与失败两个小文件,不统计磁盘占用。
    pub fn state(&self) -> Result<BackupState> {
        Ok(BackupState {
            running: self.progress(),
            alert: self.alert(),
            failures: self.failures(),
            last_success_at: self.entries()?.first().map(|entry| entry.created_at),
        })
    }

    /// 正在进行的打包进度(读 `.progress.json`)。
    ///
    /// 进程被杀时进度文件会留在盘上:超过 [`PROGRESS_STALE_MS`] 没更新就不再当成“正在打包”,
    /// 否则页面会永远显示一个不动的进度条。
    pub fn progress(&self) -> Option<BackupProgress> {
        let text = std::fs::read_to_string(self.dir().join(PROGRESS_FILE)).ok()?;
        let progress: BackupProgress = serde_json::from_str(&text).ok()?;
        if progress.stage.is_running()
            && now_millis().saturating_sub(progress.updated_at) > PROGRESS_STALE_MS
        {
            return None;
        }
        Some(progress)
    }

    /// 最近的失败记录(新的在前;坏文件当作没有)。
    pub fn failures(&self) -> Vec<BackupFailure> {
        self.failure_log().failures
    }

    /// 还没解决的最近一次失败(打包 / 清理 / 异地副本都算)。
    ///
    /// 判据:某个环节最近一次失败晚于**该环节**最近一次成功(定时或手动都算)。
    /// 之后只要该环节成功一次,这条告警就自然消失,不需要额外的“已读”状态;
    /// 别的环节成功不会把它冲掉(清理成功不该撤掉打包失败的横幅)。
    pub fn alert(&self) -> Option<BackupFailure> {
        self.failure_log().alert().cloned()
    }

    /// 已有归档,按时间倒序。
    pub fn entries(&self) -> Result<Vec<BackupEntry>> {
        let dir = self.dir();
        let read = match std::fs::read_dir(dir) {
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => {
                return Err(KbError::Internal(format!(
                    "读取备份目录 {} 失败: {err}",
                    dir.display()
                )));
            }
        };
        let mut entries = Vec::new();
        for item in read {
            let item = item.map_err(|err| {
                KbError::Internal(format!("读取备份目录 {} 失败: {err}", dir.display()))
            })?;
            let name = item.file_name().to_string_lossy().to_string();
            // 跳过写了一半的临时文件(`.` 开头)与不是归档的东西
            if name.starts_with('.') || !name.ends_with(ARCHIVE_EXT) {
                continue;
            }
            let meta = match item.metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if !meta.is_file() {
                continue;
            }
            entries.push(BackupEntry {
                name,
                size_bytes: meta.len(),
                created_at: mtime_millis(&meta),
                skipped: 0,
            });
        }
        entries.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.name.cmp(&left.name))
        });
        Ok(entries)
    }

    /// 新建一份备份(手动触发),返回归档信息。
    pub async fn create(&self, options: &BackupOptions) -> Result<BackupEntry> {
        self.create_with(options, BackupTrigger::Manual).await
    }

    /// 新建一份备份,并记下触发方式(定时备份用 `Auto`)。
    ///
    /// 失败时把「时间 + 触发方式 + 原因」记进 `backups/.failures.json` 并推给观察者 ——
    /// 不管失败发生在哪一步(建目录 / 快照 / 打包 / 落盘),都在这一层收口。
    /// 归档落盘后复制到异地目录的失败**不算**这次备份失败(本机已经有一份),
    /// 但同样记一条 [`BackupFailureKind::Mirror`] 失败,横幅与设置页都能看到。
    /// 写完之后自动跑的那次校验如果没过,也只记 [`BackupFailureKind::Verify`] 告警 ——
    /// 归档留着当现场证据,但“这份备份解不开”必须让人看见。
    pub async fn create_with(
        &self,
        options: &BackupOptions,
        trigger: BackupTrigger,
    ) -> Result<BackupEntry> {
        match self.create_inner(options).await {
            Ok((entry, mirrors, check)) => {
                self.record_success(BackupFailureKind::Pack);
                self.record_mirrors(&mirrors, trigger);
                self.record_check(&entry.name, trigger, check);
                if let Some(observer) = &self.observer {
                    observer.done(&entry, trigger);
                }
                Ok(entry)
            }
            Err(err) => {
                self.record_failure(trigger, BackupFailureKind::Pack, failure_reason(&err));
                Err(err)
            }
        }
    }

    /// 真正干活的那一层(不管进度与失败记录)。
    ///
    /// 进程内串行:归档名只精确到秒,并发调用会撞同一个临时文件。
    /// 返回归档信息、每个异地目录的复制结果(复制失败由 [`BackupService::create_with`] 记账)
    /// 与写完之后那次自动校验的结果(同上)。
    pub(crate) async fn create_inner(
        &self,
        options: &BackupOptions,
    ) -> Result<(BackupEntry, Vec<MirrorOutcome>, Result<ArchiveCheck>)> {
        let _guard = CREATE_LOCK.lock().await;
        let dir = self.dir().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|err| {
            KbError::Internal(format!("创建备份目录 {} 失败: {err}", dir.display()))
        })?;

        // 进度从“准备中”开始:取快照可能就要几秒,这段时间页面也该有反馈
        let mut sink = ProgressSink::new(dir.clone(), self.observer.clone());
        sink.stage(BackupStage::Preparing);

        let created_at = now_millis();
        let name = format!("kb-{}{ARCHIVE_EXT}", timestamp_text(created_at));
        let final_path = dir.join(&name);
        if final_path.exists() {
            return Err(KbError::InvalidInput(format!(
                "同名备份已存在:{}",
                final_path.display()
            )));
        }

        // 数据库先取一致性快照,再和其余文件一起打归档
        let snapshot_path = dir.join(format!(".snapshot-{created_at}.db"));
        if let Err(err) = self.snapshot.snapshot_to(&snapshot_path).await {
            sink.finish(BackupStage::Failed, Some(err.to_string()));
            return Err(err);
        }

        let sources = options.include_sources;
        let config_file = self.paths.config_file().to_path_buf();
        let skills_dir = self.paths.skills_dir().to_path_buf();
        let eval_dir = self.paths.eval_dir().to_path_buf();
        let sources_dir = self.paths.sources_dir().to_path_buf();
        let extra_paths = self.paths.clone();
        let extra_snapshotter = self.extra.clone();

        let part_path = dir.join(format!(".{name}.part"));
        let write_part = part_path.clone();
        let part_for_task = part_path;
        let final_for_task = final_path;
        let name_for_task = name.clone();
        let archive_dir = dir.clone();
        // 异地目录在打包前就解析好:复制阶段不能再读策略(热更新中途换掉会让计数对不上)
        let mirror_dirs = self.mirror_dirs();
        let snapshot_for_task = snapshot_path.clone();
        let written = tokio::task::spawn_blocking(move || {
            // 多用户:账号库、各用户知识库的元数据库(和含原件时的原件)、头像
            let extras = match &extra_snapshotter {
                Some(snapshotter) => gather_extras(
                    &extra_paths,
                    snapshotter.as_ref(),
                    &archive_dir,
                    created_at,
                    sources,
                ),
                None => Ok(Extras::default()),
            };
            let extras = match extras {
                Ok(extras) => extras,
                Err(err) => {
                    sink.finish(BackupStage::Failed, Some(err.to_string()));
                    return Err(err);
                }
            };
            let result = write_archive(
                &write_part,
                created_at,
                sources,
                &config_file,
                &snapshot_for_task,
                &skills_dir,
                &eval_dir,
                if sources { Some(&sources_dir) } else { None },
                &extras,
                &mut sink,
            )
            .and_then(|(size_bytes, skipped)| {
                // 改名落盘与异地复制都放在这个阻塞线程里:大归档的复制也要能推进度
                std::fs::rename(&part_for_task, &final_for_task).map_err(|err| {
                    KbError::Internal(format!(
                        "备份归档落盘 {} 失败: {err}",
                        final_for_task.display()
                    ))
                })?;
                let mirrors = mirror_archive_to_all(
                    &final_for_task,
                    &archive_dir,
                    &name_for_task,
                    &mirror_dirs,
                    &mut sink,
                );
                // 写完之后自己验一遍:等用户手点「校验」才发现归档解不开就太晚了
                sink.stage(BackupStage::Verifying);
                let check = check_archive(&final_for_task, &name_for_task, size_bytes);
                Ok((size_bytes, skipped, mirrors, check))
            });
            // 其它库的快照是中间产物,打完包(成败都一样)就删
            for temp in &extras.temps {
                let _ = std::fs::remove_file(temp);
            }
            // 收尾一定要走:进度文件不删的话,页面会一直显示“打包中”
            match &result {
                Ok(_) => sink.finish(BackupStage::Done, None),
                Err(err) => {
                    // 半成品不能留:失败后归档目录里只该有归档与状态文件
                    let _ = std::fs::remove_file(&part_for_task);
                    sink.finish(BackupStage::Failed, Some(err.to_string()));
                }
            }
            result
        })
        .await
        .map_err(|err| KbError::Internal(format!("备份写线程异常: {err}")))?;

        // 快照是中间产物,成功与否都删掉
        let _ = std::fs::remove_file(&snapshot_path);

        let (size_bytes, skipped, mirrors, check) = written?;
        if !skipped.is_empty() {
            tracing::warn!(
                count = skipped.len(),
                "备份跳过了部分文件(详见归档里的 manifest.json)"
            );
        }

        Ok((
            BackupEntry {
                name,
                size_bytes,
                created_at,
                skipped: skipped.len() as u64,
            },
            mirrors,
            check,
        ))
    }

    /// 校验一份归档(**只读**,不解包到 `KB_HOME`)。
    ///
    /// 检查四件事:gzip 流完整(CRC32 由 flate2 在流末尾校验)、每个 tar 头的校验和与格式、
    /// `manifest.json` 与 `meta.db` 都在且自洽(文件数对得上、meta.db 是 SQLite 文件)、
    /// 没有绝对路径或 `..` 这类解包时会写到 `KB_HOME` 之外的成员。
    ///
    /// 恢复流程的第一步就是它:`kb backup verify <归档名>`(见 `docs/BACKUP_RESTORE.md`)。
    /// 也可以直接给**路径**(异地副本 / 手工拷出来的归档),校验是只读的。
    ///
    /// 它**不写** `backups/.verify.json` —— 那份记录只由备份写完时的自动校验更新
    /// (见 [`BackupService::last_check`]),否则「最近校验」会变成“最后一次有人点过校验”。
    pub fn verify(&self, name: &str) -> Result<ArchiveCheck> {
        let trimmed = name.trim();
        // 带 `/` 的当成路径:异地副本 / 手工拷出来的文件直接校验,不用先挪回 backups/。
        // 只有 verify 认路径(它是只读的);删除与清理仍只认文件名,免得误删别处的文件。
        let path = if trimmed.contains('/') {
            if !trimmed.ends_with(ARCHIVE_EXT) {
                return Err(KbError::InvalidInput(format!(
                    "不是备份归档(应以 {ARCHIVE_EXT} 结尾):{name}"
                )));
            }
            PathBuf::from(trimmed)
        } else {
            self.resolve(trimmed)?
        };
        let shown = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| trimmed.to_owned());
        let meta = match std::fs::metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(KbError::NotFound(format!("备份不存在:{name}")));
            }
            Err(err) => {
                return Err(KbError::Internal(format!(
                    "读取归档 {} 失败: {err}",
                    path.display()
                )));
            }
        };
        check_archive(&path, &shown, meta.len())
    }

    /// 删除一份备份(连同异地副本)。
    ///
    /// 本机那份删不掉 → 返回错误(与原来一致);异地副本删不掉不影响本机删除的结果,
    /// 但会记一条 [`BackupFailureKind::Mirror`] 告警 —— 否则副本会悄悄变成“删不掉的历史”。
    pub fn delete(&self, name: &str) -> Result<()> {
        self.delete_local(name)?;
        for (where_, reason) in self.delete_mirrors(name) {
            self.record_failure(
                BackupTrigger::Manual,
                BackupFailureKind::Mirror,
                format!("删除异地副本 {where_}:{reason}"),
            );
        }
        Ok(())
    }

    /// 只删本机归档目录里的那一份(清理内部用:异地副本由 `prune` 单独记账)。
    pub(crate) fn delete_local(&self, name: &str) -> Result<()> {
        let path = self.resolve(name)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(KbError::NotFound(format!("备份不存在:{name}")))
            }
            Err(err) => Err(KbError::Internal(format!(
                "删除备份 {} 失败: {err}",
                path.display()
            ))),
        }
    }

    /// 从每个异地目录里删掉同名归档,返回失败项(`<目录>/<归档名>`, 原因)。
    ///
    /// 副本本来就不在(没配异地目录 / 上次没复制成功)不算失败。
    pub(crate) fn delete_mirrors(&self, name: &str) -> Vec<(String, String)> {
        let trimmed = name.trim();
        let mut failed = Vec::new();
        for dir in self.mirror_dirs() {
            let path = dir.join(trimmed);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    tracing::warn!(archive = %path.display(), error = %err, "删除异地副本失败");
                    failed.push((path.display().to_string(), err.to_string()));
                }
            }
        }
        failed
    }

    /// 把归档名解析成路径,顺带挡住路径穿越。
    pub(crate) fn resolve(&self, name: &str) -> Result<PathBuf> {
        let trimmed = name.trim();
        let valid = !trimmed.is_empty()
            && trimmed.ends_with(ARCHIVE_EXT)
            && !trimmed.starts_with('.')
            && !trimmed.contains('/')
            && !trimmed.contains('\\')
            && !trimmed.contains("..");
        if !valid {
            return Err(KbError::InvalidInput(format!("备份名不合法:{name}")));
        }
        Ok(self.dir().join(trimmed))
    }
}
