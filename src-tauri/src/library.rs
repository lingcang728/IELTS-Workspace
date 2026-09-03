use crate::error::AppError;
use crate::paths;
use crate::safe_path;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_IMPORT_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMPORT_QUESTIONS: usize = 80;

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

/// Where `load_transcript` looks. Probed once per index build so a listening
/// paper can say up front whether dictation has anything to show.
fn transcript_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(fixtures) = paths::fixtures_root() {
        roots.push(fixtures.join("transcripts"));
    }
    if let Ok(data) = paths::ensure_data_layout() {
        roots.push(data.join("transcripts"));
    }
    roots
}

fn build_index() -> Result<LibraryIndex, AppError> {
    let mut index = LibraryIndex::default();
    let transcripts = transcript_roots();
    let audio_bindings = crate::audio::load_bindings().unwrap_or_else(|_| crate::audio::BindingsFile {
        schema_version: 1,
        bindings: std::collections::BTreeMap::new(),
    });
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
        // Cambridge 4's listening papers have audio, questions and answer keys
        // but no transcript was ever extracted, so dictation would open on a
        // blank page. Report the fact here instead: the exam stays fully usable
        // for practice and mock, and 精听 filters on this flag.
        let has_transcript = transcripts
            .iter()
            .any(|root| root.join(format!("{id}.json")).exists());
        let module = v.get("module").and_then(Value::as_str).unwrap_or("");
        let audio_status = if module == "listening" {
            crate::audio::status_for_with_bindings(&audio_bindings, id)
        } else {
            "ready"
        };
        index.summaries.push(serde_json::json!({
            "id": v.get("id"),
            "title": v.get("title"),
            "module": v.get("module"),
            "source": v.get("source"),
            "path": path.display().to_string(),
            "durationMs": v.pointer("/policy/endCondition/durationMs"),
            "questionCount": count_questions(&v),
            "hasTranscript": has_transcript,
            "audioStatus": audio_status,
        }));
        index.exams.insert(id.to_string(), v);
    }
    index.summaries.sort_by(|a, b| {
        natural_cmp(
            a.get("title").and_then(Value::as_str).unwrap_or_default(),
            b.get("title").and_then(Value::as_str).unwrap_or_default(),
        )
    });
    Ok(index)
}

/// Compare titles the way a person reads them: digit runs count as numbers.
///
/// Plain `str::cmp` sorted the library "Cambridge IELTS 10 … 21" and only then
/// "Cambridge IELTS 4 … 9", because '1' < '4' one character at a time. The
/// Cambridge books are numbered, and their number is also their order — oldest
/// to newest, easiest to hardest — so the list has to read 4, 5, … 20, 21.
/// The same rule fixes "Test 10" against "Test 9" if a book ever grows one.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    // Compare the whole digit run as a number. Leading zeros are
                    // ignored for value, then used to break an exact tie so the
                    // ordering stays total ("04" and "4" are not the same key).
                    let take_run = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                        let mut run = String::new();
                        while let Some(d) = it.peek().copied() {
                            if !d.is_ascii_digit() {
                                break;
                            }
                            run.push(d);
                            it.next();
                        }
                        run
                    };
                    let x_run = take_run(&mut left);
                    let y_run = take_run(&mut right);
                    let x_trim = x_run.trim_start_matches('0');
                    let y_trim = y_run.trim_start_matches('0');
                    match x_trim.len().cmp(&y_trim.len()).then(x_trim.cmp(y_trim)) {
                        Ordering::Equal => match x_run.len().cmp(&y_run.len()) {
                            Ordering::Equal => continue,
                            other => return other,
                        },
                        other => return other,
                    }
                }
                match x.cmp(&y) {
                    Ordering::Equal => {
                        left.next();
                        right.next();
                    }
                    other => return other,
                }
            }
        }
    }
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

pub fn invalidate() {
    invalidate_index();
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

fn collect_asset_fields(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if matches!(key.as_str(), "audioAsset" | "imageAsset") {
                    if let Some(s) = child.as_str() {
                        out.push(s.to_string());
                    }
                }
                collect_asset_fields(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_asset_fields(child, out);
            }
        }
        _ => {}
    }
}

pub fn import_exam_json(raw: &str) -> Result<Value, AppError> {
    if raw.len() > MAX_IMPORT_BYTES {
        return Err(AppError::from("导入失败：JSON 超过 2 MB 上限"));
    }
    let v: Value = serde_json::from_str(raw)?;
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::from("导入失败：缺少 schemaVersion=1"));
    }
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::from("导入失败：缺少 id"))?;
    if !safe_path::valid_id(id) {
        return Err(AppError::from("导入失败：id 只能含字母、数字、连字符和下划线"));
    }
    let module = v.get("module").and_then(Value::as_str).unwrap_or("");
    if !matches!(module, "reading" | "listening" | "writing") {
        return Err(AppError::from("导入失败：module 必须是 reading、listening 或 writing"));
    }
    let questions = count_questions(&v) as usize;
    if questions == 0 {
        return Err(AppError::from("导入失败：试卷没有任何题目"));
    }
    if questions > MAX_IMPORT_QUESTIONS {
        return Err(AppError::from(format!(
            "导入失败：题目数量 {questions} 超过 {MAX_IMPORT_QUESTIONS} 上限"
        )));
    }
    let mut assets = Vec::new();
    collect_asset_fields(&v, &mut assets);
    for rel in &assets {
        safe_path::sanitize_rel(rel).map_err(|e| {
            AppError::from(format!("导入失败：资源路径非法（{rel}）：{e}"))
        })?;
    }
    if exam_exists(id) {
        return Err(AppError::from("导入失败：试卷 ID 已存在，拒绝覆盖"));
    }
    let dest = paths::library_dir()?.join(format!("{id}.json"));
    crate::session::atomic_write(&dest, serde_json::to_vec_pretty(&v)?.as_slice())?;
    invalidate_index();
    Ok(v)
}

