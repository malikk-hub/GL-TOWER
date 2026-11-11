/*
 * GL Towers - ESP32 sensor node firmware  (v1.0.0)
 *
 * Reads the tower sensors, publishes them over MQTT, receives pump / lighting commands
 * and runs the pump state machine locally, so irrigation keeps working without Wi-Fi.
 *
 * Topics (TOWER_ID = "tower-01", MQTT_SITE = "main"):
 *   gltowers/main/tower-01/sensors   node -> server  {"ts","ph","level","waterTemp","airTemp","humidity"}
 *   gltowers/main/tower-01/state     node -> server  retained {"online","fw","rssi","fsm","pump","lighting","cmdId"}
 *   gltowers/main/tower-01/cmd       server -> node  {"cmdId","target":"pump"|"lighting", ...settings}
 * Last Will: {"online":false} on the state topic (retained), published by the broker if the node disappears.
 *
 * Wiring (report, Table 3.2):
 *   GPIO34 pH board analog out | GPIO16 ultrasonic TRIG | GPIO17 ultrasonic ECHO (3.3 V level)
 *   GPIO4  DS18B20 (4.7k pull-up) | GPIO27 DHT22 | GPIO26 relay (pump) | GPIO25 MOSFET gate (LED PWM)
 *
 * Board: "ESP32 Dev Module" (Arduino-ESP32 core 3.x)
 * Libraries: PubSubClient (Nick O'Leary), ArduinoJson 7, OneWire, DallasTemperature, DHT sensor library (Adafruit)
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <DHT.h>
#include <time.h>
#include "config.h"

#define FW_VERSION "1.0.0"

// ---------------- pins ----------------
const int PIN_PH = 34, PIN_TRIG = 16, PIN_ECHO = 17, PIN_DS18B20 = 4, PIN_DHT = 27, PIN_RELAY = 26, PIN_LED = 25;
const bool RELAY_ACTIVE_LOW = true;   // most relay modules switch ON with a LOW input

// ---------------- objects ----------------
WiFiClient net;
PubSubClient mqtt(net);
OneWire oneWire(PIN_DS18B20);
DallasTemperature waterProbe(&oneWire);
DHT dht(PIN_DHT, DHT22);

String topicBase = String("gltowers/") + MQTT_SITE + "/" + TOWER_ID;
String tSensors = topicBase + "/sensors", tState = topicBase + "/state", tCmd = topicBase + "/cmd";

// ---------------- settings (updated by commands) ----------------
struct PumpCfg  { bool enabled = true; float onMin = 1.0; float pauseMin = 90; String start = "06:00", end = "22:00"; } pump;
struct LightCfg { bool enabled = true; int brightness = 70; String start = "06:00", end = "22:00"; int photoperiod = 16; } light;

// ---------------- pump state machine (report, Figure 2.7) ----------------
enum Fsm { IDLE, PUMP_ON, PUMP_OFF, FAULT };
const char *FSM_NAMES[] = { "IDLE", "PUMP_ON", "PUMP_OFF", "FAULT" };
Fsm fsm = IDLE;
unsigned long fsmSince = 0;

float lastLevel = 100;          // last valid reservoir level (%)
String lastCmdId = "";
unsigned long lastPublish = 0, lastReconnect = 0;

// ======================================================================
void setRelay(bool on) { digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }

int minutesOfDay(const String &hhmm) { return hhmm.substring(0, 2).toInt() * 60 + hhmm.substring(3, 5).toInt(); }

// true if "now" is inside [start, end), handles windows crossing midnight; true if time is unknown
bool inWindow(const String &start, const String &end) {
  struct tm now;
  if (!getLocalTime(&now, 10)) return true;
  int m = now.tm_hour * 60 + now.tm_min, s = minutesOfDay(start), e = minutesOfDay(end);
  return s <= e ? (m >= s && m < e) : (m >= s || m < e);
}

void publishState() {
  JsonDocument doc;
  doc["online"] = true; doc["fw"] = FW_VERSION; doc["rssi"] = WiFi.RSSI(); doc["fsm"] = FSM_NAMES[fsm];
  JsonObject p = doc["pump"].to<JsonObject>();
  p["enabled"] = pump.enabled; p["pumpOn"] = pump.onMin; p["pumpPause"] = pump.pauseMin; p["start"] = pump.start; p["end"] = pump.end;
  JsonObject l = doc["lighting"].to<JsonObject>();
  l["enabled"] = light.enabled; l["brightness"] = light.brightness; l["start"] = light.start; l["end"] = light.end; l["photoperiod"] = light.photoperiod;
  if (lastCmdId.length()) doc["cmdId"] = lastCmdId;
  char buf[512]; size_t n = serializeJson(doc, buf);
  mqtt.publish(tState.c_str(), (const uint8_t *)buf, n, true);   // retained
}

void setFsm(Fsm next) {
  if (fsm == next) return;
  fsm = next; fsmSince = millis();
  setRelay(fsm == PUMP_ON);
  Serial.printf("[fsm] -> %s\n", FSM_NAMES[fsm]);
  if (mqtt.connected()) publishState();
}

void runFsm() {
  float minutes = (millis() - fsmSince) / 60000.0;
  if (lastLevel < LOW_LEVEL_FAULT && fsm != FAULT) { setFsm(FAULT); return; }
  bool allowed = pump.enabled && inWindow(pump.start, pump.end);
  switch (fsm) {
    case IDLE:     if (allowed) setFsm(PUMP_ON); break;
    case PUMP_ON:  if (!allowed || minutes >= pump.onMin) setFsm(PUMP_OFF); break;
    case PUMP_OFF: if (!pump.enabled) setFsm(IDLE); else if (allowed && minutes >= pump.pauseMin) setFsm(PUMP_ON); break;
    case FAULT:    break;   // leaves only with a "reset" command once the level is back
  }
}

void applyLighting() {
  bool on = light.enabled && inWindow(light.start, light.end);
  ledcWrite(PIN_LED, on ? map(light.brightness, 0, 100, 0, 255) : 0);
}

// ---------------- sensors ----------------
float readPh() {
  long sum = 0;
  for (int i = 0; i < 20; i++) { sum += analogReadMilliVolts(PIN_PH); delay(5); }
  float v = sum / 20.0 / 1000.0;
  float slope = (7.0 - 4.0) / (PH_V_AT_7 - PH_V_AT_4);     // pH per volt (negative)
  return 7.0 + slope * (v - PH_V_AT_7);
}

float readLevelPercent() {
  digitalWrite(PIN_TRIG, LOW); delayMicroseconds(4);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(20);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);
  if (us == 0) return NAN;                                   // no echo
  float cm = us * 0.0343 / 2.0;
  float pct = (TANK_EMPTY_CM - cm) / (TANK_EMPTY_CM - TANK_FULL_CM) * 100.0;
  return constrain(pct, 0, 100);
}

void publishSensors() {
  waterProbe.requestTemperatures();
  float waterT = waterProbe.getTempCByIndex(0);
  float airT = dht.readTemperature(), hum = dht.readHumidity();
  float level = readLevelPercent(), ph = readPh();
  if (!isnan(level)) lastLevel = level;

  JsonDocument doc;
  struct tm now; char ts[25];
  if (getLocalTime(&now, 10)) { time_t t = time(nullptr); strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", gmtime(&t)); doc["ts"] = ts; }
  if (ph > 0 && ph < 14) doc["ph"] = round(ph * 100) / 100.0;
  if (!isnan(level)) doc["level"] = (int)round(level);
  if (waterT != DEVICE_DISCONNECTED_C) doc["waterTemp"] = round(waterT * 10) / 10.0;
  if (!isnan(airT)) doc["airTemp"] = round(airT * 10) / 10.0;
  if (!isnan(hum)) doc["humidity"] = (int)round(hum);
  char buf[256]; size_t n = serializeJson(doc, buf);
  mqtt.publish(tSensors.c_str(), (const uint8_t *)buf, n, false);
  Serial.printf("[sensors] %s\n", buf);
}

// ---------------- commands ----------------
void onMessage(char *topic, byte *payload, unsigned int len) {
  JsonDocument cmd;
  if (deserializeJson(cmd, payload, len)) { Serial.println("[cmd] invalid JSON"); return; }
  String target = cmd["target"] | "";
  if (target == "pump") {
    if (cmd["action"] == "reset" && fsm == FAULT && lastLevel >= LOW_LEVEL_FAULT) setFsm(IDLE);
    if (!cmd["enabled"].isNull())   pump.enabled  = cmd["enabled"];
    if (!cmd["pumpOn"].isNull())    pump.onMin    = cmd["pumpOn"];
    if (!cmd["pumpPause"].isNull()) pump.pauseMin = cmd["pumpPause"];
    if (!cmd["start"].isNull())     pump.start    = cmd["start"].as<String>();
    if (!cmd["end"].isNull())       pump.end      = cmd["end"].as<String>();
    if (!pump.enabled && fsm != FAULT) setFsm(IDLE);
  } else if (target == "lighting") {
    if (!cmd["enabled"].isNull())     light.enabled     = cmd["enabled"];
    if (!cmd["brightness"].isNull())  light.brightness  = constrain((int)cmd["brightness"], 0, 100);
    if (!cmd["start"].isNull())       light.start       = cmd["start"].as<String>();
    if (!cmd["end"].isNull())         light.end         = cmd["end"].as<String>();
    if (!cmd["photoperiod"].isNull()) light.photoperiod = cmd["photoperiod"];
    applyLighting();
  } else return;
  lastCmdId = cmd["cmdId"] | "";
  Serial.printf("[cmd] %s applied (%s)\n", target.c_str(), lastCmdId.c_str());
  publishState();                                            // confirms the command to the server
}

// ---------------- connectivity (non-blocking) ----------------
void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected() || millis() - lastReconnect < 5000) return;
  lastReconnect = millis();
  String clientId = String("node-") + TOWER_ID;
  bool ok = mqtt.connect(clientId.c_str(), TOWER_ID, MQTT_PASSWORD,
                         tState.c_str(), 1, true, "{\"online\":false}");   // Last Will
  if (ok) {
    mqtt.subscribe(tCmd.c_str(), 1);
    publishState();
    Serial.println("[mqtt] connected");
  } else {
    Serial.printf("[mqtt] connection failed, rc=%d\n", mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT); setRelay(false);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
  analogSetPinAttenuation(PIN_PH, ADC_11db);
  ledcAttach(PIN_LED, 5000, 8);                              // 5 kHz, 8-bit PWM
  waterProbe.begin(); dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(onMessage);
  fsmSince = millis();
}

void loop() {
  ensureMqtt();
  mqtt.loop();
  runFsm();                                                  // runs even without Wi-Fi
  applyLighting();
  if (millis() - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = millis();
    if (mqtt.connected()) publishSensors();
    else { float lv = readLevelPercent(); if (!isnan(lv)) lastLevel = lv; }   // keep the FAULT protection offline
  }
  delay(20);
}
