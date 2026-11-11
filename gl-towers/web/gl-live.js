/* GL Towers — live data layer.
 * Connects the web application to the GL Towers server (REST API + WebSocket).
 * - Served by the API (http://<server>:3000) or opened with ?api=http://<server>:3000 -> LIVE mode
 * - Opened as a local file with no server -> DEMO mode (simulated data, nothing changes)
 * The application keeps working on its local store; this layer fills that store from the API,
 * sends every change back to the API and applies the live updates pushed over the WebSocket.
 */
(function () {
  const LIVE = { enabled: false, base: '', applying: false, alerts: [], devices: [], history: {}, wsOk: false };
  window.GL_LIVE = LIVE;

  // ---------------- helpers ----------------
  function apiBase() {
    const q = new URLSearchParams(location.search).get('api');
    if (q) return q.replace(/\/$/, '');
    return location.protocol.startsWith('http') ? '' : null;
  }
  async function api(path, opts = {}) {
    const r = await fetch(LIVE.base + '/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) {
      let msg = r.status + ''; try { msg = (await r.json()).error || msg; } catch (e) { /* no body */ }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }
  const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const toast = m => { try { saveToast(m); } catch (e) { /* app not ready */ } };

  // Raw writers that only touch the browser store (used when applying server data)
  const rawSaveTowers = saveTowers;
  const rawSavePlants = savePlants;

  // ---------------- outgoing changes ----------------
  const CONFIG_FIELDS = ['name', 'location', 'status', 'stage', 'type', 'installed', 'modules'];
  const PUMP_FIELDS = ['enabled', 'pumpOn', 'pumpPause', 'start', 'end'];
  const LIGHT_FIELDS = ['enabled', 'brightness', 'start', 'end', 'photoperiod', 'preset'];
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

  function towerBody(t) {
    return { id: t.id, ...pick(t, CONFIG_FIELDS), modules: (t.modules || []).map(m => ({ name: m.name, plants: m.plants, growDays: m.growDays })),
      pump: t.pump, lighting: t.lighting, substrate: t.substrate };
  }

  async function syncTowers(prev, next) {
    const before = new Map(prev.map(t => [t.id, t]));
    const after = new Map(next.map(t => [t.id, t]));
    try {
      for (const [id, t] of after) {
        const old = before.get(id);
        if (!old) { await send('POST', '/towers', towerBody(t)); continue; }
        const patch = {};
        for (const k of CONFIG_FIELDS) if (!same(old[k], t[k])) patch[k] = k === 'modules' ? towerBody(t).modules : t[k];
        if (Object.keys(patch).length) await send('PATCH', '/towers/' + encodeURIComponent(id), patch);
        if (!same(pick(old.pump, PUMP_FIELDS), pick(t.pump, PUMP_FIELDS))) {
          await send('POST', `/towers/${encodeURIComponent(id)}/commands`, { target: 'pump', ...pick(t.pump, PUMP_FIELDS) });
          if (t.pump && t.pump.profile !== old.pump?.profile) await send('PATCH', '/towers/' + encodeURIComponent(id), { pump: t.pump });
        }
        if (!same(pick(old.lighting, LIGHT_FIELDS), pick(t.lighting, LIGHT_FIELDS))) {
          await send('POST', `/towers/${encodeURIComponent(id)}/commands`, { target: 'lighting', ...pick(t.lighting, LIGHT_FIELDS) });
        }
      }
      for (const id of before.keys()) if (!after.has(id)) await send('DELETE', '/towers/' + encodeURIComponent(id));
    } catch (e) {
      toast('Server error: ' + e.message);
      await loadTowers();
    }
  }

  async function syncPlants(prev, next) {
    const before = new Map(prev.map(p => [p.id, p]));
    const after = new Map(next.map(p => [p.id, p]));
    try {
      for (const [id, p] of after) {
        if (!before.has(id)) await send('POST', '/plants', p);
        else if (!same(before.get(id), p)) await send('PUT', '/plants/' + encodeURIComponent(id), p);
      }
      for (const id of before.keys()) if (!after.has(id)) await send('DELETE', '/plants/' + encodeURIComponent(id));
    } catch (e) { toast('Server error: ' + e.message); }
  }

  // Every change made by the application goes through these two functions
  saveTowers = function (towers) {
    const prev = getTowers();
    rawSaveTowers(towers);
    if (LIVE.enabled && !LIVE.applying) syncTowers(prev, towers);
  };
  savePlants = function (plants) {
    const prev = getPlants();
    rawSavePlants(plants);
    if (LIVE.enabled && !LIVE.applying) syncPlants(prev, plants);
  };

  // ---------------- incoming data ----------------
  function applyTowers(towers) {
    LIVE.applying = true;
    try { rawSaveTowers(towers); } finally { LIVE.applying = false; }
  }
  async function loadTowers() { applyTowers(await api('/towers')); }
  async function loadAlerts() { LIVE.alerts = await api('/alerts'); }
  async function loadDevices() { LIVE.devices = await api('/devices'); }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      const a = document.activeElement;
      const busy = document.getElementById('towerAddModal') || (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName));
      if (busy) return scheduleRender();          // never re-render while the user is typing
      const y = window.scrollY; render(); window.scrollTo(0, y);
    }, 700);
  }

  const FIELD = { ph: 'ph', level: 'reservoir', water_temp: 'waterTemp', air_temp: 'airTemp', humidity: 'humidity' };
  function onEvent(ev) {
    if (ev.type === 'reading') {
      const towers = getTowers(); const t = towers.find(x => x.id === ev.towerId); if (!t) return;
      for (const [k, v] of Object.entries(ev.values)) if (FIELD[k]) t[FIELD[k]] = k === 'level' ? Math.round(v) : v;
      if (ev.values.level != null) t.modules.forEach(m => { m.waterLevel = Math.round(ev.values.level); });
      t.lastSync = 'just now'; if (t.status === 'Offline') t.status = 'Online';
      applyTowers(towers); scheduleRender();
    } else if (ev.type === 'state') {
      const d = LIVE.devices.find(x => x.towerId === ev.towerId);
      if (d) { d.online = ev.online; d.fsm = ev.fsm || d.fsm; d.rssi = ev.rssi ?? d.rssi; d.lastSync = 'just now'; }
      const towers = getTowers(); const t = towers.find(x => x.id === ev.towerId);
      if (t && t.status !== 'Maintenance') { t.status = ev.online ? 'Online' : 'Offline'; applyTowers(towers); }
      if (!d) loadDevices().catch(() => {});
      scheduleRender();
    } else if (ev.type === 'alert') {
      LIVE.alerts.unshift(ev.alert); toast('Alert: ' + ev.alert.message); scheduleRender();
    } else if (ev.type === 'alert-ack') {
      const a = LIVE.alerts.find(x => x.id === ev.alert.id); if (a) a.ack = true; scheduleRender();
    } else if (ev.type === 'command-ack') {
      toast('Command confirmed by the tower');
    } else if (ev.type === 'tower-changed') {
      loadTowers().then(scheduleRender).catch(() => {});
    }
  }

  function connectWs() {
    const origin = LIVE.base || location.origin;
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
    ws.onopen = () => { LIVE.wsOk = true; scheduleRender(); };
    ws.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.warn('[live]', e); } };
    ws.onclose = () => { LIVE.wsOk = false; scheduleRender(); setTimeout(connectWs, 3000); };
  }

  // ---------------- live panels added to the existing pages ----------------
  const fmtTime = iso => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function liveAlertsCard() {
    const open = LIVE.alerts.filter(a => !a.ack);
    const towerName = id => (getTowers().find(t => t.id === id) || {}).name || id;
    const rows = LIVE.alerts.slice(0, 15).map(a => `<tr><td><span class="pill ${a.level === "critical" ? "red" : "orange"}">${escH(a.level)}</span></td>
      <td>${escH(towerName(a.towerId))}</td><td>${escH(a.message)}</td><td>${fmtTime(a.createdAt)}</td>
      <td>${a.ack ? '<span class="muted">Acknowledged</span>' : `<button class="btn ghost" data-live-ack="${a.id}">Acknowledge</button>`}</td></tr>`).join('');
    return `<div class="card card-pad mb live-card"><div class="section-title"><h2>Live alerts <span class="status-pill">${open.length} open</span></h2><span class="muted">From the GL Towers server</span></div>
      ${rows ? `<div class="dashboard-table-wrap"><table class="table"><thead><tr><th>Level</th><th>Tower</th><th>Message</th><th>Time</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No alert raised by the towers.</p>'}</div>`;
  }

  function liveDevicesCard() {
    const towerName = id => (getTowers().find(t => t.id === id) || {}).name || id;
    const rows = LIVE.devices.map(d => `<tr><td><b>${escH(d.id)}</b></td><td>${escH(towerName(d.towerId))}</td>
      <td>${d.online ? '<span class="pill">● Online</span>' : '<span class="pill gray">● Offline</span>'}</td><td>${escH(d.fsm || '—')}</td>
      <td>${d.rssi != null ? escH(d.rssi) + ' dBm' : '—'}</td><td>${escH(d.firmware || '—')}</td><td>${escH(d.lastSync)}</td></tr>`).join('');
    return `<div class="card card-pad mb live-card"><div class="section-title"><h2>Connected sensor nodes <span class="status-pill">${LIVE.devices.filter(d => d.online).length}/${LIVE.devices.length} online</span></h2><span class="muted">ESP32 nodes reporting over MQTT</span></div>
      ${rows ? `<div class="dashboard-table-wrap"><table class="table"><thead><tr><th>Node</th><th>Tower</th><th>Status</th><th>Pump state</th><th>Signal</th><th>Firmware</th><th>Last message</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No node has connected yet.</p>'}</div>`;
  }

  // Simple SVG line chart with real time labels
  function historyChart(rows, color, unit) {
    if (rows.length < 2) return '<p class="muted">Not enough data yet.</p>';
    const w = 760, h = 200, p = { l: 46, r: 16, t: 14, b: 30 };
    const t0 = new Date(rows[0].time).getTime(), t1 = new Date(rows[rows.length - 1].time).getTime() || t0 + 1;
    const vs = rows.map(r => Number(r.value)); let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 0.2) { lo -= 0.1; hi += 0.1; }
    const X = t => p.l + (new Date(t).getTime() - t0) / (t1 - t0 || 1) * (w - p.l - p.r);
    const Y = v => h - p.b - (v - lo) / (hi - lo) * (h - p.t - p.b);
    const path = rows.map((r, i) => (i ? 'L' : 'M') + X(r.time).toFixed(1) + ',' + Y(Number(r.value)).toFixed(1)).join(' ');
    const yl = [0, 0.5, 1].map(f => { const v = lo + f * (hi - lo); return `<text x="${p.l - 6}" y="${Y(v) + 4}" font-size="12" text-anchor="end" fill="#4b5750">${v.toFixed(1)}</text><line x1="${p.l}" x2="${w - p.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e8eeea" stroke-dasharray="2 3"/>`; }).join('');
    const xl = [0, 0.5, 1].map(f => { const t = new Date(t0 + f * (t1 - t0)); return `<text x="${p.l + f * (w - p.l - p.r)}" y="${h - 8}" font-size="12" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" fill="#4b5750">${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`; }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${yl}${xl}<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/><text x="${w - p.r}" y="${p.t}" font-size="12" text-anchor="end" fill="${color}">${escH(unit)}</text></svg>`;
  }

  function liveHistoryCard() {
    const t = selectedTower(); if (!t) return '';
    const h = LIVE.history[t.id];
    if (!h) { loadHistory(t.id); return `<div class="card card-pad mb live-card"><h2>Live history — ${escH(t.name)}</h2><p class="muted">Loading…</p></div>`; }
    const of = type => h.filter(r => r.type === type);
    const block = (title, type, color, unit) => `<div><h3 class="card-title">${title}</h3>${historyChart(of(type), color, unit)}</div>`;
    return `<div class="card card-pad mb live-card"><div class="section-title"><h2>Live history — ${escH(t.name)} <span class="status-pill">last 24 h</span></h2><span class="muted">Measured by the sensor node, 2-minute averages</span></div>
      <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">${block('pH', 'ph', '#15803d', 'pH')}${block('Reservoir level', 'level', '#2563eb', '%')}${block('Water temperature', 'water_temp', '#ea580c', '°C')}${block('Humidity', 'humidity', '#7c3aed', '%')}</div></div>`;
  }
  // Dashboard sparklines and trend chart: replace the built-in demo series (global "d") by the
  // shape of the real measurements of the selected tower, kept in the value band the chart expects.
  const DEMO = JSON.parse(JSON.stringify(d));
  const TREND_KEYS = { ph: 'ph', water: 'water_temp', air: 'air_temp', hum: 'humidity', res: 'level' };
  function resample(vals, n) {
    if (vals.length === n) return vals.slice();
    return Array.from({ length: n }, (_, i) => { const x = i * (vals.length - 1) / (n - 1), a = Math.floor(x), f = x - a; return vals[a] + ((vals[a + 1] ?? vals[a]) - vals[a]) * f; });
  }
  function applyTrends(rows) {
    for (const [key, type] of Object.entries(TREND_KEYS)) {
      const base = DEMO[key]; const vals = rows.filter(r => r.type === type).map(r => Number(r.value));
      if (vals.length < 3) { d[key] = base.slice(); continue; }
      const s = resample(vals, base.length), lo = Math.min(...s), hi = Math.max(...s);
      const bLo = Math.min(...base), bHi = Math.max(...base), mid = (bLo + bHi) / 2;
      d[key] = s.map(v => hi - lo < 1e-9 ? mid : bLo + (v - lo) / (hi - lo) * (bHi - bLo));
    }
  }
  const loadingHistory = {};
  async function loadHistory(towerId) {
    if (loadingHistory[towerId]) return; loadingHistory[towerId] = true;
    try {
      LIVE.history[towerId] = await api(`/towers/${encodeURIComponent(towerId)}/readings?hours=24&bucket=2`);
      if (selectedTower()?.id === towerId) applyTrends(LIVE.history[towerId]);
      scheduleRender();
    }
    catch (e) { LIVE.history[towerId] = []; } finally { setTimeout(() => { loadingHistory[towerId] = false; delete LIVE.history[towerId]; }, 60000); }
  }

  function wrapPage(name, card) {
    const original = pages[name];
    pages[name] = function () { return (LIVE.enabled ? card() : '') + original.apply(this, arguments); };
  }

  // Topbar: honest indicator of where the data comes from
  const previousRender = render;
  render = function () {
    previousRender();
    const sc = document.querySelector('.status-card');
    if (sc) {
      const live = LIVE.enabled;
      sc.innerHTML = `<span class="dot" style="background:${live ? (LIVE.wsOk ? '#16a34a' : '#f59e0b') : '#9ca3af'}"></span><div><b>${live ? 'Live data' : 'Demo mode'}</b><span>${live ? (LIVE.wsOk ? 'Connected to GL Towers server' : 'Reconnecting…') : 'Simulated values, no server'}</span></div>`;
    }
    const badge = document.querySelector('.icon-btn .badge');
    if (badge && LIVE.enabled) badge.textContent = String(LIVE.alerts.filter(a => !a.ack).length);
    const date = document.querySelector('.date-card .date');
    if (date && LIVE.enabled) { const n = new Date(); date.innerHTML = `${n.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}<div class="time">${n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`; }
    try { translateEverythingItalian(); } catch (e) { /* English interface */ }
  };

  // Capture phase + stopImmediatePropagation: the app opens a demo detail pop-up for any other button
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-live-ack]'); if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try { await send('PATCH', '/alerts/' + b.dataset.liveAck, { ack: true }); await loadAlerts(); render(); }
    catch (err) { toast('Server error: ' + err.message); }
  }, true);

  // ---------------- start ----------------
  async function start() {
    const base = apiBase();
    if (base === null) { render(); return; }               // opened as a file: demo mode
    LIVE.base = base;
    try {
      const health = await api('/health');
      if (!health.db) throw new Error('database unavailable');
    } catch (e) { console.info('[live] server not reachable, demo mode'); render(); return; }
    LIVE.enabled = true;
    wrapPage('alerts', liveAlertsCard);
    wrapPage('devices', liveDevicesCard);
    wrapPage('sensors', liveHistoryCard);
    wrapPage('dashboard', () => {                       // keep the dashboard trends in sync with the selected tower
      const t = selectedTower(); if (!t) return '';
      if (LIVE.history[t.id]) applyTrends(LIVE.history[t.id]); else loadHistory(t.id);
      return '';
    });
    await Promise.all([
      loadTowers(),
      api('/plants').then(list => { if (list.length) { LIVE.applying = true; rawSavePlants(list); LIVE.applying = false; } }),
      loadAlerts(), loadDevices(),
    ]).catch(e => toast('Server error: ' + e.message));
    connectWs();
    render();
    setInterval(() => { Promise.all([loadTowers(), loadDevices(), loadAlerts()]).then(scheduleRender).catch(() => {}); }, 30000);
  }
  start();
})();
