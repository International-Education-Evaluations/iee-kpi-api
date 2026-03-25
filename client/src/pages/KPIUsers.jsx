import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, Table, Section, Skel, FilterBar, FilterSelect, FilterInput, fmt, fmtI, disambiguateWorkers } from '../components/UI';
import { api } from '../hooks/useApi';
const TT={contentStyle:{background:'#ffffff',border:'1px solid #e2e8f0',borderRadius:8,color:'#0f172a',fontSize:12}};

export default function KPIUsers() {
  const [segs, setSegs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sp] = useSearchParams();
  const [sel, setSel] = useState(sp.get('worker') || '');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fStatus, setFStatus] = useState('');

  useEffect(() => { load(); }, []);
  useEffect(() => { if (sp.get('worker')) setSel(sp.get('worker')); }, [sp]);

  async function load() {
    setLoading(true);
    try {
      let all=[], p=1, more=true;
      while(more){const d=await api(`/data/kpi-segments?days=60&page=${p}&pageSize=5000`);all=all.concat(d.segments||[]);more=d.hasMore;p++;}
      const dis = disambiguateWorkers(all);
      setSegs(dis);
      const m={};
      dis.forEach(s=>{if(s.workerEmail) m[s.workerEmail]=s.displayName||s.workerName;});
      setWorkers(Object.entries(m).map(([v,l])=>({value:v,label:l})).sort((a,b)=>a.label.localeCompare(b.label)));
    } catch(e){console.error(e);}
    setLoading(false);
  }

  const userSegs = useMemo(() => {
    if(!sel) return [];
    return segs.filter(s => {
      if(s.workerEmail!==sel) return false;
      if(fFrom&&s.segmentStart&&s.segmentStart<fFrom) return false;
      if(fTo&&s.segmentStart&&s.segmentStart>fTo+'T23:59:59') return false;
      if(fStatus&&(s.statusName||s.statusSlug)!==fStatus) return false;
      return true;
    });
  }, [segs, sel, fFrom, fTo, fStatus]);

  const m = useMemo(() => {
    if(!userSegs.length) return null;
    const c=userSegs.filter(s=>!s.isOpen&&s.durationMinutes>0);
    const t=c.reduce((a,s)=>a+(s.durationMinutes||0),0);
    return{total:userSegs.length,closed:c.length,open:userSegs.filter(s=>s.isOpen).length,avg:c.length?t/c.length:0,hrs:t/60,orders:new Set(userSegs.map(s=>s.orderSerialNumber).filter(Boolean)).size};
  },[userSegs]);

  const daily=useMemo(()=>{const d={};userSegs.forEach(s=>{const k=s.segmentStart?.substring(0,10);if(!k)return;if(!d[k])d[k]={date:k,segs:0,min:0,closed:0};d[k].segs++;if(!s.isOpen&&s.durationMinutes>0){d[k].min+=s.durationMinutes;d[k].closed++;}});return Object.values(d).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,avg:d.closed?Math.round(d.min/d.closed*10)/10:0}));},[userSegs]);

  const byStatus=useMemo(()=>{const d={};userSegs.forEach(s=>{const k=s.statusName||s.statusSlug;if(!d[k])d[k]={status:k,count:0,totalMin:0,closed:0};d[k].count++;if(!s.isOpen&&s.durationMinutes>0){d[k].totalMin+=s.durationMinutes;d[k].closed++;}});return Object.values(d).map(d=>({...d,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null})).sort((a,b)=>b.count-a.count);},[userSegs]);

  const statuses = useMemo(()=>[...new Set(segs.filter(s=>s.workerEmail===sel).map(s=>s.statusName||s.statusSlug).filter(Boolean))].sort(),[segs,sel]);
  const selName=workers.find(w=>w.value===sel)?.label||'';

  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-display font-bold text-ink-900">User Drill-Down</h1><p className="text-xs text-ink-400 mt-0.5">Individual worker performance · Last 60 days</p></div>
      <FilterBar>
        <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
        {sel && <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={statuses} />}
        <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
        <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
      </FilterBar>

      {sel && m && <>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <Card label="Segments" value={fmtI(m.total)} /><Card label="Closed" value={fmtI(m.closed)} color="green" /><Card label="Open" value={fmtI(m.open)} color="amber" />
          <Card label="Avg Duration" value={fmt(m.avg)} sub="min" /><Card label="Total Hours" value={fmt(m.hrs)} /><Card label="Orders" value={fmtI(m.orders)} color="plum" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="card-surface p-4"><Section title="Daily Activity" sub={selName}>
            <ResponsiveContainer width="100%" height={220}><BarChart data={daily} margin={{left:0,right:10}}><XAxis dataKey="date" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} /><YAxis tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Bar dataKey="segs" fill="#3d6bab" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>
          </Section></div>
          <div className="card-surface p-4"><Section title="Avg Duration Trend" sub="Minutes per segment">
            <ResponsiveContainer width="100%" height={220}><LineChart data={daily} margin={{left:0,right:10}}><XAxis dataKey="date" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} /><YAxis tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Line type="monotone" dataKey="avg" stroke="#2E7D32" strokeWidth={2} dot={{r:1.5}} /></LineChart></ResponsiveContainer>
          </Section></div>
        </div>
        <Section title="By Status"><Table cols={[{key:'status',label:'Status',w:200},{key:'count',label:'Segments',right:true,render:v=>fmtI(v)},{key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},{key:'avg',label:'Avg Min',right:true,render:v=>fmt(v)}]} rows={byStatus} /></Section>
      </>}
      {sel && !m && !loading && <div className="card-surface p-8 text-center text-ink-500">No segments for this worker.</div>}
    </div>
  );
}
