import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Card, Table, Section, Pills, FilterBar, FilterSelect, FilterInput, FilterReset, Skel, fmt, fmtI, fmtP } from '../components/UI';
import { api } from '../hooks/useApi';
const TT={contentStyle:{background:'#ffffff',border:'1px solid #e2e8f0',borderRadius:8,color:'#0f172a',fontSize:12}};
const COLORS=['#4CAF50','#F44336','#FF9800','#2196F3','#9C27B0','#00BCD4','#795548'];

export default function QCOverview() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('dept');
  const [fDept, setFDept] = useState('');
  const [fType, setFType] = useState('');
  const [fErr, setFErr] = useState('');

  useEffect(() => { load(); }, []);
  async function load() { setLoading(true); try { const d=await api('/data/qc-events?days=60&includeHtml=false&includeText=false'); setEvents(d.events||[]); } catch(e){console.error(e);} setLoading(false); }

  const filtered = useMemo(()=>events.filter(e=>{
    if(fDept&&e.departmentName!==fDept) return false;
    if(fType&&e.orderType!==fType) return false;
    if(fErr&&e.errorType!==fErr) return false;
    return true;
  }),[events,fDept,fType,fErr]);

  const depts = useMemo(()=>[...new Set(events.map(e=>e.departmentName).filter(Boolean))].sort(),[events]);

  const m=useMemo(()=>{if(!filtered.length) return null; const fi=filtered.filter(e=>e.isFixedIt).length; const kb=filtered.filter(e=>e.isKickItBack).length;
    return{total:filtered.length,fi,kb,orders:new Set(filtered.map(e=>e.orderSerialNumber).filter(Boolean)).size,users:new Set(filtered.map(e=>(e.accountableName||'').trim()).filter(Boolean)).size,fiP:filtered.length?fi/filtered.length:0,kbP:filtered.length?kb/filtered.length:0};
  },[filtered]);

  const byDept=useMemo(()=>{const d={};filtered.forEach(e=>{const k=e.departmentName||'(blank)';if(!d[k])d[k]={dept:k,total:0,fi:0,kb:0,orders:new Set(),users:new Set()};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;if(e.orderSerialNumber)d[k].orders.add(e.orderSerialNumber);if(e.accountableName)d[k].users.add(e.accountableName.trim());});return Object.values(d).map(d=>({...d,orders:d.orders.size,users:d.users.size,fiP:d.total?d.fi/d.total:0})).sort((a,b)=>b.total-a.total);},[filtered]);

  const byIssue=useMemo(()=>{const d={};filtered.forEach(e=>{const k=e.issueName||'(blank)';if(!d[k])d[k]={issue:k,total:0,fi:0,kb:0};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;});return Object.values(d).sort((a,b)=>b.total-a.total);},[filtered]);

  const byUser=useMemo(()=>{const d={};filtered.forEach(e=>{const k=(e.accountableName||'').trim()||'(unattr)';const dept=e.departmentName||'';const key=k+'||'+dept;if(!d[key])d[key]={user:k,dept,total:0,fi:0,kb:0,issues:new Set()};d[key].total++;if(e.isFixedIt)d[key].fi++;if(e.isKickItBack)d[key].kb++;if(e.issueName)d[key].issues.add(e.issueName);});return Object.values(d).map(d=>({...d,issues:d.issues.size})).sort((a,b)=>b.total-a.total).slice(0,30);},[filtered]);

  const clearF=()=>{setFDept('');setFType('');setFErr('');};

  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-display font-bold text-ink-900">QC Overview</h1><p className="text-xs text-ink-400 mt-0.5">Quality control events · Last 60 days</p></div>
      <FilterBar>
        <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
        <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
        <FilterSelect label="Error Type" value={fErr} onChange={setFErr} options={[{value:'i_fixed_it',label:'Fixed It'},{value:'kick_it_back',label:'Kick It Back'}]} />
        <FilterReset onClick={clearF} />
      </FilterBar>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <Card label="QC Events" value={fmtI(m?.total)} color="green" loading={loading} />
        <Card label="Fixed It" value={fmtI(m?.fi)} sub={fmtP(m?.fiP)} loading={loading} />
        <Card label="Kick It Back" value={fmtI(m?.kb)} sub={fmtP(m?.kbP)} color="red" loading={loading} />
        <Card label="Orders" value={fmtI(m?.orders)} color="slate" loading={loading} />
        <Card label="Accountable Users" value={fmtI(m?.users)} color="plum" loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card-surface p-4"><Section title="By Department">
          {loading?<Skel rows={5} cols={1}/>:<ResponsiveContainer width="100%" height={260}><BarChart data={byDept} layout="vertical" margin={{left:10,right:15}}><XAxis type="number" tick={{fill:'#64748b',fontSize:10}} /><YAxis type="category" dataKey="dept" width={150} tick={{fill:'#64748b',fontSize:10}} /><Tooltip {...TT} /><Bar dataKey="fi" stackId="a" fill="#16a34a" name="Fixed It" /><Bar dataKey="kb" stackId="a" fill="#C62828" name="Kick Back" radius={[0,4,4,0]} /></BarChart></ResponsiveContainer>}
        </Section></div>
        <div className="card-surface p-4"><Section title="Distribution">
          {loading?<Skel rows={5}/>:<ResponsiveContainer width="100%" height={260}><PieChart><Pie data={byDept.map(d=>({name:d.dept,value:d.total}))} cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} dataKey="value">{byDept.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]} />)}</Pie><Tooltip {...TT} /></PieChart></ResponsiveContainer>}
        </Section></div>
      </div>

      <Section title="Breakdown" right={<Pills tabs={[{key:'dept',label:'Department'},{key:'issue',label:'Issue'},{key:'user',label:'User'}]} active={view} onChange={setView} />}>
        {view==='dept'&&<Table cols={[{key:'dept',label:'Department',w:160},{key:'total',label:'Events',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>},{key:'fiP',label:'% Fixed',right:true,render:v=>fmtP(v)},{key:'orders',label:'Orders',right:true,render:v=>fmtI(v)},{key:'users',label:'Users',right:true,render:v=>fmtI(v)}]} rows={byDept} />}
        {view==='issue'&&<Table cols={[{key:'issue',label:'Issue',w:250},{key:'total',label:'Events',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>}]} rows={byIssue} />}
        {view==='user'&&<Table cols={[{key:'user',label:'User',w:180},{key:'dept',label:'Dept',w:140},{key:'total',label:'Errors',right:true,render:v=>fmtI(v)},{key:'fi',label:'Fixed',right:true,render:v=>fmtI(v)},{key:'kb',label:'Kick Back',right:true,render:(v)=><span className={v>0?'text-red-600':''}>{fmtI(v)}</span>},{key:'issues',label:'Issue Types',right:true,render:v=>fmtI(v)}]} rows={byUser} />}
      </Section>
    </div>
  );
}
