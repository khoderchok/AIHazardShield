import requests
import cv2
import numpy as np
from ultralytics import YOLO
import time
import firebase_admin
from firebase_admin import credentials, db

# ==============================
# CONFIG
# ==============================
ESP32_IP = "172.20.10.9"
SNAPSHOT_URL = f"http://{ESP32_IP}/capture"
MODEL_PATH = "C:\\Users\\Badih\\Downloads\\runs\\detect\\train2\\weights\\best.pt"
FIRE_CLASS_NAME = "fire"
POLL_INTERVAL = 1.0
# ==============================

# Init Firebase
cred = credentials.Certificate("serviceAccountKey.json")  # download from Firebase Console
firebase_admin.initialize_app(cred, {
    "databaseURL": "https://YOUR-PROJECT-ID-default-rtdb.firebaseio.com"
})
ref = db.reference("/fire_detection")

# Init YOLO
model = YOLO(MODEL_PATH).to("cuda")


def fetch_frame():
    response = requests.get(SNAPSHOT_URL, timeout=5)
    response.raise_for_status()
    img_array = np.frombuffer(response.content, np.uint8)
    return cv2.imdecode(img_array, cv2.IMREAD_COLOR)


def run_yolo(frame):
    results = model(frame, verbose=False)
    max_prob = 0.0
    fire_detected = False
    for result in results:
        for box in result.boxes:
            cls_id = int(box.cls[0])
            label = model.names[cls_id].lower()
            conf = float(box.conf[0])
            if label == FIRE_CLASS_NAME.lower():
                fire_detected = True
                if conf > max_prob:
                    max_prob = conf
    return fire_detected, round(max_prob * 100, 1)


print("Starting Firebase fire detection...")
while True:
    try:
        frame = fetch_frame()
        fire_detected, probability = run_yolo(frame)

        ref.set({
            "fire_detected": fire_detected,
            "probability": probability,
            "label": "🔥 Fire Detected!" if fire_detected else "✅ No Fire",
            "timestamp": time.time(),
            "error": None
        })
        print(f"[{time.strftime('%H:%M:%S')}] Fire: {fire_detected} | {probability}%")

    except requests.exceptions.ConnectionError:
        ref.set({"error": "Cannot reach ESP32-CAM", "timestamp": time.time()})
    except Exception as e:
        ref.set({"error": str(e), "timestamp": time.time()})

    time.sleep(POLL_INTERVAL)

# File summary:
# fire_backend.py is an older/simple Firebase fire detection loop.
# It captures ESP32 snapshots, runs a YOLO model, and writes detection results to Firebase.
# It is useful as a lightweight backend example or fallback compared with main.py.
# The production app appears to use main.py for the complete alert workflow.
