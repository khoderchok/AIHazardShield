import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { ref, set } from "firebase/database";
import { auth, db } from "./Firebaseconfig";

const ORB_SIZE = 96;
const AI_BRAIN_LOGO = require("./assets/ai_brain_logo.png");

// Particle positions are kept in one list so the logo animation stays easy to tune.
const PARTICLES = [
  { angle: 8, distance: 54, size: 4, delay: 0 },
  { angle: 72, distance: 50, size: 3, delay: 0.18 },
  { angle: 138, distance: 58, size: 3, delay: 0.34 },
  { angle: 214, distance: 52, size: 4, delay: 0.48 },
  { angle: 292, distance: 56, size: 3, delay: 0.62 },
];

// Animated blue orb used as the premium login logo.
function FireOrb() {
  const spin = useSharedValue(0);
  const spinReverse = useSharedValue(0);
  const breathe = useSharedValue(0);
  const spark = useSharedValue(0);

  // Starts the repeating motion values for ring rotation, breathing, and spark movement.
  useEffect(() => {
    spin.value = withRepeat(
      withTiming(1, { duration: 12000, easing: Easing.linear }),
      -1,
      false
    );
    spinReverse.value = withRepeat(
      withTiming(1, { duration: 17000, easing: Easing.linear }),
      -1,
      false
    );
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 1800, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    spark.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.linear }),
      -1,
      false
    );
  }, []);

  // Maps animation values into visual transforms used by the glowing orb layers.
  const orbStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(breathe.value, [0, 1], [1, 1.075]) },
      { rotate: `${spin.value * 360}deg` },
    ],
  }));

  const outerRingStyle = useAnimatedStyle(() => ({
    opacity: interpolate(breathe.value, [0, 1], [0.42, 0.92]),
    transform: [
      { rotate: `${spin.value * 360}deg` },
      { scale: interpolate(breathe.value, [0, 1], [0.98, 1.06]) },
    ],
  }));

  const innerRingStyle = useAnimatedStyle(() => ({
    opacity: interpolate(breathe.value, [0, 1], [0.34, 0.78]),
    transform: [
      { rotate: `${spinReverse.value * -360}deg` },
      { scale: interpolate(breathe.value, [0, 1], [1.05, 0.96]) },
    ],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(breathe.value, [0, 1], [0.28, 0.74]),
    transform: [{ scale: interpolate(breathe.value, [0, 1], [0.88, 1.22]) }],
  }));

  // Builds the layered logo: glow, two rings, orbit particles, and the brain image.
  return (
    <View style={styles.orbStage}>
      <Animated.View style={[styles.orbGlow, glowStyle]} />
      <Animated.View style={[styles.energyRingOuter, outerRingStyle]}>
        <View style={styles.ringDashTop} />
        <View style={styles.ringDashBottom} />
      </Animated.View>
      <Animated.View style={[styles.energyRingInner, innerRingStyle]}>
        <View style={styles.ringDashLeft} />
        <View style={styles.ringDashRight} />
      </Animated.View>
      {PARTICLES.map((particle, index) => (
        <FireParticle key={index} particle={particle} spark={spark} />
      ))}
      <Animated.View style={[styles.orbCore, orbStyle]}>
        <View style={styles.orbInnerShade} />
        <Image source={AI_BRAIN_LOGO} style={styles.orbBrainLogo} resizeMode="cover" />
      </Animated.View>
    </View>
  );
}

// Small glowing particle that orbits around the fire orb.
function FireParticle({ particle, spark }) {
  const style = useAnimatedStyle(() => {
    const phase = (spark.value + particle.delay) % 1;
    const radius = particle.distance + interpolate(phase, [0, 1], [-5, 8]);
    const angle = ((particle.angle + phase * 46) * Math.PI) / 180;

    return {
      opacity: interpolate(phase, [0, 0.45, 1], [0.18, 1, 0.22]),
      transform: [
        { translateX: Math.cos(angle) * radius },
        { translateY: Math.sin(angle) * radius },
        { scale: interpolate(phase, [0, 0.5, 1], [0.7, 1.35, 0.72]) },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          width: particle.size,
          height: particle.size,
          borderRadius: particle.size / 2,
        },
        style,
      ]}
    />
  );
}

