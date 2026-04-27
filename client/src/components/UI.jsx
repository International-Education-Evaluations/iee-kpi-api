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
export function Card({ label, value, sub, color='brand', loading, trend, icon, tooltip }) {
  const s = CARD_STYLES[color] || CARD_STYLES.brand;
  return (
    <div className={`card-surface ${s.bg} ${s.border} p-3 sm:p-4 group`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-1 mb-1">
          <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
          {tooltip && <InfoTip text={tooltip} />}
        </div>
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

// Small "i" badge that reveals a definition on hover/focus. Uses the native
// `title` attribute as a keyboard-/screen-reader-accessible fallback so users
// without a mouse still get the explanation.
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button"
        aria-label={`What does this mean? ${text}`}
        title={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); setOpen(o => !o); }}
        className="w-3.5 h-3.5 rounded-full bg-surface-200 hover:bg-surface-300 text-ink-500 hover:text-ink-700 text-[9px] font-bold leading-none flex items-center justify-center cursor-help focus:outline-none focus:ring-2 focus:ring-brand-300">
        i
      </button>
      {open && (
        <span role="tooltip"
          className="absolute z-50 left-1/2 -translate-x-1/2 top-full mt-1.5 w-64 px-3 py-2 rounded-lg bg-ink-900 text-white text-[11px] leading-snug font-normal normal-case tracking-normal shadow-lg pointer-events-none">
          {text}
          <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-ink-900 rotate-45"></span>
        </span>
      )}
    </span>
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
export function FilterBar({ children, ...rest }) {
  return <div className="card-surface px-3 sm:px-4 py-3 flex flex-wrap items-end gap-2 sm:gap-3" {...rest}>{children}</div>;
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

// ── DatePresets ───────────────────────────────────────────────
// Quick-select preset date ranges. Outputs YYYY-MM-DD strings
// compatible with HTML date inputs and the ISO string comparison in filters.
export function DatePresets({ onSelect }) {
  const presets = [
    { label: 'Today',      getDates: () => { const d = toYMD(new Date()); return [d, d]; } },
    { label: 'Yesterday',  getDates: () => { const d = toYMD(daysAgo(1)); return [d, d]; } },
    { label: 'Last 7d',    getDates: () => [toYMD(daysAgo(6)), toYMD(new Date())] },
    { label: 'Last 30d',   getDates: () => [toYMD(daysAgo(29)), toYMD(new Date())] },
    { label: 'This week',  getDates: () => { const n = new Date(); const d = n.getDay(); return [toYMD(daysAgo(d)), toYMD(new Date())]; } },
    { label: 'Last week',  getDates: () => { const n = new Date(); const d = n.getDay(); return [toYMD(daysAgo(d + 7)), toYMD(daysAgo(d + 1))]; } },
    { label: 'This month', getDates: () => { const n = new Date(); return [`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`, toYMD(new Date())]; } },
    { label: 'Last month', getDates: () => { const n = new Date(); const y = n.getMonth() === 0 ? n.getFullYear()-1 : n.getFullYear(); const m = n.getMonth() === 0 ? 12 : n.getMonth(); const days = new Date(y, m, 0).getDate(); return [`${y}-${String(m).padStart(2,'0')}-01`, `${y}-${String(m).padStart(2,'0')}-${days}`]; } },
    { label: 'This quarter', getDates: () => { const n = new Date(); const q = Math.floor(n.getMonth()/3); const qStart = new Date(n.getFullYear(), q*3, 1); return [toYMD(qStart), toYMD(new Date())]; } },
    { label: 'Last quarter', getDates: () => { const n = new Date(); const q = Math.floor(n.getMonth()/3); const lqStart = new Date(n.getFullYear(), (q-1)*3, 1); const lqEnd = new Date(n.getFullYear(), q*3, 0); return [toYMD(lqStart), toYMD(lqEnd)]; } },
  ];

  function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
  function toYMD(d) { return d.toISOString().slice(0, 10); }

  return (
    <div className="flex flex-wrap gap-1">
      {presets.map(p => (
        <button key={p.label} type="button"
          onClick={() => { const [from, to] = p.getDates(); onSelect(from, to); }}
          className="px-2 py-1 text-[10px] font-medium text-ink-500 bg-white border border-surface-200 rounded-md hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50 transition-all whitespace-nowrap">
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Pills ─────────────────────────────────────────────────────
export function Pills({ tabs, active, onChange, ...rest }) {
  return (
    <div className="flex gap-0.5 bg-surface-100 rounded-lg p-1 border border-surface-200 overflow-x-auto" {...rest}>
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
  contentStyle: { background:'#ffffff', border:'1px solid #e2e8f0', borderRadius:10, color:'#0f172a', fontSize:12, fontFamily:'"DM Sans",system-ui,sans-serif', boxShadow:'0 4px 16px rgba(0,0,0,0.12)', padding:'10px 14px' },
  labelStyle: { fontWeight:700, marginBottom:4, color:'#0077cc', fontSize:13 },
  itemStyle: { padding:'2px 0', fontSize:12, color:'#334155', fontWeight:500 },
  cursor: { fill:'rgba(0,119,204,0.06)' },
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
// ── disambiguateWorkers ──────────────────────────────────────────────────────
// Resolves a stable _workerId and display name for every segment.
//
// Root causes of duplicate workers in the dropdown:
//  1. Email case inconsistency: "Camelo@myiee.org" vs "camelo@myiee.org" when
//     workerUserId is null → two different string keys → two dropdown entries.
//  2. Mixed workerUserId presence: older segments have workerUserId=null with
//     email="deana@iee.com", newer segments have workerUserId="12345" with
//     same email → two separate ids → Deana appears twice, March data "missing".
//
// Fix: three-tier canonical id with email normalization + cross-tier merge.
//  Tier 1 (preferred): workerUserId (integer string) — most stable
//  Tier 2: email.toLowerCase() — stable across case variants
//  Tier 3: workerName.toLowerCase() — last resort for unattributed segments
//
// Cross-tier merge: if a Tier-1 id and a Tier-2 id share the same lowercased email,
// all Tier-2 segments are promoted to the Tier-1 id. This merges Deana's old + new
// segments under a single id so she appears once in the dropdown.
export function disambiguateWorkers(items) {
  // ── Pass 1: compute raw ids, normalize email ──────────────────────────────
  const processed = items.map(item => {
    const rawEmail = (item.workerEmail || '').toLowerCase().trim();
    const uid  = item.workerUserId ? String(item.workerUserId).trim() : null;
    const rawId = uid || rawEmail || (item.workerName || '').trim() || null;
    return { ...item, _rawId: rawId, _normEmail: rawEmail, _uid: uid };
  });

  // ── Pass 2: build email → uid map for cross-tier merging ─────────────────
  // If any segment with an email also has a workerUserId, that uid is the
  // canonical id for ALL segments sharing that email (including uid-less ones).
  const emailToUid = {}; // normEmail → best uid seen
  for (const item of processed) {
    if (item._uid && item._normEmail) {
      // Prefer the uid that appears most — break ties by string sort
      if (!emailToUid[item._normEmail] || item._uid < emailToUid[item._normEmail]) {
        emailToUid[item._normEmail] = item._uid;
      }
    }
  }

  // ── Pass 3: assign canonical id ───────────────────────────────────────────
  const withId = processed.map(item => {
    let cid;
    if (item._uid) {
      cid = item._uid;
    } else if (item._normEmail && emailToUid[item._normEmail]) {
      // Promote: this email is known to belong to a workerUserId — use it
      cid = emailToUid[item._normEmail];
    } else if (item._normEmail) {
      cid = item._normEmail;
    } else {
      cid = (item.workerName || '').trim().toLowerCase() || null;
    }
    return { ...item, _cid: cid };
  });

  // ── Pass 4: build canonical name per id (most-frequent wins) ─────────────
  const idNameCounts = {}; // cid → { name → count }
  for (const item of withId) {
    if (!item._cid) continue;
    const name = item.workerName?.trim() || 'UNATTRIBUTED';
    if (!idNameCounts[item._cid]) idNameCounts[item._cid] = {};
    idNameCounts[item._cid][name] = (idNameCounts[item._cid][name] || 0) + 1;
  }
  const canonicalName = {}; // cid → best name
  for (const [cid, counts] of Object.entries(idNameCounts)) {
    canonicalName[cid] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // ── Pass 5: detect true name collisions (different people, same name) ─────
  // Two cids with the same canonical name → disambiguation needed → append email
  const nameCount = {}; // canonicalName → count of distinct cids
  for (const name of Object.values(canonicalName)) {
    nameCount[name] = (nameCount[name] || 0) + 1;
  }

  // ── Pass 6: emit final _workerId and displayName ──────────────────────────
  return withId.map(item => {
    const cid  = item._cid;
    const name = cid ? (canonicalName[cid] || item.workerName?.trim() || 'UNATTRIBUTED') : (item.workerName?.trim() || 'UNATTRIBUTED');
    const isNameCollision = nameCount[name] > 1;
    // Only append email for true collisions (different people with same full name)
    const displayName = isNameCollision && item._normEmail ? `${name} (${item._normEmail})` : name;
    // Strip internal pass fields from returned item
    const { _rawId, _normEmail, _uid, _cid, ...rest } = item;
    return { ...rest, _workerId: cid, displayName };
  });
}
