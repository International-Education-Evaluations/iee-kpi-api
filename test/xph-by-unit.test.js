const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeXphByUnit } = require('../lib/segment-aggregations');

// Helper to build a segment quickly for tests.
function seg({ xphUnit = 'Orders', unitValue = 1, durationMinutes = 60 } = {}) {
  return { xphUnit, unitValue, durationMinutes };
}

test('pure-Orders worker reports dominant: orders', () => {
  const segs = [
    seg({ xphUnit: 'Orders', unitValue: 1, durationMinutes: 30 }),
    seg({ xphUnit: 'Orders', unitValue: 1, durationMinutes: 30 }),
  ];
  const r = computeXphByUnit(segs);
  assert.equal(r.dominant, 'orders');
  assert.equal(r.orders.units, 2);
  assert.equal(r.orders.hours, 1);
  assert.equal(r.orders.xph, 2);
  assert.equal(r.reports.xph, null);
  assert.equal(r.credentials.xph, null);
});

test('pure-Reports worker (Eval team) reports dominant: reports', () => {
  const segs = [
    seg({ xphUnit: 'Reports', unitValue: 5, durationMinutes: 60 }),
    seg({ xphUnit: 'Reports', unitValue: 3, durationMinutes: 60 }),
  ];
  const r = computeXphByUnit(segs);
  assert.equal(r.dominant, 'reports');
  assert.equal(r.reports.units, 8);
  assert.equal(r.reports.hours, 2);
  assert.equal(r.reports.xph, 4);
});

test('pure-Credentials worker (Data Entry) reports dominant: credentials', () => {
  const segs = [
    seg({ xphUnit: 'Credentials', unitValue: 12, durationMinutes: 240 }),
  ];
  const r = computeXphByUnit(segs);
  assert.equal(r.dominant, 'credentials');
  assert.equal(r.credentials.units, 12);
  assert.equal(r.credentials.hours, 4);
  assert.equal(r.credentials.xph, 3);
});

test('Elena scenario: 154 Orders + 1 Reports → dominant: orders, not mislabeled', () => {
  // Pre-fix bug: the dashboard summed 154 + 1 = 155 mixed units and labeled the
  // card as "Reports" (first non-Orders unit found). After fix, dominant is
  // chosen by largest unit count, and per-unit XpH is reported separately.
  const segs = [];
  for (let i = 0; i < 154; i++) segs.push(seg({ xphUnit: 'Orders', unitValue: 1, durationMinutes: 41 }));
  segs.push(seg({ xphUnit: 'Reports', unitValue: 1, durationMinutes: 81 }));

  const r = computeXphByUnit(segs);
  assert.equal(r.dominant, 'orders');
  assert.equal(r.orders.units, 154);
  // 154 segs * 41 min = 6314 min = 105.23h ≈ 105.2 (rounded to 1dp)
  assert.equal(r.orders.hours, 105.2);
  // 154 / 105.2 ≈ 1.464 → 1.5
  assert.equal(r.orders.xph, 1.5);
  assert.equal(r.reports.units, 1);
  assert.equal(r.reports.xph, 0.7); // 1 / (81/60) = 1/1.35 = 0.74
});

test('zero-duration segments are skipped (matches caller filter)', () => {
  const r = computeXphByUnit([
    seg({ xphUnit: 'Orders', unitValue: 1, durationMinutes: 0 }),
    seg({ xphUnit: 'Orders', unitValue: 5, durationMinutes: -10 }),
  ]);
  assert.equal(r.orders.units, 0);
  assert.equal(r.orders.hours, 0);
  assert.equal(r.orders.xph, null);
  assert.equal(r.dominant, 'orders'); // default fallback
});

test('returns finite xph or null — never Infinity', () => {
  const r = computeXphByUnit([
    seg({ xphUnit: 'Orders', unitValue: 100, durationMinutes: 0 }),
  ]);
  assert.equal(r.orders.xph, null);
  assert.notEqual(r.orders.xph, Infinity);
});

test('unknown xphUnit values are silently dropped (not counted)', () => {
  const r = computeXphByUnit([
    seg({ xphUnit: 'Orders', unitValue: 2, durationMinutes: 60 }),
    seg({ xphUnit: 'Bananas', unitValue: 99, durationMinutes: 60 }),
  ]);
  assert.equal(r.orders.units, 2);
  assert.equal(r.dominant, 'orders');
});

test('empty input returns zeros and dominant: orders', () => {
  const r = computeXphByUnit([]);
  assert.equal(r.dominant, 'orders');
  assert.equal(r.orders.xph, null);
  assert.equal(r.reports.xph, null);
  assert.equal(r.credentials.xph, null);
});

test('non-array input returns the same shape', () => {
  const r = computeXphByUnit(null);
  assert.equal(r.dominant, 'orders');
  assert.equal(r.orders.units, 0);
});
