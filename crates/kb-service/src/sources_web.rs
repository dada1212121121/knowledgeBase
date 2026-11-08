//! 网页抓取:单页 / 站点,深度 ≤ 3、同域白名单、robots.txt、限速。
//!
//! 抓到的页面按 URL 路径落成 `<KB_HOME>/sources/<id>/<host>/<path>/index.html`,
//! 之后走既有的解析队列(`HtmlExtractor` → `DocChunker` → 索引),所以:
//! - 检索结果的 `source` 就是页面路径,块头里带 URL;
//! - 刷新时只有内容变化的页面会产生新的块(索引管线按文件哈希跳过没变的)。
//!
//! 安全与礼貌:
//! - 只抓 `http` / `https`;
//! - 域名白名单(空 = 只允许种子 URL 的域名),跨域链接一律不入队;
//! - `robots.txt` 里 `Disallow` 命中的路径不抓;
//! - 同一主机两次请求之间至少间隔 `delay`(默认 200 ms);
//! - 页数上限(默认 200)与深度上限(3,默认上限)。

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use kb_core::{KbError, Result};
use serde::Serialize;

/// 抓取规则。
#[derive(Clone, Debug)]
pub struct CrawlOptions {
    /// 最大深度(种子页 = 1)。
    pub max_depth: u32,
    /// 最多抓多少页。
    pub max_pages: usize,
    /// 同一主机两次请求之间的最小间隔。
    pub delay: Duration,
    /// 域名白名单(空 = 只允许种子的域名)。
    pub allow_hosts: Vec<String>,
    /// 超时。
    pub timeout: Duration,
    /// 允许抓内网 / 本机 / 云元数据地址。默认**不允许**(SSRF):多用户下任何人都能添加网页来源,
    /// 放开就等于让他借本服务器去读内网服务。只有管理员明确配置才打开(`[network] crawl_allow_private`)。
    pub allow_private: bool,
}

impl Default for CrawlOptions {
    fn default() -> Self {
        Self {
            max_depth: 3,
            max_pages: 200,
            delay: Duration::from_millis(200),
            allow_hosts: Vec::new(),
            timeout: Duration::from_secs(20),
            allow_private: false,
        }
    }
}

impl CrawlOptions {
    /// 从数据源配置构造(深度夹在 1..=3)。
    pub fn from_source(depth: u32, allow_hosts: &[String], max_pages: usize) -> Self {
        Self {
            max_depth: depth.clamp(1, 3),
            max_pages: max_pages.max(1),
            allow_hosts: allow_hosts.to_vec(),
            ..Self::default()
        }
    }

    /// 是否允许抓私有地址。
    #[must_use]
    pub fn with_allow_private(mut self, allow: bool) -> Self {
        self.allow_private = allow;
        self
    }
}

/// 抓到的页面。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CrawledPage {
    /// 完整 URL。
    pub url: String,
    /// 相对路径(落盘用,`<host>/<path>/index.html`)。
    pub rel_path: String,
    /// HTML 正文。
    pub html: String,
}

/// 抓取结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CrawlOutcome {
    /// 抓到的页面。
    pub pages: Vec<CrawledPage>,
    /// 被跳过的 URL 与原因(跨域 / robots / 深度 / 非 HTML / 抓取失败)。
    pub skipped: Vec<(String, String)>,
}

/// 网页抓取器。
pub struct WebCrawler {
    client: reqwest::Client,
    options: CrawlOptions,
}

