// App.js  — AiHazardShield complete entry point
// -----------------------------------------------------------------------------
// Covers:
//   • Notification channel setup + push token registration on mount
//   • Local notifications triggered by Firebase /alerts listener (foreground + background)
//   • Push notifications sent by Python backend (background + killed)
//   • Navigate-to-screen on notification tap
//   • 30-second dedup 3444444444444window to prevent spam
//   • Full LiveScreen + HistoryScreen implementations
// -----------------------------------------------------------------------------
import React, {
  useState, useRef, useEffect, useCallback,
} from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar,
  ActivityIndicator, Dimensions, Animated, ScrollView,
  Platform, Vibration, Alert,
} from "react-native";
import { WebView }      from "react-native-webview";
import { LineChart }    from "react-native-chart-kit";
import * as Notifications from "expo-notifications";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import { onAuthStateChanged, signOut } from "firebase/auth";

import { ref, onValue, query, limitToLast, set } from "firebase/database";
import { auth, db }           from "./Firebaseconfig";
import { setupNotificationChannels } from "./Notificationsetup";
import { registerPushToken }  from "./Pushtoken";
import LoginScreen            from "./LoginScreen";

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------
const { width }       = Dimensions.get("window");
const ESP32_IP        = "10.1.1.110";
const DEDUP_MS        = 30_000;   // same alert type won't re-notify within 30 s
const MAX_HISTORY_PTS = 20;
const BACKEND_STALE_MS = 8_000;
const ALARM_SOUND     = require("./assets/alarm_siren.mp3");

// Converts Firebase values into safe numbers for display and comparisons.
const toNumber = (value, fallback = null) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

// Chooses the visual danger mode from the current fire and gas state.
const getHazardMode = ({
  alertType = "NONE",
  alertActive = false,
  fireDetected = false,
  gasWarn = false,
  probability = 0,
} = {}) => {
  const type = alertActive ? alertType : "NONE";
  const fireHot = type === "FIRE" || type === "FIRE+GAS" || fireDetected || probability >= 70;
  const gasHot = type === "GAS" || type === "FIRE+GAS" || gasWarn;

  if (type === "FIRE+GAS" || (fireHot && gasHot)) return "critical";
  if (fireHot) return "fire";
  if (gasHot) return "gas";
  return "normal";
};

// Returns the color set used by each visual danger mode.
const getModeColors = (mode) => {
  if (mode === "critical") {
    return { accent: C.fire, accent2: C.gasHot, bg: C.fireDark, border: C.fireBorder, glow: C.fireGlow };
  }
  if (mode === "fire") {
    return { accent: C.fire, accent2: C.fireHot, bg: C.fireDim, border: C.fireBorder, glow: C.fireGlow };
  }
  if (mode === "gas") {
    return { accent: C.gas, accent2: C.gasHot, bg: C.gasDim, border: C.gasBorder, glow: C.gasGlow };
  }
  return { accent: C.sage, accent2: C.sageMid, bg: C.glassWhite, border: C.glassBorder, glow: C.glowSage };
};

// -----------------------------------------------------------------------------
// DESIGN TOKENS
// -----------------------------------------------------------------------------
const C = {
  bgDeep:       "#050607",
  bgMid:        "#111315",
  glassWhite:   "rgba(18,20,22,0.76)",
  glassBorder:  "rgba(255,255,255,0.16)",
  glassBorder2: "rgba(255,255,255,0.08)",
  sage:         "#f2f2f2",
  sageDim:      "#1b1d20",
  sageMid:      "#bfc2c4",
  sageGlow:     "rgba(255,255,255,0.14)",
  amber:        "#f7f7f7",
  amberGlow:    "rgba(255,255,255,0.18)",
  amberBorder:  "rgba(255,255,255,0.32)",
  amberDim:     "rgba(255,255,255,0.12)",
  danger:       "#d8d8d8",
  dangerDim:    "rgba(255,255,255,0.12)",
  dangerBorder: "rgba(255,255,255,0.28)",
  fire:         "#ff3434",
  fireHot:      "#ff6b2a",
  fireDark:     "rgba(83,4,4,0.88)",
  fireDim:      "rgba(255,33,33,0.20)",
  fireBorder:   "rgba(255,58,44,0.78)",
  fireGlow:     "rgba(255,20,20,0.32)",
  gas:          "#ffc928",
  gasHot:       "#ff9f0a",
  gasDark:      "rgba(64,41,0,0.86)",
  gasDim:       "rgba(255,190,21,0.20)",
  gasBorder:    "rgba(255,191,36,0.76)",
  gasGlow:      "rgba(255,171,0,0.26)",
  tealDim:      "rgba(255,255,255,0.10)",
  tealBorder:   "rgba(255,255,255,0.24)",
  white:        "#f5f5f5",
  grey:         "#a7a9ac",
  greyDim:      "#62666a",
  glowSage:     "rgba(255,255,255,0.10)",
  glowAmber:    "rgba(255,255,255,0.08)",
};

// -----------------------------------------------------------------------------
// ALERT CONFIGS  (shared by banner + local notifications)
// -----------------------------------------------------------------------------
const ALERT_CONFIGS = {
  "FIRE+GAS": {
    emoji:   "??",
    text:    "CRITICAL ALERT",
    subtext: "FIRE + GAS DETECTED",
    bg:      C.fireDark,
    border:  C.fireBorder,
    accent:  C.fireHot,
    vibrate: [0, 500, 150, 500, 150, 500],
  },
  "FIRE": {
    emoji:   "??",
    text:    "FIRE DETECTED",
    subtext: "TAKE IMMEDIATE ACTION",
    bg:      C.fireDim,
    border:  C.fireBorder,
    accent:  C.fire,
    vibrate: [0, 500, 200, 500],
  },
  "GAS": {
    emoji:   "??",
    text:    "GAS LEAK DETECTED",
    subtext: "VENTILATE AREA IMMEDIATELY",
    bg:      C.gasDim,
    border:  C.gasBorder,
    accent:  C.gas,
    vibrate: [0, 300, 300, 300],
  },
  "false Detection": {
    emoji:   "??",
    text:    "FALSE DETECTION",
    bg:      C.tealDim,
    border:  C.tealBorder,
    vibrate: null,
  },
  "NONE": null,
};

// Per-alert local notification payload
const LOCAL_NOTIF_CONFIGS = {
  "FIRE+GAS": {
    title:           "???? FIRE + GAS ALERT",
    body:            "Fire AND gas detected simultaneously! Evacuate immediately.",
    channelId:       "fire-alerts",
    color:           "#c0443a",
    priority:        Notifications.AndroidNotificationPriority.MAX,
    sticky:          true,
    autoDismiss:     false,
    badge:           1,
  },
  "FIRE": {
    title:           "?? FIRE ALERT",
    body:            "Fire detected by AI camera. Act now.",
    channelId:       "fire-alerts",
    color:           "#c0443a",
    priority:        Notifications.AndroidNotificationPriority.MAX,
    sticky:          true,
    autoDismiss:     false,
    badge:           1,
  },
  "GAS": {
    title:           "?? GAS LEAK ALERT",
    body:            "Gas leak detected. Ventilate area immediately.",
    channelId:       "fire-alerts",
    color:           "#bfc2c4",
    priority:        Notifications.AndroidNotificationPriority.HIGH,
    sticky:          true,
    autoDismiss:     false,
    badge:           1,
  },
  "false Detection": {
    title:           "?? False Detection",
    body:            "Potential fire detected but cleared within 2 seconds.",
    channelId:       "false-detections",
    color:           "#4db8b0",
    priority:        Notifications.AndroidNotificationPriority.DEFAULT,
    sticky:          false,
    autoDismiss:     true,
    badge:           0,
  },
};

// Builds the local notification payload for a specific alert type.
function getLocalNotificationContent(alertType) {
  const cfg = LOCAL_NOTIF_CONFIGS[alertType];
  if (!cfg) return null;

  return {
    title:            cfg.title,
    body:             cfg.body,
    data: {
      alertType,
      screen: "live",     // tap handler reads this to navigate
      source: "local-listener",
    },
    sound:            alertType !== "false Detection" ? "default" : null,
    priority:         cfg.priority,
    color:            cfg.color,
    sticky:           cfg.sticky,
    autoDismiss:      cfg.autoDismiss,
    badge:            cfg.badge,
    ...(Platform.OS === "android" && { channelId: cfg.channelId }),
  };
}

// Sends a local notification when an alert should be shown.
async function scheduleLocalNotification(alertType, trigger = null) {
  const content = getLocalNotificationContent(alertType);
  if (!content) return null;

  return Notifications.scheduleNotificationAsync({
    content,
    trigger,
  });
}

// -----------------------------------------------------------------------------
// MJPEG WEBVIEW HTML
// -----------------------------------------------------------------------------
// Creates the WebView HTML used to stream the ESP32 camera feed.
const getMjpegHtml = (ip) => {
  const streamUrl = `http://${ip}:81/stream`;
  const probeUrl  = `http://${ip}:81/`;
  const configUrl = `http://${ip}/control`;
  return `<!DOCTYPE html><html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#050607;display:flex;align-items:center;justify-content:center;overflow:hidden}
img{width:100%;height:100%;object-fit:contain;display:block}
#error{display:none;color:#f2f2f2;font-family:-apple-system,sans-serif;font-size:13px;text-align:center;padding:20px;position:absolute}
#retry-msg{display:none;color:#8fa892;font-family:-apple-system,sans-serif;font-size:11px;position:absolute;bottom:10px}
</style>
</head>
<body>
<img id="stream"/>
<div id="error">? Stream unavailable<br/>Check ESP32 IP &amp; WiFi</div>
<div id="retry-msg">Retrying…</div>
<script>
const img=document.getElementById('stream');
const err=document.getElementById('error');
const retryMsg=document.getElementById('retry-msg');
let retryTimer=null, failCount=0, probeInterval=null;

async function configureCamera(){
  try{
    await fetch('${configUrl}?var=xclk&val=24');
    await fetch('${configUrl}?var=quality&val=10');
    await fetch('${configUrl}?var=framesize&val=6');
  }catch(e){}
}

function startStream(){
  img.style.display='block';
  err.style.display='none';
  retryMsg.style.display='none';
  img.src='${streamUrl}?t='+Date.now();
  startProbe();
}

function onFail(){
  if(img.style.display==='none') return;
  failCount++;
  img.style.display='none';
  err.style.display='block';
  retryMsg.style.display='block';
  stopProbe();
  const delay = failCount > 3 ? 5000 : 3000;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(()=>{ failCount=0; startStream(); }, delay);
}

img.onerror = onFail;
img.onabort = onFail;

function startProbe(){
  stopProbe();
  probeInterval = setInterval(()=>{
    const p = new Image();
    p.onerror = ()=>{ if(img.style.display!=='none') onFail(); };
    p.src = '${probeUrl}?t='+Date.now();
  }, 10000);
}

function stopProbe(){
  if(probeInterval){ clearInterval(probeInterval); probeInterval=null; }
}

document.addEventListener('visibilitychange', ()=>{
  if(document.hidden){ stopProbe(); clearTimeout(retryTimer); }
  else { startStream(); }
});

configureCamera().then(startStream);
</script>
</body></html>`;
};

const STREAM_SOURCE = { html: getMjpegHtml(ESP32_IP) };

