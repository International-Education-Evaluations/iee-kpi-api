import React, { useEffect, useState, useCallback } from 'react';
import { Section, Pills, Skel } from '../components/UI';
import { api, getUser, isManagerPlus } from '../hooks/useApi';

export default function SettingsPage() {
  const [tab, setTab] = useState('benchmarks');
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-display font-bold text-ink-900">Configuration</h1><p className="text-xs text-ink-400 mt-0.5">Benchmarks, production hours, user levels · All changes audited</p></div>
      <Pills tabs={[{key:'benchmarks',label:'Benchmarks'},{key:'thresholds',label:'Thresholds'},{key:'hours',label:'Production Hours'},{key:'levels',label:'User Levels'},{key:'audit',label:'Audit Log'}]} active={tab} onChange={setTab} />
      {tab==='benchmarks'&&<ConfigTable title="XpH Benchmarks" sub="Targets by team, status, and level" endpoint="/config/benchmarks" dataKey="benchmarks" idFields={[{key:'team',label:'Team'},{key:'status',label:'Status'}]} extra={[{key:'xphUnit',label:'Unit'}]} />}
      {tab==='thresholds'&&<ThresholdConfig />}
      {tab==='hours'&&<ConfigTable title="Production Hours" sub="Net processing hours per day" endpoint="/config/production-hours" dataKey="hours" idFields={[{key:'team',label:'Team'},{key:'status',label:'Status'}]} />}
      {tab==='levels'&&<UserLevels />}
      {tab==='audit'&&<AuditLog />}
    </div>
  );
}

