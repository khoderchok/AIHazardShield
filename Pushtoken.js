import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Alert } from "react-native";
import { ref, update } from "firebase/database";
import { db } from "./Firebaseconfig";

// Firebase paths where the device push token is stored.
const TOKEN_PATH = "/device/push_token";
const UPDATED_AT_PATH = "/device/token_updated_at";

// Requests notification permission and saves this phone's Expo push token.
export async function registerPushToken() {
  if (!Device.isDevice) {
    console.warn("Push notifications require a physical device.");
    return null;
  }

  // Checks existing permission before asking the user.
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync({
      android: {},
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        allowCriticalAlerts: true,
      },
    });
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    Alert.alert(
      "Notifications Disabled",
      "FireWatch needs notifications to alert you about fire and gas.\n\n" +
        "Enable them in Settings > Apps > FireWatch > Notifications",
      [{ text: "OK" }]
    );
    return null;
  }

  try {
    // Expo needs the EAS project id to generate a push token.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      throw new Error(
        "projectId not found. Add it to app.json under extra.eas.projectId"
      );
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    // Stores the token so the Python backend can send push alerts.
    await update(ref(db), {
      [TOKEN_PATH.slice(1)]: token,
      [UPDATED_AT_PATH.slice(1)]: Date.now(),
    });

    console.log("Push token saved to Firebase:", token);
    return token;
  } catch (e) {
    console.error("Failed to register push token:", e.message);
    return null;
  }
}

// File summary:
// Pushtoken.js requests notification permission from the mobile device.
// It asks Expo for this device's push token using the EAS project id.
// It saves the token and update timestamp into Firebase Realtime Database.
// The Python backend reads that saved token to send FireWatch alert pushes.
