import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { doLogin, doSetup, isAuth } from '../hooks/useApi';

export default function LoginPage() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverUp, setServerUp] = useState(null); // null=checking, true=up, false=down
  const nav = useNavigate();

  // If already authenticated, redirect to dashboard
  useEffect(() => { if (isAuth()) nav('/'); }, [nav]);

  // Check server health on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/health');
        if (!cancelled) setServerUp(r.ok);
      } catch {
        if (!cancelled) setServerUp(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async e => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      if (mode === 'setup') { await doSetup(email, password, name, setupSecret); }
      else { await doLogin(email, password); }
      nav('/');
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-100 via-white to-brand-50 flex items-center justify-center px-4">
      {/* Subtle pattern */}
      <div className="fixed inset-0 opacity-[0.03]" style={{backgroundImage:'radial-gradient(circle at 1px 1px, #00aeef 0.5px, transparent 0)',backgroundSize:'32px 32px'}} />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-500 shadow-lg shadow-brand-200 mb-4">
            <span className="text-white font-display font-bold text-xl">IEE</span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink-900 tracking-tight">Operations Dashboard</h1>
          <p className="text-ink-400 text-sm mt-1.5">KPI · QC · Queue · Reports</p>
        </div>

        {/* Server status indicator */}
        {serverUp === false && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm font-medium text-red-700">Server Unavailable</span>
            </div>
            <p className="text-xs text-red-600 mt-1">The API server is not responding. Check your Railway deployment and MongoDB Atlas cluster status.</p>
          </div>
        )}

        {/* Card */}
        <div className="card-surface p-7">
          <div className="flex gap-1 mb-5 bg-surface-100 rounded-lg p-1 border border-surface-200">
            <button onClick={() => setMode('login')} className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${mode==='login'?'bg-white text-brand-600 shadow-card border border-surface-200':'text-ink-500 hover:text-ink-700 border border-transparent'}`}>Sign In</button>
            <button onClick={() => setMode('setup')} className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${mode==='setup'?'bg-white text-brand-600 shadow-card border border-surface-200':'text-ink-500 hover:text-ink-700 border border-transparent'}`}>First-Time Setup</button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === 'setup' && <>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Setup Secret</label>
                <input type="password" value={setupSecret} onChange={e => setSetupSecret(e.target.value)} placeholder="Provided by administrator"
                  className="w-full px-3.5 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Your Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Andrew Nguyen"
                  className="w-full px-3.5 py-2.5 bg-white border border-surface-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
              </div>
            </>}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@myiee.org"
                className="w-full px-3.5 py-2.5 bg-white border border-surface-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                className="w-full px-3.5 py-2.5 bg-white border border-surface-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
            </div>
            {error && (
              <div className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <div className="font-medium">{error}</div>
                {error.includes('503') || error.includes('502') || error.includes('unavailable') || error.includes('Cannot reach') ? (
                  <div className="text-xs text-red-600 mt-1">This usually means the server ran out of resources. Check Railway deployment logs and MongoDB Atlas cluster status.</div>
                ) : null}
              </div>
            )}
            <button type="submit" disabled={loading || serverUp === false}
              className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-200 disabled:text-ink-400 text-white rounded-lg font-semibold text-sm transition-all shadow-lg shadow-brand-200">
              {loading ? 'Connecting...' : mode === 'setup' ? 'Create Admin Account' : 'Sign In'}
            </button>
          </form>
          {mode === 'setup' && <p className="text-[11px] text-ink-400 mt-3 text-center">Requires setup secret. Only works once.</p>}
        </div>
      </div>
    </div>
  );
}
