use crate::audio;
use crate::clock::{epoch_day_now, iso_epoch_day, now_iso};
use crate::content;
use crate::error::AppError;
use crate::library;
use crate::migrate;
use crate::paths;
use crate::safe_path;
use crate::scoring;
use crate::session;
use crate::store;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Run blocking file work off the async runtime's worker threads. `async fn`
/// commands already avoid the UI thread, but they still share the runtime with
/// small commands like `save_session` — a minutes-long audio scan or migration
/// must not park an executor thread while autosave waits.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::from(format!("后台任务失败：{e}")))?
}

#[tauri::command]
pub async fn bootstrap(app: AppHandle) -> Result<Value, AppError> {
    blocking(move || bootstrap_inner(&app)).await
}

/// Bootstraps can overlap now that they run on blocking workers (two reload
/// triggers in quick succession). They share `.migrate-staging` and the
/// content `.staging-{version}` directories, so a second bootstrap must wait
/// rather than interleave file copies. Poisoning is recovered — the guard
/// protects no data of its own.
fn bootstrap_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn bootstrap_inner(app: &AppHandle) -> Result<Value, AppError> {
    let _bootstrap_guard = bootstrap_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let migration = migrate::run(|progress| {
        let _ = app.emit("bootstrap-progress", progress);
    });
    let mut probe = paths::probe_writable();
    if probe.ok {
        // Staging from a scan that was never confirmed outlives the in-memory
        // import plan only until reboot — the plan is gone, so the extracted
        // files can never be confirmed. Drop them instead of letting up to
        // 2 GiB sit under data/temp/audio-import.
        if let Ok(root) = paths::ensure_data_layout() {
            // The sweep races a scan in progress: the wizard keeps extracted
            // ZIP parts under this staging dir until confirm. Wait for the
            // scan lock instead of deleting files out from under it.
            if let Ok(_scan_guard) = audio::scan_lock().lock() {
                let _ = fs::remove_dir_all(root.join("temp").join("audio-import"));
            }
        }
        match content::ensure() {
            Ok(status) => {
                if probe.warning.is_none() {
                    probe.warning = status.warning;
                }
            }
            Err(err) => {
                probe.ok = false;
                probe.error = Some(err.to_string());
            }
        }
    }
    if probe.warning.is_none() {
        probe.warning = migration.error.clone();
    }
    if !probe.ok {
        return Ok(serde_json::json!({
            "probe": probe,
            "exams": [],
            "sessions": [],
            "profile": null,
            "audio": null,
            "migration": migration,
        }));
    }
    let mut warnings: Vec<String> = Vec::new();
    if let Some(w) = &probe.warning {
        if !w.is_empty() {
            warnings.push(w.clone());
        }
    }
    let exams = match library::list_exams() {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("题库读取失败：{e}"));
            Vec::new()
        }
    };
    let listed = match session::list_sessions_with_diagnostics() {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("会话列表读取失败：{e}"));
            session::SessionList::default()
        }
    };
    if !listed.quarantined.is_empty() {
        warnings.push(format!(
            "已隔离 {} 个损坏的会话文件，可在数据目录 sessions/quarantine 查看",
            listed.quarantined.len()
        ));
    }
    let quarantined_records = store::quarantined_count();
    if quarantined_records > 0 {
        warnings.push(format!(
            "已隔离 {quarantined_records} 个损坏的学习记录文件（错题/生词/计划/反馈），可在数据目录对应类别的 quarantine 子目录查看"
        ));
    }
    if migration.conflicts > 0 {
        warnings.push(format!(
            "迁移时有 {} 个文件与现有数据重名，已保留现有版本；旧副本仍在原目录的 .migrated.bak 备份中",
            migration.conflicts
        ));
    }
    let profile = match load_profile_migrated() {
        Ok(v) => v,
        Err(e) => {
            warnings.push(e.to_string());
            None
        }
    };
    let audio_status = match audio::library_status() {
        Ok(v) => Some(v),
        Err(e) => {
            warnings.push(format!("音频绑定读取失败：{e}"));
            None
        }
    };
    if probe.warning.is_none() && !warnings.is_empty() {
        probe.warning = Some(warnings.join("；"));
    }
    Ok(serde_json::json!({
        "probe": probe,
        "exams": exams,
        "sessions": listed.summaries,
        "profile": profile,
        "audio": audio_status,
        "migration": migration,
        "diagnostics": {
            "warnings": warnings,
            "sessionsQuarantined": listed.quarantined,
        },
    }))
}

