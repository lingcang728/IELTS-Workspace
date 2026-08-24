//! Raw-score to IELTS band conversion.
//!
//! The tables are compiled in from `schema/band-conversion.json`, the same file
//! `src/lib/band.ts` imports, so the frontend and the backend can never drift
//! into two different scales. Never reintroduce a `raw / total * 9` formula:
//! it under-reports the low bands by close to a full band.

use serde::Deserialize;
use std::sync::OnceLock;

const TABLE_JSON: &str = include_str!("../../schema/band-conversion.json");

#[derive(Debug, Deserialize)]
struct BandRow {
    min: u32,
    max: u32,
    band: f64,
}

#[derive(Debug, Deserialize)]
struct BandTables {
    #[serde(rename = "readingAcademic")]
    reading_academic: Vec<BandRow>,
    listening: Vec<BandRow>,
}

fn tables() -> &'static BandTables {
    static TABLES: OnceLock<BandTables> = OnceLock::new();
    TABLES.get_or_init(|| {
        serde_json::from_str(TABLE_JSON).expect("schema/band-conversion.json must be valid")
    })
}

fn rows_for(module: &str) -> Option<&'static [BandRow]> {
    match module {
        "listening" => Some(tables().listening.as_slice()),
        "reading" => Some(tables().reading_academic.as_slice()),
        _ => None,
    }
}

/// Estimated band for a raw score out of 40. `None` when the module has no
/// objective raw score (writing) or the score falls below the published table —
/// the UI shows `—` rather than inventing a number.
pub fn raw_to_band(module: &str, raw: u32) -> Option<f64> {
    let rows = rows_for(module)?;
    for row in rows {
        if raw >= row.min && raw <= row.max {
            return Some(row.band);
        }
    }
    match rows.first() {
        Some(top) if raw > top.max => Some(top.band),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_published_boundaries() {
        assert_eq!(raw_to_band("listening", 40), Some(9.0));
        assert_eq!(raw_to_band("listening", 30), Some(7.0));
        assert_eq!(raw_to_band("listening", 23), Some(6.0));
        assert_eq!(raw_to_band("reading", 30), Some(7.0));
        assert_eq!(raw_to_band("reading", 20), Some(5.5));
    }

    #[test]
    fn returns_none_below_the_table_and_for_writing() {
        assert_eq!(raw_to_band("listening", 9), None);
        assert_eq!(raw_to_band("reading", 3), None);
        assert_eq!(raw_to_band("writing", 30), None);
    }

    #[test]
    fn agrees_with_the_frontend_table_not_with_the_old_formula() {
        // The removed formula produced 23/40*9 = 5.175 for a real band 6.0.
        let band = raw_to_band("listening", 23).unwrap();
        assert!((band - 6.0).abs() < f64::EPSILON);
        assert!((band - (23.0 / 40.0) * 9.0).abs() > 0.5);
    }
}