// Renders the live camera WebView with small detection overlays.
const CameraStreamView = React.memo(function CameraStreamView({
  webviewKey,
  isLoadingStream,
  fadeAnim,
  onLoad,
  onError,
  onHttpError,
  probability,
  probColor,
  detectionLabel,
}) {
  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      {isLoadingStream && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={C.sage} />
          <Text style={styles.loadingText}>Connecting to {ESP32_IP}...</Text>
        </View>
      )}
      <WebView
        key={webviewKey}
        originWhitelist={["*"]}
        source={STREAM_SOURCE}
        style={styles.webview}
        cacheEnabled={false}
        javaScriptEnabled
        domStorageEnabled={false}
        onLoad={onLoad}
        onError={onError}
        onHttpError={onHttpError}
        scrollEnabled={false}
        mixedContentMode="always"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
      />
      <View style={styles.overlayTR}>
        <Text style={[styles.overlayBig, { color: probColor }]}>{probability}%</Text>
        <Text style={styles.overlaySmall}>PROB</Text>
      </View>
      <View style={styles.overlayBL}>
        <View style={[styles.overlayDot, { backgroundColor: probColor }]} />
        <Text style={[styles.overlayTag, { color: probColor }]}>{detectionLabel}</Text>
      </View>
      <View style={styles.overlayBR}>
        <Text style={styles.overlayMhz}>24 MHz</Text>
      </View>
    </Animated.View>
  );
});

// -----------------------------------------------------------------------------
// SHARED UI COMPONENTS
// -----------------------------------------------------------------------------
// Shared glass card wrapper used by dashboard panels.
const GlassCard = ({ children, style }) => (
  <Animated.View style={[styles.glassCard, style]}>{children}</Animated.View>
);

// Shows a compact status label with an optional danger glow.
const PillBadge = ({ label, color, glow = false }) => (
  <View style={[
    styles.pill,
    { backgroundColor: color + "22", borderColor: color + "55" },
    glow && styles.pillDanger,
  ]}>
    <View style={[styles.pillDot, { backgroundColor: color }, glow && styles.pillDotGlow]} />
    <Text style={[styles.pillText, { color }]}>{label}</Text>
  </View>
);

// Displays one small ON/OFF system status tile.
const BentoTile = ({ label, icon, active, color, sublabel, danger = false, pulseStyle }) => (
  <Animated.View style={[
    styles.bentoTile,
    active && { borderColor: color + "44", backgroundColor: color + "12" },
    danger && styles.bentoTileDanger,
    danger && pulseStyle,
  ]}>
    <Text style={[styles.bentoIcon,  { color: active ? color : C.greyDim }]}>{icon}</Text>
    <Text style={[styles.bentoVal,   { color: active ? color : C.greyDim }]}>
      {active ? "ON" : "OFF"}
    </Text>
    <Text style={styles.bentoLabel}>{label}</Text>
    {sublabel ? <Text style={styles.bentoSublabel}>{sublabel}</Text> : null}
  </Animated.View>
);

// Displays one sensor reading and highlights it when dangerous.
const SensorTile = ({ icon, label, value, unit, color, warn, pulseStyle }) => (
  <Animated.View style={[
    styles.sensorTile,
    warn && { borderColor: color + "55", backgroundColor: color + "10" },
    warn && pulseStyle,
  ]}>
    <View style={styles.sensorTop}>
      <Text style={styles.sensorIcon}>{icon}</Text>
      {warn && <View style={[styles.sensorWarnDot, { backgroundColor: color }]} />}
    </View>
    <Text style={[styles.sensorValue, { color: warn ? color : C.white }]}>
      {value !== null && value !== undefined && !isNaN(value)
        ? `${typeof value === "number"
            ? value.toFixed(value % 1 === 0 ? 0 : 1)
            : value}${unit}`
        : "--"}
    </Text>
    <Text style={styles.sensorLabel}>{label}</Text>
  </Animated.View>
);

// Draws the full-screen glow and pulsing border during danger modes.
const HazardOverlay = ({ mode, pulseAnim, flashAnim }) => {
  if (mode === "normal") return null;
  const colors = getModeColors(mode);
  return (
    <View pointerEvents="none" style={styles.hazardLayer}>
      <Animated.View
        style={[
          styles.hazardWash,
          {
            backgroundColor: colors.glow,
            opacity: flashAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [mode === "critical" ? 0.18 : 0.10, mode === "critical" ? 0.42 : 0.28],
            }),
          },
        ]}
      />
      <Animated.View
        style={[
          styles.hazardFrame,
          {
            borderColor: colors.border,
            opacity: flashAnim,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      />
    </View>
  );
};

// -----------------------------------------------------------------------------
// ALERT BANNER
// -----------------------------------------------------------------------------
// Shows the animated alert banner and controls alert vibration.
const AlertBanner = ({ alertType }) => {
  const config     = ALERT_CONFIGS[alertType];
  const translateY = useRef(new Animated.Value(-80)).current;
  const opacity    = useRef(new Animated.Value(0)).current;
  const flashAnim  = useRef(new Animated.Value(1)).current;
  const flashLoop  = useRef(null);

  // Animates the banner in and out whenever the alert type changes.
  useEffect(() => {
    if (config) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0, useNativeDriver: true, damping: 14, stiffness: 140,
        }),
        Animated.timing(opacity, {
          toValue: 1, duration: 250, useNativeDriver: true,
        }),
      ]).start();

      if (alertType === "FIRE" || alertType === "FIRE+GAS") {
        flashLoop.current = Animated.loop(Animated.sequence([
          Animated.timing(flashAnim, { toValue: 0.3, duration: 400, useNativeDriver: true }),
          Animated.timing(flashAnim, { toValue: 1,   duration: 400, useNativeDriver: true }),
        ]));
        flashLoop.current.start();
      } else {
        flashAnim.setValue(1);
      }

      if (config.vibrate) Vibration.vibrate(config.vibrate, alertType !== "false Detection");
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -80, duration: 300, useNativeDriver: true }),
        Animated.timing(opacity,    { toValue: 0,   duration: 300, useNativeDriver: true }),
      ]).start();
      Vibration.cancel();
      if (flashLoop.current) flashLoop.current.stop();
      flashAnim.setValue(1);
    }

    return () => {
      if (flashLoop.current) flashLoop.current.stop();
      Vibration.cancel();
    };
  }, [alertType]);

  if (!config) return null;

  return (
    <Animated.View style={[
      styles.alertBanner,
      {
        backgroundColor: config.bg,
        borderColor:     config.border,
        transform:       [{ translateY }],
        opacity: alertType === "FIRE" || alertType === "FIRE+GAS"
          ? flashAnim
          : opacity,
      },
    ]}>
      <Animated.Text
        style={[
          styles.alertEmoji,
          { transform: [{ scale: flashAnim.interpolate({ inputRange: [0.3, 1], outputRange: [0.9, 1.14] }) }] },
        ]}
      >
        {config.emoji}
      </Animated.Text>
      <View style={styles.alertCopy}>
        <Text style={styles.alertText}>{config.text}</Text>
        {config.subtext ? (
          <Text style={[styles.alertSubText, { color: config.accent }]}>{config.subtext}</Text>
        ) : null}
      </View>
      <Animated.Text
        style={[
          styles.alertEmoji,
          { transform: [{ scale: flashAnim.interpolate({ inputRange: [0.3, 1], outputRange: [0.9, 1.14] }) }] },
        ]}
      >
        {config.emoji}
      </Animated.Text>
    </Animated.View>
  );
};

// -----------------------------------------------------------------------------
// HISTORY SCREEN
// -----------------------------------------------------------------------------
const CHART_W = width - 32;

const chartBase = {
  backgroundGradientFrom: "#111315",
  backgroundGradientTo:   "#050607",
  decimalPlaces:          1,
  color:       (opacity = 1) => `rgba(255,255,255,${opacity * 0.18})`,
  labelColor:  ()            => C.grey,
  propsForDots: { r: "3" },
  propsForBackgroundLines: { stroke: "rgba(255,255,255,0.06)" },
};

// Displays recent temperature, gas, and fire probability history.
function HistoryScreen() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [noData,  setNoData]  = useState(false);

  // Reads the latest history records from Firebase.
  useEffect(() => {
    const histRef = query(ref(db, "/history"), limitToLast(MAX_HISTORY_PTS));
    const unsub = onValue(histRef, (snap) => {
      setLoading(false);
      const raw = snap.val();
      if (!raw) { setNoData(true); return; }
      setNoData(false);
      const arr = Object.values(raw)
        .map((r) => ({
          ...r,
          temperature: toNumber(r.temperature, 0),
          gas_level:   toNumber(r.gas_level, 0),
          fire_prob:   toNumber(r.fire_prob, 0),
          ts:          toNumber(r.ts, 0),
        }))
        .sort((a, b) => a.ts - b.ts);
      setHistory(arr);
    }, () => {
      setLoading(false);
      setNoData(true);
    });
    return () => unsub();
  }, []);

  if (loading) return (
    <View style={hStyles.center}>
      <ActivityIndicator size="large" color={C.sage} />
      <Text style={hStyles.loadingText}>Loading history…</Text>
    </View>
  );

  if (noData) return (
    <View style={hStyles.center}>
      <Text style={{ fontSize: 36 }}>??</Text>
      <Text style={hStyles.noDataTitle}>No history yet</Text>
      <Text style={hStyles.noDataSub}>
        Data will appear once ESP32 starts pushing records.
      </Text>
    </View>
  );

  // Prepares chart arrays and latest values from history records.
  const temps  = history.map(r => toNumber(r.temperature, 0));
  const gases  = history.map(r => toNumber(r.gas_level, 0));
  const probs  = history.map(r => +(toNumber(r.fire_prob, 0) * 100).toFixed(1));
  const labels = history.map((_, i) => i % 5 === 0 ? `#${i + 1}` : "");
  const makeData = (values) => ({ labels, datasets: [{ data: values }] });

  const latestTemp = temps[temps.length - 1]?.toFixed(1) ?? "--";
  const latestGas  = gases[gases.length - 1]             ?? "--";
  const latestProb = probs[probs.length - 1]?.toFixed(1) ?? "--";
  const maxTemp    = Math.max(...temps);
  const maxGas     = Math.max(...gases);
  const maxProb    = Math.max(...probs);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "transparent" }}
      contentContainerStyle={hStyles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {/* -- Summary chips -- */}
      <View style={hStyles.chips}>
        <View style={[hStyles.chip, { borderColor: C.danger + "55" }]}>
          <Text style={hStyles.chipIcon}>???</Text>
          <Text style={[hStyles.chipVal, { color: C.danger }]}>{latestTemp}°C</Text>
          <Text style={hStyles.chipLbl}>Now</Text>
        </View>
        <View style={[hStyles.chip, { borderColor: C.amber + "55" }]}>
          <Text style={hStyles.chipIcon}>??</Text>
          <Text style={[hStyles.chipVal, { color: C.amber }]}>{latestGas}</Text>
          <Text style={hStyles.chipLbl}>Gas ppm</Text>
        </View>
        <View style={[hStyles.chip, { borderColor: C.sage + "55" }]}>
          <Text style={hStyles.chipIcon}>??</Text>
          <Text style={[hStyles.chipVal, { color: C.sage }]}>{latestProb}%</Text>
          <Text style={hStyles.chipLbl}>Fire Prob</Text>
        </View>
      </View>

      {/* -- Temperature chart -- */}
      <View style={hStyles.chartCard}>
        <View style={hStyles.chartHeader}>
          <Text style={hStyles.chartTitle}>???  Temperature</Text>
          <View style={hStyles.chartBadge}>
            <Text style={[hStyles.chartBadgeText, { color: C.danger }]}>
              Max {maxTemp.toFixed(1)}°C
            </Text>
          </View>
        </View>
        <LineChart
          data={makeData(temps)}
          width={CHART_W - 32}
          height={160}
          chartConfig={{
            ...chartBase,
            color: (opacity = 1) => `rgba(192,68,58,${opacity})`,
          }}
          bezier
          withInnerLines
          withOuterLines={false}
          withShadow={false}
          style={hStyles.chart}
        />
        <Text style={hStyles.chartUnit}>°C — last {history.length} records</Text>
      </View>

      {/* -- Gas chart -- */}
      <View style={hStyles.chartCard}>
        <View style={hStyles.chartHeader}>
          <Text style={hStyles.chartTitle}>??  Gas Level</Text>
          <View style={hStyles.chartBadge}>
            <Text style={[hStyles.chartBadgeText, { color: C.amber }]}>
              Max {maxGas} ppm
            </Text>
          </View>
        </View>
        <LineChart
          data={makeData(gases)}
          width={CHART_W - 32}
          height={160}
          chartConfig={{
            ...chartBase,
            color: (opacity = 1) => `rgba(190,192,194,${opacity})`,
          }}
          bezier
          withInnerLines
          withOuterLines={false}
          withShadow={false}
          style={hStyles.chart}
        />
        <Text style={hStyles.chartUnit}>ppm — danger threshold: 200</Text>
      </View>

      {/* -- Fire probability chart -- */}
      <View style={hStyles.chartCard}>
        <View style={hStyles.chartHeader}>
          <Text style={hStyles.chartTitle}>??  Fire Probability</Text>
          <View style={hStyles.chartBadge}>
            <Text style={[hStyles.chartBadgeText, { color: C.sage }]}>
              Max {maxProb.toFixed(1)}%
            </Text>
          </View>
        </View>
        <LineChart
          data={makeData(probs)}
          width={CHART_W - 32}
          height={160}
          chartConfig={{
            ...chartBase,
            color: (opacity = 1) => `rgba(242,242,242,${opacity})`,
          }}
          bezier
          withInnerLines
          withOuterLines={false}
          withShadow={false}
          style={hStyles.chart}
        />
        <Text style={hStyles.chartUnit}>% — danger threshold: 60%</Text>
      </View>

      <Text style={hStyles.footer}>
        Showing last {history.length} of {MAX_HISTORY_PTS} max records · auto-updates
      </Text>
    </ScrollView>
  );
}

