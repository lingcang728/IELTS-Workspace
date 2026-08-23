use crate::error::AppError;
use crate::paths;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct LibraryIndex {
    exams: BTreeMap<String, Value>,
    summaries: Vec<Value>,
}

static LIBRARY_INDEX: OnceLock<Mutex<Option<LibraryIndex>>> = OnceLock::new();

fn library_cache() -> &'static Mutex<Option<LibraryIndex>> {
    LIBRARY_INDEX.get_or_init(|| Mutex::new(None))
}

fn collect_exam_files() -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    let mut dirs = vec![paths::library_dir()?, paths::fixtures_root()?];
    if paths::is_dev() {
        dirs.push(paths::app_root()?.join("data-dev").join("official-samples"));
    } else {
        dirs.push(paths::data_root()?.join("official-samples"));
    }
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        walk_json(&dir, &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn walk_json(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_json(&path, files)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
            files.push(path);
        }
    }
    Ok(())
}

fn build_index() -> Result<LibraryIndex, AppError> {
    let mut index = LibraryIndex::default();
    for path in collect_exam_files()? {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        let id = v.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() || v.get("module").is_none() {
            continue;
        }
        if v.pointer("/source/kind").and_then(Value::as_str) == Some("generated_practice") {
            continue;
        }
        if v.get("module").and_then(Value::as_str) == Some("listening")
            && id.starts_with("cambridge-21-test-")
        {
            continue;
        }
        index.summaries.push(serde_json::json!({
            "id": v.get("id"),
            "title": v.get("title"),
            "module": v.get("module"),
            "source": v.get("source"),
            "path": path.display().to_string(),
            "durationMs": v.pointer("/policy/endCondition/durationMs"),
            "questionCount": count_questions(&v),
        }));
        index.exams.insert(id.to_string(), v);
    }
    index.summaries.sort_by(|a, b| {
        a.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("title").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(index)
}

fn with_index<T>(read: impl FnOnce(&LibraryIndex) -> T) -> Result<T, AppError> {
    let mut guard = library_cache()
        .lock()
        .map_err(|_| AppError::from("题库索引锁已损坏"))?;
    if guard.is_none() {
        *guard = Some(build_index()?);
    }
    Ok(read(guard.as_ref().expect("library index initialized")))
}

fn invalidate_index() {
    if let Ok(mut guard) = library_cache().lock() {
        *guard = None;
    }
}

pub fn list_exams() -> Result<Vec<Value>, AppError> {
    with_index(|index| index.summaries.clone())
}

fn count_questions(exam: &Value) -> u32 {
    let mut n = 0u32;
    if let Some(sections) = exam.get("sections").and_then(Value::as_array) {
        for s in sections {
            if let Some(groups) = s.get("questionGroups").and_then(Value::as_array) {
                for g in groups {
                    if let Some(qs) = g.get("questions").and_then(Value::as_array) {
                        n += qs.len() as u32;
                    }
                }
            }
        }
    }
    n
}

pub fn load_exam(id: &str) -> Result<Value, AppError> {
    with_index(|index| index.exams.get(id).cloned())?
        .ok_or_else(|| AppError::from(format!("找不到试卷: {id}")))
}

pub fn import_exam_json(raw: &str) -> Result<Value, AppError> {
    let v: Value = serde_json::from_str(raw)?;
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::from("导入失败：缺少 schemaVersion=1"));
    }
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::from("导入失败：缺少 id"))?;
    let dest = paths::library_dir()?.join(format!("{id}.json"));
    crate::session::atomic_write(&dest, serde_json::to_vec_pretty(&v)?.as_slice())?;
    invalidate_index();
    Ok(v)
}

pub fn resolve_asset(rel: &str) -> Result<String, AppError> {
    if rel.is_empty() || rel.contains("..") {
        return Err(AppError::from("非法资源路径"));
    }
    let candidates = [
        paths::assets_dir()?.join(rel),
        paths::data_root()?.join(rel),
        paths::fixtures_root()?.join(rel),
        paths::app_root()?.join(rel),
    ];
    for p in candidates {
        if p.exists() {
            return Ok(p.display().to_string());
        }
    }
    Err(AppError::from(format!("找不到资源: {rel}")))
}
