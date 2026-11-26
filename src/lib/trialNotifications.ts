import { invoke } from "@tauri-apps/api/core";

import type { HeadroomPricingStatus } from "./types";
import { shouldNotifyInBackground } from "./urgentNotifications";

// Remaining-time thresholds at which to fire grace period notifications.
const GRACE_HOURS_LEFT_THRESHOLDS = [
  16,
  8,
  1,
];

const GRACE_THRESHOLD_KEY = "headroom_grace_notif_threshold";

export async function maybeFireTrialNotifications(
  status: HeadroomPricingStatus,
  _dailySavings: unknown[] = []
): Promise<void> {
  if (!(await shouldNotifyInBackground())) return;

  // Headroom is free for signed-in accounts. The only notice left here is the
  // local 72-hour grace window prompting a sign-in; there is no trial, no
  // trial-ending countdown, and no upgrade offer (the backend never marks a
  // signed-in account as trial/subscription based anymore).
  if (status.localGraceActive && !status.authenticated) {
    await maybeFireGraceNotification(status);
  }
}

async function maybeFireGraceNotification(
  status: HeadroomPricingStatus
): Promise<void> {
  const graceEndsAt = new Date(status.localGraceEndsAt).getTime();
  const now = Date.now();
  const hoursLeftRaw = (graceEndsAt - now) / (60 * 60 * 1000);
  const lastSent = parseInt(localStorage.getItem(GRACE_THRESHOLD_KEY) ?? "-1", 10);

  let nextIndex = -1;
  for (let i = GRACE_HOURS_LEFT_THRESHOLDS.length - 1; i >= 0; i--) {
    if (hoursLeftRaw <= GRACE_HOURS_LEFT_THRESHOLDS[i] && i > lastSent) {
      nextIndex = i;
      break;
    }
  }
  if (nextIndex === -1) return;

  const hoursLeft = Math.max(0, Math.round((graceEndsAt - now) / (60 * 60 * 1000)));
  const body =
    hoursLeft <= 2
      ? `Less than ${hoursLeft + 1} hour(s) left. Sign in to Headroom to keep optimizing your prompts.`
      : `${hoursLeft} hours left in your 72-hour access window. Sign in to Headroom to keep optimizing your prompts.`;

  // Claim the threshold before awaiting so an overlapping tick can't send it
  // twice. sendNotification never throws, so the claim always stood anyway.
  localStorage.setItem(GRACE_THRESHOLD_KEY, String(nextIndex));
  await sendNotification("Sign In to Headroom", body, "signup");
}

async function sendNotification(
  title: string,
  body: string,
  action?: string
): Promise<void> {
  try {
    await invoke("show_notification", { title, body, action });
  } catch {
    // best-effort
  }
}
