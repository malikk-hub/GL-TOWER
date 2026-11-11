// Copy this file to config.h and fill in your values (config.h is not committed).
#pragma once

// ---- Wi-Fi ----
#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"

// ---- MQTT broker (Mosquitto) ----
#define MQTT_HOST      "192.168.1.10"     // IP of the computer/server running Mosquitto
#define MQTT_PORT      1883
#define MQTT_SITE      "main"
#define TOWER_ID       "tower-01"         // also the MQTT username (see mosquitto/config/acl)
#define MQTT_PASSWORD  "node-dev-pass"

// ---- Time (NTP) for the irrigation and lighting windows ----
#define TZ_INFO        "CET-1"            // Tunisia: UTC+1, no daylight saving

// ---- Sensor calibration ----
// pH: measure the board voltage in pH 7.00 and pH 4.00 buffer solutions (see README).
#define PH_V_AT_7      1.50f              // volts read in pH 7 buffer
#define PH_V_AT_4      2.03f              // volts read in pH 4 buffer
// Reservoir: distance from the ultrasonic sensor to the water surface
#define TANK_EMPTY_CM  30.0f              // distance when the reservoir is empty
#define TANK_FULL_CM   5.0f               // distance when the reservoir is full

#define PUBLISH_INTERVAL_MS 10000         // one sensor message every 10 s
#define LOW_LEVEL_FAULT     15            // % below which the pump is stopped (FAULT)
