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
    if dest.is_dir() && marker_is(&marker, CONTENT_VERSION) && dest.join("manifest.json").is_file()
    {
        // Extraction already hashes every file against the manifest once; the
        // `.verified` stamp lets later boots trust that pass instead of
        // re-hashing the whole tree on every launch. A missing stamp (tree
        // written by an older build) triggers one full verify, then stamps.
        let stamped = fs::read_to_string(dest.join(".verified"))
            .ok()
            .and_then(|s| s.trim().parse::<usize>().ok());
        let verified = match stamped {
            // A stale stamp (files added/removed after it was written) must not
            // skip verification — recounting is cheap next to the hash pass.
            Some(count) if count_files(&dest) == count => Some(count),
            _ if verify_extracted(&dest).is_ok() => {
                let count = count_files(&dest);
                let _ = fs::write(dest.join(".verified"), count.to_string());
                Some(count)
            }
            _ => None,
        };
        if let Some(count) = verified {
            return Ok(ContentStatus {
                version: CONTENT_VERSION.into(),
                extracted: true,
                file_count: count,
                warning: None,
            });
        }
    }
    let staging = content_root.join(format!(".staging-{CONTENT_VERSION}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    match extract_pack(PACK, &staging) {
        Ok(count) => {
            if dest.exists() {
                let _ = fs::remove_dir_all(&dest);
            }
            fs::rename(&staging, &dest)
                .map_err(|e| AppError::from(format!("无法启用新题库内容包：{e}")))?;
            fs::write(&marker, CONTENT_VERSION.as_bytes())?;
            // The extraction above verified every file; stamp it so later
            // boots skip the full hash pass.
            let _ = fs::write(dest.join(".verified"), count.to_string());
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
                let ver = current.trim();
                if let Some(keep) = paths::valid_version_dir(ver).then(|| content_root.join(ver)) {
                    if keep.is_dir() {
                        return Ok(ContentStatus {
                            version: ver.into(),
                            extracted: true,
                            file_count: count_files(&keep),
                            warning: Some(format!(
                                "新题库内容包解压失败，已继续使用上一份有效版本。原因：{err}"
                            )),
                        });
                    }
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
    let by_path: std::collections::HashMap<&Path, &[u8]> = files
        .iter()
        .map(|(p, b)| (p.as_path(), b.as_slice()))
        .collect();
    let manifest = by_path
        .get(Path::new("manifest.json"))
        .copied()
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
        let Some(bytes) = by_path.get(Path::new(rel)).copied() else {
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
        // The in-memory bytes were just verified against the manifest hashes;
        // a post-write hash pass would only re-read page cache.
        fs::write(&out, bytes)?;
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
    count_files_at(dir, 0)
}

fn count_files_at(dir: &Path, depth: usize) -> usize {
    if depth > 32 {
        return 0;
    }
    let mut n = 0usize;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        if crate::safe_path::is_reparse_point(&entry) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            n += count_files_at(&path, depth + 1);
        } else if !(depth == 0 && entry.file_name() == ".verified") {
            // The stamp file is bookkeeping, not content — counting it would
            // make the `.verified` check above never match.
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
