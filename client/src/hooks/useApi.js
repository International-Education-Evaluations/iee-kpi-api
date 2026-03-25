import { useState, useCallback } from 'react';

export const getToken = () => sessionStorage.getItem('iee_t') || '';
export const setToken = t => sessionStorage.setItem('iee_t', t);
export const getUser = () => JSON.parse(sessionStorage.getItem('iee_u') || 'null');
export const setUser = u => sessionStorage.setItem('iee_u', JSON.stringify(u));
export const clearAuth = () => { sessionStorage.removeItem('iee_t'); sessionStorage.removeItem('iee_u'); };
export const isAuth = () => !!getToken() && !!getUser();
export const isAdmin = () => getUser()?.role === 'admin';
export const isManagerPlus = () => ['admin','manager'].includes(getUser()?.role);

export async function api(path, opts = {}) {
  const token = getToken();
  const h = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(path, { ...opts, headers: h });
  if (r.status === 401) { clearAuth(); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `Error ${r.status}`); }
  return r.json();
}

export async function doLogin(email, password) {
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Login failed');
  setToken(d.token); setUser(d.user);
  return d.user;
}

export async function doSetup(email, password, name, setupSecret) {
  const r = await fetch('/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name, setupSecret }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Setup failed');
  setToken(d.token); setUser(d.user);
  return d.user;
}

export function useData(init = null) {
  const [data, setData] = useState(init);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(async (path) => {
    setLoading(true); setError(null);
    try { const r = await api(path); setData(r); return r; }
    catch (e) { setError(e.message); return null; }
    finally { setLoading(false); }
  }, []);
  return { data, loading, error, load, setData };
}
