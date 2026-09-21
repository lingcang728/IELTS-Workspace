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

/// Serializes the load→mutate→save cycle of `bindings.json`. Import commands
/// now run off the main thread, so a concurrent `remove_binding` must not
/// interleave with a `confirm_import` write.
fn bindings_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn last_plan() -> &'static Mutex<Option<AudioImportPlan>> {
    static P: OnceLock<Mutex<Option<AudioImportPlan>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

/// Scans share `data/temp/audio-import` staging and the single `last_plan`
/// slot; now that commands run off the main thread, two overlapping scans
/// would wipe each other's extracted files mid-flight. `bootstrap` also takes
/// this lock before sweeping the staging directory so its cleanup cannot
/// delete files a running scan just extracted.
pub(crate) fn scan_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
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
    /// Size + mtime captured at scan time. `confirm_import` trusts the scanned
    /// hash when both still match — one stat replaces a full-file re-hash.
    pub bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamImportRow {
    pub exam_id: String,
    pub book: u32,
    pub test: u32,
    pub parts: Vec<Option<ScannedPart>>,
    /// Set when the scanned file's SHA-256 matches the embedded catalog entry —
    /// an official whole-track recording. `parts` stays empty for these rows.
    pub whole_track: Option<ScannedPart>,
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
    bytes: u64,
    modified_ms: u64,
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
    let bak = path.with_extension("json.bak");
    let tmp = path.with_extension("json.tmp");
    // atomic_write always leaves a .bak next to bindings.json, and an
    // interrupted write can leave a complete .tmp: a truncated main file must
    // not take every listening paper down to "missing audio".
    let mut last_err = String::new();
    for candidate in [path.as_path(), bak.as_path(), tmp.as_path()] {
        if !candidate.exists() {
            continue;
        }
        let parsed = fs::read_to_string(candidate)
            .map_err(|e| e.to_string())
            .and_then(|text| {
                serde_json::from_str::<BindingsFile>(&text)
                    .map(|file| (text, file))
                    .map_err(|e| e.to_string())
            });
        match parsed {
            Ok((text, mut file)) => {
                // `managed_name` is joined onto `audio_files_dir` at every
                // play/delete site. bindings.json is user-editable local state,
                // so a hand-crafted `../` or device name must die at the load
                // boundary rather than escape the directory later.
                for binding in file.bindings.values_mut() {
                    binding.files.retain(|f| managed_name_ok(&f.managed_name));
                }
                if candidate != path {
                    // load_bindings is read without `bindings_lock`, so this
                    // restore can race a save_bindings tmp write — take the
                    // shared write guard for the duration of the restore.
                    if let Ok(_guard) = crate::session::write_guard() {
                        crate::session::restore_write(&path, text.as_bytes());
                    }
                }
                return Ok(file);
            }
            Err(why) => last_err = why,
        }
    }
    if path.exists() {
        return Err(AppError::from(format!("音频绑定文件损坏：{last_err}")));
    }
    Ok(BindingsFile {
        schema_version: 1,
        bindings: BTreeMap::new(),
    })
}

fn save_bindings(file: &BindingsFile) -> Result<(), AppError> {
    let path = paths::audio_bindings_path()?;
    let bytes = serde_json::to_vec_pretty(file)?;
    // `bindings_lock` serialises mutations against each other, but a
    // lock-free `load_bindings` restore can still write the same tmp scratch
    // file concurrently — take the shared write guard for the write itself.
    let _guard = session::write_guard()?;
    session::atomic_write(&path, &bytes)
}

/// Managed file names are always `{sha256}.{ext}`, generated on import and
/// never free-form. Anything else means bindings.json was hand-edited.
fn managed_name_ok(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    stem.len() == 64
        && stem
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(ext, "mp3" | "m4a" | "wav")
}

fn binding_ready(b: &AudioBinding) -> bool {
    let expected = match b.mode {
        BindingMode::Parts => 4,
        BindingMode::FullTrack => 1,
    };
    b.files.len() == expected
        && b.files.iter().all(|f| {
            paths::audio_files_dir()
                .map(|d| d.join(&f.managed_name).is_file())
                .unwrap_or(false)
        })
}

pub fn status_for_with_bindings(file: &BindingsFile, exam_id: &str) -> &'static str {
    match file.bindings.get(exam_id) {
        None => "missing",
        Some(b) if binding_ready(b) => "ready",
        Some(_) => "needsReview",
    }
}

