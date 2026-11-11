#!/usr/bin/env node
// GL Towers node simulator.
// Behaves like the ESP32 firmware (firmware/gl_tower_node): same topics, same JSON messages,
// same pump state machine (IDLE -> PUMP_ON <-> PUMP_OFF, FAULT on low water) and same Last Will.
//
// Usage:
//   node simulate.js --towers tower-01,tower-02 [--interval 5] [--speed 60] [--scenario normal|ph-high|low-level]
//   environment: MQTT_URL (default mqtt://localhost:1883), DEVICE_PASSWORD (default node-dev-pass)
//
// --speed 60 means one simulated minute lasts one real second (pump cycles become visible quickly).

const mqtt = require('mqtt');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const TOWERS = (args.towers || 'tower-01').split(',');
const INTERVAL_S = Number(args.interval || 5);
const SPEED = Number(args.speed || 60);
const SCENARIO = args.scenario || 'normal';
const URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const PASSWORD = process.env.DEVICE_PASSWORD || 'node-dev-pass';
const SITE = process.env.MQTT_SITE || 'main';
const FW = '1.0.0';
const LOW_LEVEL_FAULT = 15; // % — same threshold as the firmware

function createNode(towerId, index) {
  const base = `gltowers/${SITE}/${towerId}`;
  const node = {
    towerId, fsm: 'IDLE', fsmSince: Date.now(), lastCmdId: null,
    level: SCENARIO === 'low-level' ? 22 : 90 - index * 3,
    ph: SCENARIO === 'ph-high' ? 7.4 : 6.0, waterTemp: 20.5, airTemp: 23, humidity: 70,
    pump: { enabled: true, pumpOn: 1, pumpPause: 90, start: '06:00', end: '22:00' },
    lighting: { enabled: true, brightness: 70, start: '06:00', end: '22:00', photoperiod: 16 },
    rssi: -55 - index * 4,
  };

  const client = mqtt.connect(URL, {
    clientId: `sim-${towerId}`, username: towerId, password: PASSWORD, clean: false, reconnectPeriod: 2000,
    will: { topic: `${base}/state`, payload: JSON.stringify({ online: false }), qos: 1, retain: true },
  });

  const publishState = () => client.publish(`${base}/state`, JSON.stringify({
    online: true, fw: FW, rssi: node.rssi, fsm: node.fsm,
    pump: node.pump, lighting: node.lighting, ...(node.lastCmdId ? { cmdId: node.lastCmdId } : {}),
  }), { qos: 1, retain: true });
  const setFsm = state => { if (node.fsm !== state) { node.fsm = state; node.fsmSince = Date.now(); publishState(); log(`state -> ${state}`); } };
  const log = m => console.log(`[${towerId}] ${m}`);

  client.on('connect', () => {
    log('connected');
    client.subscribe(`${base}/cmd`, { qos: 1 });
    publishState();
  });
  client.on('error', e => log(`error: ${e.message}`));

  client.on('message', (t, payload) => {
    let cmd; try { cmd = JSON.parse(payload.toString()); } catch { return; }
    log(`command received: ${payload}`);
    if (cmd.target === 'pump') {
      if (cmd.action === 'reset' && node.fsm === 'FAULT' && node.level >= LOW_LEVEL_FAULT) setFsm('IDLE');
      for (const k of ['enabled', 'pumpOn', 'pumpPause', 'start', 'end']) if (cmd[k] !== undefined) node.pump[k] = cmd[k];
      if (!node.pump.enabled && node.fsm !== 'FAULT') setFsm('IDLE');
    } else if (cmd.target === 'lighting') {
      for (const k of ['enabled', 'brightness', 'start', 'end', 'photoperiod']) if (cmd[k] !== undefined) node.lighting[k] = cmd[k];
    }
    node.lastCmdId = cmd.cmdId || null;
    publishState(); // confirms the command (cmdId echoed back)
  });

  // Pump state machine (same transitions as the firmware), evaluated every second (simulated minutes = real seconds * SPEED / 60)
  setInterval(() => {
    const minutesInState = (Date.now() - node.fsmSince) / 60000 * SPEED;
    if (node.level < LOW_LEVEL_FAULT && node.fsm !== 'FAULT') return setFsm('FAULT');
    const allowed = node.pump.enabled && inWindow(node.pump.start, node.pump.end);
    if (node.fsm === 'IDLE' && allowed) setFsm('PUMP_ON');
    else if (node.fsm === 'PUMP_ON') {
      node.level = Math.max(0, node.level - 0.05 * SPEED / 60);
      if (!allowed || minutesInState >= node.pump.pumpOn) setFsm('PUMP_OFF');
    } else if (node.fsm === 'PUMP_OFF') {
      if (!node.pump.enabled) setFsm('IDLE');
      else if (allowed && minutesInState >= node.pump.pumpPause) setFsm('PUMP_ON');
    }
  }, 1000);

  // Sensor acquisition and publication
  setInterval(() => {
    const t = Date.now() / 60000;
    node.ph = SCENARIO === 'ph-high' ? clamp(node.ph + (Math.random() - 0.5) * 0.04, 4, 9)
      : clamp(node.ph + (6.0 - node.ph) * 0.05 + (Math.random() - 0.5) * 0.04, 4, 9);   // regulated around pH 6.0
    node.waterTemp = 20.5 + Math.sin(t / 30 + index) * 0.6 + (Math.random() - 0.5) * 0.1;
    node.airTemp = 23 + Math.sin(t / 25 + index) * 1.2 + (Math.random() - 0.5) * 0.2;
    node.humidity = clamp(70 + Math.sin(t / 40 + index) * 4 + (Math.random() - 0.5), 30, 95);
    if (SCENARIO === 'low-level') node.level = Math.max(0, node.level - 1.5);
    const msg = { ts: new Date().toISOString(), ph: r1(node.ph, 2), level: Math.round(node.level),
      waterTemp: r1(node.waterTemp, 1), airTemp: r1(node.airTemp, 1), humidity: Math.round(node.humidity) };
    client.publish(`${base}/sensors`, JSON.stringify(msg), { qos: 0 });
  }, INTERVAL_S * 1000);

  return { client, node };
}

// Same rule as the firmware: inside [start, end), windows may cross midnight
function inWindow(start, end) {
  const now = new Date(); const m = now.getHours() * 60 + now.getMinutes();
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(start), e = toMin(end);
  return s <= e ? (m >= s && m < e) : (m >= s || m < e);
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

const nodes = TOWERS.map(createNode);
console.log(`Simulating ${nodes.length} tower(s) on ${URL} — interval ${INTERVAL_S}s, speed x${SPEED}, scenario ${SCENARIO}`);

// Ctrl+C: clean disconnect (publishes offline like a normal shutdown).
// Kill -9 instead to test the Last Will (the broker publishes it).
process.on('SIGINT', () => {
  for (const { client, node } of nodes) client.publish(`gltowers/${SITE}/${node.towerId}/state`, JSON.stringify({ online: false }), { qos: 1, retain: true });
  setTimeout(() => process.exit(0), 300);
});
