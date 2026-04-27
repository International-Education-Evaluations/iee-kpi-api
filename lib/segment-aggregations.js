// Pure helpers for KPI segment aggregations. Kept dependency-free so they're
// testable from node:test (server-side) and importable by the client bundle.

// ── sumOrderLevelField ──────────────────────────────────────────────────────
// reportItemCount and credentialCount are *order-level* fields — server-side
// they're attached identically to every segment of an order. Naively summing
// across a worker's segments multi-counts orders the worker touched in more
// than one segment. This helper takes the value once per distinct
// orderSerialNumber, then sums.
function sumOrderLevelField(segments, field) {
  if (!Array.isArray(segments) || !field) return 0;
  const perOrder = new Map();
  for (const s of segments) {
    const key = s?.orderSerialNumber;
    if (!key) continue;
    if (!perOrder.has(key)) {
      const v = s?.[field];
      perOrder.set(key, typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }
  }
  let total = 0;
  for (const v of perOrder.values()) total += v;
  return total;
}

// ── computeXphByUnit ────────────────────────────────────────────────────────
// Per-worker XpH must be partitioned by xphUnit (Orders | Reports | Credentials)
// because units are heterogeneous and summing them is meaningless. Returns
// per-unit { units, hours, xph } plus the dominant key (the unit with the
// largest absolute units sum, falling back to 'orders').
//
// Pass closed segments only (caller's filter). Each segment must carry
// `xphUnit` and `unitValue` (already computed in client/src/hooks/useData.jsx).
function computeXphByUnit(closedSegments) {
  const acc = {
    orders:      { units: 0, minutes: 0 },
    reports:     { units: 0, minutes: 0 },
    credentials: { units: 0, minutes: 0 },
  };
  if (!Array.isArray(closedSegments)) return finalize(acc);

  for (const s of closedSegments) {
    const unit = String(s?.xphUnit || 'Orders').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(acc, unit)) continue;
    const dur  = Number(s?.durationMinutes);
    const uval = Number(s?.unitValue);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (Number.isFinite(uval)) acc[unit].units += uval;
    acc[unit].minutes += dur;
  }
  return finalize(acc);
}

function finalize(acc) {
  const out = {};
  let dominant = 'orders';
  let maxUnits = -Infinity;
  for (const [key, v] of Object.entries(acc)) {
    const hours = v.minutes / 60;
    out[key] = {
      units: v.units,
      hours: Math.round(hours * 10) / 10,
      xph:   hours > 0 ? Math.round((v.units / hours) * 10) / 10 : null,
    };
    if (v.units > maxUnits) { maxUnits = v.units; dominant = key; }
  }
  out.dominant = maxUnits > 0 ? dominant : 'orders';
  return out;
}

module.exports = { sumOrderLevelField, computeXphByUnit };
