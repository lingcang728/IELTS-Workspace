use crate::error::AppError;
use crate::paths;
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
    if id.is_empty()
        || id.contains("..")
        || id.contains('/')
        || id.contains('\\')
        || id.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(AppError::from("非法 session id"));
    }
    Ok(paths::sessions_dir()?.join(format!("{id}.json")))
}

pub fn save_session_json(raw: &str) -> Result<String, AppError> {
    let value: Value = serde_json::from_str(raw)?;
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
    let path = session_path(id)?;
    atomic_write(&path, raw.as_bytes())?;
    Ok(path.display().to_string())
}

pub fn load_session_json(id: &str) -> Result<String, AppError> {
    let path = session_path(id)?;
    read_with_fallback(&path)
}

fn read_with_fallback(path: &Path) -> Result<String, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str::<Value>(&text)?;
            Ok(text)
        }
        Err(_) => {
            let bak = path.with_extension("json.bak");
            if bak.exists() {
                let text = fs::read_to_string(&bak)?;
                serde_json::from_str::<Value>(&text)?;
                return Ok(text);
            }
            let tmp = path.with_extension("json.tmp");
            if tmp.exists() {
                let text = fs::read_to_string(&tmp)?;
                serde_json::from_str::<Value>(&text)?;
                return Ok(text);
            }
            Err(AppError::from("找不到有效的 Session 文件"))
        }
    }
}

pub fn list_session_summaries() -> Result<Vec<Value>, AppError> {
    let dir = paths::sessions_dir()?;
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        out.push(serde_json::json!({
            "id": v.get("id"),
            "examId": v.get("examId"),
            "module": v.get("module"),
            "mode": v.get("mode"),
            "status": v.get("status"),
            "integrity": v.get("integrity"),
            "startedAt": v.get("startedAt"),
            "updatedAt": v.get("updatedAt"),
            "title": v.get("examTitle"),
        }));
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
        fs::rename(&path, archive.join(path.file_name().unwrap()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

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
}
