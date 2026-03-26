import React, { useEffect, useState, useMemo, useCallback, useDeferredValue } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Card, Table, Pills, FilterBar, FilterSelect, FilterInput, FilterReset,
         ChartLegend, DrilldownDrawer, OrderLink,
         TOOLTIP_STYLE, fmtI, fmtP, fmtDateTime } from '../components/UI';
import { useData } from '../hooks/useData';

const COLORS=['#00aeef','#16a34a','#d97706','#ea580c','#9333ea','#0891b2','#dc2626','#65a30d','#7c3aed'];

function fmtDate(d){if(!d)return'';const[,m,day]=d.split('-');const months=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return`${months[parseInt(m)]} ${parseInt(day)}`;}

// Drilldown cols for QC events
const QC_COLS = [
  { key:'orderSerialNumber', label:'Order', w:110, sortable:true, render:(v)=><OrderLink serial={v} tab="discussion" /> },
  { key:'qcCreatedAt', label:'Date', w:130, sortable:true, render:v=>fmtDateTime(v) },
  { key:'outcome', label:'Outcome', w:90, sortable:true,
    render:v=><span className={`badge ${v==='Fixed It'?'badge-success':v==='Kick Back'?'badge-danger':'badge-neutral'}`}>{v||'—'}</span> },
  { key:'accountableName', label:'Accountable', w:140, sortable:true },
  { key:'departmentName', label:'Dept', w:120, sortable:true },
  { key:'issueName', label:'Issue', w:180, sortable:true },
  { key:'reporterName', label:'Reporter', w:130, sortable:true },
  { key:'orderType', label:'Type', w:80, sortable:true, render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span> },
];

