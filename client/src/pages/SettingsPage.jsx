import React, { useEffect, useState, useCallback } from 'react';
import { Section, Pills, Skel } from '../components/UI';
import { api, getUser, isManagerPlus } from '../hooks/useApi';

export default function SettingsPage() {
  const [tab, setTab] = useState('benchmarks');
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-display font-bold text-white">Configuration</h1><p className="text-xs text-slate-400 mt-0.5">Benchmarks, production hours, user levels · All changes audited</p></div>
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
    <div className="glass rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
        <Section title={title} sub={sub} />{canEdit&&!isEd&&<button onClick={startAdd} className="px-3 py-1.5 bg-navy-600 hover:bg-navy-500 text-white text-xs rounded-lg font-medium">+ Add</button>}
      </div>
      {adding&&editRow&&<div className="px-4 py-3 bg-navy-600/10 border-b border-navy-500/20">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-2.5">
          {allF.map(f=><div key={f.key}><label className="text-[10px] text-slate-400 uppercase">{f.label}</label><input type="text" value={editRow[f.key]||''} onChange={e=>upd(f.key,e.target.value)} className="w-full mt-1 px-2.5 py-1.5 bg-slate-800 border border-slate-600 rounded text-sm text-white" /></div>)}
        </div>
        <div className="grid grid-cols-6 gap-2.5 mb-2.5">
          {lvls.map(f=><div key={f}><label className="text-[10px] text-slate-400 uppercase">{f.toUpperCase()}</label><input type="number" step="0.1" value={editRow[f]??''} onChange={e=>upd(f,e.target.value?Number(e.target.value):null)} className="w-full mt-1 px-2.5 py-1.5 bg-slate-800 border border-slate-600 rounded text-sm text-white text-right" /></div>)}
        </div>
        <div className="flex gap-2"><button onClick={save} disabled={saving} className="px-3 py-1.5 bg-emerald-600 text-white text-xs rounded font-medium">{saving?'...':'Save'}</button><button onClick={cancel} className="px-3 py-1.5 bg-slate-700 text-white text-xs rounded">Cancel</button></div>
      </div>}
      <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
        {allF.map(f=><th key={f.key}>{f.label}</th>)}
        {lvls.map(f=><th key={f} className="text-right">{f.toUpperCase()}</th>)}
        <th className="text-right text-slate-500">By</th>{canEdit&&<th></th>}
      </tr></thead><tbody>
        {data.map((row,i)=>{const ed=editIdx===i&&!adding;const r=ed?editRow:row;return(
          <tr key={i} className={ed?'bg-navy-600/10':''}>
            {allF.map(f=><td key={f.key} className="font-medium text-white">{r[f.key]||'—'}</td>)}
            {lvls.map(f=><td key={f} className="text-right font-mono">{ed?<input type="number" step="0.1" value={r[f]??''} onChange={e=>upd(f,e.target.value?Number(e.target.value):null)} className="w-14 px-1.5 py-0.5 bg-slate-800 border border-slate-600 rounded text-right text-xs text-white" />:<span className={r[f]!=null?'text-white':'text-slate-600'}>{r[f]??'—'}</span>}</td>)}
            <td className="text-right text-[10px] text-slate-500">{row.updatedBy||'—'}</td>
            {canEdit&&<td className="text-right">{ed?<div className="flex gap-1 justify-end"><button onClick={save} disabled={saving} className="px-2 py-0.5 bg-emerald-600 text-white text-[10px] rounded">{saving?'...':'Save'}</button><button onClick={cancel} className="px-2 py-0.5 bg-slate-700 text-white text-[10px] rounded">×</button></div>:!isEd?<button onClick={()=>startEdit(i)} className="text-[10px] text-navy-400 hover:text-white">Edit</button>:null}</td>}
          </tr>);})}
      </tbody></table></div>
      {!data.length&&<div className="px-4 py-8 text-center text-slate-500 text-sm">No data. Click + Add to create entries.</div>}
    </div>
  );
}

function UserLevels() {
  const [users,setUsers]=useState([]);
  const [levels,setLevels]=useState({});
  const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState('');
  const [saving,setSaving]=useState(null);

  useEffect(()=>{(async()=>{setLoading(true);try{const[ur,lr]=await Promise.all([api('/users'),api('/config/user-levels').catch(()=>({levels:[]}))]);setUsers(ur.users||[]);const m={};for(const l of(lr.levels||[]))m[l.email?.toLowerCase()]=l.level;setLevels(m);}catch(e){console.error(e);}setLoading(false);})();},[]);

  const update=async(u,lv)=>{const em=(u.email||'').toLowerCase();setSaving(em);try{await api('/config/user-levels',{method:'PUT',body:JSON.stringify({email:em,name:u.fullName||'',department:u.departmentName||'',level:lv||null,changedBy:getUser()?.name})});setLevels(p=>({...p,[em]:lv||null}));}catch(e){alert('Failed: '+e.message);}setSaving(null);};

  const fl=users.filter(u=>{if(!filter)return true;const s=filter.toLowerCase();return(u.fullName||'').toLowerCase().includes(s)||(u.email||'').toLowerCase().includes(s)||(u.departmentName||'').toLowerCase().includes(s);});

  if(loading) return <Skel rows={10} cols={5} />;
  return (
    <div className="space-y-3">
      <div className="glass rounded-xl p-4"><Section title="User Levels" sub={`${users.length} staff. Level changes save immediately.`} />
        <input type="text" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search name, email, department..." className="w-full max-w-sm px-3 py-2 bg-slate-800/50 border border-slate-600/40 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-navy-400 mt-2" />
      </div>
      <div className="glass rounded-xl overflow-hidden"><div className="overflow-x-auto max-h-[550px] overflow-y-auto"><table className="tbl w-full"><thead className="sticky top-0 z-10"><tr><th>Name</th><th>Email</th><th>Department</th><th className="text-center">Level</th></tr></thead>
        <tbody>{fl.slice(0,100).map((u,i)=>{const em=(u.email||'').toLowerCase();const cl=levels[em]||'';const sv=saving===em;return(
          <tr key={i}><td className="font-medium text-white">{u.fullName||'—'}</td><td className="font-mono text-[11px]">{u.email||'—'}</td><td className="text-sm">{u.departmentName||'—'}</td>
          <td className="text-center"><select value={cl} onChange={e=>update(u,e.target.value)} disabled={sv} className={`px-1.5 py-0.5 bg-slate-800 border rounded text-xs text-center font-mono ${sv?'border-amber-500 text-amber-400':cl?'border-emerald-600/40 text-emerald-400':'border-slate-600 text-slate-400'}`}>{['','L0','L1','L2','L3','L4','L5'].map(l=><option key={l} value={l}>{l||'—'}</option>)}</select></td></tr>);})}</tbody></table></div>
      {fl.length>100&&<div className="px-4 py-1.5 text-[10px] text-slate-500 border-t border-slate-700/40">Showing 100 of {fl.length}</div>}</div>
    </div>
  );
}

