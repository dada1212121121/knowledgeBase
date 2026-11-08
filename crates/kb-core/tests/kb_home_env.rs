//! 验证 `KB_HOME` 环境变量真的驱动全部默认路径(而不只是验证注入参数的函数)。
//!
//! 这个测试二进制里只有一个测试,因此修改环境变量不会与其它测试并发竞争。

#[test]
fn kb_home_env_var_drives_all_default_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    // SAFETY: edition 2024 下 `set_var` 是 unsafe(多线程读环境变量时可能竞争)。
    // 这里是本测试二进制里唯一的测试,且在任何路径解析之前只执行一次。
    unsafe { std::env::set_var("KB_HOME", dir.path()) };

    let paths = kb_core::KbPaths::from_env().expect("按 KB_HOME 解析路径");
    assert_eq!(paths.home(), dir.path());
    for path in [
        paths.socket(),
        paths.models_dir(),
        paths.lang_dir(),
        paths.meta_db(),
        paths.lance_dir(),
        paths.logs_dir(),
    ] {
        assert!(
            path.starts_with(dir.path()),
            "{} 不在 KB_HOME 之下",
            path.display()
        );
    }
}
