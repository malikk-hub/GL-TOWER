// REST API routes (mounted on /api)
const express = require('express');
const db = require('./db');
const bridge = require('./mqttBridge');
const realtime = require('./realtime');

const router = express.Router();
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };

function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ---------------- validation ----------------
function checkPump(p) {
  if (typeof p !== 'object' || !p) bad('pump must be an object');
  if (p.pumpOn !== undefined && !(Number(p.pumpOn) > 0 && Number(p.pumpOn) <= 60)) bad('pumpOn must be between 0 and 60 minutes');
  if (p.pumpPause !== undefined && !(Number(p.pumpPause) >= 1 && Number(p.pumpPause) <= 1440)) bad('pumpPause must be between 1 and 1440 minutes');
  for (const k of ['start', 'end']) if (p[k] !== undefined && !HHMM.test(p[k])) bad(`pump.${k} must be HH:MM`);
}
function checkLighting(l) {
  if (typeof l !== 'object' || !l) bad('lighting must be an object');
  if (l.brightness !== undefined && !(Number(l.brightness) >= 0 && Number(l.brightness) <= 100)) bad('brightness must be between 0 and 100');
  if (l.photoperiod !== undefined && !(Number(l.photoperiod) >= 0 && Number(l.photoperiod) <= 24)) bad('photoperiod must be between 0 and 24 h');
  for (const k of ['start', 'end']) if (l[k] !== undefined && !HHMM.test(l[k])) bad(`lighting.${k} must be HH:MM`);
}
function checkTower(t, creating) {
  if (creating && !t.name) bad('name is required');
  if (t.name !== undefined && (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60)) bad('name must be 1-60 characters');
  if (t.status !== undefined && !['Online', 'Offline', 'Maintenance'].includes(t.status)) bad('status must be Online, Offline or Maintenance');
  if (t.pump !== undefined) checkPump(t.pump);
  if (t.lighting !== undefined) checkLighting(t.lighting);
  if (t.modules !== undefined && (!Array.isArray(t.modules) || t.modules.length > 12)) bad('modules must be an array (max 12)');
}

// ---------------- health ----------------
router.get('/health', wrap(async (req, res) => {
  let dbOk = false; try { dbOk = await db.ping(); } catch { /* reported below */ }
  res.status(dbOk && bridge.isConnected() ? 200 : 503).json({ status: dbOk && bridge.isConnected() ? 'ok' : 'degraded', db: dbOk, mqtt: bridge.isConnected() });
}));

// ---------------- towers ----------------
router.get('/towers', wrap(async (req, res) => res.json(await db.listTowers())));

router.post('/towers', wrap(async (req, res) => {
  const t = req.body || {}; checkTower(t, true);
  t.id = t.id ? slug(t.id) : `tower-${slug(t.name)}`;
  if (!t.id) bad('invalid id');
  if (await db.towerExists(t.id)) throw new HttpError(409, `tower ${t.id} already exists`);
  const created = await db.createTower(t);
  realtime.broadcast({ type: 'tower-changed', towerId: created.id, action: 'created' });
  res.status(201).json(created);
}));

router.get('/towers/:id', wrap(async (req, res) => {
  const t = await db.getTower(req.params.id);
  if (!t) throw new HttpError(404, 'tower not found');
  res.json(t);
}));

router.patch('/towers/:id', wrap(async (req, res) => {
  checkTower(req.body || {}, false);
  const t = await db.updateTower(req.params.id, req.body || {});
  if (!t) throw new HttpError(404, 'tower not found');
  realtime.broadcast({ type: 'tower-changed', towerId: t.id, action: 'updated' });
  res.json(t);
}));

router.delete('/towers/:id', wrap(async (req, res) => {
  if (!(await db.deleteTower(req.params.id))) throw new HttpError(404, 'tower not found');
  realtime.broadcast({ type: 'tower-changed', towerId: req.params.id, action: 'deleted' });
  res.status(204).end();
}));

router.get('/towers/:id/readings', wrap(async (req, res) => {
  if (!(await db.towerExists(req.params.id))) throw new HttpError(404, 'tower not found');
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 90);
  const bucket = req.query.bucket ? Math.min(Math.max(Number(req.query.bucket), 1), 1440) : undefined;
  res.json(await db.readings(req.params.id, { type: req.query.type, hours, bucketMinutes: bucket }));
}));

// Sends a pump or lighting command to the tower and stores it as the desired configuration
router.post('/towers/:id/commands', wrap(async (req, res) => {
  const tower = await db.getTower(req.params.id);
  if (!tower) throw new HttpError(404, 'tower not found');
  const { target, ...settings } = req.body || {};
  if (target === 'pump') checkPump(settings);
  else if (target === 'lighting') checkLighting(settings);
  else bad('target must be "pump" or "lighting"');
  const { action, ...config } = settings;            // "action" (e.g. reset) is not a stored setting
  if (action !== undefined && !(target === 'pump' && action === 'reset')) bad('unknown action');
  if (Object.keys(config).length) await db.updateTower(tower.id, { [target]: { ...tower[target], ...config } });
  const cmdId = bridge.sendCommand(tower.id, { target, ...settings });
  res.status(202).json({ cmdId, status: 'sent', deviceOnline: !!tower.device?.online });
}));

router.get('/commands/:cmdId', (req, res) => {
  const c = bridge.commandStatus(req.params.cmdId);
  if (!c) return res.status(404).json({ error: 'command not found' });
  res.json(c);
});

// ---------------- plants ----------------
router.get('/plants', wrap(async (req, res) => res.json(await db.listPlants())));

function plantFromBody(body, id) {
  const p = { ...body, id };
  if (!p.displayName || typeof p.displayName !== 'string') bad('displayName is required');
  if (p.phMin !== undefined && p.phMax !== undefined && Number(p.phMin) > Number(p.phMax)) bad('phMin must be lower than phMax');
  return p;
}
router.post('/plants', wrap(async (req, res) => {
  const id = slug(req.body?.id || req.body?.displayName || '');
  if (!id) bad('displayName is required');
  if (await db.getPlant(id)) throw new HttpError(409, `plant ${id} already exists`);
  res.status(201).json(await db.upsertPlant(plantFromBody(req.body, id)));
}));
router.put('/plants/:id', wrap(async (req, res) => {
  if (!(await db.getPlant(req.params.id))) throw new HttpError(404, 'plant not found');
  res.json(await db.upsertPlant(plantFromBody(req.body, req.params.id)));
}));
router.delete('/plants/:id', wrap(async (req, res) => {
  if (!(await db.deletePlant(req.params.id))) throw new HttpError(404, 'plant not found');
  res.status(204).end();
}));

// ---------------- alerts & devices ----------------
router.get('/alerts', wrap(async (req, res) => {
  res.json(await db.listAlerts({ open: req.query.open === '1' || req.query.open === 'true', towerId: req.query.towerId }));
}));
router.patch('/alerts/:id', wrap(async (req, res) => {
  if (req.body?.ack !== true) bad('only {"ack": true} is supported');
  const a = await db.ackAlert(Number(req.params.id));
  if (!a) throw new HttpError(404, 'alert not found');
  realtime.broadcast({ type: 'alert-ack', alert: a });
  res.json(a);
}));
router.get('/devices', wrap(async (req, res) => res.json(await db.listDevices())));

// ---------------- errors ----------------
router.use((req, res) => res.status(404).json({ error: 'not found' }));
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error('[api]', err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = router;
