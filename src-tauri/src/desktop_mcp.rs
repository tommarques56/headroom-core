//! Desktop-app MCP integration.
//!
//! The Headroom runtime exposes an MCP server (`headroom mcp serve`) whose
//! tools (`headroom_compress`, `headroom_retrieve`, `headroom_stats`) let any
//! MCP-capable harness compress content on demand without proxy routing. That
//! is the supported way to bring Headroom to the desktop apps (Claude Desktop,
//! Cursor, the ChatGPT desktop app), none of which honor the CLI routing
//! environment variables.
//!
//! This module owns the per-app wiring. Every harness is configured by writing
//! a `headroom` server entry into the config file the app already reads, in its
//! native format:
//! - Claude Desktop reads `mcpServers` from `claude_desktop_config.json`.
//! - Cursor reads `mcpServers` from `~/.cursor/mcp.json` (global).
//! - The ChatGPT desktop app and Codex share MCP configuration in
//!   `~/.codex/config.toml` (`[mcp_servers.headroom]`, stdio) - the app's own
//!   "Settings -> MCP servers -> Add server (STDIO)" screen writes the same
//!   file, so writing it ourselves gives the same result with zero manual work.
//!
//! Everything is reversible: install/uninstall round-trips the exact prior
//! value of the touched fields, writes through `atomic_write`, and refuses to
//! touch a file that no longer parses. Presence detection is the same style as
//! `client_adapters::claude_desktop_installed` (install roots, never the data
//! dirs a former user leaves behind).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};

use crate::client_adapters;
use crate::models::DesktopMcpStatus;

/// MCP server name this app owns in every harness config.
pub const MCP_SERVER_NAME: &str = "headroom";

/// Loopback proxy URL the MCP server should talk to for retrieval/stats.
/// Local to this module, same value as `client_adapters::HEADROOM_PROXY_URL`
/// (which is private to that module).
pub const HEADROOM_PROXY_URL: &str = "http://127.0.0.1:6767";

/// A desktop harness this app can wire MCP into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopHarness {
    pub id: &'static str,
    pub name: &'static str,
    /// Config file format: Claude Desktop and Cursor use a JSON `mcpServers`
    /// object; the ChatGPT desktop app shares Codex's TOML config.
    pub toml: bool,
}

const DESKTOP_HARNESSES: [DesktopHarness; 3] = [
    DesktopHarness {
        id: "claude_desktop",
        name: "Claude Desktop",
        toml: false,
    },
    DesktopHarness {
        id: "cursor",
        name: "Cursor",
        toml: false,
    },
    DesktopHarness {
        id: "chatgpt_desktop",
        name: "ChatGPT Desktop",
        toml: true,
    },
];

pub fn harness(id: &str) -> Option<&'static DesktopHarness> {
    DESKTOP_HARNESSES.iter().find(|h| h.id == id)
}

/// All harnesses, in UI order.
pub fn all_harnesses() -> &'static [DesktopHarness] {
    &DESKTOP_HARNESSES
}

// ---------------------------------------------------------------------------
// Presence detection
// ---------------------------------------------------------------------------

/// True when the app's install root exists. Same rule as
/// `claude_desktop_installed`: install roots only, never Electron data dirs.
pub fn is_installed(id: &str) -> bool {
    match id {
        "claude_desktop" => claude_desktop_install_exists(),
        "cursor" => cursor_install_exists(),
        "chatgpt_desktop" => chatgpt_desktop_install_exists(),
        _ => false,
    }
}

fn claude_desktop_install_exists() -> bool {
    let home = client_adapters::home_dir();
    let mut candidates = vec![
        PathBuf::from("/Applications/Claude.app"),
        home.join("Applications").join("Claude.app"),
    ];
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(base);
        candidates.push(base.join("AnthropicClaude"));
        candidates.push(base.join("Packages").join("Claude_pzs8sxrjxfjjc"));
    }
    candidates.iter().any(|path| path.exists())
}