function ConfigTable({title,sub,endpoint,dataKey,idFields,extra=[]}) {
  const [data,setData]=useState([]);
  const [loading,setLoading]=useState(true);
  const [editIdx,setEditIdx]=useState(null);
  const [editRow,setEditRow]=useState(null);
  const [saving,setSaving]=useState(false);
  const [adding,setAdding]=useState(false);
  const lvls=['l0','l1','l2','l3','l4','l5'];
  const canEdit=isManagerPlus();

  const load=useCallback(async()=>{setLoading(true);try{const r=await api(endpoint);setData(r[dataKey]||[]);}catch{setData([]);}setLoading(false);},[endpoint,dataKey]);
  useEffect(()=>{load();},[load]);

  const startEdit=i=>{setEditIdx(i);setEditRow({...data[i]});setAdding(false);};
  const startAdd=()=>{const b={};idFields.forEach(f=>b[f.key]='');extra.forEach(f=>b[f.key]='');lvls.forEach(f=>b[f]=null);setEditRow(b);setAdding(true);setEditIdx(-1);};
  const cancel=()=>{setEditIdx(null);setEditRow(null);setAdding(false);};
  const save=async()=>{setSaving(true);try{await api(endpoint,{method:'PUT',body:JSON.stringify({...editRow,changedBy:getUser()?.name})});cancel();await load();}catch(e){alert('Failed: '+e.message);}setSaving(false);};
  const upd=(k,v)=>setEditRow(p=>({...p,[k]:v}));
  const allF=[...idFields,...extra];
  const isEd=editIdx!==null;

  if(loading) return <Skel rows={8} cols={6} />;

  return (
    <div className="card-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
        <Section title={title} sub={sub} />{canEdit&&!isEd&&<button onClick={startAdd} className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-ink-900 text-xs rounded-lg font-medium">+ Add</button>}
      </div>
      {adding&&editRow&&<div className="px-4 py-3 bg-brand-500/10 border-b border-navy-500/20">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-2.5">
          {allF.map(f=><div key={f.key}><label className="text-[10px] text-ink-400 uppercase">{f.label}</label><input type="text" value={editRow[f.key]||''} onChange={e=>upd(f.key,e.target.value)} className="w-full mt-1 px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>)}
        </div>
        <div className="grid grid-cols-6 gap-2.5 mb-2.5">
          {lvls.map(f=><div key={f}><label className="text-[10px] text-ink-400 uppercase">{f.toUpperCase()}</label><input type="number" step="0.1" value={editRow[f]??''} onChange={e=>upd(f,e.target.value?Number(e.target.value):null)} className="w-full mt-1 px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900 text-right" /></div>)}
        </div>
        <div className="flex gap-2"><button onClick={save} disabled={saving} className="px-3 py-1.5 bg-emerald-600 text-ink-900 text-xs rounded font-medium">{saving?'...':'Save'}</button><button onClick={cancel} className="px-3 py-1.5 bg-slate-700 text-ink-900 text-xs rounded">Cancel</button></div>
      </div>}
      <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
        {allF.map(f=><th key={f.key}>{f.label}</th>)}
        {lvls.map(f=><th key={f} className="text-right">{f.toUpperCase()}</th>)}
        <th className="text-right text-ink-500">By</th>{canEdit&&<th></th>}
      </tr></thead><tbody>
        {data.map((row,i)=>{const ed=editIdx===i&&!adding;const r=ed?editRow:row;return(
          <tr key={i} className={ed?'bg-brand-500/10':''}>
            {allF.map(f=><td key={f.key} className="font-medium text-ink-900">{r[f.key]||'—'}</td>)}
            {lvls.map(f=><td key={f} className="text-right font-mono">{ed?<input type="number" step="0.1" value={r[f]??''} onChange={e=>upd(f,e.target.value?Number(e.target.value):null)} className="w-14 px-1.5 py-0.5 bg-white border border-surface-200 rounded text-right text-xs text-ink-900" />:<span className={r[f]!=null?'text-ink-900':'text-slate-600'}>{r[f]??'—'}</span>}</td>)}
            <td className="text-right text-[10px] text-ink-500">{row.updatedBy||'—'}</td>
            {canEdit&&<td className="text-right">{ed?<div className="flex gap-1 justify-end"><button onClick={save} disabled={saving} className="px-2 py-0.5 bg-emerald-600 text-ink-900 text-[10px] rounded">{saving?'...':'Save'}</button><button onClick={cancel} className="px-2 py-0.5 bg-slate-700 text-ink-900 text-[10px] rounded">×</button></div>:!isEd?<button onClick={()=>startEdit(i)} className="text-[10px] text-brand-600 hover:text-ink-900">Edit</button>:null}</td>}
          </tr>);})}
      </tbody></table></div>
      {!data.length&&<div className="px-4 py-8 text-center text-ink-500 text-sm">No data. Click + Add to create entries.</div>}
    </div>
  );
}

function UserLevels() {
  const [users,setUsers]=useState([]);
  const [levels,setLevels]=useState({});
  const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState('');
  const [deptFilter,setDeptFilter]=useState('');
  const [saving,setSaving]=useState(null);

  useEffect(()=>{(async()=>{setLoading(true);try{const[ur,lr]=await Promise.all([api('/users'),api('/config/user-levels').catch(()=>({levels:[]}))]);setUsers(ur.users||[]);const m={};for(const l of(lr.levels||[]))m[l.email?.toLowerCase()]=l.level;setLevels(m);}catch(e){console.error(e);}setLoading(false);})();},[]);

  const update=async(u,lv)=>{const em=(u.email||'').toLowerCase();setSaving(em);try{await api('/config/user-levels',{method:'PUT',body:JSON.stringify({email:em,name:u.fullName||'',department:u.department||'',level:lv||null,changedBy:getUser()?.name})});setLevels(p=>({...p,[em]:lv||null}));}catch(e){alert('Failed: '+e.message);}setSaving(null);};

  const depts = [...new Set(users.map(u=>u.department).filter(Boolean))].sort();

  const fl=users.filter(u=>{
    if(deptFilter && u.department !== deptFilter) return false;
    if(!filter) return true;
    const s=filter.toLowerCase();
    return(u.fullName||'').toLowerCase().includes(s)||(u.email||'').toLowerCase().includes(s)||(u.department||'').toLowerCase().includes(s);
  });

  if(loading) return <Skel rows={10} cols={5} />;
  return (
    <div className="space-y-3">
      <div className="card-surface p-4"><Section title="User Levels" sub={`${users.length} staff. Level changes save immediately.`} />
        <div className="flex flex-wrap gap-3 mt-2">
          <input type="text" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search name, email..." className="flex-1 min-w-[200px] max-w-sm px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 placeholder-ink-400 focus:outline-none focus:border-brand-400" />
          <select value={deptFilter} onChange={e=>setDeptFilter(e.target.value)} className="px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-800 focus:outline-none focus:border-brand-400 min-w-[180px]">
            <option value="">All Departments</option>
            {depts.map(d=><option key={d} value={d}>{d}</option>)}
          </select>
          {(filter||deptFilter)&&<button onClick={()=>{setFilter('');setDeptFilter('');}} className="px-3 py-2 text-xs text-ink-400 hover:text-brand-600 font-medium">Clear</button>}
        </div>
        <div className="text-[10px] text-ink-400 mt-1.5">{fl.length} of {users.length} shown{deptFilter ? ` · ${deptFilter}` : ''}</div>
      </div>
      <div className="card-surface overflow-hidden"><div className="overflow-x-auto max-h-[550px] overflow-y-auto"><table className="tbl w-full"><thead className="sticky top-0 z-10"><tr><th>Name</th><th>Email</th><th>Department</th><th className="text-center">Level</th></tr></thead>
        <tbody>{fl.slice(0,200).map((u,i)=>{const em=(u.email||'').toLowerCase();const cl=levels[em]||'';const sv=saving===em;return(
          <tr key={i}><td className="font-medium text-ink-900">{u.fullName||'—'}</td><td className="font-mono text-[11px]">{u.email||'—'}</td><td className="text-sm">{u.department||'—'}</td>
          <td className="text-center"><select value={cl} onChange={e=>update(u,e.target.value)} disabled={sv} className={`px-1.5 py-0.5 bg-white border rounded text-xs text-center font-mono ${sv?'border-amber-500 text-amber-600':cl?'border-emerald-600/40 text-emerald-600':'border-surface-200 text-ink-400'}`}>{['','L0','L1','L2','L3','L4','L5'].map(l=><option key={l} value={l}>{l||'—'}</option>)}</select></td></tr>);})}</tbody></table></div>
      {fl.length>200&&<div className="px-4 py-1.5 text-[10px] text-ink-500 border-t border-surface-200">Showing 200 of {fl.length}</div>}</div>
    </div>
  );
}

function AuditLog() {
  const [logs,setLogs]=useState([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{(async()=>{setLoading(true);try{const r=await api('/config/audit-log?limit=100');setLogs(r.logs||[]);}catch{setLogs([]);}setLoading(false);})();},[]);
  if(loading) return <Skel rows={10} cols={4} />;
  return (
    <div className="card-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200"><Section title="Audit Log" sub="Recent config changes" /></div>
      <div className="overflow-x-auto max-h-[550px] overflow-y-auto"><table className="tbl w-full"><thead className="sticky top-0 z-10"><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>{logs.map((l,i)=>(<tr key={i}>
          <td className="font-mono text-[10px] whitespace-nowrap">{l.timestamp?new Date(l.timestamp).toLocaleString('en-US',{timeZone:'America/New_York'}):'—'}</td>
          <td className="font-medium text-ink-900 text-xs">{l.changedBy||'—'}</td>
          <td><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${l.action==='upsert'?'bg-blue-500/15 text-blue-400':l.action==='seed'?'bg-purple-500/15 text-purple-400':'bg-surface-200 text-ink-400'}`}>{l.action}</span></td>
          <td className="text-[10px] text-ink-400">{(l.collection||'').replace('dashboard_','')}</td>
          <td className="text-[10px] text-ink-500 max-w-[200px] truncate">{JSON.stringify(l.data||{}).substring(0,100)}</td>
        </tr>))}</tbody></table></div>
      {!logs.length&&<div className="p-8 text-center text-ink-500 text-sm">No entries yet.</div>}
    </div>
  );
}

function ThresholdConfig() {
  const [benchmarks, setBenchmarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const canEdit = isManagerPlus();

  useEffect(() => { (async () => { setLoading(true); try { const d = await api('/config/benchmarks'); setBenchmarks(d.benchmarks || []); } catch {} setLoading(false); })(); }, []);

  const upd = async (b, field, value) => {
    setSaving(b.status + field);
    try {
      await api('/config/benchmarks/thresholds', { method: 'PUT', body: JSON.stringify({
        status: b.status, [field]: value, changedBy: getUser()?.name
      })});
      setBenchmarks(prev => prev.map(x => x.status === b.status ? { ...x, [field]: value } : x));
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(null);
  };

  if (loading) return <Skel rows={8} cols={6} />;

  const fields = [
    { key: 'excludeShortMin', label: 'Exclude Short <', unit: 'min', desc: 'Below this = excluded (accidental clicks)' },
    { key: 'inRangeMin', label: 'In-Range Min', unit: 'min', desc: 'Start of acceptable range' },
    { key: 'inRangeMax', label: 'In-Range Max', unit: 'min', desc: 'End of acceptable range' },
    { key: 'excludeLongMax', label: 'Exclude Long >', unit: 'min', desc: 'Above this = excluded (left open)' },
  ];

  return (
    <div className="space-y-4">
      <div className="card-surface p-4">
        <Section title="5-Bucket Thresholds" sub="Duration thresholds (minutes) for KPI classification. Applied per status." />
        <div className="mt-3 grid grid-cols-5 gap-2 text-[10px] text-ink-500">
          <div className="px-2 py-1 rounded bg-surface-50">Exclude Short: too fast</div>
          <div className="px-2 py-1 rounded bg-amber-50 border border-amber-500/20 text-amber-600">Out-of-Range Short</div>
          <div className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-600">In-Range (target)</div>
          <div className="px-2 py-1 rounded bg-orange-600/10 border border-orange-500/20 text-orange-400">Out-of-Range Long</div>
          <div className="px-2 py-1 rounded bg-red-600/10 border border-red-200 text-red-600">Exclude Long: too slow</div>
        </div>
      </div>
      <div className="card-surface overflow-hidden">
        <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
          <th>Status</th><th>Team</th>
          {fields.map(f => <th key={f.key} className="text-right">{f.label}</th>)}
        </tr></thead>
        <tbody>{benchmarks.map((b, i) => (
          <tr key={i}>
            <td className="font-medium text-ink-900 text-xs">{b.status}</td>
            <td className="text-xs text-ink-400">{b.team}</td>
            {fields.map(f => (
              <td key={f.key} className="text-right">
                {canEdit ? <input type="number" step="0.5" value={b[f.key] ?? ''} placeholder={f.key === 'excludeShortMin' ? '0.5' : f.key === 'inRangeMin' ? '1' : f.key === 'inRangeMax' ? '120' : '480'}
                  onBlur={e => { const v = e.target.value ? Number(e.target.value) : null; if (v !== (b[f.key] ?? null)) upd(b, f.key, v); }}
                  onChange={e => setBenchmarks(prev => prev.map(x => x.status === b.status ? { ...x, [f.key]: e.target.value ? Number(e.target.value) : null } : x))}
                  className={`w-16 px-1.5 py-0.5 bg-white border rounded text-right text-xs font-mono text-ink-900 ${saving === b.status+f.key ? 'border-amber-500' : 'border-surface-200'}`} />
                : <span className="text-xs font-mono">{b[f.key] ?? '—'}</span>}
              </td>
            ))}
          </tr>
        ))}</tbody></table></div>
        {!benchmarks.length && <div className="p-6 text-center text-ink-500 text-sm">No benchmarks configured. Add benchmarks first in the Benchmarks tab.</div>}
      </div>
    </div>
  );
}
