//! (占位)
//!
//! 由 `config.rs` 的 `#[cfg(test)] mod tests` 摊平而来:
//! 单测跟实现分开住,实现文件只留结构。

use super::*;

#[test]
fn default_config_roundtrips_through_toml() {
    let config = Config::default();
    let text = toml::to_string(&config).expect("serialize default config");
    let parsed: Config = toml::from_str(&text).expect("parse serialized config");
    assert_eq!(parsed, config, "默认配置序列化后必须能原样解析回来");
}

/// :`[accel]` 的 ngl / roles 缺省值,以及 roles 是「白名单」而不是「开关」。
#[test]
fn accel_roles_default_to_both_and_can_be_narrowed() {
    let base = AccelConfig::default();
    assert_eq!(base.ngl, 99, "默认全放显卡");
    assert!(base.role_enabled("embed") && base.role_enabled("rerank"));

    let narrowed: Config = toml::from_str(
        r#"
 [accel]
 enabled = true
 ngl = 0
 roles = [" Rerank "]
 "#,
    )
    .expect("解析配置");
    assert_eq!(narrowed.accel.ngl, 0, "填 0 = 纯 CPU");
    // 大小写与首尾空白不敏感:手写配置时很容易写成 "Rerank"
    assert!(narrowed.accel.role_enabled("rerank"));
    assert!(!narrowed.accel.role_enabled("embed"));
    // 没写 roles 的老配置:两路都起(行为不变)
    let legacy: Config = toml::from_str("[accel]\nenabled = true\n").expect("解析配置");
    assert!(legacy.accel.role_enabled("embed") && legacy.accel.role_enabled("rerank"));
}

/// R1b:`vector_index_min_rows` 默认 1 万;老配置没写这项时也走新默认(不用改配置文件)。
#[test]
fn vector_index_threshold_defaults_to_ten_thousand() {
    assert_eq!(IndexConfig::default().vector_index_min_rows, 10_000);
    let config: Config = toml::from_str("[index]\nwatch = false\n").expect("解析配置");
    assert_eq!(config.index.vector_index_min_rows, 10_000);
}

#[test]
fn partial_config_keeps_defaults() {
    let config: Config = toml::from_str(
        r#"
 [search]
 k = 3
 "#,
    )
    .expect("parse partial config");
    assert_eq!(config.search.k, 3);
    assert_eq!(config.search.rrf_k, 60);
    // 查询向量缓存:条数与 TTL 都有默认值,老配置里没写这两项时按默认走
    assert_eq!(config.search.query_cache_entries, 512);
    assert_eq!(config.search.query_cache_ttl_secs, 900);
    // 并发上限不写出配置:按核数自动算,老配置文件不用改
    assert_eq!(config.search.max_concurrency, None);
    // 排队上限有保守默认;不写这项的老配置也能直接跑
    assert_eq!(config.search.max_queue, 256);
    assert_eq!(config.server.listen, "127.0.0.1:7878");
    assert_eq!(config.index.exclude.len(), 13);
    config.validate().expect("partial config is valid");
}

#[test]
fn invalid_listen_address_is_rejected() {
    let mut config = Config::default();
    config.server.listen = "not-an-address".to_owned();
    assert!(matches!(
    config.validate(),
    Err(KbError::InvalidInput(msg)) if msg.contains("listen")
    ));
}

#[test]
fn non_loopback_listen_requires_allow_remote() {
    let mut config = Config::default();
    config.server.listen = "0.0.0.0:7878".to_owned();
    assert!(config.validate().is_err(), "非回环地址未授权时必须被拒绝");

    config.server.allow_remote = true;
    config.validate().expect("授权后应通过");

    config.server.listen = "[::]:7878".to_owned();
    config
        .validate()
        .expect("IPv6 任意地址同样由 allow_remote 控制");
}

#[test]
fn loopback_variants_are_accepted() {
    for listen in ["127.0.0.1:7878", "127.0.0.53:1", "[::1]:7878"] {
        let mut config = Config::default();
        config.server.listen = listen.to_owned();
        config
            .validate()
            .unwrap_or_else(|err| panic!("{listen} 应被接受: {err}"));
    }
}

#[test]
fn batch_size_range_is_enforced() {
    for (batch, ok) in [
        (1usize, true),
        (8, true),
        (64, true),
        (0, false),
        (65, false),
    ] {
        let mut config = Config::default();
        config.embed.batch_size = batch;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "batch_size = {batch} 的校验结果不对"
        );
    }
}

#[test]
fn read_pool_range_is_enforced() {
    // :默认 4、上限 8(写连接恒为 1)
    assert_eq!(Config::default().meta.read_pool, 4);
    for (pool, ok) in [(1usize, true), (4, true), (8, true), (0, false), (9, false)] {
        let mut config = Config::default();
        config.meta.read_pool = pool;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "read_pool = {pool} 的校验结果不对"
        );
    }
}