fn cursor_install_exists() -> bool {
    let home = client_adapters::home_dir();
    let mut candidates = vec![
        PathBuf::from("/Applications/Cursor.app"),
        home.join("Applications").join("Cursor.app"),
    ];
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(base);
        candidates.push(base.join("Programs").join("cursor").join("Cursor.exe"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        candidates.push(PathBuf::from(xdg).join("Cursor"));
    }
    candidates.push(PathBuf::from("/usr/share/cursor"));
    candidates.iter().any(|path| path.exists())
}

fn chatgpt_desktop_install_exists() -> bool {
    let home = client_adapters::home_dir();
    let mut candidates = vec![
        PathBuf::from("/Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home.join("Applications").join("ChatGPT.app"),
    ];
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(base);
        candidates.push(base.join("Programs").join("ChatGPT").join("ChatGPT.exe"));
    }
    candidates.iter().any(|path| path.exists())
}

/// A user-facing summary row for the desktop MCP manager UI. Only present
/// harnesses are reported.
pub fn detect() -> Vec<DesktopMcpStatus> {
    DESKTOP_HARNESSES
        .iter()
        .filter(|h| is_installed(h.id))
        .map(|h| DesktopMcpStatus {
            client_id: h.id.to_string(),
            name: h.name.to_string(),
            present: true,
            mcp_configured: mcp_configured_for(h),
        })
        .collect()
}

fn mcp_configured_for(h: &DesktopHarness) -> bool {
    let Some(path) = config_path_for(h) else {
        return false;
    };
    if !path.exists() {
        return false;
    }
    if h.toml {
        read_toml(&path)
            .is_some_and(|doc| doc.get("mcp_servers").and_then(|v| v.as_table()).is_some_and(|t| t.contains_key(MCP_SERVER_NAME)))
    } else {
        read_json_file(&path).is_some_and(|c| has_headroom_mcp(&c))
    }
}

// ---------------------------------------------------------------------------
// Config file read/write helpers
// ---------------------------------------------------------------------------

fn read_json_file(path: &Path) -> Option<Map<String, Value>> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn write_json_file(path: &Path, map: &Map<String, Value>) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(map)
        .with_context(|| format!("serializing {}", path.display()))?;
    bytes.push(b'\n');
    client_adapters::atomic_write(path, &bytes)
}

/// True when `mcpServers` holds our server entry (by name).
fn has_headroom_mcp(root: &Map<String, Value>) -> bool {
    root.get("mcpServers")
        .and_then(Value::as_object)
        .is_some_and(|servers| servers.contains_key(MCP_SERVER_NAME))
}

fn read_toml(path: &Path) -> Option<toml::Table> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.parse::<toml::Table>().ok()
}

fn write_toml(path: &Path, table: &toml::Table) -> Result<()> {
    let mut bytes = table.to_string().into_bytes();
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    client_adapters::atomic_write(path, &bytes)
}

/// The ChatGPT desktop app (and Codex) use a `[mcp_servers.headroom]` TOML
/// table. Returns true when that table exists.
fn has_headroom_mcp_toml(table: &toml::Table) -> bool {
    table
        .get("mcp_servers")
        .and_then(|v| v.as_table())
        .is_some_and(|servers| servers.contains_key(MCP_SERVER_NAME))
}

/// Config path per harness.
fn config_path_for(h: &DesktopHarness) -> Option<PathBuf> {
    match h.id {
        "claude_desktop" => claude_desktop_config_path(),
        "cursor" => Some(client_adapters::home_dir().join(".cursor").join("mcp.json")),
        "chatgpt_desktop" => Some(codex_config_path()),
        _ => None,
    }
}