impl WebCrawler {
    /// 构造。
    pub fn new(options: CrawlOptions) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(options.timeout)
            .user_agent("kb-crawler/0.1 (+https://localhost)");
        if !options.allow_private {
            // 连接时再解析一次域名并去掉私有地址(防 DNS 重绑定);重定向的每一跳也要过一遍
            builder = builder.dns_resolver(Arc::new(PublicOnlyResolver)).redirect(
                reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 {
                        attempt.error("重定向次数太多")
                    } else if let Err(reason) = literal_host_allowed(attempt.url()) {
                        attempt.error(reason)
                    } else {
                        attempt.follow()
                    }
                }),
            );
        }
        let client = builder
            .build()
            .map_err(|err| KbError::Internal(format!("构造 HTTP 客户端失败: {err}")))?;
        Ok(Self { client, options })
    }

    /// 抓一个站点(或单页)。
    pub async fn crawl(&self, seed: &str) -> Result<CrawlOutcome> {
        let seed_url = parse_url(seed)?;
        // 种子地址指向内网 / 本机 / 元数据服务:整个抓取直接拒绝(不是悄悄跳过)
        if let Err(reason) = self.check_public(seed).await {
            return Err(KbError::InvalidInput(format!("不能抓取这个地址:{reason}")));
        }
        let allowed_hosts: HashSet<String> = if self.options.allow_hosts.is_empty() {
            HashSet::from([seed_url.host.clone()])
        } else {
            self.options
                .allow_hosts
                .iter()
                .map(|host| host.trim().to_ascii_lowercase())
                .collect()
        };
        let robots = self.fetch_robots(&seed_url).await;
        let mut outcome = CrawlOutcome::default();
        let mut queue: VecDeque<(String, u32)> = VecDeque::from([(seed.to_owned(), 1)]);
        let mut seen: HashSet<String> = HashSet::from([normalize_url(seed)]);
        let mut last_request: Option<tokio::time::Instant> = None;

        while let Some((url, depth)) = queue.pop_front() {
            if outcome.pages.len() >= self.options.max_pages {
                outcome
                    .skipped
                    .push((url, format!("超过页数上限 {}", self.options.max_pages)));
                continue;
            }
            let parsed = match parse_url(&url) {
                Ok(parsed) => parsed,
                Err(err) => {
                    outcome.skipped.push((url, err.to_string()));
                    continue;
                }
            };
            if !allowed_hosts.contains(&parsed.host) {
                outcome
                    .skipped
                    .push((url, format!("域名 {} 不在白名单", parsed.host)));
                continue;
            }
            if let Some(robots) = &robots
                && !robots.allows(&parsed.path)
            {
                outcome.skipped.push((url, "robots.txt 不允许".to_owned()));
                continue;
            }
            // 同域链接、重定向后的落点都可能是私有地址:每个请求前都查
            if let Err(reason) = self.check_public(&url).await {
                outcome.skipped.push((url, reason));
                continue;
            }
            // 限速:同一主机两次请求之间等够间隔
            if let Some(last) = last_request {
                let elapsed = last.elapsed();
                if elapsed < self.options.delay {
                    tokio::time::sleep(self.options.delay - elapsed).await;
                }
            }
            last_request = Some(tokio::time::Instant::now());

            let response = match self.client.get(&url).send().await {
                Ok(response) => response,
                Err(err) => {
                    outcome.skipped.push((url, format!("抓取失败: {err}")));
                    continue;
                }
            };
            if !response.status().is_success() {
                outcome
                    .skipped
                    .push((url, format!("HTTP {}", response.status().as_u16())));
                continue;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !content_type.contains("html") && !content_type.is_empty() {
                outcome
                    .skipped
                    .push((url, format!("不是 HTML({content_type})")));
                continue;
            }
            let html = match response.text().await {
                Ok(html) => html,
                Err(err) => {
                    outcome.skipped.push((url, format!("读取正文失败: {err}")));
                    continue;
                }
            };

            // 链接入队(只收同域、未访问过的)
            if depth < self.options.max_depth {
                for link in extract_links(&html) {
                    let absolute = match resolve(&parsed, &link) {
                        Some(absolute) => absolute,
                        None => continue,
                    };
                    let normalized = normalize_url(&absolute);
                    if !seen.insert(normalized.clone()) {
                        continue;
                    }
                    let Ok(link_url) = parse_url(&normalized) else {
                        continue;
                    };
                    if !allowed_hosts.contains(&link_url.host) {
                        continue;
                    }
                    queue.push_back((normalized, depth + 1));
                }
            }
            outcome.pages.push(CrawledPage {
                rel_path: page_rel_path(&parsed),
                url,
                html,
            });
        }
        Ok(outcome)
    }

    /// 这个 URL 的主机是不是公网地址。允许私有地址时一律放行。
    ///
    /// 先看字面:IP 直接判断,`localhost` 一类名字拒绝;域名再解析一遍,**任何一个**解析结果是私有地址就拒绝
    /// (只要有一个能连上内网就可能被利用)。走代理时连接由代理发起,连接阶段的解析过滤管不到,
    /// 所以这里的预检查不能省。
    async fn check_public(&self, url: &str) -> std::result::Result<(), String> {
        if self.options.allow_private {
            return Ok(());
        }
        let parsed = reqwest::Url::parse(url).map_err(|err| format!("URL 不合法: {err}"))?;
        literal_host_allowed(&parsed)?;
        if let HostKind::Domain(domain) = host_kind(&parsed) {
            let port = parsed.port_or_known_default().unwrap_or(80);
            let resolved = tokio::net::lookup_host((domain.as_str(), port))
                .await
                .map_err(|err| format!("解析域名 {domain} 失败: {err}"))?;
            judge_resolution(&domain, resolved.map(|addr| addr.ip()))?;
        }
        Ok(())
    }

    /// 取 robots.txt(取不到就当“没有限制”)。
    async fn fetch_robots(&self, seed: &Url) -> Option<Robots> {
        let url = format!("{}://{}/robots.txt", seed.scheme, seed.host);
        // 种子已经查过;这里是同一个主机,但重定向可能把 robots.txt 指到别处,交给客户端的重定向策略
        self.check_public(&url).await.ok()?;
        let response = self.client.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        Some(Robots::parse(&text))
    }
}

