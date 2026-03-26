import { useState, useCallback } from 'react';

// ── Auth helpers ────────────────────────────────────────────
// Uses localStorage so login persists across tabs and browser restarts.
// JWT expiration is checked client-side before API calls.
export const getToken = () => localStorage.getItem('iee_t') || '';
export const setToken = t => localStorage.setItem('iee_t', t);
export const getUser = () => JSON.parse(localStorage.getItem('iee_u') || 'null');
export const setUser = u => localStorage.setItem('iee_u', JSON.stringify(u));
export const clearAuth = () => {
  // Remove auth but preserve user-scoped state keys so they survive re-login
  const user = getUser();
  localStorage.removeItem('iee_t');
  localStorage.removeItem('iee_u');
  // Keep user-scoped keys: they'll be unreachable until re-login anyway
};

// ── Per-user localStorage ────────────────────────────────────────────────────
// All user-specific preferences (selected worker, chat history, etc.) are
// scoped to the authenticated user's ID so 10 users on the same browser
// profile don't share or overwrite each other's state.
function getUserId() {
  const u = getUser();
  return u?.id || u?._id || u?.email || 'anon';
}
export function userGet(key) {
  try { return JSON.parse(localStorage.getItem(`iee:${getUserId()}:${key}`) || 'null'); } catch { return null; }
}
export function userSet(key, value) {
  try { localStorage.setItem(`iee:${getUserId()}:${key}`, JSON.stringify(value)); } catch {}
}
export function userDel(key) {
  try { localStorage.removeItem(`iee:${getUserId()}:${key}`); } catch {}
}
export const isAuth = () => {
  const t = getToken();
  const u = getUser();
  if (!t || !u) return false;
  // Check JWT expiration client-side (avoids surprise 401 on first API call)
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearAuth();
      return false;
    }
  } catch { clearAuth(); return false; }
  return true;
};
export const isAdmin = () => getUser()?.role === 'admin';
export const isManagerPlus = () => ['admin','manager'].includes(getUser()?.role);

// ── Token remaining time (for UI display) ──────────────────
export function getTokenExpiresIn() {
  const t = getToken();
  if (!t) return null;
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (!payload.exp) return null;
    const ms = payload.exp * 1000 - Date.now();
    return ms > 0 ? ms : null;
  } catch { return null; }
}

// ── API fetch wrapper ──────────────────────────────────────
export async function api(path, opts = {}) {
  // Pre-check token expiration before making the call
  if (!isAuth()) {
    clearAuth();
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const token = getToken();
  const h = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(path, { ...opts, headers: h });
  if (r.status === 401) { clearAuth(); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `Error ${r.status}`); }
  return r.json();
}

// ── Login / Setup ──────────────────────────────────────────
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

// ── Generic data hook (kept for backward compat) ───────────
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