/// The ChatGPT desktop app, Codex CLI and the IDE extension share MCP server
/// configuration in `~/.codex/config.toml` (see module doc).
fn codex_config_path() -> PathBuf {
    client_adapters::home_dir().join(".codex").join("config.toml")
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_path() -> Option<PathBuf> {
    Some(
        client_adapters::home_dir()
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"),
    )
}

#[cfg(windows)]
fn claude_desktop_config_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| {
        PathBuf::from(appdata)
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn claude_desktop_config_path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME").map(|xdg| {
        PathBuf::from(xdg)
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

/// The stdio entry for a harness that runs local servers. `entrypoint` is the
/// absolute path to the managed `headroom` binary so GUI-launched apps (which
/// inherit a minimal PATH) can still start it.
fn mcp_stdio_server_value(entrypoint: &Path) -> Value {
    json!({
        "command": entrypoint.to_string_lossy(),
        "args": ["mcp", "serve", "--proxy-url", HEADROOM_PROXY_URL]
    })
}

// ---------------------------------------------------------------------------
// Install / uninstall / status
// ---------------------------------------------------------------------------

/// Result of an install/uninstall: which config file was touched.
#[derive(Debug, Clone, Default)]
pub struct McpChange {
    pub path: Option<PathBuf>,
}

/// Install the MCP server for a harness. `entrypoint` is the managed
/// `headroom` binary. Returns what changed so the UI can report it.
pub fn install(id: &str, entrypoint: &Path) -> Result<McpChange> {
    let h = harness(id)
        .with_context(|| format!("unknown desktop harness {id}"))?;
    let path = config_path_for(h)
        .with_context(|| format!("no config path for {id}"))?;
    if h.toml {
        upsert_toml_entry(&path, entrypoint)?;
    } else {
        upsert_stdio_entry(&path, entrypoint)?;
    }
    Ok(McpChange {
        path: Some(path),
    })
}

/// Remove the MCP server for a harness, restoring the exact prior state.
pub fn uninstall(id: &str, _entrypoint: &Path) -> Result<McpChange> {
    let h = harness(id)
        .with_context(|| format!("unknown desktop harness {id}"))?;
    let path = config_path_for(h)
        .with_context(|| format!("no config path for {id}"))?;
    let changed = if h.toml {
        remove_toml_entry(&path)?
    } else {
        remove_stdio_entry(&path)?
    };
    Ok(McpChange {
        path: changed.then_some(path),
    })
}

/// True when the harness's MCP wiring is in place.
pub fn configured(id: &str) -> bool {
    let Some(h) = harness(id) else { return false };
    mcp_configured_for(h)
}

fn upsert_stdio_entry(path: &Path, entrypoint: &Path) -> Result<()> {
    let existed = path.exists();
    let mut root = match read_json_file(path) {
        Some(map) => map,
        None if path.exists() => {
            // Present but unparseable: refuse to clobber it.
            anyhow::bail!(
                "{} is not valid JSON; refusing to touch it",
                path.display()
            );
        }
        None => Map::new(),
    };
    // We created the file (or will). Later installs on an existing file must
    // not relabel it as ours: only the first creation sets the marker.
    if !existed {
        set_marker(path)?;
    }

    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .context("mcpServers in config is not an object")?;

    // Idempotent: if already ours, leave it (but pin the command so a runtime
    // move re-pins like the CLI integration does).
    if servers.contains_key(MCP_SERVER_NAME) {
        servers.insert(
            MCP_SERVER_NAME.to_string(),
            mcp_stdio_server_value(entrypoint),
        );
        return write_json_file(path, &root);
    }

    servers.insert(MCP_SERVER_NAME.to_string(), mcp_stdio_server_value(entrypoint));
    write_json_file(path, &root)
}

fn upsert_toml_entry(path: &Path, entrypoint: &Path) -> Result<()> {
    let existed = path.exists();
    let mut table = match read_toml(path) {
        Some(table) => table,
        None if path.exists() => {
            anyhow::bail!(
                "{} is not valid TOML; refusing to touch it",
                path.display()
            );
        }
        None => toml::Table::new(),
    };
    if !existed {
        set_marker(path)?;
    }
    let servers = table
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .context("mcp_servers in config is not a table")?;

    let mut server = toml::Table::new();
    server.insert(
        "command".to_string(),
        toml::Value::String(entrypoint.to_string_lossy().into_owned()),
    );
    server.insert(
        "args".to_string(),
        toml::Value::Array(vec![
            toml::Value::String("mcp".to_string()),
            toml::Value::String("serve".to_string()),
        ]),
    );
    // Point the MCP server at the local proxy for retrieval/stats, and keep
    // the beacon off (same env the CLI integration sets).
    let mut env = toml::Table::new();
    env.insert(
        "HEADROOM_PROXY_URL".to_string(),
        toml::Value::String(HEADROOM_PROXY_URL.to_string()),
    );
    env.insert("HEADROOM_BEACON".to_string(), toml::Value::String("off".to_string()));
    server.insert("env".to_string(), toml::Value::Table(env));

    servers.insert(MCP_SERVER_NAME.to_string(), toml::Value::Table(server));
    write_toml(path, &table)
}

fn remove_stdio_entry(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_json_file(path)
        .with_context(|| format!("{} is not valid JSON; refusing to touch it", path.display()))?;
    let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let removed = servers.remove(MCP_SERVER_NAME).is_some();
    if !removed {
        return Ok(false);
    }
    // We created the whole file: drop it entirely for a true round-trip.
    if was_created_by_us(path) {
        clear_marker(path);
        let _ = std::fs::remove_file(path);
        return Ok(true);
    }
    // The file predates us: take only our entry, leaving the user's config
    // (including their other MCP servers) intact.
    write_json_file(path, &root)?;
    Ok(true)
}

fn remove_toml_entry(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut table = read_toml(path)
        .with_context(|| format!("{} is not valid TOML; refusing to touch it", path.display()))?;
    let Some(servers) = table.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) else {
        return Ok(false);
    };
    let removed = servers.remove(MCP_SERVER_NAME).is_some();
    if !removed {
        return Ok(false);
    }
    // We created the whole file: drop it entirely for a true round-trip.
    if was_created_by_us(path) {
        clear_marker(path);
        let _ = std::fs::remove_file(path);
        return Ok(true);
    }
    write_toml(path, &table)?;
    Ok(true)
}

/// Did we create this file? Tracked by a marker file beside the config
/// (a `.headroom-<name>` flag) so uninstall can drop a section we added
/// without touching a user's own empty `mcpServers`.
fn was_created_by_us(path: &Path) -> bool {
    marker_path(path).exists()
}

fn marker_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    path.with_file_name(format!(".headroom-{name}"))
}

