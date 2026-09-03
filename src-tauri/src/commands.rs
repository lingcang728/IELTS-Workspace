use crate::audio;
use crate::content;
use crate::error::AppError;
use crate::library;
use crate::migrate;
use crate::paths;
use crate::safe_path;
use crate::scoring;
use crate::session;
use serde_json::Value;
use std::fs;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn bootstrap() -> Result<Value, AppError> {
    let migration = migrate::run();
    let mut probe = paths::probe_writable();
    if probe.ok {
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
    let Ok(y) = s[0..4].parse::<i32>() else { return false };
    let Ok(m) = s[5..7].parse::<u32>() else { return false };
    let Ok(d) = s[8..10].parse::<u32>() else { return false };
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
    let text = fs::read_to_string(&path)
        .map_err(|e| AppError::from(format!("无法读取配置：{e}")))?;
    let mut value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let dir = path.parent().unwrap_or(std::path::Path::new(".")).join("quarantine");
            let _ = session::quarantine_file_to(&path, &dir, &format!("profile 损坏：{e}"));
            return Err(AppError::from("配置文件已损坏，已隔离。请重新设置主题与考试日期。"));
        }
    };
    let missing = value.get("practiceScheme").is_none();
    normalize_profile(&mut value)?;
    if missing {
        let _ = session::atomic_write(&path, serde_json::to_vec_pretty(&value)?.as_slice());
    }
    Ok(Some(value))
}

#[tauri::command]
pub fn save_session(json: String) -> Result<String, AppError> {
    session::save_session_json(&json)
}

#[tauri::command]
pub fn load_session(id: String) -> Result<String, AppError> {
    session::load_session_json(&id)
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<Value>, AppError> {
    session::list_session_summaries()
}

#[tauri::command]
pub fn discard_session(id: String) -> Result<(), AppError> {
    session::discard_session(&id)
}

#[tauri::command]
pub fn archive_session(id: String) -> Result<(), AppError> {
    session::archive_session(&id)
}

#[tauri::command]
pub fn load_exam(id: String) -> Result<Value, AppError> {
    library::load_exam(&id)
}

#[tauri::command]
pub fn import_exam(json: String) -> Result<Value, AppError> {
    library::import_exam_json(&json)
}

#[tauri::command]
pub fn resolve_asset(rel: String) -> Result<String, AppError> {
    library::resolve_asset(&rel)
}

#[tauri::command]
pub fn score_exam(exam_id: String, answers_json: String) -> Result<Value, AppError> {
    let exam = library::load_exam(&exam_id)?;
    let answers: Value = serde_json::from_str(&answers_json)?;
    let report = scoring::score_exam(&exam, &answers).map_err(AppError::from)?;
    Ok(serde_json::to_value(report)?)
}

#[tauri::command]
pub fn save_profile(json: String) -> Result<(), AppError> {
    let mut v: Value = serde_json::from_str(&json)?;
    normalize_profile(&mut v)?;
    let path = paths::profile_path()?;
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
pub fn analytics_report(range_days: u32) -> Result<Value, AppError> {
    use std::collections::BTreeMap;
    let cutoff_day = if range_days == 0 {
        None
    } else {
        Some(today_epoch_day().saturating_sub(i64::from(range_days)))
    };
    let mut module_scores: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut module_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut unbanded_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut trend: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut type_totals: BTreeMap<(String, String), (u32, u32)> = BTreeMap::new();
    let mut time_trend: Vec<Value> = Vec::new();
    let dir = crate::paths::sessions_dir()?;
    if dir.exists() {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(session) = serde_json::from_str::<Value>(&raw) else { continue };
            if session.get("status").and_then(Value::as_str) != Some("submitted") { continue; }
            let module = session.get("module").and_then(Value::as_str).unwrap_or("writing").to_string();
            let updated = session.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(cutoff) = cutoff_day {
                // Undated sessions are kept: dropping them would silently
                // shrink the corpus the user is reasoning about.
                if let Some(day) = iso_epoch_day(&updated) {
                    if day < cutoff { continue; }
                }
            }
            if module == "writing" {
                *module_counts.entry(module).or_default() += 1;
                continue;
            }
            let Some(exam_id) = session.get("examId").and_then(Value::as_str) else { continue };
            let Ok(exam) = crate::library::load_exam(exam_id) else { continue };
            let answers = session.get("answers").cloned().unwrap_or_else(|| serde_json::json!({}));
            let Ok(score) = crate::scoring::score_exam(&exam, &answers) else { continue };
            let band = crate::band::raw_to_band(&module, score.raw_correct);
            match band {
                Some(value) => module_scores.entry(module.clone()).or_default().push(value),
                None => *unbanded_counts.entry(module.clone()).or_default() += 1,
            }
            *module_counts.entry(module.clone()).or_default() += 1;
            trend.entry(module.clone()).or_default().push(serde_json::json!({
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
                if item.correct { totals.0 += 1; }
            }
        }
    }
    let mut averages = serde_json::Map::new();
    let mut module_avg_sum = 0.0;
    let mut module_avg_count = 0usize;
    for (module, scores) in &module_scores {
        if scores.is_empty() { continue; }
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        module_avg_sum += avg;
        module_avg_count += 1;
        averages.insert(module.clone(), serde_json::json!(avg));
    }
    let accuracy = type_totals.into_iter().map(|((module, question_type), (correct, total))| {
        serde_json::json!({ "module": module, "questionType": question_type, "correct": correct, "total": total, "accuracy": if total == 0 { 0.0 } else { correct as f64 / total as f64 } })
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": chrono_like_now(),
        "rangeDays": range_days,
        "overallAverage": if module_avg_count == 0 { Value::Null } else { serde_json::json!(module_avg_sum / module_avg_count as f64) },
        "moduleAverages": averages,
        "moduleCounts": module_counts,
        "unbandedCounts": unbanded_counts,
        "scoreTrend": trend,
        "questionTypeAccuracy": accuracy,
        "timeTrend": time_trend,
        "speakingEnabled": false,
    }))
}

/// Days since 1970-01-01 for the `YYYY-MM-DD` prefix of an ISO 8601 string.
fn iso_epoch_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' { return None; }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) { return None; }
    Some(days_from_civil(year, month, day))
}

/// Howard Hinnant's `days_from_civil`; proleptic Gregorian, no dependencies.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn today_epoch_day() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or_default()
}

