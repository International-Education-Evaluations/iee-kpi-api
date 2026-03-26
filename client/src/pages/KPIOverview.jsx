import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Card, Table, Pills, FilterBar, FilterSelect, FilterInput, FilterReset, ChartLegend, TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs } from '../components/UI';
import { api } from '../hooks/useApi';
import { useData } from '../hooks/useData';

const BUCKET_COLORS = { 'Exclude Short':'#94a3b8', 'Out-of-Range Short':'#F57F17', 'In-Range':'#16a34a', 'Out-of-Range Long':'#E65100', 'Exclude Long':'#B71C1C', 'Unclassified':'#cbd5e1', 'Open':'#3b82f6' };
const ORDER_URL = 'https://admin.prod.iee.com/orders/';

export default function KPIOverview() {
  const { kpiSegs: segs, kpiLoading: loading, loadKpi } = useData();
  const [benchmarks, setBenchmarks] = useState([]);
  const [view, setView] = useState('status');
  const [fType, setFType] = useState('');
  const [fDept, setFDept] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fWorker, setFWorker] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [showSegs, setShowSegs] = useState(false);
  const nav = useNavigate();

  useEffect(() => { loadKpi(); }, [loadKpi]);

  // Load benchmarks for client-side classification
  useEffect(() => {
    api('/config/benchmarks').then(d => setBenchmarks(d.benchmarks || [])).catch(() => {});
  }, []);

  // Client-side 5-bucket classification
  const classifySegment = useMemo(() => {
    const benchMap = {};
    for (const b of benchmarks) {
      if (b.status) benchMap[b.status] = b;
    }
    return (s) => {
      if (s.isOpen) return 'Open';
      if (s.durationMinutes == null) return 'Unclassified';
      const b = benchMap[s.statusSlug];
      if (!b) return 'Unclassified';
      const dur = s.durationMinutes;
      const exShort = b.excludeShortMin ?? 0.5;
      const irMin = b.inRangeMin ?? 1;
      const irMax = b.inRangeMax ?? 120;
      const exLong = b.excludeLongMax ?? 480;
      if (dur < exShort) return 'Exclude Short';
      if (dur < irMin) return 'Out-of-Range Short';
      if (dur <= irMax) return 'In-Range';
      if (dur <= exLong) return 'Out-of-Range Long';
      return 'Exclude Long';
    };
  }, [benchmarks]);

  // Dropdown options
  const workers = useMemo(() => {
    const m = {};
    segs.forEach(s => { if (s._workerId) m[s._workerId] = s.displayName || s.workerName; });
    return Object.entries(m).map(([v,l]) => ({value:v,label:l})).sort((a,b) => a.label.localeCompare(b.label));
  }, [segs]);
  const statuses = useMemo(() => [...new Set(segs.map(s => s.statusName || s.statusSlug).filter(Boolean))].sort(), [segs]);
  const depts = useMemo(() => [...new Set(segs.map(s => s.departmentName).filter(Boolean))].sort(), [segs]);

  // Filtered
  const filtered = useMemo(() => segs.filter(s => {
    if (fType && s.orderType !== fType) return false;
    if (fDept && s.departmentName !== fDept) return false;
    if (fWorker && s._workerId !== fWorker) return false;
    if (fStatus && (s.statusName||s.statusSlug) !== fStatus) return false;
    if (fFrom && s.segmentStart && s.segmentStart < fFrom) return false;
    if (fTo && s.segmentStart && s.segmentStart > fTo + 'T23:59:59') return false;
    return true;
  }), [segs, fType, fDept, fFrom, fTo, fWorker, fStatus]);

  // Metrics
  const metrics = useMemo(() => {
    if (!filtered.length) return null;
    const closed = filtered.filter(s => !s.isOpen && s.durationMinutes > 0);
    const totalMin = closed.reduce((a,s) => a + (s.durationMinutes||0), 0);
    const now = new Date();
    const d7 = new Date(now - 7*86400000).toISOString();
    const d14 = new Date(now - 14*86400000).toISOString();
    const thisWeek = filtered.filter(s => s.segmentStart >= d7).length;
    const lastWeek = filtered.filter(s => s.segmentStart >= d14 && s.segmentStart < d7).length;
    const volTrend = lastWeek > 0 ? Math.round((thisWeek - lastWeek) / lastWeek * 100) : null;
    const inRange = filtered.filter(s => classifySegment(s) === 'In-Range').length;
    const scorable = closed.length || 1;
    return {
      total: filtered.length, closed: closed.length, open: filtered.filter(s=>s.isOpen).length,
      avg: closed.length ? totalMin/closed.length : 0,
      median: getMedian(closed.map(s => s.durationMinutes)),
      hrs: totalMin/60,
      workers: new Set(filtered.map(s=>s._workerId).filter(Boolean)).size,
      orders: new Set(filtered.map(s=>s.orderSerialNumber).filter(Boolean)).size,
      depts: new Set(filtered.map(s=>s.departmentName).filter(Boolean)).size,
      volTrend,
      inRangePct: Math.round(inRange / scorable * 1000) / 10,
    };
  }, [filtered]);

  // Bucket data — client-side classification
  const bucketData = useMemo(() => {
    if (!benchmarks.length) return [];
    const counts = {};
    filtered.forEach(s => { const b = classifySegment(s); counts[b] = (counts[b]||0) + 1; });
    const total = filtered.length || 1;
    const order = ['Exclude Short','Out-of-Range Short','In-Range','Out-of-Range Long','Exclude Long','Unclassified','Open'];
    return order.filter(b => counts[b]).map(b => ({
      bucket: b.replace('Out-of-Range ','OOR ').replace('Exclude ','Excl '), fullName: b,
      count: counts[b], fill: BUCKET_COLORS[b],
      pct: Math.round(counts[b]/total*1000)/10,
    }));
  }, [filtered, benchmarks, classifySegment]);

  // By Status — full parity with GAS KPI_BY_STATUS
  const byStatus = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s.statusName||s.statusSlug||'Unknown';
      if (!m[k]) m[k] = {status:k, slug: s.statusSlug||'', count:0, totalMin:0, closed:0, open:0, durations:[], workers:new Set(), xphUnit:''};
      m[k].count++;
      if (!s.isOpen && s.durationMinutes>0) { m[k].totalMin+=s.durationMinutes; m[k].closed++; m[k].durations.push(s.durationMinutes); }
      if(s.isOpen) m[k].open++;
      if (s._workerId) m[k].workers.add(s._workerId);
      if (!m[k].xphUnit && s.xphTarget != null) m[k].xphUnit = 'benchmarked';
    });
    return Object.values(m).map(d=>({
      ...d, avg: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null,
      median: getMedian(d.durations), hrs: Math.round(d.totalMin/60*10)/10,
      pct: filtered.length ? Math.round(d.count/filtered.length*100) : 0,
      workers: d.workers.size,
    })).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  // By Worker — full parity with GAS KPI_BY_USER (includes Department!)
  const byWorker = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s._workerId||'none';
      if (!m[k]) m[k] = {worker:s.displayName||s.workerName||'UNATTRIBUTED', workerId:k,
        dept: s.departmentName||'', orderType: '',
        count:0, totalMin:0, closed:0, open:0, orders:new Set()};
      const b = m[k];
      b.count++;
      if (!b.dept && s.departmentName) b.dept = s.departmentName;
      if(!s.isOpen&&s.durationMinutes>0){b.totalMin+=s.durationMinutes;b.closed++;}
      if(s.isOpen) b.open++;
      if(s.orderSerialNumber) b.orders.add(s.orderSerialNumber);
    });
    return Object.values(m).map(d=>({
      ...d, orders: d.orders.size,
      avg: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null,
      hrs: Math.round(d.totalMin/60*10)/10,
      xph: d.totalMin > 0 ? Math.round(d.closed / (d.totalMin/60) * 10) / 10 : null,
    })).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  // Daily volume
  const daily = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const d = s.segmentStart?.substring(0,10); if(!d) return;
      if(!m[d]) m[d]={date:d,count:0};
      m[d].count++;
    });
    return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d, label: fmtDate(d.date)}));
  }, [filtered]);

  // Segment detail rows (most recent 500)
  const segRows = useMemo(() => {
    return filtered.slice().sort((a,b) => (b.segmentStart||'').localeCompare(a.segmentStart||'')).slice(0,500);
  }, [filtered]);

  const clearFilters = () => { setFType(''); setFDept(''); setFFrom(''); setFTo(''); setFWorker(''); setFStatus(''); };
  const hasFilters = fType || fDept || fWorker || fStatus || fFrom || fTo;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">KPI Overview</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Processing performance · Last 60 days · {fmtI(segs.length)} segments · {metrics?.depts||0} departments</p>
      </div>

      {/* Filters */}
      <FilterBar>
        <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
        <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
        <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={statuses} />
        <FilterSelect label="Worker" value={fWorker} onChange={setFWorker} options={workers} allLabel="All Workers" />
        <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
        <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
        {hasFilters && <FilterReset onClick={clearFilters} />}
      </FilterBar>

      {/* Metric Cards */}
      <div className="metric-grid">
        <Card label="Segments" value={fmtI(metrics?.total)} loading={loading} trend={metrics?.volTrend} />
        <Card label="Closed" value={fmtI(metrics?.closed)} color="green" loading={loading} />
        <Card label="Open" value={fmtI(metrics?.open)} color="amber" loading={loading} />
        <Card label="Avg Duration" value={fmtDur(metrics?.avg)} color="brand" loading={loading} />
        <Card label="Median" value={fmtDur(metrics?.median)} color="slate" loading={loading} />
        <Card label="In-Range" value={metrics?.inRangePct != null ? `${metrics.inRangePct}%` : '—'} color="green" loading={loading} />
        <Card label="Orders" value={fmtI(metrics?.orders)} color="navy" loading={loading} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 5-Bucket */}
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-3">5-Bucket Classification</div>
          {bucketData.length > 0 ? <div className="space-y-3">
            <div className="text-center">
              <div className="text-3xl font-display font-bold text-emerald-600">{metrics?.inRangePct||0}%</div>
              <div className="text-[11px] text-ink-400">In-Range Rate</div>
            </div>
            <div className="h-3 rounded-full overflow-hidden flex bg-surface-100">
              {bucketData.map((b,i) => (
                <div key={i} style={{width:`${b.pct}%`,background:b.fill,minWidth:b.pct>0?'2px':'0'}} className="h-full" title={`${b.fullName}: ${b.pct}%`} />
              ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 text-[10px] text-ink-500">
              {bucketData.map(b => (
                <div key={b.fullName} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{background:b.fill}} />
                  {b.bucket}: {fmtI(b.count)} ({b.pct}%)
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={bucketData} margin={{left:0,right:5,bottom:5}}>
                <XAxis dataKey="bucket" tick={{fill:'#64748b',fontSize:9}} angle={-15} textAnchor="end" height={40} interval={0} />
                <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v,n,p) => [fmtI(v)+` (${p.payload.pct}%)`, p.payload.fullName]} labelFormatter={()=>''} />
                <Bar dataKey="count" radius={[4,4,0,0]}>{bucketData.map((d,i) => <Cell key={i} fill={d.fill} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div> : <div className="text-ink-400 text-xs text-center py-8">No classification data — check benchmarks & thresholds in Settings</div>}
        </div>

        {/* Status chart */}
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-3">Top Statuses by Volume</div>
          {!loading && byStatus.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(280, byStatus.slice(0,12).length * 28 + 40)}>
              <BarChart data={byStatus.slice(0,12)} layout="vertical" margin={{left:5,right:20}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="status" width={160} tick={{fill:'#334155',fontSize:10}} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [fmtI(v), 'Segments']} />
                <Bar dataKey="count" fill="#00aeef" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-60 loading rounded-lg" />}
        </div>
      </div>

      {/* Daily Volume */}
      <div className="card-surface p-4">
        <div className="text-xs font-semibold text-ink-600 mb-3">Daily Segment Volume</div>
        {!loading && daily.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily} margin={{left:0,right:10,bottom:5}}>
              <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={55} interval={Math.max(0,Math.floor(daily.length/20))} />
              <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p) => p?.[0]?.payload?.date||''} formatter={v => [fmtI(v),'Segments']} />
              <Bar dataKey="count" fill="#16a34a" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <div className="h-48 loading rounded-lg" />}
      </div>

      {/* Breakdown — By Status / By Worker */}
      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-600">Breakdown</span>
          <Pills tabs={[{key:'status',label:'By Status'},{key:'worker',label:'By Worker'}]} active={view} onChange={setView} />
        </div>
        {view === 'status' ?
          <Table cols={[
            {key:'status',label:'Status',w:180},
            {key:'slug',label:'Slug',w:170,render:v=><span className="font-mono text-[10px] text-ink-400">{v}</span>},
            {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
            {key:'pct',label:'Share',right:true,render:v=><span className="text-ink-400">{v}%</span>},
            {key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},
            {key:'open',label:'Open',right:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
            {key:'avg',label:'Avg',right:true,render:v=>v!=null?fmtDur(v):'—'},
            {key:'median',label:'Median',right:true,render:v=>v!=null?fmtDur(v):'—'},
            {key:'hrs',label:'Total Hrs',right:true,render:v=>fmtHrs(v)},
            {key:'workers',label:'Workers',right:true,render:v=>fmtI(v)},
          ]} rows={byStatus} />
        :
          <Table cols={[
            {key:'worker',label:'Worker',w:170},
            {key:'dept',label:'Department',w:150,render:v=>v||<span className="text-ink-300">—</span>},
            {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
            {key:'orders',label:'Orders',right:true,render:v=>fmtI(v)},
            {key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},
            {key:'open',label:'Open',right:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
            {key:'avg',label:'Avg',right:true,render:v=>v!=null?fmtDur(v):'—'},
            {key:'hrs',label:'Total Hrs',right:true,render:v=>fmtHrs(v)},
            {key:'xph',label:'XpH',right:true,render:v=>v!=null?<span className="font-semibold text-brand-600">{fmt(v)}</span>:'—'},
          ]} rows={byWorker} onRow={r => r.workerId !== 'none' && nav(`/kpi/users?worker=${r.workerId}`)} />
        }
      </div>

      {/* Segment Detail */}
      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-ink-600">Segment Detail</span>
            <span className="text-[10px] text-ink-400 ml-2">{fmtI(Math.min(500,segRows.length))} of {fmtI(filtered.length)} · most recent first</span>
          </div>
          <button onClick={() => setShowSegs(!showSegs)}
            className="text-[11px] px-3 py-1 rounded-lg border border-surface-200 text-ink-500 hover:text-brand-600 hover:border-brand-200 font-medium">
            {showSegs ? 'Hide' : 'Show Segments'}
          </button>
        </div>
        {showSegs && (
          <div className="overflow-x-auto" style={{maxHeight:'500px'}}>
            <table className="tbl"><thead className="sticky top-0 z-10"><tr>
              <th>Date</th><th>Order</th><th>Worker</th><th>Department</th>
              <th>Status</th><th>Type</th><th className="text-right">Duration</th>
              <th className="text-right">Min</th><th className="text-right">Sec</th>
              <th className="text-center">State</th><th>Classification</th><th>Level</th>
            </tr></thead><tbody>
              {segRows.map((s,i) => (
                <tr key={i}>
                  <td className="text-[11px] font-mono text-ink-500 whitespace-nowrap">{s.segmentStart ? fmtDateTime(s.segmentStart) : '—'}</td>
                  <td>{s.orderSerialNumber ? <a href={`${ORDER_URL}${s.orderSerialNumber}?tab=order-information`} target="_blank" rel="noopener" className="text-brand-600 hover:underline font-mono text-[11px]">{s.orderSerialNumber}</a> : '—'}</td>
                  <td className="text-[12px]">{s.displayName || s.workerName || '—'}</td>
                  <td className="text-[12px] text-ink-500">{s.departmentName || '—'}</td>
                  <td className="text-[12px]">{s.statusName || s.statusSlug || '—'}</td>
                  <td className="capitalize text-[11px] text-ink-400">{s.orderType||'—'}</td>
                  <td className="text-right font-mono text-[11px]">{s.isOpen ? <span className="text-amber-600">Open</span> : fmtDur(s.durationMinutes)}</td>
                  <td className="text-right font-mono text-[10px] text-ink-400">{s.durationMinutes != null ? fmt(s.durationMinutes) : ''}</td>
                  <td className="text-right font-mono text-[10px] text-ink-400">{s.durationSeconds != null ? fmtI(Math.round(s.durationSeconds)) : ''}</td>
                  <td className="text-center"><span className={`badge ${s.isOpen?'badge-warning':'badge-success'}`}>{s.isOpen?'Open':'Closed'}</span></td>
                  <td>{(() => { const b = classifySegment(s); return <span className={`text-[10px] font-semibold ${b==='In-Range'?'text-emerald-600':b?.includes('Out-of-Range')?'text-amber-600':b?.includes('Exclude')?'text-red-600':'text-ink-400'}`}>{b}</span>; })()}</td>
                  <td className="text-[11px] font-mono text-ink-400">{s.userLevel||'—'}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
      </div>
    </div>
  );
}

function getMedian(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? Math.round(s[mid]*10)/10 : Math.round((s[mid-1]+s[mid])/2*10)/10;
}

function fmtDate(d) {
  if (!d) return '';
  const [,m,day] = d.split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)]} ${parseInt(day)}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' +
      d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
  } catch { return iso.substring(0,16); }
}
