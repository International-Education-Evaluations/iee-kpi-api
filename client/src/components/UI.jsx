import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';

const ORDER_URL = 'https://admin.prod.iee.com/orders/';

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
export function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' +
      d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
  } catch { return iso.substring(0,16); }
}

// ── Metric Card ──────────────────────────────────────────────
const CARD_STYLES = {
  brand: { bg:'bg-brand-50', border:'border-brand-200', accent:'text-brand-600' },
  green: { bg:'bg-emerald-50', border:'border-emerald-200', accent:'text-emerald-600' },
  amber: { bg:'bg-amber-50', border:'border-amber-200', accent:'text-amber-600' },
  red:   { bg:'bg-red-50', border:'border-red-200', accent:'text-red-600' },
  plum:  { bg:'bg-purple-50', border:'border-purple-200', accent:'text-purple-600' },
  slate: { bg:'bg-slate-50', border:'border-slate-200', accent:'text-slate-600' },
  navy:  { bg:'bg-ocean-50', border:'border-ocean-200', accent:'text-ocean-600' },
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

export function MiniStat({ label, value, accent }) {
  return (
    <div className="p-2 bg-surface-50 rounded-lg">
      <div className="text-[10px] text-ink-400 font-medium">{label}</div>
      <div className={`text-sm font-bold font-mono ${accent || 'text-ink-900'}`}>{value ?? '—'}</div>
    </div>
  );
}

// ── Sortable, searchable Data Table ─────────────────────────
export function Table({ cols, rows, onRow, empty='No data', maxHeight='550px', searchKey, searchPlaceholder='Search…', defaultSort, defaultSortDir='desc' }) {
  const [sortKey, setSortKey] = useState(defaultSort || null);
  const [sortDir, setSortDir] = useState(defaultSortDir);
  const [search, setSearch] = useState('');

  const handleSort = useCallback((key) => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return key; }
      setSortDir('desc'); return key;
    });
  }, []);

  const displayed = useMemo(() => {
    let out = rows || [];
    if (search && searchKey) {
      const q = search.toLowerCase();
      out = out.filter(r => Object.values(r).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(q)));
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const av = a[sortKey]; const bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1; if (bv == null) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, search, searchKey, sortKey, sortDir]);

  return (
    <div>
      {searchKey && (
        <div className="px-4 py-2 border-b border-surface-100 bg-surface-50 flex items-center gap-3">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={searchPlaceholder}
            className="w-full max-w-xs px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
          {search && <span className="text-[10px] text-ink-400 whitespace-nowrap">{displayed.length} of {rows?.length} rows</span>}
        </div>
      )}
      {!displayed.length
        ? <div className="p-8 text-center text-ink-400 text-sm">{search ? `No results for "${search}"` : empty}</div>
        : <div className="overflow-x-auto" style={{ maxHeight }}>
            <table className="tbl">
              <thead className="sticky top-0 z-10"><tr>
                {cols.map((c, i) => (
                  <th key={i} className={`${c.right?'text-right':''} ${c.sortable!==false?'cursor-pointer hover:bg-surface-100 select-none':''}`}
                    style={{minWidth:c.w}} onClick={() => c.sortable!==false && handleSort(c.key)}>
                    {c.label}
                    {c.sortable!==false && <span className={`ml-1 text-[9px] ${sortKey===c.key?'text-brand-600':'text-ink-300'}`}>{sortKey===c.key?(sortDir==='asc'?'▲':'▼'):'⇅'}</span>}
                  </th>
                ))}
              </tr></thead>
              <tbody>{displayed.map((r,i) => (
                <tr key={i} className={onRow?'cursor-pointer':''} onClick={() => onRow?.(r)}>
                  {cols.map((c,j) => <td key={j} className={c.right?'text-right font-mono':''}>{c.render?c.render(r[c.key],r):(r[c.key]??'—')}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
      }
    </div>
  );
}

// ── Filter Bar ───────────────────────────────────────────────
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

// ── Pills ─────────────────────────────────────────────────────
export function Pills({ tabs, active, onChange }) {
  return (
    <div className="flex gap-0.5 bg-surface-100 rounded-lg p-1 border border-surface-200 overflow-x-auto">
      {tabs.map(t => <button key={t.key} onClick={() => onChange(t.key)}
        className={`px-2.5 sm:px-3.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all whitespace-nowrap ${active===t.key?'bg-white text-brand-600 shadow-card border border-surface-200':'text-ink-500 hover:text-ink-700 border border-transparent'}`}>
        {t.label}
      </button>)}
    </div>
  );
}

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

export function Skel({ rows=5, cols=4 }) {
  return <div className="card-surface p-4 space-y-3">
    {Array.from({length:rows}).map((_,i) => <div key={i} className="flex gap-4">{Array.from({length:cols}).map((_,j) => <div key={j} className="h-4 rounded-lg loading flex-1" />)}</div>)}
  </div>;
}

export const TOOLTIP_STYLE = {
  contentStyle: { background:'#ffffff', border:'1px solid #e2e8f0', borderRadius:10, color:'#0f172a', fontSize:12, fontFamily:'"DM Sans",system-ui,sans-serif', boxShadow:'0 8px 24px rgba(0,0,0,0.1)', padding:'10px 14px' },
  labelStyle: { fontWeight:600, marginBottom:4, color:'#0f172a' },
  itemStyle: { padding:'2px 0', fontSize:12 },
};

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

// ── OrderLink ─────────────────────────────────────────────────
export function OrderLink({ serial, tab='order-information' }) {
  if (!serial) return <span className="text-ink-300">—</span>;
  return (
    <a href={`${ORDER_URL}${serial}?tab=${tab}`} target="_blank" rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="text-brand-600 hover:text-brand-700 hover:underline font-mono text-[11px] font-semibold">
      {serial}
    </a>
  );
}

// ── DrilldownDrawer ────────────────────────────────────────────
export function DrilldownDrawer({ open, onClose, title, subtitle, rows=[], loading=false, cols=[], emptyText='No orders found.', extraFilters }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => { if (open) setSearch(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  const handleSort = (key) => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return key; }
      setSortDir('asc'); return key;
    });
  };

  const displayed = useMemo(() => {
    let out = rows;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(r => Object.values(r).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(q)));
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const av = a[sortKey]; const bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1; if (bv == null) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, search, sortKey, sortDir]);

  return (
    <>
      <div onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity duration-200"
        style={{ opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }} />
      <div className="fixed top-0 right-0 z-50 h-full w-full max-w-3xl flex flex-col bg-white shadow-2xl transition-transform duration-300 ease-out"
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 bg-gradient-to-r from-brand-600 to-brand-700 text-white shrink-0">
          <div className="min-w-0 flex-1 pr-4">
            <h2 className="text-base font-display font-bold truncate">{title || 'Drilldown'}</h2>
            {subtitle && <p className="text-[11px] text-brand-100 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 text-white/80 hover:text-white transition-colors shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/>
            </svg>
          </button>
        </div>

        {/* Search bar */}
        <div className="px-4 py-3 border-b border-surface-200 bg-surface-50 shrink-0 flex flex-wrap items-center gap-3">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search orders, workers, departments…"
            className="flex-1 min-w-[180px] px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
          {extraFilters}
          <span className="text-[10px] text-ink-400 whitespace-nowrap">
            {loading ? 'Loading…' : `${displayed.length.toLocaleString()} / ${rows.length.toLocaleString()}`}
          </span>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-8 space-y-3">{[1,2,3,4,5].map(i => <div key={i} className="h-8 rounded-lg loading" style={{opacity:1-i*0.15}} />)}</div>
          ) : !displayed.length ? (
            <div className="p-12 text-center text-ink-400 text-sm">{search ? `No results for "${search}"` : emptyText}</div>
          ) : (
            <table className="tbl w-full">
              <thead className="sticky top-0 z-10 bg-surface-50">
                <tr>
                  {cols.map((c, i) => (
                    <th key={i}
                      className={`${c.right?'text-right':''} ${c.sortable!==false?'cursor-pointer hover:bg-surface-100 select-none':''} text-[10px] px-3 py-2.5 font-semibold uppercase tracking-wider text-ink-500 border-b border-surface-200`}
                      style={{minWidth:c.w}} onClick={() => c.sortable!==false && handleSort(c.key)}>
                      {c.label}
                      {c.sortable!==false && <span className={`ml-1 text-[9px] ${sortKey===c.key?'text-brand-600':'text-ink-300'}`}>{sortKey===c.key?(sortDir==='asc'?'▲':'▼'):'⇅'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map((r, i) => (
                  <tr key={i} className="hover:bg-brand-50/30 transition-colors">
                    {cols.map((c, j) => (
                      <td key={j} className={`px-3 py-2 text-[12px] border-b border-surface-100 ${c.right?'text-right font-mono':''}`}>
                        {c.render ? c.render(r[c.key], r) : (r[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-ink-400">Click any order number to open in production admin</span>
          <button onClick={onClose} className="px-4 py-1.5 text-xs font-semibold text-ink-600 hover:text-brand-600 border border-surface-200 hover:border-brand-200 rounded-lg transition-colors">Close</button>
        </div>
      </div>
    </>
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
  for (const [id, names] of Object.entries(idNames)) canonical[id] = Object.entries(names).sort((a,b)=>b[1]-a[1])[0][0];
  const nameToIds = {};
  for (const [id, name] of Object.entries(canonical)) { if (!nameToIds[name]) nameToIds[name]=[]; nameToIds[name].push(id); }
  return items.map(item => {
    const id = item.workerUserId || item.workerEmail || item.workerName || null;
    const name = id ? (canonical[id] || item.workerName || 'UNATTRIBUTED') : (item.workerName || 'UNATTRIBUTED');
    const isDuplicate = nameToIds[name] && nameToIds[name].length > 1;
    const displayName = isDuplicate && item.workerEmail ? `${name} (${item.workerEmail})` : name;
    return { ...item, _workerId: id, displayName };
  });
}
