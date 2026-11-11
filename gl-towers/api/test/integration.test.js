// GL Towers integration tests (scenarios I1–I8 of the report + security checks).
// Requirements: Mosquitto, PostgreSQL and the API running (npm start), seeded database (npm run seed),
// and a simulator for tower-01..tower-03:  node ../simulator/simulate.js --towers tower-01,tower-02,tower-03 --interval 2
// Run: npm test            (results are also written to test/results.json)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const mqtt = require('mqtt');

const API = process.env.API_URL || 'http://localhost:3000';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const DEVICE_PWD = process.env.DEVICE_PASSWORD || 'node-dev-pass';
const API_PWD = process.env.MQTT_PASSWORD || 'api-dev-pass';
const SIM = path.join(__dirname, '..', '..', 'simulator', 'simulate.js');
const results = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, body) {
  const r = await fetch(API + '/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
async function waitFor(fn, timeoutMs = 15000, stepMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(stepMs); }
  return null;
}
function connect(username, password) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(MQTT_URL, { username, password, reconnectPeriod: 0, connectTimeout: 4000 });
    c.once('connect', () => resolve(c)); c.once('error', reject);
  });
}
function record(id, scenario, criterion, observed, ms) { results.push({ id, scenario, criterion, observed, ms }); }
async function ackOpen(towerId, type) {
  for (const a of (await api('GET', `/alerts?open=1&towerId=${towerId}`)).body) if (a.type === type) await api('PATCH', `/alerts/${a.id}`, { ack: true });
}

test('I1 — the node publishes a reading: visible on the topic and stored in sensor_readings', async () => {
  const watcher = await connect('api', API_PWD);
  const seen = new Promise(res => { watcher.on('message', (t, p) => res({ t, p: JSON.parse(p) })); });
  await new Promise(r => watcher.subscribe('gltowers/main/tower-02/sensors', { qos: 1 }, r));
  const node = await connect('tower-02', DEVICE_PWD);
  const marker = 6.37;                                   // distinctive value
  const t0 = Date.now();
  node.publish('gltowers/main/tower-02/sensors', JSON.stringify({ ts: new Date().toISOString(), ph: marker, level: 77, waterTemp: 21.4, airTemp: 22.9, humidity: 66 }));
  const msg = await seen;
  assert.equal(msg.p.ph, marker);
  const stored = await waitFor(async () => {
    const rows = (await api('GET', '/towers/tower-02/readings?hours=1&type=ph')).body;
    return rows.find(r => Math.abs(r.value - marker) < 1e-9);
  });
  const ms = Date.now() - t0;
  assert.ok(stored, 'reading stored in the database');
  record('I1', 'The ESP32 publishes a reading', 'Message visible on the sensors topic, row added to sensor_readings',
    `Message received on gltowers/main/tower-02/sensors; pH ${marker} stored and returned by the API after ${ms} ms`, ms);
  watcher.end(true); node.end(true);
});

test('I2 — a new reading reaches connected browsers over the WebSocket', async () => {
  const ws = new WebSocket(API.replace(/^http/, 'ws') + '/ws');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const got = new Promise(res => { ws.onmessage = m => { const e = JSON.parse(m.data); if (e.type === 'reading' && e.towerId === 'tower-02' && e.values.ph === 6.41) res(e); }; });
  const node = await connect('tower-02', DEVICE_PWD);
  const t0 = Date.now();
  node.publish('gltowers/main/tower-02/sensors', JSON.stringify({ ph: 6.41, level: 76 }));
  const ev = await Promise.race([got, sleep(10000).then(() => null)]);
  const ms = Date.now() - t0;
  assert.ok(ev, 'reading event pushed');
  record('I2', 'A new reading reaches the dashboard', 'Card and chart updated without reloading the page',
    `WebSocket "reading" event received ${ms} ms after publication (UI update checked in the browser test)`, ms);
  ws.close(); node.end(true);
});

test('I3 — pH outside the plants’ target range raises an alert', async () => {
  await ackOpen('tower-03', 'ph_range');
  const node = await connect('tower-03', DEVICE_PWD);
  node.publish('gltowers/main/tower-03/sensors', JSON.stringify({ ph: 7.6, level: 80 }));
  const alert = await waitFor(async () => (await api('GET', '/alerts?open=1&towerId=tower-03')).body.find(a => a.type === 'ph_range'));
  assert.ok(alert); assert.match(alert.message, /pH 7\.6/);
  record('I3', "pH outside the plant's target range", 'Alert created and shown in the Alerts workspace',
    `Alert "${alert.message}" (level ${alert.level}) returned by GET /api/alerts`);
  node.end(true);
  await api('PATCH', `/alerts/${alert.id}`, { ack: true });
});

test('I4 — a pump command reaches the node, which confirms it', async () => {
  const t0 = Date.now();
  const r = await api('POST', '/towers/tower-01/commands', { target: 'pump', pumpOn: 2, pumpPause: 75 });
  assert.equal(r.status, 202);
  const confirmed = await waitFor(async () => {
    const c = (await api('GET', `/commands/${r.body.cmdId}`)).body; return c.status === 'confirmed' ? c : null;
  });
  const ms = Date.now() - t0;
  assert.ok(confirmed, 'command confirmed by the node');
  const tower = (await api('GET', '/towers/tower-01')).body;
  assert.equal(tower.pump.pumpOn, 2); assert.equal(tower.pump.pumpPause, 75);
  record('I4', 'Pump cycle changed from the Irrigation workspace', 'Command received by the ESP32, new state published and confirmed in the UI',
    `Command ${r.body.cmdId.slice(0, 8)}… confirmed by the node after ${ms} ms; tower now ON 2 min / pause 75 min`, ms);
  await api('POST', '/towers/tower-01/commands', { target: 'pump', pumpOn: 1, pumpPause: 90 });
});

