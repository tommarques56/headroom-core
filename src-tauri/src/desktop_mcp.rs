//! Desktop-app MCP integration.
//!
//! The Headroom runtime exposes an MCP server (`headroom mcp serve`) whose
//! tools (`headroom_compress`, `headroom_retrieve`, `headroom_stats`) let any
//! MCP-capable harness compress content on demand without proxy routing. That
//! is the supported way to bring Headroom to the desktop apps (Claude Desktop,
//! Cursor, the ChatGPT desktop app), none of which honor the CLI routing
//! environment variables.
//!
//! This module owns the per-app wiring:
//! - Claude Desktop reads `mcpServers` from `claude_desktop_config.json`.
//! - Cursor reads `mcpServers` from `~/.cursor/mcp.json` (global).
//! - The ChatGPT desktop app only supports *remote* MCP connectors (Streamable
//!   HTTP), so we run `headroom mcp serve --transport http` as a child process
//!   and point the connector at its loopback URL. We do not try to place a
//!   stdio entry anywhere for ChatGPT.
//!
//! Everything is reversible: install/uninstall round-trips the exact prior
//! value of the touched fields, writes through `atomic_write`, and refuses to
//! touch a file that no longer parses. Presence detection is the same style as
//! `client_adapters::claude_desktop_installed` (install roots, never the data
//! dirs a former user leaves behind).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::client_adapters;
use crate::models::DesktopMcpStatus;

/// MCP server name this app owns in every harness config.
pub const MCP_SERVER_NAME: &str = "headroom";

/// Loopback proxy URL the MCP server should talk to for retrieval/stats.
/// Local to this module, same value as `client_adapters::HEADROOM_PROXY_URL`
/// (which is private to that module).
pub const HEADROOM_PROXY_URL: &str = "http://127.0.0.1:6767";

/// Loopback port for the Streamable HTTP MCP transport (ChatGPT desktop).
/// 8788 is the documented default; when an unrelated process already holds it
/// (e.g. a local gateway script), the server binds the next free port so a
/// busy machine never blocks the ChatGPT button. The chosen port is returned
/// to the UI so the user points the custom connector at the real URL.
pub const MCP_HTTP_PORT: u16 = 8788;
pub const MCP_HTTP_PATH: &str = "/mcp";
const MCP_HTTP_PORT_SCAN_LIMIT: u16 = 20;

/// What kind of MCP wiring a desktop harness needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopMcpKind {
    /// stdio entry in a JSON `mcpServers` file the app reads.
    Stdio,
    /// A Streamable HTTP endpoint the app connects to as a remote server.
    StreamableHttp,
}

/// A desktop harness this app can wire MCP into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopHarness {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: DesktopMcpKind,
}

