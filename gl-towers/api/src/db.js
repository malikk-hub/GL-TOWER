// Data access layer: every SQL query of the API lives here.
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

// Sensor types stored in sensor_readings <-> field names used by the web app
const SENSOR_FIELDS = { ph: 'ph', level: 'reservoir', water_temp: 'waterTemp', air_temp: 'airTemp', humidity: 'humidity' };

function relativeTime(date) {
  if (!date) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Builds the tower object exactly as the web application expects it
function toTowerJson(row, modules, latest, device) {
  const t = {
    id: row.id, name: row.name, location: row.location, status: row.status, stage: row.stage,
    substrate: row.substrate, type: row.type, installed: row.installed,
    reservoir: 0, ph: '—', ec: '—', waterTemp: '—', airTemp: '—', humidity: '—',
    lighting: row.lighting, pump: row.pump,
    modules: [], lastSync: 'never', lastSeen: null,
    device: device ? { id: device.id, online: device.online, firmware: device.firmware, rssi: device.rssi, fsm: device.fsm_state } : null,
  };
  let newest = null;
  for (const r of latest) {
    const field = SENSOR_FIELDS[r.type];
    if (!field) continue;
    t[field] = field === 'reservoir' ? Math.round(r.value) : Math.round(r.value * 10) / 10;
    if (!newest || r.time > newest) newest = r.time;
  }
  t.lastSeen = newest; t.lastSync = relativeTime(newest);
  t.modules = modules.map(m => ({ name: m.name, plants: m.plants, waterLevel: t.reservoir, growDays: m.grow_days }));
  return t;
}

async function listTowers() {
  const [towers, modules, latest, devices] = await Promise.all([
    pool.query('SELECT * FROM towers ORDER BY id'),
    pool.query('SELECT * FROM modules ORDER BY tower_id, position'),
    pool.query('SELECT * FROM latest_readings'),
    pool.query('SELECT * FROM devices'),
  ]);
  return towers.rows.map(row => toTowerJson(
    row,
    modules.rows.filter(m => m.tower_id === row.id),
    latest.rows.filter(l => l.tower_id === row.id),
    devices.rows.find(d => d.tower_id === row.id),
  ));
}

async function getTower(id) {
  return (await listTowers()).find(t => t.id === id) || null;
}

async function towerName(id) {
  const r = await pool.query('SELECT name FROM towers WHERE id=$1', [id]);
  return r.rows[0]?.name || id;
}

async function towerExists(id) {
  const r = await pool.query('SELECT 1 FROM towers WHERE id=$1', [id]);
  return r.rowCount > 0;
}

async function saveModules(client, towerId, modules) {
  await client.query('DELETE FROM modules WHERE tower_id=$1', [towerId]);
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    await client.query(
      'INSERT INTO modules (tower_id, position, name, plants, grow_days) VALUES ($1,$2,$3,$4,$5)',
      [towerId, i, m.name || `Module ${i + 1}`, (m.plants || []).filter(Boolean), Number(m.growDays) || 0]);
  }
}

async function createTower(t) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO towers (id, name, location, status, stage, substrate, type, installed, lighting, pump)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.id, t.name, t.location || 'GreenLab HQ', t.status || 'Online', t.stage || 'Vegetative',
       t.substrate || 'hydroponic', t.type || 'Standard (3 modules)', t.installed || null,
       t.lighting || {}, t.pump || {}]);
    await saveModules(client, t.id, t.modules || []);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return getTower(t.id);
}

const EDITABLE = ['name', 'location', 'status', 'stage', 'substrate', 'type', 'installed', 'lighting', 'pump'];
async function updateTower(id, patch) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sets = []; const values = [];
    for (const key of EDITABLE) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]); sets.push(`${key}=$${values.length}`);
    }
    if (sets.length) {
      values.push(id);
      const r = await client.query(`UPDATE towers SET ${sets.join(', ')} WHERE id=$${values.length}`, values);
      if (r.rowCount === 0) { await client.query('ROLLBACK'); return null; }
    }
    if (Array.isArray(patch.modules)) await saveModules(client, id, patch.modules);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return getTower(id);
}

async function deleteTower(id) {
  const r = await pool.query('DELETE FROM towers WHERE id=$1', [id]);
  return r.rowCount > 0;
}

// ---- readings ----
async function insertReadings(towerId, time, values) {
  const rows = Object.entries(values);
  if (!rows.length) return;
  const params = []; const tuples = [];
  rows.forEach(([type, value], i) => {
    params.push(time, towerId, type, value);
    tuples.push(`($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`);
  });
  await pool.query(`INSERT INTO sensor_readings (time, tower_id, type, value) VALUES ${tuples.join(',')}`, params);
}

// History for charts. With bucketMinutes, values are averaged per time bucket.
async function readings(towerId, { type, hours = 24, bucketMinutes }) {
  const params = [towerId, `${Number(hours)} hours`];
  let typeFilter = '';
  if (type) { params.push(type); typeFilter = `AND type = $${params.length}`; }
  if (bucketMinutes) {
    params.push(`${Number(bucketMinutes)} minutes`);
    const r = await pool.query(
      `SELECT date_bin($${params.length}::interval, time, TIMESTAMPTZ '2000-01-01') AS time, type, avg(value) AS value
       FROM sensor_readings WHERE tower_id=$1 AND time > now() - $2::interval ${typeFilter}
       GROUP BY 1, 2 ORDER BY 1`, params);
    return r.rows;
  }
  const r = await pool.query(
    `SELECT time, type, value FROM sensor_readings
     WHERE tower_id=$1 AND time > now() - $2::interval ${typeFilter} ORDER BY time`, params);
  return r.rows;
}

