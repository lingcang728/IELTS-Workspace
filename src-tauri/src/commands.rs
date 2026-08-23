use crate::error::AppError;
use crate::library;
use crate::paths;
use crate::scoring;
use crate::session;
use serde_json::Value;
use std::fs;

#[tauri::command]
pub fn bootstrap() -> Result<Value, AppError> {
    let probe = paths::probe_writable();
    if !probe.ok {
        return Ok(serde_json::json!({
            "probe": probe,
            "exams": [],
            "sessions": [],
            "profile": null,
        }));
    }
    let exams = library::list_exams().unwrap_or_default();
    let sessions = session::list_session_summaries().unwrap_or_default();
    let profile = fs::read_to_string(paths::profile_path()?)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    Ok(serde_json::json!({
        "probe": probe,
        "exams": exams,
        "sessions": sessions,
        "profile": profile,
    }))
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
    let v: Value = serde_json::from_str(&json)?;
    let path = paths::profile_path()?;
    session::atomic_write(&path, serde_json::to_vec_pretty(&v)?.as_slice())?;
    Ok(())
}

/// Build analytics strictly from submitted local sessions and the current
/// answer keys. No placeholder or estimated Speaking values are generated.
#[tauri::command]
pub fn analytics_report(range_days: u32) -> Result<Value, AppError> {
    use std::collections::BTreeMap;
    let _ = range_days; // Session timestamps are retained verbatim for the UI.
    let mut module_scores: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut module_counts: BTreeMap<String, u32> = BTreeMap::new();
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
            if module == "writing" {
                *module_counts.entry(module).or_default() += 1;
                continue;
            }
            let Some(exam_id) = session.get("examId").and_then(Value::as_str) else { continue };
            let Ok(exam) = crate::library::load_exam(exam_id) else { continue };
            let answers = session.get("answers").cloned().unwrap_or_else(|| serde_json::json!({}));
            let Ok(score) = crate::scoring::score_exam(&exam, &answers) else { continue };
            let normalized = if score.raw_total == 0 { 0.0 } else { (score.raw_correct as f64 / score.raw_total as f64) * 9.0 };
            module_scores.entry(module.clone()).or_default().push(normalized);
            *module_counts.entry(module.clone()).or_default() += 1;
            trend.entry(module.clone()).or_default().push(serde_json::json!({
                "date": updated,
                "score": normalized,
                "rawCorrect": score.raw_correct,
                "rawTotal": score.raw_total,
            }));
            time_trend.push(serde_json::json!({
                "date": updated,
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
    let mut overall_sum = 0.0;
    let mut overall_count = 0usize;
    for (module, scores) in &module_scores {
        if scores.is_empty() { continue; }
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        overall_sum += scores.iter().sum::<f64>();
        overall_count += scores.len();
        averages.insert(module.clone(), serde_json::json!(avg));
    }
    let accuracy = type_totals.into_iter().map(|((module, question_type), (correct, total))| {
        serde_json::json!({ "module": module, "questionType": question_type, "correct": correct, "total": total, "accuracy": if total == 0 { 0.0 } else { correct as f64 / total as f64 } })
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": chrono_like_now(),
        "rangeDays": range_days,
        "overallAverage": if overall_count == 0 { Value::Null } else { serde_json::json!(overall_sum / overall_count as f64) },
        "moduleAverages": averages,
        "moduleCounts": module_counts,
        "scoreTrend": trend,
        "questionTypeAccuracy": accuracy,
        "timeTrend": time_trend,
        "speakingEnabled": false,
    }))
}

fn chrono_like_now() -> String {
    // Keep the command dependency-free; milliseconds are enough for report
    // freshness and the frontend already formats user-facing dates.
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    millis.to_string()
}
