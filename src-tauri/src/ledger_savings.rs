//! Unified savings ledger reader.
//!
//! The proxy writes every savings event (proxy HTTP compressions AND MCP tool
//! compressions from `headroom_compress`, plus any other source) to
//! `~/.headroom/savings_events.jsonl` — the append-only, durable ledger. The
//! backend's `/stats` `summary.mcp` block only surfaces the last 2h of MCP
//! work (`SESSION_WINDOW_SECONDS`), so it is useless for a lifetime figure.
//!
//! This module reads the ledger directly so the dashboard's lifetime total can
//! include the non-proxy layers (MCP tools, CLI-side work, ...) without ever
//! double-counting: each tuple (ts, source, pid) appears once in the ledger,
//! the proxy HTTP layer and the MCP tool layer are disjoint, and we only add
//! the rows the daily buckets do NOT already carry (`source != "proxy"`).
//!
//! The proxy's own rows are deliberately excluded here: the tracker's daily
//! buckets already account for every proxy request through the `/stats` poll
//! delta path, so counting them again would inflate the total. Non-proxy rows
//! (`source: "mcp"`, `"cli"`, ...) are exactly the gap the `/stats` path never
//! sees and never reports.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Path to the backend's durable savings ledger. Mirrors the backend's
/// `workspace_dir()` default of `~/.headroom` (same as
/// `output_savings::ledger_path`).
pub fn ledger_path() -> Option<PathBuf> {
    let home = crate::client_adapters::home_dir();
    Some(home.join(".headroom").join("savings_events.jsonl"))
}

/// One aggregated non-proxy row, bucketed by UTC day.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DayAccumulator {
    tokens_saved: u64,
}

/// Aggregated savings from the ledger, bucketed by UTC day and by sender.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerSavings {
    /// UTC day key (`YYYY-MM-DD`) → tokens saved by non-proxy sources.
    pub by_utc_day: BTreeMap<String, u64>,
    /// UTC day key → sender (`client` field) → tokens saved. Covers every
    /// source (proxy + MCP + CLI) so the history chart can show who saved
    /// what; senders are the raw `client` labels from the events.
    pub by_source_day: BTreeMap<String, BTreeMap<String, u64>>,
    /// Sum across every day in `by_utc_day`.
    pub total_tokens_saved: u64,
}

/// Result of one ledger read. `Missing`/`Unreadable` map to an empty read
/// (callers render zero and keep whatever they already hold); `Ok` carries the
/// aggregated rows. `CacheMiss` is internal.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LedgerRead {
    Ok(LedgerSavings),
    Missing,
    Unreadable,
}

/// Small TTL cache so `build_dashboard` (which runs on every poll and UI
/// access) does not re-read and re-parse the whole file each time.
static CACHE: Mutex<Option<(PathBuf, Instant, LedgerSavings)>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(15);

fn parse_iso_day(ts: &str) -> Option<String> {
    // Accepts `2026-11-25T10:33:02...` (and bare `2026-11-25`).
    ts.get(0..10).map(str::to_string)
}

fn read_ledger(path: &PathBuf) -> LedgerRead {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LedgerRead::Missing,
        Err(_) => return LedgerRead::Unreadable,
    };
    let reader = BufReader::new(file);
    let mut acc: BTreeMap<String, DayAccumulator> = BTreeMap::new();
    let mut by_source_day: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut total: u64 = 0;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // torn line mid-write; skip it
        };
        let saved = value
            .get("saved")
            .and_then(|s| s.as_u64())
            .unwrap_or_else(|| {
                value
                    .get("saved")
                    .and_then(|s| s.as_i64())
                    .map(|v| v.max(0) as u64)
                    .unwrap_or(0)
            });
        if saved == 0 {
            continue;
        }
        // Attribute to UTC day: the ledger timestamps are UTC ISO-8601 and the
        // tracker's daily buckets join on UTC day keys.
        let day = value
            .get("ts")
            .and_then(|t| t.as_str())
            .and_then(parse_iso_day);

        // Per-sender breakdown covers every source (proxy + MCP + CLI): this is
        // the only place the history chart can learn WHO saved tokens.
        let client = value
            .get("client")
            .and_then(|c| c.as_str())
            .map(|c| c.trim())
            .filter(|c| !c.is_empty())
            .unwrap_or("unknown");
        // The tracker's own health rows record client "proxy"; treat them as
        // unknown — they are the proxy itself, not an end user.
        let client = if client == "proxy" || client == "probe" {
            "unknown"
        } else {
            client
        };
        if let Some(day) = day.as_deref() {
            *by_source_day
                .entry(day.to_string())
                .or_default()
                .entry(client.to_string())
                .or_insert(0) += saved;
        }

        // Only count rows the daily buckets do not already carry.
        let source = value.get("source").and_then(|s| s.as_str()).unwrap_or("");
        if source == "proxy" {
            continue;
        }
        match day {
            Some(day) => {
                let entry = acc.entry(day).or_insert(DayAccumulator { tokens_saved: 0 });
                entry.tokens_saved = entry.tokens_saved.saturating_add(saved);
                total = total.saturating_add(saved);
            }
            None => {
                // No usable timestamp: still count toward the total so the
                // cumulative number never silently loses a row.
                total = total.saturating_add(saved);
            }
        }
    }

    let by_utc_day = acc
        .into_iter()
        .map(|(day, a)| (day, a.tokens_saved))
        .collect();
    LedgerRead::Ok(LedgerSavings {
        by_utc_day,
        by_source_day,
        total_tokens_saved: total,
    })
}

