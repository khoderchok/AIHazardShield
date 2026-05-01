// notificationSetup.js
// ─────────────────────────────────────────────────────────────────────────────
// Sets the foreground notification handler and creates ALL Android channels.
// Import and call setupNotificationChannels() once at app startup (App.js).
// ─────────────────────────────────────────────────────────────────────────────
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

// ── Controls how notifications behave when the app is OPEN (foreground) ──────
Notifications.setNotificationHandler({
  // Controls banner, sound, and badge behavior for foreground alerts.
  handleNotification: async (notification) => {
    const data      = notification.request.content.data ?? {};
    const isCrit    = data.alertType === "FIRE" || data.alertType === "FIRE+GAS";
    const isGas     = data.alertType === "GAS";
    const isCritical = isCrit || isGas;

    return {
      shouldShowBanner: true,
      shouldShowList:   true,
      shouldPlaySound:  isCritical,
      shouldSetBadge:   isCritical,
      priority: isCrit
        ? Notifications.AndroidNotificationPriority.MAX
        : Notifications.AndroidNotificationPriority.HIGH,
    };
  },
});

// ── Create all channels ───────────────────────────────────────────────────────
// Must be called BEFORE any notification is scheduled.
// On Android 8+ the channel importance/sound/vibration takes precedence over
// per-notification values, so these settings are the source of truth.
// Creates Android notification channels for alerts and status messages.
export async function setupNotificationChannels() {
  if (Platform.OS !== "android") return;

  // ── Channel 1: FIRE / GAS critical alerts ──────────────────────────────────
  await Notifications.setNotificationChannelAsync("fire-alerts", {
    name:                "🔥 Fire & Gas Alerts",
    description:         "Critical fire and gas leak notifications – never miss one.",
    importance:          Notifications.AndroidImportance.MAX,   // heads-up banner
    vibrationPattern:    [0, 400, 200, 400, 200, 800],
    lightColor:          "#c0443a",
    sound:               "default",
    bypassDnd:           true,                 // overrides Do Not Disturb
    lockscreenVisibility:
      Notifications.AndroidNotificationVisibility.PUBLIC,
    enableLights:        true,
    showBadge:           true,
  });

  // ── Channel 2: False detection – informational, lower urgency ──────────────
  await Notifications.setNotificationChannelAsync("false-detections", {
    name:                "⚠️ False Detections",
    description:         "Non-critical detection notices.",
    importance:          Notifications.AndroidImportance.DEFAULT,
    vibrationPattern:    [0, 200],
    sound:               null,
    bypassDnd:           false,
    lockscreenVisibility:
      Notifications.AndroidNotificationVisibility.PRIVATE,
  });

  // ── Channel 3: System / status – silent ───────────────────────────────────
  await Notifications.setNotificationChannelAsync("system-status", {
    name:        "System Status",
    description: "Backend connection status updates.",
    importance:  Notifications.AndroidImportance.LOW,
    sound:       null,
  });

  console.log("✅ Notification channels created");
}

// File summary:
// Notificationsetup.js configures how Expo notifications behave in the app.
// It sets the foreground notification handler for banners, sound, badge, and priority.
// It creates Android channels for critical alerts, false detections, and system status.
// App.js calls setupNotificationChannels during startup before scheduling notifications.