fn chrono_like_now() -> String {
    // Keep the command dependency-free; milliseconds are enough for report
    // freshness and the frontend already formats user-facing dates.
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    millis.to_string()
}


/// The audioscript for a listening paper, when one was extracted.
///
/// Transcripts live beside the exams in `fixtures/transcripts` rather than
/// inside the exam JSON: they are large, only the intensive-listening view
/// needs them, and loading an exam for a mock should not pay for them.
#[tauri::command]
pub fn load_transcript(exam_id: String) -> Result<Value, AppError> {
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
pub fn audio_library_status() -> Result<Value, AppError> {
    Ok(serde_json::to_value(audio::library_status()?)?)
}

#[tauri::command]
pub fn audio_catalog() -> Result<Value, AppError> {
    Ok(serde_json::to_value(audio::catalog()?)?)
}

#[tauri::command]
pub fn audio_pick_files() -> Result<Vec<String>, AppError> {
    audio::pick_files()
}

#[tauri::command]
pub fn audio_pick_folders() -> Result<Vec<String>, AppError> {
    audio::pick_folders()
}

#[tauri::command]
pub fn audio_scan_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_exam_id: Option<String>,
) -> Result<Value, AppError> {
    let plan = audio::scan_paths(paths, target_exam_id, |p| {
        let _ = app.emit("audio-import-progress", &p);
    })?;
    Ok(serde_json::to_value(plan)?)
}

#[tauri::command]
pub fn audio_confirm_import(app: AppHandle, exam_ids: Vec<String>) -> Result<Value, AppError> {
    let value = serde_json::to_value(audio::confirm_import(exam_ids, |p| {
        let _ = app.emit("audio-import-progress", &p);
    })?)?;
    library::invalidate();
    Ok(value)
}

#[tauri::command]
pub fn audio_cancel_import() -> Result<(), AppError> {
    audio::request_cancel();
    Ok(())
}

#[tauri::command]
pub fn audio_playback_source(exam_id: String) -> Result<Value, AppError> {
    Ok(serde_json::to_value(audio::playback_source(&exam_id)?)?)
}

#[tauri::command]
pub fn audio_remove_binding(exam_id: String) -> Result<(), AppError> {
    audio::remove_binding(&exam_id)?;
    library::invalidate();
    Ok(())
}

#[tauri::command]
pub fn audio_repair_bindings() -> Result<Value, AppError> {
    let value = serde_json::to_value(audio::repair_bindings()?)?;
    library::invalidate();
    Ok(value)
}

#[tauri::command]
pub fn audio_open_guide() -> Result<String, AppError> {
    audio::open_guide()
}

#[tauri::command]
pub fn audio_bindings() -> Result<Value, AppError> {
    Ok(serde_json::to_value(audio::load_bindings()?)?)
}

#[cfg(test)]
mod tests {
    use super::{days_from_civil, iso_epoch_day};

    #[test]
    fn epoch_day_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 8, 24), 20_689);
        assert_eq!(iso_epoch_day("2026-08-24T10:12:00Z"), Some(20_689));
        assert_eq!(
            iso_epoch_day("2026-08-25T00:00:00Z").unwrap() - iso_epoch_day("2026-08-24T23:59:00Z").unwrap(),
            1
        );
    }

    #[test]
    fn epoch_day_rejects_junk() {
        assert_eq!(iso_epoch_day(""), None);
        assert_eq!(iso_epoch_day("not-a-date"), None);
        assert_eq!(iso_epoch_day("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn ymd_gate() {
        assert!(super::valid_ymd("2026-08-26"));
        assert!(!super::valid_ymd("2026-13-01"));
        assert!(!super::valid_ymd("26-08-26"));
        assert!(!super::valid_ymd("2026-02-30"));
    }
}

