import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, Table, Section, Pills, Skel, FilterBar, FilterSelect, fmt, fmtI } from '../components/UI';
import DashboardGrid, { Widget } from '../components/DashboardGrid';
import { useData } from '../hooks/useData';
const TT={contentStyle:{background:'#ffffff',border:'1px solid #e2e8f0',borderRadius:8,color:'#0f172a',fontSize:12,boxShadow:'0 4px 12px rgba(0,0,0,0.08)'}};

const DEFAULT_LAYOUT = [
  { i: 'header', x: 0, y: 0, w: 12, h: 1, static: true },
  { i: 'cards', x: 0, y: 1, w: 12, h: 2, minH: 2 },
  { i: 'aging', x: 0, y: 3, w: 12, h: 6, minW: 8, minH: 4 },
  { i: 'table', x: 0, y: 9, w: 12, h: 7, minW: 8, minH: 4 },
];

export default function QueueOps() {
  const { queueSnap: snap, queueWait: wait, queueLoading: loading, loadQueue, forceRefreshQueue } = useData();
  const [view, setView] = useState('snapshot');
  const [fWait, setFWait] = useState('');

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const sm=useMemo(()=>{if(!snap) return null;const w=(snap.snapshot||[]).filter(s=>s.isWaitingStatus);return{active:snap.totalActiveOrders||0,waiting:snap.waitingOrders||0,proc:snap.processingOrders||0,o24:w.reduce((a,s)=>a+(s.over24h||0),0),o72:w.reduce((a,s)=>a+(s.over72h||0),0),today:(snap.snapshot||[]).reduce((a,s)=>a+(s.enteredToday||0),0)};},[snap]);

  const snapRows=useMemo(()=>{if(!snap?.snapshot) return []; let rows=snap.snapshot; if(fWait==='waiting') rows=rows.filter(s=>s.isWaitingStatus); else if(fWait==='processing') rows=rows.filter(s=>s.isProcessingStatus); return rows.sort((a,b)=>b.orderCount-a.orderCount);},[snap,fWait]);
  const waitRows=useMemo(()=>wait?.summary?.filter(s=>s.isWaiting)||[],[wait]);

  const aging=useMemo(()=>snapRows.filter(s=>s.isWaitingStatus).slice(0,10).map(s=>({status:s.statusName?.replace('Awaiting ','Aw. ')||'',lt24:s.orderCount-(s.over24h||0),'24-48':(s.over24h||0)-(s.over48h||0),'48-72':(s.over48h||0)-(s.over72h||0),gt72:s.over72h||0})),[snapRows]);

  const refreshLabel = snap?._backfilledAt
    ? `Last: ${new Date(snap._backfilledAt).toLocaleTimeString()} (cached)`
    : snap?.refreshedAt
      ? `Last: ${new Date(snap.refreshedAt).toLocaleTimeString()} (live)`
      : '';

  return (
    <div className="space-y-3">
      <div><h1 className="text-xl font-display font-bold text-ink-900">Queue Operations</h1><p className="text-xs text-ink-400 mt-0.5">Queue snapshot updates every 5 min via backfill · {refreshLabel}</p></div>

      <DashboardGrid pageId="queue-ops" defaultLayout={DEFAULT_LAYOUT}>
        <div key="header">
          <div className="flex items-center justify-between h-full">
            <Pills tabs={[{key:'snapshot',label:'Live Snapshot'},{key:'history',label:'Wait Summary (2024+)'}]} active={view} onChange={setView} />
            <button onClick={forceRefreshQueue} className="text-xs text-brand-600 hover:text-brand-700 font-semibold">↻ Force Live Refresh</button>
          </div>
        </div>

        <div key="cards">
          <Widget title="Queue Metrics">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
              <Card label="Active" value={fmtI(sm?.active)} color="plum" loading={loading} />
              <Card label="Waiting" value={fmtI(sm?.waiting)} color="amber" loading={loading} />
              <Card label="Processing" value={fmtI(sm?.proc)} color="green" loading={loading} />
              <Card label="> 24 Hours" value={fmtI(sm?.o24)} color="red" loading={loading} />
              <Card label="> 72 Hours" value={fmtI(sm?.o72)} color="red" loading={loading} />
              <Card label="Entered Today" value={fmtI(sm?.today)} color="brand" loading={loading} />
            </div>
          </Widget>
        </div>

        <div key="aging">
          <Widget title={view === 'snapshot' ? 'Queue Aging — Orders by Wait Bucket' : 'Historical Wait Summary'}>
            {view === 'snapshot' ? <>
              <FilterBar><FilterSelect label="Status Type" value={fWait} onChange={setFWait} options={[{value:'waiting',label:'Waiting/Holding Only'},{value:'processing',label:'Processing Only'}]} allLabel="All Active" /></FilterBar>
              <div className="mt-3">
                {loading ? <Skel rows={6} /> :
                <ResponsiveContainer width="100%" height={250}><BarChart data={aging} layout="vertical" margin={{left:10,right:15}}><XAxis type="number" tick={{fill:'#64748b',fontSize:10}} /><YAxis type="category" dataKey="status" width={150} tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Bar dataKey="lt24" stackId="a" fill="#16a34a" name="< 24hr" /><Bar dataKey="24-48" stackId="a" fill="#d97706" name="24-48hr" /><Bar dataKey="48-72" stackId="a" fill="#ea580c" name="48-72hr" /><Bar dataKey="gt72" stackId="a" fill="#dc2626" name="> 72hr" radius={[0,4,4,0]} /></BarChart></ResponsiveContainer>}
              </div>
            </> : <div className="text-ink-400 text-sm">See table below for full historical wait data.</div>}
          </Widget>
        </div>

        <div key="table">
          <Widget title={view === 'snapshot' ? 'All Active Statuses' : 'Wait Summary by Status'}>
            {view==='snapshot' ?
              <Table cols={[
                {key:'statusName',label:'Status',w:200},
                {key:'statusType',label:'Type',w:100,render:v=><span className={`badge ${v==='Processing'?'badge-info':v==='Holding'||v==='Waiting'?'badge-warning':'badge-neutral'}`}>{v}</span>},
                {key:'orderCount',label:'Orders',right:true,render:v=>fmtI(v)},
                {key:'evaluationCount',label:'Eval',right:true,render:v=>fmtI(v)},
                {key:'translationCount',label:'Trans',right:true,render:v=>fmtI(v)},
                {key:'medianWaitHours',label:'Median hr',right:true,render:v=>fmt(v)},
                {key:'over24h',label:'>24h',right:true,render:v=><span className={v>0?'text-amber-600 font-semibold':''}>{fmtI(v)}</span>},
                {key:'over48h',label:'>48h',right:true,render:v=><span className={v>0?'text-orange-600 font-semibold':''}>{fmtI(v)}</span>},
                {key:'over72h',label:'>72h',right:true,render:v=><span className={v>0?'text-red-600 font-bold':''}>{fmtI(v)}</span>},
                {key:'enteredToday',label:'Today',right:true,render:v=>fmtI(v)}
              ]} rows={snapRows} />
            :
              <Table cols={[
                {key:'statusName',label:'Status',w:200},
                {key:'totalVolume',label:'Volume',right:true,render:v=>fmtI(v)},
                {key:'completedCount',label:'Done',right:true,render:v=>fmtI(v)},
                {key:'openCount',label:'Open',right:true,render:v=>fmtI(v)},
                {key:'medianWaitHours',label:'Median hr',right:true,render:v=>fmt(v)},
                {key:'avgWaitHours',label:'Avg hr',right:true,render:v=>fmt(v)},
                {key:'p75WaitHours',label:'P75',right:true,render:v=>fmt(v)},
                {key:'p90WaitHours',label:'P90',right:true,render:v=>fmt(v)},
                {key:'over24h',label:'>24h',right:true,render:v=><span className={v>0?'text-amber-600':''}>{fmtI(v)}</span>},
                {key:'over72h',label:'>72h',right:true,render:v=><span className={v>0?'text-red-600 font-bold':''}>{fmtI(v)}</span>}
              ]} rows={waitRows} />
            }
          </Widget>
        </div>
      </DashboardGrid>
    </div>
  );
}
