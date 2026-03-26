import React, { useEffect, useState, useMemo, useCallback, useDeferredValue } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ComposedChart, Bar, Line, LineChart, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, BarChart } from 'recharts';
import { Card, Table, FilterBar, FilterSelect, FilterInput, FilterReset, DatePresets,
         ChartLegend, DrilldownDrawer, OrderLink, Pills,
         TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs, fmtDateTime } from '../components/UI';
import { useData } from '../hooks/useData';
import { userGet, userSet } from '../hooks/useApi';

const BUCKET_COLORS = {
  'Exclude Short':'#94a3b8','Out-of-Range Short':'#F57F17','In-Range':'#16a34a',
  'Out-of-Range Long':'#E65100','Exclude Long':'#B71C1C','Unclassified':'#cbd5e1','Open':'#3b82f6'
};

function getMedian(arr) {
  if (!arr.length) return null;
  const s=[...arr].sort((a,b)=>a-b); const mid=Math.floor(s.length/2);
  return s.length%2?Math.round(s[mid]*10)/10:Math.round((s[mid-1]+s[mid])/2*10)/10;
}
function fmtDate(d) {
  if(!d)return''; const[,m,day]=d.split('-');
  const months=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return`${months[parseInt(m)]} ${parseInt(day)}`;
}