// -----------------------------------------------------------------------------
// LIVE SCREEN
// -----------------------------------------------------------------------------
// Main live dashboard for camera, sensors, alerts, and stream controls.
function LiveScreen() {
  const [isStreaming,      setIsStreaming]      = useState(false);
  const [isLoadingStream,  setIsLoadingStream]  = useState(false);
  const [streamStatus,     setStreamStatus]     = useState(false);
  const [webviewKey,       setWebviewKey]       = useState(0);
  const [probability,      setProbability]      = useState(0);
  const [fireDetected,     setFireDetected]     = useState(false);
  const [detectionLabel,   setDetectionLabel]   = useState("--");
  const [lastUpdated,      setLastUpdated]      = useState("");
  const [temperature,      setTemperature]      = useState(null);
  const [gasLevel,         setGasLevel]         = useState(null);
  const [alertType,        setAlertType]        = useState("NONE");
  const [alertActive,      setAlertActive]      = useState(false);
  const [backendConnected, setBackendConnected] = useState(null);

  const pulseAnim       = useRef(new Animated.Value(1)).current;
  const hazardPulseAnim = useRef(new Animated.Value(1)).current;
  const hazardFlashAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim        = useRef(new Animated.Value(0)).current;
  const barAnim         = useRef(new Animated.Value(0)).current;
  const streamStatusRef = useRef(false);
  const backendLastSeenRef = useRef(null);
  const backendRunningRef = useRef(false);
  const watchdogRef     = useRef(null);

  // Keep ref in sync for watchdog timer
  useEffect(() => { streamStatusRef.current = streamStatus; }, [streamStatus]);

  // Watchdog: reload webview if stream stops responding
  useEffect(() => {
    if (!isStreaming) return;
    watchdogRef.current = setInterval(() => {
      if (!streamStatusRef.current) {
        setWebviewKey((k) => k + 1);
        setIsLoadingStream(true);
      }
    }, 15000);
    return () => clearInterval(watchdogRef.current);
  }, [isStreaming]);

  // Pulse animation for LIVE badge
  useEffect(() => {
    if (!isStreaming) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.7, duration: 900, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,   duration: 900, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [isStreaming]);

  // Bar animation
  useEffect(() => {
    Animated.timing(barAnim, {
      toValue:        probability / 100,
      duration:       700,
      useNativeDriver: false,
    }).start();
  }, [probability]);

  // -- Firebase: fire detection data -------------------------------
  useEffect(() => {
    const fireRef = ref(db, "/fire_detection");
    const unsub = onValue(
      fireRef,
      (snap) => {
        const data = snap.val();
        const hasData =
          data !== null &&
          (typeof data.probability   === "number" ||
           typeof data.fire_detected === "boolean" ||
           typeof data.label         === "string");

        if (!hasData) return;

        setProbability(Math.round((data.probability ?? 0) * 100));
        setFireDetected(data.fire_detected ?? false);
        setDetectionLabel(data.label ?? "Safe");
        setLastUpdated(new Date().toLocaleTimeString());
      },
      () => {}
    );

    return () => unsub();
  }, []);

  // -- Firebase: Python backend heartbeat from main.py -------------
  useEffect(() => {
    const statusRef = ref(db, "/backend_status");
    const refreshStatus = (lastSeen, running = true) => {
      if (!running || !lastSeen) {
        setBackendConnected(false);
        return;
      }
      setBackendConnected(Date.now() - lastSeen <= BACKEND_STALE_MS);
    };

    const unsub = onValue(statusRef, (snap) => {
      const data = snap.val();
      const timestamp = toNumber(data?.timestamp);
      const lastSeen = timestamp ? timestamp * 1000 : null;
      const running = data?.running === true;
      backendLastSeenRef.current = lastSeen;
      backendRunningRef.current = running;
      refreshStatus(lastSeen, running);
    }, () => {
      backendLastSeenRef.current = null;
      backendRunningRef.current = false;
      setBackendConnected(false);
    });

    const timer = setInterval(() => {
      refreshStatus(backendLastSeenRef.current, backendRunningRef.current);
    }, 2000);

    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  // -- Firebase: sensor data ----------------------------------------
  useEffect(() => {
    const unsub = onValue(ref(db, "/sensors"), (snap) => {
      const data = snap.val();
      if (!data) return;
      const nextTemp = toNumber(data.temperature);
      const nextGas  = toNumber(data.gas_level);
      if (nextTemp !== null) setTemperature(nextTemp);
      if (nextGas !== null) setGasLevel(nextGas);
    });
    return () => unsub();
  }, []);

  // -- Firebase: alert state ----------------------------------------
  useEffect(() => {
    const unsub = onValue(ref(db, "/alerts"), (snap) => {
      const data = snap.val();
      if (!data) return;
      setAlertType(data.type   ?? "NONE");
      setAlertActive(data.active ?? false);
    });
    return () => unsub();
  }, []);

  // Starts the ESP32 camera stream in the WebView.
  const handleConnect = useCallback(() => {
    if (isStreaming) return;
    setIsLoadingStream(true);
    setStreamStatus(false);
    setWebviewKey((k) => k + 1);
    setIsStreaming(true);
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, [isStreaming]);

  // Stops the camera stream and clears loading state.
  const handleDisconnect = useCallback(() => {
    setIsStreaming(false);
    setStreamStatus(false);
    setIsLoadingStream(false);
    fadeAnim.setValue(0);
    clearInterval(watchdogRef.current);
  }, []);

  // Calculates display colors and danger flags for the live UI.
  const probColor       = probability >= 70 ? C.fire : probability >= 40 ? C.gas : C.sage;
  const tempWarn        = temperature !== null && temperature > 45;
  const gasWarn         = gasLevel    !== null && gasLevel    > 200;
  const hazardMode      = getHazardMode({
    alertType,
    alertActive,
    fireDetected,
    gasWarn,
    probability,
  });
  const modeColors      = getModeColors(hazardMode);
  const tempColor       = tempWarn ? C.fire : C.sage;
  const gasColor        = gasWarn  ? C.gas  : C.sage;
  const dangerPulseStyle = hazardMode !== "normal"
    ? {
        borderColor: modeColors.border,
        shadowColor: modeColors.accent,
        shadowOpacity: hazardFlashAnim.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.72] }),
        shadowRadius: hazardFlashAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 24] }),
        transform: [{ scale: hazardPulseAnim }],
      }
    : null;
  const fireDanger       = hazardMode === "fire" || hazardMode === "critical";
  const gasDanger        = hazardMode === "gas" || hazardMode === "critical";
  const backendActive   = backendConnected === true;
  const backendSublabel =
    backendConnected === null ? "Checking…" :
    backendConnected          ? "Connected" : "Offline";
  const activeAlert     = alertActive && alertType !== "NONE" ? alertType : null;

  // Runs the pulsing glow animation while any danger mode is active.
  useEffect(() => {
    if (hazardMode === "normal") {
      hazardPulseAnim.setValue(1);
      hazardFlashAnim.setValue(0);
      return;
    }

    const pulseLoop = Animated.loop(Animated.sequence([
      Animated.timing(hazardPulseAnim, {
        toValue: hazardMode === "critical" ? 1.035 : 1.018,
        duration: hazardMode === "critical" ? 360 : 620,
        useNativeDriver: false,
      }),
      Animated.timing(hazardPulseAnim, {
        toValue: 1,
        duration: hazardMode === "critical" ? 360 : 620,
        useNativeDriver: false,
      }),
    ]));
    const flashLoop = Animated.loop(Animated.sequence([
      Animated.timing(hazardFlashAnim, {
        toValue: 1,
        duration: hazardMode === "critical" ? 320 : 600,
        useNativeDriver: false,
      }),
      Animated.timing(hazardFlashAnim, {
        toValue: 0,
        duration: hazardMode === "critical" ? 320 : 600,
        useNativeDriver: false,
      }),
    ]));

    pulseLoop.start();
    flashLoop.start();
    return () => {
      pulseLoop.stop();
      flashLoop.stop();
    };
  }, [hazardMode]);

  return (
    <View style={[styles.liveRoot, hazardMode !== "normal" && { backgroundColor: modeColors.bg }]}>
      <StatusBar barStyle="light-content" backgroundColor={hazardMode === "normal" ? C.bgDeep : "#210202"} />
      <HazardOverlay mode={hazardMode} pulseAnim={hazardPulseAnim} flashAnim={hazardFlashAnim} />
      <View style={styles.glowTopLeft}     pointerEvents="none" />
      <View style={styles.glowBottomRight} pointerEvents="none" />

      {/* -- Header -- */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[styles.logoBox, hazardMode !== "normal" && { borderColor: modeColors.border, shadowColor: modeColors.accent }]}>
            <Text style={styles.logoEmoji}>??</Text>
          </View>
          <View>
            <Text style={styles.headerTitle}>AiHazardShield</Text>
            <Text style={styles.headerSub}>AI · Hazard Shield · 24 MHz</Text>
          </View>
        </View>
        <View style={[
          styles.liveBadge,
          isStreaming ? styles.liveBadgeOn : styles.liveBadgeOff,
          hazardMode !== "normal" && { borderColor: modeColors.border, backgroundColor: modeColors.bg, shadowColor: modeColors.accent, shadowOpacity: 0.55, shadowRadius: 16 },
        ]}>
          {isStreaming && (
            <Animated.View
              style={[styles.livePulse, { transform: [{ scale: pulseAnim }] }]}
            />
          )}
          <Text style={[
            styles.liveBadgeText,
            { color: hazardMode !== "normal" ? modeColors.accent : isStreaming ? C.sage : C.greyDim },
          ]}>
            {hazardMode === "critical" ? "CRITICAL" : hazardMode === "fire" ? "FIRE ALERT" : hazardMode === "gas" ? "GAS ALERT" : isStreaming ? "LIVE" : "OFFLINE"}
          </Text>
        </View>
      </View>

      {/* -- Alert banner -- */}
      <AlertBanner alertType={activeAlert} />

      {/* -- Camera viewport -- */}
      <View style={styles.viewport}>
        {!isStreaming ? (
          <View style={styles.placeholder}>
            <Animated.View style={[
              styles.placeholderOrb,
              hazardMode !== "normal" && {
                borderColor: modeColors.border,
                backgroundColor: modeColors.bg,
                shadowColor: modeColors.accent,
                shadowOpacity: 0.62,
                shadowRadius: 22,
                transform: [{ scale: hazardPulseAnim }],
              },
            ]}>
              <Text style={{ fontSize: 32 }}>??</Text>
            </Animated.View>
            <Text style={[styles.placeholderTitle, hazardMode !== "normal" && { color: modeColors.accent }]}>Camera Standby</Text>
            <Text style={[styles.placeholderSub, hazardMode !== "normal" && { color: modeColors.accent2 }]}>Tap Connect to start stream</Text>
          </View>
        ) : (
          <CameraStreamView
            webviewKey={webviewKey}
            isLoadingStream={isLoadingStream}
            fadeAnim={fadeAnim}
            onLoad={() => { setIsLoadingStream(false); setStreamStatus(true); }}
            onError={() => { setIsLoadingStream(false); setStreamStatus(false); }}
            onHttpError={() => setStreamStatus(false)}
            probability={probability}
            probColor={probColor}
            detectionLabel={detectionLabel}
          />
        )}
      </View>

      {/* -- Scrollable bottom section -- */}
      <ScrollView
        contentContainerStyle={styles.bottom}
        showsVerticalScrollIndicator={false}
      >
        {/* -- Sensor row -- */}
        <View style={styles.sensorRow}>
          <SensorTile
            icon="???" label="Temperature"
            value={temperature} unit="°C"
            color={tempColor} warn={tempWarn}
            pulseStyle={tempWarn ? dangerPulseStyle : null}
          />
          <SensorTile
            icon="??" label="Gas (MQ-2)"
            value={gasLevel} unit=" ppm"
            color={gasDanger ? C.gas : gasColor} warn={gasWarn || gasDanger}
            pulseStyle={gasDanger ? dangerPulseStyle : null}
          />
          <Animated.View style={[
            styles.alertChip,
            activeAlert
              ? {
                  borderColor:     ALERT_CONFIGS[activeAlert]?.border ?? C.glassBorder,
                  backgroundColor: ALERT_CONFIGS[activeAlert]?.bg     ?? C.glassWhite,
                }
              : { borderColor: C.glassBorder2, backgroundColor: C.glassWhite },
            hazardMode !== "normal" && dangerPulseStyle,
          ]}>
            <Text style={styles.alertChipEmoji}>
              {activeAlert ? ALERT_CONFIGS[activeAlert]?.emoji : "???"}
            </Text>
            <Text style={[
              styles.alertChipText,
              { color: activeAlert ? C.white : C.grey },
            ]}>
              {activeAlert ? alertType.replace("+", " +\n") : "All\nClear"}
            </Text>
          </Animated.View>
        </View>

        {/* -- Fire probability card -- */}
        <GlassCard style={[
          fireDanger && styles.probCardDanger,
          fireDanger && dangerPulseStyle,
        ]}>
          <View style={styles.probHeader}>
            <Text style={styles.cardLabel}>FIRE PROBABILITY</Text>
            <Text style={[styles.probValue, { color: fireDanger ? C.fire : probColor }]}>{probability}%</Text>
          </View>
          <View style={styles.barTrack}>
            <Animated.View style={[
              styles.barFill,
              {
                width: barAnim.interpolate({
                  inputRange:  [0, 1],
                  outputRange: ["0%", "100%"],
                }),
                backgroundColor: fireDanger ? C.fire : probColor,
              },
            ]} />
            <View style={[styles.tick, { left: "40%" }]} />
            <View style={[styles.tick, { left: "70%" }]} />
          </View>
          <View style={styles.barLegend}>
            {["Safe", "Caution", "Danger"].map((t, i) => (
              <Text key={i} style={styles.legendText}>{t}</Text>
            ))}
          </View>
          <View style={styles.probFooter}>
            <PillBadge label={fireDanger ? "DANGER" : detectionLabel} color={fireDanger ? C.fire : probColor} glow={fireDanger} />
            <Text style={styles.ts}>
              {lastUpdated ? `Updated ${lastUpdated}` : "Waiting for data…"}
            </Text>
          </View>
        </GlassCard>

        {/* -- Bento status grid -- */}
        <View style={styles.bentoGrid}>
          <BentoTile
            label="Camera" icon="??"
            active={streamStatus} color={C.sage}
            sublabel={streamStatus ? "Streaming" : "Idle"}
          />
          <BentoTile
            label="AI Backend" icon="??"
            active={backendActive} color={C.sage}
            sublabel={backendSublabel}
          />
          <BentoTile
            label="Safety" icon="???"
            active={!activeAlert || alertType === "false Detection"}
            color={activeAlert && alertType !== "false Detection" ? modeColors.accent : C.sage}
            danger={hazardMode === "critical"}
            pulseStyle={hazardMode === "critical" ? dangerPulseStyle : null}
            sublabel={
              alertType === "FIRE+GAS"        ? "FIRE+GAS"   :
              alertType === "FIRE"            ? "FIRE"       :
              alertType === "GAS"             ? "GAS LEAK"   :
              alertType === "false Detection" ? "False Det." : "Clear"
            }
          />
        </View>

        {hazardMode !== "normal" && (
          <Animated.View style={[
            styles.alarmStrip,
            {
              borderColor: modeColors.border,
              backgroundColor: modeColors.bg,
              shadowColor: modeColors.accent,
              shadowOpacity: hazardFlashAnim.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.7] }),
            },
          ]}>
            <Text style={[styles.alarmWave, { color: modeColors.accent }]}>~~~</Text>
            <Text style={[styles.alarmStripText, { color: modeColors.accent }]}>ALARM ACTIVE</Text>
            <Text style={[styles.alarmWave, { color: modeColors.accent }]}>~~~</Text>
          </Animated.View>
        )}

        {/* -- Connect / Stop buttons -- */}
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.btn, isStreaming ? styles.btnStreaming : styles.btnConnect]}
            onPress={handleConnect}
            disabled={isStreaming}
            activeOpacity={0.8}
          >
            <Text style={[styles.btnText, { color: isStreaming ? C.sage : C.bgDeep }]}>
              {isStreaming ? "? Streaming" : "Connect"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnStop]}
            onPress={handleDisconnect}
            activeOpacity={0.8}
          >
            <Text style={[styles.btnText, { color: C.grey }]}>Stop</Text>
          </TouchableOpacity>
        </View>

        {/* -- Force reconnect -- */}
        {isStreaming && !streamStatus && (
          <TouchableOpacity
            style={styles.btnReconnect}
            onPress={() => { setIsLoadingStream(true); setWebviewKey((k) => k + 1); }}
            activeOpacity={0.8}
          >
            <Text style={styles.btnReconnectText}>?  Force Reconnect</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

// -----------------------------------------------------------------------------
// SMART CONTROL SCREEN
// -----------------------------------------------------------------------------
// Animated lamp control used by the Smart Control screen.
const LampToggle = ({ isOn, onToggle }) => {
  const glow = useRef(new Animated.Value(isOn ? 1 : 0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // Fades the lamp glow when the lamp state changes.
  useEffect(() => {
    Animated.timing(glow, {
      toValue: isOn ? 1 : 0,
      duration: 420,
      useNativeDriver: false,
    }).start();
  }, [isOn]);

  // Pulses the light while the lamp is turned on.
  useEffect(() => {
    let loop;
    if (isOn) {
      loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: false }),
      ]));
      loop.start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(0);
    }

    return () => {
      if (loop) loop.stop();
    };
  }, [isOn]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onToggle}
      onPressIn={() => Animated.spring(press, { toValue: 0.97, useNativeDriver: false }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, friction: 5, useNativeDriver: false }).start()}
      style={styles.lampTapArea}
    >
      <Animated.View style={[styles.lampScene, { transform: [{ scale: press }] }]}>
        <Animated.View
          style={[
            styles.lampHalo,
            {
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.65] }),
              transform: [
                {
                  scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] }),
                },
              ],
            },
          ]}
        />
        <View style={styles.lampCable} />
        <View style={styles.lampTopCap} />
        <View style={styles.lampNeck} />
        <View style={styles.lampBraceLeft} />
        <View style={styles.lampBraceRight} />
        <View style={styles.lampShade}>
          <Text style={styles.lampMark}>E</Text>
        </View>
        <View style={styles.lampShadeLip} />
        <Animated.View
          style={[
            styles.lampBulbGlow,
            {
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.12, 1] }),
              transform: [
                {
                  scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.lampBulb,
            {
              backgroundColor: glow.interpolate({
                inputRange: [0, 1],
                outputRange: ["#27313a", "#fff1bf"],
              }),
            },
          ]}
        />
        <Animated.View
          style={[
            styles.lampBeam,
            {
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.82] }),
            },
          ]}
        />
        <Animated.View
          style={[
            styles.lampFloorGlow,
            {
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }),
              transform: [
                {
                  scaleX: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1.08] }),
                },
              ],
            },
          ]}
        />
        <Text style={[styles.buzzerHint, styles.lampHint]}>
          {isOn ? "Tap to turn lamp off" : "Tap to turn lamp on"}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
};

