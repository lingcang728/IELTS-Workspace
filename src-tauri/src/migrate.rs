use crate::error::AppError;
use crate::paths;
use crate::ziputil::sha256_file;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const USER_DIRS: &[&str] = &[
    "sessions", "profile", "notes", "mistakes", "vocab", "plans", "feedback", "library", "audio",
    "sources",
];

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated: bool,
    pub from: Option<String>,
    pub to: Option<String>,
    pub error: Option<String>,
}

/// Copy v1.2.0 sidecar data (next to the exe) into the 1.3.0 data root.
/// Failure keeps the source intact and returns a Chinese error.
pub fn run() -> MigrationReport {
    match run_inner() {
        Ok(report) => report,
        Err(err) => MigrationReport {
            migrated: false,
            from: None,
            to: paths::data_root().ok().map(|p| p.display().to_string()),
            error: Some(err.to_string()),
        },
    }
}

fn run_inner() -> Result<MigrationReport, AppError> {
    if paths::is_dev() {
        return Ok(MigrationReport::default());
    }
    let dest = paths::data_root()?;
    fs::create_dir_all(&dest)?;
    let mut report = MigrationReport {
        to: Some(dest.display().to_string()),
        ..MigrationReport::default()
    };
    let mut candidates = Vec::new();
    if let Ok(sidecar) = paths::sidecar_data_root() {
        if sidecar.exists() && sidecar != dest {
            candidates.push(sidecar);
        }
    }
    for src in candidates {
        copy_verify_merge(&src, &dest)?;
        // Never delete the old tree. Rename it to a cold backup so non-whitelist
        // files (exports, extra folders) survive, and dest-wins conflicts stay
        // recoverable. The next launch no longer sees sidecar `data/`.
        let bak = retire_source(&src)?;
        report.migrated = true;
        report.from = Some(bak.display().to_string());
    }
    Ok(report)
}

/// Used by the portable updater hand-off as well as first-run migration.
pub fn copy_verify_merge(src: &Path, dest: &Path) -> Result<(), AppError> {
    if !src.exists() {
        return Ok(());
    }
    if src == dest {
        return Ok(());
    }
    let staging = dest.parent().unwrap_or(dest).join(".migrate-staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    copy_user_tree(src, &staging)?;
    verify_tree(src, &staging)?;
    merge_into(&staging, dest)?;
    let _ = fs::remove_dir_all(&staging);
    Ok(())
}

fn copy_user_tree(src: &Path, dest: &Path) -> Result<(), AppError> {
    for name in USER_DIRS {
        let from = src.join(name);
        if !from.exists() {
            continue;
        }
        copy_dir(&from, &dest.join(name))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), AppError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir(&src, &dest)?;
        } else {
            fs::copy(&src, &dest)?;
        }
    }
    Ok(())
}

fn verify_tree(src: &Path, copy: &Path) -> Result<(), AppError> {
    for name in USER_DIRS {
        let from = src.join(name);
        if !from.exists() {
            continue;
        }
        verify_dir(&from, &copy.join(name))?;
    }
    Ok(())
}

fn verify_dir(src: &Path, copy: &Path) -> Result<(), AppError> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = copy.join(entry.file_name());
        if s.is_dir() {
            verify_dir(&s, &d)?;
            continue;
        }
        if !d.is_file() {
            return Err(AppError::from(format!("迁移副本缺失：{}", d.display())));
        }
        if sha256_file(&s)? != sha256_file(&d)? {
            return Err(AppError::from(format!("迁移副本校验失败：{}", d.display())));
        }
        if d.extension().and_then(|e| e.to_str()) == Some("json") {
            let in_quarantine = s
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                == Some("quarantine");
            if !in_quarantine {
                if let Ok(src_text) = fs::read_to_string(&s) {
                    if serde_json::from_str::<Value>(&src_text).is_ok() {
                        let text = fs::read_to_string(&d)?;
                        serde_json::from_str::<Value>(&text).map_err(|e| {
                            AppError::from(format!("迁移副本 JSON 无效（{}）：{e}", d.display()))
                        })?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn merge_into(staging: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for name in USER_DIRS {
        let from = staging.join(name);
        if !from.exists() {
            continue;
        }
        merge_dir(&from, &dest.join(name))?;
    }
    Ok(())
}

/// Move `src` aside after a verified copy. Failure leaves the source intact.
fn retire_source(src: &Path) -> Result<PathBuf, AppError> {
    let parent = src.parent().unwrap_or(src);
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".into());
    let mut bak = parent.join(format!("{name}.migrated.bak"));
    if bak.exists() {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        bak = parent.join(format!("{name}.migrated.bak.{ms}"));
    }
    fs::rename(src, &bak).map_err(|e| {
        AppError::from(format!(
            "数据已复制，但无法将旧目录改名为备份 {}：{e}。旧数据仍保留，可稍后手动删除。",
            bak.display()
        ))
    })?;
    Ok(bak)
}

fn merge_dir(from: &Path, to: &Path) -> Result<(), AppError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            merge_dir(&src, &dest)?;
        } else if dest.exists() {
            // Destination already has this file (new install started writing). Keep dest.
            continue;
        } else {
            fs::copy(&src, &dest)?;
        }
    }
    Ok(())
}

pub fn portable_to_installed() -> Result<PathBuf, AppError> {
    let src = paths::sidecar_data_root()?;
    let dest = paths::installed_data_root()?;
    copy_verify_merge(&src, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::{copy_verify_merge, retire_source};
    use std::fs;

    #[test]
    fn copies_sessions_and_keeps_source() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("old");
        let dest = tmp.path().join("new");
        fs::create_dir_all(src.join("sessions")).unwrap();
        fs::write(src.join("sessions/s-1.json"), b"{\"id\":\"s-1\"}").unwrap();
        fs::create_dir_all(src.join("cache")).unwrap();
        fs::write(src.join("cache/skip.txt"), b"no").unwrap();
        copy_verify_merge(&src, &dest).unwrap();
        assert!(dest.join("sessions/s-1.json").is_file());
        assert!(!dest.join("cache/skip.txt").exists());
        assert!(src.join("sessions/s-1.json").is_file());
    }

    #[test]
    fn dest_wins_on_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("old");
        let dest = tmp.path().join("new");
        fs::create_dir_all(src.join("sessions")).unwrap();
        fs::create_dir_all(dest.join("sessions")).unwrap();
        fs::write(src.join("sessions/s-1.json"), b"{\"id\":\"from-src\"}").unwrap();
        fs::write(dest.join("sessions/s-1.json"), b"{\"id\":\"from-dest\"}").unwrap();
        copy_verify_merge(&src, &dest).unwrap();
        let text = fs::read_to_string(dest.join("sessions/s-1.json")).unwrap();
        assert!(text.contains("from-dest"));
    }

    #[test]
    fn retire_source_renames_instead_of_deleting() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("data");
        fs::create_dir_all(src.join("exports")).unwrap();
        fs::write(src.join("exports/report.html"), b"keep-me").unwrap();
        let bak = retire_source(&src).unwrap();
        assert!(!src.exists());
        assert!(bak.join("exports/report.html").is_file());
    }
}
