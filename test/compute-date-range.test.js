const { test } = require('node:test');
const assert = require('node:assert/strict');

let m;
test.before(async () => { m = await import('../client/src/lib/classify-segment.js'); });

test('from-only range ends today so gap-day detection still runs', () => {
  const r = m.computeDateRange({ from: '2026-07-08', to: '', segments: [], now: new Date('2026-10-05T12:00:00Z') });
  assert.equal(r.fromIso, '2026-07-08');
  assert.equal(r.toIso, '2026-10-05');
});

test('from-only range finds the missing day', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const segs = [{ segmentStart: '2026-10-03T09:00:00Z' }, { segmentStart: '2026-10-05T09:00:00Z' }];
  const r = m.computeDateRange({ from: '2026-10-03', to: '', segments: segs, now });
  assert.deepEqual(m.findGapDays(segs, r.fromIso, r.toIso), ['2026-10-04']);
});

test('from-only range ends at the last data day, not today, so today is not a false gap', () => {
  const segs = [{ segmentStart: '2026-09-18T09:00:00Z' }, { segmentStart: '2026-09-20T09:00:00Z' }];
  const r = m.computeDateRange({ from: '2026-09-18', to: '', segments: segs, now: new Date('2026-10-05T01:00:00Z') });
  assert.equal(r.toIso, '2026-09-20');
});

test('explicit from + to is unchanged', () => {
  const r = m.computeDateRange({ from: '2026-07-08', to: '2026-08-01', segments: [] });
  assert.equal(r.toIso, '2026-08-01');
});
