import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setToken, setUser } from '../hooks/useApi';

export default function InvitePage() {
  const [sp] = useSearchParams();
  const token = sp.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const nav = useNavigate();

  const submit = async e => {
    e.preventDefault(); setError('');
    if (password.length < 6) return setError('Password must be at least 6 characters');
    if (password !== confirm) return setError('Passwords do not match');
    setLoading(true);
    try {
      const r = await fetch('/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      setToken(d.token); setUser(d.user);
      setDone(true);
      setTimeout(() => nav('/'), 2000);
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-surface-100 via-white to-brand-50 flex items-center justify-center px-4">
        <div className="card-surface p-8 max-w-sm text-center">
          <div className="text-3xl mb-3">⚠️</div>
          <h2 className="font-display font-bold text-ink-900 text-lg">Invalid Invite Link</h2>
          <p className="text-sm text-ink-500 mt-2">This link is missing the invite token. Please check your email for the correct link, or ask your administrator to resend the invitation.</p>
          <button onClick={() => nav('/login')} className="mt-4 px-4 py-2 bg-brand-500 text-white text-sm rounded-lg font-semibold">Go to Sign In</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-100 via-white to-brand-50 flex items-center justify-center px-4">
      <div className="fixed inset-0 opacity-[0.03]" style={{backgroundImage:'radial-gradient(circle at 1px 1px, #00aeef 0.5px, transparent 0)',backgroundSize:'32px 32px'}} />
      <div className="w-full max-w-sm relative">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-500 shadow-lg shadow-brand-200 mb-4">
            <span className="text-white font-display font-bold text-xl">IEE</span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Welcome to IEE Ops</h1>
          <p className="text-ink-400 text-sm mt-1.5">Set your password to activate your account</p>
        </div>

        <div className="card-surface p-7">
          {done ? (
            <div className="text-center py-4">
              <div className="text-4xl mb-3">✓</div>
              <h3 className="font-display font-bold text-ink-900 text-lg">Account Activated!</h3>
              <p className="text-sm text-ink-500 mt-1">Redirecting to the dashboard...</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">New Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters"
                  className="w-full px-3.5 py-2.5 bg-white border border-surface-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Confirm Password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Type it again"
                  className="w-full px-3.5 py-2.5 bg-white border border-surface-200 rounded-lg text-ink-900 placeholder-ink-400 text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
              </div>
              {error && <div className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 font-medium">{error}</div>}
              <button type="submit" disabled={loading}
                className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-200 disabled:text-ink-400 text-white rounded-lg font-semibold text-sm transition-all shadow-lg shadow-brand-200">
                {loading ? 'Activating...' : 'Set Password & Activate'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