// Login screen that protects the AiHazardShield dashboard.
export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Login state stays local because Firebase auth owns the signed-in session.

  // Signs in with Firebase email and password authentication.
  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Missing Info", "Enter your email and password.");
      return;
    }

    try {
      setLoading(true);
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (e) {
      Alert.alert("Login Failed", e.message);
    } finally {
      setLoading(false);
    }
  };

  // Creates a new Firebase user for another family phone.
  const handleRegister = async () => {
    if (!email.trim() || password.length < 6) {
      Alert.alert("Missing Info", "Use an email and a password of at least 6 characters.");
      return;
    }

    try {
      setLoading(true);
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await set(ref(db, `/users/${credential.user.uid}`), {
        email: credential.user.email,
        role: "viewer",
        createdAt: Date.now(),
      });
    } catch (e) {
      Alert.alert("Register Failed", e.message);
    } finally {
      setLoading(false);
    }
  };

  // Sends a password reset email if the user forgets the password.
  const handleResetPassword = async () => {
    if (!email.trim()) {
      Alert.alert("Email Required", "Enter your email first.");
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email.trim());
      Alert.alert("Reset Sent", "Check your email for the reset link.");
    } catch (e) {
      Alert.alert("Reset Failed", e.message);
    }
  };

  // The screen is wrapped for keyboard safety and scrolls on smaller phones.
  return (
    <View style={styles.page}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboard}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.phoneFrame}>
            {/* Decorative background and animated brand mark for the login screen. */}
            <View style={styles.bgGrid} />
            <View style={styles.greenGlowTop} />
            <View style={styles.greenGlowBottom} />
            <FireOrb />

            <Text style={styles.title}>Welcome Back!</Text>
            <Text style={styles.subtitle}>
              Sign in to access smart, personalized fire protection for your home.
            </Text>

            <View style={styles.form}>
              {/* Email and password fields feed Firebase auth handlers above. */}
              <Text style={styles.label}>Email address*</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="example@gmail.com"
                placeholderTextColor="rgba(255,255,255,0.34)"
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
              />

              <Text style={styles.label}>Password*</Text>
              <View style={styles.passwordWrap}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="@Sn123hsn#"
                  placeholderTextColor="rgba(255,255,255,0.34)"
                  secureTextEntry={!showPassword}
                  style={styles.passwordInput}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((value) => !value)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text style={styles.eye}>{showPassword ? "hide" : "show"}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.optionRow}>
                {/* Remember-me is a UI preference placeholder for the login form. */}
                <TouchableOpacity
                  style={styles.rememberRow}
                  onPress={() => setRememberMe((value) => !value)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.checkbox, rememberMe && styles.checkboxOn]}>
                    {rememberMe ? <Text style={styles.check}>✓</Text> : null}
                  </View>
                  <Text style={styles.optionText}>Remember me</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleResetPassword} disabled={loading}>
                  <Text style={styles.forgot}>Forgot Password?</Text>
                </TouchableOpacity>
              </View>

              {/* Primary and secondary actions share the loading state to avoid double submits. */}
              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.disabledBtn]}
                onPress={handleLogin}
                disabled={loading}
                activeOpacity={0.9}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.primaryText}>✣  Sign in</Text>
                )}
              </TouchableOpacity>

              <View style={styles.signupRow}>
                <Text style={styles.signupMuted}>Don't have an account?</Text>
                <TouchableOpacity onPress={handleRegister} disabled={loading}>
                  <Text style={styles.signupText}>Sign up</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Page containers keep the login centered and full-screen on all device sizes.
  page: {
    flex: 1,
    backgroundColor: "#000000",
  },
  keyboard: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  phoneFrame: {
    width: "100%",
    minHeight: "100%",
    borderRadius: 0,
    overflow: "hidden",
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "ios" ? 58 : 42,
    paddingBottom: 28,
    backgroundColor: "#000000",
    shadowColor: "#000000",
    shadowOpacity: 0.36,
    shadowRadius: 22,
    elevation: 14,
  },
  // Background accents create the blue smart-home security look behind the form.
  bgGrid: {
    position: "absolute",
    top: 18,
    left: 10,
    right: 10,
    height: 230,
    opacity: 0.16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(70,150,255,0.30)",
    backgroundColor: "rgba(50,120,255,0.04)",
  },
  greenGlowTop: {
    position: "absolute",
    top: -70,
    alignSelf: "center",
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: "rgba(47,128,255,0.16)",
  },
  greenGlowBottom: {
    position: "absolute",
    bottom: -100,
    left: -60,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(28,88,180,0.12)",
  },
  // Orb styles define the animated logo, its rings, and the tiny moving particles.
  orbStage: {
    width: ORB_SIZE + 48,
    height: ORB_SIZE + 48,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    marginBottom: 16,
  },
  orbGlow: {
    position: "absolute",
    width: ORB_SIZE + 42,
    height: ORB_SIZE + 42,
    borderRadius: (ORB_SIZE + 42) / 2,
    backgroundColor: "rgba(47,128,255,0.24)",
    shadowColor: "#2f80ff",
    shadowOpacity: 0.9,
    shadowRadius: 24,
  },
  energyRingOuter: {
    position: "absolute",
    width: ORB_SIZE + 32,
    height: ORB_SIZE + 32,
    borderRadius: (ORB_SIZE + 32) / 2,
    borderWidth: 1,
    borderColor: "rgba(97,174,255,0.72)",
  },
  energyRingInner: {
    position: "absolute",
    width: ORB_SIZE + 14,
    height: ORB_SIZE + 14,
    borderRadius: (ORB_SIZE + 14) / 2,
    borderWidth: 1,
    borderColor: "rgba(34,211,238,0.52)",
  },
  ringDashTop: {
    position: "absolute",
    top: -2,
    left: "45%",
    width: 16,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#60a5fa",
  },
  ringDashBottom: {
    position: "absolute",
    bottom: -2,
    right: "42%",
    width: 18,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#22d3ee",
  },
  ringDashLeft: {
    position: "absolute",
    left: -2,
    top: "45%",
    width: 4,
    height: 16,
    borderRadius: 2,
    backgroundColor: "#60a5fa",
  },
  ringDashRight: {
    position: "absolute",
    right: -2,
    bottom: "42%",
    width: 4,
    height: 18,
    borderRadius: 2,
    backgroundColor: "#22d3ee",
  },
  particle: {
    position: "absolute",
    backgroundColor: "#7dd3fc",
    shadowColor: "#7dd3fc",
    shadowOpacity: 0.9,
    shadowRadius: 8,
  },
  orbCore: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "rgba(96,165,250,0.86)",
    backgroundColor: "rgba(5,18,42,0.96)",
    shadowColor: "#2f80ff",
    shadowOpacity: 0.85,
    shadowRadius: 20,
    elevation: 14,
  },
  orbInnerShade: {
    position: "absolute",
    width: ORB_SIZE - 12,
    height: ORB_SIZE - 12,
    borderRadius: (ORB_SIZE - 12) / 2,
    backgroundColor: "rgba(96,165,250,0.13)",
  },
  orbBrainLogo: {
    width: 70,
    height: 70,
    borderRadius: 35,
  },
  // Header and form text styles keep the login readable over the dark background.
  title: {
    color: "#f6f6f0",
    fontSize: 28,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 4,
  },
  subtitle: {
    color: "rgba(246,246,240,0.58)",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 10,
    marginBottom: 28,
    paddingHorizontal: 24,
  },
  form: {
    width: "100%",
  },
  label: {
    color: "#f6f6f0",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 8,
  },
  input: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    color: "#f6f6f0",
    fontSize: 13,
    paddingHorizontal: 12,
    backgroundColor: "rgba(0,0,0,0.28)",
    marginBottom: 16,
  },
  // Password and option controls cover visibility toggle, remember-me, and reset link.
  passwordWrap: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(0,0,0,0.28)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    marginBottom: 16,
  },
  passwordInput: {
    flex: 1,
    color: "#f6f6f0",
    fontSize: 13,
  },
  eye: {
    color: "rgba(246,246,240,0.58)",
    fontSize: 11,
    fontWeight: "800",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 22,
  },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(246,246,240,0.62)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: "#2f80ff",
    borderColor: "#60a5fa",
  },
  check: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
  },
  optionText: {
    color: "rgba(246,246,240,0.62)",
    fontSize: 12,
    fontWeight: "700",
  },
  forgot: {
    color: "#9cc9ff",
    fontSize: 11,
    fontWeight: "800",
  },
  // Button and signup styles finish the login action area.
  primaryBtn: {
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2f80ff",
    shadowColor: "#2f80ff",
    shadowOpacity: 0.42,
    shadowRadius: 18,
    elevation: 12,
    marginBottom: 14,
  },
  disabledBtn: {
    opacity: 0.72,
  },
  primaryText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "900",
  },
  signupRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingTop: 0,
    marginBottom: 8,
  },
  signupMuted: {
    color: "rgba(246,246,240,0.52)",
    fontSize: 12,
    fontWeight: "700",
  },
  signupText: {
    color: "#9cc9ff",
    fontSize: 12,
    fontWeight: "900",
  },
});

// File summary:
// LoginScreen renders the AiHazardShield authentication entry screen.
// It handles Firebase email login, account registration, and password reset.
// It includes the animated orb logo and all styling for the mobile login form.
// App.js shows this screen whenever Firebase reports that no user is signed in.
