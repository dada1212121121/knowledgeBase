//! 把锁定版本的 LibreOffice 装进数据目录(`kb convert install`,旧格式 Office 入库转换用，见下文)。
//!
//! 为什么这样装:
//! - **不依赖系统里装的 LibreOffice,也不改 `/usr`、`/etc`**:用文档基金会(TDF)的官方 Linux 整包。
//!   它自带运行库,解到哪个目录都能跑;Debian 的系统包写死了 `/usr/lib`、`/etc`, 实测要改三处才能挪地方;
//! - 装到 `<bin>/libreoffice-<版本>/`,再把 `<bin>/libreoffice` 这个符号链接指过去(转换器默认就找它)。
//!   换版本时先把新的装好、验过,最后一步才改链接,中途失败不影响正在用的那一份;上一个版本留着
//!   (正在跑的转换可能还在用它),更早的删掉;
//! - 下载后核对大小和 SHA-256(锁在代码里);离线时可以指定本地文件,同样核对;
//! - 有安全更新时改 [`Package::locked`] 的版本和哈希,随新版本发布;部署时重跑 `kb convert install` 就升级了。
//!
//! 解包用系统自带的 `tar`,每个 `.deb` 用 `dpkg-deb -x`(没有就用 `ar` + `tar`),不引入新的 Rust 依赖。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use kb_core::{KbError, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

/// 指向当前版本的符号链接名(`<bin>/libreoffice`)。
pub const LINK_NAME: &str = "libreoffice";
/// 装完整之后才写的标记文件:`<整包 SHA-256> <版本>`。
const MARKER: &str = ".kb-package";
/// 第一次启动 `soffice` 要建用户配置,机器忙的时候可能要几十秒。
const PROBE_TIMEOUT: Duration = Duration::from_secs(180);

/// 一个锁定的安装包。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Package {
    /// 版本号(装出来的目录名带它)。
    pub version: String,
    /// 下载地址(TDF 的下载站按地理位置跳到就近镜像)。
    pub url: String,
    /// 备用镜像:主地址跳到的镜像太慢或不通时按顺序换。内容靠 SHA-256 核对,镜像可以不可信。
    pub mirrors: Vec<String>,
    /// 整包的 SHA-256(十六进制小写)。
    pub sha256: String,
    /// 整包字节数。
    pub size: u64,
}

impl Package {
    /// 现在锁定的版本。26.2 是 TDF 的「still」分支(比 26.8 成熟,推荐给求稳的部署),
    /// 26.2.6 是它最新的修订(2026-09-03 发布)。哈希和大小取自 TDF 下载站的元数据页。
    pub fn locked() -> Self {
        Self {
            version: "26.2.6".to_owned(),
            url: "https://download.documentfoundation.org/libreoffice/stable/26.2.6/deb/x86_64/LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz".to_owned(),
            // 下载站的跳转按 IP 随机挑镜像,实测碰到过只有约 90 KB/s 的(217 MB 要 40 分钟),同一份文件在清华镜像 12 秒下完
            mirrors: vec![
                "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.2.6/deb/x86_64/LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz".to_owned(),
                "https://mirrors.nju.edu.cn/tdf/libreoffice/stable/26.2.6/deb/x86_64/LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz".to_owned(),
            ],
            sha256: "fd0e8f8f2408dd2e5b90286e60f3f97cf566ba441cd48cfc5bcc68067303e0bc".to_owned(),
            size: 217_285_735,
        }
    }

    /// 整包的文件名(地址的最后一段)。
    pub fn file_name(&self) -> String {
        self.url
            .rsplit('/')
            .next()
            .unwrap_or("libreoffice.tar.gz")
            .to_owned()
    }
}

/// 安装包从哪里来。
#[derive(Clone, Debug)]
pub enum Source {
    /// 从下载站下载(先直连,不行再走系统代理)。
    Download,
    /// 用本地已有的文件(离线安装)。
    File(PathBuf),
}

/// 安装结果。
#[derive(Clone, Debug, Serialize)]
pub struct Installed {
    /// 版本。
    pub version: String,
    /// 实际安装目录 `<bin>/libreoffice-<版本>`。
    pub dir: PathBuf,
    /// 转换器找的链接 `<bin>/libreoffice`。
    pub link: PathBuf,
    /// 本来就装好了,这次只核对了一下。
    pub already: bool,
    /// `soffice --version` 的输出。
    pub reported: String,
}

/// 某个版本的安装目录。
pub fn install_dir(bin_dir: &Path, version: &str) -> PathBuf {
    bin_dir.join(format!("libreoffice-{version}"))
}

/// 当前链接指向的版本(读标记文件)。没装、或是手动放进去的(没有标记)返回 `None`。
pub fn installed_version(bin_dir: &Path) -> Option<String> {
    let marker = std::fs::read_to_string(bin_dir.join(LINK_NAME).join(MARKER)).ok()?;
    marker.split_whitespace().nth(1).map(str::to_owned)
}

/// 这个版本已经完整装好(有 `soffice`,标记里的哈希对得上)。
fn is_complete(dir: &Path, package: &Package) -> bool {
    dir.join("program").join("soffice").is_file()
        && std::fs::read_to_string(dir.join(MARKER))
            .ok()
            .and_then(|marker| marker.split_whitespace().next().map(str::to_owned))
            .is_some_and(|sha256| sha256 == package.sha256)
}

