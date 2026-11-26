//! Direct hosted-Supabase integration for Headroom desktop.
//!
//! Replaces the local gateway (`backend/gateway/server.mjs`) as the account
//! backend: the desktop app talks to Supabase Auth (signup / login / password
//! recovery / session refresh) and PostgREST (profiles + licenses, RLS-scoped)
//! directly over HTTPS, using only the public `anon` key. No service-role
//! secret ever ships in the app, so this is safe to embed in every install.
//!
//! The signup trigger (see `supabase/migrations/..._licensing_schema.sql`)
//! auto-creates a `profile` row and a 7-day `trial` license for every new
//! user, so a successful signup is immediately a valid Headroom account.

use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use serde::Deserialize;

/// Supabase project URL for the hosted backend.
const SUPABASE_URL: &str = "https://dqnyzemgsffawrvojpvn.supabase.co";
/// Public publishable/anon key — safe to ship in the client. It can create
/// users and start sessions but cannot read other rows (RLS) nor touch
/// licensing tables.
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxbnl6ZW1nc2ZmYXdydm9qcHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1NTM4OTEsImV4cCI6MjExMTEyOTg5MX0.3khWN6zQ4hqr0rWlpxeI728smvm2NXeaa5f_Yz2ssjY";

/// A complete user session handed back by Supabase Auth.
#[derive(Debug, Clone)]
pub struct SupabaseSession {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub email: String,
}

/// The PostgREST `profiles` row for the current user (RLS-scoped).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SupabaseProfile {
    pub email: Option<String>,
    pub trial_ends_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub invite_bonus_percent: f64,
}

/// The PostgREST `licenses` row for the current user (RLS-scoped).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SupabaseLicense {
    pub tier: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub kind: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
struct SupabaseAuthResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    user: Option<SupabaseAuthUser>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    msg: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SupabaseAuthUser {
    id: String,
    email: Option<String>,
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Could not build HTTP client: {err}"))
}

fn supabase_url() -> String {
    SUPABASE_URL.trim_end_matches('/').to_string()
}

fn auth_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("apikey", SUPABASE_ANON_KEY.parse().unwrap());
    h.insert(
        "Authorization",
        format!("Bearer {SUPABASE_ANON_KEY}").parse().unwrap(),
    );
    h.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    h
}

fn bearer_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("apikey", SUPABASE_ANON_KEY.parse().unwrap());
    h.insert("Authorization", format!("Bearer {token}").parse().unwrap());
    h
}

/// Parse a Supabase error body into a concise, user-facing message.
fn supabase_error_message(body: &str, fallback: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = parsed.get("msg").and_then(|v| v.as_str()) {
            return msg.to_string();
        }
        if let Some(desc) = parsed.get("error_description").and_then(|v| v.as_str()) {
            return desc.to_string();
        }
        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            // "Invalid login credentials", "Email not confirmed", ...
            return err.to_string();
        }
        if let Some(message) = parsed.get("message").and_then(|v| v.as_str()) {
            return message.to_string();
        }
    }
    fallback.to_string()
}

/// Test-only alias so `pricing.rs` tests can assert on the same parser the
/// HTTP paths use without coupling to the module's private function.
#[cfg(test)]
pub(crate) fn supabase_error_message_for_test(body: &str, fallback: &str) -> String {
    supabase_error_message(body, fallback)
}

/// Register (and sign in) with email + password. Because `mailer_autoconfirm`
/// is on in the hosted project, a fresh signup returns a live session in the
/// same round-trip — there is no separate confirmation step.
pub fn sign_up(email: &str, password: &str) -> Result<SupabaseSession, String> {
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid email address.".into());
    }
    if password.trim().is_empty() {
        return Err("Enter your password.".into());
    }
    let body = serde_json::json!({ "email": email, "password": password });
    let response = http_client()?
        .post(format!("{}/auth/v1/signup", supabase_url()))
        .headers(auth_headers())
        .json(&body)
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() || text.trim().is_empty() {
        return Err(supabase_error_message(
            &text,
            &format!("Could not register your account (status {status})."),
        ));
    }
    let parsed: SupabaseAuthResponse =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected server response: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(supabase_error_message(&text, &err));
    }
    let Some(access_token) = parsed.access_token else {
        // User exists already → `signup` returns 200 with no session. The UI
        // flow treats "register" as idempotent, so fall through to sign-in.
        return sign_in(&email, password);
    };
    let refresh_token = parsed.refresh_token.unwrap_or_default();
    let (user_id, user_email) = parsed
        .user
        .map(|u| (u.id, u.email.unwrap_or_else(|| email.clone())))
        .unwrap_or_else(|| (String::new(), email.clone()));
    Ok(SupabaseSession {
        access_token,
        refresh_token,
        user_id,
        email: user_email,
    })
}

