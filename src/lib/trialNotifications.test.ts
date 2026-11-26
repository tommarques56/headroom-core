import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeadroomPricingStatus } from "./types";
import { maybeFireTrialNotifications } from "./trialNotifications";

const { invokeMock, isVisibleMock, windows } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isVisibleMock: vi.fn(),
  // The calling webview's label, and whether the OTHER Headroom window is on
  // screen. isVisibleMock is the calling (main) window.
  windows: { label: "main", otherVisible: false },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windows.label, isVisible: isVisibleMock }),
  getAllWindows: async () => [
    { isVisible: isVisibleMock },
    { isVisible: async () => windows.otherVisible },
  ],
}));

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    },
  });
  return values;
}

afterEach(() => {
  windows.label = "main";
  windows.otherVisible = false;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

function hoursFromNow(n: number): string {
  return new Date(Date.now() + n * 60 * 60 * 1000).toISOString();
}

function makeStatus(overrides: Partial<HeadroomPricingStatus> = {}): HeadroomPricingStatus {
  const now = new Date();
  const graceStart = hoursAgo(2);
  const graceEnd = new Date(new Date(graceStart).getTime() + 72 * 60 * 60 * 1000).toISOString();
  return {
    authenticated: false,
    localGraceStartedAt: graceStart,
    localGraceEndsAt: graceEnd,
    localGraceActive: true,
    accountSyncError: null,
    needsAuthentication: false,
    optimizationAllowed: true,
    shouldNudge: false,
    nudgeLevel: 0,
    gateReason: null,
    gateMessage: "",
    nudgeThresholdPercent: null,
    effectiveNudgeThresholdsPercent: null,
    disableThresholdPercent: null,
    effectiveDisableThresholdPercent: null,
    recommendedSubscriptionTier: null,
    claude: {
      authMethod: "claude_ai_oauth",
      email: null,
      displayName: null,
      planTier: "free",
      hasExtraUsageEnabled: false,
    },
    account: null,
    launchDiscountActive: false,
    ...overrides,
  };
}

describe("maybeFireTrialNotifications", () => {
  afterEach(() => {
    invokeMock.mockReset();
    isVisibleMock.mockReset();
  });

  describe("window visibility gate", () => {
    it("does not fire any notification when the window is visible", async () => {
      isVisibleMock.mockResolvedValue(true);
      installStorage();
      const status = makeStatus({ localGraceStartedAt: hoursAgo(2), localGraceActive: true });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("treats isVisible errors as visible to avoid spamming on failure", async () => {
      isVisibleMock.mockRejectedValue(new Error("bridge down"));
      installStorage();
      const status = makeStatus({ localGraceStartedAt: hoursAgo(2), localGraceActive: true });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe("single notifying webview", () => {
    it("fires only from the main webview, and not while any Headroom window is on screen", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const status = makeStatus({ localGraceEndsAt: hoursFromNow(15.5) });

      windows.label = "launcher";
      await maybeFireTrialNotifications(status);
      expect(invokeMock).not.toHaveBeenCalled();

      windows.label = "main";
      windows.otherVisible = true;
      await maybeFireTrialNotifications(status);
      expect(invokeMock).not.toHaveBeenCalled();

      windows.otherVisible = false;
      await maybeFireTrialNotifications(status);
      expect(invokeMock).toHaveBeenCalledOnce();
    });

    it("fires once when two overlapping ticks race for the same slot", async () => {
      isVisibleMock.mockResolvedValue(false);
      invokeMock.mockResolvedValue(undefined);
      installStorage();
      const grace = makeStatus({ localGraceEndsAt: hoursFromNow(15.5) });

      await Promise.all([
        maybeFireTrialNotifications(grace),
        maybeFireTrialNotifications(grace),
      ]);
      expect(invokeMock).toHaveBeenCalledOnce();
    });
  });

  describe("grace period notifications", () => {
    it("fires the 16-hour-left notification when 16 or fewer hours remain", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const graceEnd = hoursFromNow(15.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).toHaveBeenCalledWith("show_notification", {
        title: "Sign In to Headroom",
        body: expect.stringContaining("hours left"),
        action: "signup",
      });
    });

    it("fires the 8-hour-left notification when 8 or fewer hours remain", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const graceEnd = hoursFromNow(7.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).toHaveBeenCalledWith("show_notification", {
        title: "Sign In to Headroom",
        body: expect.any(String),
        action: "signup",
      });
    });

    it("fires the 1-hour-left notification when 1 or fewer hours remain", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const graceEnd = hoursFromNow(0.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).toHaveBeenCalledWith("show_notification", {
        title: "Sign In to Headroom",
        body: expect.any(String),
        action: "signup",
      });
    });

    it("does not fire when more than 16 hours remain", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const graceEnd = hoursFromNow(17);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("does not repeat a threshold that was already sent", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage({ headroom_grace_notif_threshold: "1" }); // 8h-left threshold already sent
      const graceEnd = hoursFromNow(7.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("sends the next threshold when a lower one was already sent", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage({ headroom_grace_notif_threshold: "0" }); // 16h-left sent, 8h-left not yet
      const graceEnd = hoursFromNow(7.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd, localGraceActive: true });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).toHaveBeenCalledOnce();
    });

    it("records the threshold index in localStorage after sending", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const graceEnd = hoursFromNow(15.5);
      const status = makeStatus({ localGraceEndsAt: graceEnd });

      await maybeFireTrialNotifications(status);

      expect(localStorage.setItem).toHaveBeenCalledWith(
        "headroom_grace_notif_threshold",
        "0"
      );
    });

    it("skips grace notification when user is authenticated", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const status = makeStatus({
        authenticated: true,
        localGraceEndsAt: hoursFromNow(7.5),
      });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("skips grace notification when grace period has expired", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const status = makeStatus({
        localGraceActive: false,
        localGraceStartedAt: hoursAgo(73),
      });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("uses urgent copy when fewer than 3 hours remain", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage({ headroom_grace_notif_threshold: "1" }); // 8h-left sent, 1h-left eligible
      const graceEnd = hoursFromNow(0.5);
      const status = makeStatus({
        localGraceEndsAt: graceEnd,
      });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).toHaveBeenCalledWith("show_notification", {
        title: "Sign In to Headroom",
        body: expect.stringContaining("hour(s) left"),
        action: "signup",
      });
    });

    it("best-effort swallows invoke errors without throwing", async () => {
      isVisibleMock.mockResolvedValue(false);
      invokeMock.mockRejectedValueOnce(new Error("notifications disabled"));
      installStorage();
      const status = makeStatus({ localGraceEndsAt: hoursFromNow(15.5) });

      await expect(maybeFireTrialNotifications(status)).resolves.toBeUndefined();
    });
  });

  describe("free forever: no trial notifications", () => {
    it("never fires a trial-ending notification, even soon before an account trial end", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const status = makeStatus({
        localGraceActive: false,
        authenticated: true,
        account: {
          email: "user@example.com",
          trialStartedAt: hoursAgo(11 * 24),
          trialEndsAt: daysFromNow(2),
          trialUsageDaysLeft: 2,
          trialActive: true,
          subscriptionActive: false,
          subscriptionTier: null,
          inviteCode: null,
          acceptedInvitesCount: 0,
          inviteBonusPercent: 0,
        },
      });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("never fires an intro-offer upgrade pitch for a free account", async () => {
      isVisibleMock.mockResolvedValue(false);
      installStorage();
      const status = makeStatus({
        localGraceActive: false,
        authenticated: true,
        introOffer: { active: true, percentOff: 25, annualPercentOff: 12.5, durationMonths: 3 },
        account: {
          email: "user@example.com",
          trialStartedAt: hoursAgo(5),
          trialEndsAt: daysFromNow(13),
          trialActive: true,
          subscriptionActive: false,
          subscriptionTier: null,
          inviteCode: null,
          acceptedInvitesCount: 0,
          inviteBonusPercent: 0,
        },
      });

      await maybeFireTrialNotifications(status);

      expect(invokeMock).not.toHaveBeenCalled();
    });
  });
});

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}
