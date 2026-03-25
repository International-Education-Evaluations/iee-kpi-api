import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, Table, Section, Pills, Skel, FilterBar, FilterSelect, fmt, fmtI } from '../components/UI';
import { api } from '../hooks/useApi';
const TT={contentStyle:{background:'#ffffff',border:'1px solid #e2e8f0',borderRadius:8,color:'#0f172a',fontSize:12}};

export default function QueueOps() {
  const [snap, setSnap] = useState(null);
  const [wait, setWait] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('snapshot');
  const [fWait, setFWait] = useState('');

  useEffect(()=>{load();},[]);
  async function load(){setLoading(true);try{const[s,w]=await Promise.all([api('/queue-snapshot'),api('/queue-wait-summary?days=450')]);setSnap(s);setWait(w);}catch(e){console.error(e);}setLoading(false);}

  const sm=useMemo(()=>{if(!snap) return null;const w=(snap.snapshot||[]).filter(s=>s.isWaitingStatus);return{active:snap.totalActiveOrders||0,waiting:snap.waitingOrders||0,proc:snap.processingOrders||0,o24:w.reduce((a,s)=>a+(s.over24h||0),0),o72:w.reduce((a,s)=>a+(s.over72h||0),0),today:(snap.snapshot||[]).reduce((a,s)=>a+(s.enteredToday||0),0)};},[snap]);

  const snapRows=useMemo(()=>{if(!snap?.snapshot) return []; let rows=snap.snapshot; if(fWait==='waiting') rows=rows.filter(s=>s.isWaitingStatus); else if(fWait==='processing') rows=rows.filter(s=>s.isProcessingStatus); return rows.sort((a,b)=>b.orderCount-a.orderCount);},[snap,fWait]);
  const waitRows=useMemo(()=>wait?.summary?.filter(s=>s.isWaiting)||[],[wait]);

  const aging=useMemo(()=>snapRows.filter(s=>s.isWaitingStatus).slice(0,10).map(s=>({status:s.statusName?.replace('Awaiting ','Aw. ')||'',lt24:s.orderCount-(s.over24h||0),'24-48':(s.over24h||0)-(s.over48h||0),'48-72':(s.over48h||0)-(s.over72h||0),gt72:s.over72h||0})),[snapRows]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">Queue Operations</h1><p className="text-xs text-ink-400 mt-0.5">Live snapshot + historical wait · <button onClick={load} className="text-brand-600 hover:text-navy-300">↻ Refresh</button></p></div>
        <Pills tabs={[{key:'snapshot',label:'Live Snapshot'},{key:'history',label:'Wait Summary (2024+)'}]} active={view} onChange={setView} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <Card label="Active" value={fmtI(sm?.active)} color="plum" loading={loading} />
        <Card label="Waiting" value={fmtI(sm?.waiting)} color="amber" loading={loading} />
        <Card label="Processing" value={fmtI(sm?.proc)} color="green" loading={loading} />
        <Card label="> 24 Hours" value={fmtI(sm?.o24)} color="red" loading={loading} />
        <Card label="> 72 Hours" value={fmtI(sm?.o72)} color="red" loading={loading} />
        <Card label="Entered Today" value={fmtI(sm?.today)} loading={loading} />
      </div>

      {view==='snapshot'?<>
        <FilterBar><FilterSelect label="Status Type" value={fWait} onChange={setFWait} options={[{value:'waiting',label:'Waiting/Holding Only'},{value:'processing',label:'Processing Only'}]} allLabel="All Active" /></FilterBar>
        <div className="card-surface p-4"><Section title="Queue Aging" sub="Current orders by wait bucket">
          {loading?<Skel rows={6}/>:<ResponsiveContainer width="100%" height={300}><BarChart data={aging} layout="vertical" margin={{left:10,right:15}}><XAxis type="number" tick={{fill:'#64748b',fontSize:10}} /><YAxis type="category" dataKey="status" width={150} tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Bar dataKey="lt24" stackId="a" fill="#16a34a" name="< 24hr" /><Bar dataKey="24-48" stackId="a" fill="#F57F17" name="24-48hr" /><Bar dataKey="48-72" stackId="a" fill="#E65100" name="48-72hr" /><Bar dataKey="gt72" stackId="a" fill="#C62828" name="> 72hr" radius={[0,4,4,0]} /></BarChart></ResponsiveContainer>}
        </Section></div>
        <Table cols={[{key:'statusName',label:'Status',w:200},{key:'orderCount',label:'Orders',right:true,render:v=>fmtI(v)},{key:'evaluationCount',label:'Eval',right:true,render:v=>fmtI(v)},{key:'translationCount',label:'Trans',right:true,render:v=>fmtI(v)},{key:'medianWaitHours',label:'Median hr',right:true,render:v=>fmt(v)},{key:'over24h',label:'>24h',right:true,render:v=><span className={v>0?'text-amber-600':''}>{fmtI(v)}</span>},{key:'over48h',label:'>48h',right:true,render:v=><span className={v>0?'text-orange-400':''}>{fmtI(v)}</span>},{key:'over72h',label:'>72h',right:true,render:v=><span className={v>0?'text-red-600 font-bold':''}>{fmtI(v)}</span>},{key:'enteredToday',label:'Today',right:true,render:v=>fmtI(v)}]} rows={snapRows} />
      </>:<>
        <Table cols={[{key:'statusName',label:'Status',w:200},{key:'totalVolume',label:'Volume',right:true,render:v=>fmtI(v)},{key:'completedCount',label:'Done',right:true,render:v=>fmtI(v)},{key:'openCount',label:'Open',right:true,render:v=>fmtI(v)},{key:'medianWaitHours',label:'Median hr',right:true,render:v=>fmt(v)},{key:'avgWaitHours',label:'Avg hr',right:true,render:v=>fmt(v)},{key:'p75WaitHours',label:'P75',right:true,render:v=>fmt(v)},{key:'p90WaitHours',label:'P90',right:true,render:v=>fmt(v)},{key:'over24h',label:'>24h',right:true,render:v=><span className={v>0?'text-amber-600':''}>{fmtI(v)}</span>},{key:'over72h',label:'>72h',right:true,render:v=><span className={v>0?'text-red-600 font-bold':''}>{fmtI(v)}</span>},{key:'topNextStatuses',label:'Next Statuses',w:250,render:v=><span className="text-xs text-ink-400">{v||'—'}</span>}]} rows={waitRows} />
      </>}
    </div>
  );
}
