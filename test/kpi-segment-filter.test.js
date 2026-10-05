const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildKpiSegmentFilter } = require('../lib/kpi-segment-filter');

test('no params → empty filter (legacy callers unchanged)', () => {
  assert.deepEqual(buildKpiSegmentFilter({}), {});
});

test('from/to map to segmentStart range, to is end-of-day', () => {
  assert.deepEqual(buildKpiSegmentFilter({ from: '2026-07-08', to: '2026-10-05' }), {
    segmentStart: { $gte: '2026-07-08', $lte: '2026-10-05T23:59:59' },
  });
});

test('equality filters pass through', () => {
  assert.deepEqual(
    buildKpiSegmentFilter({ orderType: 'Evaluation', workerEmail: 'a@b.c', workerUserId: 'x1', statusSlug: 'qc' }),
    { orderType: 'Evaluation', workerEmail: 'a@b.c', workerUserId: 'x1', statusSlug: 'qc' },
  );
});

test('includeOpen=1 with a date range also returns open segments outside it', () => {
  assert.deepEqual(buildKpiSegmentFilter({ from: '2026-07-08', includeOpen: '1', orderType: 'Evaluation' }), {
    orderType: 'Evaluation',
    $or: [{ segmentStart: { $gte: '2026-07-08' } }, { isOpen: true }],
  });
});

test('includeOpen without a date range adds nothing', () => {
  assert.deepEqual(buildKpiSegmentFilter({ includeOpen: '1' }), {});
});

test('non-string params reject the whole request (operator injection, repeated params)', () => {
  assert.equal(buildKpiSegmentFilter({ from: { $ne: null } }), null);
  assert.equal(buildKpiSegmentFilter({ orderType: ['a', 'b'] }), null);
  assert.equal(buildKpiSegmentFilter({ workerEmail: { $gt: '' }, from: '2026-07-08' }), null);
});

test('unrelated non-string params (page, cb) do not reject', () => {
  assert.deepEqual(buildKpiSegmentFilter({ cb: ['1', '2'], from: '2026-07-08' }), {
    segmentStart: { $gte: '2026-07-08' },
  });
});
