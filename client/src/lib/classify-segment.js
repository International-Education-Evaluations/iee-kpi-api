// 5-bucket KPI segment classifier. Pulled out of KPIOverview.jsx so KPIUsers,
// KPIScorecard, and any other page can use the same rules. Returns a memoized
// classifier function bound to a specific benchmarks list.

export function makeClassifier(benchmarks) {
  const benchMap = {};
  for (const b of benchmarks || []) {
    if (b?.status) benchMap[b.status] = b;
  }
  return function classify(s) {
    if (!s) return 'Unclassified';
    if (s.isOpen) return 'Open';
    if (s.durationMinutes == null) return 'Unclassified';
    const b = benchMap[s.statusSlug];
    if (!b) return 'Unclassified';
    const dur = s.durationMinutes;
    if (dur <  (b.excludeShortMin ?? 0.5)) return 'Exclude Short';
    if (dur <  (b.inRangeMin      ?? 1))   return 'Out-of-Range Short';
    if (dur <= (b.inRangeMax      ?? 120)) return 'In-Range';
    if (dur <= (b.excludeLongMax  ?? 480)) return 'Out-of-Range Long';
    return 'Exclude Long';
  };
}

// Compute the explicit date range covered by the active dataset / filters.
// Returns { fromIso, toIso, label } where label is something like
// "Apr 13 – Apr 27" (always, never just a day count). When the user has set
// explicit From/To filters those win; otherwise fall back to the loaded
// dataset's actual segmentStart bounds, then to a 60-day backfill window.
const _MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _fmtMD(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  const m = parseInt(s.slice(5, 7), 10);
  const d = parseInt(s.slice(8, 10), 10);
  return `${_MO[m - 1] || '?'} ${d}`;
}

export function computeDateRange({ from, to, segments, fallbackDays = 60 }) {
  // 1. Explicit filter wins.
  if (from && to) return { fromIso: from, toIso: to, label: `${_fmtMD(from)} – ${_fmtMD(to)}` };
  if (from)       return { fromIso: from, toIso: null, label: `${_fmtMD(from)} – now` };
  if (to)         return { fromIso: null, toIso: to,   label: `up to ${_fmtMD(to)}` };

  // 2. Derive from data — pick the min/max segmentStart across loaded rows.
  if (Array.isArray(segments) && segments.length) {
    let minIso = null, maxIso = null;
    for (const s of segments) {
      const v = s?.segmentStart;
      if (!v) continue;
      if (minIso === null || v < minIso) minIso = v;
      if (maxIso === null || v > maxIso) maxIso = v;
    }
    if (minIso && maxIso) return { fromIso: minIso, toIso: maxIso, label: `${_fmtMD(minIso)} – ${_fmtMD(maxIso)}` };
  }

  // 3. Fallback to the server's window (today − fallbackDays through today).
  const today = new Date();
  const start = new Date(today.getTime() - fallbackDays * 86400000);
  const fromIso = start.toISOString().slice(0, 10);
  const toIso   = today.toISOString().slice(0, 10);
  return { fromIso, toIso, label: `${_fmtMD(fromIso)} – ${_fmtMD(toIso)}` };
}

// Find dates inside [fromIso, toIso] that have no segments at all. Used to
// surface coverage-gap days like "Apr 15 has no data" right on the page.
// Returns an array of YYYY-MM-DD strings (sorted ascending).
export function findGapDays(segments, fromIso, toIso) {
  if (!fromIso || !toIso || !Array.isArray(segments)) return [];
  const have = new Set();
  for (const s of segments) {
    if (s?.segmentStart) have.add(String(s.segmentStart).slice(0, 10));
  }
  const fromMs = Date.parse(fromIso + 'T00:00:00Z');
  const toMs   = Date.parse(toIso   + 'T00:00:00Z');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  // Cap iteration at 180 days to bound cost.
  const maxDays = Math.min(Math.round((toMs - fromMs) / 86400000) + 1, 180);
  const gaps = [];
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(fromMs + i * 86400000).toISOString().slice(0, 10);
    if (!have.has(d)) gaps.push(d);
  }
  return gaps;
}

// True when the segment should be excluded from central-tendency metrics
// (Avg Duration, Median, Total Hours, XpH). Outliers (Excl Short / Excl Long)
// represent data-quality artifacts — accidental clicks at the low end and
// chain-break gaps at the high end. Open and Unclassified segments stay
// included by NOT being matched here (they're filtered separately by the
// caller's `!s.isOpen` and `durationMinutes > 0` predicates).
export function isOutlier(bucket) {
  return bucket === 'Exclude Short' || bucket === 'Exclude Long';
}
