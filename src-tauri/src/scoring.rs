use serde::{Deserialize, Serialize};
use serde_json::Value;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoringPolicy {
    PerQuestion,
    InEitherOrder,
}

impl Default for ScoringPolicy {
    fn default() -> Self {
        Self::PerQuestion
    }
}

/// Trim, collapse whitespace, ASCII/Unicode case-fold. No fuzzy expansion.
pub fn normalize_answer(raw: &str) -> String {
    raw.trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn answers_match(accepted: &[String], given: Option<&str>) -> bool {
    let Some(given) = given else {
        return false;
    };
    let n = normalize_answer(given);
    if n.is_empty() {
        return false;
    }
    accepted.iter().any(|item| normalize_answer(item) == n)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionScore {
    pub question_id: String,
    pub number: u32,
    pub question_type: String,
    pub correct: bool,
    pub user_answer: Option<Value>,
    pub accepted_answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreReport {
    pub schema_version: u32,
    pub exam_id: String,
    pub raw_correct: u32,
    pub raw_total: u32,
    pub questions: Vec<QuestionScore>,
}

/// Score a full exam JSON + a map of questionId -> answer value.
pub fn score_exam(exam: &Value, answers: &Value) -> Result<ScoreReport, String> {
    let exam_id = exam
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let mut questions_out = Vec::new();

    let sections = exam
        .get("sections")
        .and_then(Value::as_array)
        .ok_or("exam.sections missing")?;

    for section in sections {
        let groups = section
            .get("questionGroups")
            .and_then(Value::as_array)
            .ok_or("section.questionGroups missing")?;
        for group in groups {
            score_group(group, answers, &mut questions_out)?;
        }
    }

    let raw_correct = questions_out.iter().filter(|q| q.correct).count() as u32;
    let raw_total = questions_out.len() as u32;
    Ok(ScoreReport {
        schema_version: 1,
        exam_id,
        raw_correct,
        raw_total,
        questions: questions_out,
    })
}

fn score_group(
    group: &Value,
    answers: &Value,
    out: &mut Vec<QuestionScore>,
) -> Result<(), String> {
    let questions = group
        .get("questions")
        .and_then(Value::as_array)
        .ok_or("group.questions missing")?;
    let policy = group
        .get("scoringPolicy")
        .and_then(Value::as_str)
        .unwrap_or("per_question");

    if policy == "in_either_order" {
        return score_in_either_order(group, questions, answers, out);
    }

    for q in questions {
        out.push(score_one(q, group, answers));
    }
    Ok(())
}

fn score_one(question: &Value, group: &Value, answers: &Value) -> QuestionScore {
    let id = question
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let number = question.get("number").and_then(Value::as_u64).unwrap_or(0) as u32;
    let qtype = question
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let accepted = accepted_list(question, group);
    let user_val = answers.get(&id).cloned();
    let given = value_to_compare(user_val.as_ref());
    let correct = answers_match(&accepted, given.as_deref());
    QuestionScore {
        question_id: id,
        number,
        question_type: qtype,
        correct,
        user_answer: user_val,
        accepted_answers: accepted,
    }
}

fn accepted_list(question: &Value, group: &Value) -> Vec<String> {
    if let Some(list) = question
        .get("acceptedAnswers")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    {
        return list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    group
        .get("acceptedAnswers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_to_compare(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(Value::Array(arr)) => {
            // Multi-select stored as array: compare as sorted joined tokens only
            // for per-question multi_choice of a single slot. Group either-order
            // handles arrays at group level instead.
            let parts: Vec<String> = arr.iter().filter_map(Value::as_str).map(str::to_string).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("|"))
            }
        }
        Some(other) => Some(other.to_string()),
    }
}

fn score_in_either_order(
    group: &Value,
    questions: &[Value],
    answers: &Value,
    out: &mut Vec<QuestionScore>,
) -> Result<(), String> {
    let mut remaining: Vec<String> = group
        .get("acceptedAnswers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|s| normalize_answer(s))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let accepted_display: Vec<String> = group
        .get("acceptedAnswers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    for q in questions {
        let id = q.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let number = q.get("number").and_then(Value::as_u64).unwrap_or(0) as u32;
        let qtype = q
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let user_val = answers.get(&id).cloned();
        let given = value_to_compare(user_val.as_ref()).map(|s| normalize_answer(&s));
        let mut correct = false;
        if let Some(g) = given {
            if !g.is_empty() {
                if let Some(pos) = remaining.iter().position(|a| a == &g) {
                    remaining.remove(pos);
                    correct = true;
                }
            }
        }
        out.push(QuestionScore {
            question_id: id,
            number,
            question_type: qtype,
            correct,
            user_answer: user_val,
            accepted_answers: accepted_display.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exam_with_group(group: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "id": "exam-test",
            "sections": [{ "id": "s1", "questionGroups": [group] }]
        })
    }

    #[test]
    fn normalize_trim_case_spaces() {
        assert_eq!(normalize_answer("  The   Library  "), "the library");
        assert_eq!(normalize_answer("COLOUR"), "colour");
    }

    #[test]
    fn multi_accepted() {
        let accepted = vec!["colour".into(), "color".into()];
        assert!(answers_match(&accepted, Some("Colour")));
        assert!(answers_match(&accepted, Some("COLOR")));
        assert!(!answers_match(&accepted, Some("colors")));
    }

    #[test]
    fn illegal_and_blank() {
        let accepted = vec!["library".into()];
        assert!(!answers_match(&accepted, Some("")));
        assert!(!answers_match(&accepted, Some("   ")));
        assert!(!answers_match(&accepted, None));
        assert!(!answers_match(&accepted, Some("museum")));
    }

    #[test]
    fn true_false_ng() {
        let exam = exam_with_group(json!({
            "id": "g1",
            "scoringPolicy": "per_question",
            "questions": [
                { "id": "q1", "number": 1, "type": "true_false_ng", "acceptedAnswers": ["FALSE"] },
                { "id": "q2", "number": 2, "type": "true_false_ng", "acceptedAnswers": ["NOT GIVEN"] }
            ]
        }));
        let answers = json!({ "q1": "false", "q2": "NOT GIVEN" });
        let report = score_exam(&exam, &answers).unwrap();
        assert_eq!(report.raw_correct, 2);
    }

    #[test]
    fn yes_no_ng_illegal() {
        let exam = exam_with_group(json!({
            "id": "g1",
            "scoringPolicy": "per_question",
            "questions": [
                { "id": "q1", "number": 1, "type": "yes_no_ng", "acceptedAnswers": ["YES"] }
            ]
        }));
        let answers = json!({ "q1": "TRUE" });
        let report = score_exam(&exam, &answers).unwrap();
        assert_eq!(report.raw_correct, 0);
    }

    #[test]
    fn single_choice() {
        let exam = exam_with_group(json!({
            "id": "g1",
            "scoringPolicy": "per_question",
            "questions": [
                { "id": "q1", "number": 1, "type": "single_choice", "acceptedAnswers": ["B"] }
            ]
        }));
        assert_eq!(score_exam(&exam, &json!({"q1":"B"})).unwrap().raw_correct, 1);
        assert_eq!(score_exam(&exam, &json!({"q1":"C"})).unwrap().raw_correct, 0);
    }

    #[test]
    fn completion() {
        let exam = exam_with_group(json!({
            "id": "g1",
            "scoringPolicy": "per_question",
            "questions": [
                { "id": "q1", "number": 1, "type": "completion", "acceptedAnswers": ["the library", "library"] }
            ]
        }));
        assert_eq!(
            score_exam(&exam, &json!({"q1":"  Library "})).unwrap().raw_correct,
            1
        );
    }

    #[test]
    fn matching() {
        let exam = exam_with_group(json!({
            "id": "g1",
            "scoringPolicy": "per_question",
            "questions": [
                { "id": "q1", "number": 1, "type": "matching", "acceptedAnswers": ["ii"] },
                { "id": "q2", "number": 2, "type": "matching", "acceptedAnswers": ["iv"] }
            ]
        }));
        let report = score_exam(&exam, &json!({"q1":"ii","q2":"iv"})).unwrap();
        assert_eq!(report.raw_correct, 2);
    }

    #[test]
    fn in_either_order_forward() {
        let exam = either_order_exam();
        let report = score_exam(&exam, &json!({"q21":"B","q22":"D"})).unwrap();
        assert_eq!(report.raw_correct, 2);
    }

    #[test]
    fn in_either_order_reverse() {
        let exam = either_order_exam();
        let report = score_exam(&exam, &json!({"q21":"D","q22":"B"})).unwrap();
        assert_eq!(report.raw_correct, 2);
    }

    #[test]
    fn in_either_order_duplicate() {
        let exam = either_order_exam();
        let report = score_exam(&exam, &json!({"q21":"B","q22":"B"})).unwrap();
        assert_eq!(report.raw_correct, 1);
    }

    #[test]
    fn in_either_order_partial() {
        let exam = either_order_exam();
        let report = score_exam(&exam, &json!({"q21":"B"})).unwrap();
        assert_eq!(report.raw_correct, 1);
        let report = score_exam(&exam, &json!({"q21":"A","q22":"C"})).unwrap();
        assert_eq!(report.raw_correct, 0);
    }

    fn either_order_exam() -> Value {
        exam_with_group(json!({
            "id": "g-either",
            "scoringPolicy": "in_either_order",
            "acceptedAnswers": ["B", "D"],
            "questions": [
                { "id": "q21", "number": 21, "type": "multi_choice" },
                { "id": "q22", "number": 22, "type": "multi_choice" }
            ]
        }))
    }

    #[test]
    fn scores_original_fixture_either_order() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/question-types/fixture-multi_choice_either_order.json");
        let exam: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("mock json")).unwrap();
        let answers = json!({ "f2": "C", "f3": "A" });
        let report = score_exam(&exam, &answers).unwrap();
        assert_eq!(report.raw_total, 2);
        let f2 = report
            .questions
            .iter()
            .find(|q| q.question_id == "f2")
            .unwrap();
        let f3 = report
            .questions
            .iter()
            .find(|q| q.question_id == "f3")
            .unwrap();
        assert!(f2.correct && f3.correct);
    }
}