/// Aggregate non-proxy savings from the ledger, using a short TTL cache keyed
/// by the resolved path (so a HOME swap — tests, a different user — never
/// serves another profile's ledger).
pub fn aggregated() -> LedgerSavings {
    let path = match ledger_path() {
        Some(path) => path,
        None => return LedgerSavings::default(),
    };
    if let Ok(cache) = CACHE.lock() {
        if let Some((cached_path, at, value)) = cache.as_ref() {
            if cached_path == &path && at.elapsed() < CACHE_TTL {
                return value.clone();
            }
        }
    }
    let value = match read_ledger(&path) {
        LedgerRead::Ok(value) => value,
        LedgerRead::Missing | LedgerRead::Unreadable => LedgerSavings::default(),
    };
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((path, Instant::now(), value.clone()));
    }
    value
}

/// Drop the TTL cache. Tests write temporary ledgers and must not read a
/// stale cached value; nothing at runtime calls this.
#[cfg(test)]
pub(crate) fn clear_cache_for_tests() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp(tag: &str, rows: &[&str]) -> PathBuf {
        clear_cache_for_tests();
        let dir = std::env::temp_dir().join(format!(
            "ledger_savings_test_{}_{}",
            tag,
            rand_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("savings_events.jsonl");
        let mut content = String::new();
        for row in rows {
            content.push_str(row);
            content.push('\n');
        }
        std::fs::write(&path, content).unwrap();
        path
    }

    #[allow(clippy::needless_pass_by_value)]
    fn rand_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }

    #[test]
    fn sums_only_non_proxy_rows_per_utc_day() {
        let path = write_tmp("sums_only_non_proxy", &[
            r#"{"ts":"2026-11-25T10:00:00+00:00","saved":371,"source":"mcp","pid":1,"client":"cursor-vscode"}"#,
            r#"{"ts":"2026-11-25T11:00:00+00:00","saved":4000,"source":"mcp","pid":2,"client":"probe"}"#,
            r#"{"ts":"2026-11-25T09:00:00+00:00","saved":5000,"source":"proxy","pid":3,"client":"claude-code"}"#,
            r#"{"ts":"2026-11-24T08:00:00+00:00","saved":100,"source":"cli","pid":4,"client":"opencode"}"#,
        ]);
        let value = read_ledger(&path);
        match value {
            LedgerRead::Ok(savings) => {
                assert_eq!(savings.total_tokens_saved, 371 + 4000 + 100);
                assert_eq!(savings.by_utc_day.get("2026-11-25"), Some(&4371));
                assert_eq!(savings.by_utc_day.get("2026-11-24"), Some(&100));
                assert_eq!(savings.by_utc_day.get("2026-11-23"), None);
                // Per-sender: all sources, probe folded into unknown.
                let day25 = savings.by_source_day.get("2026-11-25").unwrap();
                assert_eq!(day25.get("cursor-vscode"), Some(&371));
                assert_eq!(day25.get("unknown"), Some(&4000));
                assert_eq!(day25.get("claude-code"), Some(&5000));
                let day24 = savings.by_source_day.get("2026-11-24").unwrap();
                assert_eq!(day24.get("opencode"), Some(&100));
            }
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn empty_missing_reads_as_default() {
        let path = write_tmp("empty_missing", &[]);
        match read_ledger(&path) {
            LedgerRead::Ok(savings) => {
                assert_eq!(savings.total_tokens_saved, 0);
                assert!(savings.by_source_day.is_empty());
            }
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn torn_line_skipped_without_losing_others() {
        let path = write_tmp("torn_line", &[
            r#"{"ts":"2026-11-25T10:00:00+00:00","saved":371,"source":"mcp","pid":1}"#,
            r#"{"ts":"2026-11-25T10:0"#,
            r#"{"ts":"2026-11-25T11:00:00+00:00","saved":9,"source":"mcp","pid":2}"#,
        ]);
        match read_ledger(&path) {
            LedgerRead::Ok(savings) => assert_eq!(savings.total_tokens_saved, 380),
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn missing_day_still_counts_toward_total() {
        let path = write_tmp("missing_day", &[r#"{"saved":42,"source":"cli","pid":9}"#]);
        match read_ledger(&path) {
            LedgerRead::Ok(savings) => {
                assert_eq!(savings.total_tokens_saved, 42);
                assert!(savings.by_utc_day.is_empty());
            }
            _ => panic!("expected Ok"),
        }
    }
}
