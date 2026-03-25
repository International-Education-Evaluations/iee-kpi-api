import React from 'react';

// ── Formatters ──────────────────────────────────────────────
export const fmt = (n, d=1) => n==null||n===''?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtI = n => n==null||n===''?'—':Number(n).toLocaleString('en-US');
export const fmtP = n => n==null?'—':Math.round(n*100)+'%';

// ── Metric Card ─────────────────────────────────────────────
const CARD_STYLES = {
  brand: { bg:'bg-brand-50', border:'border-brand-200', accent:'text-brand-600', icon:'bg-brand-100' },
  green: { bg:'bg-emerald-50', border:'border-emerald-200', accent:'text-emerald-600', icon:'bg-emerald-100' },
  amber: { bg:'bg-amber-50', border:'border-amber-200', accent:'text-amber-600', icon:'bg-amber-100' },
  red:   { bg:'bg-red-50', border:'border-red-200', accent:'text-red-600', icon:'bg-red-100' },
  plum:  { bg:'bg-purple-50', border:'border-purple-200', accent:'text-purple-600', icon:'bg-purple-100' },
  slate: { bg:'bg-slate-50', border:'border-slate-200', accent:'text-slate-600', icon:'bg-slate-100' },
  navy:  { bg:'bg-ocean-50', border:'border-ocean-200', accent:'text-ocean-600', icon:'bg-ocean-100' },
};
export function Card({ label, value, sub, color='brand', loading }) {
  const s = CARD_STYLES[color] || CARD_STYLES.brand;
  return (
    <div className={`card-surface ${s.bg} ${s.border} p-4 group`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">{label}</div>
      {loading ? <div className="h-8 w-20 rounded-lg loading" /> : <>
        <div className={`text-2xl font-display font-bold ${s.accent} leading-tight`}>{value??'—'}</div>
        {sub && <div className="text-[11px] text-ink-400 mt-0.5">{sub}</div>}
      </>}
    </div>
  );
}

// ── Data Table ──────────────────────────────────────────────
export function Table({ cols, rows, onRow, empty='No data' }) {
  if (!rows?.length) return <div className="card-surface p-8 text-center text-ink-400">{empty}</div>;
  return (
    <div className="card-surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr>{cols.map((c,i) => <th key={i} className={c.right?'text-right':''} style={{minWidth:c.w}}>{c.label}</th>)}</tr></thead>
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
  return <div className="card-surface px-4 py-3 flex flex-wrap items-end gap-3">{children}</div>;
}
export function FilterSelect({ label, value, onChange, options, allLabel='All' }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-sm text-ink-800 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 min-w-[140px]">
        <option value="">{allLabel}</option>
        {options.map(o => <option key={typeof o==='string'?o:o.value} value={typeof o==='string'?o:o.value}>{typeof o==='string'?o:o.label}</option>)}
      </select>
    </div>
  );
}
export function FilterInput({ label, value, onChange, placeholder, type='text' }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-sm text-ink-800 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 min-w-[140px]" />
    </div>
  );
}
export function FilterReset({ onClick }) {
  return <button onClick={onClick} className="px-3 py-1.5 text-xs text-ink-400 hover:text-brand-600 font-medium transition-colors self-end">Clear filters</button>;
}

// ── Pills ───────────────────────────────────────────────────
export function Pills({ tabs, active, onChange }) {
  return (
    <div className="flex gap-0.5 bg-surface-100 rounded-lg p-1 border border-surface-200">
      {tabs.map(t => <button key={t.key} onClick={() => onChange(t.key)}
        className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all ${active===t.key
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
          <h2 className="text-base font-display font-bold text-ink-900">{title}</h2>
          {sub && <p className="text-xs text-ink-400 mt-0.5">{sub}</p>}
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

// ── Worker name disambiguator ───────────────────────────────
export function disambiguateWorkers(items, nameKey='workerName', emailKey='workerEmail') {
  const nameCounts = {};
  for (const item of items) {
    const name = item[nameKey] || 'UNATTRIBUTED';
    nameCounts[name] = (nameCounts[name] || 0) + 1;
  }
  return items.map(item => {
    const name = item[nameKey] || 'UNATTRIBUTED';
    const displayName = nameCounts[name] > 1 && item[emailKey]
      ? `${name} (${item[emailKey]})`
      : name;
    return { ...item, displayName };
  });
}
