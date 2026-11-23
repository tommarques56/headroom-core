import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DesktopMcpPanel } from "./DesktopMcpPanel";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

const detected = [
  { clientId: "claude_desktop", name: "Claude Desktop", present: true, mcpConfigured: false },
  { clientId: "cursor", name: "Cursor", present: true, mcpConfigured: true }
];

function respond(rows: unknown[]) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "detect_desktop_mcp") return Promise.resolve(rows);
    if (command === "install_desktop_mcp" || command === "uninstall_desktop_mcp") {
      return Promise.resolve({ status: "installed" });
    }
    return Promise.reject(new Error(`unexpected command ${command}`));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("DesktopMcpPanel", () => {
  it("renders only detected harnesses with their status", async () => {
    respond(detected);
    render(<DesktopMcpPanel />);

    await waitFor(() => expect(screen.getByText("Claude Desktop")).toBeInTheDocument());
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    // Status chips match the backend state.
    expect(screen.getByText("not configured")).toBeInTheDocument();
    expect(screen.getByText("configured")).toBeInTheDocument();
    // A harness absent from the detection payload is not rendered at all.
    expect(screen.queryByText("ChatGPT Desktop")).not.toBeInTheDocument();
  });

  it("shows an empty state when no desktop app is detected", async () => {
    respond([]);
    render(<DesktopMcpPanel />);

    await waitFor(() =>
      expect(
        screen.getByText(/No supported desktop apps detected/i),
      ).toBeInTheDocument(),
    );
  });

  it("installs a harness when its button is Install", async () => {
    respond(detected);
    render(<DesktopMcpPanel />);

    await waitFor(() => expect(screen.getByText("Claude Desktop")).toBeInTheDocument());
    const installButton = screen.getByText("Install");
    await userEvent.click(installButton);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("install_desktop_mcp", { id: "claude_desktop" }),
    );
    expect(
      await screen.findByText(/Claude Desktop: Headroom MCP installed/i),
    ).toBeInTheDocument();
  });

  it("removes a harness when its button is Remove", async () => {
    respond(detected);
    render(<DesktopMcpPanel />);

    // The configured harness is Cursor in this fixture; find its card's Remove.
    await waitFor(() => expect(screen.getByText("Cursor")).toBeInTheDocument());
    const cursorCard = screen.getByText("Cursor").closest("li");
    expect(cursorCard).not.toBeNull();
    const removeButton = within(cursorCard as HTMLElement).getByText("Remove");
    await userEvent.click(removeButton);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("uninstall_desktop_mcp", { id: "cursor" }),
    );
    expect(await screen.findByText(/Cursor: Headroom MCP removed/i)).toBeInTheDocument();
  });

  it("surfaces a failed action as an error message", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "detect_desktop_mcp") return Promise.resolve(detected);
      if (command === "install_desktop_mcp") return Promise.reject("boom");
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    render(<DesktopMcpPanel />);

    await waitFor(() => expect(screen.getByText("Claude Desktop")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Install"));

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