export default function QCOverview() {
  const { qcEvents: events, qcLoading: loading, loadQc } = useData();
  const [view, setView] = useState('dept');
  const [fDept, setFDept] = useState(''); const [fType, setFType] = useState('');
  const [fErr, setFErr] = useState(''); const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState(''); const [fSearch, setFSearch] = useState('');
  const [drawer, setDrawer] = useState({ open:false, title:'', subtitle:'', rows:[] });

  const dFDept   = useDeferredValue(fDept);
  const dFType   = useDeferredValue(fType);
  const dFErr    = useDeferredValue(fErr);
  const dFFrom   = useDeferredValue(fFrom);
  const dFTo     = useDeferredValue(fTo);
  const dFSearch = useDeferredValue(fSearch);

  useEffect(() => { loadQc(); }, [loadQc]);

  const filtered = useMemo(() => events.filter(e => {
    if (dFDept && e.departmentName!==dFDept) return false;
    if (dFType && e.orderType!==dFType) return false;
    if (dFErr==='i_fixed_it' && !e.isFixedIt) return false;
    if (dFErr==='kick_it_back' && !e.isKickItBack) return false;
    if (dFFrom && e.qcCreatedAt && e.qcCreatedAt<dFFrom) return false;
    if (dFTo && e.qcCreatedAt && e.qcCreatedAt>dFTo+'T23:59:59') return false;
    if (dFSearch) {
      const q = dFSearch.toLowerCase();
      return (e.accountableName||'').toLowerCase().includes(q) ||
             (e.orderSerialNumber||'').toLowerCase().includes(q) ||
             (e.issueName||'').toLowerCase().includes(q) ||
             (e.departmentName||'').toLowerCase().includes(q);
    }
    return true;
  }), [events, dFDept, dFType, dFErr, dFFrom, dFTo, dFSearch]);

  const depts = useMemo(()=>[...new Set(events.map(e=>e.departmentName).filter(Boolean))].sort(),[events]);

  const m = useMemo(() => {
    if (!filtered.length) return null;
    const fi=filtered.filter(e=>e.isFixedIt).length; const kb=filtered.filter(e=>e.isKickItBack).length;
    const now=new Date(); const d7=new Date(now-7*86400000).toISOString(); const d14=new Date(now-14*86400000).toISOString();
    const tw=filtered.filter(e=>e.qcCreatedAt>=d7).length; const lw=filtered.filter(e=>e.qcCreatedAt>=d14&&e.qcCreatedAt<d7).length;
    return{total:filtered.length,fi,kb,orders:new Set(filtered.map(e=>e.orderSerialNumber).filter(Boolean)).size,
      users:new Set(filtered.map(e=>(e.accountableName||'').trim()).filter(Boolean)).size,
      fiP:filtered.length?fi/filtered.length:0,kbP:filtered.length?kb/filtered.length:0,
      trend:lw>0?Math.round((tw-lw)/lw*100):null};
  },[filtered]);

  const byDept = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{const k=e.departmentName||'(blank)';if(!d[k])d[k]={dept:k,total:0,fi:0,kb:0,orders:new Set(),users:new Set()};
      d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;
      if(e.orderSerialNumber)d[k].orders.add(e.orderSerialNumber);if(e.accountableName)d[k].users.add(e.accountableName.trim());});
    return Object.values(d).map(d=>({...d,orders:d.orders.size,users:d.users.size,fiP:d.total?d.fi/d.total:0,kbRate:d.total?Math.round(d.kb/d.total*100):0})).sort((a,b)=>b.total-a.total);
  },[filtered]);

  const byIssue = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{const k=e.issueName||'(blank)';const dept=e.departmentName||'';const key=k+'||'+dept;
      if(!d[key])d[key]={issue:k,dept,total:0,fi:0,kb:0,orders:new Set()};
      d[key].total++;if(e.isFixedIt)d[key].fi++;if(e.isKickItBack)d[key].kb++;if(e.orderSerialNumber)d[key].orders.add(e.orderSerialNumber);});
    return Object.values(d).map(d=>({...d,orders:d.orders.size,kbRate:d.total?Math.round(d.kb/d.total*100):0})).sort((a,b)=>b.total-a.total);
  },[filtered]);

  const byUser = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{const k=(e.accountableName||'').trim()||'(unattr)';const dept=e.departmentName||'';const key=k+'||'+dept;
      if(!d[key])d[key]={user:k,dept,total:0,fi:0,kb:0,issues:new Set()};
      d[key].total++;if(e.isFixedIt)d[key].fi++;if(e.isKickItBack)d[key].kb++;if(e.issueName)d[key].issues.add(e.issueName);});
    return Object.values(d).map(d=>({...d,issues:[...d.issues].sort().join(', '),issueCount:d.issues.size,
      kbRate:d.total?Math.round(d.kb/d.total*100):0})).sort((a,b)=>b.total-a.total).slice(0,50);
  },[filtered]);

  const dailyTrend = useMemo(()=>{
    const d={};filtered.forEach(e=>{const k=e.qcCreatedAt?.substring(0,10);if(!k)return;if(!d[k])d[k]={date:k,fi:0,kb:0,total:0};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;});
    return Object.values(d).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,label:fmtDate(d.date)}));
  },[filtered]);

  // Build event rows with outcome for drawer / event log
  const withOutcome = useCallback((evts) =>
    evts.map(e => ({...e, outcome: e.isFixedIt?'Fixed It':e.isKickItBack?'Kick Back':'—'})), []);

  const openDeptDrawer = useCallback((row) => {
    const evts = filtered.filter(e=>(e.departmentName||'(blank)')===row.dept);
    setDrawer({open:true, title:row.dept, subtitle:`${fmtI(row.total)} events · ${fmtI(row.fi)} fixed · ${fmtI(row.kb)} kick-back · ${row.kbRate}% KB rate`, rows:withOutcome(evts)});
  },[filtered, withOutcome]);

  const openIssueDrawer = useCallback((row) => {
    const evts = filtered.filter(e=>(e.issueName||'(blank)')===row.issue && (e.departmentName||'')===row.dept);
    setDrawer({open:true, title:row.issue||'(blank)', subtitle:`${fmtI(row.total)} events in ${row.dept||'all depts'} · ${row.orders} orders`, rows:withOutcome(evts)});
  },[filtered, withOutcome]);

  const openUserDrawer = useCallback((row) => {
    const evts = filtered.filter(e=>((e.accountableName||'').trim()||'(unattr)')===row.user && (e.departmentName||'')===row.dept);
    setDrawer({open:true, title:row.user, subtitle:`${row.dept} · ${fmtI(row.total)} errors · ${row.kbRate}% kick-back rate`, rows:withOutcome(evts)});
  },[filtered, withOutcome]);

  const clearF = ()=>{setFDept('');setFType('');setFErr('');setFFrom('');setFTo('');setFSearch('');};
  const hasF = fDept||fType||fErr||fFrom||fTo||fSearch;

  const deptCols = [
    {key:'dept',label:'Department',w:160,sortable:true},
    {key:'total',label:'Events',w:70,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'fi',label:'Fixed',w:65,right:true,sortable:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
    {key:'kb',label:'Kick Back',w:80,right:true,sortable:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
    {key:'fiP',label:'Fix Rate',w:75,right:true,sortable:true,render:v=><span className={v>=0.8?'text-emerald-600 font-semibold':v>=0.5?'text-amber-600':'text-red-600'}>{fmtP(v)}</span>},
    {key:'kbRate',label:'KB %',w:65,right:true,sortable:true,render:v=>v>20?<span className="text-red-600 font-bold">{v}%</span>:<span>{v}%</span>},
    {key:'orders',label:'Orders',w:65,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'users',label:'Users',w:60,right:true,sortable:true,render:v=>fmtI(v)},
  ];
  const issueCols = [
    {key:'issue',label:'Issue',w:220,sortable:true},
    {key:'dept',label:'Department',w:140,sortable:true},
    {key:'total',label:'Events',w:70,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'fi',label:'Fixed',w:65,right:true,sortable:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
    {key:'kb',label:'Kick Back',w:80,right:true,sortable:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
    {key:'kbRate',label:'KB %',w:65,right:true,sortable:true,render:v=>v>20?<span className="text-red-600 font-bold">{v}%</span>:<span>{v}%</span>},
    {key:'orders',label:'Orders',w:65,right:true,sortable:true,render:v=>fmtI(v)},
  ];
  const userCols = [
    {key:'user',label:'User',w:160,sortable:true},
    {key:'dept',label:'Dept',w:130,sortable:true},
    {key:'total',label:'Errors',w:65,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'fi',label:'Fixed',w:65,right:true,sortable:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
    {key:'kb',label:'Kick Back',w:80,right:true,sortable:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
    {key:'kbRate',label:'KB %',w:65,right:true,sortable:true,render:v=>v>20?<span className="text-red-600 font-bold">{v}%</span>:<span>{v}%</span>},
    {key:'issueCount',label:'Issue Types',w:90,right:true,sortable:true,render:v=>fmtI(v)},
    {key:'issues',label:'Issues',w:250,sortable:false,render:v=><span className="text-[10px] text-ink-400">{v}</span>},
  ];

  const eventLogRows = useMemo(()=>withOutcome(filtered.slice().sort((a,b)=>(b.qcCreatedAt||'').localeCompare(a.qcCreatedAt||'')).slice(0,1000)),[filtered,withOutcome]);
  const eventLogCols = [
    {key:'qcCreatedAt',label:'Date',w:130,sortable:true,render:v=>fmtDateTime(v)},
    {key:'orderSerialNumber',label:'Order',w:110,sortable:true,render:(v)=><OrderLink serial={v} tab="discussion" />},
    {key:'outcome',label:'Outcome',w:90,sortable:true,render:v=><span className={`badge ${v==='Fixed It'?'badge-success':v==='Kick Back'?'badge-danger':'badge-neutral'}`}>{v}</span>},
    {key:'accountableName',label:'Accountable',w:140,sortable:true},
    {key:'departmentName',label:'Dept',w:120,sortable:true},
    {key:'issueName',label:'Issue',w:180,sortable:true},
    {key:'reporterName',label:'Reporter',w:130,sortable:true},
    {key:'statusAtQcName',label:'Status at QC',w:150,sortable:true},
    {key:'orderType',label:'Type',w:80,sortable:true,render:v=><span className="capitalize text-[11px] text-ink-500">{v||'—'}</span>},
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900" data-tour="qc-title">QC Overview</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Quality control events · {fmtI(events.length)} total · <span className="text-brand-500">Click department, issue, or user rows to see events</span></p>
      </div>

      <FilterBar>
        <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
        <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
        <FilterSelect label="Outcome" value={fErr} onChange={setFErr} options={[{value:'i_fixed_it',label:'Fixed It'},{value:'kick_it_back',label:'Kick It Back'}]} />
        <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
        <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
        <FilterInput label="Search" value={fSearch} onChange={setFSearch} placeholder="Order, worker, issue…" />
        {hasF && <FilterReset onClick={clearF} />}
      </FilterBar>

      <div className="metric-grid-5">
        <Card label="QC Events" value={fmtI(m?.total)} color="brand" loading={loading} trend={m?.trend} />
        <Card label="Fixed It" value={fmtI(m?.fi)} sub={fmtP(m?.fiP)} color="green" loading={loading} />
        <Card label="Kick It Back" value={fmtI(m?.kb)} sub={fmtP(m?.kbP)} color="red" loading={loading} />
        <Card label="Orders Affected" value={fmtI(m?.orders)} color="slate" loading={loading} />
        <Card label="Accountable Users" value={fmtI(m?.users)} color="plum" loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-3">By Department — Fixed vs Kick Back</div>
          {!loading&&byDept.length>0?<>
            <ResponsiveContainer width="100%" height={Math.max(200,byDept.length*30+30)}>
              <BarChart data={byDept} layout="vertical" margin={{left:5,right:15}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="dept" width={140} tick={{fill:'#334155',fontSize:11}} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v,n)=>[fmtI(v),n==='fi'?'Fixed It':'Kick Back']} />
                <Bar dataKey="fi" stackId="a" fill="#16a34a" />
                <Bar dataKey="kb" stackId="a" fill="#dc2626" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
            <ChartLegend items={[{label:'Fixed It',color:'#16a34a'},{label:'Kick Back',color:'#dc2626'}]} />
          </>:<div className="h-48 loading rounded-lg" />}
        </div>
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-3">Department Share</div>
          {!loading&&byDept.length>0?
            <ResponsiveContainer width="100%" height={280}>
              <PieChart><Pie data={byDept.map(d=>({name:d.dept,value:d.total}))} cx="50%" cy="50%" innerRadius="35%" outerRadius="70%" paddingAngle={2} dataKey="value"
                label={({name,percent})=>percent>0.05?`${name} ${Math.round(percent*100)}%`:''} labelLine={false} style={{fontSize:10}}>
                {byDept.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Pie><Tooltip {...TOOLTIP_STYLE} formatter={v=>[fmtI(v),'Events']} /></PieChart>
            </ResponsiveContainer>:<div className="h-72 loading rounded-lg" />}
        </div>
      </div>

      <div className="card-surface p-4">
        <div className="text-xs font-semibold text-ink-600 mb-3">Daily QC Volume — Fixed vs Kick Back</div>
        {!loading&&dailyTrend.length>0?<>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyTrend} margin={{left:0,right:10,bottom:5}}>
              <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(dailyTrend.length/15))} />
              <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(_,p)=>p?.[0]?.payload?.date||''} formatter={(v,n)=>[fmtI(v),n==='fi'?'Fixed It':'Kick Back']} />
              <Bar dataKey="fi" stackId="a" fill="#16a34a" /><Bar dataKey="kb" stackId="a" fill="#dc2626" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
          <ChartLegend items={[{label:'Fixed It',color:'#16a34a'},{label:'Kick Back',color:'#dc2626'}]} />
        </>:<div className="h-48 loading rounded-lg" />}
      </div>

      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-600">Summary Breakdown</span>
          <Pills tabs={[{key:'dept',label:'Department'},{key:'issue',label:'Issue'},{key:'user',label:'User'}]} active={view} onChange={setView} />
        </div>
        {view==='dept' && <Table cols={deptCols} rows={byDept} defaultSort="total" defaultSortDir="desc" searchKey="dept" searchPlaceholder="Search departments…" onRow={openDeptDrawer} />}
        {view==='issue' && <Table cols={issueCols} rows={byIssue} defaultSort="total" defaultSortDir="desc" searchKey="issue" searchPlaceholder="Search issues…" onRow={openIssueDrawer} />}
        {view==='user' && <Table cols={userCols} rows={byUser} defaultSort="total" defaultSortDir="desc" searchKey="user" searchPlaceholder="Search users…" onRow={openUserDrawer} />}
      </div>

      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200">
          <span className="text-xs font-semibold text-ink-600">QC Event Log</span>
          <span className="text-[10px] text-ink-400 ml-2">{fmtI(Math.min(1000,eventLogRows.length))} most recent · sortable · click order to open admin</span>
        </div>
        <Table cols={eventLogCols} rows={eventLogRows} defaultSort="qcCreatedAt" defaultSortDir="desc"
          searchKey="accountableName" searchPlaceholder="Search events…" maxHeight="500px" />
      </div>

      <DrilldownDrawer
        open={drawer.open}
        onClose={() => setDrawer(d=>({...d,open:false}))}
        title={drawer.title}
        subtitle={drawer.subtitle}
        rows={drawer.rows}
        cols={QC_COLS}
      />
    </div>
  );
}
