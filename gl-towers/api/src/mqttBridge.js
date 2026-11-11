// MQTT bridge: receives tower messages, stores them, raises alerts and forwards commands.
const mqtt = require('mqtt');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const alerts = require('./alerts');
const realtime = require('./realtime');

const SITE = config.mqtt.site;
const topic = (towerId, kind) => `gltowers/${SITE}/${towerId}/${kind}`;

// JSON field sent by the node -> sensor type stored in the database, with plausible limits
const SENSOR_MAP = {
  ph: ['ph', 0, 14], level: ['level', 0, 100], waterTemp: ['water_temp', -10, 60],
  airTemp: ['air_temp', -20, 70], humidity: ['humidity', 0, 100],
};

const pendingCommands = new Map(); // cmdId -> {towerId, target, status, sentAt, confirmedAt}
let client = null;
let connected = false;

function start() {
  client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username, password: config.mqtt.password,
    clientId: `gltowers-api-${process.pid}`, reconnectPeriod: 2000,
  });
  client.on('connect', () => {
    connected = true;
    client.subscribe([topic('+', 'sensors'), topic('+', 'state')], { qos: 1 });
    console.log('[mqtt] connected to', config.mqtt.url);
  });
  client.on('close', () => { connected = false; });
  client.on('error', err => console.error('[mqtt]', err.message));
  client.on('message', (t, payload) => {
    handleMessage(t, payload).catch(err => console.error('[mqtt] message error:', err.message));
  });
  // A node that stops publishing without a Last Will (e.g. power cut on the router) is detected here
  setInterval(() => checkStale().catch(err => console.error('[stale]', err.message)), 30000).unref();
  return client;
}

async function handleMessage(t, payload) {
  const parts = t.split('/'); // gltowers/<site>/<towerId>/<kind>
  if (parts.length !== 4 || parts[0] !== 'gltowers') return;
  const towerId = parts[2]; const kind = parts[3];
  if (!(await db.towerExists(towerId))) { console.warn(`[mqtt] message for unknown tower ${towerId}`); return; }
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { console.warn(`[mqtt] invalid JSON on ${t}`); return; }
  if (kind === 'sensors') return onSensors(towerId, msg);
  if (kind === 'state') return onState(towerId, msg);
}

async function onSensors(towerId, msg) {
  const values = {};
  for (const [field, [type, min, max]] of Object.entries(SENSOR_MAP)) {
    const v = Number(msg[field]);
    if (msg[field] != null && Number.isFinite(v) && v >= min && v <= max) values[type] = Math.round(v * 100) / 100;
  }
  if (!Object.keys(values).length) return;
  const ts = msg.ts && !Number.isNaN(Date.parse(msg.ts)) ? new Date(msg.ts) : new Date();
  const time = Math.abs(ts - Date.now()) > 3600e3 ? new Date() : ts; // ignore a wrong node clock
  await db.insertReadings(towerId, time, values);
  await db.upsertDevice({ id: `node-${towerId}`, towerId, online: true });
  await db.setTowerStatus(towerId, 'Online');
  realtime.broadcast({ type: 'reading', towerId, time: time.toISOString(), values });
  const tower = { id: towerId, name: await db.towerName(towerId) };
  for (const a of await alerts.checkReading(tower, values)) realtime.broadcast({ type: 'alert', alert: a });
}

async function onState(towerId, msg) {
  const online = msg.online !== false;
  await db.upsertDevice({ id: `node-${towerId}`, towerId, online, firmware: msg.fw, rssi: msg.rssi, fsm: msg.fsm });
  await db.setTowerStatus(towerId, online ? 'Online' : 'Offline');
  if (online && (msg.pump || msg.lighting)) await db.setTowerReported(towerId, { pump: msg.pump, lighting: msg.lighting });

  const tower = { id: towerId, name: await db.towerName(towerId) };
  const raised = [];
  if (!online) {
    raised.push(...await alerts.raise(towerId, [{ type: 'offline', level: 'warning', message: `${tower.name} node is offline (connection lost)` }]));
  }
  if (msg.fsm === 'FAULT') {
    raised.push(...await alerts.raise(towerId, [{ type: 'pump_fault', level: 'critical',
      message: `Pump stopped on ${tower.name}: water level too low (FAULT state)` }]));
  }
  for (const a of raised) realtime.broadcast({ type: 'alert', alert: a });

  if (msg.cmdId && pendingCommands.has(msg.cmdId)) {
    const c = pendingCommands.get(msg.cmdId);
    c.status = 'confirmed'; c.confirmedAt = new Date().toISOString();
    realtime.broadcast({ type: 'command-ack', cmdId: msg.cmdId, towerId });
  }
  realtime.broadcast({ type: 'state', towerId, online, fsm: msg.fsm, pump: msg.pump, lighting: msg.lighting, rssi: msg.rssi });
}

async function checkStale() {
  for (const d of await db.markStaleDevices(config.staleAfterSeconds)) {
    if (!d.tower_id) continue;
    await db.setTowerStatus(d.tower_id, 'Offline');
    const name = await db.towerName(d.tower_id);
    const raised = await alerts.raise(d.tower_id, [{ type: 'offline', level: 'warning',
      message: `${name} node is silent (no message for ${config.staleAfterSeconds} s)` }]);
    for (const a of raised) realtime.broadcast({ type: 'alert', alert: a });
    realtime.broadcast({ type: 'state', towerId: d.tower_id, online: false });
  }
}

// Publishes a command for a tower (QoS 1) and returns its id
function sendCommand(towerId, command) {
  const cmdId = crypto.randomUUID();
  const body = { cmdId, ...command };
  pendingCommands.set(cmdId, { towerId, target: command.target, status: 'sent', sentAt: new Date().toISOString() });
  if (pendingCommands.size > 500) pendingCommands.delete(pendingCommands.keys().next().value);
  client.publish(topic(towerId, 'cmd'), JSON.stringify(body), { qos: 1 });
  return cmdId;
}

module.exports = {
  start, sendCommand, topic,
  commandStatus: id => pendingCommands.get(id) || null,
  isConnected: () => connected,
  stop: () => client && client.end(true),
};
