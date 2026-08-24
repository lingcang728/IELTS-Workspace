//! FSRS-4.5 scheduling for the vocabulary book.
//!
//! FSRS models a card with three numbers: **stability** (days until recall
//! probability falls to 90%), **difficulty** (1-10, how hard this item is for
//! this learner) and **retrievability** (probability of recall right now).
//! After each review the three are updated from the published equations and
//! the next interval follows from the requested retention.
//!
//! This is the real algorithm with the published default weights, not an SM-2
//! approximation: the interval a card gets depends on how far its recall
//! probability had already decayed when it was reviewed, which is the whole
//! point of FSRS and the thing SM-2 cannot express.
//!
//! Reference: Ye et al., "Optimizing Spaced Repetition Schedule by Capturing
//! the Dynamics of Memory" (FSRS v4.5 default parameters).

/// Grades, as the UI presents them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

impl Grade {
    pub fn from_i64(value: i64) -> Option<Grade> {
        match value {
            1 => Some(Grade::Again),
            2 => Some(Grade::Hard),
            3 => Some(Grade::Good),
            4 => Some(Grade::Easy),
            _ => None,
        }
    }

    fn as_f64(self) -> f64 {
        self as i64 as f64
    }
}

/// FSRS-4.5 default weights.
const W: [f64; 17] = [
    0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461,
    2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY: f64 = -0.5;
/// Chosen so that `retrievability(stability, stability) == 0.9`.
const FACTOR: f64 = 19.0 / 81.0;
const MIN_STABILITY: f64 = 0.1;
const MAX_STABILITY: f64 = 36500.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Memory {
    pub stability: f64,
    pub difficulty: f64,
}

/// Probability of recalling a card `elapsed_days` after its last review.
pub fn retrievability(stability: f64, elapsed_days: f64) -> f64 {
    (1.0 + FACTOR * elapsed_days.max(0.0) / stability.max(MIN_STABILITY)).powf(DECAY)
}

/// Days until recall probability decays to `requested_retention`.
pub fn interval_days(stability: f64, requested_retention: f64) -> f64 {
    let retention = requested_retention.clamp(0.7, 0.99);
    (stability / FACTOR) * (retention.powf(1.0 / DECAY) - 1.0)
}

fn clamp_difficulty(d: f64) -> f64 {
    d.clamp(1.0, 10.0)
}

fn clamp_stability(s: f64) -> f64 {
    s.clamp(MIN_STABILITY, MAX_STABILITY)
}

/// State for a card being seen for the first time.
pub fn initial(grade: Grade) -> Memory {
    let index = grade as usize - 1;
    Memory {
        stability: clamp_stability(W[index]),
        difficulty: clamp_difficulty(W[4] - (W[5] * (grade.as_f64() - 3.0)).exp() + 1.0),
    }
}

fn next_difficulty(difficulty: f64, grade: Grade) -> f64 {
    let delta = difficulty - W[6] * (grade.as_f64() - 3.0);
    // Mean reversion towards the difficulty an "Easy" first answer would give,
    // so a card cannot drift to 10 and stay there for ever.
    let target = initial(Grade::Easy).difficulty;
    clamp_difficulty(W[7] * target + (1.0 - W[7]) * delta)
}

fn stability_after_recall(memory: Memory, retrievability: f64, grade: Grade) -> f64 {
    let hard_penalty = if grade == Grade::Hard { W[15] } else { 1.0 };
    let easy_bonus = if grade == Grade::Easy { W[16] } else { 1.0 };
    let growth = (W[8]).exp()
        * (11.0 - memory.difficulty)
        * memory.stability.powf(-W[9])
        * ((W[10] * (1.0 - retrievability)).exp_m1())
        * hard_penalty
        * easy_bonus;
    clamp_stability(memory.stability * (1.0 + growth))
}

fn stability_after_lapse(memory: Memory, retrievability: f64) -> f64 {
    let value = W[11]
        * memory.difficulty.powf(-W[12])
        * ((memory.stability + 1.0).powf(W[13]) - 1.0)
        * (W[14] * (1.0 - retrievability)).exp();
    clamp_stability(value.min(memory.stability))
}

/// The card's state after a review, given how long it had been since the last.
pub fn review(previous: Option<Memory>, elapsed_days: f64, grade: Grade) -> Memory {
    let Some(memory) = previous else {
        return initial(grade);
    };
    let r = retrievability(memory.stability, elapsed_days);
    let difficulty = next_difficulty(memory.difficulty, grade);
    let stability = if grade == Grade::Again {
        stability_after_lapse(memory, r)
    } else {
        stability_after_recall(memory, r, grade)
    };
    Memory {
        stability,
        difficulty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tolerance: f64) -> bool {
        (a - b).abs() < tolerance
    }

    #[test]
    fn retrievability_is_ninety_percent_after_one_stability() {
        assert!(close(retrievability(10.0, 10.0), 0.9, 1e-6));
        assert!(close(retrievability(3.0, 3.0), 0.9, 1e-6));
    }

    #[test]
    fn retrievability_decays_with_time() {
        let fresh = retrievability(10.0, 0.0);
        let later = retrievability(10.0, 30.0);
        assert!(close(fresh, 1.0, 1e-9));
        assert!(later < fresh);
        assert!(later > 0.0);
    }

    #[test]
    fn interval_grows_with_stability() {
        let short = interval_days(1.0, 0.9);
        let long = interval_days(30.0, 0.9);
        assert!(long > short);
        // At the default 90% retention the interval is the stability itself.
        assert!(close(interval_days(30.0, 0.9), 30.0, 1e-6));
    }

    #[test]
    fn lower_retention_target_means_longer_gaps() {
        assert!(interval_days(10.0, 0.8) > interval_days(10.0, 0.9));
    }

    #[test]
    fn first_answer_orders_stability_by_grade() {
        let again = initial(Grade::Again).stability;
        let hard = initial(Grade::Hard).stability;
        let good = initial(Grade::Good).stability;
        let easy = initial(Grade::Easy).stability;
        assert!(again < hard && hard < good && good < easy);
    }

    #[test]
    fn easy_is_easier_than_again() {
        assert!(initial(Grade::Easy).difficulty < initial(Grade::Again).difficulty);
    }

    #[test]
    fn again_shortens_stability_and_good_lengthens_it() {
        let start = Memory {
            stability: 20.0,
            difficulty: 5.0,
        };
        let lapsed = review(Some(start), 20.0, Grade::Again);
        let recalled = review(Some(start), 20.0, Grade::Good);
        assert!(lapsed.stability < start.stability);
        assert!(recalled.stability > start.stability);
    }

    #[test]
    fn a_late_review_is_worth_more_than_an_early_one() {
        // The point of FSRS: recalling a card whose retrievability had already
        // decayed teaches more than recalling one reviewed immediately.
        let start = Memory {
            stability: 10.0,
            difficulty: 5.0,
        };
        let early = review(Some(start), 1.0, Grade::Good).stability;
        let late = review(Some(start), 20.0, Grade::Good).stability;
        assert!(late > early);
    }

    #[test]
    fn difficulty_stays_in_range() {
        let mut memory = initial(Grade::Again);
        for _ in 0..40 {
            memory = review(Some(memory), 1.0, Grade::Again);
            assert!(memory.difficulty >= 1.0 && memory.difficulty <= 10.0);
            assert!(memory.stability >= MIN_STABILITY);
        }
        for _ in 0..40 {
            memory = review(Some(memory), 30.0, Grade::Easy);
            assert!(memory.difficulty >= 1.0 && memory.difficulty <= 10.0);
        }
    }

    #[test]
    fn grade_parsing_rejects_out_of_range() {
        assert_eq!(Grade::from_i64(3), Some(Grade::Good));
        assert!(Grade::from_i64(0).is_none());
        assert!(Grade::from_i64(5).is_none());
    }
}