/// 安装(已经装好就只核对一遍)。
pub async fn install(bin_dir: &Path, package: &Package, source: Source) -> Result<Installed> {
    std::fs::create_dir_all(bin_dir)
        .map_err(|err| io_error(&format!("创建 {}", bin_dir.display()), err))?;
    let target = install_dir(bin_dir, &package.version);
    let link = bin_dir.join(LINK_NAME);
    if is_complete(&target, package) {
        let reported = probe_version(&target, package).await?;
        switch_link(bin_dir, &target)?;
        return Ok(Installed {
            version: package.version.clone(),
            dir: target,
            link,
            already: true,
            reported,
        });
    }
    let (archive, downloaded) = match source {
        Source::File(path) => {
            let checked = path.clone();
            let expected = package.clone();
            blocking(move || verify(&checked, &expected)).await?;
            (path, false)
        }
        Source::Download => (download(bin_dir, package).await?, true),
    };
    let staging = bin_dir.join(format!(".libreoffice-{}.staging", package.version));
    {
        let (archive, staging, target, package) = (
            archive.clone(),
            staging.clone(),
            target.clone(),
            package.clone(),
        );
        blocking(move || unpack(&archive, &staging, &target, &package)).await?;
    }
    let reported = match probe_version(&target, package).await {
        Ok(reported) => reported,
        Err(err) => {
            // 起不来的安装不留着:下次重装,也免得转换器找到一个坏的
            let _ = std::fs::remove_dir_all(&target);
            return Err(err);
        }
    };
    switch_link(bin_dir, &target)?;
    if downloaded {
        let _ = std::fs::remove_file(&archive);
    }
    Ok(Installed {
        version: package.version.clone(),
        dir: target,
        link,
        already: false,
        reported,
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| KbError::Internal(format!("安装任务异常退出: {err}")))?
}

fn io_error(what: &str, err: std::io::Error) -> KbError {
    KbError::Internal(format!("{what}失败: {err}"))
}

/// 核对大小和 SHA-256。不对就报错并说清楚是哪一项。
pub fn verify(path: &Path, package: &Package) -> Result<()> {
    let size = std::fs::metadata(path)
        .map_err(|err| io_error(&format!("读取 {}", path.display()), err))?
        .len();
    if size != package.size {
        return Err(KbError::InvalidInput(format!(
            "{} 的大小是 {size} 字节,应为 {} 字节(LibreOffice {}),不是这个版本的官方整包或没下完",
            path.display(),
            package.size,
            package.version
        )));
    }
    let mut file = std::fs::File::open(path)
        .map_err(|err| io_error(&format!("打开 {}", path.display()), err))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| io_error(&format!("读取 {}", path.display()), err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != package.sha256 {
        return Err(KbError::InvalidInput(format!(
            "{} 的 SHA-256 是 {actual},应为 {}:文件被改过或损坏,不能安装",
            path.display(),
            package.sha256
        )));
    }
    Ok(())
}

/// 下载的超时和最低速度(测试里调小)。
#[derive(Clone, Debug)]
pub struct DownloadPolicy {
    /// 建立连接的时限。
    pub connect_timeout: Duration,
    /// 一次读取多久没数据就算卡死。
    pub read_timeout: Duration,
    /// 每个窗口至少要下到多少字节/秒,低于就换下一个地址(最后一个地址不限速,慢也要下完)。
    pub min_bytes_per_sec: u64,
    /// 统计速度的窗口。
    pub rate_window: Duration,
    /// 直连不通时是否再试系统代理。
    pub try_proxy: bool,
}

impl Default for DownloadPolicy {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(20),
            read_timeout: Duration::from_secs(60),
            min_bytes_per_sec: 256 * 1024,
            rate_window: Duration::from_secs(15),
            try_proxy: true,
        }
    }
}

/// 下载到 `<bin>/.downloads/`,支持断点续传;核对通过才返回。
async fn download(bin_dir: &Path, package: &Package) -> Result<PathBuf> {
    download_with(bin_dir, package, &DownloadPolicy::default()).await
}

