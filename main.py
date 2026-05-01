# main.py  — FireWatch Python backend
# ─────────────────────────────────────────────────────────────────────────────
# Covers:
#   • YOLO fire detection from ESP32 MJPEG snapshot
#   • Firebase Realtime DB writes (live + history)
#   • Firestore SOS image logging on fire detection
#   • Expo push notifications with retry, dedup, and token validation
#   • Sensor polling in a background thread
#   • Stale-token cleanup (DeviceNotRegistered)
# ─────────────────────────────────────────────────────────────────────────────

import requests
import cv2
import numpy as np
from ultralytics import YOLO
import time
import threading
import base64
import atexit

import firebase_admin
from firebase_admin import credentials, db, firestore

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────
ESP32_IP       = "10.1.1.110"
SNAPSHOT_URL   = f"http://{ESP32_IP}/capture"
EXPO_PUSH_URL  = "https://exp.host/--/api/v2/push/send"

HISTORY_INTERVAL   = 10    # seconds between history pushes
FIRESTORE_INTERVAL = 10    # seconds between Firestore image logs
SENSOR_POLL_S      = 5     # seconds between sensor reads
TOKEN_POLL_S       = 5     # seconds between push token reads
ALERT_POLL_S       = 0.5   # seconds between alert checks for push notifications
DEDUP_WINDOW_S     = 5     # seconds before same alert type can fire again
MAIN_LOOP_SLEEP    = 0.1   # seconds between detection cycles
BACKEND_HEARTBEAT_S = 2    # seconds between app status heartbeats
FIRE_THRESHOLD     = 0.6
GAS_THRESHOLD      = 200

# ─────────────────────────────────────────────────────────────────────────────
# FIREBASE INIT
# ─────────────────────────────────────────────────────────────────────────────
cred = credentials.Certificate("fire_detection_key.json")
firebase_admin.initialize_app(cred, {
    "databaseURL": "https://firedetection-2bb0e-default-rtdb.europe-west1.firebasedatabase.app"
})

ref_rtdb    = db.reference("/fire_detection")
ref_history = db.reference("/history")
ref_sensors = db.reference("/sensors")
ref_alerts  = db.reference("/alerts")
ref_device  = db.reference("/device")
ref_backend_status = db.reference("/backend_status")
db_fs       = firestore.client()

# ─────────────────────────────────────────────────────────────────────────────
# MODEL
# ─────────────────────────────────────────────────────────────────────────────
model = YOLO("best1.pt").to("cuda")
print("✅ YOLO model loaded on CUDA")

# ─────────────────────────────────────────────────────────────────────────────
# PUSH NOTIFICATION CONFIGS
# ─────────────────────────────────────────────────────────────────────────────
NOTIF_CONFIGS = {
    "FIRE+GAS": {
        "title":     "🔥💨 FIRE + GAS ALERT",
        "body":      "Fire AND gas detected simultaneously! Evacuate immediately.",
        "channelId": "fire-alerts",
        "priority":  "high",
        "sound":     "default",
        "ttl":       3600,
        "badge":     1,
    },
    "FIRE": {
        "title":     "🔥 FIRE ALERT",
        "body":      "Fire detected by AI camera. Check your environment now.",
        "channelId": "fire-alerts",
        "priority":  "high",
        "sound":     "default", 
        "ttl":       3600,
        "badge":     1,
    },
    "GAS": {
        "title":     "💨 GAS LEAK ALERT",
        "body":      "Gas leak detected by sensor. Ventilate area immediately.",
        "channelId": "fire-alerts",
        "priority":  "high",
        "sound":     "default",
        "ttl":       3600,
        "badge":     1,
    },
    "false Detection": {
        "title":     "⚠️ False Detection",
        "body":      "A potential fire was detected but cleared within 2 seconds.",
        "channelId": "false-detections",
        "priority":  "normal",
        "sound":     None,
        "ttl":       300,
        "badge":     0,
    },
}

# ─────────────────────────────────────────────────────────────────────────────
# THREAD-SAFE SHARED STATE
# ─────────────────────────────────────────────────────────────────────────────
sensor_cache      = {"temperature": 0.0, "gas_level": 0}
sensor_lock       = threading.Lock()

push_token_cache  = {"token": None}
token_lock        = threading.Lock()

# Dedup: tracks {alert_type: last_sent_timestamp}
dedup_state       = {}
dedup_lock        = threading.Lock()

last_active_alert_type = "NONE"
last_active_alert_lock = threading.Lock()
last_written_alert = {"type": None, "active": None}
alert_write_lock = threading.Lock()

