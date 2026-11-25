import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AuthCodeForm } from "./AuthCodeForm";

function renderForm(overrides: Partial<React.ComponentProps<typeof AuthCodeForm>> = {}) {
  const props: React.ComponentProps<typeof AuthCodeForm> = {
    lead: "Sign in to continue",
    email: "",
    onEmailChange: vi.fn(),
    emailValid: false,
    password: "",
    onPasswordChange: vi.fn(),
    mode: "login",
    onModeChange: vi.fn(),
    submitBusy: false,
    error: null,
    success: null,
    onSubmit: vi.fn(),
    ...overrides
  };

  render(<AuthCodeForm {...props} />);
  return props;
}

describe("AuthCodeForm", () => {
  it("renders email and password and submits login", async () => {
    const props = renderForm({ email: "person@example.com", emailValid: true, password: "s3cret!" });

    await userEvent.type(screen.getByPlaceholderText("you@example.com"), "x");
    await userEvent.type(screen.getByPlaceholderText("Password"), "y");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(props.onEmailChange).toHaveBeenLastCalledWith("person@example.comx");
    expect(props.onPasswordChange).toHaveBeenLastCalledWith("s3cret!y");
    expect(props.onSubmit).toHaveBeenCalledWith("login");
  });

  it("blocks submit until email and password are present", () => {
    renderForm({ email: "person@example.com", emailValid: true, password: "" });
    const missingPassword = screen.getAllByRole("button", { name: "Sign in" }).pop()!;
    expect(missingPassword).toBeDisabled();

    // Separate render (fresh DOM) for the missing-email case.
    cleanup();
    renderForm({ email: "", emailValid: false, password: "s3cret!" });
    const missingEmail = screen.getAllByRole("button", { name: "Sign in" }).pop()!;
    expect(missingEmail).toBeDisabled();
  });

  it("shows the signing-in state", () => {
    renderForm({ email: "person@example.com", emailValid: true, password: "s3cret!", submitBusy: true });
    expect(screen.getByRole("button", { name: /Signing in/ })).toBeDisabled();
  });

  it("switches to register mode and submits register", async () => {
    const props = renderForm({ mode: "register", emailValid: true, password: "s3cret!" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Register" }));
    await user.click(screen.getByRole("button", { name: "Create account" }));

    // Clicking the toggle fires onModeChange; the parent flips `mode`.
    expect(props.onModeChange).toHaveBeenCalledWith("register");
    expect(props.onSubmit).toHaveBeenCalledWith("register");
  });

  it("shows the creating-account state", () => {
    renderForm({ mode: "register", emailValid: true, password: "s3cret!", submitBusy: true });
    expect(screen.getByRole("button", { name: /Creating account/ })).toBeDisabled();
  });

  it("submits on Enter with the current mode", async () => {
    const props = renderForm({ email: "person@example.com", emailValid: true, password: "s3cret!", mode: "register" });
    await userEvent.type(screen.getByPlaceholderText("Password"), "{Enter}");
    expect(props.onSubmit).toHaveBeenCalledWith("register");
  });

  it("calls the forgot-password handler when present", async () => {
    const props = renderForm({ onForgotPassword: vi.fn(), forgotBusy: false });
    await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(props.onForgotPassword).toHaveBeenCalledTimes(1);
  });

  it("shows the forgot-password busy state", () => {
    renderForm({ onForgotPassword: vi.fn(), forgotBusy: true });
    expect(screen.getByRole("button", { name: /Sending reset link/ })).toBeDisabled();
  });

  it("shows error before success", () => {
    renderForm({ error: "Invalid login credentials", success: "Check your email" });

    expect(screen.getByText("Invalid login credentials")).toBeInTheDocument();
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  it("shows success when there is no error", () => {
    renderForm({ success: "Reset link sent" });

    expect(screen.getByText("Reset link sent")).toBeInTheDocument();
  });
});