/// 这个 IP 是不是「不该让用户经服务器去访问」的地址:回环、私有网段、链路本地(含 169.254.169.254 云元数据)、
/// 运营商级 NAT、未指定、广播、多播、文档保留段;IPv6 的回环、唯一本地、链路本地,以及内嵌 IPv4 的映射地址。
pub fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // 100.64.0.0/10:运营商级 NAT,云上常被拿来放内部服务
                || (a == 100 && (64..=127).contains(&b))
                // 0.0.0.0/8
                || a == 0
                // 198.18.0.0/15:基准测试保留段
                || (a == 198 && (b == 18 || b == 19))
                // 240.0.0.0/4:保留
                || a >= 240
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 唯一本地
                || (first & 0xfe00) == 0xfc00
                // fe80::/10 链路本地
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// 域名解析结果的裁决:**只要有一个**地址是私有的就拒绝(哪怕还有公网地址,
/// 连接时也可能选到内网那个)。解析结果为空也拒绝。
fn judge_resolution(
    domain: &str,
    addrs: impl IntoIterator<Item = std::net::IpAddr>,
) -> std::result::Result<(), String> {
    let mut any = false;
    for ip in addrs {
        any = true;
        if is_blocked_ip(ip) {
            return Err(format!("{domain} 解析到内网 / 本机地址 {ip},不允许抓取"));
        }
    }
    if any {
        Ok(())
    } else {
        Err(format!("{domain} 没有解析结果"))
    }
}

/// URL 里的主机是 IP 还是域名(IPv6 的 `host_str` 带方括号,要先去掉)。
enum HostKind {
    Ip(std::net::IpAddr),
    Domain(String),
    None,
}