def write_backend_status(running: bool):
    """Write a heartbeat so the app knows main.py is currently alive."""
    ref_backend_status.update({
        "running": running,
        "timestamp": time.time(),
        "source": "main.py",
    })

def backend_heartbeat_thread():
    while True:
        try:
            write_backend_status(True)
        except Exception as e:
            print(f"Backend heartbeat error: {e}")
        time.sleep(BACKEND_HEARTBEAT_S)

def mark_backend_offline():
    try:
        write_backend_status(False)
    except Exception:
        pass

atexit.register(mark_backend_offline)
threading.Thread(target=backend_heartbeat_thread, daemon=True).start()
print("Backend heartbeat started")

# ─────────────────────────────────────────────────────────────────────────────
# DEDUP HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def should_send_push(alert_type: str) -> bool:
    """Returns True if enough time has passed since this alert type was last sent."""
    with dedup_lock:
        last_sent = dedup_state.get(alert_type, 0)
        if time.time() - last_sent >= DEDUP_WINDOW_S:
            dedup_state[alert_type] = time.time()
            return True
        return False

def reset_dedup(alert_type: str):
    """Reset dedup for an alert type so it can fire again on next event."""
    with dedup_lock:
        dedup_state.pop(alert_type, None)

# Adds sensor readings to the alert push payload.
def build_alert_extra() -> dict:
    with sensor_lock:
        return {
            "temperature": sensor_cache["temperature"],
            "gas_level":   sensor_cache["gas_level"],
        }

# Handles push sending and dedup reset when alert state changes.
def handle_alert_state(alert_type: str, active: bool):
    global last_active_alert_type

    if active and alert_type != "NONE":
        with last_active_alert_lock:
            last_active_alert_type = alert_type

        if should_send_push(alert_type):
            dispatch_push(alert_type, build_alert_extra())
        return

    with last_active_alert_lock:
        previous_type = last_active_alert_type
        last_active_alert_type = "NONE"

    if previous_type != "NONE":
        reset_dedup(previous_type)

# Converts fire probability and gas level into one alert state.
def get_alert_state(fire_prob: float, gas_level: int) -> tuple[str, bool]:
    fire_active = fire_prob > FIRE_THRESHOLD
    gas_active = gas_level > GAS_THRESHOLD

    if fire_active and gas_active:
        return "FIRE+GAS", True
    if fire_active:
        return "FIRE", True
    if gas_active:
        return "GAS", True
    return "NONE", False

# Writes alert state to Firebase only when it changes.
def write_alert_state(alert_type: str, active: bool):
    with alert_write_lock:
        if (
            last_written_alert["type"] == alert_type and
            last_written_alert["active"] == active
        ):
            return

        last_written_alert["type"] = alert_type
        last_written_alert["active"] = active

    ref_alerts.update({
        "type": alert_type,
        "active": active,
        "timestamp": time.time(),
        "source": "python-backend",
    })

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND THREAD: sensor polling
# ─────────────────────────────────────────────────────────────────────────────
# Keeps the latest temperature and gas sensor values cached.
def sensor_polling_thread():
    while True:
        try:
            data = ref_sensors.get()
            if data:
                temp = float(data.get("temperature", 0) or 0)
                gas  = int(  data.get("gas_level",   0) or 0)
                with sensor_lock:
                    sensor_cache["temperature"] = temp
                    sensor_cache["gas_level"]   = gas
        except Exception as e:
            print(f"⚠️  Sensor poll error: {e}")
        time.sleep(SENSOR_POLL_S)

threading.Thread(target=sensor_polling_thread, daemon=True).start()
print("✅ Sensor polling thread started")

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND THREAD: push token polling
# ─────────────────────────────────────────────────────────────────────────────
# Reads the latest Expo push token from Firebase.
def refresh_push_token():
    data  = ref_device.get()
    token = data.get("push_token") if data else None

    if token and token.startswith("ExponentPushToken["):
        with token_lock:
            if push_token_cache["token"] != token:
                push_token_cache["token"] = token
                print(f"📱 Push token updated: {token[:40]}…")
    else:
        with token_lock:
            push_token_cache["token"] = None

# Refreshes the push token cache in the background.
def token_polling_thread():
    while True:
        try:
            refresh_push_token()
        except Exception as e:
            print(f"⚠️  Token poll error: {e}")
        time.sleep(TOKEN_POLL_S)

threading.Thread(target=token_polling_thread, daemon=True).start()
print("✅ Token polling thread started")

