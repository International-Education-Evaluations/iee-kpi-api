import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';
import { Card, Table, Section, Pills, Skel, FilterBar, FilterSelect, FilterInput, FilterReset, ChartLegend, TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs } from '../components/UI';
import DashboardGrid, { Widget } from '../components/DashboardGrid';
import { useData } from '../hooks/useData';

const BUCKET_COLORS = { 'Exclude Short':'#94a3b8', 'Out-of-Range Short':'#F57F17', 'In-Range':'#16a34a', 'Out-of-Range Long':'#E65100', 'Exclude Long':'#B71C1C', 'Unclassified':'#cbd5e1', 'Open':'#3b82f6' };

const DEFAULT_LAYOUT = [
  { i: 'filters', x: 0, y: 0, w: 12, h: 1, static: true },
  { i: 'cards', x: 0, y: 1, w: 12, h: 2, minH: 2 },
  { i: 'buckets', x: 0, y: 3, w: 5, h: 4, minW: 3, minH: 3 },
  { i: 'bucketChart', x: 5, y: 3, w: 7, h: 4, minW: 4, minH: 3 },
  { i: 'byStatus', x: 0, y: 7, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'daily', x: 6, y: 7, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'breakdown', x: 0, y: 12, w: 12, h: 6, minW: 6, minH: 4 },
];