// Animated buzzer control used to toggle the alarm device.
const BuzzerToggle = ({ isOn, onToggle }) => {
  const glow = useRef(new Animated.Value(isOn ? 1 : 0)).current;
  const press = useRef(new Animated.Value(1)).current;

  // Presses and glows the buzzer when its state changes.
  useEffect(() => {
    Animated.timing(glow, {
      toValue: isOn ? 1 : 0,
      duration: 260,
      useNativeDriver: false,
    }).start();
  }, [isOn]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onToggle}
      onPressIn={() => Animated.spring(press, { toValue: 0.95, useNativeDriver: false }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, friction: 5, useNativeDriver: false }).start()}
      style={[styles.buzzerButton, isOn && styles.buzzerButtonOn]}
    >
      <Animated.View
        style={[
          styles.buzzerPad,
          {
            transform: [{ scale: press }],
            shadowOpacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.85] }),
          },
        ]}
      >
        <View style={styles.buzzerScrewRow}>
          <View style={styles.buzzerScrew} />
          <View style={styles.buzzerScrew} />
        </View>
        <Animated.View
          style={[
            styles.buzzerRedButton,
            {
              transform: [
                {
                  translateY: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 4] }),
                },
              ],
            },
          ]}
        />
        <View style={styles.buzzerScrewRow}>
          <View style={styles.buzzerScrew} />
          <View style={styles.buzzerScrew} />
        </View>
      </Animated.View>

      <Text style={[styles.buzzerIcon, isOn && { color: C.amber }]}>
        {isOn ? "BUZZING" : "SILENT"}
      </Text>
      <Text style={styles.buzzerHint}>
        {isOn ? "Tap to turn buzzer off" : "Tap to turn buzzer on"}
      </Text>
    </TouchableOpacity>
  );
};

