use crate::error::AppError;
use crate::paths;
use crate::safe_path;
use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }
    let f = wide(from);
    let t = wide(to);
    let ok = unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(path, &bak);
    }
    replace_file(&tmp, path)?;
    Ok(())
}

pub fn session_path(id: &str) -> Result<PathBuf, AppError> {
    if !crate::safe_path::valid_id(id) {
        return Err(AppError::from("非法 session id"));
    }
    Ok(paths::sessions_dir()?.join(format!("{id}.json")))
}

fn valid_iso_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 19 {
        return false;
    }
    b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b' ')
        && b[13] == b':'
        && b[16] == b':'
        && b[0].is_ascii_digit()
}

fn validate_session(value: &Value) -> Result<(), AppError> {
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::from("Session 缺少 schemaVersion"))?;
    if version != 1 {
        return Err(AppError::from(format!("不支持的 Session schemaVersion: {version}")));
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::from("Session 缺少 id"))?;
    if !safe_path::valid_id(id) {
        return Err(AppError::from("非法 session id"));
    }
    let exam_id = value
        .get("examId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if exam_id.is_empty() || !safe_path::valid_id(exam_id) {
        return Err(AppError::from("Session 缺少合法 examId"));
    }
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        status,
        "created" | "in_progress" | "submitted" | "aborted" | "interrupted"
    ) {
        return Err(AppError::from("Session status 非法"));
    }
    for key in ["startedAt", "updatedAt"] {
        let Some(s) = value.get(key).and_then(Value::as_str) else {
            return Err(AppError::from(format!("Session 缺少 {key}")));
        };
        if !valid_iso_datetime(s) {
            return Err(AppError::from(format!("Session {key} 不是合法日期")));
        }
    }
    if let Some(audio) = value.get("audio") {
        if audio.is_null() {
            return Ok(());
        }
        let obj = audio
            .as_object()
            .ok_or_else(|| AppError::from("Session.audio 格式错误"))?;
        if let Some(pos) = obj.get("positionMs") {
            if !pos.is_number() || pos.as_f64().unwrap_or(-1.0) < 0.0 {
                return Err(AppError::from("Session.audio.positionMs 非法"));
            }
        }
        if let Some(part) = obj.get("partIndex") {
            let n = part.as_u64().unwrap_or(99);
            if n > 3 {
                return Err(AppError::from("Session.audio.partIndex 必须是 0–3"));
            }
        }
    }
    Ok(())
}

pub fn save_session_json(raw: &str) -> Result<String, AppError> {
    let value: Value = serde_json::from_str(raw)?;
    validate_session(&value)?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::from("Session 缺少 id"))?;
    let path = session_path(id)?;
    if path.exists() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<Value>(&text) {
                if is_submitted_downgrade(&existing, &value) {
                    return Err(AppError::from("会话已交卷，不能覆盖为未提交状态"));
                }
            }
        }
    }
    atomic_write(&path, serde_json::to_vec_pretty(&value)?.as_slice())?;
    Ok(path.display().to_string())
}

fn is_submitted_downgrade(existing: &Value, incoming: &Value) -> bool {
    existing.get("status").and_then(Value::as_str) == Some("submitted")
        && incoming.get("status").and_then(Value::as_str) != Some("submitted")
}

pub fn load_session_json(id: &str) -> Result<String, AppError> {
    let path = session_path(id)?;
    read_with_fallback(&path)
}

pub fn quarantine_file(path: &Path, why: &str) -> Result<PathBuf, AppError> {
    quarantine_file_to(path, &paths::sessions_dir()?.join("quarantine"), why)
}

pub fn quarantine_file_to(path: &Path, dir: &Path, why: &str) -> Result<PathBuf, AppError> {
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("broken.json");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let dest = dir.join(format!("{stamp}-{name}"));
    let _ = fs::rename(path, &dest).or_else(|_| fs::copy(path, &dest).map(|_| {
        let _ = fs::remove_file(path);
    }));
    let note = dest.with_extension("reason.txt");
    let _ = fs::write(&note, format!("{why}\n原文件：{}\n", path.display()));
    Ok(dest)
}