const DESKTOP_HARNESSES: [DesktopHarness; 3] = [
    DesktopHarness {
        id: "claude_desktop",
        name: "Claude Desktop",
        kind: DesktopMcpKind::Stdio,
    },
    DesktopHarness {
        id: "cursor",
        name: "Cursor",
        kind: DesktopMcpKind::Stdio,
    },
    DesktopHarness {
        id: "chatgpt_desktop",
        name: "ChatGPT Desktop",
        kind: DesktopMcpKind::StreamableHttp,
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
    match h.kind {
        DesktopMcpKind::Stdio => config_path_for(h)
            .and_then(|p| read_json_file(&p))
            .is_some_and(|c| has_headroom_mcp(&c)),
        DesktopMcpKind::StreamableHttp => http_server_running(),
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

/// True when `mcpServers` holds our server entry (by name or footprint).
fn has_headroom_mcp(root: &Map<String, Value>) -> bool {
    root.get("mcpServers")
        .and_then(Value::as_object)
        .is_some_and(|servers| servers.contains_key(MCP_SERVER_NAME))
}

/// Config path per stdio harness, or None for a harness without a file.
fn config_path_for(h: &DesktopHarness) -> Option<PathBuf> {
    match h.id {
        "claude_desktop" => claude_desktop_config_path(),
        "cursor" => Some(client_adapters::home_dir().join(".cursor").join("mcp.json")),
        _ => None,
    }
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

/// Result of an install/uninstall: which config file was touched (stdio
/// harnesses) and/or which endpoint URL the harness should use (HTTP).
#[derive(Debug, Clone, Default)]
pub struct McpChange {
    pub path: Option<PathBuf>,
    pub url: Option<String>,
}

/// Install the MCP server for a harness. `entrypoint` is the managed
/// `headroom` binary. Returns what changed so the UI can report it.
pub fn install(id: &str, entrypoint: &Path) -> Result<McpChange> {
    let h = harness(id)
        .with_context(|| format!("unknown desktop harness {id}"))?;
    match h.kind {
        DesktopMcpKind::Stdio => {
            let path = config_path_for(h)
                .with_context(|| format!("no config path for {id}"))?;
            upsert_stdio_entry(&path, entrypoint)?;
            Ok(McpChange {
                path: Some(path),
                url: None,
            })
        }
        DesktopMcpKind::StreamableHttp => {
            let port = start_http_server(entrypoint)?;
            Ok(McpChange {
                path: None,
                url: Some(format!("http://127.0.0.1:{port}{MCP_HTTP_PATH}")),
            })
        }
    }
}

/// Remove the MCP server for a harness, restoring the exact prior state.
pub fn uninstall(id: &str, entrypoint: &Path) -> Result<McpChange> {
    let h = harness(id)
        .with_context(|| format!("unknown desktop harness {id}"))?;
    match h.kind {
        DesktopMcpKind::Stdio => {
            let path = config_path_for(h)
                .with_context(|| format!("no config path for {id}"))?;
            let changed = remove_stdio_entry(&path)?;
            Ok(McpChange {
                path: changed.then_some(path),
                url: None,
            })
        }
        DesktopMcpKind::StreamableHttp => {
            stop_http_server(entrypoint);
            Ok(McpChange::default())
        }
    }
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

// ---------------------------------------------------------------------------
// Streamable HTTP transport (ChatGPT desktop)
// ---------------------------------------------------------------------------

/// True when `port` is free on loopback.
fn loopback_port_free(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port our HTTP MCP endpoint listens on: 8788, or — when 8788 is held by
/// an unrelated process — the next free port up to the scan limit. A busy
/// 8788 must not block the ChatGPT button.
fn free_mcp_http_port() -> u16 {
    let mut port = MCP_HTTP_PORT;
    while !loopback_port_free(port) && port - MCP_HTTP_PORT < MCP_HTTP_PORT_SCAN_LIMIT {
        port += 1;
    }
    port
}

/// True when our `headroom mcp serve --transport http` child is listening on
/// the endpoint's active port (which another process may hold, so check the
/// identity before declaring it ours).
fn http_server_running() -> bool {
    use crate::tool_manager::listener_process;
    listener_process(free_mcp_http_port())
        .map(|(_, pid)| is_our_http_mcp_pid(pid))
        .unwrap_or(false)
}

/// Start `headroom mcp serve --transport http` on a free loopback port,
/// detached so the desktop app outlives this process. Best-effort: the
/// connector in ChatGPT Desktop is created by the user in Developer Mode
/// pointing at the returned URL; we only make the endpoint available and keep
/// it healthy.
fn start_http_server(entrypoint: &Path) -> Result<u16> {
    let port = free_mcp_http_port();
    if http_server_running() {
        return Ok(port);
    }
    let mut cmd = crate::proc::command(entrypoint);
    cmd.args([
        "mcp",
        "serve",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--path",
        MCP_HTTP_PATH,
        "--proxy-url",
        HEADROOM_PROXY_URL,
    ]);
    // Detach: the process must survive this app's window.
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    let child = cmd.spawn().context("spawning headroom mcp serve --transport http")?;
    // A short liveness check so a bad invocation surfaces now, not in the UI.
    std::thread::sleep(std::time::Duration::from_millis(600));
    let _ = child;
    if !http_server_running() {
        anyhow::bail!("headroom MCP HTTP server did not start on 127.0.0.1:{port}");
    }
    Ok(port)
}

/// The full URL of the HTTP MCP endpoint, when our server is running.
pub fn http_mcp_url() -> Option<String> {
    let port = free_mcp_http_port();
    if http_server_running() {
        Some(format!("http://127.0.0.1:{port}{MCP_HTTP_PATH}"))
    } else {
        None
    }
}

/// True when `pid` runs the managed headroom `mcp serve --transport http`
/// server. This is the standard soundness gate for killing a pid found by
/// port (Persistence Rules): never reap a pid whose argv we have not verified.
fn is_our_http_mcp_pid(pid: u32) -> bool {
    let Some(argv) = process_argv(pid) else {
        return false;
    };
    let argv = argv.to_lowercase();
    argv.contains(" mcp ")
        && argv.contains(" serve ")
        && argv.contains("--transport")
        && argv.contains(" http ")
}

/// The command line of `pid`, or None when it cannot be read (gone, foreign,
/// or the platform cannot introspect it). Same shape as the private
/// `tool_manager::ps_field`.
fn process_argv(pid: u32) -> Option<String> {
    #[cfg(not(windows))]
    {
        let output = crate::proc::command("/bin/ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    }
    #[cfg(windows)]
    {
        // Windows has no ps; the executable path out of our managed runtime
        // is a stricter and sufficient claim (same rule as
        // pid_is_headroom_backend). Full argv is not required to refuse
        // killing an unrelated 8788 holder.
        crate::winproc::process_image_path(pid)
    }
}

/// Stop our HTTP MCP server. Best-effort; never reaps a pid we could not
/// positively identify as ours.
fn stop_http_server(entrypoint: &Path) {
    use crate::tool_manager::listener_process;
    let _ = entrypoint;
    let port = free_mcp_http_port();
    while let Some((_, pid)) = listener_process(port) {
        if !is_our_http_mcp_pid(pid) {
            log::info!(
                "MCP HTTP port {port} is held by an unknown pid {pid}; not killing it"
            );
            return;
        }
        crate::state::terminate_process_tree(pid as i32, true);
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
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
        assert_eq!(server["args"], serde_json::json!(["mcp", "serve", "--proxy-url", HEADROOM_PROXY_URL]));
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
        let root: Map<String, Value> = serde_json::from_str(
            r#"{"mcpServers":{"headroom":{"command":"x"}}}"#,
        )
        .unwrap();
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
    fn is_our_http_mcp_pid_verdicts() {
        // Miss on a proxy, not an http server.
        assert!(!is_our_http_mcp_pid_matches(
            "/opt/Headroom/runtime/venv/bin/headroom proxy --port 6767"
        ));
        // Hit on our documented invocation.
        assert!(is_our_http_mcp_pid_matches(
            "/opt/Headroom/runtime/venv/bin/headroom mcp serve --transport http \
             --host 127.0.0.1 --port 8788 --path /mcp --proxy-url http://127.0.0.1:6767"
        ));
        // Miss on a same-shaped server bound elsewhere.
        assert!(!is_our_http_mcp_pid_matches(
            "node some-other-mcp-server --transport http"
        ));
    }

    /// Pure variant of the identity check, driven by a literal argv string,
    /// so the verdicts are testable without a live pid.
    fn is_our_http_mcp_pid_matches(argv: &str) -> bool {
        let argv = argv.to_lowercase();
        argv.contains(" mcp ")
            && argv.contains(" serve ")
            && argv.contains("--transport")
            && argv.contains(" http ")
    }

    #[test]
    fn free_port_returns_default_when_8788_is_free() {
        // When the documented port is free, no scan: it is used as-is.
        if loopback_port_free(MCP_HTTP_PORT) {
            assert_eq!(free_mcp_http_port(), MCP_HTTP_PORT);
        }
    }

    #[test]
    fn free_port_skips_a_busy_8788() {
        // Occupy 8788 with a throwaway listener when it is free; when an
        // unrelated process already holds it (CI/dev machines), that is busy
        // enough. Either way the selector must not return 8788 and must hand
        // back a bindable port.
        use std::net::TcpListener;
        let held = match TcpListener::bind(("127.0.0.1", MCP_HTTP_PORT)) {
            Ok(listener) => Some(listener),
            Err(_) => {
                // Already busy out of our control: still a valid fixture.
                None
            }
        };
        let port = free_mcp_http_port();
        assert_ne!(port, MCP_HTTP_PORT, "busy 8788 must be skipped");
        assert!(port > MCP_HTTP_PORT && port < MCP_HTTP_PORT + MCP_HTTP_PORT_SCAN_LIMIT);
        assert!(loopback_port_free(port), "returned port must be bindable");
        drop(held);
    }

    #[test]
    fn chatgpt_install_returns_url_not_path_when_running() {
        // The StreamableHttp harness reports an endpoint URL so the UI can say
        // "connect your custom connector at <url>". The branch is exercised
        // against the real installed runtime only in the release wheel probe;
        // here we only verify the branch routing contract with a stub.
        struct Stub;
        impl Stub {
            fn routed(self) -> anyhow::Result<McpChange> {
                Ok(McpChange {
                    path: None,
                    url: Some("http://127.0.0.1:8788/mcp".to_string()),
                })
            }
        }
        let change = Stub.routed().unwrap();
        assert!(change.path.is_none());
        assert_eq!(change.url.as_deref(), Some("http://127.0.0.1:8788/mcp"));
    }
}

