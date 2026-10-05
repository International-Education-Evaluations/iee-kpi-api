const { test } = require('node:test');
const assert = require('node:assert/strict');

let m;
test.before(async () => { m = await import('../client/src/lib/kpi-window.js'); });

test('default from is 89 days back → 90-day inclusive window', () => {
  assert.equal(m.KPI_DEFAULT_DAYS, 90);
  assert.equal(m.defaultKpiFrom(new Date('2026-10-05T12:00:00Z')), '2026-07-08');
});

test('widening (earlier from) needs a refetch', () => {
  assert.equal(m.needsKpiRefetch('2026-07-08', '2026-03-01'), true);
});

test('narrowing or same from does not', () => {
  assert.equal(m.needsKpiRefetch('2026-07-08', '2026-07-08'), false);
  assert.equal(m.needsKpiRefetch('2026-07-08', '2026-09-01'), false);
});

test('empty From (cleared or half-typed date input) never triggers a fetch', () => {
  assert.equal(m.needsKpiRefetch('2026-07-08', ''), false);
});

test('isKpiDate accepts only full YYYY-MM-DD dates from 2000 on', () => {
  assert.equal(m.isKpiDate('2026-07-08'), true);
  assert.equal(m.isKpiDate(''), false);
  assert.equal(m.isKpiDate('0202-10-05'), false);
  assert.equal(m.isKpiDate('2026-7-1'), false);
  assert.equal(m.isKpiDate(undefined), false);
});

test('kpiFetchFrom: a real From date wins', () => {
  assert.equal(m.kpiFetchFrom('2026-03-01', '', '2026-07-08'), '2026-03-01');
  assert.equal(m.kpiFetchFrom('2026-03-01', '2026-04-01', '2026-07-08'), '2026-03-01');
});

test('kpiFetchFrom: empty or half-typed From keeps the loaded window', () => {
  assert.equal(m.kpiFetchFrom('', '', '2026-07-08'), '2026-07-08');
  assert.equal(m.kpiFetchFrom('0020-01-01', '', '2026-07-08'), '2026-07-08');
});

test('kpiFetchFrom: empty From + To older than the window → 90 days ending at To', () => {
  assert.equal(m.kpiFetchFrom('', '2026-05-31', '2026-07-08'), '2026-03-03');
});

test('kpiFetchFrom: empty From + To inside the window keeps the window', () => {
  assert.equal(m.kpiFetchFrom('', '2026-09-01', '2026-07-08'), '2026-07-08');
  assert.equal(m.kpiFetchFrom('', '2026-9-1', '2026-07-08'), '2026-07-08');
});

test('nothing more to fetch once all history is loaded', () => {
  assert.equal(m.needsKpiRefetch('', '2025-01-01'), false);
  assert.equal(m.needsKpiRefetch('', ''), false);
});

test('half-typed or malformed dates never trigger a fetch', () => {
  assert.equal(m.needsKpiRefetch('2026-07-08', '0002-10-05'), false);
  assert.equal(m.needsKpiRefetch('2026-07-08', '0202-10-05'), false);
  assert.equal(m.needsKpiRefetch('2026-07-08', '2026-7-1'), false);
  assert.equal(m.needsKpiRefetch('2026-07-08', undefined), false);
});

test('path includes from + includeOpen only when bounded', () => {
  assert.equal(
    m.kpiSegmentsPath({ page: 2, from: '2026-07-08', cb: 7 }),
    '/data/kpi-segments?page=2&pageSize=10000&drilldown=1&from=2026-07-08&includeOpen=1&cb=7',
  );
  assert.equal(
    m.kpiSegmentsPath({ page: 1, from: '', cb: 7 }),
    '/data/kpi-segments?page=1&pageSize=10000&drilldown=1&cb=7',
  );
});