fn host_kind(url: &reqwest::Url) -> HostKind {
    let Some(host) = url.host_str() else {
        return HostKind::None;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<std::net::IpAddr>() {
        Ok(ip) => HostKind::Ip(ip),
        Err(_) => HostKind::Domain(host.trim_end_matches('.').to_ascii_lowercase()),
    }
}

/// 只看 URL 字面上的主机:IP 直接判断,`localhost` / `*.localhost` 拒绝。域名要不要放行由解析结果决定。
fn literal_host_allowed(url: &reqwest::Url) -> std::result::Result<(), String> {
    match host_kind(url) {
        HostKind::None => Err("URL 缺少主机".to_owned()),
        HostKind::Ip(ip) if is_blocked_ip(ip) => Err(format!("{ip} 是内网 / 本机地址,不允许抓取")),
        HostKind::Ip(_) => Ok(()),
        HostKind::Domain(domain) => {
            if domain == "localhost" || domain.ends_with(".localhost") {
                Err(format!("{domain} 是本机地址,不允许抓取"))
            } else {
                Ok(())
            }
        }
    }
}

/// 连接时的域名解析:只留公网地址。解析结果全是私有地址就当解析失败。
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|addr| !is_blocked_ip(addr.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("{} 只解析到内网 / 本机地址", name.as_str()).into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// 极简 URL(够抓取用;不引 `url` crate)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    /// `http` / `https`。
    pub scheme: String,
    /// 小写主机(含端口)。
    pub host: String,
    /// 路径(以 `/` 开头)。
    pub path: String,
    /// 查询串(可空)。
    pub query: String,
}

impl Url {
    /// 重新拼成完整 URL。
    pub fn to_string_with_query(&self) -> String {
        if self.query.is_empty() {
            format!("{}://{}{}", self.scheme, self.host, self.path)
        } else {
            format!(
                "{}://{}{}?{}",
                self.scheme, self.host, self.path, self.query
            )
        }
    }
}

/// 解析 URL;只接受 http / https。
pub fn parse_url(raw: &str) -> Result<Url> {
    let raw = raw.trim();
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| KbError::InvalidInput(format!("不是完整 URL:{raw}")))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(KbError::InvalidInput(format!("只支持 http / https:{raw}")));
    }
    let (authority, path_and_query) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let host = authority.to_ascii_lowercase();
    if host.is_empty() {
        return Err(KbError::InvalidInput(format!("URL 缺少主机:{raw}")));
    }
    let (path, query) = match path_and_query.split_once('?') {
        Some((path, query)) => (path.to_owned(), query.to_owned()),
        None => (path_and_query.to_owned(), String::new()),
    };
    let path = if path.is_empty() {
        "/".to_owned()
    } else {
        path
    };
    Ok(Url {
        scheme,
        host,
        path,
        query,
    })
}

/// 相对链接 → 绝对 URL(只处理 `/path`、`path`、`../path` 与完整 URL)。
fn resolve(base: &Url, link: &str) -> Option<String> {
    let link = link.trim();
    if link.is_empty()
        || link.starts_with('#')
        || link.starts_with("mailto:")
        || link.starts_with("javascript:")
    {
        return None;
    }
    if link.starts_with("http://") || link.starts_with("https://") {
        return Some(link.to_owned());
    }
    let base_dir = match base.path.rfind('/') {
        Some(index) => &base.path[..=index],
        None => "/",
    };
    let joined = if let Some(rest) = link.strip_prefix('/') {
        format!("/{rest}")
    } else {
        format!("{base_dir}{link}")
    };
    Some(format!(
        "{}://{}{}",
        base.scheme,
        base.host,
        normalize_path(&joined)
    ))
}

/// 归一化路径(去掉 `.` / `..` 段,去掉重复斜杠)。
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let mut out = String::from("/");
    out.push_str(&parts.join("/"));
    if path.ends_with('/') && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// 去重用:去掉片段与末尾斜杠。
fn normalize_url(raw: &str) -> String {
    let without_fragment = raw.split('#').next().unwrap_or(raw);
    match parse_url(without_fragment) {
        Ok(url) => {
            let mut text = url.to_string_with_query();
            if text.ends_with('/') {
                text.pop();
            }
            text
        }
        Err(_) => without_fragment.to_owned(),
    }
}

/// 落盘用的相对路径:`<host>/<path>`;目录型页面补 `index.html`。
fn page_rel_path(url: &Url) -> String {
    let host = url.host.replace(':', "_");
    let mut path = url.path.trim_start_matches('/').to_owned();
    if path.is_empty() {
        path = "index.html".to_owned();
    } else if path.ends_with('/') {
        path.push_str("index.html");
    } else if !path.contains('.') {
        // `/docs/install` 这种无扩展名的路径补成目录形式
        path.push_str("/index.html");
    }
    let path = path.replace("..", "_");
    format!("{host}/{path}")
}

/// 页面里出现的全部链接,按页面地址解析成绝对 URL(去掉 `#片段`,去重,保持出现顺序)。
///
/// 只留 http / https。给 AI 规范化当“真实链接集合”用:模型返回的链接必须在这里面,
/// 挡住它编造出来的地址。与抓取时的链接入队用同一套解析规则。
pub fn page_links(page_url: &str, html: &str) -> Vec<String> {
    let Ok(base) = parse_url(page_url) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for link in extract_links(html) {
        let link = decode_href(&link);
        // 带协议但不是 http(s) 的(ftp: / tel: / data: …):`resolve` 会把它当相对路径拼出假地址,先挡掉
        if has_other_scheme(&link) {
            continue;
        }
        let Some(absolute) = resolve(&base, &link) else {
            continue;
        };
        let without_fragment = absolute.split('#').next().unwrap_or(&absolute).to_owned();
        if !(without_fragment.starts_with("http://") || without_fragment.starts_with("https://")) {
            continue;
        }
        if seen.insert(without_fragment.clone()) {
            out.push(without_fragment);
        }
    }
    out
}

