import React, { useEffect, useState, useMemo, useCallback, useDeferredValue } from 'react';
import { useData } from '../hooks/useData';
import { api } from '../hooks/useApi';
import { fmtI, fmt, fmtDur, OrderLink } from '../components/UI';

const BUCKET_COLORS = {
  'Exclude Short':      '#94a3b8',
  'Out-of-Range Short': '#d97706',
  'In-Range':           '#16a34a',
  'Out-of-Range Long':  '#ea580c',
  'Exclude Long':       '#dc2626',
  'Unclassified':       '#64748b',
  'Open':               '#0284c7',
};

function AttainmentBadge({ pct, target }) {
  if (target == null) return <span className="text-[10px] text-ink-300">no target</span>;
  const ratio = target > 0 ? pct / target : 0;
  const cls = ratio >= 0.95 ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
            : ratio >= 0.75 ? 'bg-amber-100 text-amber-700 border-amber-200'
            : 'bg-red-100 text-red-700 border-red-200';
  const icon = ratio >= 0.95 ? '✓' : ratio >= 0.75 ? '~' : '✗';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cls}`}>
      {icon} {Math.round(ratio * 100)}%
    </span>
  );
}

function TrendArrow({ val }) {
  if (val == null) return <span className="text-ink-300 text-[10px]">—</span>;
  const up = val >= 0;
  return <span className={`text-[10px] font-semibold ${up ? 'text-emerald-600' : 'text-red-500'}`}>{up ? '↑' : '↓'}{Math.abs(val)}%</span>;
}

function MiniBar({ pct, color = '#16a34a' }) {
  return (
    <div className="flex items-center gap-1.5 w-full">
      <div className="flex-1 h-1.5 bg-surface-200 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono text-ink-600 w-9 text-right shrink-0">{fmt(pct)}%</span>
    </div>
  );
}

export default function KPIScorecard() {
  const { kpiSegs, kpiLoading, loadKpi } = useData();
  const [benchmarks, setBenchmarks] = useState([]);
  const [userLevels, setUserLevels] = useState([]);
  const [fDept, setFDept] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fWorker, setFWorker] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [view, setView] = useState('worker'); // worker | status | matrix
  const [sortCol, setSortCol] = useState('xph_pct');
  const [sortDir, setSortDir] = useState('asc'); // asc = worst first (red on top)

  const dFDept   = useDeferredValue(fDept);
  const dFStatus = useDeferredValue(fStatus);
  const dFWorker = useDeferredValue(fWorker);
  const dFFrom   = useDeferredValue(fFrom);
  const dFTo     = useDeferredValue(fTo);

  useEffect(() => {
    loadKpi();
    Promise.all([
      api('/config/benchmarks').catch(() => ({ benchmarks: [] })),
      api('/config/user-levels').catch(() => ({ levels: [] })),
    ]).then(([b, l]) => {
      setBenchmarks(b.benchmarks || []);
      setUserLevels(l.levels || []);
    });
  }, [loadKpi]);

  // Build lookup maps
  const benchMap = useMemo(() => {
    const m = {};
    for (const b of benchmarks) if (b.status) m[b.status] = b;
    return m;
  }, [benchmarks]);

  const levelMap = useMemo(() => {
    const m = {};
    for (const u of userLevels) {
      if (u.email) m[u.email.toLowerCase()] = u.level;
      if (u.v1Id) m[String(u.v1Id)] = u.level;
    }
    return m;
  }, [userLevels]);

  const classify = useCallback((s) => {
    if (s.isOpen) return 'Open';
    if (s.durationMinutes == null) return 'Unclassified';
    const b = benchMap[s.statusSlug];
    if (!b) return 'Unclassified';
    const d = s.durationMinutes;
    if (d < (b.excludeShortMin ?? 0.5)) return 'Exclude Short';
    if (d < (b.inRangeMin ?? 1)) return 'Out-of-Range Short';
    if (d <= (b.inRangeMax ?? 120)) return 'In-Range';
    if (d <= (b.excludeLongMax ?? 480)) return 'Out-of-Range Long';
    return 'Exclude Long';
  }, [benchMap]);

  const getXphTarget = useCallback((s) => {
    const b = benchMap[s.statusSlug];
    if (!b) return null;
    const uid = s.workerUserId ? String(s.workerUserId) : null;
    const em  = (s.workerEmail || '').toLowerCase();
    const level = (uid && levelMap[uid]) || (em && levelMap[em]) || s.userLevel || null;
    if (!level) return null;
    return b[level.toLowerCase()] ?? null;
  }, [benchMap, levelMap]);

  // Apply filters
  const filtered = useMemo(() => kpiSegs.filter(s => {
    if (s.isOpen) return false; // scorecard only covers closed work
    if (dFDept   && s.departmentName !== dFDept)   return false;
    if (dFStatus && s.statusSlug !== dFStatus)      return false;
    if (dFWorker && s._workerId !== dFWorker)       return false;
    if (dFFrom   && s.segmentStart && s.segmentStart < dFFrom) return false;
    if (dFTo     && s.segmentStart && s.segmentStart > dFTo + 'T23:59:59') return false;
    return true;
  }), [kpiSegs, dFDept, dFStatus, dFWorker, dFFrom, dFTo]);

  // Dropdown options
  const depts   = useMemo(() => [...new Set(kpiSegs.map(s => s.departmentName).filter(Boolean))].sort(), [kpiSegs]);
  const statuses = useMemo(() => [...new Set(kpiSegs.map(s => s.statusSlug).filter(Boolean))].map(slug => ({
    slug, name: kpiSegs.find(s => s.statusSlug === slug)?.statusName || slug
  })).sort((a,b) => a.name.localeCompare(b.name)), [kpiSegs]);

  const workers = useMemo(() => {
    const m = {};
    for (const s of kpiSegs) {
      if (!s._workerId) continue;
      if (!m[s._workerId]) m[s._workerId] = { id: s._workerId, name: s.displayName || s.workerName || s._workerId };
    }
    return Object.values(m).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [kpiSegs]);

  // ── Per-worker scorecard ─────────────────────────────────────
  const workerRows = useMemo(() => {
    const m = {};
    for (const s of filtered) {
      const id = s._workerId || 'unknown';
      if (!m[id]) m[id] = {
        id, name: s.displayName || s.workerName || id,
        dept: s.departmentName || '',
        level: (() => {
          const uid = s.workerUserId ? String(s.workerUserId) : null;
          const em  = (s.workerEmail || '').toLowerCase();
          return (uid && levelMap[uid]) || (em && levelMap[em]) || s.userLevel || null;
        })(),
        segs: 0, closed: 0, inRange: 0, totalMin: 0, xphNumer: 0, xphDenom: 0,
        xphTargets: [], orders: new Set(),
      };
      const r = m[id];
      r.segs++;
      r.closed++;
      const bucket = classify(s);
      if (bucket === 'In-Range') r.inRange++;
      if (s.durationMinutes > 0) { r.totalMin += s.durationMinutes; r.xphNumer += (s.unitValue ?? 1); r.xphDenom += s.durationMinutes / 60; }
      const t = getXphTarget(s);
      if (t != null) r.xphTargets.push(t);
      if (s.orderSerialNumber) r.orders.add(s.orderSerialNumber);
    }
    return Object.values(m).map(r => {
      const xph = r.xphDenom > 0 ? r.xphNumer / r.xphDenom : 0;
      const xphTarget = r.xphTargets.length ? r.xphTargets.reduce((a,b)=>a+b,0)/r.xphTargets.length : null;
      const inRangePct = r.closed > 0 ? r.inRange / r.closed * 100 : 0;
      const xph_pct = xphTarget > 0 ? xph / xphTarget * 100 : null;
      return { ...r, xph: Math.round(xph*100)/100, xphTarget: xphTarget ? Math.round(xphTarget*100)/100 : null,
               inRangePct: Math.round(inRangePct*10)/10, xph_pct, orders: r.orders.size,
               totalHrs: Math.round(r.totalMin/60*10)/10 };
    });
  }, [filtered, classify, getXphTarget, levelMap]);

  // ── Per-status scorecard ─────────────────────────────────────
  const statusRows = useMemo(() => {
    const m = {};
    for (const s of filtered) {
      const key = s.statusSlug || 'unknown';
      if (!m[key]) m[key] = { slug:key, name:s.statusName||key, segs:0, inRange:0, totalMin:0, cnt:0, workers:new Set(), orders:new Set() };
      const r = m[key];
      r.segs++; r.cnt++;
      if (classify(s) === 'In-Range') r.inRange++;
      if (s.durationMinutes > 0) { r.totalMin += s.durationMinutes; r.unitSum = (r.unitSum||0) + (s.unitValue??1); }
      if (s._workerId) r.workers.add(s._workerId);
      if (s.orderSerialNumber) r.orders.add(s.orderSerialNumber);
    }
    return Object.values(m).map(r => ({
      ...r, workers: r.workers.size, orders: r.orders.size,
      inRangePct: r.segs > 0 ? Math.round(r.inRange/r.segs*1000)/10 : 0,
      avgDuration: r.cnt > 0 ? Math.round(r.totalMin/r.cnt*10)/10 : 0,
      xph: r.totalMin > 0 ? Math.round((r.unitSum||r.cnt)/(r.totalMin/60)*100)/100 : 0,
    }));
  }, [filtered, classify]);

  const sortFn = (arr) => {
    return [...arr].sort((a,b) => {
      const av = a[sortCol] ?? -Infinity;
      const bv = b[sortCol] ?? -Infinity;
      if (typeof av === 'string') return sortDir==='asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  };

  const sortedWorkers = useMemo(() => sortFn(workerRows), [workerRows, sortCol, sortDir]);
  const sortedStatuses = useMemo(() => sortFn(statusRows), [statusRows, sortCol, sortDir]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const SortTh = ({ col, label, right }) => (
    <th onClick={() => toggleSort(col)}
      className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 cursor-pointer select-none hover:text-brand-500 ${right?'text-right':'text-left'} whitespace-nowrap`}>
      {label}{sortCol===col ? (sortDir==='asc'?' ↑':' ↓') : ''}
    </th>
  );

  const hasFilters = fDept||fStatus||fWorker||fFrom||fTo;

  return (
    <div className="space-y-4" data-tour="scorecard-title">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-display font-bold text-ink-900">KPI Performance Scorecard</h1>
          <p className="text-xs text-ink-400 mt-0.5">
            XpH attainment vs benchmark · In-Range rate · {fmtI(filtered.length)} closed segments
          </p>
        </div>
        <div className="flex gap-1 bg-surface-100 p-1 rounded-lg border border-surface-200">
          {[['worker','By Worker'],['status','By Status']].map(([k,l]) => (
            <button key={k} onClick={() => { setView(k); setSortCol(k==='worker'?'xph_pct':'inRangePct'); setSortDir('asc'); }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${view===k?'bg-white text-brand-600 shadow-sm border border-surface-200':'text-ink-500 hover:text-ink-700'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="card-surface p-3 flex flex-wrap gap-3 items-end">
        {[
          { label:'Dept', value:fDept, set:setFDept, opts:depts.map(d=>({value:d,label:d})) },
          { label:'Status', value:fStatus, set:setFStatus, opts:statuses.map(s=>({value:s.slug,label:s.name})) },
          { label:'Worker', value:fWorker, set:setFWorker, opts:workers.map(w=>({value:w.id,label:w.name})) },
        ].map(f => (
          <div key={f.label} className="min-w-[140px]">
            <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">{f.label}</label>
            <select value={f.value} onChange={e => f.set(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
              <option value="">All</option>
              {f.opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        ))}
        {[['From',fFrom,setFFrom],['To',fTo,setFTo]].map(([l,v,s]) => (
          <div key={l}>
            <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">{l}</label>
            <input type="date" value={v} onChange={e=>s(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400" />
          </div>
        ))}
        {hasFilters && <button onClick={()=>{setFDept('');setFStatus('');setFWorker('');setFFrom('');setFTo('');}} className="text-[11px] text-red-500 hover:text-red-700 font-medium self-end pb-1.5">Clear</button>}
      </div>

      {kpiLoading && <div className="text-center text-ink-400 text-sm py-12">Loading segments…</div>}

      {/* Worker Scorecard */}
      {!kpiLoading && view === 'worker' && (
        <div className="card-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-50 border-b border-surface-200">
                <tr>
                  <SortTh col="name"       label="Worker" />
                  <SortTh col="dept"       label="Dept" />
                  <SortTh col="level"      label="Level" />
                  <SortTh col="segs"       label="Segs"     right />
                  <SortTh col="orders"     label="Orders"   right />
                  <SortTh col="xph"        label="XpH"      right />
                  <SortTh col="xphTarget"  label="Target"   right />
                  <SortTh col="xph_pct"    label="Attain."  right />
                  <SortTh col="inRangePct" label="In-Range" right />
                  <SortTh col="totalHrs"   label="Total Hrs" right />
                </tr>
              </thead>
              <tbody>
                {sortedWorkers.map((r, i) => {
                  const xphRatio = r.xphTarget > 0 ? r.xph / r.xphTarget : null;
                  const rowBg = xphRatio != null
                    ? xphRatio >= 0.95 ? 'hover:bg-emerald-50/50'
                    : xphRatio >= 0.75 ? 'hover:bg-amber-50/50'
                    : 'hover:bg-red-50/50'
                    : 'hover:bg-surface-50';
                  return (
                    <tr key={r.id} className={`border-b border-surface-100 text-sm ${rowBg}`}>
                      <td className="px-3 py-2.5 font-medium text-ink-900 max-w-[160px] truncate">{r.name}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-500 max-w-[120px] truncate">{r.dept || '—'}</td>
                      <td className="px-3 py-2.5">
                        {r.level ? <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 text-[10px] font-bold border border-brand-200">{r.level}</span> : <span className="text-ink-300 text-[10px]">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtI(r.segs)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtI(r.orders)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold text-ink-900">{fmt(r.xph)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-400">{r.xphTarget != null ? fmt(r.xphTarget) : '—'}</td>
                      <td className="px-3 py-2.5 text-right"><AttainmentBadge pct={r.xph} target={r.xphTarget} /></td>
                      <td className="px-3 py-2.5 min-w-[120px]"><MiniBar pct={r.inRangePct} color={r.inRangePct>=80?'#16a34a':r.inRangePct>=60?'#d97706':'#dc2626'} /></td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-500">{r.totalHrs}h</td>
                    </tr>
                  );
                })}
                {!sortedWorkers.length && <tr><td colSpan={10} className="px-3 py-8 text-center text-ink-400 text-sm">No data for current filters</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Status Scorecard */}
      {!kpiLoading && view === 'status' && (
        <div className="card-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-50 border-b border-surface-200">
                <tr>
                  <SortTh col="name"        label="Status" />
                  <SortTh col="segs"        label="Segs"      right />
                  <SortTh col="orders"      label="Orders"    right />
                  <SortTh col="workers"     label="Workers"   right />
                  <SortTh col="inRangePct"  label="In-Range"  right />
                  <SortTh col="avgDuration" label="Avg Dur"   right />
                  <SortTh col="xph"         label="XpH"       right />
                </tr>
              </thead>
              <tbody>
                {sortedStatuses.map((r, i) => (
                  <tr key={r.slug} className="border-b border-surface-100 text-sm hover:bg-surface-50">
                    <td className="px-3 py-2.5 font-medium text-ink-900">{r.name}
                      <span className="ml-2 text-[10px] text-ink-400 font-mono">{r.slug}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtI(r.segs)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtI(r.orders)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtI(r.workers)}</td>
                    <td className="px-3 py-2.5 min-w-[130px]"><MiniBar pct={r.inRangePct} color={r.inRangePct>=80?'#16a34a':r.inRangePct>=60?'#d97706':'#dc2626'} /></td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtDur(r.avgDuration)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold">{fmt(r.xph)}</td>
                  </tr>
                ))}
                {!sortedStatuses.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-400 text-sm">No data for current filters</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