// Animated window control used to open or close the servo.
const ServoWindowToggle = ({ isOpen, onToggle }) => {
  const open = useRef(new Animated.Value(isOpen ? 1 : 0)).current;
  const press = useRef(new Animated.Value(1)).current;

  // Moves the window panel when the servo state changes.
  useEffect(() => {
    Animated.spring(open, {
      toValue: isOpen ? 1 : 0,
      friction: 7,
      tension: 70,
      useNativeDriver: false,
    }).start();
  }, [isOpen]);

  const panelTransform = [
    {
      translateX: open.interpolate({ inputRange: [0, 1], outputRange: [0, 34] }),
    },
    {
      translateY: open.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }),
    },
    {
      rotateZ: open.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "-12deg"] }),
    },
  ];

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onToggle}
      onPressIn={() => Animated.spring(press, { toValue: 0.97, useNativeDriver: false }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, friction: 5, useNativeDriver: false }).start()}
      style={[styles.windowButton, isOpen && styles.windowButtonOpen]}
    >
      <Animated.View style={[styles.windowScene, { transform: [{ scale: press }] }]}>
        <View style={styles.windowFrame}>
          <View style={styles.windowBarVertical} />
          <View style={styles.windowBarHorizontal} />
          <View style={[styles.windowBarVertical, styles.windowBarRight]} />
        </View>
        <Animated.View style={[styles.windowPanel, { transform: panelTransform }]}>
          <View style={styles.windowPanelBarVertical} />
          <View style={styles.windowPanelBarHorizontal} />
        </Animated.View>
      </Animated.View>

      <Text style={[styles.buzzerIcon, isOpen && { color: C.amber }]}>
        {isOpen ? "WINDOW OPEN" : "WINDOW CLOSED"}
      </Text>
      <Text style={styles.buzzerHint}>
        {isOpen ? "Tap to close servo" : "Tap to open servo"}
      </Text>
    </TouchableOpacity>
  );
};

// Animated pump control used to start or stop water flow.
const PumpToggle = ({ isOn, onToggle }) => {
  const flow = useRef(new Animated.Value(isOn ? 1 : 0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const ripple = useRef(new Animated.Value(0)).current;

  // Fades the water stream when the pump state changes.
  useEffect(() => {
    Animated.timing(flow, {
      toValue: isOn ? 1 : 0,
      duration: 380,
      useNativeDriver: false,
    }).start();
  }, [isOn]);

  // Loops water ripple animation while the pump is running.
  useEffect(() => {
    let loop;
    if (isOn) {
      loop = Animated.loop(Animated.timing(ripple, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: false,
      }));
      ripple.setValue(0);
      loop.start();
    } else {
      ripple.stopAnimation();
      ripple.setValue(0);
    }

    return () => {
      if (loop) loop.stop();
    };
  }, [isOn]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onToggle}
      onPressIn={() => Animated.spring(press, { toValue: 0.96, useNativeDriver: false }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, friction: 5, useNativeDriver: false }).start()}
      style={[styles.pumpButton, isOn && styles.pumpButtonOn]}
    >
      <Animated.View style={[styles.pumpScene, { transform: [{ scale: press }] }]}>
        <Animated.View
          style={[
            styles.pumpAura,
            {
              opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [0.08, 0.55] }),
              transform: [
                {
                  scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.18] }),
                },
              ],
            },
          ]}
        />
        <View style={styles.faucetHandleBase} />
        <Animated.View
          style={[
            styles.faucetHandle,
            {
              transform: [
                {
                  rotateZ: flow.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "-18deg"] }),
                },
              ],
            },
          ]}
        />
        <View style={styles.faucetStem} />
        <View style={styles.faucetBody} />
        <View style={styles.faucetSpout} />
        <View style={styles.faucetNozzle} />
        <View style={styles.faucetSideKnob} />
        <Animated.View
          style={[
            styles.waterStream,
            {
              opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
              transform: [
                {
                  scaleY: flow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.waterDrop,
            {
              opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
              transform: [
                {
                  translateY: ripple.interpolate({ inputRange: [0, 1], outputRange: [0, 12] }),
                },
                {
                  scale: flow.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.waterRippleOne,
            {
              opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.65] }),
              transform: [
                {
                  scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.35] }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.waterRippleTwo,
            {
              opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }),
              transform: [
                {
                  scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.75] }),
                },
              ],
            },
          ]}
        />
      </Animated.View>

      <Text style={[styles.buzzerIcon, isOn && { color: C.amber }]}>
        {isOn ? "PUMP RUNNING" : "PUMP OFF"}
      </Text>
      <Text style={styles.buzzerHint}>
        {isOn ? "Tap to stop water pump" : "Tap to start water pump"}
      </Text>
    </TouchableOpacity>
  );
};

// Shows device controls and mirrors current hardware states.
function SmartControlScreen({ hazardMode = "normal" }) {
  const [lampOn, setLampOn] = useState(false);
  const [buzzerOn, setBuzzerOn] = useState(false);
  const [servoOn, setServoOn] = useState(false);
  const [relayOn, setRelayOn] = useState(false);
  const [loadingLamp, setLoadingLamp] = useState(true);
  const [loadingBuzzer, setLoadingBuzzer] = useState(true);
  const [loadingServo, setLoadingServo] = useState(true);
  const [loadingRelay, setLoadingRelay] = useState(true);

  // Reads all smart device states from Firebase.
  useEffect(() => {
    const lampStateRef = ref(db, "/device_states/lamp");
    const buzzerStateRef = ref(db, "/device_states/buzzer");
    const servoStateRef = ref(db, "/device_states/servo");
    const relayStateRef = ref(db, "/device_states/relay");

    const unsubLamp = onValue(lampStateRef, (snap) => {
      const value = snap.val();
      setLampOn(!!value);
      setLoadingLamp(false);
    }, () => {
      setLoadingLamp(false);
    });

    const unsubBuzzer = onValue(buzzerStateRef, (snap) => {
      const value = snap.val();
      setBuzzerOn(!!value);
      setLoadingBuzzer(false);
    }, () => {
      setLoadingBuzzer(false);
    });

    const unsubServo = onValue(servoStateRef, (snap) => {
      const value = snap.val();
      setServoOn(!!value);
      setLoadingServo(false);
    }, () => {
      setLoadingServo(false);
    });

    const unsubRelay = onValue(relayStateRef, (snap) => {
      const value = snap.val();
      setRelayOn(!!value);
      setLoadingRelay(false);
    }, () => {
      setLoadingRelay(false);
    });

    return () => {
      unsubLamp();
      unsubBuzzer();
      unsubServo();
      unsubRelay();
    };
  }, []);

  // Sends a lamp toggle command to Firebase.
  const handleLampToggle = async () => {
    try {
      const next = !lampOn;
      await set(ref(db, "/control/lamp"), next);
    } catch (e) {
      Alert.alert("Error", "Failed to control lamp.");
    }
  };

  // Sends a buzzer toggle command to Firebase.
  const handleBuzzerToggle = async () => {
    try {
      const next = !buzzerOn;
      await set(ref(db, "/control/buzzer"), next);
    } catch (e) {
      Alert.alert("Error", "Failed to control buzzer.");
    }
  };

  // Sends a servo window toggle command to Firebase.
  const handleServoToggle = async () => {
    try {
      const next = !servoOn;
      await set(ref(db, "/control/servo"), next);
    } catch (e) {
      Alert.alert("Error", "Failed to control servo.");
    }
  };

  // Sends a water pump toggle command to Firebase.
  const handleRelayToggle = async () => {
    try {
      const next = !relayOn;
      await set(ref(db, "/control/relay"), next);
    } catch (e) {
      Alert.alert("Error", "Failed to control water pump.");
    }
  };

  // Highlights key control cards during critical mode.
  const criticalMode = hazardMode === "critical";
  const controlDangerStyle = criticalMode
    ? {
        borderColor: C.fireBorder,
        backgroundColor: C.fireDim,
        shadowColor: C.fire,
        shadowOpacity: 0.48,
        shadowRadius: 22,
      }
    : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "transparent" }}
      contentContainerStyle={styles.controlScroll}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.glowTopLeft} pointerEvents="none" />
      <View style={styles.controlHeader}>
        <Text style={styles.controlEyebrow}>SMART CONTROL</Text>
        <Text style={styles.controlTitle}>Device Control</Text>
      </View>

      <View style={styles.controlCard}>
        <View style={styles.controlCardHeader}>
          <View>
            <Text style={styles.deviceTitle}>Smart Lamp</Text>
            <Text style={styles.deviceSub}>
              {loadingLamp ? "Loading state..." : "Tap the Lamp to switch"}
            </Text>
          </View>

          <View style={[styles.statePill, lampOn && styles.statePillOn]}>
            <View
              style={[
                styles.stateDot,
                { backgroundColor: lampOn ? C.amber : C.greyDim },
              ]}
            />
            <Text style={styles.stateText}>{lampOn ? "ON" : "OFF"}</Text>
          </View>
        </View>

        <LampToggle isOn={lampOn} onToggle={handleLampToggle} />
      </View>

      <View style={[styles.controlCard, controlDangerStyle]}>
        <View style={styles.controlCardHeader}>
          <View>
            <Text style={styles.deviceTitle}>Buzzer</Text>
            <Text style={styles.deviceSub}>
              {loadingBuzzer ? "Loading state..." : "Tap the Buzzer to switch"}
            </Text>
          </View>

          <View style={[styles.statePill, buzzerOn && styles.statePillOn, criticalMode && styles.statePillCritical]}>
            <View
              style={[
                styles.stateDot,
                { backgroundColor: criticalMode ? C.fire : buzzerOn ? C.amber : C.greyDim },
              ]}
            />
            <Text style={styles.stateText}>{buzzerOn ? "ON" : "OFF"}</Text>
          </View>
        </View>

        <BuzzerToggle isOn={buzzerOn} onToggle={handleBuzzerToggle} />
      </View>

      <View style={[styles.controlCard, criticalMode && { borderColor: C.gasBorder, backgroundColor: C.gasDim, shadowColor: C.gas, shadowOpacity: 0.32 }]}>
        <View style={styles.controlCardHeader}>
          <View>
            <Text style={styles.deviceTitle}>Servo Window</Text>
            <Text style={styles.deviceSub}>
              {loadingServo ? "Loading state..." : "Tap to open/close window"}
            </Text>
          </View>

          <View style={[styles.statePill, servoOn && styles.statePillOn]}>
            <View
              style={[
                styles.stateDot,
                { backgroundColor: servoOn ? C.amber : C.greyDim },
              ]}
            />
            <Text style={styles.stateText}>{servoOn ? "OPEN" : "CLOSED"}</Text>
          </View>
        </View>

        <ServoWindowToggle isOpen={servoOn} onToggle={handleServoToggle} />
      </View>

      <View style={[styles.controlCard, controlDangerStyle]}>
        <View style={styles.controlCardHeader}>
          <View>
            <Text style={styles.deviceTitle}>Water Pump</Text>
            <Text style={styles.deviceSub}>
              {loadingRelay ? "Loading state..." : "Tap the pump to switch"}
            </Text>
          </View>

          <View style={[styles.statePill, relayOn && styles.statePillOn, criticalMode && styles.statePillCritical]}>
            <View
              style={[
                styles.stateDot,
                { backgroundColor: criticalMode ? C.fire : relayOn ? C.amber : C.greyDim },
              ]}
            />
            <Text style={styles.stateText}>{relayOn ? "ON" : "OFF"}</Text>
          </View>
        </View>

        <PumpToggle isOn={relayOn} onToggle={handleRelayToggle} />
      </View>
    </ScrollView>
  );
}

