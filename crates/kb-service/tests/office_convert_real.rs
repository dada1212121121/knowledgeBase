//! 真实 LibreOffice 的转换测试(默认不跑,需要本机装好转换器):
//! `KB_SOFFICE_DIR=<解开的安装目录,含 program/soffice> KB_SOFFICE_LD=<LD_LIBRARY_PATH> \
//!  cargo test -p kb-service --test office_convert_real -- --ignored --nocapture`
//!
//! 输入用仓库自带的夹具(`web-ui/e2e/fixtures/sample.doc` / `sample.xls`)。

use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_service::office_convert::{ConvertError, Converter, Target};

fn converter(work: &Path) -> Option<Converter> {
    let dir = PathBuf::from(std::env::var("KB_SOFFICE_DIR").ok()?);
    let soffice = Converter::locate(&dir)?;
    let mut converter = Converter::new(soffice, work.to_path_buf(), Duration::from_secs(120), 2);
    if let Ok(ld) = std::env::var("KB_SOFFICE_LD") {
        converter = converter.with_env("LD_LIBRARY_PATH", &ld);
    }
    Some(converter)
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web-ui/e2e/fixtures")
        .join(name)
}

#[tokio::test]
#[ignore = "需要本机装好 LibreOffice:设置 KB_SOFFICE_DIR(和 KB_SOFFICE_LD)"]
async fn real_libreoffice_converts_doc_and_xls_and_rejects_the_rest() {
    let work = tempfile::tempdir().expect("临时目录");
    let Some(converter) = converter(work.path()) else {
        return;
    };
    let doc_before = std::fs::read(fixture("sample.doc")).expect("读夹具");

    let (target, docx) = converter
        .convert(&fixture("sample.doc"))
        .await
        .expect("doc 转换");
    assert_eq!(target, Target::Docx);
    assert!(docx.starts_with(b"PK\x03\x04"));
    println!("doc -> docx: {} bytes", docx.len());

    let (target, xlsx) = converter
        .convert(&fixture("sample.xls"))
        .await
        .expect("xls 转换");
    assert_eq!(target, Target::Xlsx);
    println!("xls -> xlsx: {} bytes", xlsx.len());

    // 输入文件不被改动
    assert_eq!(
        std::fs::read(fixture("sample.doc")).expect("再读夹具"),
        doc_before
    );

    // 合成的假 OLE 加载不了,必须算失败。两个版本的表现不一样:Debian 的 25.2.3 退出码是 0 却没有产出
    // (转换器按「产物不合法」判失败),官方 26.2.6 直接以非零状态退出;两种都是失败,不能当成功
    let err = converter
        .convert(&fixture("sample.ppt"))
        .await
        .expect_err("合成夹具不是合法的 ppt");
    println!("ppt fixture -> {err}");
    assert!(
        matches!(err, ConvertError::BadOutput(_) | ConvertError::Failed(_)),
        "{err:?}"
    );

    // 转换用的临时目录都清掉了
    let left = std::fs::read_dir(work.path())
        .map(|e| e.count())
        .unwrap_or(0);
    assert_eq!(left, 0, "临时目录应被清掉");
}