test('I5 — low water level: pump state machine goes to FAULT and an alert is raised', async () => {
  await ackOpen('tower-05', 'pump_fault'); await ackOpen('tower-05', 'low_level');
  const sim = spawn(process.execPath, [SIM, '--towers', 'tower-05', '--interval', '1', '--scenario', 'low-level'], { stdio: 'ignore' });
  try {
    const fault = await waitFor(async () => (await api('GET', '/alerts?open=1&towerId=tower-05')).body.find(a => a.type === 'pump_fault'), 20000);
    assert.ok(fault, 'pump_fault alert');
    const dev = (await api('GET', '/devices')).body.find(d => d.towerId === 'tower-05');
    assert.equal(dev.fsm, 'FAULT');
    const low = (await api('GET', '/alerts?open=1&towerId=tower-05')).body.find(a => a.type === 'low_level');
    record('I5', 'Water level below the threshold', 'Pump state machine enters FAULT, pump stopped, alert raised',
      `Node state ${dev.fsm}; alerts raised: "${fault.message}"${low ? ` and "${low.message}"` : ''}`);
  } finally { sim.kill('SIGINT'); await sleep(500); }
});

test('I6 — node powered off: the broker publishes the Last Will, device shown offline', async () => {
  await ackOpen('tower-06', 'offline');
  const sim = spawn(process.execPath, [SIM, '--towers', 'tower-06', '--interval', '1'], { stdio: 'ignore' });
  const up = await waitFor(async () => (await api('GET', '/devices')).body.find(d => d.towerId === 'tower-06' && d.online));
  assert.ok(up, 'node online first');
  const t0 = Date.now();
  sim.kill('SIGKILL');                                    // abrupt loss: no clean disconnect
  const down = await waitFor(async () => (await api('GET', '/devices')).body.find(d => d.towerId === 'tower-06' && !d.online), 20000);
  const ms = Date.now() - t0;
  assert.ok(down, 'device offline');
  const tower = (await api('GET', '/towers/tower-06')).body;
  assert.equal(tower.status, 'Offline');
  const alert = (await api('GET', '/alerts?open=1&towerId=tower-06')).body.find(a => a.type === 'offline');
  assert.ok(alert);
  record('I6', 'ESP32 powered off', 'Last Will message: device shown offline in the Devices workspace',
    `Process killed; Last Will received, node offline and tower status "Offline" after ${ms} ms; alert "${alert.message}"`, ms);
});

test('I7 — 24-hour sensor history', async () => {
  const rows = (await api('GET', '/towers/tower-01/readings?hours=24&bucket=15')).body;
  const types = [...new Set(rows.map(r => r.type))].sort();
  assert.ok(rows.length > 0);
  for (const t of ['air_temp', 'humidity', 'level', 'ph', 'water_temp']) assert.ok(types.includes(t), t);
  record('I7', 'Sensor history requested for 24 hours', 'API returns the readings of the window; chart drawn',
    `${rows.length} 15-minute averages returned for 5 sensor types (${types.join(', ')})`);
});

test('I8 — CRUD on towers and plants through the API', async () => {
  const id = 'tower-it-' + Date.now();
  let r = await api('POST', '/towers', { id, name: 'Integration Tower', location: 'Lab', modules: [{ name: 'Top Module', plants: ['basil'] }] });
  assert.equal(r.status, 201);
  r = await api('PATCH', `/towers/${id}`, { name: 'Integration Tower (renamed)', stage: 'Seedling' });
  assert.equal(r.body.name, 'Integration Tower (renamed)');
  const reread = (await api('GET', '/towers')).body.find(t => t.id === id);
  assert.equal(reread.stage, 'Seedling'); assert.deepEqual(reread.modules[0].plants, ['basil']);
  assert.equal((await api('DELETE', `/towers/${id}`)).status, 204);
  assert.equal((await api('GET', `/towers/${id}`)).status, 404);
  r = await api('POST', '/plants', { displayName: 'Test Microgreen IT', categoryGL: 'Microgreens', phMin: '5.8', phMax: '6.4' });
  assert.equal(r.status, 201);
  const pid = r.body.id;
  r = await api('PUT', `/plants/${pid}`, { ...r.body, difficulty: 'Easy' });
  assert.equal(r.body.difficulty, 'Easy');
  assert.equal((await api('DELETE', `/plants/${pid}`)).status, 204);
  record('I8', 'CRUD on towers and plants through the API', 'Changes stored in the database and visible after reload',
    'Tower created (201), renamed and modified, re-read from the database, deleted (204, then 404); plant created, updated and deleted');
});

test('S1 — security: anonymous clients refused, a node cannot publish for another tower', async () => {
  await assert.rejects(connect(undefined, undefined));
  const watcher = await connect('api', API_PWD);
  let leaked = false;
  watcher.on('message', () => { leaked = true; });
  await new Promise(r => watcher.subscribe('gltowers/main/tower-07/sensors', { qos: 1 }, r));
  const node = await connect('tower-01', DEVICE_PWD);
  node.publish('gltowers/main/tower-07/sensors', JSON.stringify({ ph: 9.9 }));
  await sleep(1500);
  assert.equal(leaked, false);
  const bad = await api('POST', '/towers/tower-01/commands', { target: 'pump', pumpOn: 500 });
  assert.equal(bad.status, 400);
  record('S1', 'Broker access control and input validation', 'Anonymous refused; tower-01 cannot publish for tower-07; invalid command rejected',
    `Anonymous connection refused; message from tower-01 to tower-07 topic dropped by the ACL; pumpOn=500 rejected with 400 ("${bad.body.error}")`);
  watcher.end(true); node.end(true);
});

after(() => {
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
});