/// Sign in with email + password (Supabase `grant_type=password`).
pub fn sign_in(email: &str, password: &str) -> Result<SupabaseSession, String> {
    let email = email.trim().to_ascii_lowercase();
    let body = serde_json::json!({ "email": email, "password": password });
    let response = http_client()?
        .post(format!(
            "{}/auth/v1/token?grant_type=password",
            supabase_url()
        ))
        .headers(auth_headers())
        .json(&body)
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(supabase_error_message(
            &text,
            &format!("Could not sign in (status {status})."),
        ));
    }
    let parsed: SupabaseAuthResponse =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected server response: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(supabase_error_message(&text, &err));
    }
    let Some(access_token) = parsed.access_token else {
        return Err("The server did not return a session.".into());
    };
    Ok(SupabaseSession {
        access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        user_id: parsed.user.as_ref().map(|u| u.id.clone()).unwrap_or_default(),
        email: parsed
            .user
            .as_ref()
            .and_then(|u| u.email.clone())
            .unwrap_or(email.clone()),
    })
}

/// Exchange a refresh token for a fresh access token.
pub fn refresh_session(refresh_token: &str) -> Result<SupabaseSession, String> {
    let body = serde_json::json!({ "refresh_token": refresh_token });
    let response = http_client()?
        .post(format!(
            "{}/auth/v1/token?grant_type=refresh_token",
            supabase_url()
        ))
        .headers(auth_headers())
        .json(&body)
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(supabase_error_message(
            &text,
            &format!("Could not refresh the session (status {status})."),
        ));
    }
    let parsed: SupabaseAuthResponse =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected server response: {e}"))?;
    let Some(access_token) = parsed.access_token else {
        return Err("The server did not return a refreshed session.".into());
    };
    Ok(SupabaseSession {
        access_token,
        refresh_token: parsed.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        user_id: parsed.user.as_ref().map(|u| u.id.clone()).unwrap_or_default(),
        email: parsed
            .user
            .as_ref()
            .and_then(|u| u.email.clone())
            .unwrap_or_default(),
    })
}

/// Send a password-recovery email for the account (never reveals existence).
pub fn reset_password(email: &str) -> Result<(), String> {
    let email = email.trim().to_ascii_lowercase();
    let body = serde_json::json!({ "email": email });
    let response = http_client()?
        .post(format!("{}/auth/v1/recover", supabase_url()))
        .headers(auth_headers())
        .json(&body)
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(supabase_error_message(
            &text,
            &format!("Could not send the password reset email (status {status})."),
        ));
    }
    Ok(())
}

/// Fetch the current user's profile via PostgREST (RLS-scoped to their row).
pub fn fetch_profile(access_token: &str) -> Result<Option<SupabaseProfile>, String> {
    let response = http_client()?
        .get(format!(
            "{}/rest/v1/profiles?select=email,trial_ends_at,invite_bonus_percent&limit=1",
            supabase_url()
        ))
        .headers(bearer_headers(access_token))
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err("Your session has expired; please sign in again.".into());
        }
        return Err(format!("Could not load your account (status {status})."));
    }
    let mut rows: Vec<SupabaseProfile> =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected account response: {e}"))?;
    Ok(rows.pop())
}

/// Fetch the current user's active license via PostgREST (RLS-scoped).
pub fn fetch_license(access_token: &str) -> Result<Option<SupabaseLicense>, String> {
    let response = http_client()?
        .get(format!(
            "{}/rest/v1/licenses?select=tier,status,kind,starts_at,ends_at&order=created_at.desc&limit=1",
            supabase_url()
        ))
        .headers(bearer_headers(access_token))
        .send()
        .map_err(|err| format!("Could not reach the server: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err("Your session has expired; please sign in again.".into());
        }
        return Err(format!("Could not load your license (status {status})."));
    }
    let mut rows: Vec<SupabaseLicense> =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected license response: {e}"))?;
    Ok(rows.pop())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_extracted_from_common_supabase_bodies() {
        let body = r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#;
        assert_eq!(
            supabase_error_message(body, "fb"),
            "Invalid login credentials"
        );
        let body2 = r#"{"msg":"Email not confirmed"}"#;
        assert_eq!(supabase_error_message(body2, "fb"), "Email not confirmed");
        let body3 = "not json";
        assert_eq!(supabase_error_message(body3, "fb"), "fb");
    }
}