#[test]
fn consolidate_ranges_are_enforced() {
    // :主题归纳的阈值 / 主题条数 / 一次最多几个主题
    let defaults = Config::default().evolution;
    assert!((defaults.consolidate_similarity - 0.80).abs() < 1e-9);
    assert_eq!(defaults.consolidate_min_members, 2);
    assert_eq!(defaults.consolidate_max_clusters, 5);
    assert!(defaults.nightly_dedup, "夜间去重默认开启");
    for (similarity, ok) in [
        (0.0f64, true),
        (0.8, true),
        (1.0, true),
        (-0.1, false),
        (1.1, false),
    ] {
        let mut config = Config::default();
        config.evolution.consolidate_similarity = similarity;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "consolidate_similarity = {similarity} 的校验结果不对"
        );
    }
    for (members, ok) in [(1usize, false), (2, true), (20, true)] {
        let mut config = Config::default();
        config.evolution.consolidate_min_members = members;
        assert_eq!(config.validate().is_ok(), ok, "min_members = {members}");
    }
    for (clusters, ok) in [(0usize, false), (1, true), (50, true), (51, false)] {
        let mut config = Config::default();
        config.evolution.consolidate_max_clusters = clusters;
        assert_eq!(config.validate().is_ok(), ok, "max_clusters = {clusters}");
    }
}

#[test]
fn backup_defaults_and_ranges_are_enforced() {
    // 默认:开启、每天一次、留 7 份、不按天清、不含原件
    let defaults = Config::default().backup;
    assert!(defaults.enabled, "定时备份默认开启");
    assert_eq!(defaults.interval_hours, 24);
    assert_eq!(defaults.keep_count, 7);
    assert_eq!(defaults.keep_days, 0);
    assert!(!defaults.include_sources);
    Config::default().validate().expect("默认备份配置应合法");

    for (hours, ok) in [
        (0u64, false),
        (1, true),
        (24, true),
        (720, true),
        (721, false),
    ] {
        let mut config = Config::default();
        config.backup.interval_hours = hours;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "backup.interval_hours = {hours} 的校验结果不对"
        );
    }
    // 保留策略:0 表示“不按这一维清理”,是合法值;超过上限被拒
    for (keep_count, ok) in [(0u64, true), (7, true), (365, true), (366, false)] {
        let mut config = Config::default();
        config.backup.keep_count = keep_count;
        assert_eq!(config.validate().is_ok(), ok, "keep_count = {keep_count}");
    }
    for (keep_days, ok) in [(0u64, true), (30, true), (3650, true), (3651, false)] {
        let mut config = Config::default();
        config.backup.keep_days = keep_days;
        assert_eq!(config.validate().is_ok(), ok, "keep_days = {keep_days}");
    }
    // 未知键被拒(`deny_unknown_fields`),避免把拼错的策略名当成默认值
    assert!(toml::from_str::<Config>("[backup]\nkeep_counts = 3\n").is_err());
}

#[test]
fn web_extract_defaults_and_ranges_are_enforced() {
    // :新建网页来源默认打开 AI 规范化;单次 24000 字、最多 4 段、每次同步最多 50 页
    let defaults = Config::default().web_extract;
    assert!(defaults.enabled_by_default);
    assert_eq!(defaults.max_input_chars, 24_000);
    assert_eq!(defaults.max_parts, 4);
    assert_eq!(defaults.max_pages_per_sync, 50);
    for (chars, ok) in [
        (1_999usize, false),
        (2_000, true),
        (200_000, true),
        (200_001, false),
    ] {
        let mut config = Config::default();
        config.web_extract.max_input_chars = chars;
        assert_eq!(config.validate().is_ok(), ok, "max_input_chars = {chars}");
    }
    for (parts, ok) in [(0usize, false), (1, true), (20, true), (21, false)] {
        let mut config = Config::default();
        config.web_extract.max_parts = parts;
        assert_eq!(config.validate().is_ok(), ok, "max_parts = {parts}");
    }
    for (pages, ok) in [(0usize, false), (1, true), (200, true), (201, false)] {
        let mut config = Config::default();
        config.web_extract.max_pages_per_sync = pages;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "max_pages_per_sync = {pages}"
        );
    }
    // 只写要改的键;拼错的键被拒
    let parsed: Config = toml::from_str("[web_extract]\nmax_parts = 2\n").expect("合法的部分配置");
    assert_eq!(parsed.web_extract.max_parts, 2);
    assert_eq!(parsed.web_extract.max_input_chars, 24_000);
    assert!(toml::from_str::<Config>("[web_extract]\nmax_part = 2\n").is_err());
}

#[test]
fn backup_mirror_dirs_are_optional_but_validated() {
    // 默认不复制到异地
    assert!(Config::default().backup.mirror_dirs.is_empty());
    Config::default().validate().expect("默认应合法");

    // 绝对路径与相对 KB_HOME 的路径都接受
    let mut config = Config::default();
    config.backup.mirror_dirs = vec!["/mnt/usb/kb-backups".to_owned(), "offsite".to_owned()];
    config.validate().expect("合法目录应通过");

    // 空串 / 全空白 / `..` 段 / 超过上限 都被拒
    for bad in [
        vec![String::new()],
        vec![" ".to_owned()],
        vec!["../escape".to_owned()],
        vec!["/mnt/../etc".to_owned()],
    ] {
        let mut config = Config::default();
        config.backup.mirror_dirs = bad.clone();
        let error = config.validate().expect_err(&format!("{bad:?} 应被拒"));
        assert!(
            error.to_string().contains("mirror_dirs"),
            "错误文案要指向 mirror_dirs:{error}"
        );
    }
    let mut too_many = Config::default();
    too_many.backup.mirror_dirs = (0..=BackupConfig::MAX_MIRROR_DIRS)
        .map(|index| format!("/mnt/disk{index}"))
        .collect();
    let error = too_many.validate().expect_err("超过上限应被拒");
    assert!(error.to_string().contains("最多"), "{error}");

    // TOML 里直接写数组
    let parsed: Config =
        toml::from_str("[backup]\nmirror_dirs = [\"/mnt/usb/kb\"]\n").expect("解析");
    assert_eq!(parsed.backup.mirror_dirs, vec!["/mnt/usb/kb".to_owned()]);
    // 省略时是空数组(旧配置文件照样能读)
    let parsed: Config = toml::from_str("[backup]\nkeep_count = 3\n").expect("解析");
    assert!(parsed.backup.mirror_dirs.is_empty());
}

