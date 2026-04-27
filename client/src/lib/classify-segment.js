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

// True when the segment should be excluded from central-tendency metrics
// (Avg Duration, Median, Total Hours, XpH). Outliers (Excl Short / Excl Long)
// represent data-quality artifacts — accidental clicks at the low end and
// chain-break gaps at the high end. Open and Unclassified segments stay
// included by NOT being matched here (they're filtered separately by the
// caller's `!s.isOpen` and `durationMinutes > 0` predicates).
export function isOutlier(bucket) {
  return bucket === 'Exclude Short' || bucket === 'Exclude Long';
}