fn valid_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let Ok(y) = s[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(m) = s[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(d) = s[8..10].parse::<u32>() else {
        return false;
    };
    if !(2000..=2100).contains(&y) || !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let max = match m {
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    d <= max
}

fn normalize_profile(value: &mut Value) -> Result<(), AppError> {
    let obj = value
        .as_object_mut()
        .ok_or_else(|| AppError::from("配置必须是 JSON 对象"))?;
    if let Some(theme) = obj.get("theme") {
        if !theme.is_null() {
            let s = theme.as_str().unwrap_or("");
            if !matches!(s, "light" | "dark") {
                return Err(AppError::from("主题只能是 light 或 dark"));
            }
        }
    }
    match obj.get("practiceScheme").and_then(Value::as_str) {
        Some("follow_shell") | Some("light") | Some("dark") => {}
        Some(_) => return Err(AppError::from("练习外观只能是 follow_shell、light 或 dark")),
        None => {
            obj.insert(
                "practiceScheme".into(),
                serde_json::Value::String("follow_shell".into()),
            );
        }
    }
    if let Some(band) = obj.get("targetBand") {
        if !band.is_null() {
            let ok = band
                .as_f64()
                .map(|b| (4.0..=9.0).contains(&b))
                .unwrap_or(false);
            if !ok {
                return Err(AppError::from("目标分数必须是 4.0–9.0 的数字"));
            }
        }
    }
    if let Some(date) = obj.get("examDate").cloned() {
        if let Some(s) = date.as_str() {
            if !s.is_empty() && !valid_ymd(s) {
                return Err(AppError::from("考试日期必须是 YYYY-MM-DD"));
            }
        } else if !date.is_null() {
            return Err(AppError::from("考试日期必须是 YYYY-MM-DD"));
        }
    }
    Ok(())
}

fn load_profile_migrated() -> Result<Option<Value>, AppError> {
    let path = paths::profile_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(&path).map_err(|e| AppError::from(format!("无法读取配置：{e}")))?;
    let mut value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let dir = path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("quarantine");
            let _ = session::quarantine_file_to(&path, &dir, &format!("profile 损坏：{e}"));
            return Err(AppError::from(
                "配置文件已损坏，已隔离。请重新设置主题与考试日期。",
            ));
        }
    };
    let missing = value.get("practiceScheme").is_none();
    normalize_profile(&mut value)?;
    if missing {
        // Serialise the repair write against a concurrent save_profile —
        // both share the same profile.json.tmp scratch file.
        if let Ok(_guard) = session::write_guard() {
            let _ = session::atomic_write(&path, serde_json::to_vec_pretty(&value)?.as_slice());
        }
    }
    Ok(Some(value))
}

// Session commands run on the async runtime: they are small writes that must
// not queue behind main-thread work (audio scans, migration) while autosave is
// trying to land answers on disk.
#[tauri::command]
pub async fn save_session(json: String) -> Result<String, AppError> {
    session::save_session_json(&json)
}

#[tauri::command]
pub async fn load_session(id: String) -> Result<String, AppError> {
    session::load_session_json(&id)
}

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<Value>, AppError> {
    session::list_session_summaries()
}

#[tauri::command]
pub async fn discard_session(id: String) -> Result<(), AppError> {
    session::discard_session(&id)
}

#[tauri::command]
pub async fn archive_session(id: String) -> Result<(), AppError> {
    session::archive_session(&id)
}

#[tauri::command]
pub async fn load_exam(id: String) -> Result<Value, AppError> {
    library::load_exam(&id)
}

#[tauri::command]
pub async fn import_exam(json: String) -> Result<Value, AppError> {
    library::import_exam_json(&json)
}

#[tauri::command]
pub async fn resolve_asset(rel: String) -> Result<String, AppError> {
    library::resolve_asset(&rel)
}

#[tauri::command]
pub async fn score_exam(exam_id: String, answers_json: String) -> Result<Value, AppError> {
    safe_path::check_json_arg(&answers_json, "答案数据")?;
    let exam = library::load_exam(&exam_id)?;
    let answers: Value = serde_json::from_str(&answers_json)?;
    let report = scoring::score_exam(&exam, &answers).map_err(AppError::from)?;
    Ok(serde_json::to_value(report)?)
}

#[tauri::command]
pub async fn save_profile(json: String) -> Result<(), AppError> {
    safe_path::check_json_arg(&json, "个人资料")?;
    let mut v: Value = serde_json::from_str(&json)?;
    normalize_profile(&mut v)?;
    let path = paths::profile_path()?;
    // Async commands can overlap: two rapid settings changes would otherwise
    // interleave on the same profile.json.tmp scratch file.
    let _guard = session::write_guard()?;
    session::atomic_write(&path, serde_json::to_vec_pretty(&v)?.as_slice())?;
    Ok(())
}