// Draws the smoky background and changes its glow during alerts.
const AmbientBackground = ({ mode = "normal" }) => {
  const colors = getModeColors(mode);
  return (
  <View pointerEvents="none" style={styles.ambientRoot}>
    <View style={[styles.smokeHazeBack, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={[styles.smokeHazeFront, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent2 }]} />
    <View style={[styles.smokeCloud, styles.smokeCloudOne, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={[styles.smokeCloud, styles.smokeCloudTwo, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent2 }]} />
    <View style={[styles.smokeCloud, styles.smokeCloudThree, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={[styles.smokeCloud, styles.smokeCloudFour, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent2 }]} />
    <View style={[styles.smokeCloud, styles.smokeCloudFive, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={[styles.smokeWisp, styles.smokeWispOne, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={[styles.smokeWisp, styles.smokeWispTwo, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent2 }]} />
    <View style={[styles.smokeWisp, styles.smokeWispThree, mode !== "normal" && { backgroundColor: colors.glow, shadowColor: colors.accent }]} />
    <View style={styles.smokeFloor} />
  </View>
  );
};

// Bottom navigation tab with press feedback and alert coloring.
const TabButton = ({ active, icon, label, hazardMode = "normal", onPress }) => {
  const press = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(active ? 1 : 0)).current;
  const colors = getModeColors(hazardMode);

  // Animates the active tab glow when selected.
  useEffect(() => {
    Animated.timing(pulse, {
      toValue: active ? 1 : 0,
      duration: 320,
      useNativeDriver: false,
    }).start();
  }, [active]);

  return (
    <TouchableOpacity
      style={[
        styles.tabBtn,
        active && styles.tabBtnActive,
        active && hazardMode !== "normal" && {
          backgroundColor: colors.bg,
          borderColor: colors.border,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.9}
      onPressIn={() => Animated.spring(press, { toValue: 0.94, useNativeDriver: false }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, friction: 5, useNativeDriver: false }).start()}
    >
      <Animated.View
        style={[
          styles.tabBtnInner,
          {
            transform: [{ scale: press }],
            shadowOpacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] }),
          },
        ]}
      >
        <Text style={[styles.tabIcon, active && { color: hazardMode !== "normal" ? colors.accent : C.sage }]}>{icon}</Text>
        <Text style={[styles.tabLabel, active && { color: hazardMode !== "normal" ? colors.accent : C.sage }]}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
};

// -----------------------------------------------------------------------------
// ROOT APP
// -----------------------------------------------------------------------------
// Root component that connects notifications, alarm sound, and screen tabs.
export default function App() {
  const [activeTab, setActiveTab] = useState("live");
  const [globalAlertType, setGlobalAlertType] = useState("NONE");
  const [globalAlertActive, setGlobalAlertActive] = useState(false);
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [userRole, setUserRole] = useState("viewer");
  const [roleReady, setRoleReady] = useState(false);
  const alarmPlayer = useAudioPlayer(ALARM_SOUND);

  // Dedup ref: { type: string, sentAt: number }
  const lastAlertRef       = useRef({ type: "NONE", sentAt: 0 });
  const notifListenerRef   = useRef(null);
  const responseListenerRef = useRef(null);

  // Watches Firebase Auth and decides whether to show login or the app.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setUserRole("viewer");
      setRoleReady(!nextUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Reads this user's role so admins get full access and viewers get Live only.
  useEffect(() => {
    if (!user) return;

    const unsub = onValue(ref(db, `/users/${user.uid}`), (snap) => {
      const role = snap.val()?.role;
      setUserRole(role === "admin" ? "admin" : "viewer");
      setRoleReady(true);
    }, () => {
      setUserRole("viewer");
      setRoleReady(true);
    });

    return () => unsub();
  }, [user]);

  // Forces viewers back to Live if they somehow land on another tab.
  useEffect(() => {
    if (roleReady && userRole !== "admin" && activeTab !== "live") {
      setActiveTab("live");
    }
  }, [activeTab, roleReady, userRole]);

  // Sends an alert notification only when it is not a recent duplicate.
  const notifyIfDue = useCallback((type, active) => {
    // Clear dedup on reset so same type can fire again next event.
    if (!active || type === "NONE") {
      lastAlertRef.current = { type: "NONE", sentAt: 0 };
      return;
    }

    const now = Date.now();
    const { type: lastType, sentAt } = lastAlertRef.current;
    const isDuplicate = type === lastType && now - sentAt < DEDUP_MS;
    if (isDuplicate) return;

    lastAlertRef.current = { type, sentAt: now };
    scheduleLocalNotification(type).catch((error) => {
      console.warn("Failed to schedule local notification:", error);
    });
  }, []);

  // -- One-time setup on mount -------------------------------------
  useEffect(() => {
    if (!user) return;

    (async () => {
      await setupNotificationChannels();   // channels must exist before any notify
      await registerPushToken();           // request permission + save token
    })();

    // User tapped a notification ? navigate to correct screen
    responseListenerRef.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data ?? {};
        if (data.screen === "history" && userRole === "admin") {
          setActiveTab("history");
        } else {
          setActiveTab("live");
        }
      });

    // Foreground notification received (logging / optional custom UI)
    notifListenerRef.current =
      Notifications.addNotificationReceivedListener((notification) => {
        console.log(
          "?? Foreground notification:",
          notification.request.content.title
        );
      });

    return () => {
      notifListenerRef.current?.remove?.();
      responseListenerRef.current?.remove?.();
    };
  }, [user, userRole]);

  // -- Firebase /alerts listener ? LOCAL notification --------------
  // This is the fallback for when the app is open or in background.
  // The Python backend sends push notifications for killed-app state.
  // Both sides have a 30-second dedup window to prevent duplicates.
  useEffect(() => {
    if (!user) return;

    const alertsRef = ref(db, "/alerts");
    const unsub = onValue(alertsRef, (snap) => {
      const data   = snap.val();
      if (!data) return;

      const type   = data.type   ?? "NONE";
      const active = data.active ?? false;

      setGlobalAlertType(type);
      setGlobalAlertActive(active);
      notifyIfDue(type, active);
    });

    return () => unsub();
  }, [notifyIfDue, user]);

  // Computes the app-wide visual mode for background and navigation.
  const globalMode = getHazardMode({
    alertType: globalAlertType,
    alertActive: globalAlertActive,
  });
  const globalModeColors = getModeColors(globalMode);
  const isAdmin = userRole === "admin";

  // Configures app audio so the alarm can play during alerts.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
    }).catch((error) => {
      console.warn("Failed to configure alarm audio:", error);
    });
  }, []);

  // Starts or stops the bundled siren sound based on alert mode.
  useEffect(() => {
    const alarmActive = globalMode !== "normal";

    try {
      alarmPlayer.loop = true;
      alarmPlayer.volume = globalMode === "critical" ? 1 : 0.82;

      if (alarmActive) {
        alarmPlayer.seekTo(0);
        alarmPlayer.play();
      } else {
        alarmPlayer.pause();
        alarmPlayer.seekTo(0);
      }
    } catch (error) {
      console.warn("Failed to update alarm sound:", error);
    }

    return () => {
      try {
        alarmPlayer.pause();
      } catch (error) {
        console.warn("Failed to stop alarm sound:", error);
      }
    };
  }, [globalMode, alarmPlayer]);

  if (!authReady || (user && !roleReady)) {
    return (
      <View style={styles.authLoading}>
        <ActivityIndicator size="large" color={C.fireHot} />
        <Text style={styles.authLoadingText}>Loading AiHazardShield...</Text>
      </View>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bgDeep }}>
      <AmbientBackground mode={globalMode} />
      {activeTab === "live" && <LiveScreen />}
      {isAdmin && activeTab === "history" && <HistoryScreen />}
      {isAdmin && activeTab === "control" && <SmartControlScreen hazardMode={globalMode} />}

      <TouchableOpacity
        style={styles.logoutButton}
        onPress={() => signOut(auth)}
        activeOpacity={0.85}
      >
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

      {/* -- Tab bar -- */}
      <View style={[
        styles.tabBar,
        globalMode !== "normal" && {
          borderColor: globalModeColors.border,
          backgroundColor: globalModeColors.bg,
          shadowColor: globalModeColors.accent,
          shadowOpacity: 0.42,
        },
      ]}>
        <TabButton
          active={activeTab === "live"}
          icon="??"
          label="Live"
          hazardMode={globalMode}
          onPress={() => setActiveTab("live")}
        />
        {isAdmin && (
          <TabButton
            active={activeTab === "history"}
            icon="??"
            label="History"
            hazardMode={globalMode}
            onPress={() => setActiveTab("history")}
          />
        )}
        {isAdmin && (
          <TabButton
            active={activeTab === "control"}
            icon="??"
            label="Control"
            hazardMode={globalMode}
            onPress={() => setActiveTab("control")}
          />
        )}
      </View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// STYLES