fn try_parse_session(path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?;
    Ok(text)
}

fn read_with_fallback(path: &Path) -> Result<String, AppError> {
    let bak = path.with_extension("json.bak");
    let tmp = path.with_extension("json.tmp");
    for candidate in [path, bak.as_path(), tmp.as_path()] {
        if !candidate.exists() {
            continue;
        }
        match try_parse_session(candidate) {
            Ok(text) => {
                if candidate != path {
                    let _ = fs::write(path, &text);
                }
                return Ok(text);
            }
            Err(why) => {
                let _ = quarantine_file(candidate, &format!("JSON 损坏：{why}"));
            }
        }
    }
    Err(AppError::from("找不到有效的 Session 文件（损坏文件已隔离）"))
}

/// How much of a paper was actually attempted: (answered, total).
///
/// "Submitted" is not the same as "finished". A session submitted after two
/// questions was still submitted, so counting submissions as completions told
/// the learner they had done four papers this week when they had walked out of
/// most of them. The summary therefore carries the real numbers and lets the
/// UI decide what to call finished.
///
/// A question counts as answered when its value is neither null nor empty —
/// for a multi-select that means at least one option chosen. Writing sessions
/// have no per-question answers, so their progress comes from `writing`, where
/// a task counts once it has any text in it.
fn answered_counts(session: &Value) -> (u64, u64) {
    if let Some(answers) = session.get("answers").and_then(Value::as_object) {
        if !answers.is_empty() {
            let answered = answers
                .values()
                .filter(|entry| {
                    let value = entry.get("value").unwrap_or(&Value::Null);
                    match value {
                        Value::Null => false,
                        Value::String(text) => !text.trim().is_empty(),
                        Value::Array(items) => items.iter().any(|item| {
                            item.as_str().map(|t| !t.trim().is_empty()).unwrap_or(true)
                        }),
                        _ => true,
                    }
                })
                .count() as u64;
            return (answered, answers.len() as u64);
        }
    }
    if let Some(writing) = session.get("writing").and_then(Value::as_object) {
        let written = writing
            .values()
            .filter(|text| text.as_str().map(|t| !t.trim().is_empty()).unwrap_or(false))
            .count() as u64;
        // A writing paper is always two tasks, even when only one was opened.
        return (written, writing.len().max(2) as u64);
    }
    (0, 0)
}

#[derive(Debug, Default)]
pub struct SessionList {
    pub summaries: Vec<Value>,
    pub quarantined: Vec<String>,
}

pub fn list_session_summaries() -> Result<Vec<Value>, AppError> {
    Ok(list_sessions_with_diagnostics()?.summaries)
}

pub fn list_sessions_with_diagnostics() -> Result<SessionList, AppError> {
    let dir = paths::sessions_dir()?;
    let mut out = SessionList::default();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            == Some("quarantine")
        {
            continue;
        }
        match try_parse_session(&path) {
            Ok(text) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let (answered, total) = answered_counts(&v);
                out.summaries.push(serde_json::json!({
                    "id": v.get("id"),
                    "examId": v.get("examId"),
                    "module": v.get("module"),
                    "mode": v.get("mode"),
                    "status": v.get("status"),
                    "integrity": v.get("integrity"),
                    "startedAt": v.get("startedAt"),
                    "updatedAt": v.get("updatedAt"),
                    "title": v.get("examTitle"),
                    "answered": answered,
                    "total": total,
                }));
            }
            Err(why) => {
                let bak = path.with_extension("json.bak");
                let mut recovered = false;
                if bak.exists() {
                    if let Ok(bak_text) = try_parse_session(&bak) {
                        if let Ok(v) = serde_json::from_str::<Value>(&bak_text) {
                            let _ = fs::write(&path, &bak_text);
                            let (answered, total) = answered_counts(&v);
                            out.summaries.push(serde_json::json!({
                                "id": v.get("id"),
                                "examId": v.get("examId"),
                                "module": v.get("module"),
                                "mode": v.get("mode"),
                                "status": v.get("status"),
                                "integrity": v.get("integrity"),
                                "startedAt": v.get("startedAt"),
                                "updatedAt": v.get("updatedAt"),
                                "title": v.get("examTitle"),
                                "answered": answered,
                                "total": total,
                            }));
                            recovered = true;
                        }
                    }
                }
                if !recovered {
                    let dest = quarantine_file(&path, &format!("列出会话时发现损坏：{why}"))?;
                    out.quarantined.push(format!(
                        "{}（已隔离到 {}）",
                        path.display(),
                        dest.display()
                    ));
                }
            }
        }
    }
    Ok(out)
}

