import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { describeInvokeError } from "../lib/appHelpers";

interface DesktopMcpStatus {
  clientId: string;
  name: string;
  present: boolean;
  mcpConfigured: boolean;
}

const HARNESS_HELP: Record<string, string> = {
  claude_desktop:
    "Adds the headroom tools to Claude Desktop as an MCP server, so Claude can compress content on demand.",
  cursor:
    "Registers headroom as a global MCP server in Cursor, available in every project.",
  chatgpt_desktop:
    "Starts Headroom's Streamable HTTP MCP endpoint for ChatGPT Desktop. Connect to it in ChatGPT's Developer Mode with a custom connector.",
};

export function DesktopMcpPanel() {
  const [rows, setRows] = useState<DesktopMcpStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; error: boolean } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<DesktopMcpStatus[]>("detect_desktop_mcp");
      setRows(next);
    } catch {
      // Keep the last known list; a failed poll is not a failure to show.
      setRows([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(row: DesktopMcpStatus) {
    setBusyId(row.clientId);
    setMessage(null);
    const target = row.mcpConfigured ? "uninstall" : "install";
    try {
      const change = await invoke<{ path?: string; url?: string }>(
        `${target}_desktop_mcp`,
        { id: row.clientId },
      );
      const detail =
        target === "install" && change.url
          ? ` Connect ChatGPT's custom connector to: ${change.url}`
          : "";
      setMessage({
        id: row.clientId,
        text:
          target === "install"
            ? `${row.name}: Headroom MCP installed. Restart the app to pick it up.${detail}`
            : `${row.name}: Headroom MCP removed.`,
        error: false,
      });
    } catch (error) {
      setMessage({
        id: row.clientId,
        text: describeInvokeError(error, `${row.name}: the MCP action could not be completed.`),
        error: true,
      });
    } finally {
      setBusyId(null);
      void refresh();
    }
  }

  if (!loaded) {
    return (
      <section className="addons-mcp">
        <h2 className="addons-mcp__title">Desktop apps</h2>
        <p className="addons-mcp__hint">Checking which desktop apps are installed…</p>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="addons-mcp">
        <h2 className="addons-mcp__title">Desktop apps</h2>
        <p className="addons-mcp__hint">
          No supported desktop apps detected on this machine. Headroom MCP is
          available for Claude Desktop, Cursor and the ChatGPT desktop app.
        </p>
      </section>
    );
  }

  return (
    <section className="addons-mcp">
      <h2 className="addons-mcp__title">Desktop apps</h2>
      <p className="addons-mcp__hint">
        Add Headroom's compression tools to your desktop apps through MCP. Only
        apps installed on this machine are shown.
      </p>
      <ul className="addons__list addons__list--mcp">
        {rows.map((row) => {
          const busy = busyId === row.clientId;
          return (
            <li key={row.clientId} className="addon-card">
              <div className="addon-card__body">
                <div className="addon-card__heading">
                  <span className="addon-card__name">{row.name}</span>
                  <span className="addon-card__version">
                    {row.mcpConfigured ? "configured" : "not configured"}
                  </span>
                </div>
                <p className="addon-card__description">{HARNESS_HELP[row.clientId]}</p>
                {message && message.id === row.clientId ? (
                  <p className={`addon-card__notice${message.error ? " addon-card__notice--error" : ""}`}>
                    {message.text}
                  </p>
                ) : null}
              </div>
              <div className="addon-card__actions">
                <button
                  type="button"
                  className={`addon-card__action${row.mcpConfigured ? " addon-card__action--danger" : " addon-card__action--primary"}`}
                  disabled={busy}
                  onClick={() => void toggle(row)}
                >
                  {busy
                    ? "..."
                    : row.mcpConfigured
                      ? "Remove"
                      : "Install"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
