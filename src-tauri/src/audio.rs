use crate::audio_meta;
use crate::error::AppError;
use crate::paths;
use crate::session;
use crate::ziputil;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const CATALOG_JSON: &str = include_str!("../../schema/audio-catalog.json");
const DURATION_SLACK_MS: i64 = 5000;

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
pub struct AudioImportCandidate {
    pub path: String,
    pub file_name: String,
    pub sha256: String,
    pub duration_ms: u64,
    pub exam_id: Option<String>,
    pub part_index: Option<u32>,
    pub confidence: String,
    pub match_kind: Option<MatchKind>,
    pub needs_confirm: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportPlan {
    pub candidates: Vec<AudioImportCandidate>,
    pub ready: Vec<AudioImportCandidate>,
    pub needs_confirm: Vec<AudioImportCandidate>,
    pub unknown: Vec<AudioImportCandidate>,
    pub errors: Vec<String>,
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

pub fn catalog() -> Result<&'static CatalogFile, AppError> {
    use std::sync::OnceLock;
    static CATALOG: OnceLock<CatalogFile> = OnceLock::new();
    Ok(CATALOG.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(CATALOG_JSON).expect("schema/audio-catalog.json 无效")
    }))
}

fn catalog_by_id() -> Result<BTreeMap<String, CatalogEntry>, AppError> {
    Ok(catalog()?
        .entries
        .iter()
        .cloned()
        .map(|e| (e.exam_id.clone(), e))
        .collect())
}

fn catalog_by_hash() -> Result<BTreeMap<String, CatalogEntry>, AppError> {
    Ok(catalog()?
        .entries
        .iter()
        .cloned()
        .map(|e| (e.sha256.clone(), e))
        .collect())
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
        Some(b) if matches!(b.match_kind, MatchKind::Confirmed) && b.files.is_empty() => {
            "needsReview"
        }
        Some(b) if b.files.is_empty() => "missing",
        Some(_) => "ready",
    }
}