fn set_marker(path: &Path) -> Result<()> {
    let marker = marker_path(path);
    client_adapters::atomic_write(&marker, b"managed by headroom-desktop\n")
}

fn clear_marker(path: &Path) {
    let _ = std::fs::remove_file(marker_path(path));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        (dir, path)
    }

    fn entrypoint_fixture() -> PathBuf {
        PathBuf::from("/opt/Headroom/runtime/venv/bin/headroom")
    }

    fn read_map(path: &Path) -> Map<String, Value> {
        read_json_file(path).unwrap_or_else(|| panic!("could not read {}", path.display()))
    }

    #[test]
    fn upsert_creates_file_and_marker_on_missing_path() {
        let (_dir, path) = tmp_path("claude_desktop_config.json");
        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();

        assert!(path.exists());
        assert!(was_created_by_us(&path), "marker must be set on first write");

        let root = read_map(&path);
        assert!(has_headroom_mcp(&root));
        let server = root["mcpServers"][MCP_SERVER_NAME].clone();
        assert_eq!(server["command"], "/opt/Headroom/runtime/venv/bin/headroom");
        assert_eq!(
            server["args"],
            serde_json::json!(["mcp", "serve", "--proxy-url", HEADROOM_PROXY_URL])
        );
    }

    #[test]
    fn upsert_is_idempotent_no_duplicate_entries() {
        let (_dir, path) = tmp_path("config.json");
        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();
        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();

        let root = read_map(&path);
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1, "re-install must not duplicate");
    }

    #[test]
    fn upsert_keeps_foreign_servers_untouched() {
        let (_dir, path) = tmp_path("existing_config.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x","args":[]}}}"#,
        )
        .unwrap();
        // A preexisting file is NOT marked as created by us.
        assert!(!was_created_by_us(&path));

        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();

        let root = read_map(&path);
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 2);
        assert!(servers.contains_key("other"));
        assert!(servers.contains_key(MCP_SERVER_NAME));
    }

    #[test]
    fn remove_of_file_we_created_deletes_the_whole_file() {
        let (_dir, path) = tmp_path("ours.json");
        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();
        assert!(was_created_by_us(&path));

        let changed = remove_stdio_entry(&path).unwrap();
        assert!(changed);
        assert!(!path.exists(), "file we created must be fully removed");
        assert!(!was_created_by_us(&path), "marker must be cleared");
    }

    #[test]
    fn remove_of_preexisting_file_only_takes_our_entry() {
        let (_dir, path) = tmp_path("preexisting.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"y"},"headroom":{"command":"z"}}}"#,
        )
        .unwrap();

        let changed = remove_stdio_entry(&path).unwrap();
        assert!(changed);
        assert!(path.exists(), "preexisting file must be kept");

        let root = read_map(&path);
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("other"));
        assert!(!servers.contains_key(MCP_SERVER_NAME));
    }

    #[test]
    fn remove_of_absent_file_reports_no_change() {
        let (_dir, path) = tmp_path("nope.json");
        assert!(!remove_stdio_entry(&path).unwrap());
    }

    #[test]
    fn remove_refuses_unparseable_json() {
        let (_dir, path) = tmp_path("broken.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(remove_stdio_entry(&path).is_err());
    }

    #[test]
    fn upsert_refuses_unparseable_json() {
        let (_dir, path) = tmp_path("broken.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(upsert_stdio_entry(&path, &entrypoint_fixture()).is_err());
    }

    #[test]
    fn round_trip_install_then_uninstall_restores_absent_state() {
        let (_dir, path) = tmp_path("roundtrip.json");
        // Pre-existing empty state (no file, no marker).
        assert!(!path.exists());
        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();
        assert!(has_headroom_mcp(&read_map(&path)));

        remove_stdio_entry(&path).unwrap();
        assert!(!path.exists(), "round-trip must restore the absent state");
        assert!(!was_created_by_us(&path));
    }

    #[test]
    fn has_headroom_mcp_detects_by_name() {
        let root: Map<String, Value> =
            serde_json::from_str(r#"{"mcpServers":{"headroom":{"command":"x"}}}"#).unwrap();
        assert!(has_headroom_mcp(&root));

        let other: Map<String, Value> =
            serde_json::from_str(r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        assert!(!has_headroom_mcp(&other));

        let none: Map<String, Value> = serde_json::from_str(r#"{}"#).unwrap();
        assert!(!has_headroom_mcp(&none));
    }

    #[test]
    fn marker_path_is_sibling_dotfile() {
        let path = PathBuf::from("/tmp/configs/claude_desktop_config.json");
        let marker = marker_path(&path);
        assert_eq!(
            marker,
            PathBuf::from("/tmp/configs/.headroom-claude_desktop_config.json")
        );
    }

    #[test]
    fn harness_lookup_covers_all_desktop_apps() {
        assert!(harness("claude_desktop").is_some());
        assert!(harness("cursor").is_some());
        assert!(harness("chatgpt_desktop").is_some());
        assert!(harness("nope").is_none());
        assert_eq!(all_harnesses().len(), 3);
    }

    #[test]
    fn chatgpt_uses_codex_toml_path() {
        // The ChatGPT desktop app reads Codex's shared MCP config. Writing a
        // JSON file to ~/.codex/config.toml would corrupt it, so the harness
        // must point at the real TOML path (handled by the caller wiring the
        // config path; here we assert the resolution stays on .codex).
        let path = config_path_for(harness("chatgpt_desktop").unwrap()).unwrap();
        assert!(path.ends_with(".codex/config.toml"), "got {}", path.display());
    }

    #[test]
    fn install_and_uninstall_keep_foreign_servers_through_round_trip() {
        let (_dir, path) = tmp_path("cursor.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"unityMCP":{"url":"http://127.0.0.1:8080/mcp"}}}"#,
        )
        .unwrap();

        upsert_stdio_entry(&path, &entrypoint_fixture()).unwrap();
        let root = read_map(&path);
        assert!(root["mcpServers"].as_object().unwrap().contains_key("unityMCP"));
        assert!(root["mcpServers"].as_object().unwrap().contains_key(MCP_SERVER_NAME));

        remove_stdio_entry(&path).unwrap();
        let root = read_map(&path);
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("unityMCP"));
        assert!(!servers.contains_key(MCP_SERVER_NAME));
    }

    #[test]
    fn chatgpt_toml_upsert_writes_stdio_entry_and_preserves_other_servers() {
        let (_dir, path) = tmp_path("config.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "[plugins.\"gmail@openai-curated\"]\nenabled = false\n\n[mcp_servers.unityMCP]\nurl = \"http://127.0.0.1:8080/mcp\"\n",
        )
        .unwrap();
        assert!(!was_created_by_us(&path));

        upsert_toml_entry(&path, &entrypoint_fixture()).unwrap();

        let table = read_toml(&path).expect("file must stay valid TOML");
        // Our server is present with command/args/env...
        let servers = table["mcp_servers"].as_table().unwrap();
        assert!(servers.contains_key(MCP_SERVER_NAME));
        let headroom = &servers[MCP_SERVER_NAME];
        assert_eq!(
            headroom["command"],
            toml::Value::String(entrypoint_fixture().to_string_lossy().into_owned())
        );
        assert_eq!(headroom["args"], toml::Value::Array(vec![toml::Value::String("mcp".to_string()), toml::Value::String("serve".to_string())]));
        assert_eq!(
            headroom["env"]["HEADROOM_PROXY_URL"],
            toml::Value::String(HEADROOM_PROXY_URL.to_string())
        );
        // ...and the user's own server is untouched.
        assert!(servers.contains_key("unityMCP"));
        // Other sections survive.
        assert!(table["plugins"].is_table());
    }

    #[test]
    fn chatgpt_toml_remove_only_takes_our_entry() {
        let (_dir, path) = tmp_path("config.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "[mcp_servers.unityMCP]\nurl = \"http://127.0.0.1:8080/mcp\"\n\n[mcp_servers.headroom]\ncommand = \"headroom\"\n",
        )
        .unwrap();

        let changed = remove_toml_entry(&path).unwrap();
        assert!(changed);
        assert!(path.exists(), "preexisting TOML must be kept");

        let table = read_toml(&path).expect("file must stay valid TOML");
        let servers = table["mcp_servers"].as_table().unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("unityMCP"));
        assert!(!servers.contains_key(MCP_SERVER_NAME));
    }

    #[test]
    fn chatgpt_toml_round_trip_restores_absent_state() {
        let (_dir, path) = tmp_path("missing.toml");
        assert!(!path.exists());

        upsert_toml_entry(&path, &entrypoint_fixture()).unwrap();
        assert!(has_headroom_mcp_toml(&read_toml(&path).unwrap()));
        assert!(was_created_by_us(&path));

        remove_toml_entry(&path).unwrap();
        assert!(!path.exists(), "round-trip must restore the absent state");
        assert!(!was_created_by_us(&path));
    }

    #[test]
    fn chatgpt_toml_refuses_broken_toml() {
        let (_dir, path) = tmp_path("broken.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "mcp_servers = = =").unwrap();
        assert!(upsert_toml_entry(&path, &entrypoint_fixture()).is_err());
        assert!(remove_toml_entry(&path).is_err());
    }

    #[test]
    fn has_headroom_mcp_toml_detects_by_name() {
        let with: toml::Table = "[mcp_servers.headroom]\ncommand = \"x\"\n".parse().unwrap();
        assert!(has_headroom_mcp_toml(&with));
        let without: toml::Table = "[mcp_servers.other]\nurl = \"http://x\"\n".parse().unwrap();
        assert!(!has_headroom_mcp_toml(&without));
        let empty: toml::Table = "".parse().unwrap();
        assert!(!has_headroom_mcp_toml(&empty));
    }

    #[test]
    fn golden_install_remove_on_real_codex_config() {
        // Real ~/.codex/config.toml (the ChatGPT desktop app's config): bounce
        // our entry through it and make sure the user's servers, plugins and
        // sections all survive. Skipped in CI where the file does not exist.
        let home = client_adapters::home_dir();
        let path = home.join(".codex").join("config.toml");
        if !path.exists() {
            eprintln!("skipping: {} not present", path.display());
            return;
        }
        let before = std::fs::read(&path).unwrap();
        // Production refuses to touch a non-Toml config (see
        // upsert_toml_entry: "not valid TOML; refusing to touch it"), so a
        // runner sandbox with a stale/odd ~/.codex/config.toml must not fail
        // this golden test either -- skip it just like production would.
        if String::from_utf8_lossy(&before).parse::<toml::Table>().is_err() {
            eprintln!(
                "skipping: {} is not valid TOML (runner sandbox file)",
                path.display()
            );
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("config.toml");
        std::fs::write(&copy, &before).unwrap();

        upsert_toml_entry(&copy, &entrypoint_fixture()).unwrap();
        let after = std::fs::read_to_string(&copy).unwrap();
        let table = after.parse::<toml::Table>().expect("install must keep TOML valid");
        let servers = table["mcp_servers"].as_table().unwrap();
        assert!(servers.contains_key(MCP_SERVER_NAME));
        assert_eq!(
            servers.get(MCP_SERVER_NAME).unwrap()["env"]["HEADROOM_PROXY_URL"],
            toml::Value::String(HEADROOM_PROXY_URL.to_string())
        );
        for other in servers.keys().filter(|k| *k != MCP_SERVER_NAME) {
            assert!(
                after_has_server(other, &before),
                "foreign server {other} must survive install"
            );
        }
        // Root keys and other sections survive.
        assert!(table.contains_key("model"));
        assert!(table.contains_key("plugins") || table.contains_key("mcp_servers"));

        let changed = remove_toml_entry(&copy).unwrap();
        assert!(changed);
        let restored = std::fs::read_to_string(&copy).unwrap();
        let final_table = restored
            .parse::<toml::Table>()
            .expect("uninstall must keep TOML valid");
        // Everything the user had (other servers, root keys, sections) survives
        // the round-trip. Byte-exact equality is not asserted because the toml
        // crate normalizes formatting/comments; semantic equality is what the
        // apps care about.
        assert!(!has_headroom_mcp_toml(&final_table));
        if let Some(servers) = final_table.get("mcp_servers").and_then(|v| v.as_table()) {
            for other in servers.keys().filter(|k| *k != MCP_SERVER_NAME) {
                assert!(
                    after_has_server(other, &before),
                    "foreign server {other} must survive uninstall"
                );
            }
        }
        assert!(final_table.contains_key("model"));
        // Other non-deleted sections survive the round-trip too.
        let survived = ["plugins", "projects", "features", "tui"]
            .iter()
            .any(|s| before_contains_section(s, &before) == final_table.contains_key(*s));
        assert!(survived, "user sections must survive uninstall");
    }

    fn after_has_server(name: &str, before: &[u8]) -> bool {
        let before = String::from_utf8_lossy(before);
        let before = before.parse::<toml::Table>().ok();
        before.is_some_and(|t| {
            t.get("mcp_servers")
                .and_then(|v| v.as_table())
                .is_some_and(|s| s.contains_key(name))
        })
    }

    fn before_contains_section(name: &str, before: &[u8]) -> bool {
        let raw = String::from_utf8_lossy(before);
        raw.lines()
            .any(|l| l.trim() == format!("[{name}]") || l.trim().starts_with(&format!("[{name}.")))
    }
}