// ── Drilldown cols — full segment detail for a given status ──
const SEG_COLS = [
  { key:'orderSerialNumber', label:'Order',     w:110, sortable:true, render:v=><OrderLink serial={v} /> },
  { key:'segmentStart',      label:'Start',     w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'segmentEnd',        label:'End',       w:130, sortable:true, render:(v,r)=>r.isOpen?<span className="text-amber-500 text-[11px]">Open</span>:fmtDateTime(v) },
  { key:'durationMinutes',   label:'Duration',  w:85,  right:true, sortable:true, render:(v,r)=>r.isOpen?<span className="text-amber-600 text-[11px]">Open</span>:fmtDur(v) },
  { key:'durationSeconds',   label:'Sec',       w:65,  right:true, sortable:true, render:v=>v!=null?<span className="font-mono text-ink-400 text-[11px]">{Math.round(v)}</span>:'—' },
  { key:'orderType',         label:'Type',      w:80,  sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
  { key:'reportItemCount',   label:'Reports',   w:70,  right:true, sortable:true, render:v=>v>0?<span className="font-semibold text-ink-700">{v}</span>:<span className="text-ink-300">—</span> },
  { key:'changedByName',     label:'Changed By',w:130, sortable:true, render:v=>v||<span className="text-ink-300">—</span> },
  { key:'isErrorReporting',  label:'Error Rpt', w:75,  sortable:true, render:v=>v?<span className="badge badge-danger">Yes</span>:<span className="text-ink-300">—</span> },
  { key:'isOpen',            label:'State',     w:65,  sortable:true, render:v=><span className={`badge ${v?'badge-warning':'badge-success'}`}>{v?'Open':'Closed'}</span> },
  { key:'orderSource',       label:'Source',    w:80,  sortable:true, render:v=>v?<span className="text-[10px] text-ink-400 font-mono">{v}</span>:'—' },
];

// ── Orders worked cols (distinct orders this worker touched) ──
const ORDER_COLS = [
  { key:'orderSerialNumber', label:'Order',    w:110, sortable:true, render:v=><OrderLink serial={v} /> },
  { key:'orderType',         label:'Type',     w:80,  sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
  { key:'segCount',          label:'Segments', w:80,  right:true, sortable:true, render:v=>fmtI(v) },
  { key:'reportItemCount',   label:'Reports',  w:75,  right:true, sortable:true, render:v=>v>0?<span className="font-semibold">{v}</span>:'—' },
  { key:'totalMin',          label:'Total Time',w:90, right:true, sortable:true, render:v=>fmtDur(v) },
  { key:'firstSeg',          label:'First',    w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'lastSeg',           label:'Last',     w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'hasOpen',           label:'Open Seg', w:75,  sortable:true, render:v=>v?<span className="badge badge-warning">Open</span>:'—' },
];

export default function KPIUsers() {
  const { kpiSegs: segs, kpiLoading: loading, loadKpi } = useData();
  const [sp] = useSearchParams();
  // Persist selected worker per-user so navigation away and back restores the selection
  const [sel, setSelRaw] = useState(() => sp.get('worker') || userGet('kpiusers_sel') || '');
  const setSel = (v) => { setSelRaw(v); userSet('kpiusers_sel', v); };
  const [fFrom, setFFrom]     = useState('');
  const [fTo, setFTo]         = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fType, setFType]     = useState('');
  const [view, setViewRaw]    = useState(() => userGet('kpiusers_view') || 'status');
  const setView = (v) => { setViewRaw(v); userSet('kpiusers_view', v); };
  const [drawer, setDrawer]   = useState({ open:false, title:'', subtitle:'', rows:[], cols: SEG_COLS });

  const dSel     = useDeferredValue(sel);
  const dFFrom   = useDeferredValue(fFrom);
  const dFTo     = useDeferredValue(fTo);
  const dFStatus = useDeferredValue(fStatus);
  const dFType   = useDeferredValue(fType);

  useEffect(() => { loadKpi(); }, [loadKpi]);
  useEffect(() => { if (sp.get('worker')) setSel(sp.get('worker')); }, [sp]);

  const workers = useMemo(() => {
    const m = {};
    const counts = {};
    segs.forEach(s => {
      if (!s._workerId) return;
      const n = s.displayName || s.workerName || '';
      if (!n) return;
      if (!counts[s._workerId]) counts[s._workerId] = {};
      counts[s._workerId][n] = (counts[s._workerId][n] || 0) + 1;
    });
    for (const [id, nc] of Object.entries(counts)) {
      m[id] = Object.entries(nc).sort((a,b)=>b[1]-a[1])[0][0];
    }
    const labelCount = {};
    for (const label of Object.values(m)) labelCount[label] = (labelCount[label]||0)+1;
    return Object.entries(m)
      .map(([v,l]) => ({ value:v, label: labelCount[l]>1 ? `${l} [${v.slice(-4)}]` : l }))
      .sort((a,b) => a.label.localeCompare(b.label));
  }, [segs]);

  const userSegs = useMemo(() => {
    if (!dSel) return [];
    return segs.filter(s => {
      if (s._workerId !== dSel) return false;
      if (dFFrom && s.segmentStart && s.segmentStart < dFFrom) return false;
      if (dFTo   && s.segmentStart && s.segmentStart > dFTo + 'T23:59:59') return false;
      if (dFStatus && (s.statusName||s.statusSlug) !== dFStatus) return false;
      if (dFType && s.orderType !== dFType) return false;
      return true;
    });
  }, [segs, dSel, dFFrom, dFTo, dFStatus, dFType]);

  // ── Summary metrics ──────────────────────────────────────
  const m = useMemo(() => {
    if (!userSegs.length) return null;
    const closed  = userSegs.filter(s => !s.isOpen && s.durationMinutes > 0);
    const totalMin = closed.reduce((a,s) => a + (s.durationMinutes||0), 0);
    const xph     = totalMin > 0 ? closed.length / (totalMin/60) : 0;
    const orders  = new Set(userSegs.map(s=>s.orderSerialNumber).filter(Boolean));
    const totalReports = userSegs.reduce((a,s) => a + (s.reportItemCount||0), 0);
    const errorSegs = userSegs.filter(s => s.isErrorReporting).length;

    // week-over-week
    const now = new Date();
    const d7  = new Date(now - 7*86400000).toISOString();
    const d14 = new Date(now - 14*86400000).toISOString();
    const tw  = userSegs.filter(s => s.segmentStart >= d7).length;
    const lw  = userSegs.filter(s => s.segmentStart >= d14 && s.segmentStart < d7).length;

    return {
      total: userSegs.length, closed: closed.length,
      open: userSegs.filter(s=>s.isOpen).length,
      avg:    closed.length ? totalMin/closed.length : 0,
      median: getMedian(closed.map(s=>s.durationMinutes)),
      hrs:    totalMin/60,
      orders: orders.size,
      xph:    Math.round(xph*10)/10,
      totalReports,
      errorSegs,
      dept:   userSegs.find(s=>s.departmentName)?.departmentName || '',
      level:  userSegs.find(s=>s.userLevel)?.userLevel || '',
      volTrend: lw > 0 ? Math.round((tw-lw)/lw*100) : null,
    };
  }, [userSegs]);

  // ── Daily chart data ──────────────────────────────────────
  const daily = useMemo(() => {
    const d = {};
    userSegs.forEach(s => {
      const k = s.segmentStart?.substring(0,10); if (!k) return;
      if (!d[k]) d[k] = { date:k, segs:0, min:0, closed:0, orders:new Set() };
      d[k].segs++;
      if (!s.isOpen && s.durationMinutes>0) { d[k].min += s.durationMinutes; d[k].closed++; }
      if (s.orderSerialNumber) d[k].orders.add(s.orderSerialNumber);
    });
    return Object.values(d).sort((a,b) => a.date.localeCompare(b.date)).map(d => ({
      ...d,
      orders: d.orders.size,
      avg: d.closed ? Math.round(d.min/d.closed*10)/10 : 0,
      xph: d.min>0 ? Math.round(d.closed/(d.min/60)*10)/10 : 0,
      label: fmtDate(d.date),
    }));
  }, [userSegs]);

  // ── By Status breakdown ───────────────────────────────────
  const byStatus = useMemo(() => {
    const d = {};
    userSegs.forEach(s => {
      const k = s.statusName||s.statusSlug;
      if (!d[k]) d[k] = { status:k, count:0, totalMin:0, closed:0, open:0, orders:new Set(), durations:[] };
      d[k].count++;
      if (!s.isOpen && s.durationMinutes>0) { d[k].totalMin+=s.durationMinutes; d[k].closed++; d[k].durations.push(s.durationMinutes); }
      if (s.isOpen) d[k].open++;
      if (s.orderSerialNumber) d[k].orders.add(s.orderSerialNumber);
    });
    return Object.values(d).map(d => ({
      ...d,
      orders: d.orders.size,
      avg:    d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null,
      median: getMedian(d.durations),
      hrs:    Math.round(d.totalMin/60*10)/10,
      xph:    d.totalMin>0 ? Math.round(d.closed/(d.totalMin/60)*10)/10 : null,
      pct:    userSegs.length ? Math.round(d.count/userSegs.length*100) : 0,
    })).sort((a,b) => b.count-a.count);
  }, [userSegs]);

  // ── Orders worked ─────────────────────────────────────────
  const ordersWorked = useMemo(() => {
    const m = {};
    userSegs.forEach(s => {
      const k = s.orderSerialNumber; if (!k) return;
      if (!m[k]) m[k] = { orderSerialNumber:k, orderType:s.orderType, segCount:0, totalMin:0, reportItemCount:s.reportItemCount||0, firstSeg:s.segmentStart, lastSeg:s.segmentStart, hasOpen:false };
      m[k].segCount++;
      if (!s.isOpen && s.durationMinutes>0) m[k].totalMin += s.durationMinutes;
      if (s.isOpen) m[k].hasOpen = true;
      if (s.segmentStart < m[k].firstSeg) m[k].firstSeg = s.segmentStart;
      if (s.segmentStart > m[k].lastSeg)  m[k].lastSeg  = s.segmentStart;
    });
    return Object.values(m).sort((a,b) => (b.lastSeg||'').localeCompare(a.lastSeg||''));
  }, [userSegs]);

  // ── Full segment detail (all segments, most recent first) ─
  const segDetail = useMemo(() =>
    userSegs.slice().sort((a,b) => (b.segmentStart||'').localeCompare(a.segmentStart||'')),
  [userSegs]);

  // ── XpH weekly trend ─────────────────────────────────────
  const xphByWeek = useMemo(() => {
    const w = {};
    userSegs.filter(s=>!s.isOpen&&s.durationMinutes>0).forEach(s => {
      const d = new Date(s.segmentStart);
      const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1);
      const k = mon.toISOString().substring(0,10);
      if (!w[k]) w[k] = { week:k, segs:0, min:0 };
      w[k].segs++; w[k].min += s.durationMinutes;
    });
    return Object.values(w).sort((a,b)=>a.week.localeCompare(b.week)).map(w=>({
      ...w, xph: w.min>0 ? Math.round(w.segs/(w.min/60)*10)/10 : 0, label: fmtDate(w.week),
    }));
  }, [userSegs]);

  const statuses  = useMemo(() => [...new Set(segs.filter(s=>s._workerId===sel).map(s=>s.statusName||s.statusSlug).filter(Boolean))].sort(), [segs,sel]);
  const selName   = workers.find(w=>w.value===sel)?.label || '';
  const hasFilters = fFrom||fTo||fStatus||fType;

  // ── Drilldown handlers ────────────────────────────────────
  const openStatusDrawer = useCallback((row) => {
    const rows = userSegs.filter(s=>(s.statusName||s.statusSlug)===row.status)
      .sort((a,b)=>(b.segmentStart||'').localeCompare(a.segmentStart||''));
    setDrawer({ open:true, cols:SEG_COLS,
      title: `${selName} — ${row.status}`,
      subtitle: `${fmtI(row.count)} segments · ${fmtI(row.closed)} closed · ${row.open} open · Avg ${fmtDur(row.avg)} · ${row.orders} orders`,
      rows });
  }, [userSegs, selName]);

  const openOrderDrawer = useCallback((row) => {
    const rows = userSegs.filter(s=>s.orderSerialNumber===row.orderSerialNumber)
      .sort((a,b)=>(b.segmentStart||'').localeCompare(a.segmentStart||''));
    setDrawer({ open:true, cols:SEG_COLS,
      title: row.orderSerialNumber,
      subtitle: `${row.segCount} segments · ${fmtDur(row.totalMin)} total · ${row.orderType}`,
      rows });
  }, [userSegs]);

  // ── Table col defs ────────────────────────────────────────
  const statusCols = [
    {key:'status',  label:'Status',    w:180, sortable:true},
    {key:'count',   label:'Segments',  w:80,  right:true, sortable:true, render:v=>fmtI(v)},
    {key:'pct',     label:'Share',     w:55,  right:true, sortable:true, render:v=><span className="text-ink-400">{v}%</span>},
    {key:'orders',  label:'Orders',    w:65,  right:true, sortable:true, render:v=>fmtI(v)},
    {key:'closed',  label:'Closed',    w:65,  right:true, sortable:true, render:v=>fmtI(v)},
    {key:'open',    label:'Open',      w:55,  right:true, sortable:true, render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
    {key:'avg',     label:'Avg',       w:70,  right:true, sortable:true, render:v=>v!=null?fmtDur(v):'—'},
    {key:'median',  label:'Median',    w:70,  right:true, sortable:true, render:v=>v!=null?fmtDur(v):'—'},
    {key:'xph',     label:'XpH',       w:65,  right:true, sortable:true, render:v=>v!=null?<span className="font-semibold text-brand-600">{fmt(v)}</span>:'—'},
    {key:'hrs',     label:'Total Hrs', w:80,  right:true, sortable:true, render:v=>fmtHrs(v)},
  ];

  const segDetailCols = [
    {key:'orderSerialNumber', label:'Order',     w:110, sortable:true, render:v=><OrderLink serial={v} />},
    {key:'segmentStart',      label:'Start',     w:130, sortable:true, render:v=>fmtDateTime(v)},
    {key:'statusName',        label:'Status',    w:170, sortable:true},
    {key:'durationMinutes',   label:'Duration',  w:85,  right:true, sortable:true, render:(v,r)=>r.isOpen?<span className="text-amber-600">Open</span>:fmtDur(v)},
    {key:'durationSeconds',   label:'Sec',       w:65,  right:true, sortable:true, render:v=>v!=null?<span className="font-mono text-[11px] text-ink-400">{Math.round(v)}</span>:'—'},
    {key:'orderType',         label:'Type',      w:80,  sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span>},
    {key:'reportItemCount',   label:'Reports',   w:70,  right:true, sortable:true, render:v=>v>0?<span className="font-semibold">{v}</span>:<span className="text-ink-300">—</span>},
    {key:'changedByName',     label:'Changed By',w:130, sortable:true, render:v=>v||<span className="text-ink-300">—</span>},
    {key:'isErrorReporting',  label:'Err Rpt',   w:65,  sortable:true, render:v=>v?<span className="badge badge-danger">Yes</span>:'—'},
    {key:'isOpen',            label:'State',     w:65,  sortable:true, render:v=><span className={`badge ${v?'badge-warning':'badge-success'}`}>{v?'Open':'Closed'}</span>},
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900" data-tour="user-drilldown-title">User Drill-Down</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Individual worker performance · Last 60 days</p>
      </div>

      {!sel ? (
        <div className="card-surface p-8 sm:p-12 text-center">
          <div className="text-4xl mb-3 opacity-30">◉</div>
          <h3 className="text-lg font-display font-bold text-ink-700 mb-1">Select a Worker</h3>
          <p className="text-sm text-ink-400 mb-4">Choose a team member to see their full performance breakdown.</p>
          <div className="max-w-xs mx-auto">
            <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
          </div>
        </div>
      ) : <>

        {/* Filters */}
        <FilterBar>
          <FilterSelect label="Worker"     value={sel}     onChange={setSel}     options={workers} allLabel="Select worker..." />
          <FilterSelect label="Status"     value={fStatus} onChange={setFStatus} options={statuses} />
          <FilterSelect label="Order Type" value={fType}   onChange={setFType}   options={['evaluation','translation']} />
          <FilterInput  label="From"       value={fFrom}   onChange={setFFrom}   type="date" />
          <FilterInput  label="To"         value={fTo}     onChange={setFTo}     type="date" />
          <DatePresets onSelect={(from,to)=>{ setFFrom(from); setFTo(to); }} />
          {hasFilters && <FilterReset onClick={()=>{setFFrom('');setFTo('');setFStatus('');setFType('');}} />}
        </FilterBar>

        {/* Worker identity bar */}
        <div className="flex items-center gap-3 text-xs text-ink-500 flex-wrap">
          <span className="font-semibold text-ink-800 text-sm">{selName}</span>
          {m?.dept  && <><span className="text-ink-300">·</span><span>{m.dept}</span></>}
          {m?.level && <><span className="text-ink-300">·</span><span className="badge badge-info">{m.level}</span></>}
          {m?.volTrend != null && m.volTrend !== 0 && (
            <span className={`text-[10px] font-semibold ${m.volTrend>0?'text-emerald-600':'text-red-500'}`}>
              {m.volTrend>0?'↑':'↓'} {Math.abs(m.volTrend)}% vol w/w
            </span>
          )}
        </div>

        {/* Metric cards — expanded set */}
        <div className="metric-grid">
          <Card label="Segments"     value={fmtI(m?.total)}               loading={loading} trend={m?.volTrend} />
          <Card label="Closed"       value={fmtI(m?.closed)}   color="green"  loading={loading} />
          <Card label="Open"         value={fmtI(m?.open)}     color="amber"  loading={loading} />
          <Card label="Avg Duration" value={fmtDur(m?.avg)}    color="brand"  loading={loading} />
          <Card label="Median"       value={fmtDur(m?.median)} color="slate"  loading={loading} />
          <Card label="Total Hours"  value={fmtHrs(m?.hrs)}    color="navy"   loading={loading} />
          <Card label="XpH"          value={m?.xph?fmt(m.xph):'—'} sub="segs/hr" color="plum" loading={loading} />
          <Card label="Orders"       value={fmtI(m?.orders)}   color="brand"  loading={loading} />
          <Card label="Reports"      value={fmtI(m?.totalReports)} color="slate" loading={loading} />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Daily volume + avg duration */}
          <div className="card-surface p-4">
            <div className="text-xs font-semibold text-ink-600 mb-3">Daily Volume + Avg Duration</div>
            {daily.length > 0 ? <>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={daily} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(daily.length/12))} />
                  <YAxis yAxisId="left"  tick={{fill:'#64748b',fontSize:10}} />
                  <YAxis yAxisId="right" orientation="right" tick={{fill:'#16a34a',fontSize:10}} tickFormatter={v=>`${v}m`} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.date||''}
                    formatter={(v,n)=>n==='segs'?[fmtI(v),'Segments']:[`${fmt(v)} min`,'Avg Duration']} />
                  <Bar  yAxisId="left"  dataKey="segs" fill="#00aeef" radius={[3,3,0,0]} opacity={0.8} />
                  <Line yAxisId="right" dataKey="avg"  stroke="#16a34a" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <ChartLegend items={[{label:'Segments',color:'#00aeef'},{label:'Avg Duration',color:'#16a34a'}]} />
            </> : <div className="h-60 flex items-center justify-center text-ink-400 text-sm">No data</div>}
          </div>

          {/* XpH weekly trend */}
          <div className="card-surface p-4">
            <div className="text-xs font-semibold text-ink-600 mb-3">XpH Weekly Trend</div>
            {xphByWeek.length > 0 ? <>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={xphByWeek} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(xphByWeek.length/10))} />
                  <YAxis yAxisId="left" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>`${v}`} />
                  <YAxis yAxisId="right" orientation="right" tick={{fill:'#00aeef',fontSize:10}} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.week||''}
                    formatter={(v,n)=>n==='xph'?[fmt(v),'XpH']:[fmtI(v),'Segments']} />
                  <Bar  yAxisId="right" dataKey="segs" fill="#00aeef" opacity={0.25} radius={[3,3,0,0]} />
                  <Line yAxisId="left"  dataKey="xph"  stroke="#7c3aed" strokeWidth={2.5} dot={{r:3,fill:'#7c3aed'}} activeDot={{r:5}} />
                </ComposedChart>
              </ResponsiveContainer>
              <ChartLegend items={[{label:'XpH',color:'#7c3aed'},{label:'Segments',color:'#00aeef'}]} />
            </> : <div className="h-60 flex items-center justify-center text-ink-400 text-sm">No data</div>}
          </div>
        </div>

        {/* Tabbed breakdown */}
        <div className="card-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-semibold text-ink-600">Breakdown</span>
            <Pills
              tabs={[
                {key:'status',   label:`By Status (${byStatus.length})`},
                {key:'orders',   label:`Orders (${ordersWorked.length})`},
                {key:'segments', label:`All Segments (${fmtI(segDetail.length)})`},
              ]}
              active={view} onChange={setView}
            />
          </div>

          {view === 'status' && (
            <Table cols={statusCols} rows={byStatus} defaultSort="count" defaultSortDir="desc"
              searchKey="status" searchPlaceholder="Search statuses…"
              onRow={openStatusDrawer} maxHeight="500px" />
          )}

          {view === 'orders' && (
            <Table cols={ORDER_COLS} rows={ordersWorked} defaultSort="lastSeg" defaultSortDir="desc"
              searchKey="orderSerialNumber" searchPlaceholder="Search order numbers…"
              onRow={openOrderDrawer} maxHeight="500px" />
          )}

          {view === 'segments' && (
            <Table cols={segDetailCols} rows={segDetail} defaultSort="segmentStart" defaultSortDir="desc"
              searchKey="orderSerialNumber" searchPlaceholder="Search order, status…"
              maxHeight="600px" />
          )}
        </div>

        {/* Drilldown drawer */}
        <DrilldownDrawer
          open={drawer.open}
          onClose={() => setDrawer(d=>({...d,open:false}))}
          title={drawer.title}
          subtitle={drawer.subtitle}
          rows={drawer.rows}
          cols={drawer.cols}
        />
      </>}
    </div>
  );
}
