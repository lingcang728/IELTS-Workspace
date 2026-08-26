use crate::audio_meta::{self, Sniff};
use crate::error::AppError;
use crate::paths;
use crate::session;
use crate::ziputil;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

const CATALOG_JSON: &str = include_str!("../../schema/audio-catalog.json");
const WHOLE_TRACK_MS: u64 = 15 * 60 * 1000;

static CANCEL: AtomicBool = AtomicBool::new(false);

fn last_plan() -> &'static Mutex<Option<AudioImportPlan>> {
    static P: OnceLock<Mutex<Option<AudioImportPlan>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn check_cancel() -> Result<(), AppError> {
    if CANCEL.load(Ordering::SeqCst) {
        Err(AppError::from("已取消导入"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub exam_id: String,
    pub book: u32,
    pub test: u32,
    pub standard_name: String,
    pub sha256: String,
    pub bytes: u64,
    pub duration_ms: u64,
    pub part_starts_ms: Vec<u64>,
    pub part_durations_ms: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub schema_version: u32,
    pub content_version: String,
    pub release_tag: String,
    pub guide_url: String,
    pub expected: u32,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BindingMode {
    FullTrack,
    Parts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    CatalogHash,
    KnownHash,
    FilenameDuration,
    Manual,
    Confirmed,
    FolderLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundFile {
    pub sha256: String,
    pub managed_name: String,
    pub original_name: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBinding {
    pub exam_id: String,
    pub mode: BindingMode,
    pub files: Vec<BoundFile>,
    pub part_starts_ms: Vec<u64>,
    pub match_kind: MatchKind,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingsFile {
    pub schema_version: u32,
    pub bindings: BTreeMap<String, AudioBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPart {
    pub path: String,
    pub file_name: String,
    pub sha256: String,
    pub duration_ms: u64,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamImportRow {
    pub exam_id: String,
    pub book: u32,
    pub test: u32,
    pub parts: Vec<Option<ScannedPart>>,
    pub status: String,
    pub missing_parts: Vec<u32>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipBucket {
    pub code: String,
    pub reason: String,
    pub count: u32,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportPlan {
    pub exams: Vec<ExamImportRow>,
    pub skipped: Vec<SkipBucket>,
    pub ready_count: u32,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub phase: String,
    pub current: u32,
    pub total: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLibraryStatus {
    pub catalog_count: usize,
    pub bound_count: usize,
    pub missing_count: usize,
    pub needs_review_count: usize,
    pub guide_url: String,
    pub release_tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTrack {
    pub path: String,
    pub start_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    pub exam_id: String,
    pub mode: BindingMode,
    pub tracks: Vec<PlaybackTrack>,
    pub part_starts_ms: Vec<u64>,
}

struct Inspected {
    path: PathBuf,
    original_name: String,
    sha256: String,
    duration_ms: u64,
    format: String,
    book: Option<u32>,
    test: Option<u32>,
    part: Option<u32>,
}

pub fn catalog() -> Result<&'static CatalogFile, AppError> {
    use std::sync::OnceLock;
    static CATALOG: OnceLock<CatalogFile> = OnceLock::new();
    Ok(CATALOG.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(CATALOG_JSON).expect("schema/audio-catalog.json 无效")
    }))
}

pub fn load_bindings() -> Result<BindingsFile, AppError> {
    let path = paths::audio_bindings_path()?;
    if !path.exists() {
        return Ok(BindingsFile {
            schema_version: 1,
            bindings: BTreeMap::new(),
        });
    }
    let text = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&text)?)
}

fn save_bindings(file: &BindingsFile) -> Result<(), AppError> {
    let path = paths::audio_bindings_path()?;
    let bytes = serde_json::to_vec_pretty(file)?;
    session::atomic_write(&path, &bytes)
}

pub fn status_for(exam_id: &str) -> &'static str {
    let Ok(file) = load_bindings() else {
        return "missing";
    };
    match file.bindings.get(exam_id) {
        None => "missing",
        Some(b) if b.mode != BindingMode::Parts || b.files.len() != 4 => "needsReview",
        Some(b) if b.files.iter().any(|f| {
            paths::audio_files_dir()
                .map(|d| !d.join(&f.managed_name).is_file())
                .unwrap_or(true)
        }) =>
        {
            "needsReview"
        }
        Some(_) => "ready",
    }
}

pub fn library_status() -> Result<AudioLibraryStatus, AppError> {
    let cat = catalog()?;
    let bindings = load_bindings()?;
    let mut bound = 0usize;
    let mut review = 0usize;
    for entry in &cat.entries {
        match status_for(&entry.exam_id) {
            "ready" => bound += 1,
            "needsReview" => review += 1,
            _ => {}
        }
    }
    let _ = bindings;
    Ok(AudioLibraryStatus {
        catalog_count: cat.entries.len(),
        bound_count: bound,
        missing_count: cat.entries.len().saturating_sub(bound + review),
        needs_review_count: review,
        guide_url: cat.guide_url.clone(),
        release_tag: cat.release_tag.clone(),
    })
}

pub fn pick_files() -> Result<Vec<String>, AppError> {
    let files = rfd::FileDialog::new()
        .add_filter("音频与 ZIP", &["mp3", "m4a", "wav", "zip"])
        .add_filter("音频", &["mp3", "m4a", "wav"])
        .set_title("选择听力音频（每套四个 Part）")
        .pick_files();
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect())
}

pub fn pick_folder() -> Result<Option<String>, AppError> {
    Ok(rfd::FileDialog::new()
        .set_title("选择包含听力音频的文件夹")
        .pick_folder()
        .map(|p| p.display().to_string()))
}

pub fn open_guide() -> Result<String, AppError> {
    let url = catalog()?.guide_url.clone();
    open::that(&url).map_err(|e| AppError::from(format!("无法打开浏览器：{e}")))?;
    Ok(url)
}

pub fn scan_paths(
    paths_in: Vec<String>,
    target_exam_id: Option<String>,
    mut progress: impl FnMut(ImportProgress),
) -> Result<AudioImportPlan, AppError> {
    CANCEL.store(false, Ordering::SeqCst);
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let staging = paths::ensure_data_layout()?.join("temp").join("audio-import");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    for raw in paths_in {
        check_cancel()?;
        let path = PathBuf::from(&raw);
        if !path.exists() {
            bump_skip(&mut skipped, "missing", &format!("找不到文件：{raw}"), &raw);
            continue;
        }
        if path.is_dir() {
            collect_audio(&path, &mut files);
        } else if is_zip(&path) {
            match ziputil::safe_extract(&path, &staging.join(unique_stem(&path))) {
                Ok(extracted) => {
                    for p in extracted {
                        if is_audio(&p) {
                            files.push(p);
                        }
                    }
                }
                Err(e) => bump_skip(&mut skipped, "zip", &e.to_string(), &raw),
            }
        } else if is_audio(&path) {
            files.push(path);
        } else {
            bump_skip(&mut skipped, "type", "不支持的文件类型，仅接受 MP3 / M4A / WAV / ZIP", &raw);
        }
    }
    files.sort();
    files.dedup();
    let total = files.len() as u32;
    let mut inspected = Vec::new();
    for (i, path) in files.iter().enumerate() {
        check_cancel()?;
        progress(ImportProgress {
            phase: "scan".into(),
            current: i as u32 + 1,
            total,
            message: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        });
        match inspect(path, &staging) {
            Ok(row) => inspected.push(row),
            Err(e) => bump_skip(&mut skipped, "inspect", &e.to_string(), &path.display().to_string()),
        }
    }
    let plan = group_inspected(inspected, target_exam_id.as_deref(), skipped);
    if let Ok(mut guard) = last_plan().lock() {
        *guard = Some(plan.clone());
    }
    Ok(plan)
}

fn inspect(path: &Path, staging: &Path) -> Result<Inspected, AppError> {
    let sniff = audio_meta::sniff(path)?;
    match &sniff {
        Sniff::Unsupported(why) => return Err(AppError::from(why.clone())),
        Sniff::MpegInWav { .. } => {}
        Sniff::Mp3 | Sniff::M4a | Sniff::WavPcm => {}
    }
    let work = if matches!(sniff, Sniff::MpegInWav { .. }) {
        audio_meta::extract_mpeg_from_wav(path, &staging.join("extracted"))?
    } else {
        path.to_path_buf()
    };
    let sha = ziputil::sha256_file(&work)?;
    let duration = audio_meta::duration_ms(&work)?;
    let text = path.to_string_lossy();
    let stem = file_stem(path);
    let (book, test) = parse_book_test_any(&text);
    let part = parse_part(&stem).or_else(|| parse_part(&text));
    Ok(Inspected {
        path: work,
        original_name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        sha256: sha,
        duration_ms: duration,
        format: audio_meta::format_label(&sniff).to_string(),
        book,
        test,
        part,
    })
}

fn group_inspected(
    rows: Vec<Inspected>,
    target_exam_id: Option<&str>,
    mut skipped: Vec<SkipBucket>,
) -> AudioImportPlan {
    let target = target_exam_id.and_then(parse_exam_id);
    let mut slots: BTreeMap<(u32, u32), [Vec<Inspected>; 4]> = BTreeMap::new();
    let mut seen_hash: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new();

    for row in rows {
        if let Some(book) = row.book {
            if (1..=3).contains(&book) {
                bump_skip(
                    &mut skipped,
                    "books_1_3",
                    "剑1–3 不在支持范围，请导入剑4–20 的四个 Part",
                    &row.original_name,
                );
                continue;
            }
            if book == 21 {
                bump_skip(
                    &mut skipped,
                    "book_21",
                    "剑21 没有 Listening",
                    &row.original_name,
                );
                continue;
            }
            if !(4..=20).contains(&book) {
                bump_skip(
                    &mut skipped,
                    "book_range",
                    "只支持剑4–20 听力",
                    &row.original_name,
                );
                continue;
            }
        }
        if row.part.is_none() && row.duration_ms >= WHOLE_TRACK_MS {
            bump_skip(
                &mut skipped,
                "whole_track",
                "整轨已不再支持，请导入 Part/Section 1–4 四个文件",
                &row.original_name,
            );
            continue;
        }
        let (book, test) = match (row.book, row.test, target) {
            (Some(b), Some(t), _) => (b, t),
            (_, _, Some((b, t))) if row.part.is_some() => (b, t),
            _ => {
                bump_skip(
                    &mut skipped,
                    "unmatched",
                    "无法识别册次/Test/Part，已跳过",
                    &row.original_name,
                );
                continue;
            }
        };
        if let Some((tb, tt)) = target {
            if (book, test) != (tb, tt) {
                bump_skip(
                    &mut skipped,
                    "other_exam",
                    &format!("不属于当前试卷 cambridge-{tb}-test-{tt}-listening"),
                    &row.original_name,
                );
                continue;
            }
        }
        let Some(part) = row.part else {
            bump_skip(
                &mut skipped,
                "no_part",
                "找不到 Part/Section 1–4 标记",
                &row.original_name,
            );
            continue;
        };
        if !(1..=4).contains(&part) || !(1..=4).contains(&test) {
            bump_skip(
                &mut skipped,
                "unmatched",
                "无法识别册次/Test/Part，已跳过",
                &row.original_name,
            );
            continue;
        }
        if let Some(&(b0, t0, p0)) = seen_hash.get(&row.sha256) {
            if (b0, t0, p0) != (book, test, part) {
                bump_skip(
                    &mut skipped,
                    "duplicate",
                    "同一文件哈希出现在不同试卷或 Part，已跳过后续副本",
                    &row.original_name,
                );
                continue;
            }
            bump_skip(
                &mut skipped,
                "duplicate",
                "重复文件（相同哈希）已忽略",
                &row.original_name,
            );
            continue;
        }
        seen_hash.insert(row.sha256.clone(), (book, test, part));
        let entry = slots.entry((book, test)).or_insert_with(|| {
            [Vec::new(), Vec::new(), Vec::new(), Vec::new()]
        });
        entry[(part - 1) as usize].push(row);
    }

    let mut exams = Vec::new();
    for ((book, test), parts) in slots {
        let exam_id = format!("cambridge-{book}-test-{test}-listening");
        let mut chosen: Vec<Option<ScannedPart>> = vec![None, None, None, None];
        let mut missing = Vec::new();
        let mut conflict = false;
        for i in 0..4 {
            match parts[i].as_slice() {
                [] => missing.push(i as u32 + 1),
                [one] => chosen[i] = Some(to_scanned(one)),
                many => {
                    conflict = true;
                    chosen[i] = Some(to_scanned(&many[0]));
                    bump_skip(
                        &mut skipped,
                        "conflict",
                        &format!("{exam_id} 的 Part {} 有 {} 个候选文件", i + 1, many.len()),
                        &many[1].original_name,
                    );
                }
            }
        }
        let (status, reason) = if conflict {
            ("conflict".into(), "同一 Part 出现多个不同文件".into())
        } else if missing.is_empty() {
            ("ready".into(), "四个 Part 已齐".into())
        } else {
            (
                "missing_parts".into(),
                format!(
                    "缺少 Part {}",
                    missing
                        .iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            )
        };
        exams.push(ExamImportRow {
            exam_id,
            book,
            test,
            parts: chosen,
            status,
            missing_parts: missing,
            reason,
        });
    }
    exams.sort_by(|a, b| a.book.cmp(&b.book).then(a.test.cmp(&b.test)));
    let ready_count = exams.iter().filter(|e| e.status == "ready").count() as u32;
    AudioImportPlan {
        exams,
        skipped,
        ready_count,
        cancelled: false,
    }
}

fn to_scanned(row: &Inspected) -> ScannedPart {
    ScannedPart {
        path: row.path.display().to_string(),
        file_name: row.original_name.clone(),
        sha256: row.sha256.clone(),
        duration_ms: row.duration_ms,
        format: row.format.clone(),
    }
}

fn bump_skip(buckets: &mut Vec<SkipBucket>, code: &str, reason: &str, example: &str) {
    if let Some(b) = buckets.iter_mut().find(|b| b.code == code) {
        b.count += 1;
        if b.examples.len() < 3 {
            b.examples.push(example.to_string());
        }
        return;
    }
    buckets.push(SkipBucket {
        code: code.into(),
        reason: reason.into(),
        count: 1,
        examples: vec![example.to_string()],
    });
}

pub fn confirm_import(
    exam_ids: Vec<String>,
    mut progress: impl FnMut(ImportProgress),
) -> Result<Vec<AudioBinding>, AppError> {
    CANCEL.store(false, Ordering::SeqCst);
    let plan = last_plan()
        .lock()
        .map_err(|_| AppError::from("导入计划锁已损坏"))?
        .clone()
        .ok_or_else(|| AppError::from("没有可确认的扫描结果，请重新选择文件"))?;
    let mut bindings = load_bindings()?;
    let mut written = Vec::new();
    let mut newly: Vec<PathBuf> = Vec::new();
    let total = exam_ids.len() as u32;
    let result = (|| {
        for (i, exam_id) in exam_ids.iter().enumerate() {
            check_cancel()?;
            progress(ImportProgress {
                phase: "import".into(),
                current: i as u32 + 1,
                total,
                message: exam_id.clone(),
            });
            let row = plan
                .exams
                .iter()
                .find(|e| e.exam_id == *exam_id)
                .ok_or_else(|| AppError::from(format!("{exam_id} 不在最近一次扫描结果中")))?;
            if row.status != "ready" {
                return Err(AppError::from(format!(
                    "{exam_id} 尚未凑齐四个 Part：{}",
                    row.reason
                )));
            }
            let mut files = Vec::new();
            for (idx, part) in row.parts.iter().enumerate() {
                check_cancel()?;
                let part = part
                    .as_ref()
                    .ok_or_else(|| AppError::from(format!("{exam_id} 缺少 Part {}", idx + 1)))?;
                let path = PathBuf::from(&part.path);
                let recomputed = ziputil::sha256_file(&path)?;
                if recomputed != part.sha256 {
                    return Err(AppError::from(format!(
                        "{} 在确认前被改动，已拒绝导入",
                        part.file_name
                    )));
                }
                let duration = audio_meta::duration_ms(&path)?;
                let sniff = audio_meta::sniff(&path)?;
                if matches!(sniff, Sniff::Unsupported(_)) {
                    return Err(AppError::from(format!("{} 格式不受支持", part.file_name)));
                }
                let parsed = parse_book_test_any(&path.to_string_lossy());
                if let (Some(b), Some(t)) = parsed {
                    let expected = format!("cambridge-{b}-test-{t}-listening");
                    if expected != *exam_id {
                        return Err(AppError::from(format!(
                            "{} 解析为 {expected}，与目标 {exam_id} 不符",
                            part.file_name
                        )));
                    }
                }
                let dest = paths::audio_files_dir()?.join(format!(
                    "{}.{}",
                    recomputed,
                    path.extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("mp3")
                        .to_ascii_lowercase()
                ));
                let existed_before = dest.is_file();
                let bound = ingest_file(&path, &part.file_name, &recomputed, duration)?;
                if !existed_before {
                    newly.push(paths::audio_files_dir()?.join(&bound.managed_name));
                }
                files.push(bound);
            }
            if files.len() != 4 {
                return Err(AppError::from(format!("{exam_id} 需要四个 Part 文件")));
            }
            let mut acc = 0u64;
            let mut starts = Vec::new();
            for f in &files {
                starts.push(acc);
                acc += f.duration_ms;
            }
            drop_unref(&bindings, exam_id, &files)?;
            let binding = AudioBinding {
                exam_id: exam_id.clone(),
                mode: BindingMode::Parts,
                files,
                part_starts_ms: starts,
                match_kind: MatchKind::FolderLayout,
                updated_at: now_iso(),
            };
            bindings.bindings.insert(exam_id.clone(), binding.clone());
            written.push(binding);
        }
        save_bindings(&bindings)?;
        Ok(written)
    })();
    if result.is_err() {
        rollback_new_files(&newly);
    }
    result
}

fn rollback_new_files(paths: &[PathBuf]) {
    for p in paths {
        let _ = fs::remove_file(p);
    }
}

fn ingest_file(
    src: &Path,
    original: &str,
    sha: &str,
    duration_ms: u64,
) -> Result<BoundFile, AppError> {
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp3")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp3" | "m4a" | "wav") {
        return Err(AppError::from("仅支持 MP3、M4A、WAV"));
    }
    let managed_name = format!("{sha}.{ext}");
    let dest = paths::audio_files_dir()?.join(&managed_name);
    if dest.exists() {
        if ziputil::sha256_file(&dest)? != sha {
            return Err(AppError::from("托管文件哈希冲突，拒绝覆盖"));
        }
    } else {
        fs::copy(src, &dest)?;
        if ziputil::sha256_file(&dest)? != sha {
            let _ = fs::remove_file(&dest);
            return Err(AppError::from("复制后哈希不一致，已回滚"));
        }
    }
    Ok(BoundFile {
        sha256: sha.to_string(),
        managed_name,
        original_name: original.to_string(),
        duration_ms,
    })
}

fn drop_unref(bindings: &BindingsFile, exam_id: &str, new_files: &[BoundFile]) -> Result<(), AppError> {
    let Some(old) = bindings.bindings.get(exam_id) else {
        return Ok(());
    };
    let new_hashes: Vec<&str> = new_files.iter().map(|f| f.sha256.as_str()).collect();
    for file in &old.files {
        if new_hashes.contains(&file.sha256.as_str()) {
            continue;
        }
        let still = bindings.bindings.iter().any(|(id, b)| {
            id != exam_id && b.files.iter().any(|f| f.sha256 == file.sha256)
        });
        if !still {
            let path = paths::audio_files_dir()?.join(&file.managed_name);
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

pub fn remove_binding(exam_id: &str) -> Result<(), AppError> {
    let mut file = load_bindings()?;
    let some = file.bindings.remove(exam_id);
    if let Some(old) = some {
        for f in old.files {
            let still = file
                .bindings
                .values()
                .any(|b| b.files.iter().any(|x| x.sha256 == f.sha256));
            if !still {
                let _ = fs::remove_file(paths::audio_files_dir()?.join(&f.managed_name));
            }
        }
    }
    save_bindings(&file)
}

pub fn playback_source(exam_id: &str) -> Result<PlaybackSource, AppError> {
    let bindings = load_bindings()?;
    let binding = bindings
        .bindings
        .get(exam_id)
        .ok_or_else(|| AppError::from("这套听力还没有绑定音频"))?;
    if binding.mode != BindingMode::Parts || binding.files.len() != 4 {
        return Err(AppError::from("这套听力仍是旧的整轨绑定，请重新导入四个 Part"));
    }
    let dir = paths::audio_files_dir()?;
    let mut tracks = Vec::new();
    for f in &binding.files {
        let path = dir.join(&f.managed_name);
        if !path.is_file() {
            return Err(AppError::from("绑定的音频文件丢失，请重新导入四个 Part"));
        }
        tracks.push(PlaybackTrack {
            path: path.display().to_string(),
            start_ms: 0,
            duration_ms: f.duration_ms,
        });
    }
    Ok(PlaybackSource {
        exam_id: exam_id.to_string(),
        mode: BindingMode::Parts,
        tracks,
        part_starts_ms: binding.part_starts_ms.clone(),
    })
}

pub fn repair_bindings() -> Result<AudioLibraryStatus, AppError> {
    let mut file = load_bindings()?;
    let dir = paths::audio_files_dir()?;
    let mut changed = false;
    let ids: Vec<String> = file.bindings.keys().cloned().collect();
    for id in ids {
        let Some(b) = file.bindings.get(&id).cloned() else {
            continue;
        };
        let missing = b.files.iter().any(|f| !dir.join(&f.managed_name).is_file());
        if missing {
            file.bindings.remove(&id);
            changed = true;
        }
    }
    if changed {
        save_bindings(&file)?;
    }
    library_status()
}

fn collect_audio(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio(&path, out);
        } else if is_audio(&path) {
            out.push(path);
        }
    }
}

fn is_audio(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "m4a" | "wav")
    )
}

fn is_zip(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

fn unique_stem(path: &Path) -> String {
    format!(
        "{}-{}",
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("zip"),
        ziputil::sha256_bytes(path.to_string_lossy().as_bytes())
            .chars()
            .take(8)
            .collect::<String>()
    )
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn normalize_name(name: &str) -> String {
    name.to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_book_test(stem: &str) -> Option<(u32, u32)> {
    let (book, mut test) = parse_book_test_any(stem);
    let book = book?;
    test = Some(test?);
    let mut test = test?;
    if book == 12 && (5..=8).contains(&test) {
        test -= 4;
    }
    if (4..=20).contains(&book) && (1..=4).contains(&test) {
        Some((book, test))
    } else {
        None
    }
}

fn parse_book_test_any(stem: &str) -> (Option<u32>, Option<u32>) {
    (capture_book(stem), capture_test(stem).map(|mut test| {
        if let Some(book) = capture_book(stem) {
            if book == 12 && (5..=8).contains(&test) {
                test -= 4;
            }
        }
        test
    }))
}

fn parse_exam_id(id: &str) -> Option<(u32, u32)> {
    let rest = id.strip_prefix("cambridge-")?.strip_suffix("-listening")?;
    let (book, test) = rest.split_once("-test-")?;
    Some((book.parse().ok()?, test.parse().ok()?))
}

fn capture_book(s: &str) -> Option<u32> {
    if let Some(idx) = s.find('剑') {
        let rest = &s[idx + '剑'.len_utf8()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            if (1..=21).contains(&n) {
                return Some(n);
            }
        }
    }
    let n = normalize_name(s);
    if let Some(rest) = n.strip_prefix('c') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if (1..=2).contains(&digits.len()) {
            if let Ok(book) = digits.parse::<u32>() {
                if (1..=21).contains(&book) {
                    return Some(book);
                }
            }
        }
    }
    if let Some(idx) = n.find("cambridge") {
        let rest = &n[idx + 9..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(book) = digits.parse::<u32>() {
            if (1..=21).contains(&book) {
                return Some(book);
            }
        }
    }
    None
}

fn capture_test(s: &str) -> Option<u32> {
    let n = normalize_name(s);
    for key in ["test", "t"] {
        let mut rest = n.as_str();
        while let Some(idx) = rest.find(key) {
            let after = &rest[idx + key.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(test) = digits.parse::<u32>() {
                if (1..=8).contains(&test) {
                    return Some(test);
                }
            }
            rest = &rest[idx + key.len()..];
        }
    }
    None
}

fn parse_part(stem: &str) -> Option<u32> {
    let n = normalize_name(stem);
    for key in ["section", "part"] {
        if let Some(idx) = n.find(key) {
            let after = &n[idx + key.len()..];
            let d: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(p) = d.parse::<u32>() {
                if (1..=4).contains(&p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{ms}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspected(book: u32, test: u32, part: u32, name: &str, duration: u64) -> Inspected {
        Inspected {
            path: PathBuf::from(name),
            original_name: name.into(),
            sha256: format!("{book}-{test}-{part}-{name}"),
            duration_ms: duration,
            format: "mp3".into(),
            book: Some(book),
            test: Some(test),
            part: Some(part),
        }
    }

    #[test]
    fn four_parts_group_ready() {
        let rows = (1..=4)
            .map(|p| inspected(4, 1, p, &format!("Section{p}.mp3"), 400_000))
            .collect();
        let plan = group_inspected(rows, None, vec![]);
        assert_eq!(plan.ready_count, 1);
        assert_eq!(plan.exams[0].exam_id, "cambridge-4-test-1-listening");
        assert_eq!(plan.exams[0].status, "ready");
    }

    #[test]
    fn missing_part_is_not_ready() {
        let rows = vec![
            inspected(4, 1, 1, "s1.mp3", 400_000),
            inspected(4, 1, 2, "s2.mp3", 400_000),
            inspected(4, 1, 3, "s3.mp3", 400_000),
        ];
        let plan = group_inspected(rows, None, vec![]);
        assert_eq!(plan.exams[0].status, "missing_parts");
        assert_eq!(plan.exams[0].missing_parts, vec![4]);
    }

    #[test]
    fn c1_is_skipped_not_calibrated() {
        let rows = vec![inspected(1, 1, 1, "剑1 Section1.mp3", 400_000)];
        let plan = group_inspected(rows, None, vec![]);
        assert!(plan.exams.is_empty());
        assert!(plan.skipped.iter().any(|s| s.code == "books_1_3"));
    }

    #[test]
    fn whole_track_is_skipped() {
        let row = Inspected {
            path: PathBuf::from("c04-t1.mp3"),
            original_name: "c04-t1.mp3".into(),
            sha256: "aa".into(),
            duration_ms: 1_574_000,
            format: "mp3".into(),
            book: Some(4),
            test: Some(1),
            part: None,
        };
        let plan = group_inspected(vec![row], None, vec![]);
        assert!(plan.skipped.iter().any(|s| s.code == "whole_track"));
        assert!(plan.exams.is_empty());
    }

    #[test]
    fn target_exam_id_wins_for_bare_parts() {
        let rows = (1..=4)
            .map(|p| Inspected {
                path: PathBuf::from(format!("Section{p}.mp3")),
                original_name: format!("Section{p}.mp3"),
                sha256: format!("h{p}"),
                duration_ms: 400_000,
                format: "mp3".into(),
                book: None,
                test: None,
                part: Some(p),
            })
            .collect();
        let plan = group_inspected(rows, Some("cambridge-12-test-3-listening"), vec![]);
        assert_eq!(plan.ready_count, 1);
        assert_eq!(plan.exams[0].exam_id, "cambridge-12-test-3-listening");
    }

    #[test]
    fn conflict_when_two_files_share_a_part() {
        let rows = vec![
            inspected(4, 1, 1, "a.mp3", 400_000),
            inspected(4, 1, 1, "b.mp3", 410_000),
            inspected(4, 1, 2, "s2.mp3", 400_000),
            inspected(4, 1, 3, "s3.mp3", 400_000),
            inspected(4, 1, 4, "s4.mp3", 400_000),
        ];
        let plan = group_inspected(rows, None, vec![]);
        assert_eq!(plan.exams[0].status, "conflict");
    }

    #[test]
    fn c12_source_tests_map_down() {
        assert_eq!(parse_book_test("c12t5"), Some((12, 1)));
        assert_eq!(parse_book_test("c04t1"), Some((4, 1)));
    }

    #[test]
    fn part_names() {
        assert_eq!(parse_part("Section1"), Some(1));
        assert_eq!(parse_part("Part 3.m4a"), Some(3));
        assert_eq!(parse_part("c04-t1"), None);
    }

    #[test]
    fn other_exam_files_skipped_when_target_set() {
        let rows = vec![inspected(5, 1, 1, "s1.mp3", 400_000)];
        let plan = group_inspected(rows, Some("cambridge-4-test-1-listening"), vec![]);
        assert!(plan.exams.is_empty());
        assert!(plan.skipped.iter().any(|s| s.code == "other_exam"));
    }
}