/// [`download`] 的实现。依次试主地址和备用镜像;每个地址先直连、不通再走系统代理
/// (直连通常比本机代理快得多:实测代理约 95 KB/s,直连镜像 12 秒下完)。
/// 太慢、不通、下完核对不过(镜像给了别的内容)都换下一个,已经下到的部分接着用 Range 续传。
async fn download_with(
    bin_dir: &Path,
    package: &Package,
    policy: &DownloadPolicy,
) -> Result<PathBuf> {
    let dir = bin_dir.join(".downloads");
    std::fs::create_dir_all(&dir)
        .map_err(|err| io_error(&format!("创建 {}", dir.display()), err))?;
    let done = dir.join(package.file_name());
    let part = dir.join(format!("{}.part", package.file_name()));
    if done.is_file() {
        let (path, expected) = (done.clone(), package.clone());
        if blocking(move || verify(&path, &expected)).await.is_ok() {
            return Ok(done);
        }
        let _ = std::fs::remove_file(&done);
    }
    let urls: Vec<&String> = std::iter::once(&package.url)
        .chain(package.mirrors.iter())
        .collect();
    let routes: &[(bool, &str)] = if policy.try_proxy {
        &[(true, "直连"), (false, "系统代理")]
    } else {
        &[(true, "直连")]
    };
    let attempts = urls.len() * routes.len();
    let mut failures = Vec::new();
    let mut attempt = 0;
    for url in &urls {
        for (direct, label) in routes {
            attempt += 1;
            // 上次中断时已经下完的:不用再请求(再请求 Range 会得到 416)
            let have = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
            if have != package.size {
                let builder = reqwest::Client::builder()
                    .connect_timeout(policy.connect_timeout)
                    .read_timeout(policy.read_timeout);
                let builder = if *direct { builder.no_proxy() } else { builder };
                let client = builder
                    .build()
                    .map_err(|err| KbError::Internal(format!("建下载客户端失败: {err}")))?;
                let enforce_rate = attempt < attempts;
                if let Err(err) = fetch(&client, url, &part, policy, enforce_rate).await {
                    failures.push(format!("{url}({label}):{err}"));
                    continue;
                }
            }
            let (path, expected) = (part.clone(), package.clone());
            match blocking(move || verify(&path, &expected)).await {
                Ok(()) => {
                    std::fs::rename(&part, &done)
                        .map_err(|err| io_error(&format!("改名 {}", part.display()), err))?;
                    return Ok(done);
                }
                Err(err) => {
                    // 这个地址给的内容不对:丢掉,从头换下一个地址
                    let _ = std::fs::remove_file(&part);
                    failures.push(format!("{url}({label}):{err}"));
                }
            }
        }
    }
    Err(KbError::Unavailable(format!(
        "下载 LibreOffice {} 失败({});离线安装可以先把 {} 拷到本机,再用 `kb convert install --from <文件>`",
        package.version,
        failures.join(";"),
        package.file_name()
    )))
}

/// 下载到 `part`;已经有一部分就用 Range 接着下(服务器不支持续传时从头下)。
/// `enforce_rate` 为真时,速度连续一个窗口低于下限就放弃(返回错误,由调用方换地址)。
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    policy: &DownloadPolicy,
    enforce_rate: bool,
) -> Result<()> {
    let have = std::fs::metadata(part).map(|meta| meta.len()).unwrap_or(0);
    let mut request = client.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|err| KbError::Unavailable(err.to_string()))?;
    let append = have > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(part)
        .await
        .map_err(|err| io_error(&format!("打开 {}", part.display()), err))?;
    let mut window_started = std::time::Instant::now();
    let mut window_bytes = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| KbError::Unavailable(err.to_string()))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| io_error(&format!("写入 {}", part.display()), err))?;
        window_bytes += chunk.len() as u64;
        let elapsed = window_started.elapsed();
        if elapsed >= policy.rate_window {
            let rate = window_bytes as f64 / elapsed.as_secs_f64();
            if enforce_rate && rate < policy.min_bytes_per_sec as f64 {
                let _ = file.flush().await;
                return Err(KbError::Unavailable(format!(
                    "太慢了({:.0} KB/s,要求至少 {} KB/s)",
                    rate / 1024.0,
                    policy.min_bytes_per_sec / 1024
                )));
            }
            window_started = std::time::Instant::now();
            window_bytes = 0;
        }
    }
    file.flush()
        .await
        .map_err(|err| io_error(&format!("写入 {}", part.display()), err))?;
    Ok(())
}

/// 跟转换无关、不必装的包:桌面集成、界面插件、拼写词典、在线更新,以及宏脚本的运行环境
/// (Python / BeanShell / JavaScript)——我们从不执行文档里的宏,少装这些也少一块受攻击的面。
const SKIPPED_PACKAGES: &[&str] = &[
    "-desktop-integration",
    "-gnome-integration",
    "-kde-integration",
    "-qt5",
    "-qt6",
    "-kf5",
    "-kf6",
    "-gtk3",
    "-gtk4",
    "-dict-",
    "-onlineupdate",
    "-librelogo",
    "-ogltrans",
    "-debian-menus",
    "-freedesktop-menus",
    "-pyuno",
    "script-provider",
    "-postgresql-sdbc",
    "-report-builder",
];

/// 挑出要装的 `.deb`(按文件名)。
pub fn select_packages(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| name.ends_with(".deb"))
        .filter(|name| !SKIPPED_PACKAGES.iter().any(|skip| name.contains(skip)))
        .cloned()
        .collect()
}

