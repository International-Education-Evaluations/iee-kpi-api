const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sumOrderLevelField } = require('../lib/segment-aggregations');

test('sums field once per distinct orderSerialNumber', () => {
  // Worker touched order ABC in 3 segments (5 reports each); order DEF in 2 (3 each).
  // Expected: 5 + 3 = 8 (not 15 + 6 = 21).
  const segments = [
    { orderSerialNumber: 'ABC', reportItemCount: 5 },
    { orderSerialNumber: 'ABC', reportItemCount: 5 },
    { orderSerialNumber: 'ABC', reportItemCount: 5 },
    { orderSerialNumber: 'DEF', reportItemCount: 3 },
    { orderSerialNumber: 'DEF', reportItemCount: 3 },
  ];
  assert.equal(sumOrderLevelField(segments, 'reportItemCount'), 8);
});

test('treats missing/undefined field values as 0', () => {
  const segments = [
    { orderSerialNumber: 'A', reportItemCount: 4 },
    { orderSerialNumber: 'B' },                             // missing
    { orderSerialNumber: 'C', reportItemCount: undefined },
    { orderSerialNumber: 'D', reportItemCount: null },
  ];
  assert.equal(sumOrderLevelField(segments, 'reportItemCount'), 4);
});

test('skips segments without an orderSerialNumber', () => {
  const segments = [
    { orderSerialNumber: 'A', reportItemCount: 2 },
    { reportItemCount: 99 },                  // no order ID
    { orderSerialNumber: '',  reportItemCount: 99 },
  ];
  assert.equal(sumOrderLevelField(segments, 'reportItemCount'), 2);
});

test('returns 0 for empty / non-array input', () => {
  assert.equal(sumOrderLevelField([], 'reportItemCount'), 0);
  assert.equal(sumOrderLevelField(null, 'reportItemCount'), 0);
  assert.equal(sumOrderLevelField(undefined, 'reportItemCount'), 0);
});

test('takes the first-seen value per order (caller dedupes upstream)', () => {
  // If the same order somehow has divergent values across segments, the helper
  // takes the first-seen one rather than max/sum. Server-side both fields are
  // identical per order, so this only matters for malformed data.
  const segments = [
    { orderSerialNumber: 'A', reportItemCount: 5 },
    { orderSerialNumber: 'A', reportItemCount: 99 },
  ];
  assert.equal(sumOrderLevelField(segments, 'reportItemCount'), 5);
});

test('works for credentialCount the same way', () => {
  const segments = [
    { orderSerialNumber: 'A', credentialCount: 7 },
    { orderSerialNumber: 'A', credentialCount: 7 },
    { orderSerialNumber: 'B', credentialCount: 4 },
  ];
  assert.equal(sumOrderLevelField(segments, 'credentialCount'), 11);
});
