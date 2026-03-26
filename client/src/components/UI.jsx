import React from 'react';

// ── Formatters ──────────────────────────────────────────────
export const fmt = (n, d=1) => n==null||n===''?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtI = n => n==null||n===''?'—':Number(n).toLocaleString('en-US');
export const fmtP = n => n==null?'—':Math.round(n*100)+'%';
export const fmtDur = min => {
  if (min == null || min === '') return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};
export const fmtHrs = h => {
  if (h == null || h === '') return '—';
  return Number(h).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};

// ── Metric Card (enhanced) ──────────────────────────────────
const CARD_STYLES = {
  brand: { bg:'bg-brand-50', border:'border-brand-200', accent:'text-brand-600', icon:'bg-brand-100' },
  green: { bg:'bg-emerald-50', border:'border-emerald-200', accent:'text-emerald-600', icon:'bg-emerald-100' },
  amber: { bg:'bg-amber-50', border:'border-amber-200', accent:'text-amber-600', icon:'bg-amber-100' },
  red:   { bg:'bg-red-50', border:'border-red-200', accent:'text-red-600', icon:'bg-red-100' },
  plum:  { bg:'bg-purple-50', border:'border-purple-200', accent:'text-purple-600', icon:'bg-purple-100' },
  slate: { bg:'bg-slate-50', border:'border-slate-200', accent:'text-slate-600', icon:'bg-slate-100' },
  navy:  { bg:'bg-ocean-50', border:'border-ocean-200', accent:'text-ocean-600', icon:'bg-ocean-100' },
};
export function Card({ label, value, sub, color='brand', loading, trend, icon }) {
  const s = CARD_STYLES[color] || CARD_STYLES.brand;
  return (
    <div className={`card-surface ${s.bg} ${s.border} p-3 sm:p-4 group`}>
      <div className="flex items-start justify-between">
        <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</div>
        {icon && <span className="text-sm opacity-40">{icon}</span>}
      </div>
      {loading ? <div className="h-7 w-16 rounded-lg loading" /> : <>
        <div className="flex items-baseline gap-2">
          <div className={`text-xl sm:text-2xl font-display font-bold ${s.accent} leading-tight`}>{value??'—'}</div>
          {trend != null && trend !== 0 && (
            <span className={`text-[10px] font-semibold ${trend > 0 ? 'trend-up' : 'trend-down'}`}>
              {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
            </span>
          )}
        </div>
        {sub && <div className="text-[10px] sm:text-[11px] text-ink-400 mt-0.5">{sub}</div>}
      </>}
    </div>
  );
}

// ── Mini stat (inline, for secondary metrics) ───────────────
export function MiniStat({ label, value, accent }) {
  return (
    <div className="p-2 bg-surface-50 rounded-lg">
      <div className="text-[10px] text-ink-400 font-medium">{label}</div>
      <div className={`text-sm font-bold font-mono ${accent || 'text-ink-900'}`}>{value ?? '—'}</div>
    </div>
  );
}

// ── Data Table (enhanced with responsive) ───────────────────
export function Table({ cols, rows, onRow, empty='No data', maxHeight='550px' }) {
  if (!rows?.length) return <div className="card-surface p-8 text-center text-ink-400 text-sm">{empty}</div>;
  return (
    <div className="card-surface overflow-hidden">
      <div className="overflow-x-auto" style={{ maxHeight }}>
        <table className="tbl">
          <thead className="sticky top-0 z-10"><tr>{cols.map((c,i) => <th key={i} className={c.right?'text-right':''} style={{minWidth:c.w}}>{c.label}</th>)}</tr></thead>
          <tbody>{rows.map((r,i) => (
            <tr key={i} className={onRow?'cursor-pointer':''} onClick={() => onRow?.(r)}>
              {cols.map((c,j) => <td key={j} className={c.right?'text-right font-mono':''}>{c.render?c.render(r[c.key],r):r[c.key]??'—'}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Filter Bar ──────────────────────────────────────────────
export function FilterBar({ children }) {
  return <div className="card-surface px-3 sm:px-4 py-3 flex flex-wrap items-end gap-2 sm:gap-3">{children}</div>;
}
export function FilterSelect({ label, value, onChange, options, allLabel='All' }) {
  return (
    <div className="min-w-[120px] sm:min-w-[140px]">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-2.5 sm:px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs sm:text-sm text-ink-800 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100">
        <option value="">{allLabel}</option>
        {options.map(o => <option key={typeof o==='string'?o:o.value} value={typeof o==='string'?o:o.value}>{typeof o==='string'?o:o.label}</option>)}
      </select>
    </div>
  );
}
export function FilterInput({ label, value, onChange, placeholder, type='text' }) {
  return (
    <div className="min-w-[120px] sm:min-w-[140px]">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-2.5 sm:px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs sm:text-sm text-ink-800 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
    </div>
  );
}
export function FilterReset({ onClick }) {
  return <button onClick={onClick} className="px-3 py-1.5 text-xs text-ink-400 hover:text-brand-600 font-medium transition-colors self-end">Clear filters</button>;
}

// ── Pills ───────────────────────────────────────────────────
export function Pills({ tabs, active, onChange }) {
  return (
    <div className="flex gap-0.5 bg-surface-100 rounded-lg p-1 border border-surface-200 overflow-x-auto">
      {tabs.map(t => <button key={t.key} onClick={() => onChange(t.key)}
        className={`px-2.5 sm:px-3.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all whitespace-nowrap ${active===t.key
          ?'bg-white text-brand-600 shadow-card border border-surface-200'
          :'text-ink-500 hover:text-ink-700 border border-transparent'}`}>
        {t.label}
      </button>)}
    </div>
  );
}

// ── Section ─────────────────────────────────────────────────
export function Section({ title, sub, right, children }) {
  return (
    <div>
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-sm sm:text-base font-display font-bold text-ink-900">{title}</h2>
          {sub && <p className="text-[11px] text-ink-400 mt-0.5">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ── Loading ─────────────────────────────────────────────────
export function Skel({ rows=5, cols=4 }) {
  return <div className="card-surface p-4 space-y-3">
    {Array.from({length:rows}).map((_,i) => <div key={i} className="flex gap-4">{Array.from({length:cols}).map((_,j) => <div key={j} className="h-4 rounded-lg loading flex-1" />)}</div>)}
  </div>;
}

// ── Chart tooltip style (shared) ────────────────────────────
export const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    color: '#0f172a',
    fontSize: 12,
    fontFamily: '"DM Sans", system-ui, sans-serif',
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
    padding: '10px 14px',
  },
  labelStyle: { fontWeight: 600, marginBottom: 4, color: '#0f172a' },
  itemStyle: { padding: '2px 0', fontSize: 12 },
};

// ── Legend (custom, cleaner than recharts default) ──────────
export function ChartLegend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
      {items.map(item => (
        <div key={item.label} className="flex items-center gap-1.5 text-[11px] text-ink-500">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: item.color }} />
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ── Worker identity resolver ──────────────────────────────────
export function disambiguateWorkers(items) {
  const idNames = {};
  for (const item of items) {
    const id = item.workerUserId || item.workerEmail || item.workerName || null;
    if (!id) continue;
    if (!idNames[id]) idNames[id] = {};
    const name = item.workerName || 'UNATTRIBUTED';
    idNames[id][name] = (idNames[id][name] || 0) + 1;
  }
  const canonical = {};
  for (const [id, names] of Object.entries(idNames)) {
    canonical[id] = Object.entries(names).sort((a,b) => b[1] - a[1])[0][0];
  }
  const nameToIds = {};
  for (const [id, name] of Object.entries(canonical)) {
    if (!nameToIds[name]) nameToIds[name] = [];
    nameToIds[name].push(id);
  }
  return items.map(item => {
    const id = item.workerUserId || item.workerEmail || item.workerName || null;
    const name = id ? (canonical[id] || item.workerName || 'UNATTRIBUTED') : (item.workerName || 'UNATTRIBUTED');
    const isDuplicate = nameToIds[name] && nameToIds[name].length > 1;
    const displayName = isDuplicate && item.workerEmail
      ? `${name} (${item.workerEmail})`
      : name;
    return { ...item, _workerId: id, displayName };
  });
}
