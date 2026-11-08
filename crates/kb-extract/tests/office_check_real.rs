//! 拿真实的办公文件试 `office_check`(默认忽略)。
//!
//! `KB_OFFICE_FILES=<每行一个路径的文件> cargo test -p kb-extract --test office_check_real -- --ignored --nocapture`
//! 每个文件都应该通过 `validate`;并且「原样重写成另一个 zip」(只改压缩方式)后 `compare` 应该完全一样。

use kb_extract::office_check::{OfficeKind, compare, validate};

#[test]
#[ignore = "需要真实文件:设置 KB_OFFICE_FILES"]
fn real_files_validate_and_compare_equal_to_themselves() {
    let Ok(list) = std::env::var("KB_OFFICE_FILES") else {
        return;
    };
    let (mut checked, mut failed) = (0, 0);
    for path in std::fs::read_to_string(list).expect("读清单").lines() {
        let extension = path.rsplit('.').next().unwrap_or_default();
        if OfficeKind::from_extension(extension).is_none() || path.contains("/~$") {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        checked += 1;
        match validate(&bytes, extension) {
            Ok(info) => {
                // 重写成 stored 压缩的 zip:内容一样,字节不同
                let entries =
                    kb_extract::zip::read_all(&bytes, kb_extract::zip::ZipLimits::default())
                        .expect("读");
                let refs: Vec<(&str, &[u8])> = entries
                    .iter()
                    .filter(|entry| !entry.name.ends_with('/'))
                    .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
                    .collect();
                let again = kb_extract::zip::build_stored_zip(&refs);
                let diff = compare(&bytes, &again).expect("比");
                if !diff.is_identical() {
                    failed += 1;
                    println!("DIFF {path}: {diff:?}");
                } else {
                    println!("OK   {path} ({} 个部件)", info.parts);
                }
            }
            Err(err) => {
                failed += 1;
                println!("FAIL {path}: {err}");
            }
        }
    }
    println!("检查了 {checked} 个,有问题 {failed} 个");
    assert_eq!(failed, 0);
}