pub fn library_status() -> Result<AudioLibraryStatus, AppError> {
    let cat = catalog()?;
    let bindings = load_bindings().unwrap_or_else(|_| BindingsFile {
        schema_version: 1,
        bindings: BTreeMap::new(),
    });
    let mut bound = 0usize;
    let mut review = 0usize;
    for entry in &cat.entries {
        match status_for_with_bindings(&bindings, &entry.exam_id) {
            "ready" => bound += 1,
            "needsReview" => review += 1,
            _ => {}
        }
    }
    Ok(AudioLibraryStatus {
        catalog_count: cat.entries.len(),
        bound_count: bound,
        missing_count: cat.entries.len().saturating_sub(bound + review),
        needs_review_count: review,
        guide_url: cat.guide_url.clone(),
        release_tag: cat.release_tag.clone(),
    })
}

pub fn pick_files(window: &tauri::Window) -> Result<Vec<String>, AppError> {
    let files = rfd::FileDialog::new()
        .add_filter("音频与 ZIP", &["mp3", "m4a", "wav", "zip"])
        .add_filter("音频", &["mp3", "m4a", "wav"])
        .set_title("选择听力音频（每套四个 Part）")
        .set_parent(window)
        .pick_files();
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect())
}

pub fn pick_folders(window: &tauri::Window) -> Result<Vec<String>, AppError> {
    Ok(rfd::FileDialog::new()
        .set_title("选择包含听力音频的文件夹（可多选）")
        .set_parent(window)
        .pick_folders()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect())
}

pub fn open_guide() -> Result<String, AppError> {
    let url = catalog()?.guide_url.clone();
    open::that(&url).map_err(|e| AppError::from(format!("无法打开浏览器：{e}")))?;
    Ok(url)
}

/// `paths_in` is expected to come from the rfd pickers (`pick_files` /
/// `pick_folders`). The IPC boundary cannot prove that origin, so treat every
/// entry as untrusted input: the scan returns only metadata (name, SHA-256,
/// duration) and never exposes file contents.
pub fn scan_paths(
    paths_in: Vec<String>,
    target_exam_id: Option<String>,
    mut progress: impl FnMut(ImportProgress),
) -> Result<AudioImportPlan, AppError> {
    CANCEL.store(false, Ordering::SeqCst);
    let _scan_guard = scan_lock()
        .lock()
        .map_err(|_| AppError::from("音频扫描锁已损坏"))?;
    let staging = paths::ensure_data_layout()?
        .join("temp")
        .join("audio-import");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    let staging_in = staging.clone();
    let work = move || -> Result<AudioImportPlan, AppError> {
        let mut files = Vec::new();
        let mut skipped = Vec::new();
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
                match ziputil::safe_extract(&path, &staging_in.join(unique_stem(&path))) {
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
                bump_skip(
                    &mut skipped,
                    "type",
                    "不支持的文件类型，仅接受 MP3 / M4A / WAV / ZIP",
                    &raw,
                );
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
            match inspect(path, &staging_in) {
                Ok(row) => inspected.push(row),
                Err(e) => bump_skip(
                    &mut skipped,
                    "inspect",
                    &e.to_string(),
                    &path.display().to_string(),
                ),
            }
        }
        Ok(group_inspected(
            inspected,
            target_exam_id.as_deref(),
            skipped,
        ))
    };
    let plan = work();
    if let Ok(plan) = &plan {
        if let Ok(mut guard) = last_plan().lock() {
            *guard = Some(plan.clone());
        }
    } else {
        // 取消或中途失败的扫描不留下解压/抽取产物。
        let _ = fs::remove_dir_all(&staging);
    }
    plan
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
    let (bytes, modified_ms) = file_stamp(&work);
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
        bytes,
        modified_ms,
        book,
        test,
        part,
    })
}