#[test]
fn upload_ranges_are_enforced() {
    // :分片大小 / 嵌套层数 / 压缩比的取值范围
    assert_eq!(Config::default().upload.chunk_mb, 8);
    assert_eq!(Config::default().upload.max_file_mb, 512);
    assert_eq!(Config::default().upload.unpack_max_depth, 3);
    for (chunk_mb, ok) in [(1u64, true), (8, true), (64, true), (0, false), (65, false)] {
        let mut config = Config::default();
        config.upload.chunk_mb = chunk_mb;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "upload.chunk_mb = {chunk_mb} 的校验结果不对"
        );
    }
    for (depth, ok) in [(1u32, true), (3, true), (0, false), (9, false)] {
        let mut config = Config::default();
        config.upload.unpack_max_depth = depth;
        assert_eq!(
            config.validate().is_ok(),
            ok,
            "upload.unpack_max_depth = {depth} 的校验结果不对"
        );
    }
    let mut config = Config::default();
    config.upload.unpack_max_ratio = 1;
    assert!(config.validate().is_err(), "解压倍数至少为 2");
    let mut config = Config::default();
    config.upload.max_file_mb = 0;
    assert!(config.validate().is_err(), "单文件上限必须大于 0");
}

#[test]
fn load_returns_default_when_file_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::load(dir.path().join("config.toml")).expect("missing file is fine");
    assert_eq!(config, Config::default());
}

#[test]
fn load_parses_file_and_validates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "[embed]\nbatch_size = 4\n").expect("write config");
    let config = Config::load(&path).expect("load config");
    assert_eq!(config.embed.batch_size, 4);

    std::fs::write(&path, "[server]\nlisten = \"bad\"\n").expect("write bad config");
    assert!(matches!(Config::load(&path), Err(KbError::InvalidInput(_))));
}

#[test]
fn load_rejects_malformed_toml() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "[server\nlisten = 1\n").expect("write malformed config");
    assert!(matches!(Config::load(&path), Err(KbError::InvalidInput(_))));
}

#[test]
fn diff_of_identical_configs_is_empty() {
    let config = Config::default();
    let diff = config.diff(&config.clone());
    assert!(diff.is_empty(), "同一份配置不应有差异:{diff:?}");
    assert!(diff.hot().is_empty() && diff.restart_required().is_empty());
}

#[test]
fn diff_reports_hot_keys_by_dotted_leaf_name() {
    // :热更新白名单里的项按点号叶子键报出来
    let current = Config::default();
    let mut next = current.clone();
    next.search.k = 3;
    next.rerank.mode = "off".to_owned();
    next.schedule.nightly_at = "04:30".to_owned();
    next.log.level = "debug".to_owned();
    next.index.exclude.push("**/fixtures/**".to_owned());
    let diff = current.diff(&next);
    assert_eq!(
        diff.hot(),
        vec![
            "index.exclude".to_owned(),
            "log.level".to_owned(),
            "rerank.mode".to_owned(),
            "schedule.nightly_at".to_owned(),
            "search.k".to_owned(),
        ],
        "热更新项应按点号键排序返回:{diff:?}"
    );
    assert!(diff.restart_required().is_empty());
    assert!(diff.migration().is_empty());
}

#[test]
fn diff_separates_restart_and_migration_keys() {
    let current = Config::default();
    let mut next = current.clone();
    // 只在启动时读一次的项
    next.server.listen = "127.0.0.1:7999".to_owned();
    next.index.watch = false;
    next.upload.chunk_mb = 4;
    // embedder 改动:必须迁移
    next.embed.model = "bge-small".to_owned();
    let diff = current.diff(&next);
    assert_eq!(
        diff.restart_required(),
        vec![
            "index.watch".to_owned(),
            "server.listen".to_owned(),
            "upload.chunk_mb".to_owned()
        ],
        "其余项一律算“要重启”:{diff:?}"
    );
    assert_eq!(diff.migration(), vec!["embed.model".to_owned()]);
    assert!(diff.hot().is_empty());
}

/// H4:`embed.*` 里只有会改变向量内容的键才要先迁移;
/// 卸载时间、线程数、启动预加载只在启动时读一次,最多提示重启,
/// 不能因为改了它们就让整份配置(包括同时改的热更新项)都不生效。
#[test]
fn only_vector_changing_embed_keys_require_migration() {
    for key in [
        "embed",
        "embed.backend",
        "embed.model",
        "embed.max_tokens",
        "embed.compat_group",
        "embed.batch_size",
        "embed.http.url",
        "embed.http.model",
        "embed.http.dim",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Migration, "{key}");
    }
    for key in [
        "embed.idle_unload_minutes",
        "embed.threads",
        "embed.preload",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Restart, "{key}");
    }

    // 只改卸载时间:不需要迁移,配置整体生效,只提示重启
    let current = Config::default();
    let mut next = current.clone();
    next.embed.idle_unload_minutes = 15;
    next.search.k = 12;
    let diff = current.diff(&next);
    assert!(diff.migration().is_empty(), "{diff:?}");
    assert_eq!(
        diff.restart_required(),
        vec!["embed.idle_unload_minutes".to_owned()]
    );
    assert_eq!(diff.hot(), vec!["search.k".to_owned()]);
}

