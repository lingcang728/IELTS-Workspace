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
use crate::session::atomic_write;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

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
    atomic_write(&path, &bytes)?;
    Ok(id.to_string())
}

pub fn read(kind: &str, id: &str) -> Result<Option<Value>, AppError> {
    let path = record_path(kind, id)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

/// Every record of one kind. A record that will not parse is skipped rather
/// than failing the whole list: one corrupt file must not hide the rest.
pub fn list(kind: &str) -> Result<Vec<Value>, AppError> {
    let dir = kind_dir(kind)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        out.push(value);
    }
    Ok(out)
}

pub fn delete(kind: &str, id: &str) -> Result<(), AppError> {
    let path = record_path(kind, id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let bak = path.with_extension("json.bak");
    if bak.exists() {
        let _ = fs::remove_file(bak);
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