/// `(len, mtime-ms)` used to detect a file swap between scan and confirm —
/// matching metadata trusts the scanned hash without re-reading the file.
fn file_stamp(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::metadata(path) else {
        return (0, 0);
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (meta.len(), modified)
}

/// Scan-time (len, mtime) still matching means the bytes — and therefore the
/// recorded sha256/duration — are unchanged, so confirm skips the full re-read.
/// Any drift forces a re-hash; content that no longer matches is rejected.
fn confirmed_meta(path: &Path, part: &ScannedPart) -> Result<(String, u64), AppError> {
    let (bytes, modified_ms) = file_stamp(path);
    if part.bytes > 0 && bytes == part.bytes && modified_ms == part.modified_ms {
        return Ok((part.sha256.clone(), part.duration_ms));
    }
    let recomputed = ziputil::sha256_file(path)?;
    if recomputed != part.sha256 {
        return Err(AppError::from(format!(
            "{} 在确认前被改动，已拒绝导入",
            part.file_name
        )));
    }
    Ok((recomputed, part.duration_ms))
}

fn group_inspected(
    rows: Vec<Inspected>,
    target_exam_id: Option<&str>,
    mut skipped: Vec<SkipBucket>,
) -> AudioImportPlan {
    let target = target_exam_id.and_then(parse_exam_id);
    // sha256 → catalog entry. A hash match is authoritative: it accepts an
    // official whole-track even when the file was renamed to something the
    // filename parser cannot read.
    let catalog_index: BTreeMap<&str, &CatalogEntry> = catalog()
        .map(|c| c.entries.iter().map(|e| (e.sha256.as_str(), e)).collect())
        .unwrap_or_default();
    let mut slots: BTreeMap<(u32, u32), [Vec<Inspected>; 4]> = BTreeMap::new();
    let mut whole: BTreeMap<(u32, u32), Inspected> = BTreeMap::new();
    let mut seen_hash: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new();

    for row in rows {
        if let Some(entry) = catalog_index.get(row.sha256.as_str()) {
            let (book, test) = (entry.book, entry.test);
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
            if seen_hash.contains_key(&row.sha256) {
                bump_skip(
                    &mut skipped,
                    "duplicate",
                    "重复文件（相同哈希）已忽略",
                    &row.original_name,
                );
                continue;
            }
            seen_hash.insert(row.sha256.clone(), (book, test, 0));
            whole.insert((book, test), row);
            continue;
        }
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
            // 文件名已声明册次且与目标试卷册次矛盾（如目标 C7T1 时遇到
            // cambridge-5-part1.mp3）——这是错书而不是"半匹配"，跳过而不是
            // 让后面的 target 兜底把它悄悄绑到目标试卷上。
            if let Some((tb, tt)) = target {
                if book != tb {
                    bump_skip(
                        &mut skipped,
                        "other_exam",
                        &format!("不属于当前试卷 cambridge-{tb}-test-{tt}-listening"),
                        &row.original_name,
                    );
                    continue;
                }
            }
        }
        if row.part.is_none() && row.duration_ms >= WHOLE_TRACK_MS {
            bump_skip(
                &mut skipped,
                "whole_track",
                "整轨仅在 SHA-256 与官方目录一致时才接受；请改用 Part/Section 1–4 四个文件",
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
        let entry = slots
            .entry((book, test))
            .or_insert_with(|| [Vec::new(), Vec::new(), Vec::new(), Vec::new()]);
        entry[(part - 1) as usize].push(row);
    }

    let mut exams = Vec::new();
    let mut keys: Vec<(u32, u32)> = slots.keys().chain(whole.keys()).copied().collect();
    keys.sort_unstable();
    keys.dedup();
    for (book, test) in keys {
        let exam_id = format!("cambridge-{book}-test-{test}-listening");
        if let Some(whole_row) = whole.remove(&(book, test)) {
            if slots
                .get(&(book, test))
                .map(|parts| parts.iter().any(|v| !v.is_empty()))
                .unwrap_or(false)
            {
                bump_skip(
                    &mut skipped,
                    "conflict",
                    &format!("{exam_id} 同时有整轨与分 Part 候选，已采用校验通过的整轨"),
                    &whole_row.original_name,
                );
            }
            exams.push(ExamImportRow {
                exam_id,
                book,
                test,
                parts: vec![None, None, None, None],
                whole_track: Some(to_scanned(&whole_row)),
                status: "ready".into(),
                missing_parts: Vec::new(),
                reason: "官方整轨音频，SHA-256 与内置目录一致".into(),
            });
            continue;
        }
        let Some(parts) = slots.remove(&(book, test)) else {
            continue;
        };
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
            let durations: Vec<u64> = chosen
                .iter()
                .filter_map(|p| p.as_ref().map(|p| p.duration_ms))
                .collect();
            match parts_match_catalog(&exam_id, &durations) {
                Some(false) => (
                    "ready".into(),
                    "四个 Part 已齐；但时长与官方目录不一致，请确认音频来源正确".into(),
                ),
                _ => ("ready".into(), "四个 Part 已齐".into()),
            }
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
            whole_track: None,
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

/// A part is accepted as the official recording when its duration is within
/// 15 s or 10 % of the catalog's `partDurationsMs` — transcodes and trimmed
/// rips land inside that window, a wrong book/test usually does not.
const PART_DURATION_TOLERANCE_MS: u64 = 15_000;

/// `Some(true)` when every part duration matches the catalog entry,
/// `Some(false)` when an entry exists but the durations disagree, `None` when
/// the exam is not in the catalog.
fn parts_match_catalog(exam_id: &str, durations_ms: &[u64]) -> Option<bool> {
    let cat = catalog().ok()?;
    let entry = cat.entries.iter().find(|e| e.exam_id == exam_id)?;
    if durations_ms.len() != 4 || entry.part_durations_ms.len() != 4 {
        return None;
    }
    Some(
        entry
            .part_durations_ms
            .iter()
            .zip(durations_ms.iter())
            .all(|(want, got)| want.abs_diff(*got) <= PART_DURATION_TOLERANCE_MS.max(want / 10)),
    )
}

fn to_scanned(row: &Inspected) -> ScannedPart {
    ScannedPart {
        path: row.path.display().to_string(),
        file_name: row.original_name.clone(),
        sha256: row.sha256.clone(),
        duration_ms: row.duration_ms,
        format: row.format.clone(),
        bytes: row.bytes,
        modified_ms: row.modified_ms,
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
    // Confirm reads staged extracts and wipes the shared staging dir at the
    // end; serialize against a concurrent scan for the same reason.
    let _scan_guard = scan_lock()
        .lock()
        .map_err(|_| AppError::from("音频扫描锁已损坏"))?;
    let plan = last_plan()
        .lock()
        .map_err(|_| AppError::from("导入计划锁已损坏"))?
        .clone()
        .ok_or_else(|| AppError::from("没有可确认的扫描结果，请重新选择文件"))?;
    let _bindings_guard = bindings_lock()
        .lock()
        .map_err(|_| AppError::from("音频绑定锁已损坏"))?;
    let mut bindings = load_bindings()?;
    let mut written = Vec::new();
    let mut newly: Vec<PathBuf> = Vec::new();
    // Managed files orphaned by rebinding are deleted only after the new
    // bindings are on disk: deleting them first would leave bindings.json
    // pointing at files a mid-import failure just rolled back.
    let mut stale: Vec<PathBuf> = Vec::new();
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
            // 整轨行：scan 阶段已按 SHA-256 命中官方目录，确认时再复核一次目录哈希，
            // 绑定为 FullTrack，part 切点直接取目录的 part_starts_ms。
            if let Some(whole) = &row.whole_track {
                let path = PathBuf::from(&whole.path);
                let (sha, duration) = confirmed_meta(&path, whole)?;
                let entry = catalog()?
                    .entries
                    .iter()
                    .find(|e| e.exam_id == *exam_id)
                    .ok_or_else(|| {
                        AppError::from(format!("{exam_id} 不在官方目录中，拒绝整轨导入"))
                    })?;
                if sha != entry.sha256 {
                    return Err(AppError::from(format!(
                        "{} 的哈希与官方目录不符，已拒绝导入",
                        whole.file_name
                    )));
                }
                let sniff = audio_meta::sniff(&path)?;
                if matches!(sniff, Sniff::Unsupported(_)) {
                    return Err(AppError::from(format!("{} 格式不受支持", whole.file_name)));
                }
                let dest = paths::audio_files_dir()?.join(format!(
                    "{}.{}",
                    sha,
                    path.extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("mp3")
                        .to_ascii_lowercase()
                ));
                let existed_before = dest.is_file();
                let bound = ingest_file(&path, &whole.file_name, &sha, duration)?;
                if !existed_before {
                    newly.push(paths::audio_files_dir()?.join(&bound.managed_name));
                }
                stale.extend(unreferenced_files(
                    &bindings,
                    exam_id,
                    std::slice::from_ref(&bound),
                )?);
                let binding = AudioBinding {
                    exam_id: exam_id.clone(),
                    mode: BindingMode::FullTrack,
                    files: vec![bound],
                    part_starts_ms: entry.part_starts_ms.clone(),
                    match_kind: MatchKind::CatalogHash,
                    updated_at: now_ms(),
                };
                bindings.bindings.insert(exam_id.clone(), binding.clone());
                written.push(binding);
                continue;
            }
            let mut files = Vec::new();
            for (idx, part) in row.parts.iter().enumerate() {
                check_cancel()?;
                let part = part
                    .as_ref()
                    .ok_or_else(|| AppError::from(format!("{exam_id} 缺少 Part {}", idx + 1)))?;
                let path = PathBuf::from(&part.path);
                let (recomputed, duration) = confirmed_meta(&path, part)?;
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
                } else if let Some(b) = parsed.0 {
                    // 文件名只声明了册次（cambridge-5-part1.mp3）：册次仍须与
                    // 目标一致，否则扫描期的 target 兜底已经把它绑错了书。
                    if !exam_id.starts_with(&format!("cambridge-{b}-test-")) {
                        return Err(AppError::from(format!(
                            "{} 解析为剑{b}，与目标 {exam_id} 不符",
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
            stale.extend(unreferenced_files(&bindings, exam_id, &files)?);
            let match_kind = match parts_match_catalog(
                exam_id,
                &files.iter().map(|f| f.duration_ms).collect::<Vec<_>>(),
            ) {
                Some(true) => MatchKind::FilenameDuration,
                _ => MatchKind::FolderLayout,
            };
            let binding = AudioBinding {
                exam_id: exam_id.clone(),
                mode: BindingMode::Parts,
                files,
                part_starts_ms: starts,
                match_kind,
                updated_at: now_ms(),
            };
            bindings.bindings.insert(exam_id.clone(), binding.clone());
            written.push(binding);
        }
        save_bindings(&bindings)?;
        for path in stale {
            let _ = fs::remove_file(path);
        }
        Ok(written)
    })();
    if result.is_err() {
        rollback_new_files(&newly);
    }
    // 确认是一次性动作：无论成败，解压/抽取产物与已消费的计划都不再保留，
    // 避免 data/temp/audio-import 残留（上限 2GiB）长期占盘。
    if let Ok(root) = paths::ensure_data_layout() {
        let _ = fs::remove_dir_all(root.join("temp").join("audio-import"));
    }
    if let Ok(mut guard) = last_plan().lock() {
        *guard = None;
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

/// Files an old binding stops referencing once `new_files` replaces it. The
/// caller deletes them after the updated bindings are persisted, never before.
fn unreferenced_files(
    bindings: &BindingsFile,
    exam_id: &str,
    new_files: &[BoundFile],
) -> Result<Vec<PathBuf>, AppError> {
    let Some(old) = bindings.bindings.get(exam_id) else {
        return Ok(Vec::new());
    };
    let new_hashes: Vec<&str> = new_files.iter().map(|f| f.sha256.as_str()).collect();
    let mut stale = Vec::new();
    for file in &old.files {
        if new_hashes.contains(&file.sha256.as_str()) {
            continue;
        }
        let still = bindings
            .bindings
            .iter()
            .any(|(id, b)| id != exam_id && b.files.iter().any(|f| f.sha256 == file.sha256));
        if !still {
            stale.push(paths::audio_files_dir()?.join(&file.managed_name));
        }
    }
    Ok(stale)
}

pub fn remove_binding(exam_id: &str) -> Result<(), AppError> {
    let _guard = bindings_lock()
        .lock()
        .map_err(|_| AppError::from("音频绑定锁已损坏"))?;
    let mut file = load_bindings()?;
    let some = file.bindings.remove(exam_id);
    // Persist the removal before touching managed files: if the save fails the
    // binding on disk must still point at files that exist (deleting first
    // would leave it dangling, the same failure confirm_import avoids). A
    // delete that fails after the save is only an orphan, never a dangling ref.
    save_bindings(&file)?;
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
    Ok(())
}

pub fn playback_source(exam_id: &str) -> Result<PlaybackSource, AppError> {
    let bindings = load_bindings()?;
    let binding = bindings
        .bindings
        .get(exam_id)
        .ok_or_else(|| AppError::from("这套听力还没有绑定音频"))?;
    let dir = paths::audio_files_dir()?;
    if binding.mode == BindingMode::FullTrack {
        // Whole-track bindings carry one file plus catalog part offsets; the
        // exam player streams it once, intensive mode seeks via part_starts_ms.
        let Some(f) = binding.files.first() else {
            return Err(AppError::from("整轨绑定缺少音频文件，请重新导入"));
        };
        let path = dir.join(&f.managed_name);
        if !path.is_file() {
            return Err(AppError::from("绑定的音频文件丢失，请重新导入"));
        }
        let display = path.display().to_string();
        let tracks = if binding.part_starts_ms.is_empty() {
            vec![PlaybackTrack {
                path: display,
                start_ms: 0,
                duration_ms: f.duration_ms,
            }]
        } else {
            binding
                .part_starts_ms
                .iter()
                .enumerate()
                .map(|(i, &start)| {
                    let end = binding
                        .part_starts_ms
                        .get(i + 1)
                        .copied()
                        .unwrap_or(f.duration_ms);
                    PlaybackTrack {
                        path: display.clone(),
                        start_ms: start,
                        duration_ms: end.saturating_sub(start),
                    }
                })
                .collect()
        };
        return Ok(PlaybackSource {
            exam_id: exam_id.to_string(),
            mode: BindingMode::FullTrack,
            tracks,
            part_starts_ms: binding.part_starts_ms.clone(),
        });
    }
    if binding.files.len() != 4 {
        return Err(AppError::from("这套听力绑定不完整，请重新导入四个 Part"));
    }
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
    let _guard = bindings_lock()
        .lock()
        .map_err(|_| AppError::from("音频绑定锁已损坏"))?;
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

/// Recursion guard for user-picked folders. Windows profile directories
/// contain self-referencing junctions (`Application Data` → its parent), and
/// `path.is_dir()` follows them — descending into a reparse loop overflows the
/// stack and kills the whole process mid-exam.
const COLLECT_MAX_DEPTH: usize = 32;

fn collect_audio(dir: &Path, out: &mut Vec<PathBuf>) {
    collect_audio_at(dir, 0, out);
}

fn collect_audio_at(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > COLLECT_MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if crate::safe_path::is_reparse_point(&entry) {
            // A link to a file is harmless — it is hashed and copied like any
            // other source. A link to a directory can loop, so never descend.
            if path.is_file() && is_audio(&path) {
                out.push(path);
            }
            continue;
        }
        if path.is_dir() {
            collect_audio_at(&path, depth + 1, out);
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
    (
        capture_book(stem),
        capture_test(stem).map(|mut test| {
            if let Some(book) = capture_book(stem) {
                if book == 12 && (5..=8).contains(&test) {
                    test -= 4;
                }
            }
            test
        }),
    )
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
            // Single-letter `t` must sit on a token boundary. `part1` / `section1`
            // contain a `t` followed by digits and must not be read as Test 1.
            if key == "t" && idx > 0 {
                let prev = rest.as_bytes()[idx - 1];
                if prev.is_ascii_alphabetic() {
                    rest = &rest[idx + 1..];
                    continue;
                }
            }
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

/// Epoch milliseconds, not ISO — bindings carry this value as-is.
fn now_ms() -> String {
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
            bytes: 0,
            modified_ms: 0,
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
            bytes: 0,
            modified_ms: 0,
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
                bytes: 0,
                modified_ms: 0,
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
    fn capture_test_ignores_t_inside_part() {
        assert_eq!(capture_test("c04_part1"), None);
        assert_eq!(capture_test("c04part2"), None);
        assert_eq!(capture_test("section3"), None);
        assert_eq!(capture_test("c04t1"), Some(1));
        assert_eq!(capture_test("c04-t2"), Some(2));
        assert_eq!(capture_test("test3"), Some(3));
        assert_eq!(parse_book_test("c04_part1"), None);
        assert_eq!(parse_book_test("c04t1_part2"), Some((4, 1)));
        assert_eq!(parse_part("c04_part1"), Some(1));
    }

    #[test]
    fn other_exam_files_skipped_when_target_set() {
        let rows = vec![inspected(5, 1, 1, "s1.mp3", 400_000)];
        let plan = group_inspected(rows, Some("cambridge-4-test-1-listening"), vec![]);
        assert!(plan.exams.is_empty());
        assert!(plan.skipped.iter().any(|s| s.code == "other_exam"));
    }
}
