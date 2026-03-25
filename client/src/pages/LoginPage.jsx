import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doLogin, doSetup } from '../hooks/useApi';

export default function LoginPage() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  const submit = async e => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      if (mode === 'setup') { await doSetup(email, password, name); }
      else { await doLogin(email, password); }
      nav('/');
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="fixed inset-0 opacity-[0.015]" style={{backgroundImage:'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',backgroundSize:'24px 24px'}} />
      <div className="w-full max-w-sm relative">
        <div className="text-center mb-8">
          <h1 className="font-display text-3xl font-bold text-white tracking-tight">IEE <span className="text-navy-400">Operations</span></h1>
          <p className="text-slate-500 text-sm mt-2">KPI · QC · Queue Dashboard</p>
        </div>
        <div className="glass rounded-2xl p-7">
          <div className="flex gap-2 mb-5">
            <button onClick={() => setMode('login')} className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${mode==='login'?'bg-navy-600 text-white':'text-slate-400 hover:text-white'}`}>Sign In</button>
            <button onClick={() => setMode('setup')} className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${mode==='setup'?'bg-navy-600 text-white':'text-slate-400 hover:text-white'}`}>First-Time Setup</button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'setup' && <div>
              <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1">Your Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Andrew Nguyen"
                className="w-full px-3.5 py-2 bg-slate-800/50 border border-slate-600/40 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:border-navy-400" />
            </div>}
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@myiee.org"
                className="w-full px-3.5 py-2 bg-slate-800/50 border border-slate-600/40 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:border-navy-400" />
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                className="w-full px-3.5 py-2 bg-slate-800/50 border border-slate-600/40 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:border-navy-400" />
            </div>
            {error && <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 bg-navy-600 hover:bg-navy-500 disabled:bg-slate-700 text-white rounded-lg font-medium text-sm transition-colors shadow-lg shadow-navy-600/15">
              {loading ? 'Connecting...' : mode === 'setup' ? 'Create Admin Account' : 'Sign In'}
            </button>
          </form>
          {mode === 'setup' && <p className="text-[10px] text-slate-500 mt-3 text-center">First-time setup creates the initial admin account. Only works once.</p>}
        </div>
      </div>
    </div>
  );
}