function AuditLog() {
  const [logs,setLogs]=useState([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{(async()=>{setLoading(true);try{const r=await api('/config/audit-log?limit=100');setLogs(r.logs||[]);}catch{setLogs([]);}setLoading(false);})();},[]);
  if(loading) return <Skel rows={10} cols={4} />;
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700/40"><Section title="Audit Log" sub="Recent config changes" /></div>
      <div className="overflow-x-auto max-h-[550px] overflow-y-auto"><table className="tbl w-full"><thead className="sticky top-0 z-10"><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>{logs.map((l,i)=>(<tr key={i}>
          <td className="font-mono text-[10px] whitespace-nowrap">{l.timestamp?new Date(l.timestamp).toLocaleString('en-US',{timeZone:'America/New_York'}):'—'}</td>
          <td className="font-medium text-white text-xs">{l.changedBy||'—'}</td>
          <td><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${l.action==='upsert'?'bg-blue-500/15 text-blue-400':l.action==='seed'?'bg-purple-500/15 text-purple-400':'bg-slate-700/40 text-slate-400'}`}>{l.action}</span></td>
          <td className="text-[10px] text-slate-400">{(l.collection||'').replace('dashboard_','')}</td>
          <td className="text-[10px] text-slate-500 max-w-[200px] truncate">{JSON.stringify(l.data||{}).substring(0,100)}</td>
        </tr>))}</tbody></table></div>
      {!logs.length&&<div className="p-8 text-center text-slate-500 text-sm">No entries yet.</div>}
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
      <div className="glass rounded-xl p-4">
        <Section title="5-Bucket Thresholds" sub="Duration thresholds (minutes) for KPI classification. Applied per status." />
        <div className="mt-3 grid grid-cols-5 gap-2 text-[10px] text-slate-500">
          <div className="px-2 py-1 rounded bg-slate-700/30">Exclude Short: too fast</div>
          <div className="px-2 py-1 rounded bg-amber-600/10 border border-amber-500/20 text-amber-400">Out-of-Range Short</div>
          <div className="px-2 py-1 rounded bg-emerald-600/10 border border-emerald-500/20 text-emerald-400">In-Range (target)</div>
          <div className="px-2 py-1 rounded bg-orange-600/10 border border-orange-500/20 text-orange-400">Out-of-Range Long</div>
          <div className="px-2 py-1 rounded bg-red-600/10 border border-red-500/20 text-red-400">Exclude Long: too slow</div>
        </div>
      </div>
      <div className="glass rounded-xl overflow-hidden">
        <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
          <th>Status</th><th>Team</th>
          {fields.map(f => <th key={f.key} className="text-right">{f.label}</th>)}
        </tr></thead>
        <tbody>{benchmarks.map((b, i) => (
          <tr key={i}>
            <td className="font-medium text-white text-xs">{b.status}</td>
            <td className="text-xs text-slate-400">{b.team}</td>
            {fields.map(f => (
              <td key={f.key} className="text-right">
                {canEdit ? <input type="number" step="0.5" value={b[f.key] ?? ''} placeholder={f.key === 'excludeShortMin' ? '0.5' : f.key === 'inRangeMin' ? '1' : f.key === 'inRangeMax' ? '120' : '480'}
                  onBlur={e => { const v = e.target.value ? Number(e.target.value) : null; if (v !== (b[f.key] ?? null)) upd(b, f.key, v); }}
                  onChange={e => setBenchmarks(prev => prev.map(x => x.status === b.status ? { ...x, [f.key]: e.target.value ? Number(e.target.value) : null } : x))}
                  className={`w-16 px-1.5 py-0.5 bg-slate-800 border rounded text-right text-xs font-mono text-white ${saving === b.status+f.key ? 'border-amber-500' : 'border-slate-600'}`} />
                : <span className="text-xs font-mono">{b[f.key] ?? '—'}</span>}
              </td>
            ))}
          </tr>
        ))}</tbody></table></div>
        {!benchmarks.length && <div className="p-6 text-center text-slate-500 text-sm">No benchmarks configured. Add benchmarks first in the Benchmarks tab.</div>}
      </div>
    </div>
  );
}
