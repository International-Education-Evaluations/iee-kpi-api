// ESM mirror of /lib/segment-aggregations.js (CommonJS) so the client bundle
// can use these helpers without Vite reaching above the client/ project root.
// Tests live next to the canonical CommonJS copy at /test/. If this drifts,
// fix it by re-running the tests against both.

export function sumOrderLevelField(segments, field) {
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

export function computeXphByUnit(closedSegments) {
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

// Tiny formatter so the dominant unit name displays correctly on the card.
export function unitLabel(dominant) {
  if (dominant === 'reports')     return 'Reports';
  if (dominant === 'credentials') return 'Credentials';
  return 'Orders';
}
