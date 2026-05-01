// firebaseConfig.js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, getReactNativePersistence, initializeAuth } from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
  
// Firebase project settings used by the mobile app.
const firebaseConfig = {
  apiKey: "AIzaSyBjZ6zQFzKMSsW034cAUxvvnbGziv89Tdk",
  authDomain: "firedetection-2bb0e.firebaseapp.com",
  databaseURL: "https://firedetection-2bb0e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "firedetection-2bb0e",
  storageBucket: "firedetection-2bb0e.firebasestorage.app",
  messagingSenderId: "80970950848",
  appId: "1:80970950848:web:c30523b8094fb925546525",
};

// Initializes Firebase once and exports the realtime database.
const app = initializeApp(firebaseConfig);
let auth;

try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} catch (e) {
  auth = getAuth(app);
}

export const db = getDatabase(app);
export { auth };

// File summary:
// Firebaseconfig.js initializes Firebase for the React Native app.
// It exports the realtime database connection used by dashboard and auth helpers.
// It also exports Firebase Auth with AsyncStorage persistence for mobile sessions.
// Other app files import db and auth from here instead of rebuilding Firebase setup.
