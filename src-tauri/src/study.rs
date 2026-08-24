//! Commands for the Phase 3 study features: mistakes book, vocabulary book,
//! study plan and saved external-model feedback.
//!
//! All four are records in `store`, so none of them needs its own persistence.
//! What lives here is the logic that must not be in the frontend: which cards
//! are due, what a review does to a card's schedule, and when a mistake is
//! considered learned. React decides how to draw them, not what they mean.

use crate::error::AppError;
use crate::srs::{self, Grade, Memory};
use crate::store;
use serde_json::{json, Value};

/// Consecutive correct answers before a mistake leaves the active book. Three
/// is the point where a re-do stops being recall of the last attempt.
const MASTERED_STREAK: i64 = 3;
const DEFAULT_RETENTION: f64 = 0.9;

fn now_iso() -> String {
    // The frontend sends timestamps for anything user-visible; this is only a
    // fallback so a record is never written without one.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Inverse of `days_from_civil`; proleptic Gregorian, no dependencies.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

fn epoch_day_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

fn iso_epoch_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn iso_from_epoch_day(day: i64) -> String {
    let (year, month, dom) = civil_from_days(day);
    format!("{year:04}-{month:02}-{dom:02}")
}

// ---------------------------------------------------------------- mistakes

/// Add or refresh mistakes. Re-submitting the same exam updates the existing
/// entry instead of duplicating it, so a re-do does not double-count.
#[tauri::command]
pub fn mistake_add(entries_json: String) -> Result<Value, AppError> {
    let entries: Value = serde_json::from_str(&entries_json)?;
    let list = entries
        .as_array()
        .ok_or_else(|| AppError::from("mistake_add 需要一个数组"))?;
    let existing = store::list("mistakes")?;
    let mut added = 0;
    let mut refreshed = 0;
    for entry in list {
        let exam_id = entry.get("examId").and_then(Value::as_str).unwrap_or("");
        let question_id = entry.get("questionId").and_then(Value::as_str).unwrap_or("");
        if exam_id.is_empty() || question_id.is_empty() {
            continue;
        }
        let id = format!("{exam_id}__{question_id}").replace(['.', ' '], "-");
        let previous = existing.iter().find(|value| {
            value.get("id").and_then(Value::as_str) == Some(id.as_str())
        });
        let mut record = entry.clone();
        record["id"] = json!(id);
        record["addedAt"] = previous
            .and_then(|p| p.get("addedAt").cloned())
            .unwrap_or_else(|| json!(now_iso()));
        record["updatedAt"] = json!(now_iso());
        record["streak"] = previous
            .and_then(|p| p.get("streak").cloned())
            .unwrap_or_else(|| json!(0));
        record["status"] = previous
            .and_then(|p| p.get("status").cloned())
            .unwrap_or_else(|| json!("open"));
        record["timesWrong"] = json!(previous
            .and_then(|p| p.get("timesWrong").and_then(Value::as_i64))
            .unwrap_or(0)
            + 1);
        store::save("mistakes", &record)?;
        if previous.is_some() {
            refreshed += 1;
        } else {
            added += 1;
        }
    }
    Ok(json!({ "added": added, "refreshed": refreshed }))
}

#[tauri::command]
pub fn mistake_list() -> Result<Vec<Value>, AppError> {
    let mut all = store::list("mistakes")?;
    // Most recently missed first: that is the order a learner works in.
    all.sort_by(|a, b| {
        let left = a.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let right = b.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(all)
}

/// Record a re-do. `correct` extends the streak; a wrong answer resets it.
/// Reaching `MASTERED_STREAK` archives the entry.
#[tauri::command]
pub fn mistake_resolve(id: String, correct: bool) -> Result<Value, AppError> {
    let Some(mut record) = store::read("mistakes", &id)? else {
        return Err(AppError::from("找不到该错题"));
    };
    let streak = record.get("streak").and_then(Value::as_i64).unwrap_or(0);
    let next = if correct { streak + 1 } else { 0 };
    record["streak"] = json!(next);
    record["updatedAt"] = json!(now_iso());
    if !correct {
        record["timesWrong"] = json!(record
            .get("timesWrong")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + 1);
    }
    record["status"] = json!(if next >= MASTERED_STREAK { "mastered" } else { "open" });
    store::save("mistakes", &record)?;
    Ok(record)
}

#[tauri::command]
pub fn mistake_delete(id: String) -> Result<(), AppError> {
    store::delete("mistakes", &id)
}

// ---------------------------------------------------------------- vocabulary

/// Add a word. The card starts unscheduled: its first review sets the schedule,
/// which is what FSRS expects rather than inventing an initial interval.
#[tauri::command]
pub fn vocab_add(entry_json: String) -> Result<Value, AppError> {
    let entry: Value = serde_json::from_str(&entry_json)?;
    let term = entry
        .get("term")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::from("生词缺少 term"))?;
    let slug: String = term
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let id = format!("w-{}", slug.trim_matches('-'));
    let mut record = entry.clone();
    if let Some(existing) = store::read("vocab", &id)? {
        // Meeting a word again adds a sighting; it never resets the schedule.
        let mut sightings = existing
            .get("sightings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(sighting) = entry.get("sighting") {
            if !sightings.contains(sighting) {
                sightings.push(sighting.clone());
            }
        }
        record = existing;
        record["sightings"] = json!(sightings);
        record["updatedAt"] = json!(now_iso());
        store::save("vocab", &record)?;
        return Ok(record);
    }
    record["id"] = json!(id);
    record["term"] = json!(term);
    record["addedAt"] = json!(now_iso());
    record["updatedAt"] = json!(now_iso());
    record["reps"] = json!(0);
    record["lapses"] = json!(0);
    record["sightings"] = match entry.get("sighting") {
        Some(sighting) => json!([sighting]),
        None => json!([]),
    };
    store::save("vocab", &record)?;
    Ok(record)
}

fn memory_of(record: &Value) -> Option<Memory> {
    let stability = record.get("stability").and_then(Value::as_f64)?;
    let difficulty = record.get("difficulty").and_then(Value::as_f64)?;
    Some(Memory {
        stability,
        difficulty,
    })
}

/// Cards due today, hardest-recall first. A card with no schedule yet is new
/// and always due.
#[tauri::command]
pub fn vocab_due(limit: Option<usize>) -> Result<Vec<Value>, AppError> {
    let today = epoch_day_now();
    let mut due: Vec<(f64, Value)> = Vec::new();
    for record in store::list("vocab")? {
        let due_day = record
            .get("dueOn")
            .and_then(Value::as_str)
            .and_then(iso_epoch_day);
        let is_due = match due_day {
            Some(day) => day <= today,
            None => true,
        };
        if !is_due {
            continue;
        }
        // New cards sort first; among scheduled cards the most-decayed first.
        let priority = match (memory_of(&record), record.get("lastReviewOn").and_then(Value::as_str)) {
            (Some(memory), Some(last)) => {
                let elapsed = (today - iso_epoch_day(last).unwrap_or(today)) as f64;
                srs::retrievability(memory.stability, elapsed)
            }
            _ => -1.0,
        };
        due.push((priority, record));
    }
    due.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let cap = limit.unwrap_or(usize::MAX);
    Ok(due.into_iter().take(cap).map(|(_, record)| record).collect())
}

/// Grade a card (1 Again / 2 Hard / 3 Good / 4 Easy) and reschedule it.
#[tauri::command]
pub fn vocab_review(id: String, grade: i64, retention: Option<f64>) -> Result<Value, AppError> {
    let grade = Grade::from_i64(grade).ok_or_else(|| AppError::from("评分必须是 1-4"))?;
    let Some(mut record) = store::read("vocab", &id)? else {
        return Err(AppError::from("找不到该生词"));
    };
    let today = epoch_day_now();
    let elapsed = record
        .get("lastReviewOn")
        .and_then(Value::as_str)
        .and_then(iso_epoch_day)
        .map(|day| (today - day) as f64)
        .unwrap_or(0.0);
    let memory = srs::review(memory_of(&record), elapsed, grade);
    let retention = retention.unwrap_or(DEFAULT_RETENTION);
    let interval = srs::interval_days(memory.stability, retention).max(1.0).round() as i64;

    record["stability"] = json!(memory.stability);
    record["difficulty"] = json!(memory.difficulty);
    record["intervalDays"] = json!(interval);
    record["lastReviewOn"] = json!(iso_from_epoch_day(today));
    record["dueOn"] = json!(iso_from_epoch_day(today + interval));
    record["reps"] = json!(record.get("reps").and_then(Value::as_i64).unwrap_or(0) + 1);
    if grade == Grade::Again {
        record["lapses"] = json!(record.get("lapses").and_then(Value::as_i64).unwrap_or(0) + 1);
    }
    record["updatedAt"] = json!(now_iso());
    store::save("vocab", &record)?;
    Ok(record)
}

#[tauri::command]
pub fn vocab_list() -> Result<Vec<Value>, AppError> {
    let mut all = store::list("vocab")?;
    all.sort_by(|a, b| {
        let left = a.get("addedAt").and_then(Value::as_str).unwrap_or("");
        let right = b.get("addedAt").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(all)
}

#[tauri::command]
pub fn vocab_delete(id: String) -> Result<(), AppError> {
    store::delete("vocab", &id)
}

// --------------------------------------------------------------- study plan

#[tauri::command]
pub fn plan_get() -> Result<Value, AppError> {
    Ok(store::read("plans", "current")?.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn plan_save(plan_json: String) -> Result<Value, AppError> {
    let mut plan: Value = serde_json::from_str(&plan_json)?;
    plan["id"] = json!("current");
    plan["updatedAt"] = json!(now_iso());
    store::save("plans", &plan)?;
    Ok(plan)
}

// ------------------------------------------------------------- AI feedback

/// Archive a reply pasted back from an external model, so the prompts a
/// learner sends out become a personal corpus instead of vanishing.
#[tauri::command]
pub fn feedback_save(entry_json: String) -> Result<Value, AppError> {
    let mut entry: Value = serde_json::from_str(&entry_json)?;
    if entry.get("id").and_then(Value::as_str).is_none() {
        entry["id"] = json!(format!("f-{}", epoch_day_now() * 1_000_000 + (now_iso().len() as i64)));
    }
    entry["savedAt"] = json!(now_iso());
    store::save("feedback", &entry)?;
    Ok(entry)
}

#[tauri::command]
pub fn feedback_list() -> Result<Vec<Value>, AppError> {
    let mut all = store::list("feedback")?;
    all.sort_by(|a, b| {
        let left = a.get("savedAt").and_then(Value::as_str).unwrap_or("");
        let right = b.get("savedAt").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(all)
}

#[tauri::command]
pub fn feedback_delete(id: String) -> Result<(), AppError> {
    store::delete("feedback", &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for day in [0_i64, 1, 19_000, 20_000, -365, 100_000] {
            let (y, m, d) = civil_from_days(day);
            let iso = format!("{y:04}-{m:02}-{d:02}");
            assert_eq!(iso_epoch_day(&iso), Some(day), "round trip failed for {iso}");
        }
    }

    #[test]
    fn epoch_day_zero_is_the_unix_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(iso_from_epoch_day(0), "1970-01-01");
    }

    #[test]
    fn now_iso_is_well_formed() {
        let stamp = now_iso();
        assert_eq!(stamp.len(), 20, "{stamp}");
        assert!(stamp.ends_with('Z'));
        assert!(iso_epoch_day(&stamp).is_some());
    }
}
