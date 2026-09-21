//! Proleptic-Gregorian date helpers, no external crates. These used to live as
//! three near-identical copies in commands.rs / study.rs / audio.rs; keep the
//! single implementation here so the math cannot drift.

use std::time::{SystemTime, UNIX_EPOCH};

/// Howard Hinnant's `days_from_civil`; days since 1970-01-01.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of `days_from_civil`.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
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

/// Days since 1970-01-01 for the `YYYY-MM-DD` prefix of an ISO 8601 string.
pub(crate) fn iso_epoch_day(value: &str) -> Option<i64> {
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
    Some(days_from_civil(year, month, day))
}

/// `YYYY-MM-DD` for an epoch day.
pub(crate) fn iso_from_epoch_day(day: i64) -> String {
    let (year, month, dom) = civil_from_days(day);
    format!("{year:04}-{month:02}-{dom:02}")
}

/// Today as days since the Unix epoch (UTC).
pub(crate) fn epoch_day_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`. The frontend sends timestamps
/// for anything user-visible; this is only a fallback so a record is never
/// written without one.
pub(crate) fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
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

#[cfg(test)]
mod tests {
    use super::{civil_from_days, days_from_civil, iso_epoch_day, iso_from_epoch_day, now_iso};

    #[test]
    fn epoch_day_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 8, 24), 20_689);
        assert_eq!(iso_epoch_day("2026-08-24T10:12:00Z"), Some(20_689));
        assert_eq!(
            iso_epoch_day("2026-08-25T00:00:00Z").unwrap()
                - iso_epoch_day("2026-08-24T23:59:00Z").unwrap(),
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
    fn civil_round_trip() {
        for day in [-719_468, -1, 0, 1, 20_689, 100_000] {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day, "round trip failed for {day}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(iso_from_epoch_day(0), "1970-01-01");
        assert_eq!(iso_from_epoch_day(20_689), "2026-08-24");
    }

    #[test]
    fn now_iso_is_well_formed() {
        let stamp = now_iso();
        assert_eq!(stamp.len(), 20);
        assert!(stamp.ends_with('Z'));
        assert!(iso_epoch_day(&stamp).is_some());
    }
}
