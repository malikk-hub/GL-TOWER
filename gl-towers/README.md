# GL Towers

Supervision platform for hydroponic vertical-farming towers — Fab619 internship project (Mohamed Malek Gazzeh, EPI Digital School).

```
ESP32 node ──MQTT──► Mosquitto ──► Node.js API ──► PostgreSQL + TimescaleDB
 (sensors,            (auth +       (REST, alerts,
  pump, LEDs) ◄─cmd──  ACL)          WebSocket) ──► Web application (11 workspaces)
```

| Folder | Content |
|---|---|
| `web/` | Web application (`index.html`) + live data layer (`gl-live.js`) |
| `api/` | REST API, MQTT bridge, alert engine, WebSocket push, seed script, tests |
| `db/` | Database schema (`init.sql`) and seed data (254 plants, 8 towers) |
| `mosquitto/config/` | Broker configuration, access-control list, password script |
| `firmware/gl_tower_node/` | ESP32 firmware (Arduino) |
| `simulator/` | Simulates ESP32 nodes (same topics/messages) to test without hardware |
| `tests/` | Browser tests (live mode and demo mode) |

## 1. Run with Docker (recommended)

```bash
cd mosquitto/config && ./make_passwd.sh <api-password> <device-password> && cd ../..
sudo chown -R 1883:1883 mosquitto/config          # the broker container runs as uid 1883
cp .env.example .env                                # put the same <api-password> in MQTT_API_PASSWORD
docker compose up -d --build
```
Open **http://localhost:3000**. The database is created and seeded automatically.
`make_passwd.sh` needs `mosquitto_passwd` (`sudo apt install mosquitto`), or run it inside the container:
`docker run --rm -v $PWD/mosquitto/config:/m eclipse-mosquitto:2 sh -c "cd /m && ./make_passwd.sh <api> <device>"`.

## 2. Run without Docker (development)

Requirements: Node.js 20+, PostgreSQL 16 (TimescaleDB optional), Mosquitto 2.

```bash
createdb gltowers && psql -d gltowers -f db/init.sql   # with user/password of DATABASE_URL
cd mosquitto/config && ./make_passwd.sh api-dev-pass node-dev-pass && cd ../..
mosquitto -c mosquitto/config/mosquitto.conf            # edit the /mosquitto/... paths to local paths first
cd api && npm install && npm run seed && npm start      # http://localhost:3000
```
Without TimescaleDB, `init.sql` creates `sensor_readings` as a normal indexed table (same queries work).

## 3. Test without hardware

```bash
cd simulator && npm install
node simulate.js --towers tower-01,tower-02,tower-03 --interval 2           # normal operation
node simulate.js --towers tower-05 --interval 1 --scenario low-level        # reservoir empties -> FAULT
node simulate.js --towers tower-03 --scenario ph-high                        # pH alert
```
Kill a simulator with `kill -9` to see the Last Will (node shown offline).

## 4. Tests

```bash
cd api && npm test                 # alert unit tests + integration tests I1–I8 + security (S1)
python3 tests/e2e_live.py          # browser tests, live mode (server + simulator running)
python3 tests/demo_mode_tests.py   # browser tests, demo mode (index.html opened as a file)
python3 tests/web_unit_tests.py    # unit tests of the web application logic (U1–U5)
```
Last run: 5/5 web unit + 4/4 alert unit, 9/9 integration & security, 7/7 live browser tests, 14/14 demo-mode tests (39 tests).

## 5. ESP32 firmware

1. Arduino IDE → Boards Manager: **esp32 by Espressif (3.x)**; board "ESP32 Dev Module".
2. Library Manager: **PubSubClient**, **ArduinoJson (7.x)**, **OneWire**, **DallasTemperature**, **DHT sensor library** (Adafruit).
3. Copy `config.example.h` to `config.h`, set Wi-Fi, broker IP, `TOWER_ID` and device password.
4. Wire as in the report (Table 3.2): pH GPIO34, ultrasonic TRIG 16 / ECHO 17, DS18B20 GPIO4 (4.7 kΩ pull-up), DHT22 GPIO27, relay GPIO26, MOSFET GPIO25.
5. **pH calibration:** dip the probe in pH 7.00 buffer, read the voltage printed on the serial monitor → `PH_V_AT_7`; same with pH 4.00 → `PH_V_AT_4`.
6. **Level calibration:** measure the sensor-to-water distance with the reservoir empty (`TANK_EMPTY_CM`) and full (`TANK_FULL_CM`).
7. The ultrasonic ECHO pin outputs 5 V on some boards: use a voltage divider (e.g. 1 kΩ / 2 kΩ) to bring it to 3.3 V.

The firmware has not been compiled in this environment (the Arduino toolchain could not be downloaded); compile it once in the Arduino IDE before flashing.

## MQTT topics

| Topic | Direction | QoS | Content |
|---|---|---|---|
| `gltowers/main/{towerId}/sensors` | node → server | 0 | `{"ts","ph","level","waterTemp","airTemp","humidity"}` |
| `gltowers/main/{towerId}/state` | node → server | retained | `{"online","fw","rssi","fsm","pump","lighting","cmdId"}`; Last Will `{"online":false}` |
| `gltowers/main/{towerId}/cmd` | server → node | 1 | `{"cmdId","target":"pump"\|"lighting", ...}` |

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Database and broker status |
| GET / POST | `/api/towers` | List / create towers |
| GET / PATCH / DELETE | `/api/towers/:id` | Read / modify / delete a tower |
| GET | `/api/towers/:id/readings?hours=24&bucket=15&type=ph` | Sensor history (optional averages per bucket, minutes) |
| POST | `/api/towers/:id/commands` | `{"target":"pump","pumpOn":2,"pumpPause":75}` or `{"target":"lighting",...}`; `{"target":"pump","action":"reset"}` leaves FAULT |
| GET | `/api/commands/:cmdId` | `sent` / `confirmed` |
| GET / POST / PUT / DELETE | `/api/plants[/:id]` | Plant library |
| GET / PATCH | `/api/alerts[/:id]` | `?open=1&towerId=` ; acknowledge with `{"ack":true}` |
| GET | `/api/devices` | Nodes: online, pump state, signal, firmware |
| WS | `/ws` | Events `reading`, `state`, `alert`, `alert-ack`, `command-ack`, `tower-changed` |

## Known limitations

- No user accounts yet (single user; add authentication before exposing the server to the Internet).
- The broker listens without TLS (local network). Use port 8883 with certificates for remote towers.
- EC is not measured by the prototype node (no EC sensor in the bill of materials).
