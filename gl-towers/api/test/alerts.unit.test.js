// Unit tests of the alert rules (no database needed): node --test test/alerts.unit.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRange, rangesFor, evaluateReading } = require('../src/alerts');

const basil = { phMin: '5.5', phMax: '6.5', waterTempRangeC: '20–22' };
const lettuce = { phMin: '5.8', phMax: '6.2', waterTempRangeC: '18–22' };
const blueberry = { phMin: '4.5', phMax: '5.5', waterTempRangeC: '18-21' };

test('parseRange reads "20–22" and "18-21"', () => {
  assert.deepEqual(parseRange('20–22'), [20, 22]);
  assert.deepEqual(parseRange('18-21'), [18, 21]);
  assert.equal(parseRange('n/a'), null);
});

test('target range = average of the minimums and maximums of the plants', () => {
  const r = rangesFor([basil, lettuce]);
  assert.deepEqual(r.ph, [5.7, 6.4]);
  assert.deepEqual(r.waterTemp, [19, 22]);
  assert.deepEqual(rangesFor([lettuce, blueberry]).ph, [5.2, 5.9]);
});

test('without plants, default ranges are used', () => {
  assert.deepEqual(rangesFor([]).ph, [5.5, 6.5]);
  assert.deepEqual(rangesFor([]).waterTemp, [18, 24]);
});

test('rules: pH (with tolerance), low level and water temperature', () => {
  const r = rangesFor([basil]);                     // pH 5.5–6.5, water 20–22 °C
  assert.equal(evaluateReading({ ph: 6.0, level: 80, water_temp: 21 }, r, 'T').length, 0);
  assert.equal(evaluateReading({ ph: 6.6, water_temp: 22.8 }, r, 'T').length, 0);   // inside tolerance
  const ph = evaluateReading({ ph: 6.8 }, r, 'T')[0];
  assert.equal(ph.type, 'ph_range'); assert.equal(ph.level, 'warning');
  assert.equal(evaluateReading({ ph: 7.4 }, r, 'T')[0].level, 'critical');
  assert.equal(evaluateReading({ level: 12 }, r, 'T')[0].type, 'low_level');
  assert.equal(evaluateReading({ water_temp: 25 }, r, 'T')[0].type, 'water_temp');
});
