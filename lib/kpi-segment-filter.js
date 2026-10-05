// Mongo filter for GET /data/kpi-segments. Pulled out of server.js so the
// date-window + open-segment rules are unit-testable. Express parses
// `?from[$ne]=x` into an object and `?orderType=a&orderType=b` into an array;
// either returns null (caller sends 400) rather than reaching the query or
// silently dropping the filter and returning the whole collection.
const EQUALITY_FIELDS = ['orderType', 'workerEmail', 'workerUserId', 'statusSlug'];
const FILTER_FIELDS = [...EQUALITY_FIELDS, 'from', 'to', 'includeOpen'];

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function buildKpiSegmentFilter(query = {}) {
  if (FILTER_FIELDS.some(f => query[f] !== undefined && typeof query[f] !== 'string')) return null;
  const filter = {};
  for (const field of EQUALITY_FIELDS) {
    const v = str(query[field]);
    if (v) filter[field] = v;
  }

  const from = str(query.from);
  const to = str(query.to);
  if (!from && !to) return filter;

  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to + 'T23:59:59';

  // Open segments that started before the window still matter (stuck-order
  // alerts), so the dashboard asks for them alongside the dated slice.
  if (query.includeOpen === '1') {
    filter.$or = [{ segmentStart: range }, { isOpen: true }];
  } else {
    filter.segmentStart = range;
  }
  return filter;
}

module.exports = { buildKpiSegmentFilter };
