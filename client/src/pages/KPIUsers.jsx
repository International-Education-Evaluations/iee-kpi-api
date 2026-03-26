import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ComposedChart, Bar, Line, LineChart, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, Table, FilterBar, FilterSelect, FilterInput, FilterReset,
         ChartLegend, DrilldownDrawer, OrderLink,
         TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs, fmtDateTime } from '../components/UI';
import { useData } from '../hooks/useData';

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

// Drilldown cols — segments for a given status within this worker's history
const SEG_COLS = [
  { key:'orderSerialNumber', label:'Order', w:110, sortable:true, render:(v)=><OrderLink serial={v} /> },
  { key:'segmentStart', label:'Date', w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'orderType', label:'Type', w:75, sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
  { key:'durationMinutes', label:'Duration', w:90, right:true, sortable:true,
    render:(v,r)=>r.isOpen?<span className="text-amber-600 text-[11px]">Open</span>:fmtDur(v) },
  { key:'durationSeconds', label:'Sec', w:70, right:true, sortable:true,
    render:v=>v!=null?<span className="text-ink-400">{Math.round(v)}</span>:'—' },
  { key:'isOpen', label:'State', w:70, sortable:true,
    render:v=><span className={`badge ${v?'badge-warning':'badge-success'}`}>{v?'Open':'Closed'}</span> },
];

export default function KPIUsers() {
  const { kpiSegs: segs, kpiLoading: loading, loadKpi } = useData();
  const [sp] = useSearchParams();
  const [sel, setSel] = useState(sp.get('worker') || '');
  const [fFrom, setFFrom] = useState(''); const [fTo, setFTo] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [drawer, setDrawer] = useState({ open:false, title:'', subtitle:'', rows:[] });

  useEffect(() => { loadKpi(); }, [loadKpi]);
  useEffect(() => { if (sp.get('worker')) setSel(sp.get('worker')); }, [sp]);

  const workers = useMemo(()=>{const m={};segs.forEach(s=>{if(s._workerId)m[s._workerId]=s.displayName||s.workerName;});return Object.entries(m).map(([v,l])=>({value:v,label:l})).sort((a,b)=>a.label.localeCompare(b.label));},[segs]);

  const userSegs = useMemo(()=>{
    if (!sel) return [];
    return segs.filter(s=>{
      if (s._workerId!==sel) return false;
      if (fFrom&&s.segmentStart&&s.segmentStart<fFrom) return false;
      if (fTo&&s.segmentStart&&s.segmentStart>fTo+'T23:59:59') return false;
      if (fStatus&&(s.statusName||s.statusSlug)!==fStatus) return false;
      return true;
    });
  },[segs,sel,fFrom,fTo,fStatus]);

  const m = useMemo(()=>{
    if (!userSegs.length) return null;
    const c=userSegs.filter(s=>!s.isOpen&&s.durationMinutes>0);
    const t=c.reduce((a,s)=>a+(s.durationMinutes||0),0);
    const median=getMedian(c.map(s=>s.durationMinutes));
    const xph=t>0?c.length/(t/60):0;
    return{total:userSegs.length,closed:c.length,open:userSegs.filter(s=>s.isOpen).length,
      avg:c.length?t/c.length:0,median,hrs:t/60,
      orders:new Set(userSegs.map(s=>s.orderSerialNumber).filter(Boolean)).size,
      xph:Math.round(xph*10)/10,
      dept:userSegs.find(s=>s.departmentName)?.departmentName||'',
      level:userSegs.find(s=>s.userLevel)?.userLevel||''};
  },[userSegs]);

  const daily = useMemo(()=>{
    const d={};
    userSegs.forEach(s=>{const k=s.segmentStart?.substring(0,10);if(!k)return;if(!d[k])d[k]={date:k,segs:0,min:0,closed:0};d[k].segs++;if(!s.isOpen&&s.durationMinutes>0){d[k].min+=s.durationMinutes;d[k].closed++;}});
    return Object.values(d).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,avg:d.closed?Math.round(d.min/d.closed*10)/10:0,label:fmtDate(d.date)}));
  },[userSegs]);

  const byStatus = useMemo(()=>{
    const d={};
    userSegs.forEach(s=>{const k=s.statusName||s.statusSlug;if(!d[k])d[k]={status:k,count:0,totalMin:0,closed:0,open:0};d[k].count++;if(!s.isOpen&&s.durationMinutes>0){d[k].totalMin+=s.durationMinutes;d[k].closed++;}if(s.isOpen)d[k].open++;});
    return Object.values(d).map(d=>({...d,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,hrs:Math.round(d.totalMin/60*10)/10,pct:userSegs.length?Math.round(d.count/userSegs.length*100):0})).sort((a,b)=>b.count-a.count);
  },[userSegs]);

  const statuses = useMemo(()=>[...new Set(segs.filter(s=>s._workerId===sel).map(s=>s.statusName||s.statusSlug).filter(Boolean))].sort(),[segs,sel]);
  const selName = workers.find(w=>w.value===sel)?.label||'';

  const openStatusDrawer = useCallback((row) => {
    const segRows = userSegs.filter(s=>(s.statusName||s.statusSlug)===row.status)
      .sort((a,b)=>(b.segmentStart||'').localeCompare(a.segmentStart||''));
    setDrawer({
      open:true,
      title: `${selName} — ${row.status}`,
      subtitle: `${fmtI(row.count)} segments · ${fmtI(row.closed)} closed · ${row.open} open · Avg ${fmtDur(row.avg)}`,
      rows: segRows,
    });
  }, [userSegs, selName]);

  const hasFilters = fFrom||fTo||fStatus;

  const statusCols = [
    {key:'status',label:'Status',w:180,sortable:true},
    {key:'count',label:'Segments',w:80,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'pct',label:'Share',w:60,right:true,sortable:true,render:v=><span className="text-ink-400">{v}%</span>},
    {key:'closed',label:'Closed',w:65,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'open',label:'Open',w:60,right:true,sortable:true,render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:'0'},
    {key:'avg',label:'Avg',w:70,right:true,sortable:true,render:v=>v!=null?fmtDur(v):'—'},
    {key:'hrs',label:'Total Hrs',w:80,right:true,sortable:true,render:v=>fmtHrs(v)},
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">User Drill-Down</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Individual worker performance · Last 60 days</p>
      </div>

      {!sel ? (
        <div className="card-surface p-8 sm:p-12 text-center">
          <div className="text-4xl mb-3 opacity-30">◉</div>
          <h3 className="text-lg font-display font-bold text-ink-700 mb-1">Select a Worker</h3>
          <p className="text-sm text-ink-400 mb-4">Choose a team member to see their performance breakdown.</p>
          <div className="max-w-xs mx-auto">
            <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
          </div>
        </div>
      ) : <>
        <FilterBar>
          <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
          <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={statuses} />
          <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
          <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
          {hasFilters && <FilterReset onClick={()=>{setFFrom('');setFTo('');setFStatus('');}} />}
        </FilterBar>

        {m?.dept && (
          <div className="text-xs text-ink-500">
            <span className="font-semibold text-ink-700">{selName}</span>
            <span className="mx-1.5">·</span>{m.dept}
            {m.level && <><span className="mx-1.5">·</span><span className="badge badge-info">{m.level}</span></>}
          </div>
        )}

        <div className="metric-grid">
          <Card label="Segments" value={fmtI(m?.total)} loading={loading} />
          <Card label="Closed" value={fmtI(m?.closed)} color="green" loading={loading} />
          <Card label="Open" value={fmtI(m?.open)} color="amber" loading={loading} />
          <Card label="Avg Duration" value={fmtDur(m?.avg)} color="brand" loading={loading} />
          <Card label="Median" value={fmtDur(m?.median)} color="slate" loading={loading} />
          <Card label="Total Hours" value={fmtHrs(m?.hrs)} color="navy" loading={loading} />
          <Card label="XpH" value={m?.xph?fmt(m.xph):'—'} sub="segments/hr" color="plum" loading={loading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card-surface p-4">
            <div className="text-xs font-semibold text-ink-600 mb-3">Daily Volume + Avg Duration</div>
            {daily.length>0?<>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={daily} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(daily.length/12))} />
                  <YAxis yAxisId="left" tick={{fill:'#64748b',fontSize:10}} />
                  <YAxis yAxisId="right" orientation="right" tick={{fill:'#16a34a',fontSize:10}} tickFormatter={v=>`${v}m`} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.date||''} formatter={(v,n)=>n==='segs'?[fmtI(v),'Segments']:[`${fmt(v)} min`,'Avg Duration']} />
                  <Bar yAxisId="left" dataKey="segs" fill="#00aeef" radius={[3,3,0,0]} opacity={0.8} />
                  <Line yAxisId="right" dataKey="avg" stroke="#16a34a" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <ChartLegend items={[{label:'Segments',color:'#00aeef'},{label:'Avg Duration',color:'#16a34a'}]} />
            </>:<div className="h-60 flex items-center justify-center text-ink-400 text-sm">No data</div>}
          </div>
          <div className="card-surface p-4">
            <div className="text-xs font-semibold text-ink-600 mb-3">Duration Trend (minutes)</div>
            {daily.length>0?
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={daily} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(daily.length/8))} />
                  <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>`${v}m`} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.date||''} formatter={v=>[`${fmt(v)} min`,'Avg Duration']} />
                  <Line type="monotone" dataKey="avg" stroke="#00aeef" strokeWidth={2.5} dot={{r:2,fill:'#00aeef'}} activeDot={{r:4}} />
                </LineChart>
              </ResponsiveContainer>
            :<div className="h-60 flex items-center justify-center text-ink-400 text-sm">No data</div>}
          </div>
        </div>

        <div className="card-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-200">
            <span className="text-xs font-semibold text-ink-600">Breakdown by Status</span>
            <span className="text-[10px] text-ink-400 ml-2">· click a row to see individual segments</span>
          </div>
          <Table cols={statusCols} rows={byStatus} defaultSort="count" defaultSortDir="desc"
            searchKey="status" searchPlaceholder="Search statuses…" onRow={openStatusDrawer} />
        </div>

        <DrilldownDrawer
          open={drawer.open}
          onClose={() => setDrawer(d=>({...d,open:false}))}
          title={drawer.title}
          subtitle={drawer.subtitle}
          rows={drawer.rows}
          cols={SEG_COLS}
        />
      </>}
    </div>
  );
}