#[test]
fn session_roots_default_to_the_two_client_dirs_and_are_hot_reloadable() {
    let config = Config::default();
    assert_eq!(
        config.evolution.session_roots,
        vec!["~/.claude".to_owned(), "~/.kiro".to_owned()]
    );
    // 热更新:部署后改配置就能生效,不必重启守护进程
    assert_eq!(classify_change("evolution.session_roots"), ChangeScope::Hot);

    // 绝对路径 / ~ 开头都可以
    let mut custom = config.clone();
    custom.evolution.session_roots =
        vec!["~/.claude".to_owned(), "/home/user/.codeg/.kiro".to_owned()];
    custom.validate().expect("绝对路径应通过");

    // `~foo` 既不是绝对路径、也不是 `~/` 开头:拒绝(否则永远匹配不上)
    let mut tilde_name = config.clone();
    tilde_name.evolution.session_roots = vec!["~foo".to_owned()];
    let error = tilde_name.validate().expect_err("~foo 应被拒");
    assert!(error.to_string().contains("~/"), "{error}");

    // 单独一个 `~` 等价于 $HOME,允许
    let mut just_tilde = config.clone();
    just_tilde.evolution.session_roots = vec!["~".to_owned()];
    just_tilde.validate().expect("~ 应通过");

    // 空目录与相对路径被拒
    let mut empty = config.clone();
    empty.evolution.session_roots = vec![" ".to_owned()];
    let error = empty.validate().expect_err("空目录应被拒");
    assert!(error.to_string().contains("session_roots"), "{error}");

    let mut relative = config.clone();
    relative.evolution.session_roots = vec!["sessions".to_owned()];
    let error = relative.validate().expect_err("相对路径应被拒");
    assert!(error.to_string().contains("绝对路径"), "{error}");
}

#[test]
fn classify_change_covers_the_whole_hot_whitelist() {
    // 白名单外的段落(以及未知键)都算重启,避免“悄悄热更了不该热更的项”
    for key in [
        "search.k",
        "search.mcp_max_output_chars",
        "rerank.top_n",
        "schedule.optimize_interval_minutes",
        // 备份策略每拍调度重读(守护进程把新策略喂给调度器)
        "backup.enabled",
        "backup.interval_hours",
        "backup.keep_count",
        "backup.keep_days",
        "backup.include_sources",
        "backup.mirror_dirs",
        "web_extract.enabled_by_default",
        "web_extract.max_input_chars",
        "web_extract.max_parts",
        "web_extract.max_pages_per_sync",
        "log.level",
        "index.exclude",
        "index.parallel_slices",
        "index.parallel_files",
        "evolution.session_roots",
        // LLM 每次调用都从 ConfigStore 读(提供商 / 地址 / 模型 / 额度)
        "llm.daily_token_budget",
        "llm.max_calls_per_hour",
        "llm.provider",
        "llm.base_url",
        "llm.extract_model",
        "llm.review_model",
        "llm.agent_model",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Hot, "{key} 应热更新");
    }
    for key in [
        "embed",
        "embed.model",
        "embed.batch_size",
        "server.listen",
        "paths.home",
        "network.proxy",
        "accel.enabled",
        "index.watch",
        "index.debounce_ms",
        "mcp.transports",
        "evolution.review_mode",
        "meta.read_pool",
        "upload.max_file_mb",
        "extract.ocr_enabled",
        "log.unknown",
    ] {
        assert_ne!(classify_change(key), ChangeScope::Hot, "{key} 不应热更新");
    }
}

#[test]
fn same_compat_group_needs_both_the_declared_group_and_the_model_family() {
    let current = Config::default();
    // 量化版本互换:同一族,可免迁移
    let mut next = current.clone();
    next.embed.model = "bge-m3".to_owned();
    assert!(
        current.embed.same_compat_group(&next.embed),
        "bge-m3-int8 与 bge-m3 应算同组"
    );
    // 后端换了但模型族一样(http 端点的模型名带路径前缀)
    let mut next = current.clone();
    next.embed.backend = "http".to_owned();
    next.embed.model = "BAAI/bge-m3".to_owned();
    assert!(
        current.embed.same_compat_group(&next.embed),
        "fastembed 与 http 上同一个模型应算同组"
    );

    // 只改 model 却没改 compat_group(默认值仍是 bge-m3):必须判为不同组
    let mut next = current.clone();
    next.embed.model = "bge-small".to_owned();
    assert!(
        !current.embed.same_compat_group(&next.embed),
        "模型族变了就不能说“同组、不用迁移”"
    );
    assert_eq!(next.embed.compat_group, "bge-m3", "默认值确实没跟着改");

    // 显式声明了不同的组
    let mut next = current.clone();
    next.embed.compat_group = "multilingual-e5".to_owned();
    assert!(!current.embed.same_compat_group(&next.embed));
}

#[test]
fn model_group_strips_paths_and_quantization() {
    let mut embed = EmbedConfig::default();
    assert_eq!(embed.model_group(), "bge-m3");
    embed.model = "BAAI/bge-m3".to_owned();
    assert_eq!(embed.model_group(), "bge-m3");
    embed.model = "bge-m3-fp16".to_owned();
    assert_eq!(embed.model_group(), "bge-m3");
    embed.model = "Multilingual-MiniLM".to_owned();
    assert_eq!(embed.model_group(), "multilingual-minilm");
}

