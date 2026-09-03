//! Relative-path sanitizer shared by exam import, asset resolve, and ZIP extract.
//!
//! Rejects absolute paths, UNC, drive letters, `..`, reserved Windows device
//! names, and symlink/junction escapes out of an allowlisted root.

use crate::error::AppError;
use std::fs;
use std::path::{Component, Path, PathBuf};

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CLOCK$",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !is_reserved_component(id)
}

pub fn looks_unc(raw: &str) -> bool {
    let t = raw.trim();
    t.starts_with("\\\\")
        || t.starts_with("//")
        || t.starts_with("\\\\?\\")
        || t.to_ascii_lowercase().starts_with("unc\\")
}

pub fn looks_drive(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn is_reserved_component(name: &str) -> bool {
    let trimmed = name.trim_end_matches(|c| c == '.' || c == ' ');
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Parse a user-supplied relative path. Never returns an absolute PathBuf.
pub fn sanitize_rel(raw: &str) -> Result<PathBuf, AppError> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(AppError::from("资源路径为空或含非法字符"));
    }
    if looks_unc(raw) {
        return Err(AppError::from("拒绝 UNC 路径"));
    }
    if looks_drive(raw) {
        return Err(AppError::from("拒绝盘符绝对路径"));
    }
    if raw.len() > 240 {
        return Err(AppError::from("资源路径过长"));
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(AppError::from("拒绝绝对路径"));
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::from("拒绝路径穿越"));
        }
        if part.contains(':') {
            return Err(AppError::from("拒绝盘符路径"));
        }
        if is_reserved_component(part) {
            return Err(AppError::from(format!("拒绝保留设备名：{part}")));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::from("资源路径为空"));
    }
    if out.is_absolute()
        || out
            .components()
            .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::ParentDir))
    {
        return Err(AppError::from("拒绝绝对或越界路径"));
    }
    Ok(out)
}

/// True when `child` exists and, after resolving reparse points, stays under `root`.
pub fn contained_in(child: &Path, root: &Path) -> bool {
    let Ok(root_canon) = fs::canonicalize(root) else {
        return false;
    };
    let Ok(child_canon) = fs::canonicalize(child) else {
        return false;
    };
    child_canon.starts_with(&root_canon)
}

pub fn resolve_under(rel: &str, roots: &[PathBuf]) -> Result<PathBuf, AppError> {
    let rel = sanitize_rel(rel)?;
    for root in roots {
        if !root.exists() {
            continue;
        }
        let candidate = root.join(&rel);
        if candidate.exists() && contained_in(&candidate, root) {
            return Ok(fs::canonicalize(candidate)?);
        }
    }
    Err(AppError::from(format!("找不到资源: {}", rel.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_unc_drive_and_devices() {
        assert!(sanitize_rel("../x.png").is_err());
        assert!(sanitize_rel("a/../../x.png").is_err());
        assert!(sanitize_rel("C:/Windows/x.png").is_err());
        assert!(sanitize_rel("C:\\Windows\\x.png").is_err());
        assert!(sanitize_rel("\\\\server\\share\\x.png").is_err());
        assert!(sanitize_rel("//server/share/x.png").is_err());
        assert!(sanitize_rel("/etc/passwd").is_err());
        assert!(sanitize_rel("assets/CON").is_err());
        assert!(sanitize_rel("assets/nul.txt").is_err());
        assert!(sanitize_rel("").is_err());
    }

    #[test]
    fn accepts_nested_relative() {
        let p = sanitize_rel("assets/cambridge/c10-t1.jpg").unwrap();
        assert_eq!(p, Path::new("assets").join("cambridge").join("c10-t1.jpg"));
        assert!(valid_id("cambridge-10-test-1-reading"));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a/b"));
    }
}