pub fn library_status() -> Result<AudioLibraryStatus, AppError> {
    let cat = catalog()?;
    let bindings = load_bindings()?;
    let mut bound = 0usize;
    let mut review = 0usize;
    for entry in &cat.entries {
        match bindings.bindings.get(&entry.exam_id) {
            Some(b) if !b.files.is_empty() => bound += 1,
            Some(_) => review += 1,
            None => {}
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

pub fn pick_files() -> Result<Vec<String>, AppError> {
    let files = rfd::FileDialog::new()
        .add_filter("音频与 ZIP", &["mp3", "m4a", "wav", "zip"])
        .add_filter("音频", &["mp3", "m4a", "wav"])
        .set_title("选择听力音频")
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

pub fn scan_paths(paths_in: Vec<String>) -> Result<AudioImportPlan, AppError> {
    let mut files = Vec::new();
    let mut errors = Vec::new();
    let staging = paths::ensure_data_layout()?.join("temp").join("audio-import");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    for raw in paths_in {
        let path = PathBuf::from(&raw);
        if !path.exists() {
            errors.push(format!("找不到文件：{raw}"));
            continue;
        }
        if path.is_dir() {
            collect_audio(&path, &mut files, &mut errors);
        } else if is_zip(&path) {
            match ziputil::safe_extract(&path, &staging.join(unique_stem(&path))) {
                Ok(extracted) => {
                    for p in extracted {
                        if is_audio(&p) {
                            files.push(p);
                        }
                    }
                }
                Err(e) => errors.push(format!("{}：{e}", path.display())),
            }
        } else if is_audio(&path) {
            files.push(path);
        } else {
            errors.push(format!("不支持的文件类型：{raw}"));
        }
    }
    files.sort();
    files.dedup();
    let mut candidates = Vec::new();
    for path in files {
        match inspect(&path) {
            Ok(c) => candidates.push(c),
            Err(e) => errors.push(format!("{}：{e}", path.display())),
        }
    }
    assign_matches(&mut candidates)?;
    let mut ready = Vec::new();
    let mut needs_confirm = Vec::new();
    let mut unknown = Vec::new();
    for c in &candidates {
        if c.confidence == "high" {
            ready.push(c.clone());
        } else if c.needs_confirm {
            needs_confirm.push(c.clone());
        } else {
            unknown.push(c.clone());
        }
    }
    Ok(AudioImportPlan {
        candidates,
        ready,
        needs_confirm,
        unknown,
        errors,
    })
}

fn inspect(path: &Path) -> Result<AudioImportCandidate, AppError> {
    let sha = ziputil::sha256_file(path)?;
    let duration = audio_meta::duration_ms(path)?;
    let stem = file_stem(path);
    Ok(AudioImportCandidate {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        sha256: sha,
        duration_ms: duration,
        exam_id: exam_id_from_path(path),
        part_index: parse_part(&stem).or_else(|| parse_part(&path.to_string_lossy())),
        confidence: "none".into(),
        match_kind: None,
        needs_confirm: false,
        reason: String::new(),
    })
}

fn assign_matches(candidates: &mut [AudioImportCandidate]) -> Result<(), AppError> {
    let by_hash = catalog_by_hash()?;
    let by_id = catalog_by_id()?;
    let entries = &catalog()?.entries;
    for c in candidates.iter_mut() {
        if let Some(entry) = by_hash.get(&c.sha256) {
            c.exam_id = Some(entry.exam_id.clone());
            c.confidence = "high".into();
            c.match_kind = Some(MatchKind::CatalogHash);
            c.reason = "与资源清单哈希完全一致".into();
            continue;
        }
        if let Some(entry) = known_hash_binding(&c.sha256)? {
            c.exam_id = Some(entry);
            c.confidence = "high".into();
            c.match_kind = Some(MatchKind::KnownHash);
            c.reason = "与已导入音频哈希一致".into();
            continue;
        }
        let stem = normalize_name(&c.file_name);
        if let Some(entry) = match_filename_duration(&stem, c.duration_ms, entries) {
            c.exam_id = Some(entry.exam_id.clone());
            c.confidence = "high".into();
            c.match_kind = Some(MatchKind::FilenameDuration);
            c.reason = "标准文件名且时长误差在 5 秒内".into();
            continue;
        }
        if let Some(id) = c.exam_id.clone() {
            if let Some(entry) = by_id.get(&id) {
                if duration_close(c.duration_ms, entry.duration_ms) || c.part_index.is_some() {
                    c.confidence = "high".into();
                    c.match_kind = Some(MatchKind::FilenameDuration);
                    c.reason = "路径指向该套题".into();
                    continue;
                }
                c.confidence = "low".into();
                c.needs_confirm = true;
                c.match_kind = Some(MatchKind::Confirmed);
                c.reason = "路径像这套题，但时长偏差超过 5 秒".into();
                continue;
            }
        }
        if let Some((entry, why)) = low_confidence(&stem, c.duration_ms, entries) {
            c.exam_id = Some(entry.exam_id.clone());
            c.confidence = "low".into();
            c.needs_confirm = true;
            c.match_kind = Some(MatchKind::Confirmed);
            c.reason = why;
            continue;
        }
        c.reason = "无法自动匹配，需要手动校准或确认".into();
    }
    Ok(())
}

fn known_hash_binding(sha: &str) -> Result<Option<String>, AppError> {
    let file = load_bindings()?;
    Ok(file.bindings.iter().find_map(|(id, b)| {
        b.files.iter().any(|f| f.sha256 == sha).then(|| id.clone())
    }))
}

fn match_filename_duration<'a>(
    stem: &str,
    duration_ms: u64,
    entries: &'a [CatalogEntry],
) -> Option<&'a CatalogEntry> {
    entries.iter().find(|e| {
        filename_matches(stem, e) && duration_close(duration_ms, e.duration_ms)
    })
}

fn low_confidence<'a>(
    stem: &str,
    duration_ms: u64,
    entries: &'a [CatalogEntry],
) -> Option<(&'a CatalogEntry, String)> {
    if let Some(e) = entries.iter().find(|e| filename_matches(stem, e)) {
        return Some((e, "文件名像这套题，但时长偏差超过 5 秒".into()));
    }
    let hits: Vec<_> = entries
        .iter()
        .filter(|e| duration_close(duration_ms, e.duration_ms))
        .collect();
    if hits.len() == 1 {
        return Some((hits[0], "时长接近唯一一套题，请确认".into()));
    }
    None
}

fn filename_matches(stem: &str, entry: &CatalogEntry) -> bool {
    let std = normalize_name(&entry.standard_name);
    if stem == std || stem.contains(&std) {
        return true;
    }
    let compact = format!("c{:02}t{}", entry.book, entry.test);
    if stem.contains(&compact) {
        return true;
    }
    let words = format!("cambridge{}test{}", entry.book, entry.test);
    if stem.contains(&words) {
        return true;
    }
    parse_book_test(stem) == Some((entry.book, entry.test))
}

fn duration_close(actual: u64, expected: u64) -> bool {
    (actual as i64 - expected as i64).abs() <= DURATION_SLACK_MS
}

pub fn confirm_import(candidates: Vec<AudioImportCandidate>) -> Result<Vec<AudioBinding>, AppError> {
    let mut bindings = load_bindings()?;
    let by_id = catalog_by_id()?;
    let mut written = Vec::new();
    let mut grouped: BTreeMap<String, Vec<AudioImportCandidate>> = BTreeMap::new();
    for c in candidates {
        if let Some(id) = &c.exam_id {
            grouped.entry(id.clone()).or_default().push(c);
        }
    }
    for (exam_id, mut rows) in grouped {
        rows.sort_by_key(|c| c.part_index.unwrap_or(0));
        let catalog_entry = by_id.get(&exam_id);
        let parts = rows.iter().filter(|c| c.part_index.is_some()).count();
        let mode = if parts >= 4 && rows.len() >= 4 {
            BindingMode::Parts
        } else {
            BindingMode::FullTrack
        };
        let chosen: Vec<AudioImportCandidate> = if mode == BindingMode::Parts {
            (1..=4)
                .filter_map(|i| {
                    rows.iter()
                        .find(|c| c.part_index == Some(i))
                        .cloned()
                })
                .collect()
        } else {
            vec![rows
                .iter()
                .find(|c| c.part_index.is_none())
                .cloned()
                .or_else(|| rows.first().cloned())
                .ok_or_else(|| AppError::from(format!("{exam_id} 没有可导入文件")))?]
        };
        if mode == BindingMode::Parts && chosen.len() != 4 {
            return Err(AppError::from(format!(
                "{exam_id} 需要四个 Part 文件，当前匹配到 {}",
                chosen.len()
            )));
        }
        let mut files = Vec::new();
        for row in &chosen {
            files.push(ingest_file(Path::new(&row.path), &row.file_name, &row.sha256, row.duration_ms)?);
        }
        let match_kind = chosen
            .first()
            .and_then(|c| c.match_kind.clone())
            .unwrap_or(MatchKind::Confirmed);
        let part_starts = if mode == BindingMode::FullTrack {
            catalog_entry
                .map(|e| e.part_starts_ms.clone())
                .unwrap_or_else(|| vec![0, 0, 0, 0])
        } else {
            let mut acc = 0u64;
            let mut starts = Vec::new();
            for f in &files {
                starts.push(acc);
                acc += f.duration_ms;
            }
            starts
        };
        drop_unref(&bindings, &exam_id, &files)?;
        let binding = AudioBinding {
            exam_id: exam_id.clone(),
            mode,
            files,
            part_starts_ms: part_starts,
            match_kind,
            updated_at: now_iso(),
        };
        bindings.bindings.insert(exam_id, binding.clone());
        written.push(binding);
    }
    save_bindings(&bindings)?;
    Ok(written)
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
        drop_unref(
            &BindingsFile {
                schema_version: 1,
                bindings: file.bindings.clone(),
            },
            exam_id,
            &[],
        )?;
        for f in old.files {
            let still = file.bindings.values().any(|b| b.files.iter().any(|x| x.sha256 == f.sha256));
            if !still {
                let _ = fs::remove_file(paths::audio_files_dir()?.join(&f.managed_name));
            }
        }
    }
    save_bindings(&file)
}