/// `href` 里常见的实体(`&amp;`)还原成字符,模型看到的正文链接是还原后的样子。
fn decode_href(raw: &str) -> String {
    raw.replace("&amp;", "&")
}

/// 是否以 http / https 之外的协议开头(`scheme:` 形式,RFC 3986 的协议名字符集)。
fn has_other_scheme(link: &str) -> bool {
    let link = link.trim();
    let Some((scheme, _)) = link.split_once(':') else {
        return false;
    };
    let looks_like_scheme = scheme
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'));
    looks_like_scheme && !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
}

/// 从 HTML 里取链接。
pub fn extract_links(html: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = html;
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(index) = lower[cursor..].find("href=") {
        let start = cursor + index + "href=".len();
        let tail = &rest[start..];
        let (value, consumed) = if let Some(stripped) = tail.strip_prefix('"') {
            match stripped.find('"') {
                Some(end) => (stripped[..end].to_owned(), end + 2),
                None => break,
            }
        } else if let Some(stripped) = tail.strip_prefix('\'') {
            match stripped.find('\'') {
                Some(end) => (stripped[..end].to_owned(), end + 2),
                None => break,
            }
        } else {
            let end = tail
                .find(|ch: char| ch.is_whitespace() || ch == '>')
                .unwrap_or(tail.len());
            (tail[..end].to_owned(), end)
        };
        cursor = start + consumed;
        links.push(value);
        if cursor >= lower.len() {
            break;
        }
    }
    let _ = &mut rest;
    links
}

/// robots.txt 的 `Disallow` 规则。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Robots {
    disallow: Vec<String>,
}

impl Robots {
    /// 解析;只看 `User-agent: *` 段落。
    pub fn parse(text: &str) -> Self {
        let mut disallow = Vec::new();
        let mut applies = false;
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or_default().trim();
            if line.is_empty() {
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            match key.as_str() {
                "user-agent" => applies = value == "*",
                "disallow" if applies && !value.is_empty() => disallow.push(value.to_owned()),
                _ => {}
            }
        }
        Self { disallow }
    }

    /// 这个路径能不能抓。
    pub fn allows(&self, path: &str) -> bool {
        !self
            .disallow
            .iter()
            .any(|rule| path.starts_with(rule.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_special_addresses_are_blocked_public_ones_are_not() {
        for blocked in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            // 云主机元数据服务:能拿到临时凭据
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "255.255.255.255",
            "224.0.0.1",
            "198.18.0.1",
            "::1",
            "::",
            "fd00::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            // IPv4 映射地址:换个写法不能绕过
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
        ] {
            let ip: std::net::IpAddr = blocked.parse().unwrap();
            assert!(is_blocked_ip(ip), "应拦截:{blocked}");
        }
        for public in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            let ip: std::net::IpAddr = public.parse().unwrap();
            assert!(!is_blocked_ip(ip), "不应拦截:{public}");
        }
    }

    #[test]
    fn literal_hosts_are_judged_after_url_normalisation() {
        // 各种把 127.0.0.1 写成别的样子的办法,URL 解析之后都是同一个地址
        for blocked in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://evil.example.com@127.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
        ] {
            let url = reqwest::Url::parse(blocked).unwrap();
            assert!(literal_host_allowed(&url).is_err(), "应拦截:{blocked}");
        }
        for fine in [
            "http://example.com/",
            "https://8.8.8.8/",
            "http://docs.example.com:8080/x",
        ] {
            let url = reqwest::Url::parse(fine).unwrap();
            assert!(literal_host_allowed(&url).is_ok(), "不应拦截:{fine}");
        }
    }

