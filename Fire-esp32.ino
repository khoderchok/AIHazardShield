#include <WiFi.h>
#include <FirebaseESP32.h>
#include <ESP32Servo.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <math.h>
// Wi-Fi settings used by the ESP32 controller board.
#define WIFI_SSID "Android2026"
#define WIFI_PASSWORD "badih123"
// Firebase connection settings for realtime sensor and control data.
#define FIREBASE_HOST "firedetection-2bb0e-default-rtdb.europe-west1.firebasedatabase.app/"
#define FIREBASE_AUTH "0osZmFIMOP7vL4XLpDulnWn7o9E4wfUQ7Gmrx0PR"
FirebaseData fbData;
FirebaseData fbPush;
FirebaseData fbControl;
FirebaseJson json;
FirebaseConfig config;
FirebaseAuth auth;
// Pin assignments for LEDs, buzzer, relay, servo, DHT, and MQ-2.
#define LED_PIN 2
#define RELAY_PIN 14
#define LED_PIN1 5
#define LED_PIN2 18
#define BUZZER_PIN 15
#define SERVO_PIN 13
#define DHT_PIN 4
#define MQ2_PIN 34
#define DHTTYPE DHT22
DHT dht(DHT_PIN, DHTTYPE);
Servo servo;
// Alert thresholds and timing values for fire, gas, and history writes.
#define FIRE_THRESHOLD 0.6
#define TEMP_THRESHOLD 30.0
#define GAS_THRESHOLD 200
#define FIRE_CONFIRM_MS 2000
#define WARNING_BLINK_MS 100
#define HISTORY_INTERVAL_MS 1000
#define SERVO_CLOSED_ANGLE 0
#define SERVO_OPEN_ANGLE 90
unsigned long fireFirstDetectedAt = 0;
unsigned long lastHistoryPush = 0;
unsigned long lastWarningBlink = 0;
bool firePending = false;
bool fireConfirmed = false;
bool warningLedOn = false;
bool lampState = true;
bool buzzerState = false;
bool servoState = false;
bool relayState = false;
String lastAlertType = "NONE";
// Turns the warning LED on only while an alert is active.
void updateWarningLed(bool alertActive) {
  if (alertActive) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }
}
// Updates the lamp output and mirrors its state to Firebase.
void setLampState(bool state) {
  lampState = state;
  digitalWrite(LED_PIN2, lampState ? HIGH : LOW);
  Firebase.setBool(fbControl, "/control/lamp", lampState);
  Firebase.setBool(fbControl, "/device_states/lamp", lampState);
}
// Updates the buzzer output and mirrors its state to Firebase.
void setBuzzerState(bool state) {
  buzzerState = state;
  digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);
  Firebase.setBool(fbControl, "/control/buzzer", buzzerState);
  Firebase.setBool(fbControl, "/device_states/buzzer", buzzerState);
}
// Moves the servo window and mirrors its state to Firebase.
void setServoState(bool state) {
  servoState = state;
  servo.write(servoState ? SERVO_OPEN_ANGLE : SERVO_CLOSED_ANGLE);
  Firebase.setBool(fbControl, "/control/servo", servoState);
  Firebase.setBool(fbControl, "/device_states/servo", servoState);
}
// Controls the relay pump and mirrors its state to Firebase.
void setRelayState(bool state) {
  relayState = state;
  digitalWrite(RELAY_PIN, relayState ? HIGH : LOW);
  Firebase.setBool(fbControl, "/control/relay", relayState);
  Firebase.setBool(fbControl, "/device_states/relay", relayState);
}
// Reads the lamp command from Firebase and applies it locally.
void readLampControl() {
  if (Firebase.getBool(fbControl, "/control/lamp")) {
    lampState = fbControl.boolData();
    digitalWrite(LED_PIN2, lampState ? HIGH : LOW);
    Firebase.setBool(fbControl, "/device_states/lamp", lampState);
  }
}
// Reads the buzzer command from Firebase and applies it locally.
void readBuzzerControl() {
  if (Firebase.getBool(fbControl, "/control/buzzer")) {
    buzzerState = fbControl.boolData();
    digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);
    Firebase.setBool(fbControl, "/device_states/buzzer", buzzerState);
  }
}
// Reads the servo command from Firebase and applies it locally.
void readServoControl() {
  if (Firebase.getBool(fbControl, "/control/servo")) {
    servoState = fbControl.boolData();
    servo.write(servoState ? SERVO_OPEN_ANGLE : SERVO_CLOSED_ANGLE);
    Firebase.setBool(fbControl, "/device_states/servo", servoState);
  }
}
// Reads the relay command from Firebase and applies it locally.
void readRelayControl() {
  if (Firebase.getBool(fbControl, "/control/relay")) {
    relayState = fbControl.boolData();
    digitalWrite(RELAY_PIN, relayState ? HIGH : LOW);
    Firebase.setBool(fbControl, "/device_states/relay", relayState);
  }
}
// Helper functions force device states during automatic alerts.
void forceLampOff() { setLampState(false); }
void forceBuzzerOn() { setBuzzerState(true); }
void forceBuzzerOff() { setBuzzerState(false); }
void forceServoOpen() { setServoState(true); }
void forceServoClosed() { setServoState(false); }
void forceRelayOn() { setRelayState(true); }
void forceRelayOff() { setRelayState(false); }
// Initializes pins, sensors, Wi-Fi, Firebase, and default device states.
void setup() {
  Serial.begin(9200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(LED_PIN1, OUTPUT);
  pinMode(LED_PIN2, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(MQ2_PIN, INPUT);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(LED_PIN1, HIGH);
  lampState = true;
  digitalWrite(LED_PIN2, HIGH);
  buzzerState = false;
  digitalWrite(BUZZER_PIN, LOW);
  relayState = false;
  digitalWrite(RELAY_PIN, LOW);
  // Prepares the servo and environmental sensor before network setup.
  servo.attach(SERVO_PIN);
  servoState = false;
  servo.write(SERVO_CLOSED_ANGLE);
  dht.begin();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi connected!");
  // Configures Firebase authentication and buffer sizes.
  config.database_url = FIREBASE_HOST;
  auth.token.uid = "ESP32";
  config.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&config, &auth);
  fbData.setBSSLBufferSize(2048, 1024);
  fbPush.setBSSLBufferSize(2048, 1024);
  fbControl.setBSSLBufferSize(2048, 1024);
  Firebase.reconnectWiFi(true);
  // Publishes safe default control and device states to Firebase.
  Firebase.setBool(fbControl, "/control/lamp", true);
  Firebase.setBool(fbControl, "/device_states/lamp", true);
  Firebase.setBool(fbControl, "/control/buzzer", false);
  Firebase.setBool(fbControl, "/device_states/buzzer", false);
  Firebase.setBool(fbControl, "/control/servo", false);
  Firebase.setBool(fbControl, "/device_states/servo", false);
  Firebase.setBool(fbControl, "/control/relay", false);
  Firebase.setBool(fbControl, "/device_states/relay", false);
  Firebase.setString(fbData, "/alerts/type", "NONE");
  Firebase.setBool(fbData, "/alerts/active", false);
}
// Main control loop reads sensors, checks alerts, and syncs Firebase.
void loop() {
  readLampControl();
  readBuzzerControl();
  readServoControl();
  readRelayControl();
  float fireProb = 0;
  float temperature = dht.readTemperature();
  int gasValue = analogRead(MQ2_PIN);
  if (isnan(temperature) || temperature == 0) {
    Serial.println("DHT read failed!");
    delay(100);
    temperature = dht.readTemperature();
  }
  // Prints current sensor values for debugging in Serial Monitor.
  Serial.print("Temperature: ");
  Serial.print(temperature);
  Serial.println(" C");
  Serial.print("Gas (MQ-2): ");
  Serial.println(gasValue);
  Firebase.setFloat(fbData, "/sensors/temperature", temperature);
  Firebase.setInt(fbData, "/sensors/gas_level", gasValue);
  if (Firebase.getFloat(fbData, "/fire_detection/probability")) {
    fireProb = fbData.floatData();
    if (isnan(fireProb)) fireProb = 0.0;
    Serial.print("Fire probability: ");
    Serial.println(fireProb);
    unsigned long now = millis();
    // Pushes chart history records at the configured interval.
    if (now - lastHistoryPush >= HISTORY_INTERVAL_MS) {
      lastHistoryPush = now;
      FirebaseJson histJson;
      histJson.set("temperature", temperature);
      histJson.set("gas_level", gasValue);
      histJson.set("fire_prob", fireProb);
      histJson.set("ts", (int)(now / 1000));
      if (Firebase.pushJSON(fbPush, "/history", histJson)) {
        Serial.println("History pushed OK");
      } else {
        Serial.print("History push failed: ");
        Serial.println(fbPush.errorReason());
      }
    }
    bool fireCondition = (fireProb > FIRE_THRESHOLD) || (temperature > TEMP_THRESHOLD);
    bool gasDetected = (gasValue > GAS_THRESHOLD);
    // Confirms fire only if the condition stays active for two seconds.
    if (fireCondition) {
      if (!firePending) {
        firePending = true;
        fireFirstDetectedAt = millis();
        fireConfirmed = false;
        Serial.println("Fire condition detected - starting confirmation timer...");
      } else if (!fireConfirmed && (millis() - fireFirstDetectedAt >= FIRE_CONFIRM_MS)) {
        fireConfirmed = true;
        Serial.println("Fire CONFIRMED after 2s!");
      }
    } else {
      if (firePending && !fireConfirmed) {
        Serial.println("Fire condition cleared before 2s - FALSE DETECTION, resetting.");
        Firebase.setString(fbData, "/alerts/type", "false Detection");
        Firebase.setBool(fbData, "/alerts/active", true);
        delay(2000);
        Firebase.setString(fbData, "/alerts/type", "NONE");
        Firebase.setBool(fbData, "/alerts/active", false);
      }
      firePending = false;
      fireConfirmed = false;
    }
    String currentAlertType = "NONE";
    if (fireConfirmed && gasDetected) {
      currentAlertType = "FIRE+GAS";
    } else if (fireConfirmed && !gasDetected) {
      currentAlertType = "FIRE";
    } else if (gasDetected) {
      currentAlertType = "GAS";
    }
    // Detects alert transitions so automatic devices change once per event.
    bool alertActive = currentAlertType != "NONE";
    bool alertJustStarted = alertActive && lastAlertType == "NONE";
    bool alertChanged = alertActive && currentAlertType != lastAlertType;
    bool alertJustCleared = !alertActive && lastAlertType != "NONE";
    if (alertJustStarted || alertChanged) {
      forceBuzzerOn();
      if (currentAlertType == "FIRE" || currentAlertType == "FIRE+GAS") {
        forceLampOff();
        forceRelayOn();
      } else {
        forceRelayOff();
      }
      if (currentAlertType == "GAS" || currentAlertType == "FIRE+GAS") {
        forceServoOpen();
      } else {
        forceServoClosed();
      }
    }
    if (alertJustCleared) {
      forceBuzzerOff();
      forceServoClosed();
      forceRelayOff();
    }
    lastAlertType = currentAlertType;
    // Writes the selected alert type so the app can react visually.
    if (currentAlertType == "FIRE+GAS") {
      Serial.println("FIRE + GAS ALERT!");
      updateWarningLed(true);
      digitalWrite(LED_PIN1, LOW);
      Firebase.setString(fbData, "/alerts/type", "FIRE+GAS");
      Firebase.setBool(fbData, "/alerts/active", true);
    } else if (currentAlertType == "FIRE") {
      Serial.println("FIRE ALERT!");
      updateWarningLed(true);
      digitalWrite(LED_PIN1, LOW);
      Firebase.setString(fbData, "/alerts/type", "FIRE");
      Firebase.setBool(fbData, "/alerts/active", true);
    } else if (currentAlertType == "GAS") {
      Serial.println("GAS ALERT!");
      updateWarningLed(true);
      digitalWrite(LED_PIN1, LOW);
      Firebase.setString(fbData, "/alerts/type", "GAS");
      Firebase.setBool(fbData, "/alerts/active", true);
    } else {
      updateWarningLed(false);
      digitalWrite(LED_PIN1, HIGH);
      Firebase.setString(fbData, "/alerts/type", "NONE");
      Firebase.setBool(fbData, "/alerts/active", false);
    }
  } else {
    // Clears local warning output if fire probability cannot be read.
    Serial.print("Firebase read failed: ");
    Serial.println(fbData.errorReason());
    updateWarningLed(false);
  }
} 