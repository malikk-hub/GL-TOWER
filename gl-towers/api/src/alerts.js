// Alert engine: compares each new reading with the needs of the plants grown on the tower.
const db = require('./db');

const DEFAULTS = { ph: [5.5, 6.5], waterTemp: [18, 24] };
const LOW_LEVEL_PERCENT = 20;
// Tolerance outside the target range before an alert is raised (avoids alerts on sensor noise)
const TOLERANCE = { ph: 0.2, waterTemp: 1.0 };

// "20–22" or "20-22" -> [20, 22]
function parseRange(text) {
  if (text == null) return null;
  const parts = String(text).split(/[–-]/).map(s => parseFloat(s));
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : null;
}

// Target range of a tower = average of the minimums and of the maximums of its plants.
// (A strict intersection becomes too narrow when several species share the same water.)
function targetRange(plants, pick, fallback) {
  const ranges = plants.map(pick).filter(Boolean);
  if (!ranges.length) return fallback;
  const avg = xs => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length * 10) / 10;
  const lo = avg(ranges.map(r => r[0])), hi = avg(ranges.map(r => r[1]));
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function rangesFor(plants) {
  return {
    ph: targetRange(plants, p => {
      const a = parseFloat(p.phMin), b = parseFloat(p.phMax);
      return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
    }, DEFAULTS.ph),
    waterTemp: targetRange(plants, p => parseRange(p.waterTempRangeC), DEFAULTS.waterTemp),
  };
}

// Pure rule evaluation (unit-testable): returns the alerts a reading should raise.
function evaluateReading(values, ranges, towerName) {
  const out = [];
  const out_ = (v, [lo, hi], tol) => v < lo - tol || v > hi + tol;
  if (values.ph != null && out_(values.ph, ranges.ph, TOLERANCE.ph)) {
    const far = values.ph < ranges.ph[0] - 0.7 || values.ph > ranges.ph[1] + 0.7;
    out.push({ type: 'ph_range', level: far ? 'critical' : 'warning', value: values.ph,
      message: `pH ${values.ph} out of range on ${towerName} (target ${ranges.ph[0]}–${ranges.ph[1]})` });
  }
  if (values.level != null && values.level < LOW_LEVEL_PERCENT) {
    out.push({ type: 'low_level', level: 'critical', value: values.level,
      message: `Reservoir low on ${towerName}: ${Math.round(values.level)}% — refill required` });
  }
  if (values.water_temp != null && out_(values.water_temp, ranges.waterTemp, TOLERANCE.waterTemp)) {
    out.push({ type: 'water_temp', level: 'warning', value: values.water_temp,
      message: `Water temperature ${values.water_temp} °C out of range on ${towerName} (target ${ranges.waterTemp[0]}–${ranges.waterTemp[1]} °C)` });
  }
  return out;
}

// Creates the alerts in the database (one open alert per tower and type) and returns the new ones.
async function raise(towerId, candidates) {
  const created = [];
  for (const c of candidates) {
    if (await db.openAlertExists(towerId, c.type)) continue;
    created.push(await db.createAlert({ towerId, ...c }));
  }
  return created;
}

async function checkReading(tower, values) {
  const plants = await db.plantsOfTower(tower.id);
  return raise(tower.id, evaluateReading(values, rangesFor(plants), tower.name));
}

module.exports = { parseRange, rangesFor, evaluateReading, raise, checkReading, LOW_LEVEL_PERCENT, TOLERANCE };
