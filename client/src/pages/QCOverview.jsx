import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Card, Table, Section, Pills, FilterBar, FilterSelect, FilterReset, Skel, fmt, fmtI, fmtP } from '../components/UI';
import DashboardGrid, { Widget } from '../components/DashboardGrid';
import { useData } from '../hooks/useData';
const TT={contentStyle:{background:'#ffffff',border:'1px solid #e2e8f0',borderRadius:8,color:'#0f172a',fontSize:12,boxShadow:'0 4px 12px rgba(0,0,0,0.08)'}};
const COLORS=['#00aeef','#16a34a','#d97706','#ea580c','#9333ea','#0891b2','#dc2626'];

const DEFAULT_LAYOUT = [
  { i: 'filters', x: 0, y: 0, w: 12, h: 1, static: true },
  { i: 'cards', x: 0, y: 1, w: 12, h: 2, minH: 2 },
  { i: 'byDept', x: 0, y: 3, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'pie', x: 6, y: 3, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'breakdown', x: 0, y: 8, w: 12, h: 7, minW: 6, minH: 4 },
  { i: 'eventLog', x: 0, y: 15, w: 12, h: 8, minW: 8, minH: 5 },
];

export default function QCOverview() {
  const { qcEvents: events, qcLoading: loading, loadQc } = useData();
  const [view, setView] = useState('dept');
  const [fDept, setFDept] = useState('');
  const [fType, setFType] = useState('');
  const [fErr, setFErr] = useState('');

  useEffect(() => { loadQc(); }, [loadQc]);

  const filtered = useMemo(()=>events.filter(e=>{
    if(fDept&&e.departmentName!==fDept) return false;
    if(fType&&e.orderType!==fType) return false;
    if(fErr==='i_fixed_it'&&!e.isFixedIt) return false;
    if(fErr==='kick_it_back'&&!e.isKickItBack) return false;
    return true;
  }),[events,fDept,fType,fErr]);

  const depts = useMemo(()=>[...new Set(events.map(e=>e.departmentName).filter(Boolean))].sort(),[events]);

  const m=useMemo(()=>{if(!filtered.length) return null; const fi=filtered.filter(e=>e.isFixedIt).length; const kb=filtered.filter(e=>e.isKickItBack).length;
    return{total:filtered.length,fi,kb,orders:new Set(filtered.map(e=>e.orderSerialNumber).filter(Boolean)).size,users:new Set(filtered.map(e=>(e.accountableName||'').trim()).filter(Boolean)).size,fiP:filtered.length?fi/filtered.length:0,kbP:filtered.length?kb/filtered.length:0};
  },[filtered]);

  const byDept=useMemo(()=>{const d={};filtered.forEach(e=>{const k=e.departmentName||'(blank)';if(!d[k])d[k]={dept:k,total:0,fi:0,kb:0,orders:new Set(),users:new Set()};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;if(e.orderSerialNumber)d[k].orders.add(e.orderSerialNumber);if(e.accountableName)d[k].users.add(e.accountableName.trim());});return Object.values(d).map(d=>({...d,orders:d.orders.size,users:d.users.size,fiP:d.total?d.fi/d.total:0})).sort((a,b)=>b.total-a.total);},[filtered]);

  const byIssue=useMemo(()=>{const d={};filtered.forEach(e=>{const k=e.issueName||'(blank)';if(!d[k])d[k]={issue:k,total:0,fi:0,kb:0};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;});return Object.values(d).sort((a,b)=>b.total-a.total);},[filtered]);

  const byUser=useMemo(()=>{const d={};filtered.forEach(e=>{const k=(e.accountableName||'').trim()||'(unattr)';const dept=e.departmentName||'';const key=k+'||'+dept;if(!d[key])d[key]={user:k,dept,total:0,fi:0,kb:0,issues:new Set()};d[key].total++;if(e.isFixedIt)d[key].fi++;if(e.isKickItBack)d[key].kb++;if(e.issueName)d[key].issues.add(e.issueName);});return Object.values(d).map(d=>({...d,issues:d.issues.size})).sort((a,b)=>b.total-a.total).slice(0,30);},[filtered]);

  // Event log — most recent first, limited to 200
  const eventLog = useMemo(() => {
    return filtered.slice().sort((a,b) => (b.qcCreatedAt||'').localeCompare(a.qcCreatedAt||'')).slice(0, 200).map(e => ({
      ...e,
      date: e.qcCreatedAt ? new Date(e.qcCreatedAt).toLocaleDateString() : '—',
      outcome: e.isFixedIt ? 'Fixed It' : e.isKickItBack ? 'Kick Back' : '—',
    }));
  }, [filtered]);

  const clearF=()=>{setFDept('');setFType('');setFErr('');};

  return (
    <div className="space-y-3">
      <div><h1 className="text-xl font-display font-bold text-ink-900">QC Overview</h1><p className="text-xs text-ink-400 mt-0.5">Quality control events · Last 60 days · {events.length} total events</p></div>

      <DashboardGrid pageId="qc-overview" defaultLayout={DEFAULT_LAYOUT}>
        <div key="filters">
          <FilterBar>
            <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
            <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
            <FilterSelect label="Error Type" value={fErr} onChange={setFErr} options={[{value:'i_fixed_it',label:'Fixed It'},{value:'kick_it_back',label:'Kick It Back'}]} />
            <FilterReset onClick={clearF} />
          </FilterBar>
        </div>

        <div key="cards">
          <Widget title="QC Summary">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
              <Card label="QC Events" value={fmtI(m?.total)} color="brand" loading={loading} />
              <Card label="Fixed It" value={fmtI(m?.fi)} sub={fmtP(m?.fiP)} color="green" loading={loading} />
              <Card label="Kick It Back" value={fmtI(m?.kb)} sub={fmtP(m?.kbP)} color="red" loading={loading} />
              <Card label="Orders" value={fmtI(m?.orders)} color="slate" loading={loading} />
              <Card label="Accountable Users" value={fmtI(m?.users)} color="plum" loading={loading} />
            </div>
          </Widget>
        </div>

        <div key="byDept">
          <Widget title="By Department — Fixed vs Kick Back">
            {loading ? <Skel rows={5} /> :
            <ResponsiveContainer width="100%" height="100%"><BarChart data={byDept} layout="vertical" margin={{left:10,right:15}}><XAxis type="number" tick={{fill:'#64748b',fontSize:10}} /><YAxis type="category" dataKey="dept" width={150} tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Bar dataKey="fi" stackId="a" fill="#16a34a" name="Fixed It" /><Bar dataKey="kb" stackId="a" fill="#dc2626" name="Kick Back" radius={[0,4,4,0]} /></BarChart></ResponsiveContainer>}
          </Widget>
        </div>

        <div key="pie">
          <Widget title="Department Distribution">
            {loading ? <Skel rows={5} /> :
            <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={byDept.map(d=>({name:d.dept,value:d.total}))} cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} dataKey="value">{byDept.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]} />)}</Pie><Tooltip {...TT} /></PieChart></ResponsiveContainer>}
          </Widget>
        </div>

        <div key="breakdown">
          <Widget title={<div className="flex items-center justify-between w-full">
            <span>Summary Breakdown</span>
            <Pills tabs={[{key:'dept',label:'Department'},{key:'issue',label:'Issue'},{key:'user',label:'User'}]} active={view} onChange={setView} />
          </div>}>
            {view==='dept'&&<Table cols={[{key:'dept',label:'Department',w:160},{key:'total',label:'Events',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>},{key:'fiP',label:'% Fixed',right:true,render:v=>fmtP(v)},{key:'orders',label:'Orders',right:true,render:v=>fmtI(v)},{key:'users',label:'Users',right:true,render:v=>fmtI(v)}]} rows={byDept} />}
            {view==='issue'&&<Table cols={[{key:'issue',label:'Issue',w:250},{key:'total',label:'Events',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>}]} rows={byIssue} />}
            {view==='user'&&<Table cols={[{key:'user',label:'User',w:180},{key:'dept',label:'Dept',w:140},{key:'total',label:'Errors',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>},{key:'issues',label:'Issue Types',right:true,render:v=>fmtI(v)}]} rows={byUser} />}
          </Widget>
        </div>

        <div key="eventLog">
          <Widget title={`QC Event Log — ${eventLog.length} most recent`}>
            <Table cols={[
              {key:'date',label:'Date',w:90},
              {key:'orderSerialNumber',label:'Order',w:120,render:v=>v?<a href={`https://admin.prod.iee.com/orders/${v}?tab=discussion`} target="_blank" rel="noopener" className="text-brand-600 hover:underline font-mono text-[11px]">{v}</a>:'—'},
              {key:'outcome',label:'Outcome',w:100,render:v=><span className={`badge ${v==='Fixed It'?'badge-success':v==='Kick Back'?'badge-danger':'badge-neutral'}`}>{v}</span>},
              {key:'accountableName',label:'Accountable',w:150},
              {key:'departmentName',label:'Department',w:140},
              {key:'issueName',label:'Issue',w:200},
              {key:'reporterName',label:'Reporter',w:140},
              {key:'orderType',label:'Type',w:80,render:v=><span className="capitalize">{v||'—'}</span>},
            ]} rows={eventLog} />
          </Widget>
        </div>
      </DashboardGrid>
    </div>
  );
}
