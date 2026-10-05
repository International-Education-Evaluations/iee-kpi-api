// Default KPI date window + the rule for when a range change must go back to
// the server. Shared range lives in DataProvider; this file stays pure so it
// can be unit-tested from the root node:test suite.

export const KPI_DEFAULT_DAYS = 90;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function minusWindow(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - (KPI_DEFAULT_DAYS - 1));
  return x.toISOString().slice(0, 10);
}

// Same UTC YYYY-MM-DD convention as DatePresets in components/UI.jsx.
export function defaultKpiFrom(now = new Date()) {
  return minusWindow(now);
}

// Full YYYY-MM-DD from 2000 on. Date inputs emit '' for a half-edited date and
// intermediate years while typing (0002-…, 0202-…) — neither is a real choice.
export function isKpiDate(v) {
  return typeof v === 'string' && YMD.test(v) && v >= '2000-01-01';
}

// The effective start of the KPI window — what gets fetched, what pages filter
// on, and what exports send. An empty From never means "download all history":
//   real From date                → that date
//   empty From + To before window → 90 days ending at To
//   otherwise                     → the window already loaded (loadedFrom)
export function kpiFetchFrom(wantedFrom, wantedTo, loadedFrom) {
  if (isKpiDate(wantedFrom)) return wantedFrom;
  if (isKpiDate(wantedTo) && wantedTo < loadedFrom) return minusWindow(wantedTo + 'T00:00:00Z');
  return loadedFrom;
}

// requestedFrom: `from` of the last request.
// wantedFrom:    kpiFetchFrom() for the current range.
export function needsKpiRefetch(requestedFrom, wantedFrom) {
  if (requestedFrom === '') return false;
  if (!isKpiDate(wantedFrom)) return false;
  return wantedFrom < requestedFrom;
}

export function kpiSegmentsPath({ page, from, cb }) {
  const range = from ? `&from=${from}&includeOpen=1` : '';
  return `/data/kpi-segments?page=${page}&pageSize=10000&drilldown=1${range}&cb=${cb}`;
}
