//! A small record store for the Phase 3 features.
//!
//! Mistakes, vocabulary, study plans and saved AI feedback are all the same
//! shape: many small JSON records that must survive a crash and a power cut
//! exactly as sessions do. Rather than four near-identical modules this is one
//! store keyed by a `kind` from a fixed allowlist, reusing `session::atomic_write`
//! so every record gets the temp-file + fsync + `.bak` treatment.
//!
//! Records are opaque `serde_json::Value` on the Rust side, like exams and
//! sessions: `src/lib/types.ts` is the single source of truth for their shape.

use crate::error::AppError;
use crate::paths;
use crate::session::{atomic_write, quarantine_file_to, restore_write};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Directories under the data root that this store may touch. Anything else is
/// rejected before a path is built, so a `kind` coming over IPC can never walk
/// out of the data directory.
pub const KINDS: &[&str] = &["mistakes", "vocab", "plans", "feedback"];

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn kind_dir(kind: &str) -> Result<PathBuf, AppError> {
    if !KINDS.contains(&kind) {
        return Err(AppError::Message(format!("未知的数据类别: {kind}")));
    }
    let dir = paths::ensure_data_layout()?.join(kind);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn record_path(kind: &str, id: &str) -> Result<PathBuf, AppError> {
    if !valid_id(id) {
        return Err(AppError::from("非法的记录 id"));
    }
    Ok(kind_dir(kind)?.join(format!("{id}.json")))
}

pub fn save(kind: &str, value: &Value) -> Result<String, AppError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::from("记录缺少 id"))?;
    let path = record_path(kind, id)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    // Write-side ceiling as well: callers that skip the IPC string check (a
    // record built up internally, say) still cannot land a giant file.
    if bytes.len() > crate::safe_path::MAX_JSON_ARG_BYTES {
        return Err(AppError::from("记录超过 8 MB 上限，已拒绝写入"));
    }
    // Async study commands can overlap on the same record (a rapid double
    // review, a plan autosave racing a manual save) — serialise so the shared
    // `{id}.json.tmp` scratch file is never written by two callers at once.
    let _guard = crate::session::write_guard()?;
    atomic_write(&path, &bytes)?;
    Ok(id.to_string())
}

/// Read a record, falling back to the `.json.bak`/`.json.tmp` siblings that
/// `atomic_write` leaves behind — the same crash-recovery chain sessions use.
/// A fallback hit is written back over the main file so the next read is cheap.
fn read_record(path: &Path) -> Result<Value, String> {
    let bak = path.with_extension("json.bak");
    let tmp = path.with_extension("json.tmp");
    let mut last_err = String::from("文件不存在");
    for candidate in [path, bak.as_path(), tmp.as_path()] {
        if !candidate.exists() {
            continue;
        }
        let parsed = fs::read_to_string(candidate)
            .map_err(|e| e.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .map(|value| (value, text))
                    .map_err(|e| e.to_string())
            });
        match parsed {
            Ok((value, text)) => {
                if candidate != path {
                    // Restore races a concurrent save on the same tmp scratch
                    // file; keep the write under the shared lock.
                    if let Ok(_guard) = crate::session::write_guard() {
                        restore_write(path, text.as_bytes());
                    }
                }
                return Ok(value);
            }
            Err(why) => last_err = why,
        }
    }
    Err(last_err)
}

/// Quarantine `path` and its recovery siblings into `<kind>/quarantine/`, but
/// only when the bytes read cleanly and the JSON is truly unparseable — a
/// transient lock from a sync tool or AV scan must not hide a record.
fn quarantine_corrupt(path: &Path, quarantine_dir: &Path) {
    for candidate in [
        path.to_path_buf(),
        path.with_extension("json.bak"),
        path.with_extension("json.tmp"),
    ] {
        let Ok(text) = fs::read_to_string(&candidate) else {
            continue;
        };
        if serde_json::from_str::<Value>(&text).is_err() {
            let _ = quarantine_file_to(&candidate, quarantine_dir, "记录 JSON 损坏");
        }
    }
}

/// Records quarantined as corrupt across all kinds; bootstrap surfaces the
/// count so damaged study data is never silently invisible.
pub fn quarantined_count() -> usize {
    let mut n = 0;
    for kind in KINDS {
        let Ok(dir) = kind_dir(kind) else { continue };
        let quarantine = dir.join("quarantine");
        let Ok(entries) = fs::read_dir(quarantine) else {
            continue;
        };
        n += entries
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("json"))
            .count();
    }
    n
}

pub fn read(kind: &str, id: &str) -> Result<Option<Value>, AppError> {
    let path = record_path(kind, id)?;
    let siblings_exist = path.exists()
        || path.with_extension("json.bak").exists()
        || path.with_extension("json.tmp").exists();
    if !siblings_exist {
        return Ok(None);
    }
    match read_record(&path) {
        Ok(value) => Ok(Some(value)),
        Err(why) => {
            quarantine_corrupt(&path, &kind_dir(kind)?.join("quarantine"));
            // A transient lock (sync tool, AV scan) reads as Err too, but
            // quarantine_corrupt only moves truly unparseable files — say so
            // rather than claiming a quarantine that may not have happened.
            Err(AppError::from(format!(
                "记录 {id} 暂时无法读取（若为损坏文件已自动隔离）：{why}"
            )))
        }
    }
}

/// Every record of one kind. A record that will not parse — including its
/// `.bak`/`.tmp` fallbacks — is quarantined rather than silently skipped, so a
/// corrupt file can neither hide the rest nor pretend the record never existed.
pub fn list(kind: &str) -> Result<Vec<Value>, AppError> {
    let dir = kind_dir(kind)?;
    let quarantine = dir.join("quarantine");
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        match read_record(&path) {
            Ok(value) => out.push(value),
            Err(_) => quarantine_corrupt(&path, &quarantine),
        }
    }
    Ok(out)
}

pub fn delete(kind: &str, id: &str) -> Result<(), AppError> {
    let path = record_path(kind, id)?;
    // A delete racing an in-flight save must win: without the lock the save's
    // pending rename can recreate the file just removed.
    let _guard = crate::session::write_guard()?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let bak = path.with_extension("json.bak");
    if bak.exists() {
        let _ = fs::remove_file(bak);
    }
    let tmp = path.with_extension("json.tmp");
    if tmp.exists() {
        let _ = fs::remove_file(tmp);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_kind() {
        assert!(kind_dir("../secrets").is_err());
        assert!(kind_dir("sessions").is_err());
    }

    #[test]
    fn rejects_path_traversal_in_id() {
        assert!(!valid_id("../x"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a\\b"));
        assert!(!valid_id(""));
        assert!(valid_id("v-2026-08-24_01"));
    }
}