pub fn discard_session(id: &str) -> Result<(), AppError> {
    let path = session_path(id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let bak = path.with_extension("json.bak");
    if bak.exists() {
        let _ = fs::remove_file(bak);
    }
    Ok(())
}

pub fn archive_session(id: &str) -> Result<(), AppError> {
    let path = session_path(id)?;
    let archive = paths::sessions_dir()?.join("archive");
    fs::create_dir_all(&archive)?;
    if path.exists() {
        if let Some(file_name) = path.file_name() {
            fs::rename(&path, archive.join(file_name))?;
        }
    }
    let bak = path.with_extension("json.bak");
    if bak.exists() {
        if let Some(file_name) = bak.file_name() {
            let _ = fs::rename(&bak, archive.join(file_name));
        }
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
    use std::env;

    #[test]
    fn counts_only_questions_that_were_actually_answered() {
        let session = serde_json::json!({"answers": {
            "q1": {"value": "Gujarat"},
            "q2": {"value": null},
            "q3": {"value": "   "},
            "q4": {"value": ["B", "D"]},
            "q5": {"value": []},
        }});
        assert_eq!(answered_counts(&session), (2, 5));
    }

    #[test]
    fn an_untouched_paper_counts_as_zero_not_as_finished() {
        let session = serde_json::json!({"answers": {
            "q1": {"value": null}, "q2": {"value": null},
        }});
        assert_eq!(answered_counts(&session), (0, 2));
    }

    #[test]
    fn writing_progress_comes_from_the_essays() {
        let session = serde_json::json!({"writing": {
            "task1": "Some words here.", "task2": "",
        }});
        assert_eq!(answered_counts(&session), (1, 2));
    }

    #[test]
    fn a_session_with_neither_answers_nor_essays_is_zero_of_zero() {
        assert_eq!(answered_counts(&serde_json::json!({})), (0, 0));
    }

    #[test]
    fn atomic_write_roundtrip() {
        let dir = env::temp_dir().join(format!("ielts-atomic-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("s.json");
        atomic_write(&path, br#"{"schemaVersion":1,"id":"x"}"#).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("schemaVersion"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_status_and_dates() {
        let bad = serde_json::json!({
            "schemaVersion": 1,
            "id": "s-1",
            "examId": "cambridge-4-test-1-reading",
            "status": "done",
            "startedAt": "2026-08-26T10:00:00.000Z",
            "updatedAt": "2026-08-26T10:00:00.000Z",
        });
        assert!(validate_session(&bad).is_err());
        let good = serde_json::json!({
            "schemaVersion": 1,
            "id": "s-1",
            "examId": "cambridge-4-test-1-reading",
            "status": "in_progress",
            "startedAt": "2026-08-26T10:00:00.000Z",
            "updatedAt": "2026-08-26T10:00:00.000Z",
        });
        assert!(validate_session(&good).is_ok());
    }

    #[test]
    fn isol_datetime_gate() {
        assert!(valid_iso_datetime("2026-08-26T10:00:00.000Z"));
        assert!(!valid_iso_datetime("tomorrow"));
        assert!(!valid_iso_datetime("2026/08/26"));
    }

    #[test]
    fn refuses_to_downgrade_submitted_session() {
        let submitted = serde_json::json!({"status": "submitted"});
        let in_progress = serde_json::json!({"status": "in_progress"});
        assert!(is_submitted_downgrade(&submitted, &in_progress));
        assert!(!is_submitted_downgrade(&submitted, &submitted));
        assert!(!is_submitted_downgrade(&in_progress, &submitted));
    }
}
