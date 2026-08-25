use crate::error::AppError;
use crate::paths::{self, CONTENT_VERSION};
use crate::ziputil::{self, sha256_bytes, sha256_file};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

#[cfg(not(debug_assertions))]
const PACK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/content-pack.zip"));

#[cfg(debug_assertions)]
const PACK: &[u8] = &[];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentStatus {
    pub version: String,
    pub extracted: bool,
    pub file_count: usize,
    pub warning: Option<String>,
}

/// First-launch (and version-upgrade) extract. Never touches user audio / sessions / notes.
pub fn ensure() -> Result<ContentStatus, AppError> {
    if paths::is_dev() {
        return Ok(ContentStatus {
            version: CONTENT_VERSION.into(),
            extracted: false,
            file_count: 0,
            warning: None,
        });
    }
    if PACK.is_empty() {
        return Ok(ContentStatus {
            version: CONTENT_VERSION.into(),
            extracted: false,
            file_count: 0,
            warning: Some("当前构建未嵌入题库内容包。".into()),
        });
    }
    let content_root = paths::data_root()?.join("content");
    fs::create_dir_all(&content_root)?;
    let dest = content_root.join(CONTENT_VERSION);
    let marker = content_root.join("CURRENT");
    if dest.is_dir() && marker_is(&marker, CONTENT_VERSION) && verify_extracted(&dest).is_ok() {
        return Ok(ContentStatus {
            version: CONTENT_VERSION.into(),
            extracted: true,
            file_count: count_files(&dest),
            warning: None,
        });
    }
    let staging = content_root.join(format!(".staging-{CONTENT_VERSION}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    match extract_pack(PACK, &staging) {
        Ok(count) => {
            if dest.exists() {
                let _ = fs::remove_dir_all(&dest);
            }
            fs::rename(&staging, &dest).map_err(|e| {
                AppError::from(format!("无法启用新题库内容包：{e}"))
            })?;
            fs::write(&marker, CONTENT_VERSION.as_bytes())?;
            prune_old(&content_root, CONTENT_VERSION);
            Ok(ContentStatus {
                version: CONTENT_VERSION.into(),
                extracted: true,
                file_count: count,
                warning: None,
            })
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            if let Ok(current) = fs::read_to_string(&marker) {
                let keep = content_root.join(current.trim());
                if keep.is_dir() {
                    return Ok(ContentStatus {
                        version: current.trim().into(),
                        extracted: true,
                        file_count: count_files(&keep),
                        warning: Some(format!(
                            "新题库内容包解压失败，已继续使用上一份有效版本。原因：{err}"
                        )),
                    });
                }
            }
            Err(AppError::from(format!(
                "无法解压内置题库内容包：{err}。阅读和写作需要这份内容才能使用。"
            )))
        }
    }
}

fn marker_is(path: &Path, version: &str) -> bool {
    fs::read_to_string(path)
        .map(|t| t.trim() == version)
        .unwrap_or(false)
}

fn extract_pack(bytes: &[u8], dest: &Path) -> Result<usize, AppError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| AppError::from(format!("内容包损坏：{e}")))?;
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::from(format!("内容包条目损坏：{e}")))?;
        if entry.is_dir() {
            continue;
        }
        let rel = ziputil::sanitize_zip_path(entry.name())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf)?;
        files.push((rel, buf));
    }
    let manifest = files
        .iter()
        .find(|(p, _)| p == Path::new("manifest.json"))
        .map(|(_, b)| b.as_slice())
        .ok_or_else(|| AppError::from("内容包缺少 manifest.json"))?;
    let spec: Value = serde_json::from_slice(manifest)?;
    let expected = spec
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in &expected {
        let rel = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::from("内容包清单缺少 path"))?;
        let want = item
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::from("内容包清单缺少 sha256"))?;
        let found = files.iter().find(|(p, _)| p == Path::new(rel));
        let Some((_, bytes)) = found else {
            return Err(AppError::from(format!("内容包缺少文件 {rel}")));
        };
        let got = sha256_bytes(bytes);
        if got != want {
            return Err(AppError::from(format!("内容包文件校验失败：{rel}")));
        }
        if rel.rsplit('.').next() == Some("mp3")
            || rel.rsplit('.').next() == Some("m4a")
            || rel.rsplit('.').next() == Some("wav")
        {
            return Err(AppError::from("内容包不得包含音频文件"));
        }
    }
    for (rel, bytes) in &files {
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&out, bytes)?;
        if sha256_file(&out)? != sha256_bytes(bytes) {
            return Err(AppError::from(format!("写出后校验失败：{}", rel.display())));
        }
    }
    Ok(expected.len())
}

fn verify_extracted(dir: &Path) -> Result<(), AppError> {
    let manifest_path = dir.join("manifest.json");
    let spec: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let files = spec
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::from("内容包清单无效"))?;
    for item in files {
        let rel = item.get("path").and_then(Value::as_str).unwrap_or("");
        let want = item.get("sha256").and_then(Value::as_str).unwrap_or("");
        let path = dir.join(rel);
        if !path.is_file() {
            return Err(AppError::from(format!("内容包文件缺失：{rel}")));
        }
        if sha256_file(&path)? != want {
            return Err(AppError::from(format!("内容包文件已损坏：{rel}")));
        }
    }
    Ok(())
}

fn count_files(dir: &Path) -> usize {
    let mut n = 0usize;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            n += count_files(&path);
        } else {
            n += 1;
        }
    }
    n
}

fn prune_old(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() && name != keep && !name.starts_with('.') {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::extract_pack;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, DateTime, ZipWriter};

    fn tiny_pack(tmp: &std::path::Path) -> Vec<u8> {
        let body = b"{\"schemaVersion\":1,\"id\":\"t\",\"module\":\"reading\"}";
        let digest = hex::encode(Sha256::digest(body));
        let manifest = format!(
            "{{\"contentVersion\":\"1.3.0\",\"fileCount\":1,\"totalBytes\":{},\"files\":[{{\"path\":\"cambridge/t.json\",\"bytes\":{},\"sha256\":\"{digest}\"}}]}}",
            body.len(),
            body.len()
        );
        let cursor = std::io::Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(DateTime::from_date_and_time(2001, 1, 1, 0, 0, 0).unwrap());
        zip.start_file("cambridge/t.json", options).unwrap();
        zip.write_all(body).unwrap();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        let cursor = zip.finish().unwrap();
        let _ = tmp;
        cursor.into_inner()
    }

    #[test]
    fn extracts_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let bytes = tiny_pack(dir.path());
        let n = extract_pack(&bytes, &dest).unwrap();
        assert_eq!(n, 1);
        assert!(dest.join("cambridge/t.json").is_file());
    }

    #[test]
    fn rejects_hash_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let mut bytes = tiny_pack(dir.path());
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        bytes[last.saturating_sub(8)] ^= 0xff;
        assert!(extract_pack(&bytes, &dest).is_err());
    }
}