export default function KPIOverview() {
  const { kpiSegs: segs, classified, kpiLoading: loading, loadKpi } = useData();
  const [view, setView] = useState('status');
  const [fType, setFType] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fWorker, setFWorker] = useState('');
  const nav = useNavigate();

  useEffect(() => { loadKpi(); }, [loadKpi]);

  const workers = useMemo(() => {
    const m = {};
    segs.forEach(s => { if (s._workerId) m[s._workerId] = s.displayName || s.workerName; });
    return Object.entries(m).map(([v,l]) => ({value:v,label:l})).sort((a,b) => a.label.localeCompare(b.label));
  }, [segs]);

  const filtered = useMemo(() => segs.filter(s => {
    if (fType && s.orderType !== fType) return false;
    if (fWorker && s._workerId !== fWorker) return false;
    if (fFrom && s.segmentStart && s.segmentStart < fFrom) return false;
    if (fTo && s.segmentStart && s.segmentStart > fTo + 'T23:59:59') return false;
    return true;
  }), [segs, fType, fFrom, fTo, fWorker]);

  // ── Metrics with week-over-week trend ───────────────────
  const metrics = useMemo(() => {
    if (!filtered.length) return null;
    const closed = filtered.filter(s => !s.isOpen && s.durationMinutes > 0);
    const totalMin = closed.reduce((a,s) => a + (s.durationMinutes||0), 0);
    const total = filtered.length;

    // Week-over-week trend: compare last 7 days vs prior 7 days
    const now = new Date();
    const d7 = new Date(now - 7*86400000).toISOString();
    const d14 = new Date(now - 14*86400000).toISOString();
    const thisWeek = filtered.filter(s => s.segmentStart >= d7).length;
    const lastWeek = filtered.filter(s => s.segmentStart >= d14 && s.segmentStart < d7).length;
    const volTrend = lastWeek > 0 ? Math.round((thisWeek - lastWeek) / lastWeek * 100) : null;

    return {
      total, closed: closed.length, open: filtered.filter(s=>s.isOpen).length,
      avg: closed.length ? totalMin/closed.length : 0,
      median: getMedian(closed.map(s => s.durationMinutes)),
      hrs: totalMin/60,
      workers: new Set(filtered.map(s=>s._workerId).filter(Boolean)).size,
      orders: new Set(filtered.map(s=>s.orderSerialNumber).filter(Boolean)).size,
      volTrend,
    };
  }, [filtered]);

  const bucketStats = classified?.classification || null;
  const bucketChartData = useMemo(() => {
    if (!bucketStats?.bucketCounts) return [];
    const order = ['Exclude Short', 'Out-of-Range Short', 'In-Range', 'Out-of-Range Long', 'Exclude Long', 'Unclassified', 'Open'];
    return order.filter(b => bucketStats.bucketCounts[b]).map(b => ({
      bucket: b.replace('Out-of-Range ', 'OOR ').replace('Exclude ', 'Excl '),
      fullName: b,
      count: bucketStats.bucketCounts[b],
      fill: BUCKET_COLORS[b]
    }));
  }, [bucketStats]);

  const byStatus = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s.statusName||s.statusSlug||'Unknown';
      if (!m[k]) m[k] = {status:k,count:0,totalMin:0,closed:0,open:0,durations:[]};
      m[k].count++;
      if (!s.isOpen && s.durationMinutes>0) { m[k].totalMin+=s.durationMinutes; m[k].closed++; m[k].durations.push(s.durationMinutes); }
      if(s.isOpen) m[k].open++;
    });
    return Object.values(m).map(d=>({
      ...d,
      avg: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null,
      median: getMedian(d.durations),
      hrs: Math.round(d.totalMin/60*10)/10,
      pct: filtered.length ? Math.round(d.count/filtered.length*100) : 0,
    })).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  const byWorker = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s._workerId||'none';
      if (!m[k]) m[k] = {worker:s.displayName||s.workerName||'UNATTRIBUTED',workerId:k,count:0,totalMin:0,closed:0,orders:new Set()};
      m[k].count++;
      if(!s.isOpen&&s.durationMinutes>0){m[k].totalMin+=s.durationMinutes;m[k].closed++;}
      if(s.orderSerialNumber) m[k].orders.add(s.orderSerialNumber);
    });
    return Object.values(m).map(d=>({
      ...d,
      orders: d.orders.size,
      avg: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null,
      hrs: Math.round(d.totalMin/60*10)/10,
      xph: d.totalMin > 0 ? Math.round(d.closed / (d.totalMin/60) * 10) / 10 : null,
    })).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  const daily = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const d = s.segmentStart?.substring(0,10);
      if(!d) return;
      if(!m[d]) m[d]={date:d,count:0,closed:0,totalMin:0};
      m[d].count++;
      if(!s.isOpen&&s.durationMinutes>0){m[d].closed++;m[d].totalMin+=s.durationMinutes;}
    });
    return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({
      ...d,
      avg: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : 0,
      label: formatDateShort(d.date),
    }));
  }, [filtered]);

  const clearFilters = () => { setFType(''); setFFrom(''); setFTo(''); setFWorker(''); };

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">KPI Overview</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Processing performance · Last 60 days · {fmtI(segs.length)} segments loaded</p>
      </div>

      <DashboardGrid pageId="kpi-overview" defaultLayout={DEFAULT_LAYOUT}>
        {/* Filters */}
        <div key="filters">
          <FilterBar>
            <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
            <FilterSelect label="Worker" value={fWorker} onChange={setFWorker} options={workers} allLabel="All Workers" />
            <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
            <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
            {(fType||fWorker||fFrom||fTo) && <FilterReset onClick={clearFilters} />}
          </FilterBar>
        </div>

        {/* Metric Cards */}
        <div key="cards">
          <Widget title="Key Metrics">
            <div className="metric-grid">
              <Card label="Total Segments" value={fmtI(metrics?.total)} loading={loading} trend={metrics?.volTrend} icon="◈" />
              <Card label="Closed" value={fmtI(metrics?.closed)} color="green" loading={loading} icon="✓" />
              <Card label="Open" value={fmtI(metrics?.open)} color="amber" loading={loading} icon="◌" />
              <Card label="Avg Duration" value={fmtDur(metrics?.avg)} color="brand" loading={loading} />
              <Card label="Median Duration" value={fmtDur(metrics?.median)} color="slate" loading={loading} />
              <Card label="Workers" value={fmtI(metrics?.workers)} color="plum" loading={loading} />
              <Card label="Orders" value={fmtI(metrics?.orders)} color="navy" loading={loading} />
            </div>
          </Widget>
        </div>

        {/* 5-Bucket Classification — visual progress bar */}
        <div key="buckets">
          <Widget title="5-Bucket Classification">
            {bucketStats ? <div className="space-y-3">
              {/* Hero metric */}
              <div className="text-center py-2">
                <div className="text-3xl font-display font-bold text-emerald-600">{bucketStats.inRangePercent}%</div>
                <div className="text-[11px] text-ink-400 font-medium">In-Range Rate</div>
              </div>
              {/* Progress bar */}
              <div className="h-3 rounded-full overflow-hidden flex bg-surface-100">
                {[
                  { pct: bucketStats.excludeShortPercent, color: '#94a3b8' },
                  { pct: bucketStats.outRangeShortPercent, color: '#F57F17' },
                  { pct: bucketStats.inRangePercent, color: '#16a34a' },
                  { pct: bucketStats.outRangeLongPercent, color: '#E65100' },
                  { pct: bucketStats.excludeLongPercent, color: '#B71C1C' },
                ].filter(b => b.pct > 0).map((b, i) => (
                  <div key={i} style={{ width: `${b.pct}%`, background: b.color }} className="h-full transition-all" title={`${b.pct}%`} />
                ))}
              </div>
              {/* Legend grid */}
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-amber-600" />Out Short: {bucketStats.outRangeShortPercent}%</div>
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{background:'#E65100'}} />Out Long: {bucketStats.outRangeLongPercent}%</div>
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-slate-400" />Excl Short: {bucketStats.excludeShortPercent||0}%</div>
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-red-800" />Excl Long: {bucketStats.excludeLongPercent||0}%</div>
              </div>
            </div> : <div className="text-ink-400 text-xs p-4 text-center">Configure benchmarks in Settings to enable classification</div>}
          </Widget>
        </div>

        {/* Bucket Distribution Chart */}
        <div key="bucketChart">
          <Widget title="Bucket Distribution">
            {bucketChartData.length > 0 ? <>
              <ResponsiveContainer width="100%" height="85%">
                <BarChart data={bucketChartData} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="bucket" tick={{fill:'#64748b',fontSize:10}} angle={-15} textAnchor="end" height={45} interval={0} />
                  <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v,n,p) => [fmtI(v), p.payload.fullName]} labelFormatter={() => ''} />
                  <Bar dataKey="count" radius={[4,4,0,0]}>
                    {bucketChartData.map((d,i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </> : <div className="text-ink-400 text-xs p-4 text-center">Run classification to see bucket distribution</div>}
          </Widget>
        </div>

        {/* Segments by Status */}
        <div key="byStatus">
          <Widget title="Top Statuses by Volume">
            {loading ? <Skel rows={6} cols={1} /> :
            <ResponsiveContainer width="100%" height="90%">
              <BarChart data={byStatus.slice(0,10)} layout="vertical" margin={{left:5,right:20}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="status" width={140} tick={{fill:'#334155',fontSize:11}} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => {
                  if (n==='count') return [fmtI(v), 'Segments'];
                  return [v, n];
                }} />
                <Bar dataKey="count" fill="#00aeef" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>}
          </Widget>
        </div>

        {/* Daily Volume */}
        <div key="daily">
          <Widget title="Daily Segment Volume">
            {loading ? <Skel rows={6} cols={1} /> :
            <ResponsiveContainer width="100%" height="90%">
              <BarChart data={daily} margin={{left:0,right:10,bottom:5}}>
                <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0, Math.floor(daily.length / 15))} />
                <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <Tooltip {...TOOLTIP_STYLE}
                  labelFormatter={(_,payload) => payload?.[0]?.payload?.date || ''}
                  formatter={(v,n) => [fmtI(v), n === 'count' ? 'Segments' : n]} />
                <Bar dataKey="count" fill="#16a34a" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>}
          </Widget>
        </div>

        {/* Breakdown Table */}
        <div key="breakdown">
          <Widget title={<div className="flex items-center justify-between w-full">
            <span>Breakdown</span>
            <Pills tabs={[{key:'status',label:'By Status'},{key:'worker',label:'By Worker'}]} active={view} onChange={setView} />
          </div>}>
            {view === 'status' ?
              <Table cols={[
                {key:'status',label:'Status',w:180},
                {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
                {key:'pct',label:'%',right:true,render:v=><span className="text-ink-400">{v}%</span>},
                {key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},
                {key:'open',label:'Open',right:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
                {key:'avg',label:'Avg',right:true,render:v=>v!=null?fmtDur(v):'—'},
                {key:'median',label:'Median',right:true,render:v=>v!=null?fmtDur(v):'—'},
                {key:'hrs',label:'Total Hrs',right:true,render:v=>fmtHrs(v)},
              ]} rows={byStatus} />
            :
              <Table cols={[
                {key:'worker',label:'Worker',w:180},
                {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
                {key:'orders',label:'Orders',right:true,render:v=>fmtI(v)},
                {key:'avg',label:'Avg',right:true,render:v=>v!=null?fmtDur(v):'—'},
                {key:'hrs',label:'Total Hrs',right:true,render:v=>fmtHrs(v)},
                {key:'xph',label:'XpH',right:true,render:v=>v!=null?<span className="font-semibold text-brand-600">{fmt(v)}</span>:'—'},
              ]} rows={byWorker} onRow={r => r.workerId !== 'none' && nav(`/kpi/users?worker=${r.workerId}`)} />
            }
          </Widget>
        </div>
      </DashboardGrid>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────
function getMedian(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? Math.round(s[mid]*10)/10 : Math.round((s[mid-1]+s[mid])/2*10)/10;
}

function formatDateShort(d) {
  if (!d) return '';
  const [,m,day] = d.split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)]} ${parseInt(day)}`;
}
