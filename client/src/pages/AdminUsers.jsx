import React, { useEffect, useState } from 'react';
import { Section, Table, Skel, fmtI } from '../components/UI';
import { api, getUser } from '../hooks/useApi';

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState('invite'); // 'invite' or 'manual'
  const [form, setForm] = useState({name:'',email:'',password:'',role:'viewer'});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState(null);
  const [success, setSuccess] = useState('');

  useEffect(()=>{load();},[]);
  async function load(){setLoading(true);try{const d=await api('/auth/users');setUsers(d.users||[]);}catch(e){console.error(e);}setLoading(false);}

  async function create(e){
    e.preventDefault(); setSaving(true); setError(''); setSuccess('');
    try {
      const body = mode === 'invite'
        ? { name: form.name, email: form.email, role: form.role, sendInvite: true }
        : { name: form.name, email: form.email, password: form.password, role: form.role };
      const d = await api('/auth/users',{method:'POST',body:JSON.stringify(body)});
      setShowCreate(false);
      setForm({name:'',email:'',password:'',role:'viewer'});
      if (d.invited) {
        setSuccess(`Invite sent to ${form.email}. They have 7 days to set their password.`);
      } else {
        setNewKey(d.user?.apiKey);
      }
      await load();
    } catch(e){setError(e.message);}
    setSaving(false);
  }

  async function resendInvite(u){
    try{await api('/auth/resend-invite',{method:'POST',body:JSON.stringify({email:u.email})});setSuccess(`Invite resent to ${u.email}`);}catch(e){alert('Failed: '+e.message);}
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
        <button onClick={()=>{setShowCreate(!showCreate);setError('');setSuccess('');}} className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm rounded-lg font-semibold">+ Invite User</button>
      </div>

      {success && <div className="card-surface p-4 bg-emerald-50 border-emerald-200">
        <div className="flex items-center justify-between">
          <p className="text-sm text-emerald-700 font-medium">{success}</p>
          <button onClick={()=>setSuccess('')} className="text-emerald-400 hover:text-emerald-700 text-sm">×</button>
        </div>
      </div>}

      {newKey && <div className="card-surface p-4 bg-emerald-50 border-emerald-200">
        <div className="text-sm font-semibold text-emerald-700 mb-1">New API Key Generated</div>
        <code className="text-xs font-mono text-ink-900 bg-white px-3 py-1.5 rounded block break-all border border-surface-200">{newKey}</code>
        <p className="text-[10px] text-ink-400 mt-2">Copy this now — it won't be shown again. <button onClick={()=>setNewKey(null)} className="text-ink-500 hover:text-ink-900 ml-2 font-medium">Dismiss</button></p>
      </div>}

      {showCreate && <div className="card-surface p-5">
        <Section title="Add New User" />

        {/* Mode toggle */}
        <div className="flex gap-1 bg-surface-100 rounded-lg p-1 border border-surface-200 w-fit mt-3 mb-4">
          <button onClick={()=>setMode('invite')} className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-all ${mode==='invite'?'bg-white text-brand-600 shadow-card border border-surface-200':'text-ink-500 border border-transparent'}`}>Send Invite Email</button>
          <button onClick={()=>setMode('manual')} className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-all ${mode==='manual'?'bg-white text-brand-600 shadow-card border border-surface-200':'text-ink-500 border border-transparent'}`}>Set Password Manually</button>
        </div>

        {mode === 'invite' && <div className="bg-brand-50 border border-brand-200 rounded-lg px-4 py-3 mb-4">
          <p className="text-xs text-brand-700">An email will be sent with a secure link to set their password. The link expires in 7 days.</p>
        </div>}

        <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div><label className="text-[10px] text-ink-400 uppercase font-semibold">Name</label><input type="text" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} required placeholder="Full name" className="w-full mt-1 px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase font-semibold">Email</label><input type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} required placeholder="user@myiee.org" className="w-full mt-1 px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" /></div>
          {mode === 'manual' && <div><label className="text-[10px] text-ink-400 uppercase font-semibold">Password</label><input type="password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} required={mode==='manual'} placeholder="Min 6 characters" className="w-full mt-1 px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" /></div>}
          <div><label className="text-[10px] text-ink-400 uppercase font-semibold">Role</label><select value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))} className="w-full mt-1 px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
          {error && <div className="col-span-full text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="col-span-full flex gap-2">
            <button type="submit" disabled={saving} className="px-5 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-200 disabled:text-ink-400 text-white text-sm rounded-lg font-semibold transition-all">{saving ? 'Sending...' : mode === 'invite' ? 'Send Invite' : 'Create User'}</button>
            <button type="button" onClick={()=>setShowCreate(false)} className="px-4 py-2 text-ink-500 hover:text-ink-700 text-sm font-medium">Cancel</button>
          </div>
        </form>
      </div>}

      <div className="card-surface overflow-hidden">
        <table className="tbl w-full">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>API Key</th><th></th></tr></thead>
          <tbody>{users.map(u=>(
            <tr key={u._id}>
              <td className="font-medium text-ink-900">{u.name}</td>
              <td className="font-mono text-xs">{u.email}</td>
              <td><select value={u.role} onChange={e=>changeRole(u,e.target.value)} className="bg-white text-xs border border-surface-200 rounded px-2 py-1 text-ink-600 focus:outline-none focus:border-brand-400">{['viewer','manager','admin'].map(r=><option key={r} value={r}>{r}</option>)}</select></td>
              <td>{u.isPending
                ? <span className="badge badge-warning">Pending</span>
                : u.isActive
                  ? <span className="badge badge-success">Active</span>
                  : <span className="badge badge-danger">Inactive</span>
              }</td>
              <td className="text-xs text-ink-500">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
              <td><code className="text-[10px] font-mono text-ink-400">{u.apiKey?.substring(0,12)}...</code></td>
              <td className="text-right">
                <div className="flex gap-1 justify-end">
                  {u.isPending && <button onClick={()=>resendInvite(u)} className="text-[10px] text-brand-600 hover:text-brand-700 px-2 py-0.5 border border-brand-200 rounded font-medium">Resend</button>}
                  <button onClick={()=>regenKey(u)} className="text-[10px] text-ink-500 hover:text-ink-900 px-2 py-0.5 border border-surface-200 rounded">New Key</button>
                  <button onClick={()=>toggleActive(u)} className={`text-[10px] px-2 py-0.5 border rounded font-medium ${u.isActive?'text-red-600 border-red-200 hover:bg-red-50':'text-emerald-600 border-emerald-200 hover:bg-emerald-50'}`}>{u.isActive?'Deactivate':'Activate'}</button>
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
