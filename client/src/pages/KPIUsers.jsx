import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart, Bar, LineChart, Line, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, Table, Section, Skel, FilterBar, FilterSelect, FilterInput, ChartLegend, TOOLTIP_STYLE, fmt, fmtI, fmtDur, fmtHrs } from '../components/UI';
import DashboardGrid, { Widget } from '../components/DashboardGrid';
import { useData } from '../hooks/useData';

const DEFAULT_LAYOUT = [
  { i: 'filters', x: 0, y: 0, w: 12, h: 1, static: true },
  { i: 'cards', x: 0, y: 1, w: 12, h: 2, minH: 2 },
  { i: 'dailyActivity', x: 0, y: 3, w: 7, h: 5, minW: 4, minH: 3 },
  { i: 'avgTrend', x: 7, y: 3, w: 5, h: 5, minW: 3, minH: 3 },
  { i: 'byStatus', x: 0, y: 8, w: 12, h: 6, minW: 6, minH: 4 },
];

export default function KPIUsers() {
  const { kpiSegs: segs, kpiLoading: loading, loadKpi } = useData();
  const [sp] = useSearchParams();
  const [sel, setSel] = useState(sp.get('worker') || '');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fStatus, setFStatus] = useState('');

  useEffect(() => { loadKpi(); }, [loadKpi]);
  useEffect(() => { if (sp.get('worker')) setSel(sp.get('worker')); }, [sp]);

  const workers = useMemo(() => {
    const m={};
    segs.forEach(s=>{if(s._workerId) m[s._workerId]=s.displayName||s.workerName;});
    return Object.entries(m).map(([v,l])=>({value:v,label:l})).sort((a,b)=>a.label.localeCompare(b.label));
  }, [segs]);

  const userSegs = useMemo(() => {
    if(!sel) return [];
    return segs.filter(s => {
      if(s._workerId!==sel) return false;
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
    const durations = c.map(s=>s.durationMinutes);
    const sorted = [...durations].sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length/2);
    const median = sorted.length ? (sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2) : 0;
    const xph = t > 0 ? c.length / (t/60) : 0;
    return{
      total:userSegs.length, closed:c.length, open:userSegs.filter(s=>s.isOpen).length,
      avg:c.length?t/c.length:0, median: Math.round(median*10)/10,
      hrs:t/60, orders:new Set(userSegs.map(s=>s.orderSerialNumber).filter(Boolean)).size,
      xph: Math.round(xph*10)/10,
    };
  },[userSegs]);

  // Daily data with volume bars + avg duration line
  const daily = useMemo(() => {
    const d={};
    userSegs.forEach(s=>{
      const k=s.segmentStart?.substring(0,10);
      if(!k)return;
      if(!d[k])d[k]={date:k,segs:0,min:0,closed:0};
      d[k].segs++;
      if(!s.isOpen&&s.durationMinutes>0){d[k].min+=s.durationMinutes;d[k].closed++;}
    });
    return Object.values(d).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({
      ...d,
      avg:d.closed?Math.round(d.min/d.closed*10)/10:0,
      label: formatDateShort(d.date),
    }));
  },[userSegs]);

  const byStatus=useMemo(()=>{
    const d={};
    userSegs.forEach(s=>{
      const k=s.statusName||s.statusSlug;
      if(!d[k])d[k]={status:k,count:0,totalMin:0,closed:0};
      d[k].count++;
      if(!s.isOpen&&s.durationMinutes>0){d[k].totalMin+=s.durationMinutes;d[k].closed++;}
    });
    return Object.values(d).map(d=>({
      ...d,
      avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,
      hrs:Math.round(d.totalMin/60*10)/10,
      pct: userSegs.length ? Math.round(d.count/userSegs.length*100) : 0,
    })).sort((a,b)=>b.count-a.count);
  },[userSegs]);

  const statuses = useMemo(()=>[...new Set(segs.filter(s=>s._workerId===sel).map(s=>s.statusName||s.statusSlug).filter(Boolean))].sort(),[segs,sel]);
  const selName=workers.find(w=>w.value===sel)?.label||'Select a worker';

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">User Drill-Down</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Individual worker performance · Last 60 days</p>
      </div>

      {!sel ? (
        <div className="card-surface p-8 sm:p-12 text-center animate-fade-up">
          <div className="text-4xl mb-3 opacity-30">◉</div>
          <h3 className="text-lg font-display font-bold text-ink-700 mb-1">Select a Worker</h3>
          <p className="text-sm text-ink-400 mb-4">Choose a team member to see their full performance breakdown.</p>
          <div className="max-w-xs mx-auto">
            <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
          </div>
        </div>
      ) : (
        <DashboardGrid pageId="kpi-users" defaultLayout={DEFAULT_LAYOUT}>
          <div key="filters">
            <FilterBar>
              <FilterSelect label="Worker" value={sel} onChange={setSel} options={workers} allLabel="Select worker..." />
              {sel && <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={statuses} />}
              <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
              <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
            </FilterBar>
          </div>

          <div key="cards">
            <Widget title={`${selName} — Performance`}>
              <div className="metric-grid">
                <Card label="Segments" value={fmtI(m?.total)} loading={loading} icon="◈" />
                <Card label="Closed" value={fmtI(m?.closed)} color="green" loading={loading} />
                <Card label="Open" value={fmtI(m?.open)} color="amber" loading={loading} />
                <Card label="Avg Duration" value={fmtDur(m?.avg)} color="brand" loading={loading} />
                <Card label="Median" value={fmtDur(m?.median)} color="slate" loading={loading} />
                <Card label="Total Hours" value={fmtHrs(m?.hrs)} color="navy" loading={loading} />
                <Card label="XpH" value={m?.xph ? fmt(m.xph) : '—'} sub="segments/hr" color="plum" loading={loading} />
              </div>
            </Widget>
          </div>

          {/* Daily activity — bars + avg line overlay */}
          <div key="dailyActivity">
            <Widget title="Daily Activity — Volume + Avg Duration">
              {loading ? <Skel rows={6} /> :
              <>
                <ResponsiveContainer width="100%" height="85%">
                  <ComposedChart data={daily} margin={{left:0,right:10,bottom:5}}>
                    <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(daily.length/12))} />
                    <YAxis yAxisId="left" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                    <YAxis yAxisId="right" orientation="right" tick={{fill:'#16a34a',fontSize:10}} tickFormatter={v=>`${v}m`} />
                    <Tooltip {...TOOLTIP_STYLE}
                      labelFormatter={(_,payload) => payload?.[0]?.payload?.date || ''}
                      formatter={(v,n) => n==='segs' ? [fmtI(v),'Segments'] : [`${fmt(v)} min`,'Avg Duration']} />
                    <Bar yAxisId="left" dataKey="segs" fill="#00aeef" radius={[3,3,0,0]} opacity={0.8} />
                    <Line yAxisId="right" dataKey="avg" stroke="#16a34a" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <ChartLegend items={[{label:'Segments',color:'#00aeef'},{label:'Avg Duration',color:'#16a34a'}]} />
              </>}
            </Widget>
          </div>

          {/* Avg duration trend */}
          <div key="avgTrend">
            <Widget title="Duration Trend (minutes)">
              {loading ? <Skel rows={6} /> :
              <ResponsiveContainer width="100%" height="90%">
                <LineChart data={daily} margin={{left:0,right:10,bottom:5}}>
                  <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(daily.length/8))} />
                  <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>`${v}m`} />
                  <Tooltip {...TOOLTIP_STYLE}
                    labelFormatter={(_,payload) => payload?.[0]?.payload?.date || ''}
                    formatter={(v) => [`${fmt(v)} min`,'Avg Duration']} />
                  <Line type="monotone" dataKey="avg" stroke="#00aeef" strokeWidth={2.5} dot={{r:2,fill:'#00aeef'}} activeDot={{r:4}} />
                </LineChart>
              </ResponsiveContainer>}
            </Widget>
          </div>

          <div key="byStatus">
            <Widget title="Breakdown by Status">
              <Table cols={[
                {key:'status',label:'Status',w:180},
                {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
                {key:'pct',label:'%',right:true,render:v=><span className="text-ink-400">{v}%</span>},
                {key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},
                {key:'avg',label:'Avg',right:true,render:v=>v!=null?fmtDur(v):'—'},
                {key:'hrs',label:'Total Hrs',right:true,render:v=>fmtHrs(v)},
              ]} rows={byStatus} />
            </Widget>
          </div>
        </DashboardGrid>
      )}
    </div>
  );
}

function formatDateShort(d) {
  if (!d) return '';
  const [,m,day] = d.split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)]} ${parseInt(day)}`;
}