# ─────────────────────────────────────────────────────────────────────────────
# EXPO PUSH SENDER
# ─────────────────────────────────────────────────────────────────────────────
# Sends one Expo push notification with retry handling.
def send_expo_push(token: str, alert_type: str, extra_data: dict = None) -> bool:
    """
    Send an Expo push notification.
    Retries up to 2 times on transient errors (exponential back-off).
    Raises ValueError('DeviceNotRegistered') so caller can clear the token.
    Returns True on success, False on permanent failure.
    """
    if not token or not token.startswith("ExponentPushToken["):
        print(f"⚠️  Invalid token format — skipping push")
        return False

    cfg = NOTIF_CONFIGS.get(alert_type)
    if not cfg:
        print(f"⚠️  Unknown alert type '{alert_type}' — skipping push")
        return False

    payload = {
        "to":        token,
        "title":     cfg["title"],
        "body":      cfg["body"],
        "channelId": cfg["channelId"],
        "priority":  cfg["priority"],
        "sound":     cfg["sound"],
        "ttl":       cfg["ttl"],
        "badge":     cfg["badge"],
        # Expiration computed fresh each time (not at module load)
        "expiration": int(time.time()) + cfg["ttl"],
        "data": {
            "alertType": alert_type,
            "screen":    "live",
            "source":    "python-backend",
            **(extra_data or {}),
        },
    }

    headers = {
        "Content-Type":    "application/json",
        "Accept":          "application/json",
        "Accept-Encoding": "gzip, deflate",
    }

    max_attempts = 3  # 1 initial + 2 retries
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.post(
                EXPO_PUSH_URL,
                json=payload,
                headers=headers,
                timeout=8,
            )
            resp.raise_for_status()

            result = resp.json()
            ticket = result.get("data", {})
            status = ticket.get("status", "unknown")

            if status == "ok":
                print(f"✅ Push sent [{alert_type}] ticket={ticket.get('id', 'n/a')}")
                return True

            # Handle known terminal errors
            error_code = ticket.get("details", {}).get("error", "")
            if error_code == "DeviceNotRegistered":
                raise ValueError("DeviceNotRegistered")

            print(f"⚠️  Push API returned error [{attempt}/{max_attempts}]: {result}")

        except ValueError:
            raise    # bubble up DeviceNotRegistered to caller
        except requests.exceptions.Timeout:
            print(f"⚠️  Push timeout [{attempt}/{max_attempts}]")
        except requests.exceptions.RequestException as e:
            print(f"⚠️  Push request error [{attempt}/{max_attempts}]: {e}")

        if attempt < max_attempts:
            time.sleep(2 ** attempt)   # 2 s → 4 s

    print(f"❌ Push failed after {max_attempts} attempts [{alert_type}]")
    return False

# ─────────────────────────────────────────────────────────────────────────────
# PUSH DISPATCH (runs in its own thread to never block detection loop)
# ─────────────────────────────────────────────────────────────────────────────
def dispatch_push(alert_type: str, extra_data: dict = None):
    """Fire-and-forget push in a daemon thread. Handles DeviceNotRegistered."""
    def _run():
        with token_lock:
            token = push_token_cache["token"]

        if not token:
            print("⚠️  No push token available — skipping push")
            return

        try:
            send_expo_push(token, alert_type, extra_data)
        except ValueError as e:
            if "DeviceNotRegistered" in str(e):
                print("🗑️  Stale token — clearing from Firebase")
                try:
                    ref_device.child("push_token").delete()
                except Exception:
                    pass
                with token_lock:
                    push_token_cache["token"] = None

    threading.Thread(target=_run, daemon=True).start()

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND THREAD: fast alert push monitor
# ─────────────────────────────────────────────────────────────────────────────
# Watches Firebase alerts and triggers push notifications quickly.
def alert_push_monitor_thread():
    while True:
        try:
            alert_data = ref_alerts.get()
            alert_type = alert_data.get("type", "NONE") if alert_data else "NONE"
            active = alert_data.get("active", False) if alert_data else False
            handle_alert_state(alert_type, active)
        except Exception as e:
            print(f"⚠️  Alert push monitor error: {e}")
        time.sleep(ALERT_POLL_S)

try:
    refresh_push_token()
except Exception as e:
    print(f"⚠️  Initial token read error: {e}")

threading.Thread(target=alert_push_monitor_thread, daemon=True).start()
print("✅ Fast alert push monitor started")

# ─────────────────────────────────────────────────────────────────────────────
# FIREBASE WRITE HELPERS (all run in daemon threads to never block the loop)
# ─────────────────────────────────────────────────────────────────────────────
# Runs Firebase writes in a daemon thread so detection stays fast.
def _bg_write(task, *args):
    def run():
        try:
            task(*args)
        except Exception as e:
            print(f"⚠️  Firebase write error: {e}")
    threading.Thread(target=run, daemon=True).start()

