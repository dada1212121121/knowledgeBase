//! 把 User-Agent 变成「Chrome · macOS」这样的人话,给「登录设备」列表用。
//!
//! 刻意保守:只认常见的浏览器和系统,认不出来就写「未知设备」,**不回显原始 UA**——
//! UA 是客户端随便写的任意字符串,不该原样进入界面、日志或导出。
//! 判断顺序很重要,因为 UA 字符串互相包含(Chrome 的 UA 里也写着 Safari,
//! Edge 的写着 Chrome,Android 的写着 Linux,iPhone 的写着 Mac OS X)。

/// 浏览器名。
fn browser(ua: &str) -> Option<&'static str> {
    // 先排除「冒充 Chrome/Safari 的其它浏览器」
    for (needle, name) in [
        ("MicroMessenger", "微信"),
        ("Edg/", "Edge"),
        ("EdgA/", "Edge"),
        ("EdgiOS/", "Edge"),
        ("OPR/", "Opera"),
        ("Firefox/", "Firefox"),
        ("FxiOS/", "Firefox"),
        ("SamsungBrowser/", "三星浏览器"),
        ("CriOS/", "Chrome"),
        ("Chrome/", "Chrome"),
    ] {
        if ua.contains(needle) {
            return Some(name);
        }
    }
    // Safari 的 UA 带 Version/;没有 Version/ 的多半是应用内嵌的网页视图
    if ua.contains("Safari/") && ua.contains("Version/") {
        return Some("Safari");
    }
    None
}

/// 操作系统名。
fn system(ua: &str) -> Option<&'static str> {
    // iPhone / iPad 的 UA 里都写着「Mac OS X」,Android 的写着「Linux」,所以它们要排在前面
    for (needle, name) in [
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Android", "Android"),
        ("Windows", "Windows"),
        ("CrOS", "ChromeOS"),
        ("Macintosh", "macOS"),
        ("Mac OS X", "macOS"),
        ("Linux", "Linux"),
        ("X11", "Linux"),
    ] {
        if ua.contains(needle) {
            return Some(name);
        }
    }
    None
}

/// 设备描述。两样都认不出来返回「未知设备」。
pub fn describe(user_agent: Option<&str>) -> String {
    let Some(ua) = user_agent.map(str::trim).filter(|ua| !ua.is_empty()) else {
        return "未知设备".to_owned();
    };
    // 超长的 UA 只看前面一段:正常浏览器的 UA 不到 300 字节
    let ua: String = ua.chars().take(400).collect();
    match (browser(&ua), system(&ua)) {
        (Some(browser), Some(system)) => format!("{browser} · {system}"),
        (Some(browser), None) => browser.to_owned(),
        (None, Some(system)) => system.to_owned(),
        (None, None) => "未知设备".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_browsers_and_systems_are_recognized() {
        let cases = [
            (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Chrome · macOS",
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
                "Edge · Windows",
            ),
            (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
                "Safari · macOS",
            ),
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
                "Safari · iPhone",
            ),
            (
                "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
                "Safari · iPad",
            ),
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
                "Chrome · iPhone",
            ),
            (
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
                "Chrome · Android",
            ),
            (
                "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
                "Firefox · Linux",
            ),
            (
                "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
                "三星浏览器 · Android",
            ),
            (
                "Mozilla/5.0 (Linux; Android 12; V2171A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.44",
                "微信 · Android",
            ),
            (
                "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Chrome · ChromeOS",
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
                "Opera · Windows",
            ),
        ];
        for (ua, expected) in cases {
            assert_eq!(describe(Some(ua)), expected, "{ua}");
        }
    }

    #[test]
    fn unknown_or_hostile_agents_never_echo_the_raw_string() {
        assert_eq!(describe(None), "未知设备");
        assert_eq!(describe(Some("")), "未知设备");
        assert_eq!(describe(Some("   ")), "未知设备");
        for hostile in [
            "<script>alert(1)</script>",
            "'; DROP TABLE sessions;--",
            "\u{0}\u{1}\u{2}",
            "../../etc/passwd",
        ] {
            let text = describe(Some(hostile));
            assert_eq!(text, "未知设备", "{hostile:?}");
        }
        // 就算 UA 里夹带了脚本,也只会得到我们自己的固定词汇
        let mixed = describe(Some("Mozilla/5.0 (Windows) <script>x</script> Firefox/1.0"));
        assert_eq!(mixed, "Firefox · Windows");
        assert!(!mixed.contains('<'));
        // 超长 UA 不会拖慢也不会 panic
        let long = format!("Mozilla/5.0 (Windows) {}", "A".repeat(1_000_000));
        assert_eq!(describe(Some(&long)), "Windows");
    }
}
