-- GL Towers database schema (PostgreSQL 16, TimescaleDB when available)
-- Run once on an empty database:  psql -d gltowers -f db/init.sql

-- TimescaleDB is optional: the Docker deployment uses the timescale image and
-- gets a real hypertable; a plain PostgreSQL server falls back to an indexed table.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB not available, sensor_readings will be a regular table';
END $$;

CREATE TABLE IF NOT EXISTS towers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT 'GreenLab HQ',
  status      TEXT NOT NULL DEFAULT 'Online',      -- Online | Offline | Maintenance
  stage       TEXT NOT NULL DEFAULT 'Vegetative',  -- Germination | Seedling | Vegetative | Flowering | Mature | Empty
  substrate   TEXT NOT NULL DEFAULT 'hydroponic',  -- soil | coco | rockwool | clay | hydroponic
  type        TEXT NOT NULL DEFAULT 'Standard (3 modules)',
  installed   TEXT,
  lighting    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {enabled, preset, start, end, brightness, photoperiod}
  pump        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {enabled, pumpOn, pumpPause, start, end, nightBreak, profile}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modules (
  tower_id    TEXT NOT NULL REFERENCES towers(id) ON DELETE CASCADE,
  position    INT  NOT NULL,
  name        TEXT NOT NULL,
  plants      TEXT[] NOT NULL DEFAULT '{}',        -- plant ids, one per slot
  grow_days   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tower_id, position)
);

CREATE TABLE IF NOT EXISTS plants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  ph_min      REAL,
  ph_max      REAL,
  ec_min      REAL,
  ec_max      REAL,
  data        JSONB NOT NULL                       -- full plant profile as used by the web app
);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,                    -- one ESP32 node per tower: "node-<towerId>"
  tower_id    TEXT REFERENCES towers(id) ON DELETE SET NULL,
  firmware    TEXT,
  online      BOOLEAN NOT NULL DEFAULT false,
  rssi        INT,
  fsm_state   TEXT,
  last_seen   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  tower_id    TEXT REFERENCES towers(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,                       -- critical | warning
  type        TEXT NOT NULL,                       -- ph_range | low_level | water_temp | pump_fault | offline
  message     TEXT NOT NULL,
  value       REAL,
  ack         BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (tower_id, type) WHERE NOT ack;

CREATE TABLE IF NOT EXISTS sensor_readings (
  time      TIMESTAMPTZ NOT NULL,
  tower_id  TEXT        NOT NULL REFERENCES towers(id) ON DELETE CASCADE,
  type      TEXT        NOT NULL,                  -- ph, level, water_temp, air_temp, humidity
  value     DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS sensor_readings_tower_time_idx ON sensor_readings (tower_id, type, time DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('sensor_readings', 'time', if_not_exists => TRUE);
  END IF;
END $$;

-- Latest value of each sensor type for each tower (used by GET /api/towers)
CREATE OR REPLACE VIEW latest_readings AS
SELECT DISTINCT ON (tower_id, type) tower_id, type, value, time
FROM sensor_readings
ORDER BY tower_id, type, time DESC;
