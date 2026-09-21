//! Commands for the Phase 3 study features: mistakes book, vocabulary book,
//! study plan and saved external-model feedback.
//!
//! All four are records in `store`, so none of them needs its own persistence.
//! What lives here is the logic that must not be in the frontend: which cards
//! are due, what a review does to a card's schedule, and when a mistake is
//! considered learned. React decides how to draw them, not what they mean.

use crate::clock::{epoch_day_now, iso_epoch_day, iso_from_epoch_day, now_iso};
use crate::error::AppError;
use crate::safe_path;
use crate::srs::{self, Grade, Memory};
use crate::store;
use serde_json::{json, Value};
use std::sync::atomic::AtomicU64;

static FEEDBACK_SEQ: AtomicU64 = AtomicU64::new(0);

/// Consecutive correct answers before a mistake leaves the active book. Three
/// is the point where a re-do stops being recall of the last attempt.
const MASTERED_STREAK: i64 = 3;
const DEFAULT_RETENTION: f64 = 0.9;

// ---------------------------------------------------------------- mistakes

/// Add or refresh mistakes. Re-submitting the same exam updates the existing
/// entry instead of duplicating it, so a re-do does not double-count.
#[tauri::command]
pub async fn mistake_add(entries_json: String) -> Result<Value, AppError> {
    safe_path::check_json_arg(&entries_json, "错题数据")?;
    let entries: Value = serde_json::from_str(&entries_json)?;
    let list = entries
        .as_array()
        .ok_or_else(|| AppError::from("mistake_add 需要一个数组"))?;
    let existing = store::list("mistakes")?;
    let mut added = 0;
    let mut refreshed = 0;
    for entry in list {
        let exam_id = entry.get("examId").and_then(Value::as_str).unwrap_or("");
        let question_id = entry
            .get("questionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if exam_id.is_empty() || question_id.is_empty() {
            continue;
        }
        let id = format!("{exam_id}__{question_id}").replace(['.', ' '], "-");
        let previous = existing
            .iter()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let mut record = entry.clone();
        record["id"] = json!(id);
        record["addedAt"] = previous
            .and_then(|p| p.get("addedAt").cloned())
            .unwrap_or_else(|| json!(now_iso()));
        record["updatedAt"] = json!(now_iso());
        // 重新答错已掌握错题时，必须重置连续答对次数并重新激活为 open
        record["streak"] = json!(0);
        record["status"] = json!("open");
        record["timesWrong"] = json!(
            previous
                .and_then(|p| p.get("timesWrong").and_then(Value::as_i64))
                .unwrap_or(0)
                + 1
        );
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
pub async fn mistake_list() -> Result<Vec<Value>, AppError> {
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
pub async fn mistake_resolve(id: String, correct: bool) -> Result<Value, AppError> {
    let Some(mut record) = store::read("mistakes", &id)? else {
        return Err(AppError::from("找不到该错题"));
    };
    let streak = record.get("streak").and_then(Value::as_i64).unwrap_or(0);
    let next = if correct { streak + 1 } else { 0 };
    record["streak"] = json!(next);
    record["updatedAt"] = json!(now_iso());
    if !correct {
        record["timesWrong"] = json!(
            record
                .get("timesWrong")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                + 1
        );
    }
    record["status"] = json!(if next >= MASTERED_STREAK {
        "mastered"
    } else {
        "open"
    });
    store::save("mistakes", &record)?;
    Ok(record)
}

#[tauri::command]
pub async fn mistake_delete(id: String) -> Result<(), AppError> {
    store::delete("mistakes", &id)
}

// ---------------------------------------------------------------- vocabulary

/// Add a word. The card starts unscheduled: its first review sets the schedule,
/// which is what FSRS expects rather than inventing an initial interval.
#[tauri::command]
pub async fn vocab_add(entry_json: String) -> Result<Value, AppError> {
    safe_path::check_json_arg(&entry_json, "生词数据")?;
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
    let clean_slug = slug.trim_matches('-');
    let id = if clean_slug.is_empty() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        term.hash(&mut hasher);
        format!("w-{:x}", hasher.finish())
    } else {
        format!("w-{}", clean_slug)
    };
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
pub async fn vocab_due(limit: Option<usize>) -> Result<Vec<Value>, AppError> {
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
        let priority = match (
            memory_of(&record),
            record.get("lastReviewOn").and_then(Value::as_str),
        ) {
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
    Ok(due
        .into_iter()
        .take(cap)
        .map(|(_, record)| record)
        .collect())
}

/// Grade a card (1 Again / 2 Hard / 3 Good / 4 Easy) and reschedule it.
#[tauri::command]
pub async fn vocab_review(
    id: String,
    grade: i64,
    retention: Option<f64>,
) -> Result<Value, AppError> {
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
    let interval = srs::interval_days(memory.stability, retention)
        .max(1.0)
        .round() as i64;

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
pub async fn vocab_list() -> Result<Vec<Value>, AppError> {
    let mut all = store::list("vocab")?;
    all.sort_by(|a, b| {
        let left = a.get("addedAt").and_then(Value::as_str).unwrap_or("");
        let right = b.get("addedAt").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(all)
}

#[tauri::command]
pub async fn vocab_delete(id: String) -> Result<(), AppError> {
    store::delete("vocab", &id)
}

// --------------------------------------------------------------- study plan

#[tauri::command]
pub async fn plan_get() -> Result<Value, AppError> {
    Ok(store::read("plans", "current")?.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn plan_save(plan_json: String) -> Result<Value, AppError> {
    safe_path::check_json_arg(&plan_json, "学习计划")?;
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
pub async fn feedback_save(entry_json: String) -> Result<Value, AppError> {
    safe_path::check_json_arg(&entry_json, "反馈记录")?;
    let mut entry: Value = serde_json::from_str(&entry_json)?;
    if entry.get("id").and_then(Value::as_str).is_none() {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let seq = FEEDBACK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        entry["id"] = json!(format!("f-{ms}-{seq}"));
    }
    entry["savedAt"] = json!(now_iso());
    store::save("feedback", &entry)?;
    Ok(entry)
}

#[tauri::command]
pub async fn feedback_list() -> Result<Vec<Value>, AppError> {
    let mut all = store::list("feedback")?;
    all.sort_by(|a, b| {
        let left = a.get("savedAt").and_then(Value::as_str).unwrap_or("");
        let right = b.get("savedAt").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(all)
}

#[tauri::command]
pub async fn feedback_delete(id: String) -> Result<(), AppError> {
    store::delete("feedback", &id)
}