#[test]
fn config_store_hands_out_snapshots_and_bumps_the_generation() {
    let store = ConfigStore::new(Config::default());
    assert_eq!(store.generation(), 1);
    let before = store.get();
    assert_eq!(before.search.k, 8);

    let mut next = (*before).clone();
    next.search.k = 3;
    let (generation, diff) = store.replace(next);
    assert_eq!(generation, 2, "每次替换代际号 +1");
    assert_eq!(diff.hot(), vec!["search.k".to_owned()]);
    assert_eq!(store.get().search.k, 3);
    // 旧快照不受影响(请求里可以放心持有)
    assert_eq!(before.search.k, 8, "已取出的快照不应被改写");

    // 换成完全一样的配置:代际号照样 +1,但差异为空(由调用方决定要不要发事件)
    let (generation, diff) = store.replace((*store.get()).clone());
    assert_eq!(generation, 3);
    assert!(diff.is_empty());
}

#[test]
fn config_store_is_shared_across_threads() {
    // 读多写少:并发读的同时替换配置,读到的要么是旧值要么是新值
    let store = std::sync::Arc::new(ConfigStore::new(Config::default()));
    let mut next = Config::default();
    next.search.k = 2;
    let writer = {
        let store = store.clone();
        std::thread::spawn(move || {
            for _ in 0..50 {
                store.replace(next.clone());
            }
        })
    };
    for _ in 0..50 {
        let snapshot = store.get();
        assert!(
            snapshot.search.k == 8 || snapshot.search.k == 2,
            "读到的必须是完整的一份配置,实际 {}",
            snapshot.search.k
        );
    }
    writer.join().expect("写线程");
    assert_eq!(store.generation(), 51);
}

#[test]
fn multi_user_sections_have_the_planned_defaults() {
    let config = Config::default();
    assert!(config.ai.enabled && !config.ai.chunk_context);
    assert!(config.accounts.registration_open && !config.accounts.require_invite);
    assert_eq!(config.accounts.default_role, crate::account::ROLE_USER);
    assert_eq!(config.quota.storage_gb, 100, "默认每人 100 GB");
    assert_eq!(config.quota.max_upload_mb, 200);
    assert_eq!(config.quota.llm_tokens_per_day, 200_000);
    assert_eq!(
        (
            config.quota.acp_concurrency_total,
            config.quota.acp_concurrency_per_user
        ),
        (8, 1)
    );
    assert!(
        config.share.allow_guest_view
            && !config.share.allow_guest_comment
            && !config.share.allow_guest_edit
    );
    assert_eq!(config.site.public_url, "https://kb.example.com");
    assert_eq!(
        config.site.timezone,
        crate::timezone::DEFAULT_TIMEZONE,
        "全站默认北京时间"
    );
    assert!(
        !config.site.tagline.to_lowercase().contains("ai"),
        "默认标语不含 AI 字样"
    );
}

#[test]
fn ai_switches_map_to_feature_ids() {
    let mut ai = AiConfig::default();
    assert!(ai.state().master && ai.state().off.is_empty());
    ai.deep_search = false;
    ai.acp = false;
    let state = ai.state();
    assert_eq!(
        state.off.iter().map(String::as_str).collect::<Vec<_>>(),
        ["ai.acp", "search.deep"]
    );
    assert!(
        !state.allows("search.deep") && state.allows("ai.assistant") && state.allows("docs.notes")
    );
    ai.enabled = false;
    assert!(
        !ai.state().allows("ai.assistant"),
        "总开关关闭,所有 AI 功能点都不可用"
    );
    assert!(ai.state().allows("docs.notes"), "非 AI 功能不受影响");
}

#[test]
fn partial_multi_user_sections_keep_the_other_defaults() {
    let config: Config =
        toml::from_str("[quota]\nstorage_gb = 500\n[ai]\nenabled = false\n").unwrap();
    assert_eq!(config.quota.storage_gb, 500);
    assert_eq!(config.quota.max_upload_mb, 200, "没写的键取默认值");
    assert!(!config.ai.enabled && config.ai.extract);
    assert!(
        toml::from_str::<Config>("[quota]\nnope = 1\n").is_err(),
        "拼错的键要报错而不是被吞掉"
    );
}

#[test]
fn multi_user_keys_are_hot_updatable() {
    for key in [
        "ai.enabled",
        "ai.acp",
        "accounts.require_invite",
        "quota.storage_gb",
        "share.allow_guest_edit",
        "site.name",
        "site.timezone",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Hot, "{key} 应热更新");
    }
    assert_eq!(classify_change("server.listen"), ChangeScope::Restart);
    // 预热开关只在启动时读一次:改了要重启,不能当热更新悄悄生效
    assert_eq!(
        classify_change("server.warm_on_start"),
        ChangeScope::Restart
    );
}

/// 启动预热开关:默认开着(保持老行为),关掉能写进 TOML。
#[test]
fn warm_on_start_defaults_to_true_and_can_be_turned_off() {
    assert!(ServerConfig::default().warm_on_start, "默认要等模型就绪");
    let config: Config = toml::from_str("[server]\nwarm_on_start = false\n").unwrap();
    assert!(!config.server.warm_on_start);
    assert_eq!(config.server.listen, "127.0.0.1:7878", "没写的键仍是默认值");
}

