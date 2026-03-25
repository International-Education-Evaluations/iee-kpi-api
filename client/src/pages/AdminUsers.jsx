import React, { useEffect, useState } from 'react';
import { Section, Table, Skel, fmtI } from '../components/UI';
import { api, getUser } from '../hooks/useApi';

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({name:'',email:'',password:'',role:'viewer'});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState(null);

  useEffect(()=>{load();},[]);
  async function load(){setLoading(true);try{const d=await api('/auth/users');setUsers(d.users||[]);}catch(e){console.error(e);}setLoading(false);}

  async function create(e){
    e.preventDefault(); setSaving(true); setError('');
    try{const d=await api('/auth/users',{method:'POST',body:JSON.stringify(form)});setShowCreate(false);setForm({name:'',email:'',password:'',role:'viewer'});setNewKey(d.user?.apiKey);await load();}
    catch(e){setError(e.message);}
    setSaving(false);
  }

  async function toggleActive(u){
    try{await api(`/auth/users/${u._id}`,{method:'PUT',body:JSON.stringify({isActive:!u.isActive})});await load();}catch(e){alert('Failed: '+e.message);}
  }

  async function regenKey(u){
    if(!confirm(`Regenerate API key for ${u.name}? The old key will stop working.`)) return;
    try{const d=await api(`/auth/users/${u._id}/regenerate-key`,{method:'POST'});setNewKey(d.apiKey);await load();}catch(e){alert('Failed: '+e.message);}
  }

  async function changeRole(u,role){
    try{await api(`/auth/users/${u._id}`,{method:'PUT',body:JSON.stringify({role})});await load();}catch(e){alert('Failed: '+e.message);}
  }

  if(loading) return <Skel rows={8} cols={5} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">User Management</h1><p className="text-xs text-ink-400 mt-0.5">{users.length} dashboard users</p></div>
        <button onClick={()=>setShowCreate(!showCreate)} className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-ink-900 text-sm rounded-lg font-medium">+ Create User</button>
      </div>

      {newKey && <div className="card-surface p-4 border-emerald-500/30 bg-emerald-50">
        <div className="text-sm font-medium text-emerald-600 mb-1">New API Key Generated</div>
        <code className="text-xs font-mono text-ink-900 bg-white px-3 py-1.5 rounded block break-all">{newKey}</code>
        <p className="text-[10px] text-ink-400 mt-2">Copy this now — it won't be shown again. <button onClick={()=>setNewKey(null)} className="text-ink-400 hover:text-ink-900 ml-2">Dismiss</button></p>
      </div>}

      {showCreate && <div className="card-surface p-5">
        <Section title="Create New User" />
        <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
          <div><label className="text-[10px] text-ink-400 uppercase">Name</label><input type="text" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} required className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Email</label><input type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} required className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Password</label><input type="password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} required className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Role</label><select value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))} className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900"><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
          {error && <div className="col-span-full text-red-600 text-sm">{error}</div>}
          <div className="col-span-full flex gap-2"><button type="submit" disabled={saving} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-ink-900 text-sm rounded font-medium">{saving?'Creating...':'Create User'}</button><button type="button" onClick={()=>setShowCreate(false)} className="px-4 py-1.5 bg-slate-700 text-ink-900 text-sm rounded">Cancel</button></div>
        </form>
      </div>}

      <div className="card-surface overflow-hidden">
        <table className="tbl w-full">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last Login</th><th>API Key</th><th></th></tr></thead>
          <tbody>{users.map(u=>(
            <tr key={u._id}>
              <td className="font-medium text-ink-900">{u.name}</td>
              <td className="font-mono text-xs">{u.email}</td>
              <td><select value={u.role} onChange={e=>changeRole(u,e.target.value)} className="bg-transparent text-xs border border-surface-200 rounded px-2 py-0.5 text-ink-600">{['viewer','manager','admin'].map(r=><option key={r} value={r}>{r}</option>)}</select></td>
              <td>{u.isActive?<span className="text-emerald-600 text-xs">Active</span>:<span className="text-red-600 text-xs">Inactive</span>}</td>
              <td className="text-xs text-ink-500">{u.lastLoginAt?new Date(u.lastLoginAt).toLocaleDateString():'Never'}</td>
              <td><code className="text-[10px] font-mono text-ink-500">{u.apiKey?.substring(0,12)}...</code></td>
              <td className="text-right">
                <div className="flex gap-1 justify-end">
                  <button onClick={()=>regenKey(u)} className="text-[10px] text-brand-600 hover:text-ink-900 px-2 py-0.5 border border-surface-200 rounded">New Key</button>
                  <button onClick={()=>toggleActive(u)} className={`text-[10px] px-2 py-0.5 border rounded ${u.isActive?'text-red-600 border-red-500/30 hover:bg-red-50':'text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10'}`}>{u.isActive?'Deactivate':'Activate'}</button>
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