// ---- plants ----
async function listPlants() {
  const r = await pool.query('SELECT data FROM plants ORDER BY category, name');
  return r.rows.map(x => x.data);
}
async function getPlant(id) {
  const r = await pool.query('SELECT data FROM plants WHERE id=$1', [id]);
  return r.rows[0]?.data || null;
}
async function upsertPlant(p) {
  await pool.query(
    `INSERT INTO plants (id, name, category, ph_min, ph_max, ec_min, ec_max, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, ph_min=EXCLUDED.ph_min,
       ph_max=EXCLUDED.ph_max, ec_min=EXCLUDED.ec_min, ec_max=EXCLUDED.ec_max, data=EXCLUDED.data`,
    [p.id, p.displayName, p.categoryGL || 'Experimental', num(p.phMin), num(p.phMax), num(p.ecMin), num(p.ecMax), p]);
  return p;
}
async function deletePlant(id) {
  const r = await pool.query('DELETE FROM plants WHERE id=$1', [id]);
  return r.rowCount > 0;
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// Plants grown on a tower, used by the alert engine
async function plantsOfTower(towerId) {
  const r = await pool.query(
    `SELECT DISTINCT p.data FROM modules m JOIN plants p ON p.id = ANY(m.plants) WHERE m.tower_id=$1`, [towerId]);
  return r.rows.map(x => x.data);
}

// ---- alerts ----
async function openAlertExists(towerId, type) {
  const r = await pool.query('SELECT 1 FROM alerts WHERE tower_id=$1 AND type=$2 AND NOT ack', [towerId, type]);
  return r.rowCount > 0;
}
async function createAlert(a) {
  const r = await pool.query(
    'INSERT INTO alerts (tower_id, level, type, message, value) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [a.towerId, a.level, a.type, a.message, a.value ?? null]);
  return alertJson(r.rows[0]);
}
async function listAlerts({ open, towerId }) {
  const where = []; const params = [];
  if (open) where.push('NOT ack');
  if (towerId) { params.push(towerId); where.push(`tower_id=$${params.length}`); }
  const r = await pool.query(
    `SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`, params);
  return r.rows.map(alertJson);
}
async function ackAlert(id) {
  const r = await pool.query('UPDATE alerts SET ack=true WHERE id=$1 RETURNING *', [id]);
  return r.rows[0] ? alertJson(r.rows[0]) : null;
}
function alertJson(r) {
  return { id: Number(r.id), towerId: r.tower_id, level: r.level, type: r.type, message: r.message,
    value: r.value, ack: r.ack, createdAt: r.created_at };
}

// ---- devices ----
async function upsertDevice(d) {
  await pool.query(
    `INSERT INTO devices (id, tower_id, firmware, online, rssi, fsm_state, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (id) DO UPDATE SET
       tower_id=EXCLUDED.tower_id,
       firmware=COALESCE(EXCLUDED.firmware, devices.firmware),
       online=EXCLUDED.online,
       rssi=COALESCE(EXCLUDED.rssi, devices.rssi),
       fsm_state=COALESCE(EXCLUDED.fsm_state, devices.fsm_state),
       last_seen=now()`,
    [d.id, d.towerId, d.firmware ?? null, d.online, d.rssi ?? null, d.fsm ?? null]);
}
async function listDevices() {
  const r = await pool.query('SELECT * FROM devices ORDER BY id');
  return r.rows.map(d => ({ id: d.id, towerId: d.tower_id, firmware: d.firmware, online: d.online, rssi: d.rssi,
    fsm: d.fsm_state, lastSeen: d.last_seen, lastSync: relativeTime(d.last_seen) }));
}
// Nodes marked online whose last message is older than the limit (lost without a Last Will)
async function markStaleDevices(seconds) {
  const r = await pool.query(
    `UPDATE devices SET online=false WHERE online AND last_seen < now() - ($1 || ' seconds')::interval RETURNING id, tower_id`,
    [String(seconds)]);
  return r.rows;
}

async function setTowerStatus(id, status) {
  await pool.query(`UPDATE towers SET status=$2 WHERE id=$1 AND status <> 'Maintenance'`, [id, status]);
}
async function setTowerReported(id, { pump, lighting }) {
  if (pump) await pool.query(`UPDATE towers SET pump = pump || $2::jsonb WHERE id=$1`, [id, pump]);
  if (lighting) await pool.query(`UPDATE towers SET lighting = lighting || $2::jsonb WHERE id=$1`, [id, lighting]);
}

async function ping() { await pool.query('SELECT 1'); return true; }

module.exports = {
  pool, ping, SENSOR_FIELDS,
  listTowers, getTower, towerExists, towerName, createTower, updateTower, deleteTower,
  insertReadings, readings,
  listPlants, getPlant, upsertPlant, deletePlant, plantsOfTower,
  openAlertExists, createAlert, listAlerts, ackAlert,
  upsertDevice, listDevices, setTowerStatus, setTowerReported, markStaleDevices,
};