#[test]
fn quota_overrides_layer_on_top_of_the_defaults() {
    let base = QuotaConfig::default();
    let role = base.with_overrides(r#"{"storage_gb": 500, "max_upload_mb": 1024}"#);
    assert_eq!((role.storage_gb, role.max_upload_mb), (500, 1024));
    assert_eq!(
        role.llm_tokens_per_day, base.llm_tokens_per_day,
        "没写的键保持默认"
    );
    // 用户在角色之上再覆盖一层
    let user = role.with_overrides(r#"{"storage_gb": 20}"#);
    assert_eq!((user.storage_gb, user.max_upload_mb), (20, 1024));
}

#[test]
fn bad_quota_overrides_are_ignored_not_fatal() {
    let base = QuotaConfig::default();
    for bad in [
        "",
        "not json",
        "[]",
        "null",
        r#"{"storage_gb": "lots"}"#,
        r#"{"storage_gb": -5}"#,
        r#"{"storage_gb": 1.5}"#,
        r#"{"no_such_key": 9}"#,
    ] {
        assert_eq!(base.with_overrides(bad), base, "{bad:?} 应被忽略");
    }
    // 一个键不合法不影响同一份 JSON 里的合法键
    let mixed = base.with_overrides(r#"{"storage_gb": "x", "max_upload_mb": 5}"#);
    assert_eq!((mixed.storage_gb, mixed.max_upload_mb), (100, 5));
}

#[test]
fn mail_is_off_by_default_and_presets_fill_the_server() {
    let config = Config::default();
    assert!(!config.mail.enabled, "没配好之前不开");
    assert!(!config.mail.primary.is_configured() && !config.mail.backup.is_configured());
    let qq = MailAccount {
        username: "me@qq.com".into(),
        ..MailAccount::default()
    }
    .with_preset("qq");
    assert_eq!(
        (qq.host.as_str(), qq.port, qq.security.as_str()),
        ("smtp.qq.com", 465, "tls")
    );
    assert_eq!(qq.username, "me@qq.com", "预设不动登录名");
    assert!(qq.is_configured());
    assert_eq!(
        MailAccount::default().with_preset("163").host,
        "smtp.163.com"
    );
    assert_eq!(
        MailAccount::default().with_preset("custom"),
        MailAccount::default(),
        "自定义不改任何值"
    );
    assert!(
        MAIL_PRESETS
            .iter()
            .all(|(_, _, host, port, sec)| !host.is_empty()
                && *port != 0
                && matches!(*sec, "tls" | "starttls"))
    );
}

/// 系统参数页(`web-ui/src/utils/systemParams.ts`)的每个字段路径,都必须是后端真实存在的配置键。
///
/// 前端那边的测试用的是手写的样例配置,后端改名或前端拼错时它发现不了(样例会跟着一起错);
/// 这里拿真正的默认配置对一遍,拼错、改名会立刻红。
#[test]
fn every_path_in_the_admin_params_page_is_a_real_config_key() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web-ui/src/utils/systemParams.ts");
    let Ok(source) = std::fs::read_to_string(&file) else {
        eprintln!("跳过:读不到 {}(只带了后端代码的环境)", file.display());
        return;
    };
    let defaults = serde_json::to_value(Config::default()).unwrap();
    let mut checked = 0;
    for line in source.lines() {
        let Some(start) = line.find("path: '") else {
            continue;
        };
        let rest = &line[start + "path: '".len()..];
        let Some(end) = rest.find('\'') else { continue };
        let path = &rest[..end];
        let found = path
            .split('.')
            .try_fold(&defaults, |value, part| value.get(part));
        assert!(
            found.is_some(),
            "系统参数页的字段 {path} 不是后端的配置键(拼错了,或后端改了名)"
        );
        checked += 1;
    }
    assert!(
        checked >= 20,
        "只解析出 {checked} 个字段,解析方式可能失效了"
    );
}

#[test]
fn the_deletion_cooling_off_period_can_never_be_zero_or_absurd() {
    let mut accounts = AccountsConfig::default();
    assert_eq!(
        accounts.deletion_cooling_off_ms(),
        7 * 86_400_000,
        "默认 7 天"
    );
    accounts.deletion_cooling_off_days = 0;
    assert_eq!(
        accounts.deletion_cooling_off_ms(),
        86_400_000,
        "0 天没有反悔的机会,按 1 天算"
    );
    accounts.deletion_cooling_off_days = 30;
    assert_eq!(accounts.deletion_cooling_off_ms(), 30 * 86_400_000);
    accounts.deletion_cooling_off_days = u32::MAX;
    assert_eq!(
        accounts.deletion_cooling_off_ms(),
        365 * 86_400_000,
        "最多一年"
    );
    // 配置文件里没写这个键时取默认值
    let config: Config = toml::from_str("[accounts]\nregistration_open = false\n").unwrap();
    assert_eq!(config.accounts.deletion_cooling_off_days, 7);
}

#[test]
fn mail_section_is_hot_and_rejects_typos() {
    assert_eq!(classify_change("mail.primary.host"), ChangeScope::Hot);
    assert!(toml::from_str::<Config>("[mail.primary]\nhots = \"x\"\n").is_err());
    let config: Config = toml::from_str(
        "[mail]\nenabled = true\n[mail.primary]\nhost = \"smtp.qq.com\"\nusername = \"a@qq.com\"\n",
    )
    .unwrap();
    assert!(config.mail.enabled && config.mail.primary.is_configured());
    assert_eq!(config.mail.primary.port, 465, "没写的键取默认值");
}

/// 旧格式 Office 入库转换(`[convert]`):默认关,没写的键取默认值,拒绝不合理的取值。
#[test]
fn convert_section_defaults_off_parses_and_validates() {
    let config = Config::default();
    assert!(!config.convert.enabled, "默认不转换");
    assert_eq!(config.convert.timeout_secs, 120);
    assert_eq!(config.convert.max_concurrent, 1);
    assert!(config.convert.install_dir.is_none());
    assert!(config.convert.library_path.is_none());

    let parsed: Config = toml::from_str(
 "[convert]\nenabled = true\ninstall_dir = \"/opt/lo\"\nlibrary_path = \"/opt/lo/lib\"\ntimeout_secs = 30\n",
 )
 .expect("解析");
    assert!(parsed.convert.enabled);
    assert_eq!(parsed.convert.install_dir.as_deref(), Some("/opt/lo"));
    assert_eq!(parsed.convert.library_path.as_deref(), Some("/opt/lo/lib"));
    assert_eq!(parsed.convert.timeout_secs, 30);
    assert_eq!(parsed.convert.max_concurrent, 1, "没写的键取默认值");
    parsed.validate().expect("合法配置");

    for bad in [
        "[convert]\ntimeout_secs = 0\n",
        "[convert]\ntimeout_secs = 100000\n",
        "[convert]\nmax_concurrent = 0\n",
        "[convert]\nmax_concurrent = 64\n",
    ] {
        let config: Config = toml::from_str(bad).expect("能解析");
        assert!(config.validate().is_err(), "应被拒绝:{bad}");
    }
    // 拼错的键直接报错,不悄悄忽略
    assert!(toml::from_str::<Config>("[convert]\nenabeld = true\n").is_err());
}

/// 分片内并发解析(`index.parallel_files`):默认 1(不改变已有行为),范围 1..=8,热更新。
#[test]
fn parallel_files_defaults_to_serial_and_is_validated() {
    let config = Config::default();
    assert_eq!(config.index.parallel_files, 1, "默认逐个处理");

    let parsed: Config = toml::from_str("[index]\nparallel_files = 4\n").expect("解析");
    assert_eq!(parsed.index.parallel_files, 4);
    parsed.validate().expect("4 合法");
    assert_eq!(classify_change("index.parallel_files"), ChangeScope::Hot);

    // 0 会让分片卡死(永远领不到名额),超过上限则与内存 / CPU 账不算
    for bad in [
        "[index]\nparallel_files = 0\n",
        "[index]\nparallel_files = 9\n",
    ] {
        let config: Config = toml::from_str(bad).expect("能解析");
        assert!(config.validate().is_err(), "应被拒绝:{bad}");
    }
}

/// 分片并发(`index.parallel_slices`):0 = 自动,上限是每个知识库后台的循环数,热更新。
#[test]
fn parallel_slices_is_capped_at_the_worker_loop_count() {
    let config = Config::default();
    assert_eq!(config.index.parallel_slices, 0, "默认自动");

    let parsed: Config = toml::from_str("[index]\nparallel_slices = 6\n").expect("解析");
    assert_eq!(parsed.index.parallel_slices, 6);
    parsed.validate().expect("6 合法");
    assert_eq!(classify_change("index.parallel_slices"), ChangeScope::Hot);

    // 后台循环的条数就是上限,再大的数只是空许愿
    let too_big: Config = toml::from_str("[index]\nparallel_slices = 9\n").expect("能解析");
    assert!(
        too_big.validate().is_err(),
        "超过后台循环数的并发没有意义,直接拒绝"
    );
}

/// 办公文档在线编辑(`[office]`):默认留 3 份旧版本,0 合法,超过上限被拒,改了立即生效。
#[test]
fn office_section_defaults_parses_validates_and_is_hot() {
    assert_eq!(Config::default().office.keep_versions, 3);
    let parsed: Config = toml::from_str("[office]\nkeep_versions = 0\n").expect("解析");
    assert_eq!(parsed.office.keep_versions, 0);
    parsed.validate().expect("0 份是合法的");
    let too_many: Config = toml::from_str("[office]\nkeep_versions = 51\n").expect("能解析");
    assert!(too_many.validate().is_err());
    assert!(
        toml::from_str::<Config>("[office]\nkeep_version = 3\n").is_err(),
        "拼错的键报错"
    );
    assert_eq!(classify_change("office.keep_versions"), ChangeScope::Hot);
    // 协同相关:默认开协同、AI 默认只能提建议;都是每次用到时现读
    let defaults = Config::default().office;
    assert!(defaults.collab && !defaults.agent_direct_edit);
    assert_eq!(defaults.node, "node");
    assert!(defaults.worker_dir.is_none());
    let parsed: Config = toml::from_str(
        "[office]\ncollab = false\nagent_direct_edit = true\nnode = \"/opt/node/bin/node\"\n",
    )
    .expect("解析");
    assert!(!parsed.office.collab && parsed.office.agent_direct_edit);
    assert_eq!(parsed.office.keep_versions, 3, "没写的键取默认值");
    for key in [
        "office.collab",
        "office.agent_direct_edit",
        "office.node",
        "office.worker_dir",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Hot, "{key}");
    }
}

/// `convert.*` 只在启动时读(转换器在组装根里建),改了提示重启,不是热更新也不是迁移。
#[test]
fn convert_keys_need_a_restart() {
    for key in [
        "convert.enabled",
        "convert.install_dir",
        "convert.timeout_secs",
    ] {
        assert_eq!(classify_change(key), ChangeScope::Restart, "{key}");
    }
}

/// 编辑器扩展(`[editor]`）:默认关、默认目录在 KB_HOME 下、路径校验、改了立即生效。
#[test]
fn editor_section_is_off_by_default_validates_the_dir_and_is_hot() {
    let defaults = Config::default().editor;
    assert!(!defaults.extensions, "加载第三方脚本必须显式打开");
    assert!(defaults.extensions_dir.is_none());
    let home = Path::new("/srv/kb");
    assert_eq!(
        defaults.resolved_dir(home),
        Path::new("/srv/kb/editor-extensions")
    );

    // 绝对路径原样用,相对路径落在 KB_HOME 下
    let parsed: Config =
        toml::from_str("[editor]\nextensions = true\nextensions_dir = \"/opt/kb-ext\"\n")
            .expect("解析");
    assert!(parsed.editor.extensions);
    assert_eq!(parsed.editor.resolved_dir(home), Path::new("/opt/kb-ext"));
    parsed.validate().expect("绝对路径合法");
    let relative: Config = toml::from_str("[editor]\nextensions_dir = \"my-ext\"\n").expect("解析");
    assert_eq!(
        relative.editor.resolved_dir(home),
        Path::new("/srv/kb/my-ext")
    );
    relative.validate().expect("相对路径合法");

    // 空串 / 全空白 / `..` 段都被拒,错误文案指向这个键
    for bad in ["", " ", "../escape", "/opt/../etc"] {
        let mut config = Config::default();
        config.editor.extensions_dir = Some(bad.to_owned());
        let error = config.validate().expect_err(&format!("{bad:?} 应被拒"));
        assert!(
            error.to_string().contains("editor.extensions_dir"),
            "{error}"
        );
    }
    assert!(
        toml::from_str::<Config>("[editor]\nextension = true\n").is_err(),
        "拼错的键报错"
    );

    for key in ["editor.extensions", "editor.extensions_dir"] {
        assert_eq!(classify_change(key), ChangeScope::Hot, "{key}");
    }
}

#[test]
fn ocr_resource_limits_live_in_the_config_table() {
    // B4:这三项原先硬编码在 `kb-extract/src/pdf.rs`(40 页 / 300 秒 / 名额按核数算),
    // 用户想按机器调整只能改代码重编;现在落在 `[extract.ocr]` 子表。
    let config = Config::default();
    assert_eq!(config.extract.ocr, OcrConfig::default());
    assert_eq!(config.extract.ocr.max_pages, 40);
    assert_eq!(config.extract.ocr.budget_secs, 300);

    // `slots = 0`(默认)= 按核数自动,公式与搬迁前的 `ocr_slots` 一字不差:核数/4,夹 1..=4
    let auto = OcrConfig {
        slots: 0,
        ..OcrConfig::default()
    };
    assert_eq!(auto.effective_slots(1), 1);
    assert_eq!(auto.effective_slots(8), 2);
    assert_eq!(auto.effective_slots(16), 4);
    assert_eq!(auto.effective_slots(64), 4);

    // 指定值直接用,但夹上限(填 99 不等于“开 99 份”)
    let fixed = OcrConfig {
        slots: 3,
        ..OcrConfig::default()
    };
    assert_eq!(fixed.effective_slots(16), 3);
    let too_many = OcrConfig {
        slots: 99,
        ..OcrConfig::default()
    };
    assert_eq!(too_many.effective_slots(16), OcrConfig::MAX_SLOTS);

    // 0 秒 / 0 页不能把 OCR 循环第一次就掐死(配置校验会拒,这里守的是钳制本身)
    let zero = OcrConfig {
        budget_secs: 0,
        max_pages: 0,
        ..OcrConfig::default()
    };
    assert_eq!(zero.budget().as_secs(), 1);
    assert_eq!(zero.page_cap(), 1);

    // 子表能从 toml 读到,没写的那项走默认;拼错的键要报错(`deny_unknown_fields`)
    let parsed: Config =
        toml::from_str("[extract.ocr]\nslots = 2\nmax_pages = 12\n").expect("合法的部分配置");
    assert_eq!(parsed.extract.ocr.slots, 2);
    assert_eq!(parsed.extract.ocr.max_pages, 12);
    assert_eq!(parsed.extract.ocr.budget_secs, 300);
    assert!(toml::from_str::<Config>("[extract.ocr]\nslot = 2\n").is_err());
}

#[test]
fn ocr_limits_are_validated() {
    // 越界的三种数各来一次:名额上限、预算两端、页数两端(`slots = 0` 是合法的自动值)
    for (slots, budget_secs, max_pages) in [
        (17_usize, 300_u64, 40_usize),
        (0, 29, 40),
        (0, 3_601, 40),
        (0, 300, 0),
        (0, 300, 501),
    ] {
        let mut config = Config::default();
        config.extract.ocr = OcrConfig {
            slots,
            budget_secs,
            max_pages,
        };
        assert!(
            config.validate().is_err(),
            "{slots} 份 / {budget_secs} 秒 / {max_pages} 页 应被拒"
        );
    }
    // 边界值本身合法
    let mut edge = Config::default();
    edge.extract.ocr = OcrConfig {
        slots: OcrConfig::MAX_SLOTS,
        budget_secs: *OcrConfig::BUDGET_RANGE.start(),
        max_pages: OcrConfig::MAX_PAGES,
    };
    edge.validate().expect("边界值应通过");
}
