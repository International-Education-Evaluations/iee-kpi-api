import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Card, Table, Section, Pills, FilterBar, FilterSelect, FilterReset, Skel, ChartLegend, TOOLTIP_STYLE, fmt, fmtI, fmtP } from '../components/UI';
import DashboardGrid, { Widget } from '../components/DashboardGrid';
import { useData } from '../hooks/useData';

const COLORS=['#00aeef','#16a34a','#d97706','#ea580c','#9333ea','#0891b2','#dc2626','#65a30d','#7c3aed'];

const DEFAULT_LAYOUT = [
  { i: 'filters', x: 0, y: 0, w: 12, h: 1, static: true },
  { i: 'cards', x: 0, y: 1, w: 12, h: 2, minH: 2 },
  { i: 'byDept', x: 0, y: 3, w: 7, h: 5, minW: 4, minH: 3 },
  { i: 'pie', x: 7, y: 3, w: 5, h: 5, minW: 3, minH: 3 },
  { i: 'dailyTrend', x: 0, y: 8, w: 12, h: 5, minW: 6, minH: 3 },
  { i: 'breakdown', x: 0, y: 13, w: 12, h: 7, minW: 6, minH: 4 },
  { i: 'eventLog', x: 0, y: 20, w: 12, h: 8, minW: 8, minH: 5 },
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

  const m = useMemo(()=>{
    if(!filtered.length) return null;
    const fi=filtered.filter(e=>e.isFixedIt).length;
    const kb=filtered.filter(e=>e.isKickItBack).length;
    // Weekly trend
    const now = new Date();
    const d7 = new Date(now - 7*86400000).toISOString();
    const d14 = new Date(now - 14*86400000).toISOString();
    const thisWeek = filtered.filter(e => e.qcCreatedAt >= d7).length;
    const lastWeek = filtered.filter(e => e.qcCreatedAt >= d14 && e.qcCreatedAt < d7).length;
    const trend = lastWeek > 0 ? Math.round((thisWeek - lastWeek) / lastWeek * 100) : null;
    return{
      total:filtered.length, fi, kb,
      orders:new Set(filtered.map(e=>e.orderSerialNumber).filter(Boolean)).size,
      users:new Set(filtered.map(e=>(e.accountableName||'').trim()).filter(Boolean)).size,
      fiP:filtered.length?fi/filtered.length:0,
      kbP:filtered.length?kb/filtered.length:0,
      trend,
    };
  },[filtered]);

  const byDept = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{
      const k=e.departmentName||'(blank)';
      if(!d[k])d[k]={dept:k,total:0,fi:0,kb:0,orders:new Set(),users:new Set()};
      d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;
      if(e.orderSerialNumber)d[k].orders.add(e.orderSerialNumber);
      if(e.accountableName)d[k].users.add(e.accountableName.trim());
    });
    return Object.values(d).map(d=>({...d,orders:d.orders.size,users:d.users.size,fiP:d.total?d.fi/d.total:0})).sort((a,b)=>b.total-a.total);
  },[filtered]);

  const byIssue = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{const k=e.issueName||'(blank)';if(!d[k])d[k]={issue:k,total:0,fi:0,kb:0};d[k].total++;if(e.isFixedIt)d[k].fi++;if(e.isKickItBack)d[k].kb++;});
    return Object.values(d).sort((a,b)=>b.total-a.total);
  },[filtered]);

  const byUser = useMemo(()=>{
    const d={};
    filtered.forEach(e=>{
      const k=(e.accountableName||'').trim()||'(unattr)';
      const dept=e.departmentName||'';
      const key=k+'||'+dept;
      if(!d[key])d[key]={user:k,dept,total:0,fi:0,kb:0,issues:new Set()};
      d[key].total++;if(e.isFixedIt)d[key].fi++;if(e.isKickItBack)d[key].kb++;if(e.issueName)d[key].issues.add(e.issueName);
    });
    return Object.values(d).map(d=>({...d,issues:d.issues.size,kbRate:d.total?Math.round(d.kb/d.total*100):0})).sort((a,b)=>b.total-a.total).slice(0,30);
  },[filtered]);

  // Daily QC trend (new widget)
  const dailyTrend = useMemo(() => {
    const d = {};
    filtered.forEach(e => {
      const k = e.qcCreatedAt?.substring(0,10);
      if (!k) return;
      if (!d[k]) d[k] = { date: k, fi: 0, kb: 0, total: 0 };
      d[k].total++;
      if (e.isFixedIt) d[k].fi++;
      if (e.isKickItBack) d[k].kb++;
    });
    return Object.values(d).sort((a,b) => a.date.localeCompare(b.date)).map(d => ({
      ...d, label: formatDateShort(d.date),
    }));
  }, [filtered]);

  // Event log
  const eventLog = useMemo(() => {
    return filtered.slice().sort((a,b) => (b.qcCreatedAt||'').localeCompare(a.qcCreatedAt||'')).slice(0, 200).map(e => ({
      ...e,
      date: e.qcCreatedAt ? new Date(e.qcCreatedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—',
      outcome: e.isFixedIt ? 'Fixed It' : e.isKickItBack ? 'Kick Back' : '—',
    }));
  }, [filtered]);

  const clearF=()=>{setFDept('');setFType('');setFErr('');};

  // Pie chart custom label
  const renderPieLabel = ({ name, percent }) => percent > 0.05 ? `${name} ${Math.round(percent*100)}%` : '';

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">QC Overview</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">Quality control events · Last 60 days · {fmtI(events.length)} total</p>
      </div>

      <DashboardGrid pageId="qc-overview" defaultLayout={DEFAULT_LAYOUT}>
        <div key="filters">
          <FilterBar>
            <FilterSelect label="Department" value={fDept} onChange={setFDept} options={depts} />
            <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
            <FilterSelect label="Outcome" value={fErr} onChange={setFErr} options={[{value:'i_fixed_it',label:'Fixed It'},{value:'kick_it_back',label:'Kick It Back'}]} />
            {(fDept||fType||fErr) && <FilterReset onClick={clearF} />}
          </FilterBar>
        </div>

        <div key="cards">
          <Widget title="QC Summary">
            <div className="metric-grid-5">
              <Card label="QC Events" value={fmtI(m?.total)} color="brand" loading={loading} trend={m?.trend} icon="◆" />
              <Card label="Fixed It" value={fmtI(m?.fi)} sub={fmtP(m?.fiP)} color="green" loading={loading} icon="✓" />
              <Card label="Kick It Back" value={fmtI(m?.kb)} sub={fmtP(m?.kbP)} color="red" loading={loading} icon="✗" />
              <Card label="Orders Affected" value={fmtI(m?.orders)} color="slate" loading={loading} />
              <Card label="Accountable Users" value={fmtI(m?.users)} color="plum" loading={loading} />
            </div>
          </Widget>
        </div>

        <div key="byDept">
          <Widget title="By Department — Fixed vs Kick Back">
            {loading ? <Skel rows={5} /> : <>
            <ResponsiveContainer width="100%" height="82%">
              <BarChart data={byDept} layout="vertical" margin={{left:5,right:15}}>
                <XAxis type="number" tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <YAxis type="category" dataKey="dept" width={140} tick={{fill:'#334155',fontSize:11}} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => [fmtI(v), n==='fi'?'Fixed It':'Kick Back']} />
                <Bar dataKey="fi" stackId="a" fill="#16a34a" name="Fixed It" />
                <Bar dataKey="kb" stackId="a" fill="#dc2626" name="Kick Back" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
            <ChartLegend items={[{label:'Fixed It',color:'#16a34a'},{label:'Kick Back',color:'#dc2626'}]} />
            </>}
          </Widget>
        </div>

        <div key="pie">
          <Widget title="Department Share">
            {loading ? <Skel rows={5} /> :
            <ResponsiveContainer width="100%" height="85%">
              <PieChart>
                <Pie data={byDept.map(d=>({name:d.dept,value:d.total}))} cx="50%" cy="50%"
                  innerRadius="40%" outerRadius="75%" paddingAngle={2} dataKey="value"
                  label={renderPieLabel} labelLine={false}
                  style={{fontSize:10}}>
                  {byDept.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                </Pie>
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [fmtI(v), 'Events']} />
              </PieChart>
            </ResponsiveContainer>}
          </Widget>
        </div>

        {/* Daily QC Trend (NEW) */}
        <div key="dailyTrend">
          <Widget title="Daily QC Volume — Fixed vs Kick Back">
            {loading ? <Skel rows={5} /> : <>
            <ResponsiveContainer width="100%" height="82%">
              <BarChart data={dailyTrend} margin={{left:0,right:10,bottom:5}}>
                <XAxis dataKey="label" tick={{fill:'#64748b',fontSize:9}} angle={-45} textAnchor="end" height={50} interval={Math.max(0,Math.floor(dailyTrend.length/15))} />
                <YAxis tick={{fill:'#64748b',fontSize:10}} tickFormatter={v=>fmtI(v)} />
                <Tooltip {...TOOLTIP_STYLE}
                  labelFormatter={(_,payload) => payload?.[0]?.payload?.date || ''}
                  formatter={(v,n) => [fmtI(v), n==='fi'?'Fixed It':n==='kb'?'Kick Back':'Total']} />
                <Bar dataKey="fi" stackId="a" fill="#16a34a" name="Fixed It" />
                <Bar dataKey="kb" stackId="a" fill="#dc2626" name="Kick Back" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
            <ChartLegend items={[{label:'Fixed It',color:'#16a34a'},{label:'Kick Back',color:'#dc2626'}]} />
            </>}
          </Widget>
        </div>

        <div key="breakdown">
          <Widget title={<div className="flex items-center justify-between w-full">
            <span>Summary Breakdown</span>
            <Pills tabs={[{key:'dept',label:'Department'},{key:'issue',label:'Issue'},{key:'user',label:'User'}]} active={view} onChange={setView} />
          </div>}>
            {view==='dept'&&<Table cols={[
              {key:'dept',label:'Department',w:160},
              {key:'total',label:'Events',right:true,render:v=>fmtI(v)},
              {key:'fi',label:'Fixed',right:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
              {key:'kb',label:'Kick Back',right:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
              {key:'fiP',label:'Fix Rate',right:true,render:v=><span className={v>=0.8?'text-emerald-600 font-semibold':v>=0.5?'text-amber-600':'text-red-600'}>{fmtP(v)}</span>},
              {key:'orders',label:'Orders',right:true,render:v=>fmtI(v)},
              {key:'users',label:'Users',right:true,render:v=>fmtI(v)},
            ]} rows={byDept} />}
            {view==='issue'&&<Table cols={[
              {key:'issue',label:'Issue',w:250},
              {key:'total',label:'Events',right:true,render:v=>fmtI(v)},
              {key:'fi',label:'Fixed',right:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
              {key:'kb',label:'Kick Back',right:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
            ]} rows={byIssue} />}
            {view==='user'&&<Table cols={[
              {key:'user',label:'User',w:170},
              {key:'dept',label:'Dept',w:130},
              {key:'total',label:'Errors',right:true,render:v=>fmtI(v)},
              {key:'fi',label:'Fixed',right:true,render:v=><span className="text-emerald-600">{fmtI(v)}</span>},
              {key:'kb',label:'Kick Back',right:true,render:v=>v>0?<span className="text-red-600 font-semibold">{fmtI(v)}</span>:fmtI(v)},
              {key:'kbRate',label:'KB %',right:true,render:v=>v>20?<span className="text-red-600 font-bold">{v}%</span>:<span>{v}%</span>},
              {key:'issues',label:'Issue Types',right:true,render:v=>fmtI(v)},
            ]} rows={byUser} />}
          </Widget>
        </div>

        <div key="eventLog">
          <Widget title={`QC Event Log — ${eventLog.length} most recent`} noPad>
            <Table cols={[
              {key:'date',label:'Date',w:80},
              {key:'orderSerialNumber',label:'Order',w:110,render:v=>v?<a href={`https://admin.prod.iee.com/orders/${v}?tab=discussion`} target="_blank" rel="noopener" className="text-brand-600 hover:underline font-mono text-[11px]">{v}</a>:'—'},
              {key:'outcome',label:'Outcome',w:95,render:v=><span className={`badge ${v==='Fixed It'?'badge-success':v==='Kick Back'?'badge-danger':'badge-neutral'}`}>{v}</span>},
              {key:'accountableName',label:'Accountable',w:140},
              {key:'departmentName',label:'Department',w:130},
              {key:'issueName',label:'Issue',w:190},
              {key:'reporterName',label:'Reporter',w:130},
              {key:'orderType',label:'Type',w:75,render:v=><span className="capitalize text-ink-400">{v||'—'}</span>},
            ]} rows={eventLog} maxHeight="400px" />
          </Widget>
        </div>
      </DashboardGrid>
    </div>
  );
}

function formatDateShort(d) {
  if (!d) return '';
  const [,m,day] = d.split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)]} ${parseInt(day)}`;
}