/// Build analytics strictly from submitted local sessions and the current
/// answer keys. No placeholder or estimated Speaking values are generated.
///
/// `range_days` is honoured: sessions updated more than that many days ago are
/// excluded entirely. `range_days == 0` means "all time".
///
/// Module averages are **estimated bands** from `schema/band-conversion.json`,
/// never `raw / total * 9`. Sessions whose raw score falls below the published
/// table contribute to `moduleCounts` but not to the averages, and are counted
/// in `unbandedCounts` so the UI can say so instead of silently dropping them.
#[tauri::command]
pub async fn analytics_report(range_days: u32) -> Result<Value, AppError> {
    blocking(move || analytics_report_inner(range_days)).await
}

fn analytics_report_inner(range_days: u32) -> Result<Value, AppError> {
    use std::collections::BTreeMap;
    let dir = crate::paths::sessions_dir()?;
    // The report is a pure function of the submitted sessions, the answer keys
    // and today's date — stat-only fingerprints let repeat range switches skip
    // the whole rescan without any stale reads.
    let fingerprint = format!(
        "{}|{}|{}",
        epoch_day_now(),
        sessions_fingerprint(&dir),
        library::exam_tree_fingerprint()
    );
    if let Ok(cache) = analytics_cache().lock() {
        if cache.fingerprint == fingerprint {
            if let Some(report) = cache.reports.get(&range_days) {
                return Ok(report.clone());
            }
        }
    }
    let cutoff_day = if range_days == 0 {
        None
    } else {
        // "过去 N 天" 含今天在内是 N 个自然日：cutoff 要退 N-1 天而不是 N 天。
        Some(epoch_day_now().saturating_sub(i64::from(range_days.saturating_sub(1))))
    };
    let mut module_scores: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut module_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut unbanded_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut trend: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut type_totals: BTreeMap<(String, String), (u32, u32)> = BTreeMap::new();
    let mut time_trend: Vec<Value> = Vec::new();
    if dir.exists() {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(session) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if session.get("status").and_then(Value::as_str) != Some("submitted") {
                continue;
            }
            let module = session
                .get("module")
                .and_then(Value::as_str)
                .unwrap_or("writing")
                .to_string();
            let updated = session
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(cutoff) = cutoff_day {
                // Undated sessions are kept: dropping them would silently
                // shrink the corpus the user is reasoning about.
                if let Some(day) = iso_epoch_day(&updated) {
                    if day < cutoff {
                        continue;
                    }
                }
            }
            if module == "writing" {
                *module_counts.entry(module).or_default() += 1;
                continue;
            }
            let Some(exam_id) = session.get("examId").and_then(Value::as_str) else {
                continue;
            };
            let Ok(exam) = crate::library::load_exam(exam_id) else {
                continue;
            };
            let answers = session
                .get("answers")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let Ok(score) = crate::scoring::score_exam(&exam, &answers) else {
                continue;
            };
            let band = crate::band::raw_to_band(&module, score.raw_correct);
            match band {
                Some(value) => module_scores.entry(module.clone()).or_default().push(value),
                None => *unbanded_counts.entry(module.clone()).or_default() += 1,
            }
            *module_counts.entry(module.clone()).or_default() += 1;
            trend
                .entry(module.clone())
                .or_default()
                .push(serde_json::json!({
                    "date": updated,
                    "band": band,
                    "rawCorrect": score.raw_correct,
                    "rawTotal": score.raw_total,
                }));
            time_trend.push(serde_json::json!({
                "date": updated,
                "module": module.clone(),
                "band": band,
                "rawCorrect": score.raw_correct,
                "rawTotal": score.raw_total,
            }));
            for item in score.questions {
                let key = (module.clone(), item.question_type.clone());
                let totals = type_totals.entry(key).or_default();
                totals.1 += 1;
                if item.correct {
                    totals.0 += 1;
                }
            }
        }
    }
    let mut averages = serde_json::Map::new();
    let mut module_avg_sum = 0.0;
    let mut module_avg_count = 0usize;
    for (module, scores) in &module_scores {
        if scores.is_empty() {
            continue;
        }
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        module_avg_sum += avg;
        module_avg_count += 1;
        averages.insert(module.clone(), serde_json::json!(avg));
    }
    let accuracy = type_totals.into_iter().map(|((module, question_type), (correct, total))| {
        serde_json::json!({ "module": module, "questionType": question_type, "correct": correct, "total": total, "accuracy": if total == 0 { 0.0 } else { correct as f64 / total as f64 } })
    }).collect::<Vec<_>>();
    let report = serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "rangeDays": range_days,
        "overallAverage": if module_avg_count == 0 { Value::Null } else { serde_json::json!(module_avg_sum / module_avg_count as f64) },
        "moduleAverages": averages,
        "moduleCounts": module_counts,
        "unbandedCounts": unbanded_counts,
        "scoreTrend": trend,
        "questionTypeAccuracy": accuracy,
        "timeTrend": time_trend,
        "speakingEnabled": false,
    });
    if let Ok(mut cache) = analytics_cache().lock() {
        // A fingerprint change invalidates every cached range at once.
        if cache.fingerprint != fingerprint {
            cache.reports.clear();
            cache.fingerprint = fingerprint;
        }
        cache.reports.insert(range_days, report.clone());
    }
    Ok(report)
}