fn run(command: &mut Command, what: &str) -> Result<()> {
    let output = command.output().map_err(|err| {
        KbError::Unavailable(format!(
            "{what}:启动失败({err}),需要系统里有 tar、dpkg-deb 或 ar"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }
    Err(KbError::Internal(format!(
        "{what}失败({}):{}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

/// 解开整包、装进 `target`、写上标记。在阻塞线程里跑。
fn unpack(archive: &Path, staging: &Path, target: &Path, package: &Package) -> Result<()> {
    if staging.exists() {
        std::fs::remove_dir_all(staging)
            .map_err(|err| io_error(&format!("清理 {}", staging.display()), err))?;
    }
    let (outer, root) = (staging.join("package"), staging.join("root"));
    for dir in [&outer, &root] {
        std::fs::create_dir_all(dir)
            .map_err(|err| io_error(&format!("创建 {}", dir.display()), err))?;
    }
    let result = (|| {
        run(
            Command::new("tar")
                .arg("-xzf")
                .arg(archive)
                .arg("-C")
                .arg(&outer),
            "解开安装包",
        )?;
        let debs = find_debs(&outer)?;
        let names: Vec<String> = debs
            .iter()
            .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
            .collect();
        let chosen = select_packages(&names);
        if chosen.is_empty() {
            return Err(KbError::InvalidInput(
                "安装包里没有可装的 .deb,不是 LibreOffice 的 Linux deb 整包".to_owned(),
            ));
        }
        for deb in debs.iter().filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| chosen.iter().any(|chosen| chosen == name))
        }) {
            extract_deb(deb, &root, staging)?;
        }
        let office = find_office_root(&root)?;
        if target.exists() {
            // 上次没装完的残留(没有标记,否则前面就判定为已安装了)
            std::fs::remove_dir_all(target)
                .map_err(|err| io_error(&format!("清理 {}", target.display()), err))?;
        }
        std::fs::rename(&office, target)
            .map_err(|err| io_error(&format!("移动到 {}", target.display()), err))?;
        std::fs::write(
            target.join(MARKER),
            format!("{} {}\n", package.sha256, package.version),
        )
        .map_err(|err| io_error("写安装标记", err))?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(staging);
    result
}

/// 整包解开后是 `<目录>/DEBS/*.deb`。
fn find_debs(outer: &Path) -> Result<Vec<PathBuf>> {
    let mut debs = Vec::new();
    for top in std::fs::read_dir(outer)
        .map_err(|err| io_error("读取解开的安装包", err))?
        .flatten()
    {
        let dir = top.path().join("DEBS");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|ext| ext.to_str()) == Some("deb") {
                debs.push(entry.path());
            }
        }
    }
    debs.sort();
    if debs.is_empty() {
        return Err(KbError::InvalidInput(
            "安装包里没有 DEBS 目录,不是 LibreOffice 的 Linux deb 整包".to_owned(),
        ));
    }
    Ok(debs)
}

/// 把一个 `.deb` 的文件解到 `root`:优先 `dpkg-deb -x`,没有就用 `ar` 取出 `data.tar.*` 再解。
fn extract_deb(deb: &Path, root: &Path, staging: &Path) -> Result<()> {
    extract_deb_with("dpkg-deb", deb, root, staging)
}

/// [`extract_deb`] 的实现;`dpkg_deb` 是命令名(测试里换成不存在的名字,走 `ar` 那条路)。
fn extract_deb_with(dpkg_deb: &str, deb: &Path, root: &Path, staging: &Path) -> Result<()> {
    let label = format!(
        "解开 {}",
        deb.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("deb")
    );
    match Command::new(dpkg_deb).arg("-x").arg(deb).arg(root).output() {
        Ok(output) if output.status.success() => return Ok(()),
        Ok(output) => {
            return Err(KbError::Internal(format!(
                "{label}失败:{}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(KbError::Unavailable(format!("{label}:{err}"))),
    }
    let scratch = staging.join("ar");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|err| io_error("创建临时目录", err))?;
    run(
        Command::new("ar").arg("x").arg(deb).current_dir(&scratch),
        &label,
    )?;
    let data = std::fs::read_dir(&scratch)
        .map_err(|err| io_error("读取临时目录", err))?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("data.tar"))
        })
        .ok_or_else(|| KbError::InvalidInput(format!("{label}:里面没有 data.tar")))?;
    run(
        Command::new("tar")
            .arg("-xf")
            .arg(&data)
            .arg("-C")
            .arg(root),
        &label,
    )?;
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// 解出来的程序在 `root/opt/libreoffice<主版本>/`。
fn find_office_root(root: &Path) -> Result<PathBuf> {
    std::fs::read_dir(root.join("opt"))
        .map_err(|err| io_error("读取解开的文件", err))?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("libreoffice"))
                && path.join("program").join("soffice").is_file()
        })
        .ok_or_else(|| {
            KbError::InvalidInput("解开后没找到 opt/libreoffice*/program/soffice".to_owned())
        })
}

/// 跑一次 `soffice --version`,确认装好的能从这个目录启动、版本对得上。
/// 用一次性的用户配置目录和 HOME,不碰运行账号自己的目录。
pub async fn probe_version(dir: &Path, package: &Package) -> Result<String> {
    let soffice = dir.join("program").join("soffice");
    let scratch = tempfile_dir(dir)?;
    let profile = scratch.join("profile");
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::process::Command::new(&soffice)
            .arg("--headless")
            .arg(format!(
                "-env:UserInstallation=file://{}",
                profile.display()
            ))
            .arg("--version")
            .env("HOME", &scratch)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let _ = std::fs::remove_dir_all(&scratch);
    let output = output
        .map_err(|_| {
            KbError::Unavailable(format!(
                "{} --version 在 {} 秒内没有返回",
                soffice.display(),
                PROBE_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|err| KbError::Unavailable(format!("启动 {} 失败: {err}", soffice.display())))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || !stdout.contains(&package.version) {
        return Err(KbError::Unavailable(format!(
            "{} 起不来或版本不对(退出码 {},输出 {stdout:?},错误 {:?})",
            soffice.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(stdout)
}

/// 安装目录旁边的一次性目录(和安装目录在同一个文件系统上,不用系统的 /tmp)。
fn tempfile_dir(dir: &Path) -> Result<PathBuf> {
    let parent = dir.parent().unwrap_or(dir);
    let scratch = parent.join(format!(".probe-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&scratch).map_err(|err| io_error("创建临时目录", err))?;
    Ok(scratch)
}

/// 把 `<bin>/libreoffice` 原子地指到 `target`(相对链接,数据目录整体搬走也不断)。
///
/// 那里是个真目录(手动放进去的安装)就不动它,报错让人先挪走。改完链接后,
/// 除了当前和上一个版本,更早的 `libreoffice-*` 目录都删掉:上一个版本可能还有转换在用。
pub fn switch_link(bin_dir: &Path, target: &Path) -> Result<()> {
    let link = bin_dir.join(LINK_NAME);
    let previous = match std::fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::read_link(&link).ok().map(|to| {
            if to.is_absolute() {
                to
            } else {
                bin_dir.join(to)
            }
        }),
        Ok(_) => {
            return Err(KbError::Exists(format!(
                "{} 已经存在,而且不是 `kb convert install` 建的链接(可能是手动安装的);先把它挪走再装",
                link.display()
            )));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(io_error(&format!("读取 {}", link.display()), err)),
    };
    let name = target
        .file_name()
        .ok_or_else(|| KbError::InvalidInput(format!("安装目录 {} 不合法", target.display())))?;
    let temporary = bin_dir.join(format!(".{LINK_NAME}.link-{}", uuid::Uuid::now_v7()));
    std::os::unix::fs::symlink(name, &temporary).map_err(|err| io_error("建符号链接", err))?;
    if let Err(err) = std::fs::rename(&temporary, &link) {
        let _ = std::fs::remove_file(&temporary);
        return Err(io_error(&format!("替换 {}", link.display()), err));
    }
    let keep: Vec<PathBuf> = std::iter::once(target.to_path_buf())
        .chain(previous)
        .collect();
    if let Ok(entries) = std::fs::read_dir(bin_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_version = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("libreoffice-"));
            let is_real_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            if is_version && is_real_dir && !keep.contains(&path) {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has(tool: &str) -> bool {
        Command::new(tool)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn write_exec(path: &Path, content: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().expect("上级目录")).expect("建目录");
        std::fs::write(path, content).expect("写");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("权限");
    }

    /// 用 `dpkg-deb --build` 做一个只含若干文件的 `.deb`。
    fn build_deb(work: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = work.join(format!("{name}.root"));
        std::fs::create_dir_all(root.join("DEBIAN")).expect("建目录");
        std::fs::write(
            root.join("DEBIAN").join("control"),
            format!(
                "Package: {name}\nVersion: 9.9.9\nArchitecture: amd64\nMaintainer: test <t@example.com>\nDescription: test\n"
            ),
        )
        .expect("写 control");
        for (path, content) in files {
            write_exec(&root.join(path), content);
        }
        let deb = work.join(format!("{name}_9.9.9_amd64.deb"));
        run(
            Command::new("dpkg-deb")
                .arg("--build")
                .arg("--root-owner-group")
                .arg(&root)
                .arg(&deb),
            "打 deb",
        )
        .expect("打 deb");
        deb
    }

    const FAKE_SOFFICE: &str = "#!/bin/sh\necho 'LibreOffice 9.9.9.1 0000test'\n";

    /// 做一个结构和官方一样的整包:`LibreOffice_9.9.9_Linux_x86-64_deb/DEBS/*.deb`。
    /// 其中一个是应该跳过的桌面集成包。返回整包路径和对应的 [`Package`]。
    fn build_package(work: &Path) -> (PathBuf, Package) {
        let top = work.join("LibreOffice_9.9.9_Linux_x86-64_deb");
        let debs = top.join("DEBS");
        std::fs::create_dir_all(&debs).expect("建目录");
        let core = build_deb(
            work,
            "libreoffice9.9-core",
            &[("opt/libreoffice9.9/program/soffice", FAKE_SOFFICE)],
        );
        let skipped = build_deb(
            work,
            "libreoffice9.9-gnome-integration",
            &[("opt/libreoffice9.9/program/gnome-marker", "x")],
        );
        for deb in [&core, &skipped] {
            std::fs::rename(deb, debs.join(deb.file_name().expect("文件名"))).expect("挪");
        }
        let archive = work.join("LibreOffice_9.9.9_Linux_x86-64_deb.tar.gz");
        run(
            Command::new("tar")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(work)
                .arg("LibreOffice_9.9.9_Linux_x86-64_deb"),
            "打整包",
        )
        .expect("打整包");
        let bytes = std::fs::read(&archive).expect("读");
        let package = Package {
            version: "9.9.9".to_owned(),
            url: "https://example.invalid/LibreOffice_9.9.9_Linux_x86-64_deb.tar.gz".to_owned(),
            mirrors: Vec::new(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            size: bytes.len() as u64,
        };
        (archive, package)
    }

    #[test]
    fn the_locked_package_names_its_file() {
        let package = Package::locked();
        assert_eq!(
            package.file_name(),
            "LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz"
        );
        assert!(package.url.ends_with(&package.file_name()));
        assert_eq!(package.sha256.len(), 64);
    }

    #[test]
    fn desktop_integration_and_macro_runtimes_are_not_installed() {
        let names: Vec<String> = [
            "libreoffice26.2_26.2.6.2-2_amd64.deb",
            "libobasis26.2-core_26.2.6.2-2_amd64.deb",
            "libobasis26.2-writer_26.2.6.2-2_amd64.deb",
            "libobasis26.2-impress_26.2.6.2-2_amd64.deb",
            "libobasis26.2-gnome-integration_26.2.6.2-2_amd64.deb",
            "libobasis26.2-kde-integration_26.2.6.2-2_amd64.deb",
            "libobasis26.2-pyuno_26.2.6.2-2_amd64.deb",
            "libobasis26.2-python-script-provider_26.2.6.2-2_amd64.deb",
            "libreoffice26.2-dict-en_26.2.6.2-2_amd64.deb",
            "readme.txt",
        ]
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
        let chosen = select_packages(&names);
        assert!(chosen.contains(&names[0]));
        assert!(chosen.contains(&names[1]));
        assert!(chosen.contains(&names[2]));
        assert!(chosen.contains(&names[3]));
        for skipped in &names[4..] {
            assert!(!chosen.contains(skipped), "不该装 {skipped}");
        }
    }

    #[test]
    fn a_package_with_the_wrong_size_or_hash_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let file = dir.path().join("pkg.tar.gz");
        std::fs::write(&file, b"abc").expect("写");
        let right = Package {
            version: "1".to_owned(),
            url: "https://example.invalid/pkg.tar.gz".to_owned(),
            mirrors: Vec::new(),
            sha256: format!("{:x}", Sha256::digest(b"abc")),
            size: 3,
        };
        verify(&file, &right).expect("对得上");
        let wrong_size = Package {
            size: 4,
            ..right.clone()
        };
        let err = verify(&file, &wrong_size).expect_err("大小不对");
        assert!(err.to_string().contains("大小"), "{err}");
        let wrong_hash = Package {
            sha256: "0".repeat(64),
            ..right
        };
        let err = verify(&file, &wrong_hash).expect_err("哈希不对");
        assert!(err.to_string().contains("SHA-256"), "{err}");
    }

    #[test]
    fn the_link_is_switched_atomically_and_only_the_previous_version_is_kept() {
        let bin = tempfile::tempdir().expect("临时目录");
        let bin = bin.path();
        let (v1, v2, v3) = (
            install_dir(bin, "1"),
            install_dir(bin, "2"),
            install_dir(bin, "3"),
        );
        let unrelated = bin.join("llama.cpp");
        std::fs::create_dir_all(&unrelated).expect("建目录");

        // 版本是一个个装上来的:每次装好新的才改链接
        std::fs::create_dir_all(&v1).expect("建目录");
        switch_link(bin, &v1).expect("第一次");
        assert_eq!(
            std::fs::read_link(bin.join(LINK_NAME)).expect("链接"),
            PathBuf::from("libreoffice-1"),
            "相对链接"
        );
        std::fs::create_dir_all(&v2).expect("建目录");
        switch_link(bin, &v2).expect("换到 2");
        assert!(v1.exists(), "上一个版本留着");
        std::fs::create_dir_all(&v3).expect("建目录");
        switch_link(bin, &v3).expect("换到 3");
        assert_eq!(
            std::fs::read_link(bin.join(LINK_NAME)).expect("链接"),
            PathBuf::from("libreoffice-3")
        );
        assert!(v2.exists(), "上一个版本留着");
        assert!(!v1.exists(), "更早的删掉");
        assert!(unrelated.exists(), "别的目录不碰");
    }

    #[test]
    fn a_hand_made_install_directory_is_never_replaced() {
        let bin = tempfile::tempdir().expect("临时目录");
        let manual = bin.path().join(LINK_NAME);
        std::fs::create_dir_all(manual.join("program")).expect("建目录");
        let target = install_dir(bin.path(), "1");
        std::fs::create_dir_all(&target).expect("建目录");
        let err = switch_link(bin.path(), &target).expect_err("不能覆盖手动安装");
        assert!(err.to_string().contains("挪走"), "{err}");
        assert!(manual.join("program").is_dir(), "原样留着");
    }

    #[test]
    fn without_dpkg_deb_the_files_come_out_through_ar_and_tar() {
        if !has("dpkg-deb") || !has("ar") {
            eprintln!("跳过:没有 dpkg-deb / ar");
            return;
        }
        let work = tempfile::tempdir().expect("临时目录");
        let deb = build_deb(
            work.path(),
            "libreoffice9.9-core",
            &[("opt/libreoffice9.9/program/soffice", FAKE_SOFFICE)],
        );
        let root = work.path().join("root");
        std::fs::create_dir_all(&root).expect("建目录");
        extract_deb_with("dpkg-deb-that-does-not-exist", &deb, &root, work.path())
            .expect("ar + tar");
        assert!(root.join("opt/libreoffice9.9/program/soffice").is_file());
    }

    /// 整个流程:核对 → 解包(跳过不需要的包)→ 启动核对版本 → 改链接;再装一次什么都不做。
    #[tokio::test]
    async fn an_offline_install_unpacks_probes_and_links_and_is_idempotent() {
        if !has("dpkg-deb") {
            eprintln!("跳过:没有 dpkg-deb");
            return;
        }
        let work = tempfile::tempdir().expect("临时目录");
        let (archive, package) = build_package(work.path());
        let bin = work.path().join("bin");

        let installed = install(&bin, &package, Source::File(archive.clone()))
            .await
            .expect("安装");
        assert!(!installed.already);
        assert!(
            installed.reported.contains("9.9.9"),
            "{}",
            installed.reported
        );
        let link = bin.join(LINK_NAME);
        assert!(
            link.join("program").join("soffice").is_file(),
            "转换器找得到"
        );
        assert!(
            !link.join("program").join("gnome-marker").exists(),
            "桌面集成包没装"
        );
        assert_eq!(installed_version(&bin).as_deref(), Some("9.9.9"));
        assert!(
            !bin.join(".libreoffice-9.9.9.staging").exists(),
            "解包的临时目录清掉了"
        );
        assert!(archive.exists(), "离线安装不删用户给的文件");

        let again = install(&bin, &package, Source::File(archive))
            .await
            .expect("再装");
        assert!(again.already, "装好了就不重装");
    }

    // ---- 下载:本地 HTTP 服务模拟好的 / 坏的 / 慢的镜像 ----

    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 每条路径一种行为的小 HTTP 服务。`/ok` 支持 Range;`/fail` 回 500;`/wrong` 回同样长度的别的内容;
    /// `/slow` 每 100 毫秒只吐 1 KB(模拟只有 10 KB/s 的镜像);`/stall` 发完头就不再发数据。
    /// 收到的请求:(路径, Range 起点)。
    type Hits = Arc<std::sync::Mutex<Vec<(String, Option<u64>)>>>;

    struct Mirror {
        base: String,
        hits: Hits,
        body: Arc<Vec<u8>>,
    }

    async fn mirror(body: Vec<u8>) -> Mirror {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("监听");
        let base = format!("http://{}", listener.local_addr().expect("地址"));
        let body = Arc::new(body);
        let hits = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (served, log) = (body.clone(), hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let (body, log) = (served.clone(), log.clone());
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 4096];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let from = request
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("range: bytes=")
                                .map(str::to_owned)
                        })
                        .and_then(|value| value.trim_end_matches('-').parse::<u64>().ok());
                    log.lock().expect("锁").push((path.clone(), from));
                    let header = |status: &str, length: usize, extra: &str| {
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n{extra}\r\n"
                        )
                    };
                    match path.as_str() {
                        "/ok" | "/slow" | "/stall" | "/wrong" => {
                            let mut bytes: Vec<u8> = body.to_vec();
                            if path == "/wrong" {
                                bytes.iter_mut().for_each(|byte| *byte ^= 0xff);
                            }
                            let start = from.unwrap_or(0) as usize;
                            let (status, extra) = if from.is_some() {
                                (
                                    "206 Partial Content",
                                    format!(
                                        "Content-Range: bytes {start}-{}/{}\r\n",
                                        bytes.len() - 1,
                                        bytes.len()
                                    ),
                                )
                            } else {
                                ("200 OK", String::new())
                            };
                            let rest = &bytes[start.min(bytes.len())..];
                            if stream
                                .write_all(header(status, rest.len(), &extra).as_bytes())
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match path.as_str() {
                                "/stall" => tokio::time::sleep(Duration::from_secs(30)).await,
                                "/slow" => {
                                    for piece in rest.chunks(1024) {
                                        if stream.write_all(piece).await.is_err() {
                                            return;
                                        }
                                        tokio::time::sleep(Duration::from_millis(100)).await;
                                    }
                                }
                                _ => {
                                    let _ = stream.write_all(rest).await;
                                }
                            }
                        }
                        _ => {
                            let _ = stream
                                .write_all(header("500 Internal Server Error", 0, "").as_bytes())
                                .await;
                        }
                    }
                });
            }
        });
        Mirror { base, hits, body }
    }

    impl Mirror {
        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }
        fn hit_paths(&self) -> Vec<String> {
            self.hits
                .lock()
                .expect("锁")
                .iter()
                .map(|(path, _)| path.clone())
                .collect()
        }
        fn package(&self, first: &str, mirrors: &[&str]) -> Package {
            Package {
                version: "9.9.9".to_owned(),
                url: self.url(first),
                mirrors: mirrors.iter().map(|path| self.url(path)).collect(),
                sha256: format!("{:x}", Sha256::digest(self.body.as_slice())),
                size: self.body.len() as u64,
            }
        }
    }

    fn quick_policy() -> DownloadPolicy {
        DownloadPolicy {
            connect_timeout: Duration::from_secs(2),
            read_timeout: Duration::from_millis(600),
            min_bytes_per_sec: 100 * 1024,
            rate_window: Duration::from_millis(400),
            try_proxy: false,
        }
    }

    fn sample_body() -> Vec<u8> {
        // 够大,让「慢」的镜像在窗口内一定下不完
        (0..300_000u32).map(|index| (index % 251) as u8).collect()
    }

    #[tokio::test]
    async fn the_download_falls_back_to_the_next_mirror_when_the_first_fails() {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/fail", &["/ok"]);
        let path = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert_eq!(std::fs::read(&path).expect("读"), server.body.as_slice());
        assert_eq!(server.hit_paths(), vec!["/fail", "/ok"]);
        assert!(
            !bin.path()
                .join(".downloads")
                .join(format!("{}.part", package.file_name()))
                .exists(),
            "改名后没有 .part"
        );
    }

    #[tokio::test]
    async fn a_mirror_that_is_too_slow_is_abandoned_and_the_next_one_resumes_from_where_it_stopped()
    {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/slow", &["/ok"]);
        let started = std::time::Instant::now();
        let path = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "慢镜像应在一个窗口后就放弃,而不是下完(下完要 30 秒)"
        );
        assert_eq!(std::fs::read(&path).expect("读"), server.body.as_slice());
        let hits = server.hits.lock().expect("锁").clone();
        assert_eq!(hits[0], ("/slow".to_owned(), None));
        let (second_path, resumed_from) = &hits[1];
        assert_eq!(second_path, "/ok");
        assert!(
            resumed_from.is_some_and(|offset| offset > 0),
            "接着已经下到的部分续传:{hits:?}"
        );
    }

    #[tokio::test]
    async fn the_last_candidate_is_never_dropped_for_being_slow() {
        let server = mirror(sample_body().into_iter().take(20_000).collect()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        // 只有一个地址,而且慢(每 100 毫秒 1 KB,20 KB 要 2 秒):不限速,慢也要下完
        let package = server.package("/slow", &[]);
        let path = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert_eq!(std::fs::read(&path).expect("读"), server.body.as_slice());
    }

    #[tokio::test]
    async fn a_stalled_connection_times_out_and_the_next_mirror_is_used() {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/stall", &["/ok"]);
        let started = std::time::Instant::now();
        download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(server.hit_paths(), vec!["/stall", "/ok"]);
    }

    /// 镜像给了别的内容(长度对、哈希不对):丢掉,从头换下一个,不能把坏内容留下当成续传的基础。
    #[tokio::test]
    async fn a_mirror_serving_the_wrong_bytes_is_discarded_and_the_next_starts_from_zero() {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/wrong", &["/ok"]);
        let path = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert_eq!(std::fs::read(&path).expect("读"), server.body.as_slice());
        let hits = server.hits.lock().expect("锁").clone();
        assert_eq!(
            hits,
            vec![("/wrong".to_owned(), None), ("/ok".to_owned(), None)],
            "第二个从头下,不带 Range"
        );
    }

    /// 上次已经下完但没来得及核对改名就被中断:不再请求(再请求 Range 会得到 416),直接核对。
    #[tokio::test]
    async fn a_finished_part_file_is_verified_without_asking_the_server_again() {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/ok", &[]);
        let dir = bin.path().join(".downloads");
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(
            dir.join(format!("{}.part", package.file_name())),
            server.body.as_slice(),
        )
        .expect("写");
        let path = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect("下载");
        assert_eq!(std::fs::read(&path).expect("读"), server.body.as_slice());
        assert!(server.hit_paths().is_empty(), "不该再请求服务器");
    }

    #[tokio::test]
    async fn every_address_failing_is_reported_with_each_reason() {
        let server = mirror(sample_body()).await;
        let bin = tempfile::tempdir().expect("临时目录");
        let package = server.package("/fail", &["/wrong"]);
        let error = download_with(bin.path(), &package, &quick_policy())
            .await
            .expect_err("都不行");
        let text = error.to_string();
        assert!(text.contains("/fail") && text.contains("/wrong"), "{text}");
        assert!(text.contains("SHA-256"), "{text}");
        assert!(text.contains("--from"), "要提示离线安装:{text}");
    }

    #[tokio::test]
    async fn a_tampered_package_installs_nothing() {
        if !has("dpkg-deb") {
            eprintln!("跳过:没有 dpkg-deb");
            return;
        }
        let work = tempfile::tempdir().expect("临时目录");
        let (archive, package) = build_package(work.path());
        let mut bytes = std::fs::read(&archive).expect("读");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&archive, &bytes).expect("写");
        let bin = work.path().join("bin");
        let err = install(&bin, &package, Source::File(archive))
            .await
            .expect_err("被改过的包不能装");
        assert!(err.to_string().contains("SHA-256"), "{err}");
        assert!(!bin.join(LINK_NAME).exists());
        assert!(!install_dir(&bin, "9.9.9").exists());
    }

    /// 装出来的程序起不来(比如缺系统库):不留半个安装,也不改链接。
    #[tokio::test]
    async fn an_install_that_cannot_start_is_removed() {
        if !has("dpkg-deb") {
            eprintln!("跳过:没有 dpkg-deb");
            return;
        }
        let work = tempfile::tempdir().expect("临时目录");
        let (archive, mut package) = build_package(work.path());
        // 包本身是对的,但声称的版本和程序报出来的不一样
        package.version = "9.9.8".to_owned();
        let bin = work.path().join("bin");
        let err = install(&bin, &package, Source::File(archive))
            .await
            .expect_err("版本对不上");
        assert!(err.to_string().contains("版本不对"), "{err}");
        assert!(!install_dir(&bin, "9.9.8").exists(), "不留半个安装");
        assert!(!bin.join(LINK_NAME).exists(), "链接没动");
    }
}
