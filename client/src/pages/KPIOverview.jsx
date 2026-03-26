import React, { useEffect, useState, useMemo, useCallback, useDeferredValue, useTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Card, Table, Pills, FilterBar, FilterSelect, FilterInput, FilterReset, DatePresets,
         ChartLegend, DrilldownDrawer, OrderLink,
         TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs, fmtDateTime } from '../components/UI';
import { api } from '../hooks/useApi';
import { useData } from '../hooks/useData';

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

// Segment drilldown columns
const SEG_COLS = [
  { key:'orderSerialNumber', label:'Order', w:110, sortable:true, render:(v)=><OrderLink serial={v} /> },
  { key:'workerName', label:'Worker', w:140, sortable:true },
  { key:'departmentName', label:'Dept', w:120, sortable:true },
  { key:'statusName', label:'Status', w:160, sortable:true },
  { key:'orderType', label:'Type', w:75, sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
  { key:'segmentStart', label:'Date', w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'durationMinutes', label:'Duration', w:90, right:true, sortable:true,
    render:(v,r)=>r.isOpen?<span className="text-amber-600 text-[11px]">Open</span>:fmtDur(v) },
  { key:'_bucket', label:'Bucket', w:110, sortable:true,
    render:v=><span className={`text-[10px] font-semibold ${v==='In-Range'?'text-emerald-600':v?.includes('Out-of-Range')?'text-amber-600':v?.includes('Exclude')?'text-red-600':'text-ink-400'}`}>{v||'—'}</span> },
];

export default function KPIOverview() {
  const { kpiSegs: segs, kpiLoading: loading, loadKpi } = useData();
  const [benchmarks, setBenchmarks] = useState([]);
  const [view, setView] = useState('status');
  const [fType, setFType] = useState(''); const [fDept, setFDept] = useState('');
  const [fFrom, setFFrom] = useState(''); const [fTo, setFTo] = useState('');
  const [fWorker, setFWorker] = useState(''); const [fStatus, setFStatus] = useState('');
  const [drawer, setDrawer] = useState({ open:false, title:'', subtitle:'', rows:[] });
  const [anomalyOpen, setAnomalyOpen] = useState(false); // collapsed by default
  const nav = useNavigate();

  // Defer heavy filter computations so filter inputs stay responsive even on 95k rows.
  // The filter inputs update instantly; the charts/tables update after the browser is idle.
  const deferredFType    = useDeferredValue(fType);
  const deferredFDept    = useDeferredValue(fDept);
  const deferredFWorker  = useDeferredValue(fWorker);
  const deferredFStatus  = useDeferredValue(fStatus);
  const deferredFFrom    = useDeferredValue(fFrom);
  const deferredFTo      = useDeferredValue(fTo);

  useEffect(() => { loadKpi(); }, [loadKpi]);
  useEffect(() => { api('/config/benchmarks').then(d=>setBenchmarks(d.benchmarks||[])).catch(()=>{}); }, []);

  const classifySegment = useMemo(() => {
    const benchMap = {};
    for (const b of benchmarks) { if (b.status) benchMap[b.status]=b; }
    return (s) => {
      if (s.isOpen) return 'Open';
      if (s.durationMinutes==null) return 'Unclassified';
      const b = benchMap[s.statusSlug];
      if (!b) return 'Unclassified';
      const dur=s.durationMinutes;
      if (dur<(b.excludeShortMin??0.5)) return 'Exclude Short';
      if (dur<(b.inRangeMin??1)) return 'Out-of-Range Short';
      if (dur<=(b.inRangeMax??120)) return 'In-Range';
      if (dur<=(b.excludeLongMax??480)) return 'Out-of-Range Long';
      return 'Exclude Long';
    };
  }, [benchmarks]);

  const workers = useMemo(()=>{
    const m = {};
    // Count how often each displayName appears per workerId — use most frequent
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
    // Deduplicate labels: if same display name appears for two ids, append id suffix
    const labelCount = {};
    for (const label of Object.values(m)) labelCount[label] = (labelCount[label]||0)+1;
    return Object.entries(m)
      .map(([v,l]) => ({ value:v, label: labelCount[l]>1 ? `${l} [${v.slice(-4)}]` : l }))
      .sort((a,b)=>a.label.localeCompare(b.label));
  },[segs]);
  const statuses = useMemo(()=>[...new Set(segs.map(s=>s.statusName||s.statusSlug).filter(Boolean))].sort(),[segs]);
  const depts = useMemo(()=>[...new Set(segs.map(s=>s.departmentName).filter(Boolean))].sort(),[segs]);

  const filtered = useMemo(()=>segs.filter(s=>{
    if(deferredFType&&s.orderType!==deferredFType)return false;
    if(deferredFDept&&s.departmentName!==deferredFDept)return false;
    if(deferredFWorker&&s._workerId!==deferredFWorker)return false;
    if(deferredFStatus&&(s.statusName||s.statusSlug)!==deferredFStatus)return false;
    if(deferredFFrom&&s.segmentStart&&s.segmentStart<deferredFFrom)return false;
    if(deferredFTo&&s.segmentStart&&s.segmentStart>deferredFTo+'T23:59:59')return false;
    return true;
  }),[segs,deferredFType,deferredFDept,deferredFFrom,deferredFTo,deferredFWorker,deferredFStatus]);

  const metrics = useMemo(()=>{
    if(!filtered.length)return null;
    const closed=filtered.filter(s=>!s.isOpen&&s.durationMinutes>0);
    const totalMin=closed.reduce((a,s)=>a+(s.durationMinutes||0),0);
    const now=new Date(); const d7=new Date(now-7*86400000).toISOString(); const d14=new Date(now-14*86400000).toISOString();
    const tw=filtered.filter(s=>s.segmentStart>=d7).length; const lw=filtered.filter(s=>s.segmentStart>=d14&&s.segmentStart<d7).length;
    const inRange=filtered.filter(s=>classifySegment(s)==='In-Range').length;
    return{total:filtered.length,closed:closed.length,open:filtered.filter(s=>s.isOpen).length,
      avg:closed.length?totalMin/closed.length:0,median:getMedian(closed.map(s=>s.durationMinutes)),
      hrs:totalMin/60,workers:new Set(filtered.map(s=>s._workerId).filter(Boolean)).size,
      orders:new Set(filtered.map(s=>s.orderSerialNumber).filter(Boolean)).size,
      depts:new Set(filtered.map(s=>s.departmentName).filter(Boolean)).size,
      volTrend:lw>0?Math.round((tw-lw)/lw*100):null,inRangePct:Math.round(inRange/(closed.length||1)*1000)/10};
  },[filtered,classifySegment]);

  const bucketData = useMemo(()=>{
    if(!benchmarks.length)return[];
    const counts={};
    filtered.forEach(s=>{const b=classifySegment(s);counts[b]=(counts[b]||0)+1;});
    const total=filtered.length||1;
    const order=['Exclude Short','Out-of-Range Short','In-Range','Out-of-Range Long','Exclude Long','Unclassified','Open'];
    return order.filter(b=>counts[b]).map(b=>({bucket:b.replace('Out-of-Range ','OOR ').replace('Exclude ','Excl '),fullName:b,count:counts[b],fill:BUCKET_COLORS[b],pct:Math.round(counts[b]/total*1000)/10}));
  },[filtered,benchmarks,classifySegment]);

  const byStatus = useMemo(()=>{
    const m={};
    filtered.forEach(s=>{
      const k=s.statusName||s.statusSlug||'Unknown';
      if(!m[k])m[k]={status:k,slug:s.statusSlug||'',count:0,totalMin:0,closed:0,open:0,durations:[],workers:new Set()};
      m[k].count++;
      if(!s.isOpen&&s.durationMinutes>0){m[k].totalMin+=s.durationMinutes;m[k].closed++;m[k].durations.push(s.durationMinutes);}
      if(s.isOpen)m[k].open++;
      if(s._workerId)m[k].workers.add(s._workerId);
    });
    return Object.values(m).map(d=>({...d,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,
      median:getMedian(d.durations),hrs:Math.round(d.totalMin/60*10)/10,
      pct:filtered.length?Math.round(d.count/filtered.length*100):0,workers:d.workers.size})).sort((a,b)=>b.count-a.count);
  },[filtered]);

  const byWorker = useMemo(()=>{
    const m={};
    filtered.forEach(s=>{
      const k=s._workerId||'none';
      if(!m[k])m[k]={worker:s.displayName||s.workerName||'UNATTRIBUTED',workerId:k,dept:s.departmentName||'',count:0,totalMin:0,closed:0,open:0,orders:new Set()};
      const b=m[k]; b.count++;
      if(!b.dept&&s.departmentName)b.dept=s.departmentName;
      if(!s.isOpen&&s.durationMinutes>0){b.totalMin+=s.durationMinutes;b.closed++;}
      if(s.isOpen)b.open++;
      if(s.orderSerialNumber)b.orders.add(s.orderSerialNumber);
    });
    return Object.values(m).map(d=>({...d,orders:d.orders.size,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,
      hrs:Math.round(d.totalMin/60*10)/10,xph:d.totalMin>0?Math.round(d.closed/(d.totalMin/60)*10)/10:null})).sort((a,b)=>b.count-a.count);
  },[filtered]);

  const daily = useMemo(()=>{
    const m={};
    filtered.forEach(s=>{const d=s.segmentStart?.substring(0,10);if(!d)return;if(!m[d])m[d]={date:d,count:0};m[d].count++;});
    return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,label:fmtDate(d.date)}));
  },[filtered]);

  // Open drilldown for a status row
  const openStatusDrawer = useCallback((row) => {
    const slugToFilter = row.slug || row.statusSlug || row.status;
    const segsForStatus = filtered.filter(s=>(s.statusName||s.statusSlug)===row.status)
      .map(s=>({...s, _bucket: classifySegment(s)}))
      .sort((a,b)=>(b.segmentStart||'').localeCompare(a.segmentStart||''));
    setDrawer({
      open:true,
      title: row.status,
      subtitle: `${fmtI(row.count)} segments · ${row.closed} closed · ${row.open} open · Avg ${fmtDur(row.avg)}`,
      rows: segsForStatus,
    });
  }, [filtered, classifySegment]);

  // Open drilldown for a worker row
  const openWorkerDrawer = useCallback((row) => {
    if (row.workerId==='none') return;
    const segsForWorker = filtered.filter(s=>s._workerId===row.workerId)
      .map(s=>({...s, _bucket: classifySegment(s)}))
      .sort((a,b)=>(b.segmentStart||'').localeCompare(a.segmentStart||''));
    setDrawer({
      open:true,
      title: row.worker,
      subtitle: `${row.dept||''}${row.dept?' · ':''}${fmtI(row.count)} segments · ${fmtDur(row.avg)} avg · ${fmt(row.xph)} XpH`,
      rows: segsForWorker,
    });
  }, [filtered, classifySegment]);

  // Full segment detail rows — all filtered segments, newest first
  const segDetail = useMemo(() =>
    filtered.map(s => ({ ...s, _bucket: classifySegment(s) }))
      .sort((a,b) => (b.segmentStart||'').localeCompare(a.segmentStart||'')),
  [filtered, classifySegment]);

  const clearFilters = ()=>{setFType('');setFDept('');setFFrom('');setFTo('');setFWorker('');setFStatus('');};
  // ── Anomaly / Alert feed ────────────────────────────────────
  // Uses filtered segs when dept/worker/status filters are active so alerts
  // are relevant to the current view. Falls back to all segs when no filters set.
  const anomalies = useMemo(() => {
    const flags = [];
    const source = (deferredFDept || deferredFWorker || deferredFStatus) ? filtered : segs;
    if (!source.length || !benchmarks.length) return flags;
    const now = new Date();
    const d7  = new Date(now - 7  * 86400000).toISOString();
    const d14 = new Date(now - 14 * 86400000).toISOString();

    // 1. Workers with XpH drop >30% week-over-week
    const workerWeeks = {};
    for (const s of source) {
      if (s.isOpen || !s._workerId || !s.durationMinutes || s.durationMinutes <= 0) continue;
      const id = s._workerId;
      if (!workerWeeks[id]) workerWeeks[id] = { tw:{ cnt:0, min:0 }, lw:{ cnt:0, min:0 }, name: s.displayName || s.workerName || id };
      const wk = s.segmentStart >= d7 ? workerWeeks[id].tw : s.segmentStart >= d14 ? workerWeeks[id].lw : null;
      if (wk) { wk.cnt++; wk.min += s.durationMinutes; }
    }
    for (const [id, { tw, lw, name }] of Object.entries(workerWeeks)) {
      const twXph = tw.min > 0 ? tw.cnt / (tw.min / 60) : 0;
      const lwXph = lw.min > 0 ? lw.cnt / (lw.min / 60) : 0;
      if (lwXph > 0.5 && twXph < lwXph * 0.7) {
        const drop = Math.round((1 - twXph / lwXph) * 100);
        flags.push({ severity:'warn', type:'xph_drop', title:`XpH drop: ${name}`, detail:`${Math.round(lwXph*100)/100} → ${Math.round(twXph*100)/100} segs/hr (−${drop}% w/w)`, id });
      }
    }

    // 2. Open segments stuck >48 hours
    const cutoff48 = new Date(now - 48 * 3600000).toISOString();
    const stuckOrders = {};
    for (const s of source) {
      if (!s.isOpen || !s.segmentStart || s.segmentStart >= cutoff48) continue;
      const key = s.orderSerialNumber || s.statusSlug || 'unknown';
      if (!stuckOrders[key]) stuckOrders[key] = { serial: s.orderSerialNumber, status: s.statusName || s.statusSlug, since: s.segmentStart };
    }
    const stuck = Object.values(stuckOrders);
    if (stuck.length > 0) {
      const oldest = stuck.sort((a,b) => a.since.localeCompare(b.since))[0];
      const hrsAgo = Math.round((now - new Date(oldest.since)) / 3600000);
      flags.push({ severity:'error', type:'stuck_open', title:`${stuck.length} order${stuck.length>1?'s':''} stuck open >48h`, detail:`Oldest: ${oldest.serial || oldest.status} — ${hrsAgo}h ago`, serial: oldest.serial });
    }

    // 3. Statuses with In-Range rate below 50% this week (min 10 segments)
    const statusWeek = {};
    for (const s of source) {
      if (s.isOpen || !s.statusSlug || s.segmentStart < d7) continue;
      if (!statusWeek[s.statusSlug]) statusWeek[s.statusSlug] = { name: s.statusName||s.statusSlug, total:0, inRange:0 };
      statusWeek[s.statusSlug].total++;
      const b = benchmarks.find(x=>x.status===s.statusSlug);
      if (b && s.durationMinutes >= (b.inRangeMin??1) && s.durationMinutes <= (b.inRangeMax??120))
        statusWeek[s.statusSlug].inRange++;
    }
    for (const [slug, { name, total, inRange }] of Object.entries(statusWeek)) {
      if (total >= 10 && inRange / total < 0.5) {
        const pct = Math.round(inRange / total * 100);
        flags.push({ severity:'warn', type:'low_inrange', title:`Low In-Range: ${name}`, detail:`${pct}% this week (${total} segs)` });
      }
    }

    return flags.slice(0, 10); // cap at 10
  }, [segs, benchmarks]);

  const hasFilters = fType||fDept||fWorker||fStatus||fFrom||fTo;

  const segmentCols = [
    {key:'segmentStart',    label:'Date',       w:130, sortable:true, render:v=>fmtDateTime(v)},
    {key:'orderSerialNumber',label:'Order',     w:110, sortable:true, render:v=><OrderLink serial={v} />},
    {key:'workerName',      label:'Worker',     w:140, sortable:true, render:(v,r)=>r.displayName||v||'—'},
    {key:'departmentName',  label:'Dept',       w:120, sortable:true, render:v=>v||<span className="text-ink-300">—</span>},
    {key:'statusName',      label:'Status',     w:170, sortable:true},
    {key:'orderType',       label:'Type',       w:80,  sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span>},
    {key:'durationMinutes', label:'Duration',   w:85,  right:true, sortable:true,
      render:(v,r)=>r.isOpen?<span className="text-amber-600 text-[11px]">Open</span>:fmtDur(v)},
    {key:'durationSeconds', label:'Sec',        w:65,  right:true, sortable:true,
      render:v=>v!=null?<span className="font-mono text-[11px] text-ink-400">{Math.round(v)}</span>:'—'},
    {key:'_bucket',         label:'Bucket',     w:120, sortable:true,
      render:v=><span className={`text-[10px] font-semibold ${v==='In-Range'?'text-emerald-600':v?.includes('Out-of-Range')?'text-amber-600':v?.includes('Exclude')?'text-red-600':'text-ink-400'}`}>{v||'—'}</span>},
    {key:'isOpen',          label:'State',      w:65,  sortable:true,
      render:v=><span className={`badge ${v?'badge-warning':'badge-success'}`}>{v?'Open':'Closed'}</span>},
    {key:'reportItemCount', label:'Reports',    w:70,  right:true, sortable:true,
      render:v=>v>0?<span className="font-semibold">{v}</span>:<span className="text-ink-300">—</span>},
  ];

  const statusCols = [
    {key:'status',label:'Status',w:180,sortable:true},
    {key:'slug',label:'Slug',w:160,sortable:true,render:v=><span className="font-mono text-[10px] text-ink-400">{v}</span>},
    {key:'count',label:'Segments',w:80,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'pct',label:'Share',w:60,right:true,sortable:true,render:v=><span className="text-ink-400">{v}%</span>},
    {key:'closed',label:'Closed',w:65,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'open',label:'Open',w:60,right:true,sortable:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
    {key:'avg',label:'Avg',w:70,right:true,sortable:true,render:v=>v!=null?fmtDur(v):'—'},
    {key:'median',label:'Median',w:70,right:true,sortable:true,render:v=>v!=null?fmtDur(v):'—'},
    {key:'hrs',label:'Total Hrs',w:80,right:true,sortable:true,render:v=>fmtHrs(v)},
    {key:'workers',label:'Workers',w:70,right:true,sortable:true,render:v=>fmtI(v)},
  ];

  const workerCols = [
    {key:'worker',label:'Worker',w:170,sortable:true},
    {key:'dept',label:'Department',w:150,sortable:true,render:v=>v||<span className="text-ink-300">—</span>},
    {key:'count',label:'Segments',w:80,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'orders',label:'Orders',w:70,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'closed',label:'Closed',w:65,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'open',label:'Open',w:60,right:true,sortable:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
    {key:'avg',label:'Avg',w:70,right:true,sortable:true,render:v=>v!=null?fmtDur(v):'—'},
    {key:'hrs',label:'Total Hrs',w:80,right:true,sortable:true,render:v=>fmtHrs(v)},
    {key:'xph',label:'XpH',w:70,right:true,sortable:true,render:v=>v!=null?<span className="font-semibold text-brand-600">{fmt(v)}</span>:'—'},
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900" data-tour="kpi-overview-title">KPI Overview</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Processing performance · Last 60 days · {fmtI(segs.length)} segments · {metrics?.depts||0} departments · <span className="text-brand-500">Click status or worker rows to drill in</span></p>
      </div>

      <FilterBar data-tour="filter-bar">
        <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
        <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
        <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={statuses} />
        <FilterSelect label="Worker" value={fWorker} onChange={setFWorker} options={workers} allLabel="All Workers" />
        <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
        <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
        <DatePresets onSelect={(from,to)=>{ setFFrom(from); setFTo(to); }} />
        {hasFilters && <FilterReset onClick={clearFilters} />}
      </FilterBar>

      <div className="metric-grid" data-tour="metric-cards">
        <Card label="Segments" value={fmtI(metrics?.total)} loading={loading} trend={metrics?.volTrend} />
        <Card label="Closed" value={fmtI(metrics?.closed)} color="green" loading={loading} />
        <Card label="Open" value={fmtI(metrics?.open)} color="amber" loading={loading} />
        <Card label="Avg Duration" value={fmtDur(metrics?.avg)} color="brand" loading={loading} />
        <Card label="Median" value={fmtDur(metrics?.median)} color="slate" loading={loading} />
        <Card label="In-Range" value={metrics?.inRangePct!=null?`${metrics.inRangePct}%`:'—'} color="green" loading={loading} />
        <Card label="Orders" value={fmtI(metrics?.orders)} color="navy" loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-surface p-4" data-tour="bucket-chart">
          <div className="text-xs font-semibold text-ink-600 mb-3">5-Bucket Classification</div>
          {bucketData.length>0?<div className="space-y-3">
            <div className="text-center">
              <div className="text-3xl font-display font-bold text-emerald-600">{metrics?.inRangePct||0}%</div>
              <div className="text-[11px] text-ink-400">In-Range Rate</div>
            </div>
            <div className="h-3 rounded-full overflow-hidden flex bg-surface-100">
              {bucketData.map((b,i)=><div key={i} style={{width:`${b.pct}%`,background:b.fill,minWidth:b.pct>0?'2px':'0'}} className="h-full" title={`${b.fullName}: ${b.pct}%`} />)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 text-[10px] text-ink-500">
              {bucketData.map(b=><div key={b.fullName} className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm shrink-0" style={{background:b.fill}} />{b.bucket}: {fmtI(b.count)} ({b.pct}%)</div>)}
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={bucketData} margin={{left:0,right:5,bottom:5}}>
                <XAxis dataKey="bucket" tick={{fill:'#64748b',fontSize:9}} angle={-15} textAnchor="end" height={40} interval={0} />
                <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v,n,p)=>[fmtI(v)+` (${p.payload.pct}%)`,p.payload.fullName]} labelFormatter={()=>''} />
                <Bar dataKey="count" radius={[4,4,0,0]}>{bucketData.map((d,i)=><Cell key={i} fill={d.fill} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>:<div className="text-ink-400 text-xs text-center py-8">No classification data — check benchmarks in Settings</div>}
        </div>
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-3">Top Statuses by Volume</div>
          {!loading&&byStatus.length>0?
            <ResponsiveContainer width="100%" height={Math.max(280,byStatus.slice(0,12).length*28+40)}>
              <BarChart data={byStatus.slice(0,12)} layout="vertical" margin={{left:5,right:20}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="status" width={160} tick={{fill:'#334155',fontSize:10}} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v)=>[fmtI(v),'Segments']} />
                <Bar dataKey="count" fill="#00aeef" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>:<div className="h-60 loading rounded-lg" />}
        </div>
      </div>

      <div className="card-surface p-4">
        <div className="text-xs font-semibold text-ink-600 mb-3">Daily Segment Volume</div>
        {!loading&&daily.length>0?
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily} margin={{left:0,right:10,bottom:5}}>
              <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={55} interval={Math.max(0,Math.floor(daily.length/20))} />
              <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.date||''} formatter={v=>[fmtI(v),'Segments']} />
              <Bar dataKey="count" fill="#16a34a" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>:<div className="h-48 loading rounded-lg" />}
      </div>

      {/* ── Anomaly / Alert Feed — collapsed by default ───── */}
      {anomalies.length > 0 && (
        <div className="card-surface overflow-hidden">
          <button onClick={() => setAnomalyOpen(o => !o)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-50 transition-colors">
            <span className="text-xs font-semibold text-ink-600 flex items-center gap-1.5">
              {anomalies.some(a => a.severity === 'error')
                ? <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                : <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              }
              Alerts &amp; Anomalies
              <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${anomalies.some(a=>a.severity==='error')?'bg-red-100 text-red-700':'bg-amber-100 text-amber-700'}`}>
                {anomalies.length}
              </span>
            </span>
            <span className="text-ink-400 text-xs">{anomalyOpen ? '▲ Hide' : '▼ Show'}</span>
          </button>
          {anomalyOpen && (
            <div className="divide-y divide-surface-100 border-t border-surface-100">
              {anomalies.map((a, i) => (
                <div key={i} className={`flex items-start gap-3 px-4 py-2.5 ${a.severity==='error'?'bg-red-50/40':'bg-amber-50/30'}`}>
                  <span className={`text-sm mt-0.5 ${a.severity==='error'?'text-red-500':'text-amber-500'}`}>
                    {a.severity==='error'?'⚠':'◉'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-ink-900">{a.title}</div>
                    <div className="text-[11px] text-ink-500 mt-0.5">{a.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card-surface overflow-hidden" data-tour="breakdown-table">
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-600">Breakdown</span>
          <Pills tabs={[
            {key:'status',   label:`By Status (${byStatus.length})`},
            {key:'worker',   label:`By Worker (${byWorker.length})`},
            {key:'segments', label:`Segments (${fmtI(filtered.length)})`},
          ]} active={view} onChange={setView} />
        </div>
        {view==='status' && (
          <Table cols={statusCols} rows={byStatus} defaultSort="count" defaultSortDir="desc"
            searchKey="status" searchPlaceholder="Search statuses…" onRow={openStatusDrawer} />
        )}
        {view==='worker' && (
          <Table cols={workerCols} rows={byWorker} defaultSort="count" defaultSortDir="desc"
            searchKey="worker" searchPlaceholder="Search workers…"
            onRow={r => r.workerId!=='none' && openWorkerDrawer(r)} />
        )}
        {view==='segments' && (
          <Table cols={segmentCols} rows={segDetail} defaultSort="segmentStart" defaultSortDir="desc"
            searchKey="orderSerialNumber" searchPlaceholder="Search order, worker, status…"
            maxHeight="600px" />
        )}
      </div>

      <DrilldownDrawer
        open={drawer.open}
        onClose={() => setDrawer(d=>({...d,open:false}))}
        title={drawer.title}
        subtitle={drawer.subtitle}
        rows={drawer.rows}
        cols={SEG_COLS}
      />
    </div>
  );
}