/// Stat-only fingerprint of the sessions dir: any write, delete or quarantine
/// move changes the (name, len, mtime) triples and re-runs the report.
fn sessions_fingerprint(dir: &Path) -> String {
    let mut rows = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            rows.push(format!("{}:{}:{mtime}", path.display(), meta.len()));
        }
    }
    rows.sort();
    crate::ziputil::sha256_bytes(rows.join("\n").as_bytes())
}

struct AnalyticsCache {
    fingerprint: String,
    reports: HashMap<u32, Value>,
}

fn analytics_cache() -> &'static Mutex<AnalyticsCache> {
    static CACHE: OnceLock<Mutex<AnalyticsCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(AnalyticsCache {
            fingerprint: String::new(),
            reports: HashMap::new(),
        })
    })
}

/// The audioscript for a listening paper, when one was extracted.
///
/// Transcripts live beside the exams in `fixtures/transcripts` rather than
/// inside the exam JSON: they are large, only the intensive-listening view
/// needs them, and loading an exam for a mock should not pay for them.
#[tauri::command]
pub async fn load_transcript(exam_id: String) -> Result<Value, AppError> {
    if !safe_path::valid_id(&exam_id) {
        return Err(AppError::from("非法的试卷 id"));
    }
    for root in [
        paths::fixtures_root()?.join("transcripts"),
        paths::ensure_data_layout()?.join("transcripts"),
    ] {
        let path = root.join(format!("{exam_id}.json"));
        if path.exists() {
            let text = fs::read_to_string(&path)?;
            return Ok(serde_json::from_str(&text)?);
        }
    }
    Ok(Value::Null)
}

#[tauri::command]
pub async fn audio_pick_files(window: tauri::Window) -> Result<Vec<String>, AppError> {
    blocking(move || audio::pick_files(&window)).await
}

#[tauri::command]
pub async fn audio_pick_folders(window: tauri::Window) -> Result<Vec<String>, AppError> {
    blocking(move || audio::pick_folders(&window)).await
}

#[tauri::command]
pub async fn audio_scan_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_exam_id: Option<String>,
) -> Result<Value, AppError> {
    let plan = blocking(move || {
        audio::scan_paths(paths, target_exam_id, |p| {
            let _ = app.emit("audio-import-progress", &p);
        })
    })
    .await?;
    Ok(serde_json::to_value(plan)?)
}

#[tauri::command]
pub async fn audio_confirm_import(
    app: AppHandle,
    exam_ids: Vec<String>,
) -> Result<Value, AppError> {
    let value = serde_json::to_value(
        blocking(move || {
            audio::confirm_import(exam_ids, |p| {
                let _ = app.emit("audio-import-progress", &p);
            })
        })
        .await?,
    )?;
    library::invalidate();
    Ok(value)
}

// Deliberately stays sync: it only flips an AtomicBool and must land the
// moment it is invoked, even while a scan/import is parked on the pool.
#[tauri::command]
pub fn audio_cancel_import() -> Result<(), AppError> {
    audio::request_cancel();
    Ok(())
}

#[tauri::command]
pub async fn audio_playback_source(exam_id: String) -> Result<Value, AppError> {
    Ok(serde_json::to_value(audio::playback_source(&exam_id)?)?)
}

#[tauri::command]
pub async fn audio_remove_binding(exam_id: String) -> Result<(), AppError> {
    audio::remove_binding(&exam_id)?;
    library::invalidate();
    Ok(())
}

#[tauri::command]
pub async fn audio_repair_bindings() -> Result<Value, AppError> {
    let value = serde_json::to_value(blocking(audio::repair_bindings).await?)?;
    library::invalidate();
    Ok(value)
}

#[tauri::command]
pub async fn audio_open_guide() -> Result<String, AppError> {
    audio::open_guide()
}

#[tauri::command]
pub async fn open_data_dir() -> Result<(), AppError> {
    // Data-recovery affordance: quarantined sessions/records and .bak files
    // live under the data root, so the user needs a way to reach it.
    let root = paths::data_root()?;
    open::that_detached(&root).map_err(|e| AppError::from(format!("无法打开数据目录：{e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn ymd_gate() {
        assert!(super::valid_ymd("2026-08-26"));
        assert!(!super::valid_ymd("2026-13-01"));
        assert!(!super::valid_ymd("26-08-26"));
        assert!(!super::valid_ymd("2026-02-30"));
    }
}
