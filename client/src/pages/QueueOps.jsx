import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, Table, Pills, FilterBar, FilterSelect, ChartLegend, DrilldownDrawer, OrderLink,
         TOOLTIP_STYLE, fmt, fmtI, fmtDateTime } from '../components/UI';
import { useData } from '../hooks/useData';
import { api } from '../hooks/useApi';

const AGING_COLORS = { lt24:'#16a34a', '24-48':'#d97706', '48-72':'#ea580c', gt72:'#dc2626' };
const AGING_LABELS = { lt24:'< 24 hours', '24-48':'24–48 hours', '48-72':'48–72 hours', gt72:'> 72 hours' };

const DRAWER_COLS = [
  { key:'orderSerialNumber', label:'Order', w:110, sortable:true, render:(v)=><OrderLink serial={v} /> },
  { key:'orderType', label:'Type', w:80, sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
  { key:'workerName', label:'Worker', w:140, sortable:true },
  { key:'departmentName', label:'Department', w:130, sortable:true },
  { key:'waitHours', label:'Wait (hrs)', w:90, right:true, sortable:true,
    render:v=>v!=null ? <span className={`font-semibold ${v>72?'text-red-600':v>48?'text-orange-600':v>24?'text-amber-600':'text-emerald-600'}`}>{fmt(v)}h</span> : '—' },
  { key:'segmentStart', label:'Entered', w:130, sortable:true, render:v=>fmtDateTime(v) },
];

export default function QueueOps() {
  const { queueSnap: snap, queueWait: wait, queueLoading: loading, loadQueue, forceRefreshQueue } = useData();
  const [view, setView] = useState('snapshot');
  const [fWait, setFWait] = useState('');

  // Drilldown state
  const [drawer, setDrawer] = useState({ open:false, title:'', subtitle:'', rows:[], loading:false });
  const [drawerAgingFilter, setDrawerAgingFilter] = useState('');

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const sm = useMemo(() => {
    if (!snap) return null;
    const w = (snap.snapshot||[]).filter(s=>s.isWaitingStatus);
    return {
      active: snap.totalActiveOrders||0, waiting: snap.waitingOrders||0, proc: snap.processingOrders||0,
      o24: w.reduce((a,s)=>a+(s.over24h||0),0), o72: w.reduce((a,s)=>a+(s.over72h||0),0),
      today: (snap.snapshot||[]).reduce((a,s)=>a+(s.enteredToday||0),0),
    };
  }, [snap]);

  const snapRows = useMemo(() => {
    if (!snap?.snapshot) return [];
    let rows = snap.snapshot;
    if (fWait==='waiting') rows = rows.filter(s=>s.isWaitingStatus);
    else if (fWait==='processing') rows = rows.filter(s=>s.isProcessingStatus);
    return rows.sort((a,b)=>b.orderCount-a.orderCount);
  }, [snap, fWait]);

  const waitRows = useMemo(()=>wait?.summary?.filter(s=>s.isWaiting)||[],[wait]);
  const aging = useMemo(()=>snapRows.filter(s=>s.isWaitingStatus&&s.orderCount>0).slice(0,12).map(s=>({
    status:(s.statusName||'').replace('Awaiting ','Aw. ').replace('Waiting for ','Wait '),
    fullStatus:s.statusName, slug:s.statusSlug,
    lt24:Math.max(0,(s.orderCount||0)-(s.over24h||0)),
    '24-48':Math.max(0,(s.over24h||0)-(s.over48h||0)),
    '48-72':Math.max(0,(s.over48h||0)-(s.over72h||0)),
    gt72:s.over72h||0,
  })),[snapRows]);

  const refreshLabel = snap?._backfilledAt
    ? `Cached ${new Date(snap._backfilledAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`
    : snap?.refreshedAt ? `Live ${new Date(snap.refreshedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}` : '';

  const openDrawer = useCallback(async (row) => {
    const slug = row.statusSlug || row.slug;
    const name = row.statusName || row.fullStatus || slug;
    setDrawer({ open:true, title:name, subtitle:`${fmtI(row.orderCount)} orders currently in this status — click a row to open in admin`, rows:[], loading:true });
    setDrawerAgingFilter('');
    try {
      const data = await api(`/data/queue-status-orders?statusSlug=${encodeURIComponent(slug)}`);
      setDrawer(d => ({ ...d, rows: data.rows||[], loading:false }));
    } catch(e) {
      setDrawer(d => ({ ...d, rows:[], loading:false, subtitle:`Error: ${e.message}` }));
    }
  }, []);

  const drawerRows = useMemo(() => {
    if (!drawerAgingFilter) return drawer.rows;
    return drawer.rows.filter(r => {
      const h = r.waitHours;
      if (drawerAgingFilter==='lt24') return h!=null && h<24;
      if (drawerAgingFilter==='24-48') return h!=null && h>=24 && h<48;
      if (drawerAgingFilter==='48-72') return h!=null && h>=48 && h<72;
      if (drawerAgingFilter==='gt72') return h!=null && h>=72;
      return true;
    });
  }, [drawer.rows, drawerAgingFilter]);

  // Snapshot table cols — all sortable
  const snapshotCols = [
    { key:'statusName', label:'Status', w:190, sortable:true },
    { key:'statusType', label:'Type', w:90, sortable:true, render:v=><span className={`badge ${v==='Processing'?'badge-info':v==='Holding'||v==='Waiting'?'badge-warning':'badge-neutral'}`}>{v}</span> },
    { key:'orderCount', label:'Orders', w:75, right:true, sortable:true, render:v=><span className="font-semibold">{fmtI(v)}</span> },
    { key:'evaluationCount', label:'Eval', w:60, right:true, sortable:true, render:v=>fmtI(v) },
    { key:'translationCount', label:'Trans', w:65, right:true, sortable:true, render:v=>fmtI(v) },
    { key:'medianWaitHours', label:'Median', w:70, right:true, sortable:true, render:v=>v!=null?`${fmt(v)}h`:'—' },
    { key:'over24h', label:'>24h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-amber-600 font-semibold">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'over48h', label:'>48h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-orange-600 font-semibold">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'over72h', label:'>72h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-red-600 font-bold">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'enteredToday', label:'Today', w:65, right:true, sortable:true, render:v=>v>0?<span className="text-brand-600 font-semibold">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'oldestWaitHours', label:'Oldest (hr)', w:90, right:true, sortable:true, render:v=>v!=null?<span className={v>72?'text-red-600 font-bold':v>24?'text-amber-600':'text-ink-500'}>{fmtI(Math.round(v))}</span>:'—' },
    { key:'oldestWaitingSince', label:'Oldest Since', w:130, sortable:true, render:v=>v?<span className="text-[10px] font-mono text-ink-400">{new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>:'—' },
  ];

  const waitCols = [
    { key:'statusName', label:'Status', w:190, sortable:true },
    { key:'totalVolume', label:'Volume', w:75, right:true, sortable:true, render:v=><span className="font-semibold">{fmtI(v)}</span> },
    { key:'completedCount', label:'Done', w:65, right:true, sortable:true, render:v=>fmtI(v) },
    { key:'openCount', label:'Open', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-amber-600">{fmtI(v)}</span>:fmtI(v) },
    { key:'evaluationCount', label:'Eval', w:60, right:true, sortable:true, render:v=>fmtI(v) },
    { key:'translationCount', label:'Trans', w:65, right:true, sortable:true, render:v=>fmtI(v) },
    { key:'medianWaitHours', label:'Median', w:70, right:true, sortable:true, render:v=>v!=null?`${fmt(v)}h`:'—' },
    { key:'avgWaitHours', label:'Avg', w:60, right:true, sortable:true, render:v=>v!=null?`${fmt(v)}h`:'—' },
    { key:'p75WaitHours', label:'P75', w:60, right:true, sortable:true, render:v=>v!=null?`${fmt(v)}h`:'—' },
    { key:'p90WaitHours', label:'P90', w:60, right:true, sortable:true, render:v=>v!=null?`${fmt(v)}h`:'—' },
    { key:'over24h', label:'>24h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-amber-600">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'over48h', label:'>48h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-orange-600">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
    { key:'over72h', label:'>72h', w:60, right:true, sortable:true, render:v=>v>0?<span className="text-red-600 font-bold">{fmtI(v)}</span>:<span className="text-ink-300">0</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900" data-tour="queue-title">Queue Operations</h1>
          <p className="text-[11px] text-ink-400 mt-0.5">Live queue status {refreshLabel&&<span className="text-ink-500">· {refreshLabel}</span>} · <span className="text-brand-500">Click any row to drill into orders</span></p>
        </div>
        <div className="flex items-center gap-3">
          <Pills tabs={[{key:'snapshot',label:'Live Snapshot'},{key:'history',label:'Wait Summary (2025+)'}]} data-tour='queue-tabs' active={view} onChange={setView} />
          <button onClick={forceRefreshQueue} disabled={loading} className="text-xs text-brand-600 hover:text-brand-700 font-semibold disabled:text-ink-400">{loading?'Refreshing…':'↻ Live Refresh'}</button>
        </div>
      </div>

      <div className="metric-grid-6">
        <Card label="Active Orders" value={fmtI(sm?.active)} color="plum" loading={loading} />
        <Card label="Waiting" value={fmtI(sm?.waiting)} color="amber" loading={loading} />
        <Card label="Processing" value={fmtI(sm?.proc)} color="green" loading={loading} />
        <Card label="> 24 Hours" value={fmtI(sm?.o24)} color={sm?.o24>0?'amber':'slate'} loading={loading} />
        <Card label="> 72 Hours" value={fmtI(sm?.o72)} color={sm?.o72>0?'red':'slate'} loading={loading} />
        <Card label="Entered Today" value={fmtI(sm?.today)} color="brand" loading={loading} />
      </div>

      {view==='snapshot' && (
        <div className="card-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-ink-600">Queue Aging — Orders by Wait Bucket</span>
            <FilterSelect label="" value={fWait} onChange={setFWait}
              options={[{value:'waiting',label:'Waiting Only'},{value:'processing',label:'Processing Only'}]} allLabel="All Active" />
          </div>
          {!loading && aging.length > 0 ? <>
            <ResponsiveContainer width="100%" height={Math.max(200,aging.length*32+40)}>
              <BarChart data={aging} layout="vertical" margin={{left:5,right:20}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="status" width={130} tick={{fill:'#334155',fontSize:10}} />
                <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.fullStatus||''}
                  formatter={(v,n)=>[fmtI(v),AGING_LABELS[n]||n]} />
                <Bar dataKey="lt24" stackId="a" fill={AGING_COLORS.lt24} />
                <Bar dataKey="24-48" stackId="a" fill={AGING_COLORS['24-48']} />
                <Bar dataKey="48-72" stackId="a" fill={AGING_COLORS['48-72']} />
                <Bar dataKey="gt72" stackId="a" fill={AGING_COLORS.gt72} radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
            <ChartLegend items={Object.entries(AGING_LABELS).map(([k,l])=>({label:l,color:AGING_COLORS[k]}))} />
          </> : <div className="py-8 text-center text-ink-400 text-sm">{loading?'Loading...':'No waiting orders'}</div>}
        </div>
      )}

      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200">
          <span className="text-xs font-semibold text-ink-600">{view==='snapshot'?'All Active Statuses':'Wait Summary by Status'}</span>
          <span className="text-[10px] text-ink-400 ml-2">· click a row to see individual orders</span>
        </div>
        {view==='snapshot'
          ? <Table cols={snapshotCols} rows={snapRows} defaultSort="orderCount" defaultSortDir="desc"
              searchKey="statusName" searchPlaceholder="Search statuses…"
              onRow={openDrawer} maxHeight="500px" />
          : <Table cols={waitCols} rows={waitRows} defaultSort="totalVolume" defaultSortDir="desc"
              searchKey="statusName" searchPlaceholder="Search statuses…" maxHeight="500px" />
        }
      </div>

      <DrilldownDrawer
        open={drawer.open}
        onClose={() => setDrawer(d => ({...d, open:false}))}
        title={drawer.title}
        subtitle={drawer.subtitle}
        rows={drawerRows}
        loading={drawer.loading}
        cols={DRAWER_COLS}
        extraFilters={
          <select value={drawerAgingFilter} onChange={e=>setDrawerAgingFilter(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
            <option value="">All aging</option>
            {Object.entries(AGING_LABELS).map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
        }
      />
    </div>
  );
}