pub fn set_manual_parts(exam_id: &str, starts: Vec<u64>, source_path: String) -> Result<AudioBinding, AppError> {
    if starts.len() != 4 {
        return Err(AppError::from("需要标记 Part 1 到 Part 4 四个起点"));
    }
    let path = PathBuf::from(&source_path);
    let sha = ziputil::sha256_file(&path)?;
    let duration = audio_meta::duration_ms(&path)?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let managed = ingest_file(&path, &name, &sha, duration)?;
    let mut file = load_bindings()?;
    drop_unref(&file, exam_id, std::slice::from_ref(&managed))?;
    let binding = AudioBinding {
        exam_id: exam_id.to_string(),
        mode: BindingMode::FullTrack,
        files: vec![managed],
        part_starts_ms: starts,
        match_kind: MatchKind::Manual,
        updated_at: now_iso(),
    };
    file.bindings.insert(exam_id.to_string(), binding.clone());
    save_bindings(&file)?;
    Ok(binding)
}

pub fn playback_source(exam_id: &str) -> Result<PlaybackSource, AppError> {
    let bindings = load_bindings()?;
    let binding = bindings
        .bindings
        .get(exam_id)
        .ok_or_else(|| AppError::from("这套听力还没有绑定音频"))?;
    if binding.files.is_empty() {
        return Err(AppError::from("这套听力还没有绑定音频"));
    }
    let dir = paths::audio_files_dir()?;
    let mut tracks = Vec::new();
    match binding.mode {
        BindingMode::FullTrack => {
            let f = &binding.files[0];
            let path = dir.join(&f.managed_name);
            if !path.is_file() {
                return Err(AppError::from("绑定的音频文件丢失，请重新添加"));
            }
            tracks.push(PlaybackTrack {
                path: path.display().to_string(),
                start_ms: 0,
                duration_ms: f.duration_ms,
            });
        }
        BindingMode::Parts => {
            if binding.files.len() != 4 {
                return Err(AppError::from("分段绑定不完整，请重新添加四个 Part"));
            }
            for f in &binding.files {
                let path = dir.join(&f.managed_name);
                if !path.is_file() {
                    return Err(AppError::from("绑定的音频文件丢失，请重新添加"));
                }
                tracks.push(PlaybackTrack {
                    path: path.display().to_string(),
                    start_ms: 0,
                    duration_ms: f.duration_ms,
                });
            }
        }
    }
    Ok(PlaybackSource {
        exam_id: exam_id.to_string(),
        mode: binding.mode.clone(),
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

pub fn waveform(path: String) -> Result<ValueWaveform, AppError> {
    let (duration_ms, peaks) = audio_meta::waveform_peaks(Path::new(&path), 2000)?;
    Ok(ValueWaveform { duration_ms, peaks })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueWaveform {
    pub duration_ms: u64,
    pub peaks: Vec<f32>,
}

fn collect_audio(dir: &Path, out: &mut Vec<PathBuf>, errors: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            errors.push(format!("{}：{e}", dir.display()));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio(&path, out, errors);
        } else if is_audio(&path) {
            out.push(path);
        }
    }
}

fn is_audio(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
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

fn exam_id_from_path(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    let (book, test) = parse_book_test(&text)?;
    Some(format!("cambridge-{book}-test-{test}-listening"))
}

pub fn parse_book_test(stem: &str) -> Option<(u32, u32)> {
    let book = capture_book(stem)?;
    let mut test = capture_test(stem)?;
    if book == 12 && (5..=8).contains(&test) {
        test -= 4;
    }
    if (4..=20).contains(&book) && (1..=4).contains(&test) {
        Some((book, test))
    } else {
        None
    }
}

fn capture_book(s: &str) -> Option<u32> {
    if let Some(idx) = s.find('剑') {
        let rest = &s[idx + '剑'.len_utf8()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            if (4..=21).contains(&n) {
                return Some(n);
            }
        }
    }
    let n = normalize_name(s);
    if let Some(rest) = n.strip_prefix('c') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 1 && digits.len() <= 2 {
            if let Ok(book) = digits.parse::<u32>() {
                if (4..=21).contains(&book) {
                    return Some(book);
                }
            }
        }
    }
    if let Some(idx) = n.find("cambridge") {
        let rest = &n[idx + 9..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(book) = digits.parse::<u32>() {
            if (4..=21).contains(&book) {
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
    use super::{duration_close, filename_matches, parse_book_test, parse_part, CatalogEntry};

    fn entry(book: u32, test: u32) -> CatalogEntry {
        CatalogEntry {
            exam_id: format!("cambridge-{book}-test-{test}-listening"),
            book,
            test,
            standard_name: format!("c{book:02}-t{test}.mp3"),
            sha256: "ab".repeat(32),
            bytes: 10,
            duration_ms: 1_574_000,
            part_starts_ms: vec![0, 1, 2, 3],
            part_durations_ms: vec![1, 1, 1, 1],
        }
    }

    #[test]
    fn standard_filename_matches() {
        let e = entry(4, 1);
        assert!(filename_matches("c04t1", &e));
        assert!(filename_matches("c04-t1.mp3", &e));
        assert!(filename_matches("cambridge-4-test-1-listening", &e));
        assert!(!filename_matches("c05t1", &e));
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
    fn five_second_window() {
        assert!(duration_close(1_574_000, 1_578_000));
        assert!(!duration_close(1_574_000, 1_590_000));
    }
}
