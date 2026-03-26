import React, { useEffect, useState, useMemo, useDeferredValue } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';
import { useData } from '../hooks/useData';
import { api } from '../hooks/useApi';
import { TOOLTIP_STYLE, fmt, fmtI, fmtDur } from '../components/UI';

const COLORS = ['#00aeef','#16a34a','#d97706','#7c3aed','#ea580c','#0284c7','#dc2626','#65a30d'];

function StatCell({ value, max, color }) {
  const pct = max > 0 ? Math.min(value / max * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width:`${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-xs text-ink-700 w-14 text-right shrink-0">{value}</span>
    </div>
  );
}

export default function DeptComparison() {
  const { kpiSegs, qcEvents, kpiLoading, qcLoading, loadKpi, loadQc } = useData();
  const [benchmarks, setBenchmarks] = useState([]);
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fType, setFType] = useState('');
  const [chartMetric, setChartMetric] = useState('xph');

  const dFFrom = useDeferredValue(fFrom);
  const dFTo   = useDeferredValue(fTo);
  const dFType = useDeferredValue(fType);

  useEffect(() => {
    loadKpi(); loadQc();
    api('/config/benchmarks').then(d => setBenchmarks(d.benchmarks || [])).catch(() => {});
  }, [loadKpi, loadQc]);

  const benchMap = useMemo(() => {
    const m = {};
    for (const b of benchmarks) if (b.status) m[b.status] = b;
    return m;
  }, [benchmarks]);

  const classify = useMemo(() => (s) => {
    if (s.isOpen || s.durationMinutes == null) return null;
    const b = benchMap[s.statusSlug];
    if (!b) return null;
    const d = s.durationMinutes;
    if (d < (b.excludeShortMin??0.5)) return 'Exclude Short';
    if (d < (b.inRangeMin??1)) return 'OOR Short';
    if (d <= (b.inRangeMax??120)) return 'In-Range';
    if (d <= (b.excludeLongMax??480)) return 'OOR Long';
    return 'Exclude Long';
  }, [benchMap]);

  const filteredSegs = useMemo(() => kpiSegs.filter(s => {
    if (!s.departmentName) return false;
    if (dFType && s.orderType !== dFType) return false;
    if (dFFrom && s.segmentStart < dFFrom) return false;
    if (dFTo   && s.segmentStart > dFTo + 'T23:59:59') return false;
    return true;
  }), [kpiSegs, dFFrom, dFTo, dFType]);

  const filteredQc = useMemo(() => qcEvents.filter(e => {
    if (!e.departmentName) return false;
    if (dFFrom && e.qcCreatedAt < dFFrom) return false;
    if (dFTo   && e.qcCreatedAt > dFTo + 'T23:59:59') return false;
    return true;
  }), [qcEvents, dFFrom, dFTo]);

  const deptRows = useMemo(() => {
    const m = {};
    for (const s of filteredSegs) {
      const d = s.departmentName;
      if (!m[d]) m[d] = { dept:d, segs:0, closed:0, inRange:0, totalMin:0, xphNumer:0, xphDenom:0, orders:new Set(), workers:new Set() };
      const r = m[d];
      r.segs++;
      if (!s.isOpen) {
        r.closed++;
        const b = classify(s);
        if (b === 'In-Range') r.inRange++;
        if (s.durationMinutes > 0) { r.totalMin += s.durationMinutes; r.xphNumer += (s.unitValue ?? 1); r.xphDenom += s.durationMinutes / 60; }
      }
      if (s.orderSerialNumber) r.orders.add(s.orderSerialNumber);
      if (s._workerId) r.workers.add(s._workerId);
    }
    // QC
    const qcM = {};
    for (const e of filteredQc) {
      const d = e.departmentName;
      if (!qcM[d]) qcM[d] = { fi:0, kb:0, total:0 };
      qcM[d].total++;
      if (e.isFixedIt) qcM[d].fi++;
      if (e.isKickItBack) qcM[d].kb++;
    }
    return Object.values(m).map(r => {
      const xph = r.xphDenom > 0 ? Math.round(r.xphNumer / r.xphDenom * 100) / 100 : 0;
      const inRangePct = r.closed > 0 ? Math.round(r.inRange / r.closed * 1000) / 10 : 0;
      const avgDur = r.closed > 0 ? Math.round(r.totalMin / r.closed * 10) / 10 : 0;
      const qc = qcM[r.dept] || { fi:0, kb:0, total:0 };
      const kbRate = qc.total > 0 ? Math.round(qc.kb / qc.total * 1000) / 10 : 0;
      return { ...r, xph, inRangePct, avgDur, kbRate, qcTotal: qc.total, kbCount: qc.kb,
               orders: r.orders.size, workers: r.workers.size };
    }).sort((a,b) => b.segs - a.segs);
  }, [filteredSegs, filteredQc, classify]);

  const maxVals = useMemo(() => ({
    segs: Math.max(...deptRows.map(r => r.segs), 1),
    xph:  Math.max(...deptRows.map(r => r.xph), 1),
    orders: Math.max(...deptRows.map(r => r.orders), 1),
  }), [deptRows]);

  const chartData = useMemo(() => deptRows.map(r => ({
    dept: r.dept.replace(' Department','').replace(' Processing',''),
    xph: r.xph, inRangePct: r.inRangePct, avgDur: r.avgDur,
    segs: r.segs, kbRate: r.kbRate, workers: r.workers,
  })), [deptRows]);

  const CHART_METRICS = [
    { value:'xph',        label:'XpH',          fmt:v=>fmt(v) },
    { value:'inRangePct', label:'In-Range %',    fmt:v=>`${v}%` },
    { value:'avgDur',     label:'Avg Duration',  fmt:v=>fmtDur(v) },
    { value:'segs',       label:'Segment Count', fmt:v=>fmtI(v) },
    { value:'kbRate',     label:'KB Rate %',     fmt:v=>`${v}%` },
  ];
  const cDef = CHART_METRICS.find(c => c.value === chartMetric) || CHART_METRICS[0];

  return (
    <div className="space-y-4" data-tour="dept-comparison-title">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-display font-bold text-ink-900">Department Comparison</h1>
          <p className="text-xs text-ink-400 mt-0.5">{fmtI(deptRows.length)} departments · {fmtI(filteredSegs.length)} segments · {fmtI(filteredQc.length)} QC events</p>
        </div>
      </div>

      {/* Filters */}
      <div className="card-surface p-3 flex flex-wrap gap-3 items-end">
        {[['From',fFrom,setFFrom,'date'],['To',fTo,setFTo,'date']].map(([l,v,s,t])=>(
          <div key={l}>
            <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">{l}</label>
            <input type={t} value={v} onChange={e=>s(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400" />
          </div>
        ))}
        <div>
          <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">Order Type</label>
          <select value={fType} onChange={e=>setFType(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
            <option value="">All</option>
            <option value="evaluation">Evaluation</option>
            <option value="translation">Translation</option>
          </select>
        </div>
        {(fFrom||fTo||fType) && <button onClick={()=>{setFFrom('');setFTo('');setFType('');}} className="text-[11px] text-red-500 hover:text-red-700 font-medium self-end pb-1.5">Clear</button>}
      </div>

      {(kpiLoading || qcLoading) && <div className="text-center text-ink-400 py-10">Loading…</div>}

      {!kpiLoading && !qcLoading && deptRows.length > 0 && <>
        {/* Chart */}
        <div className="card-surface p-4 bg-slate-900">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <span className="text-xs font-semibold text-slate-400">Department {cDef.label}</span>
            <div className="flex gap-1 flex-wrap">
              {CHART_METRICS.map(c => (
                <button key={c.value} onClick={() => setChartMetric(c.value)}
                  className={`px-2.5 py-1 text-[11px] rounded font-medium transition-all ${chartMetric===c.value?'bg-brand-500 text-white':'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ left:0, right:8, top:4, bottom:60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="dept" tick={{ fill:'#94a3b8', fontSize:10 }} angle={-35} textAnchor="end" height={70} />
              <YAxis tick={{ fill:'#94a3b8', fontSize:10 }} tickFormatter={cDef.fmt} />
              <Tooltip {...TOOLTIP_STYLE}
                labelFormatter={(label) => label}
                formatter={(v, _name) => [cDef.fmt(v), cDef.label]} />
              <Bar dataKey={chartMetric} radius={[4,4,0,0]}>
                {chartData.map((_,i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Comparison table */}
        <div className="card-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-50 border-b border-surface-200">
                <tr>
                  {['Department','Segments','Orders','Workers','In-Range','Avg Dur','XpH','QC Events','KB Rate'].map(h => (
                    <th key={h} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deptRows.map((r, i) => (
                  <tr key={r.dept} className="border-b border-surface-100 hover:bg-surface-50 text-sm">
                    <td className="px-3 py-2.5 font-medium text-ink-900 max-w-[160px] truncate" style={{ borderLeft:`3px solid ${COLORS[i%COLORS.length]}` }}>
                      {r.dept}
                    </td>
                    <td className="px-3 py-2.5 min-w-[120px]">
                      <StatCell value={fmtI(r.segs)} max={maxVals.segs} color={COLORS[i%COLORS.length]} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-right">{fmtI(r.orders)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-right">{fmtI(r.workers)}</td>
                    <td className="px-3 py-2.5 min-w-[120px]">
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width:`${r.inRangePct}%`, background: r.inRangePct>=80?'#16a34a':r.inRangePct>=60?'#d97706':'#dc2626' }} />
                        </div>
                        <span className="font-mono text-xs text-ink-700 w-10 text-right">{r.inRangePct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-right">{fmtDur(r.avgDur)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-right">{fmt(r.xph)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-right">{fmtI(r.qcTotal)}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-xs font-semibold ${r.kbRate>20?'text-red-600':r.kbRate>10?'text-amber-600':'text-emerald-600'}`}>{r.kbRate}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>}

      {!kpiLoading && !qcLoading && deptRows.length === 0 && (
        <div className="card-surface flex flex-col items-center justify-center py-16 text-center">
          <div className="text-4xl mb-3 opacity-20">🏢</div>
          <p className="text-sm text-ink-400">No department data yet — department names populate after the first user sync completes.</p>
        </div>
      )}
    </div>
  );
}
