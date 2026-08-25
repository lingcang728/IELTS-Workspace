use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::ZipArchive;

pub const MAX_ZIP_FILES: usize = 400;
pub const MAX_UNCOMPRESSED: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ONE_FILE: u64 = 400 * 1024 * 1024;

pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Unzip `src` into `dest`. Rejects path traversal, absolute paths, and oversized archives.
pub fn safe_extract(src: &Path, dest: &Path) -> Result<Vec<PathBuf>, AppError> {
    fs::create_dir_all(dest)?;
    let file = File::open(src)?;
    let mut archive = ZipArchive::new(file).map_err(|e| AppError::from(format!("ZIP 无法打开：{e}")))?;
    if archive.len() > MAX_ZIP_FILES {
        return Err(AppError::from(format!(
            "ZIP 内文件过多（{}），拒绝解压",
            archive.len()
        )));
    }
    let mut written = Vec::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::from(format!("ZIP 条目损坏：{e}")))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        let rel = sanitize_zip_path(&name)?;
        let out = dest.join(&rel);
        if !out.starts_with(dest) {
            return Err(AppError::from("ZIP 含有越界路径，已拒绝"));
        }
        let size = entry.size();
        if size > MAX_ONE_FILE {
            return Err(AppError::from(format!("ZIP 内文件过大：{}", rel.display())));
        }
        total = total.saturating_add(size);
        if total > MAX_UNCOMPRESSED {
            return Err(AppError::from("ZIP 解压后体积超过限制"));
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut dest_file = File::create(&out)?;
        io::copy(&mut entry, &mut dest_file)?;
        dest_file.flush()?;
        written.push(out);
    }
    Ok(written)
}

pub fn sanitize_zip_path(name: &str) -> Result<PathBuf, AppError> {
    if name.contains('\0') {
        return Err(AppError::from("ZIP 路径非法"));
    }
    let mut out = PathBuf::new();
    for part in name.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::from("ZIP 含有路径穿越，已拒绝"));
        }
        if part.contains(':') {
            return Err(AppError::from("ZIP 含有盘符路径，已拒绝"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::from("ZIP 路径为空"));
    }
    if out.is_absolute() || out.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err(AppError::from("ZIP 含有绝对路径，已拒绝"));
    }
    Ok(out)
}



#[cfg(test)]
mod tests {
    use super::sanitize_zip_path;

    #[test]
    fn rejects_traversal() {
        assert!(sanitize_zip_path("../x.mp3").is_err());
        assert!(sanitize_zip_path("a/../../x.mp3").is_err());
        assert!(sanitize_zip_path("C:/Windows/x.mp3").is_err());
    }

    #[test]
    fn accepts_nested_relative() {
        let p = sanitize_zip_path("C04/c04-t1.mp3").unwrap();
        assert_eq!(p, std::path::Path::new("C04").join("c04-t1.mp3"));
    }
}