fn exam_exists(id: &str) -> bool {
    with_index(|index| index.exams.contains_key(id)).unwrap_or(false)
}

fn asset_roots() -> Result<Vec<PathBuf>, AppError> {
    let mut roots = vec![paths::assets_dir()?, paths::fixtures_root()?];
    let fixtures_assets = paths::fixtures_root()?.join("assets");
    if fixtures_assets.exists() {
        roots.push(fixtures_assets);
    }
    Ok(roots)
}

pub fn resolve_asset(rel: &str) -> Result<String, AppError> {
    let path = safe_path::resolve_under(rel, &asset_roots()?)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{collect_asset_fields, natural_cmp};
    use serde_json::json;

    fn sorted(mut titles: Vec<&str>) -> Vec<&str> {
        titles.sort_by(|a, b| natural_cmp(a, b));
        titles
    }

    #[test]
    fn cambridge_books_run_from_4_to_21_not_10_to_9() {
        let titles = sorted(vec![
            "Cambridge IELTS 10 Academic Test 1 Reading",
            "Cambridge IELTS 4 Academic Test 1 Reading",
            "Cambridge IELTS 21 Academic Test 1 Reading",
            "Cambridge IELTS 9 Academic Test 1 Reading",
        ]);
        assert_eq!(
            titles,
            vec![
                "Cambridge IELTS 4 Academic Test 1 Reading",
                "Cambridge IELTS 9 Academic Test 1 Reading",
                "Cambridge IELTS 10 Academic Test 1 Reading",
                "Cambridge IELTS 21 Academic Test 1 Reading",
            ]
        );
    }

    #[test]
    fn tests_within_a_book_stay_in_order_past_nine() {
        assert_eq!(
            sorted(vec!["Book 4 Test 10", "Book 4 Test 2", "Book 4 Test 9"]),
            vec!["Book 4 Test 2", "Book 4 Test 9", "Book 4 Test 10"]
        );
    }

    #[test]
    fn letters_still_decide_when_the_numbers_match() {
        assert_eq!(
            sorted(vec![
                "Cambridge IELTS 8 Academic Test 1 Writing",
                "Cambridge IELTS 8 Academic Test 1 Listening",
                "Cambridge IELTS 8 Academic Test 1 Reading",
            ]),
            vec![
                "Cambridge IELTS 8 Academic Test 1 Listening",
                "Cambridge IELTS 8 Academic Test 1 Reading",
                "Cambridge IELTS 8 Academic Test 1 Writing",
            ]
        );
    }

    #[test]
    fn the_ordering_is_total_so_the_sort_cannot_wobble() {
        use std::cmp::Ordering;
        // A zero-padded number and a bare one compare equal by value; the tie
        // break keeps them distinguishable, which `sort_by` requires.
        assert_eq!(natural_cmp("Test 04", "Test 4"), Ordering::Greater);
        assert_eq!(natural_cmp("Test 4", "Test 04"), Ordering::Less);
        assert_eq!(natural_cmp("Test 4", "Test 4"), Ordering::Equal);
        assert_eq!(natural_cmp("Test 4", "Test 4 Reading"), Ordering::Less);
    }

    #[test]
    fn import_rejects_bad_ids_and_absolute_assets() {
        use super::import_exam_json;
        assert!(import_exam_json(r#"{"schemaVersion":1,"id":"../x","module":"reading","sections":[]}"#).is_err());
        assert!(import_exam_json(r#"{"schemaVersion":1,"id":"ok-id","module":"reading","sections":[{"questionGroups":[{"questions":[{"id":"q1","number":1,"type":"completion","prompt":"x"}],"instruction":"i","questionType":"completion","scoringPolicy":"per_question"}],"imageAsset":"C:\\Windows\\x.png"}]}"#).is_err());
    }

    #[test]
    fn import_collects_nested_asset_fields() {
        let exam = json!({
            "sections": [{
                "audioAsset": "assets/cambridge/c4-t1.mp3",
                "questionGroups": [{ "imageAsset": "assets/cambridge/map.jpg", "questions": [] }]
            }]
        });
        let mut out = Vec::new();
        collect_asset_fields(&exam, &mut out);
        assert_eq!(out.len(), 2);
    }
}