# Writes the current fire detection result for the app dashboard.
def write_realtime(fire_prob: float):
    ref_rtdb.update({
        "fire_detected": fire_prob > 0.6,
        "probability":   round(fire_prob, 4),
        "label":         "🔥 FIRE" if fire_prob > 0.6 else "CLEAR",
        "timestamp":     time.time(),
    })

# Saves one history record for charts in the mobile app.
def write_history(fire_prob: float, temperature: float, gas_level: int):
    ref_history.push({
        "fire_prob":   round(fire_prob, 4),
        "temperature": round(temperature, 1),
        "gas_level":   gas_level,
        "ts":          int(time.time()),
    })
    print(f"📊 History — fire:{round(fire_prob*100,1)}%  "
          f"temp:{temperature}°C  gas:{gas_level}")

# Stores a fire snapshot image in Firestore for SOS history.
def write_firestore(frame: np.ndarray, fire_prob: float):
    _, buf    = cv2.imencode(".jpg", frame)
    frame_b64 = base64.b64encode(buf).decode("utf-8")
    db_fs.collection("fire_history").add({
        "timestamp":   firestore.SERVER_TIMESTAMP,
        "image":       frame_b64,
        "probability": round(fire_prob, 4),
    })
    print("📢 SOS image logged to Firestore")

# ─────────────────────────────────────────────────────────────────────────────
# FRAME FETCH
# ─────────────────────────────────────────────────────────────────────────────
# Downloads one camera frame from the ESP32 snapshot endpoint.
def fetch_frame() -> np.ndarray:
    response = requests.get(SNAPSHOT_URL, timeout=3)
    response.raise_for_status()
    img_array = np.frombuffer(response.content, np.uint8)
    return cv2.imdecode(img_array, cv2.IMREAD_COLOR)

# ─────────────────────────────────────────────────────────────────────────────
# MAIN DETECTION LOOP
# ─────────────────────────────────────────────────────────────────────────────
last_history_push  = 0.0
last_firestore_log = 0.0

print("🚀 FireWatch detection loop started")

# Continuously captures frames, detects fire, and updates Firebase.
while True:
    try:
        # ── 1. Capture + detect ────────────────────────────────────────────
        frame   = fetch_frame()
        results = model.predict(frame, conf=0.25, verbose=False)

        fire_prob = 0.0
        if len(results[0].boxes) > 0:
            fire_prob = float(max(results[0].boxes.conf))

        now = time.time()

        # ── 2. Write live detection result ─────────────────────────────────
        _bg_write(write_realtime, fire_prob)

        # ── 3. Write alert state from current camera + gas readings ─────────
        with sensor_lock:
            temp = sensor_cache["temperature"]
            gas  = sensor_cache["gas_level"]

        current_type, current_active = get_alert_state(fire_prob, gas)
        _bg_write(write_alert_state, current_type, current_active)

        # ── 4. History every HISTORY_INTERVAL seconds ──────────────────────
        if now - last_history_push >= HISTORY_INTERVAL:
            last_history_push = now
            _bg_write(write_history, fire_prob, temp, gas)

        # ── 5. Firestore SOS image on confirmed fire ───────────────────────
        if fire_prob > 0.5 and (now - last_firestore_log > FIRESTORE_INTERVAL):
            last_firestore_log = now
            _bg_write(write_firestore, frame.copy(), fire_prob)

        # ── 6. Console status ──────────────────────────────────────────────
        print(
            f"🔍 Fire:{round(fire_prob*100,1):5.1f}%  "
            f"Temp:{temp}°C  Gas:{gas}ppm  "
            f"Alert:{current_type}  Active:{current_active}"
        )

    except requests.exceptions.Timeout:
        print("⚠️  ESP32 timeout — retrying in 1 s")
        time.sleep(1)
        continue

    except requests.exceptions.ConnectionError:
        print("⚠️  ESP32 unreachable — retrying in 2 s")
        time.sleep(2)
        continue

    except Exception as e:
        print(f"⚠️  Unexpected error: {e}")
        time.sleep(1)
        continue

    time.sleep(MAIN_LOOP_SLEEP)

# File summary:
# main.py runs the production FireWatch Python backend.
# It reads ESP32 camera frames and sensor values, runs YOLO fire detection, and updates Firebase.
# It writes live status, history, Firestore SOS images, backend heartbeat data, and alert states.
# It also sends Expo push notifications and cleans up invalid device tokens.
