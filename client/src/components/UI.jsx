import React from 'react';

// ── Formatters ──────────────────────────────────────────────
export const fmt = (n, d=1) => n==null||n===''?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtI = n => n==null||n===''?'—':Number(n).toLocaleString('en-US');
export const fmtP = n => n==null?'—':Math.round(n*100)+'%';

// ── Metric Card ─────────────────────────────────────────────
const CARD_COLORS = {
  navy:'from-navy-600/25 to-navy-800/10 border-navy-500/25',
  green:'from-emerald-600/25 to-emerald-800/10 border-emerald-600/25',
  plum:'from-plum-500/25 to-plum-600/10 border-plum-400/25',
  amber:'from-amber-500/20 to-amber-600/10 border-amber-500/25',
  red:'from-red-500/20 to-red-700/10 border-red-500/25',
  slate:'from-slate-600/25 to-slate-800/10 border-slate-500/25'
};
export function Card({ label, value, sub, color='navy', loading }) {
  return (
    <div className={`rounded-xl bg-gradient-to-br ${CARD_COLORS[color]||CARD_COLORS.navy} border p-4 transition-all hover:scale-[1.01]`}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-1.5">{label}</div>
      {loading ? <div className="h-8 w-20 bg-slate-700/40 rounded loading" /> : <>
        <div className="text-2xl font-display font-bold text-white leading-tight">{value??'—'}</div>
        {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
      </>}
    </div>
  );
}

// ── Data Table ──────────────────────────────────────────────
export function Table({ cols, rows, onRow, empty='No data' }) {
  if (!rows?.length) return <div className="glass rounded-xl p-8 text-center text-slate-500">{empty}</div>;
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="tbl w-full">
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
  return <div className="glass rounded-xl px-4 py-3 flex flex-wrap items-end gap-3">{children}</div>;
}
export function FilterSelect({ label, value, onChange, options, allLabel='All' }) {
  return (
    <div>
      <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="px-3 py-1.5 bg-slate-800/70 border border-slate-600/40 rounded-lg text-sm text-white focus:outline-none focus:border-navy-400 min-w-[140px]">
        <option value="">{allLabel}</option>
        {options.map(o => <option key={typeof o==='string'?o:o.value} value={typeof o==='string'?o:o.value}>{typeof o==='string'?o:o.label}</option>)}
      </select>
    </div>
  );
}
export function FilterInput({ label, value, onChange, placeholder, type='text' }) {
  return (
    <div>
      <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="px-3 py-1.5 bg-slate-800/70 border border-slate-600/40 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-navy-400 min-w-[140px]" />
    </div>
  );
}
export function FilterReset({ onClick }) {
  return <button onClick={onClick} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors self-end">Clear filters</button>;
}

// ── Pills ───────────────────────────────────────────────────
export function Pills({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 bg-slate-800/40 rounded-lg p-1">
      {tabs.map(t => <button key={t.key} onClick={() => onChange(t.key)}
        className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${active===t.key?'bg-navy-600 text-white shadow':'text-slate-400 hover:text-white hover:bg-slate-700/40'}`}>
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
          <h2 className="text-lg font-display font-bold text-white">{title}</h2>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ── Loading ─────────────────────────────────────────────────
export function Skel({ rows=5, cols=4 }) {
  return <div className="glass rounded-xl p-4 space-y-3">
    {Array.from({length:rows}).map((_,i) => <div key={i} className="flex gap-4">{Array.from({length:cols}).map((_,j) => <div key={j} className="h-4 bg-slate-700/40 rounded loading flex-1" />)}</div>)}
  </div>;
}

// ── Worker name disambiguator ───────────────────────────────
// When names are duplicated, append email for clarity
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