// -----------------------------------------------------------------------------
const hStyles = StyleSheet.create({
  scroll:        { padding: 16, paddingBottom: Platform.OS === "ios" ? 112 : 104, gap: 14 },
  center:        { flex: 1, justifyContent: "center", alignItems: "center", gap: 12, backgroundColor: "transparent" },
  loadingText:   { color: C.grey, marginTop: 10, fontSize: 13 },
  noDataTitle:   { color: C.white, fontSize: 16, fontWeight: "700", marginTop: 8 },
  noDataSub:     { color: C.grey, fontSize: 12, textAlign: "center", lineHeight: 18 },
  chips:         { flexDirection: "row", gap: 10 },
  chip:          { flex: 1, backgroundColor: C.glassWhite, borderRadius: 16, borderWidth: 1, borderColor: C.glassBorder2, paddingVertical: 12, alignItems: "center", gap: 3, shadowColor: C.sage, shadowOpacity: 0.12, shadowRadius: 12, elevation: 4 },
  chipIcon:      { fontSize: 18 },
  chipVal:       { fontSize: 17, fontWeight: "800" },
  chipLbl:       { color: C.grey, fontSize: 9, fontWeight: "600", letterSpacing: 0.5 },
  chartCard:     { backgroundColor: C.glassWhite, borderRadius: 20, borderWidth: 1, borderColor: C.glassBorder, padding: 16, shadowColor: C.sage, shadowOpacity: 0.16, shadowRadius: 18, elevation: 7 },
  chartHeader:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  chartTitle:    { color: C.white, fontSize: 13, fontWeight: "700" },
  chartBadge:    { backgroundColor: C.bgMid, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  chartBadgeText:{ fontSize: 11, fontWeight: "700" },
  chart:         { borderRadius: 12, marginLeft: -8 },
  chartUnit:     { color: C.greyDim, fontSize: 9, marginTop: 6, letterSpacing: 0.3 },
  footer:        { color: C.greyDim, fontSize: 9, textAlign: "center", letterSpacing: 0.3 },
});

const styles = StyleSheet.create({
  authLoading:     { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bgDeep, gap: 12 },
  authLoadingText: { color: C.grey, fontSize: 13, fontWeight: "700" },
  logoutButton:    { position: "absolute", right: 20, bottom: Platform.OS === "ios" ? 92 : 96, zIndex: 30, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", backgroundColor: "rgba(5,6,7,0.72)" },
  logoutText:      { color: C.grey, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  liveRoot:        { flex: 1, backgroundColor: "transparent" },
  hazardLayer:     { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  hazardWash:      { ...StyleSheet.absoluteFillObject },
  hazardFrame:     { position: "absolute", left: 5, right: 5, top: 5, bottom: 5, borderRadius: 26, borderWidth: 2, shadowOpacity: 0.7, shadowRadius: 22 },
  ambientRoot:     { ...StyleSheet.absoluteFillObject, overflow: "hidden", backgroundColor: C.bgDeep },
  smokeHazeBack:   { position: "absolute", left: width * 0.22, right: -160, top: 42, height: 300, borderRadius: 150, backgroundColor: "rgba(27,86,170,0.16)", opacity: 0.72, shadowColor: "#2b78ff", shadowOpacity: 0.28, shadowRadius: 40 },
  smokeHazeFront:  { position: "absolute", left: width * 0.18, right: -120, bottom: 40, height: 260, borderRadius: 130, backgroundColor: "rgba(42,112,220,0.18)", opacity: 0.64, shadowColor: "#5298ff", shadowOpacity: 0.22, shadowRadius: 48 },
  smokeCloud:      { position: "absolute", backgroundColor: "rgba(65,140,255,0.14)", shadowColor: "#4d9cff", shadowOpacity: 0.32, shadowRadius: 30 },
  smokeCloudOne:   { right: -42, top: 34, width: 210, height: 122, borderRadius: 80, transform: [{ rotateZ: "-18deg" }] },
  smokeCloudTwo:   { right: 28, top: 174, width: 236, height: 126, borderRadius: 92, opacity: 0.72, transform: [{ rotateZ: "10deg" }] },
  smokeCloudThree: { right: -36, top: 312, width: 218, height: 132, borderRadius: 88, opacity: 0.66, transform: [{ rotateZ: "-8deg" }] },
  smokeCloudFour:  { left: width * 0.36, bottom: 82, width: 252, height: 134, borderRadius: 92, opacity: 0.58, transform: [{ rotateZ: "12deg" }] },
  smokeCloudFive:  { left: width * 0.26, bottom: 4, width: 280, height: 120, borderRadius: 90, opacity: 0.46, transform: [{ rotateZ: "-10deg" }] },
  smokeWisp:       { position: "absolute", height: 54, borderRadius: 28, backgroundColor: "rgba(80,160,255,0.14)", shadowColor: "#4d9cff", shadowOpacity: 0.30, shadowRadius: 20 },
  smokeWispOne:    { right: 8, top: 110, width: 176, transform: [{ rotateZ: "-28deg" }] },
  smokeWispTwo:    { right: 64, top: 252, width: 204, opacity: 0.64, transform: [{ rotateZ: "18deg" }] },
  smokeWispThree:  { left: width * 0.34, bottom: 148, width: 210, opacity: 0.58, transform: [{ rotateZ: "-12deg" }] },
  smokeFloor:      { position: "absolute", left: -80, right: -80, bottom: -72, height: 170, backgroundColor: "rgba(0,0,0,0.68)" },
  glowTopLeft:     { position: "absolute", top: -80, left: -80, width: 280, height: 280, borderRadius: 140, backgroundColor: C.glowSage, opacity: 0.85 },
  glowBottomRight: { position: "absolute", bottom: 100, right: -60, width: 220, height: 220, borderRadius: 110, backgroundColor: C.glowAmber, opacity: 0.7 },
  header:          { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: Platform.OS === "ios" ? 58 : 48, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: C.glassBorder2, backgroundColor: "rgba(12,13,15,0.74)", zIndex: 2 },
  headerLeft:      { flexDirection: "row", alignItems: "center", gap: 12 },
  logoBox:         { width: 44, height: 44, borderRadius: 14, backgroundColor: C.glassWhite, borderWidth: 1, borderColor: C.glassBorder, justifyContent: "center", alignItems: "center", shadowColor: C.sage, shadowOpacity: 0.45, shadowRadius: 14, elevation: 7 },
  logoEmoji:       { fontSize: 20 },
  headerTitle:     { color: C.white, fontSize: 18, fontWeight: "700", letterSpacing: 0.2 },
  headerSub:       { color: C.grey, fontSize: 10, marginTop: 1, letterSpacing: 0.5 },
  liveBadge:       { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 24, borderWidth: 1, gap: 7 },
  liveBadgeOff:    { backgroundColor: "rgba(7,19,35,0.78)", borderColor: C.glassBorder2 },
  liveBadgeOn:     { backgroundColor: C.sageGlow,   borderColor: C.sageMid + "66" },
  livePulse:       { width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.sage },
  liveBadgeText:   { fontSize: 11, fontWeight: "700", letterSpacing: 1.2 },
  alertBanner:     { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 13, paddingHorizontal: 16, gap: 12, borderBottomWidth: 1, borderTopWidth: 1, shadowColor: C.fire, shadowOpacity: 0.55, shadowRadius: 18, elevation: 12, zIndex: 3 },
  alertEmoji:      { fontSize: 20 },
  alertCopy:       { alignItems: "center", gap: 2 },
  alertText:       { fontWeight: "900", fontSize: 18, letterSpacing: 1.2, color: C.white },
  alertSubText:    { fontWeight: "900", fontSize: 11, letterSpacing: 1.1 },
  viewport:        { width: "100%", height: Math.min(width * 0.46, 230), backgroundColor: "#050607", borderBottomWidth: 1, borderBottomColor: C.glassBorder2, zIndex: 2 },
  webview:         { flex: 1, backgroundColor: "#000" },
  loadingOverlay:  { ...StyleSheet.absoluteFillObject, backgroundColor: "#0d1210", justifyContent: "center", alignItems: "center", zIndex: 10 },
  loadingText:     { color: C.grey, marginTop: 14, fontSize: 12 },
  placeholder:     { flex: 1, justifyContent: "center", alignItems: "center", gap: 10 },
  placeholderOrb:  { width: 76, height: 76, borderRadius: 38, backgroundColor: C.glassWhite, borderWidth: 1, borderColor: C.glassBorder, justifyContent: "center", alignItems: "center", marginBottom: 4 },
  placeholderTitle:{ color: C.grey, fontSize: 15, fontWeight: "600" },
  placeholderSub:  { color: C.greyDim, fontSize: 12 },
  overlayTR:       { position: "absolute", top: 12, right: 12, backgroundColor: "rgba(18,20,22,0.82)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: C.glassBorder, alignItems: "center" },
  overlayBig:      { fontSize: 20, fontWeight: "800" },
  overlaySmall:    { color: C.grey, fontSize: 8, letterSpacing: 1.2, marginTop: 1 },
  overlayBL:       { position: "absolute", bottom: 12, left: 12, backgroundColor: "rgba(18,20,22,0.82)", flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, borderWidth: 1, borderColor: C.glassBorder, gap: 6 },
  overlayDot:      { width: 6, height: 6, borderRadius: 3 },
  overlayTag:      { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  overlayBR:       { position: "absolute", bottom: 12, right: 12, backgroundColor: C.sageGlow, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7, borderWidth: 1, borderColor: C.sageMid + "55" },
  overlayMhz:      { color: C.sage, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  bottom:          { padding: 16, gap: 12, paddingBottom: Platform.OS === "ios" ? 112 : 104 },
  sensorRow:       { flexDirection: "row", gap: 10 },
  sensorTile:      { flex: 1, backgroundColor: C.glassWhite, borderRadius: 18, borderWidth: 1, borderColor: C.glassBorder2, paddingVertical: 14, paddingHorizontal: 10, alignItems: "center", gap: 3, shadowColor: C.sage, shadowOpacity: 0.12, shadowRadius: 14, elevation: 4 },
  sensorTop:       { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 },
  sensorIcon:      { fontSize: 18 },
  sensorWarnDot:   { width: 6, height: 6, borderRadius: 3 },
  sensorValue:     { fontSize: 18, fontWeight: "800", letterSpacing: 0.3 },
  sensorLabel:     { color: C.grey, fontSize: 9, fontWeight: "600", letterSpacing: 0.5 },
  alertChip:       { flex: 1, borderRadius: 18, borderWidth: 1, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", gap: 4 },
  alertChipEmoji:  { fontSize: 18 },
  alertChipText:   { fontSize: 9, fontWeight: "800", letterSpacing: 0.5, textAlign: "center", lineHeight: 13 },
  glassCard:       { backgroundColor: C.glassWhite, borderRadius: 20, borderWidth: 1, borderColor: C.glassBorder, padding: 18, overflow: "hidden", shadowColor: C.sage, shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  probCardDanger:  { backgroundColor: "rgba(73,5,5,0.88)", borderColor: C.fireBorder, shadowColor: C.fire, shadowOpacity: 0.56, shadowRadius: 28 },
  probHeader:      { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 },
  cardLabel:       { color: C.grey, fontSize: 10, fontWeight: "700", letterSpacing: 1.2 },
  probValue:       { fontSize: 38, fontWeight: "800", lineHeight: 42 },
  barTrack:        { height: 6, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "visible", marginBottom: 5, position: "relative" },
  barFill:         { height: "100%", borderRadius: 3 },
  tick:            { position: "absolute", top: -4, width: 1, height: 14, backgroundColor: C.glassBorder },
  barLegend:       { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  legendText:      { color: C.greyDim, fontSize: 9, letterSpacing: 0.3 },
  probFooter:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pill:            { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 24, borderWidth: 1 },
  pillDanger:      { shadowColor: C.fire, shadowOpacity: 0.6, shadowRadius: 12, elevation: 8 },
  pillDot:         { width: 6, height: 6, borderRadius: 3 },
  pillDotGlow:     { shadowColor: C.fire, shadowOpacity: 0.9, shadowRadius: 8 },
  pillText:        { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  ts:              { color: C.greyDim, fontSize: 10 },
  bentoGrid:       { flexDirection: "row", gap: 10 },
  bentoTile:       { flex: 1, backgroundColor: C.glassWhite, borderRadius: 16, borderWidth: 1, borderColor: C.glassBorder2, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center", gap: 4, shadowColor: C.sage, shadowOpacity: 0.10, shadowRadius: 10, elevation: 3 },
  bentoTileDanger: { backgroundColor: C.fireDim, borderColor: C.fireBorder },
  bentoIcon:       { fontSize: 18, marginBottom: 2 },
  bentoVal:        { fontSize: 12, fontWeight: "800", letterSpacing: 0.4 },
  bentoLabel:      { color: C.grey, fontSize: 9, fontWeight: "600", letterSpacing: 0.5 },
  bentoSublabel:   { color: C.greyDim, fontSize: 8, marginTop: 1 },
  btnRow:          { flexDirection: "row", gap: 10 },
  btn:             { flex: 1, height: 54, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  btnConnect:      { backgroundColor: C.sage, shadowColor: C.sage, shadowOpacity: 0.45, shadowRadius: 16, elevation: 8 },
  btnStreaming:    { backgroundColor: C.sageGlow, borderWidth: 1, borderColor: C.sage + "66", shadowColor: C.sage, shadowOpacity: 0.3, shadowRadius: 14, elevation: 6 },
  btnStop:         { backgroundColor: C.glassWhite, borderWidth: 1, borderColor: C.glassBorder },
  btnText:         { fontWeight: "700", fontSize: 14, letterSpacing: 0.3 },
  btnReconnect:    { height: 48, borderRadius: 14, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: C.sage + "55", backgroundColor: C.sageGlow },
  btnReconnectText:{ color: C.sage, fontWeight: "700", fontSize: 13, letterSpacing: 0.4 },
  alarmStrip:      { minHeight: 50, borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", shadowRadius: 18, elevation: 9 },
  alarmStripText:  { fontSize: 12, fontWeight: "900", letterSpacing: 1.2 },
  alarmWave:       { fontSize: 16, fontWeight: "900", letterSpacing: 1 },
  controlScroll:   { padding: 16, paddingTop: Platform.OS === "ios" ? 58 : 48, paddingBottom: Platform.OS === "ios" ? 112 : 104, gap: 14 },
  controlHeader:   { gap: 6, marginBottom: 6 },
  controlEyebrow:  { color: C.sage, fontSize: 10, fontWeight: "800", letterSpacing: 1.6 },
  controlTitle:    { color: C.white, fontSize: 26, fontWeight: "800" },
  controlSub:      { color: C.grey, fontSize: 12, lineHeight: 18 },
  controlCard:     { backgroundColor: C.glassWhite, borderRadius: 22, borderWidth: 1, borderColor: C.glassBorder, padding: 18, overflow: "hidden", shadowColor: C.sage, shadowOpacity: 0.20, shadowRadius: 22, shadowOffset: { width: 0, height: 12 }, elevation: 9 },
  controlCardHeader:{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  deviceTitle:     { color: C.white, fontSize: 18, fontWeight: "800" },
  deviceSub:       { color: C.grey, fontSize: 11, marginTop: 3 },
  statePill:       { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1, borderColor: C.glassBorder2, backgroundColor: "rgba(4,16,31,0.86)" },
  statePillOn:     { borderColor: C.amberBorder, backgroundColor: C.amberDim, shadowColor: C.amber, shadowOpacity: 0.45, shadowRadius: 12, elevation: 5 },
  statePillCritical:{ borderColor: C.fireBorder, backgroundColor: C.fireDim, shadowColor: C.fire, shadowOpacity: 0.55, shadowRadius: 14, elevation: 8 },
  stateDot:        { width: 7, height: 7, borderRadius: 4 },
  stateText:       { color: C.white, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  lampTapArea:     { alignItems: "center", justifyContent: "center" },
  lampScene:       { width: "100%", height: 330, alignItems: "center", position: "relative", overflow: "hidden" },
  lampHalo:        { position: "absolute", top: 112, width: 270, height: 190, borderRadius: 135, backgroundColor: "rgba(255,255,255,0.16)", shadowColor: C.amber, shadowOpacity: 0.42, shadowRadius: 30 },
  lampCable:       { position: "absolute", top: 0, width: 8, height: 76, borderRadius: 4, backgroundColor: "#05080d", shadowColor: C.sage, shadowOpacity: 0.25, shadowRadius: 10 },
  lampTopCap:      { position: "absolute", top: 58, width: 54, height: 48, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: "#070b10", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  lampNeck:        { position: "absolute", top: 92, width: 82, height: 28, borderRadius: 8, backgroundColor: "#0a0f16", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)" },
  lampBraceLeft:   { position: "absolute", top: 92, left: "34%", width: 30, height: 7, borderRadius: 4, backgroundColor: "#101720", transform: [{ rotateZ: "-18deg" }] },
  lampBraceRight:  { position: "absolute", top: 92, right: "34%", width: 30, height: 7, borderRadius: 4, backgroundColor: "#101720", transform: [{ rotateZ: "18deg" }] },
  lampShade:       { position: "absolute", top: 100, width: 244, height: 104, borderTopLeftRadius: 86, borderTopRightRadius: 86, borderBottomLeftRadius: 22, borderBottomRightRadius: 22, backgroundColor: "#080b10", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.65, shadowRadius: 20, shadowOffset: { width: 0, height: 16 }, elevation: 12 },
  lampMark:        { color: "rgba(255,255,255,0.28)", fontSize: 54, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontStyle: "italic", marginTop: 14 },
  lampShadeLip:    { position: "absolute", top: 196, width: 254, height: 14, borderRadius: 8, backgroundColor: "#141923", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  lampBulbGlow:    { position: "absolute", top: 192, width: 92, height: 72, borderRadius: 46, backgroundColor: "rgba(255,255,255,0.26)", shadowColor: "#f5f5f5", shadowOpacity: 0.65, shadowRadius: 22 },
  lampBulb:        { position: "absolute", top: 200, width: 58, height: 58, borderRadius: 29, borderWidth: 1, borderColor: "rgba(255,255,255,0.30)", shadowColor: "#f5f5f5", shadowOpacity: 0.45, shadowRadius: 14, elevation: 8 },
  lampBeam:        { position: "absolute", top: 210, width: 0, height: 0, borderLeftWidth: 112, borderRightWidth: 112, borderBottomWidth: 108, borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "rgba(255,255,255,0.14)" },
  lampFloorGlow:   { position: "absolute", bottom: 32, width: 230, height: 18, borderRadius: 115, backgroundColor: "rgba(255,255,255,0.18)", shadowColor: C.amber, shadowOpacity: 0.40, shadowRadius: 20 },
  lampHint:        { position: "absolute", bottom: 0 },
  buzzerButton:    { minHeight: 190, borderRadius: 18, borderWidth: 1, borderColor: C.glassBorder2, backgroundColor: "rgba(18,20,22,0.88)", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 18 },
  buzzerButtonOn:  { borderColor: C.amberBorder, backgroundColor: C.amberDim, shadowColor: C.amber, shadowOpacity: 0.35, shadowRadius: 18, elevation: 8 },
  buzzerIcon:      { color: C.greyDim, fontSize: 24, fontWeight: "900", letterSpacing: 1 },
  buzzerHint:      { color: C.grey, fontSize: 12, fontWeight: "600" },
  buzzerPad:       { width: 136, height: 118, borderRadius: 10, backgroundColor: "#c8d0ce", borderRightWidth: 6, borderBottomWidth: 6, borderRightColor: "#7f8987", borderBottomColor: "#7f8987", alignItems: "center", justifyContent: "space-between", padding: 13, shadowColor: "#ff2b22", shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 8 },
  buzzerScrewRow:  { width: "100%", flexDirection: "row", justifyContent: "space-between" },
  buzzerScrew:     { width: 9, height: 9, borderRadius: 5, borderWidth: 1, borderColor: "#7f8987", backgroundColor: "#dfe5e3" },
  buzzerRedButton: { width: 72, height: 72, borderRadius: 36, backgroundColor: "#e21d16", borderRightWidth: 5, borderBottomWidth: 7, borderRightColor: "#86130f", borderBottomColor: "#86130f", shadowColor: "#ff2b22", shadowOpacity: 0.75, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 10 },
  windowButton:    { minHeight: 220, borderRadius: 18, borderWidth: 1, borderColor: C.glassBorder2, backgroundColor: "rgba(18,20,22,0.88)", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 18, overflow: "hidden" },
  windowButtonOpen:{ borderColor: C.amberBorder, backgroundColor: "rgba(255,255,255,0.10)", shadowColor: C.amber, shadowOpacity: 0.24, shadowRadius: 18, elevation: 8 },
  windowScene:     { width: 230, height: 132, alignItems: "center", justifyContent: "center", position: "relative" },
  windowFrame:     { position: "absolute", left: 34, top: 20, width: 138, height: 86, borderWidth: 8, borderColor: "#9ca5a4", backgroundColor: "#dfe7e8", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 5 }, elevation: 5 },
  windowBarVertical:{ position: "absolute", left: 39, top: -1, width: 4, height: 80, backgroundColor: "#9ca5a4" },
  windowBarRight:  { left: 84 },
  windowBarHorizontal:{ position: "absolute", left: -1, top: 38, width: 132, height: 4, backgroundColor: "#9ca5a4" },
  windowPanel:     { position: "absolute", left: 78, top: 35, width: 118, height: 76, borderWidth: 7, borderColor: "#8f9998", backgroundColor: "rgba(205,218,220,0.72)", shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  windowPanelBarVertical:{ position: "absolute", left: 50, top: -1, width: 4, height: 70, backgroundColor: "#8f9998" },
  windowPanelBarHorizontal:{ position: "absolute", left: -1, top: 34, width: 112, height: 4, backgroundColor: "#8f9998" },
  pumpButton:      { minHeight: 210, borderRadius: 18, borderWidth: 1, borderColor: C.glassBorder2, backgroundColor: "rgba(18,20,22,0.90)", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden", paddingVertical: 16 },
  pumpButtonOn:    { borderColor: C.amberBorder, backgroundColor: "rgba(36,38,40,0.92)", shadowColor: C.amber, shadowOpacity: 0.24, shadowRadius: 18, elevation: 8 },
  pumpScene:       { width: 220, height: 122, alignItems: "center", justifyContent: "center", position: "relative", marginBottom: 2 },
  pumpAura:        { position: "absolute", bottom: 0, width: 168, height: 58, borderRadius: 84, backgroundColor: "rgba(255,255,255,0.12)", shadowColor: C.amber, shadowOpacity: 0.34, shadowRadius: 22 },
  faucetHandleBase:{ position: "absolute", top: 5, width: 54, height: 14, borderRadius: 8, backgroundColor: "#5f6266", borderWidth: 1, borderColor: "rgba(255,255,255,0.20)" },
  faucetHandle:    { position: "absolute", top: 4, left: 49, width: 90, height: 20, borderRadius: 10, backgroundColor: "#c4c6c8", borderWidth: 1, borderColor: "rgba(255,255,255,0.28)", shadowColor: C.sage, shadowOpacity: 0.22, shadowRadius: 10 },
  faucetStem:      { position: "absolute", top: 20, width: 42, height: 68, borderRadius: 14, backgroundColor: "#777a7e", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  faucetBody:      { position: "absolute", top: 56, left: 50, width: 110, height: 24, borderRadius: 12, backgroundColor: "#a8aaad", borderWidth: 1, borderColor: "rgba(255,255,255,0.22)" },
  faucetSpout:     { position: "absolute", top: 58, left: 24, width: 82, height: 18, borderRadius: 10, backgroundColor: "#cfd1d2", borderWidth: 1, borderColor: "rgba(255,255,255,0.26)" },
  faucetNozzle:    { position: "absolute", top: 72, left: 22, width: 24, height: 13, borderRadius: 7, backgroundColor: "#6b6e72", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  faucetSideKnob:  { position: "absolute", top: 57, right: 30, width: 46, height: 46, borderRadius: 23, backgroundColor: "#7f8286", borderWidth: 3, borderColor: "rgba(255,255,255,0.24)", shadowColor: C.sage, shadowOpacity: 0.18, shadowRadius: 10 },
  waterStream:     { position: "absolute", top: 82, left: 30, width: 11, height: 42, borderRadius: 6, backgroundColor: "rgba(245,245,245,0.48)", shadowColor: C.amber, shadowOpacity: 0.42, shadowRadius: 12 },
  waterDrop:       { position: "absolute", left: 16, bottom: 8, width: 30, height: 40, borderRadius: 18, backgroundColor: "rgba(245,245,245,0.24)", borderWidth: 1, borderColor: "rgba(255,255,255,0.50)", transform: [{ rotateZ: "45deg" }], shadowColor: C.amber, shadowOpacity: 0.32, shadowRadius: 12 },
  waterRippleOne:  { position: "absolute", left: 0, bottom: 0, width: 86, height: 24, borderRadius: 43, borderWidth: 1, borderColor: "rgba(255,255,255,0.34)" },
  waterRippleTwo:  { position: "absolute", left: -15, bottom: -4, width: 116, height: 32, borderRadius: 58, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)" },
  tabBar:          { position: "absolute", left: 16, right: 16, bottom: Platform.OS === "ios" ? 24 : 28, flexDirection: "row", backgroundColor: "rgba(14,15,17,0.88)", borderWidth: 1, borderColor: C.glassBorder, borderRadius: 24, paddingHorizontal: 8, paddingVertical: 8, shadowColor: C.sage, shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
  tabBtn:          { flex: 1, minHeight: 54, alignItems: "center", justifyContent: "center", gap: 3, paddingVertical: 6, borderRadius: 18 },
  tabBtnInner:     { alignItems: "center", justifyContent: "center", gap: 3, borderRadius: 18, shadowColor: C.sage, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  tabBtnActive:    { backgroundColor: C.sageGlow, borderWidth: 1, borderColor: C.sage + "44" },
  tabIcon:         { fontSize: 18, color: C.greyDim },
  tabLabel:        { color: C.greyDim, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
});

// File summary:
// App.js is the main AiHazardShield mobile app entry point.
// It checks Firebase Auth and shows LoginScreen until a user signs in.
// It registers notification channels and the device Expo push token.
// It listens to Firebase fire detection, sensor, alert, history, and backend status paths.
// It renders the live dashboard with camera stream, alert banner, and danger overlays.
// It shows temperature, gas, fire probability, and backend connection health.
// It displays history charts from the latest saved Firebase history records.
// It provides manual control UI for buzzer, lamp, window, and water pump states.
// It handles local notification deduplication so repeated alerts do not spam the phone.
// It stores most shared UI styles and color tokens used by the dashboard screens.