    #[test]
    fn a_domain_is_refused_when_any_resolved_address_is_private() {
        let ip = |text: &str| text.parse::<std::net::IpAddr>().unwrap();
        assert!(judge_resolution("docs.example.com", [ip("93.184.216.34")]).is_ok());
        // 混着公网地址也不行:连接时可能选到内网那个
        assert!(
            judge_resolution("evil.example.com", [ip("93.184.216.34"), ip("127.0.0.1")]).is_err()
        );
        assert!(judge_resolution("meta.example.com", [ip("169.254.169.254")]).is_err());
        assert!(judge_resolution("v6.example.com", [ip("fd00::5")]).is_err());
        assert!(judge_resolution("nothing.example.com", []).is_err());
    }

    #[tokio::test]
    async fn the_resolver_never_hands_out_loopback_addresses() {
        use reqwest::dns::Resolve;
        // `localhost` 只会解析到回环地址:全被滤掉,就是解析失败,而不是返回一个能连上内网的地址
        let name: reqwest::dns::Name = "localhost".parse().expect("域名");
        assert!(PublicOnlyResolver.resolve(name).await.is_err());
    }

    #[test]
    fn parses_and_normalises_urls() {
        let url = parse_url("https://Docs.Example.com/a/b?x=1").expect("解析");
        assert_eq!(url.host, "docs.example.com");
        assert_eq!(url.path, "/a/b");
        assert_eq!(url.query, "x=1");
        assert_eq!(
            url.to_string_with_query(),
            "https://docs.example.com/a/b?x=1"
        );
        assert!(parse_url("ftp://x/y").is_err());
        assert!(parse_url("example.com").is_err());
        assert_eq!(parse_url("https://a.com").expect("解析").path, "/");
    }

    #[test]
    fn resolves_relative_links() {
        let base = parse_url("https://a.com/docs/install/index.html").expect("解析");
        assert_eq!(
            resolve(&base, "../config.html").as_deref(),
            Some("https://a.com/docs/config.html")
        );
        assert_eq!(
            resolve(&base, "/top.html").as_deref(),
            Some("https://a.com/top.html")
        );
        assert_eq!(
            resolve(&base, "next.html").as_deref(),
            Some("https://a.com/docs/install/next.html")
        );
        assert!(resolve(&base, "#anchor").is_none());
        assert!(resolve(&base, "mailto:a@b.com").is_none());
    }

    #[test]
    fn page_links_are_absolute_deduplicated_and_http_only() {
        let html = r##"<a href="../config.html#top">配置</a>
<a href="../config.html">配置(重复)</a>
<a href="/api?x=1&amp;y=2">接口</a>
<a href="ftp://files.example/a">ftp</a>
<a href="mailto:a@b.com">信</a>
<a href="https://other.example/page">站外</a>"##;
        let links = page_links("https://a.com/docs/install/index.html", html);
        assert_eq!(
            links,
            vec![
                "https://a.com/docs/config.html".to_owned(),
                "https://a.com/api?x=1&y=2".to_owned(),
                "https://other.example/page".to_owned(),
            ]
        );
        assert!(page_links("不是网址", html).is_empty());
    }

    #[test]
    fn extracts_links_from_html() {
        let html = r#"<a href="/a.html">A</a> <a href='b.html'>B</a> <a href="https://x/y">Y</a>"#;
        let links = extract_links(html);
        assert_eq!(links, vec!["/a.html", "b.html", "https://x/y"]);
    }

    #[test]
    fn robots_disallow_is_respected() {
        let robots = Robots::parse("User-agent: *\nDisallow: /private\nAllow: /public\n");
        assert!(!robots.allows("/private/x.html"));
        assert!(robots.allows("/docs/x.html"));
        // 其它 agent 的段落不影响
        let other = Robots::parse("User-agent: bot\nDisallow: /\n");
        assert!(other.allows("/anything"));
    }

    #[test]
    fn page_paths_are_stable() {
        let url = parse_url("https://docs.example.com/guide/").expect("解析");
        assert_eq!(page_rel_path(&url), "docs.example.com/guide/index.html");
        let url = parse_url("https://docs.example.com/guide/install").expect("解析");
        assert_eq!(
            page_rel_path(&url),
            "docs.example.com/guide/install/index.html"
        );
        let url = parse_url("https://docs.example.com/a/b.html").expect("解析");
        assert_eq!(page_rel_path(&url), "docs.example.com/a/b.html");
    }
}
