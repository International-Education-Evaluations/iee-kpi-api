import React, { useEffect, useMemo, useState, useDeferredValue } from 'react';
import { useData } from '../hooks/useData';
import { fmt, fmtI } from '../components/UI';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS = Array.from({length:24}, (_,i) => i);
const fmtHour = h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;

function heatColor(val, max) {
  if (max === 0 || val === 0) return 'bg-surface-100 text-ink-300';
  const pct = val / max;
  if (pct >= 0.8) return 'bg-brand-600 text-white';
  if (pct >= 0.6) return 'bg-brand-500 text-white';
  if (pct >= 0.4) return 'bg-brand-400 text-white';
  if (pct >= 0.2) return 'bg-brand-200 text-brand-900';
  return 'bg-brand-100 text-brand-700';
}

function heatColorStyle(val, max) {
  if (max === 0 || val === 0) return { background:'#f1f5f9', color:'#94a3b8' };
  const pct = val / max;
  const alpha = 0.1 + pct * 0.85;
  return { background:`rgba(0,174,239,${alpha})`, color: pct > 0.5 ? '#fff' : '#0369a1' };
}

export default function ShiftHeatmap() {
  const { kpiSegs, kpiLoading, loadKpi } = useData();
  const [metric, setMetric] = useState('count'); // count | avgDuration | xph
  const [fDept, setFDept]   = useState('');
  const [fFrom, setFFrom]   = useState('');
  const [fTo, setFTo]       = useState('');
  const [fType, setFType]   = useState('');

  const dFDept = useDeferredValue(fDept);
  const dFFrom = useDeferredValue(fFrom);
  const dFTo   = useDeferredValue(fTo);
  const dFType = useDeferredValue(fType);

  useEffect(() => { loadKpi(); }, [loadKpi]);

  const depts = useMemo(() => [...new Set(kpiSegs.map(s=>s.departmentName).filter(Boolean))].sort(), [kpiSegs]);

  const filtered = useMemo(() => kpiSegs.filter(s => {
    if (!s.segmentStart) return false;
    if (dFDept && s.departmentName !== dFDept) return false;
    if (dFType && s.orderType !== dFType) return false;
    if (dFFrom && s.segmentStart < dFFrom) return false;
    if (dFTo   && s.segmentStart > dFTo + 'T23:59:59') return false;
    return true;
  }), [kpiSegs, dFDept, dFFrom, dFTo, dFType]);

  // Build day × hour grid
  const grid = useMemo(() => {
    // grid[day][hour] = { count, totalMin, durCount }
    const g = Array.from({length:7}, () => Array.from({length:24}, () => ({ count:0, totalMin:0, durCount:0 })));
    for (const s of filtered) {
      const d = new Date(s.segmentStart);
      const day  = d.getUTCDay();
      const hour = d.getUTCHours();
      const cell = g[day][hour];
      cell.count++;
      if (!s.isOpen && s.durationMinutes > 0) { cell.totalMin += s.durationMinutes; cell.durCount++; }
    }
    return g;
  }, [filtered]);

  const getValue = (cell) => {
    if (metric === 'count') return cell.count;
    if (metric === 'avgDuration') return cell.durCount > 0 ? Math.round(cell.totalMin / cell.durCount * 10) / 10 : 0;
    // xph: segments per hour in that cell (each cell represents many occurrences of that hour/day combination)
    return cell.totalMin > 0 ? Math.round(cell.count / (cell.totalMin / 60) * 100) / 100 : 0;
  };

  const allVals = useMemo(() => {
    const vals = [];
    for (const day of grid) for (const cell of day) vals.push(getValue(cell));
    return vals;
  }, [grid, metric]);
  const maxVal = Math.max(...allVals, 1);

  // Summary stats
  const peakCell = useMemo(() => {
    let max = 0, pk = { day:0, hour:9 };
    for (let d=0; d<7; d++) for (let h=0; h<24; h++) {
      const v = getValue(grid[d][h]);
      if (v > max) { max = v; pk = { day:d, hour:h }; }
    }
    return pk;
  }, [grid, metric]);

  const hourTotals = useMemo(() => HOURS.map(h => {
    let t = 0; for (let d=0;d<7;d++) t += getValue(grid[d][h]); return t;
  }), [grid, metric]);
  const dayTotals = useMemo(() => DAYS.map((_,d) => {
    let t = 0; for (let h=0;h<24;h++) t += getValue(grid[d][h]); return t;
  }), [grid, metric]);
  const peakHour = HOURS.reduce((a,b) => hourTotals[a] >= hourTotals[b] ? a : b, 0);
  const peakDay  = DAYS.reduce((_,__,d,arr) => dayTotals[d] >= dayTotals[arr.indexOf(arr[d])] ? d : arr.indexOf(arr[d]), 0);

  const METRICS = [
    { value:'count', label:'Volume (segments)' },
    { value:'avgDuration', label:'Avg Duration (min)' },
    { value:'xph', label:'XpH (throughput)' },
  ];

  return (
    <div className="space-y-4" data-tour="heatmap-title">
      <div>
        <h1 className="text-xl font-display font-bold text-ink-900">Shift / Time-of-Day Heatmap</h1>
        <p className="text-xs text-ink-400 mt-0.5">Processing patterns by hour × day-of-week · {fmtI(filtered.length)} segments · times in UTC</p>
      </div>

      {/* Filters + metric */}
      <div className="card-surface p-3 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">Metric</label>
          <div className="flex gap-1">
            {METRICS.map(m => (
              <button key={m.value} onClick={()=>setMetric(m.value)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all ${metric===m.value?'bg-brand-500 text-white border-brand-500':'bg-white text-ink-600 border-surface-200 hover:border-brand-300'}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {depts.length > 0 && (
          <div>
            <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">Dept</label>
            <select value={fDept} onChange={e=>setFDept(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
              <option value="">All</option>
              {depts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
        {[['From',fFrom,setFFrom],['To',fTo,setFTo]].map(([l,v,s])=>(
          <div key={l}>
            <label className="block text-[10px] uppercase font-semibold text-ink-400 mb-1">{l}</label>
            <input type="date" value={v} onChange={e=>s(e.target.value)}
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
        {(fDept||fFrom||fTo||fType)&&<button onClick={()=>{setFDept('');setFFrom('');setFTo('');setFType('');}} className="text-[11px] text-red-500 hover:text-red-700 font-medium self-end pb-1.5">Clear</button>}
      </div>

      {kpiLoading && <div className="text-center text-ink-400 py-12">Loading…</div>}

      {!kpiLoading && filtered.length > 0 && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label:'Peak Hour', value:fmtHour(peakCell.hour), sub:`${DAYS[peakCell.day]}s` },
              { label:'Peak Day',  value:DAYS[dayTotals.indexOf(Math.max(...dayTotals))], sub:'most active' },
              { label:'Busiest Hour', value:fmtHour(peakHour), sub:`across all days` },
              { label:'Active Hours', value:allVals.filter(v=>v>0).length, sub:`of 168 slots` },
            ].map(c => (
              <div key={c.label} className="card-surface p-3">
                <div className="text-[10px] uppercase font-semibold text-ink-400 tracking-wider">{c.label}</div>
                <div className="text-lg font-display font-bold text-ink-900 mt-1">{c.value}</div>
                <div className="text-[10px] text-ink-400">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Heatmap */}
          <div className="card-surface p-4 overflow-x-auto">
            <div className="text-xs font-semibold text-ink-600 mb-3">
              {METRICS.find(m=>m.value===metric)?.label} by Day × Hour (UTC)
            </div>
            <div style={{ minWidth: 700 }}>
              {/* Hour labels */}
              <div className="flex ml-10 mb-1">
                {HOURS.filter(h => h % 2 === 0).map(h => (
                  <div key={h} className="text-center text-[9px] text-ink-400" style={{ width: `${100/24*2}%` }}>
                    {fmtHour(h)}
                  </div>
                ))}
              </div>
              {/* Grid rows */}
              {DAYS.map((day, di) => (
                <div key={day} className="flex items-center mb-px">
                  <div className="w-10 shrink-0 text-[10px] font-semibold text-ink-500 text-right pr-2">{day}</div>
                  {HOURS.map(h => {
                    const cell = grid[di][h];
                    const v = getValue(cell);
                    const style = heatColorStyle(v, maxVal);
                    return (
                      <div key={h} title={`${day} ${fmtHour(h)}: ${fmt(v)} ${metric==='count'?'segs':metric==='avgDuration'?'min avg':'xph'}`}
                        className="flex-1 h-7 flex items-center justify-center text-[9px] font-mono transition-colors cursor-default rounded-sm mx-px"
                        style={style}>
                        {v > 0 ? (metric==='count'?v:fmt(v)) : ''}
                      </div>
                    );
                  })}
                  <div className="w-10 shrink-0 text-[10px] font-mono text-ink-400 text-right pl-2">
                    {fmt(dayTotals[di])}
                  </div>
                </div>
              ))}
              {/* Hour totals row */}
              <div className="flex mt-1 ml-10">
                {HOURS.map(h => (
                  <div key={h} className="flex-1 text-center text-[9px] font-mono text-ink-400"
                    title={`${fmtHour(h)}: ${fmt(hourTotals[h])} total`}>
                    {hourTotals[h] > 0 ? fmt(hourTotals[h]) : ''}
                  </div>
                ))}
              </div>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-1 mt-3">
              <span className="text-[10px] text-ink-400 mr-1">Low</span>
              {[0.1,0.2,0.4,0.6,0.8,1.0].map(p => (
                <div key={p} className="w-5 h-3 rounded-sm" style={{ background:`rgba(0,174,239,${0.1+p*0.85})` }} />
              ))}
              <span className="text-[10px] text-ink-400 ml-1">High</span>
            </div>
          </div>
        </>
      )}

      {!kpiLoading && filtered.length === 0 && (
        <div className="card-surface flex items-center justify-center py-16 text-center">
          <p className="text-sm text-ink-400">No segment data for current filters.</p>
        </div>
      )}
    </div>
  );
}
