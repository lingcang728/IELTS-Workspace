use crate::error::AppError;
use crate::paths;
use crate::ziputil::sha256_file;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

// Every directory that holds user-visible data. Missing one here silently
// strands it in the retired `data.migrated.bak` tree: imported papers lose the
// `assets/` they reference, `transcripts/` dictation text disappears, and
// `official-samples/` exams drop out of the library.
const USER_DIRS: &[&str] = &[
    "sessions",
    "profile",
    "notes",
    "mistakes",
    "vocab",
    "plans",
    "feedback",
    "library",
    "audio",
    "sources",
    "assets",
    "transcripts",
    "official-samples",
];

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated: bool,
    pub from: Option<String>,
    pub to: Option<String>,
    /// Files where the destination already had a copy and won. Nothing is lost
    /// — the source tree is renamed, not deleted — but the user could never
    /// tell which side of a conflict survived without this count.
    pub conflicts: usize,
    pub error: Option<String>,
}

/// Progress snapshot emitted on `bootstrap-progress` while a migration copy
/// runs — first-boot migration of a large profile otherwise looks like a hang
/// on the splash screen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateProgress {
    pub dir: String,
    pub done: usize,
    pub total: usize,
}

/// Copy v1.2.0 sidecar data (next to the exe) into the 1.3.0 data root.
/// Failure keeps the source intact and returns a Chinese error.
pub fn run(progress: impl FnMut(&MigrateProgress)) -> MigrationReport {
    match run_inner(progress) {
        Ok(report) => report,
        Err(err) => MigrationReport {
            migrated: false,
            from: None,
            to: paths::data_root().ok().map(|p| p.display().to_string()),
            conflicts: 0,
            error: Some(err.to_string()),
        },
    }
}

fn run_inner(mut progress: impl FnMut(&MigrateProgress)) -> Result<MigrationReport, AppError> {
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
        report.conflicts += copy_verify_merge_progress(&src, &dest, &mut progress)?;
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
    copy_verify_merge_progress(src, dest, &mut |_| {}).map(|_| ())
}

/// Returns how many files were skipped because the destination already had a
/// copy (dest-wins conflicts), so callers can surface the count.
fn copy_verify_merge_progress(
    src: &Path,
    dest: &Path,
    progress: &mut dyn FnMut(&MigrateProgress),
) -> Result<usize, AppError> {
    if !src.exists() {
        return Ok(0);
    }
    if src == dest {
        return Ok(0);
    }
    let staging = dest.parent().unwrap_or(dest).join(".migrate-staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    let mut prog = TreeProgress {
        cb: progress,
        dir: String::new(),
        done: 0,
        total: count_user_files(src),
    };
    copy_user_tree(src, &staging, &mut prog)?;
    let mut conflicts = 0usize;
    merge_into(&staging, dest, &mut conflicts)?;
    let _ = fs::remove_dir_all(&staging);
    Ok(conflicts)
}

struct TreeProgress<'a> {
    cb: &'a mut dyn FnMut(&MigrateProgress),
    dir: String,
    done: usize,
    total: usize,
}

impl TreeProgress<'_> {
    fn emit(&mut self) {
        (self.cb)(&MigrateProgress {
            dir: self.dir.clone(),
            done: self.done,
            total: self.total,
        });
    }

    fn enter_dir(&mut self, dir: &str) {
        self.dir = dir.to_string();
        self.emit();
    }

    fn tick(&mut self) {
        self.done += 1;
        // Per-file events would flood IPC on trees of small files.
        if self.done % 16 == 0 || self.done == self.total {
            self.emit();
        }
    }
}

/// File count under the migrated dirs — the progress denominator. Uses the
/// same walk rules as `copy_dir` (no reparse descent, depth-capped) so the
/// two agree.
fn count_user_files(src: &Path) -> usize {
    let mut total = 0usize;
    for name in USER_DIRS {
        count_tree(&src.join(name), &mut total, 0);
    }
    total
}

fn count_tree(dir: &Path, total: &mut usize, depth: usize) {
    if depth > WALK_MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if crate::safe_path::is_reparse_point(&entry) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            count_tree(&path, total, depth + 1);
        } else {
            *total += 1;
        }
    }
}

fn copy_user_tree(src: &Path, dest: &Path, prog: &mut TreeProgress) -> Result<(), AppError> {
    for name in USER_DIRS {
        let from = src.join(name);
        if !from.exists() {
            continue;
        }
        prog.enter_dir(name);
        copy_dir(&from, &dest.join(name), prog, 0)?;
    }
    Ok(())
}

/// Reparse points (junctions/symlinks) are skipped rather than followed, and
/// recursion is capped: a user-placed junction that points back at an ancestor
/// would otherwise recurse until the process aborts.
const WALK_MAX_DEPTH: usize = 32;

fn copy_dir(from: &Path, to: &Path, prog: &mut TreeProgress, depth: usize) -> Result<(), AppError> {
    if depth > WALK_MAX_DEPTH {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if crate::safe_path::is_reparse_point(&entry) {
            continue;
        }
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir(&src, &dest, prog, depth + 1)?;
        } else {
            copy_verified_file(&src, &dest)?;
            prog.tick();
        }
    }
    Ok(())
}

/// Streams `src` into `dest` while hashing the bytes in flight, then reads the
/// copy back once to confirm the write. The old copy→verify→merge sequence
/// hashed every file twice and copied it twice; JSON sanity no longer needs a
/// separate pass because identical hashes already imply identical bytes.
fn copy_verified_file(src: &Path, dest: &Path) -> Result<(), AppError> {
    let mut input = File::open(src)?;
    let mut out = File::create(dest)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
    }
    drop(out);
    if sha256_file(dest)? != hex::encode(hasher.finalize()) {
        return Err(AppError::from(format!(
            "迁移副本校验失败：{}",
            dest.display()
        )));
    }
    Ok(())
}

fn merge_into(staging: &Path, dest: &Path, conflicts: &mut usize) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for name in USER_DIRS {
        let from = staging.join(name);
        if !from.exists() {
            continue;
        }
        merge_dir(&from, &dest.join(name), 0, conflicts)?;
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

fn merge_dir(from: &Path, to: &Path, depth: usize, conflicts: &mut usize) -> Result<(), AppError> {
    if depth > WALK_MAX_DEPTH {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if crate::safe_path::is_reparse_point(&entry) {
            continue;
        }
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            merge_dir(&src, &dest, depth + 1, conflicts)?;
        } else if dest.exists() {
            // Destination already has this file (new install started writing). Keep dest.
            *conflicts += 1;
            continue;
        } else if fs::rename(&src, &dest).is_err() {
            // Staging sits next to dest on the same volume, so rename is a
            // metadata move; copy only as a cross-device fallback.
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
