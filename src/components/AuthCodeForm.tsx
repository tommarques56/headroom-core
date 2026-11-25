// Email + password sign-in block, rendered inside TermsGate on a fresh
// install (paywall-first onboarding) and in the upgrade-auth view. Controlled
// by App state/handlers.
//
// Supabase-backed flow (see backend/gateway): "Login" calls desktop/auth/login,
// "Register" calls desktop/auth/register, and the Forgot password link calls
// desktop/auth/reset_password. Registration is idempotent - the gateway logs
// into the account when the email already exists.
export interface AuthCodeFormProps {
  lead?: string;
  email: string;
  onEmailChange: (value: string) => void;
  emailValid: boolean;
  password: string;
  onPasswordChange: (value: string) => void;
  /** Which submit button the user picked. Defaults to "login". */
  mode: "login" | "register";
  onModeChange: (mode: "login" | "register") => void;
  submitBusy: boolean;
  error: string | null;
  success: string | null;
  onSubmit: (mode: "login" | "register") => void;
  /** Forgot-password link. Presenting a spinner/disabled state is up to the
   * parent via `forgotBusy`; on success the parent sets `success`. */
  forgotBusy?: boolean;
  onForgotPassword?: () => void;
}

export function AuthCodeForm({
  lead,
  email,
  onEmailChange,
  emailValid,
  password,
  onPasswordChange,
  mode,
  onModeChange,
  submitBusy,
  error,
  success,
  onSubmit,
  forgotBusy = false,
  onForgotPassword
}: AuthCodeFormProps) {
  const submitLabel =
    mode === "register"
      ? submitBusy
        ? "Creating account…"
        : "Create account"
      : submitBusy
        ? "Signing in…"
        : "Sign in";

  return (
    <div className="paywall__auth soft-card">
      {lead ? <p className="paywall__auth-lead">{lead}</p> : null}

      {/* Mode toggle: Register (default for a fresh install) / Login */}
      <div className="paywall__auth-toggle" role="tablist" aria-label="Sign in or create an account">
        <button
          className={`paywall__auth-toggle-btn${mode === "login" ? " is-active" : ""}`}
          disabled={submitBusy}
          onClick={() => onModeChange("login")}
          role="tab"
          aria-selected={mode === "login"}
          type="button"
        >
          Login
        </button>
        <button
          className={`paywall__auth-toggle-btn${mode === "register" ? " is-active" : ""}`}
          disabled={submitBusy}
          onClick={() => onModeChange("register")}
          role="tab"
          aria-selected={mode === "register"}
          type="button"
        >
          Register
        </button>
      </div>

      <div className="paywall__auth-row">
        <input
          className="paywall__auth-input"
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@example.com"
          type="email"
          value={email}
        />
      </div>

      <div className="paywall__auth-row">
        <input
          className="paywall__auth-input"
          onChange={(event) => onPasswordChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits with the currently selected mode.
            if (event.key === "Enter" && emailValid && password) {
              onSubmit(mode);
            }
          }}
          placeholder="Password"
          type="password"
          value={password}
        />
      </div>

      <div className="paywall__auth-row paywall__auth-actions">
        <button
          className="primary-button"
          disabled={!emailValid || !password || submitBusy}
          onClick={() => onSubmit(mode)}
          type="button"
        >
          {submitLabel}
        </button>
        {onForgotPassword ? (
          <button
            className="link-button"
            disabled={forgotBusy}
            onClick={onForgotPassword}
            type="button"
          >
            {forgotBusy ? "Sending reset link…" : "Forgot password?"}
          </button>
        ) : null}
      </div>

      {error ? <p className="install-progress__error">{error}</p> : null}
      {success && !error ? (
        <p className="paywall__auth-success paywall__auth-reveal">{success}</p>
      ) : null}
    </div>
  );
}
