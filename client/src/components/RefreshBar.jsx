import React, { useState, useEffect, useCallback } from 'react';
import { api, isAdmin } from '../hooks/useApi';

export default function RefreshBar() {
  const [status, setStatus] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api('/backfill/next');
      setStatus(d);
    } catch { /* silent — don't break dashboard if this fails */ }
  }, []);

  // Poll every 30s for status updates
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  // Tick the countdown every second
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const triggerRefresh = async () => {
    setTriggering(true);
    try {
      await api('/backfill/run', { method: 'POST', body: JSON.stringify({}) });
      // Reload status after a brief delay to catch the running state
      setTimeout(load, 1500);
    } catch (e) {
      // Will show 403 for non-admin — that's expected
      console.error('Refresh trigger failed:', e.message);
    }
    setTriggering(false);
  };

  if (!status) return null;

  // Compute relative times
  const lastRunAgo = status.lastRunAt ? formatAgo(now - new Date(status.lastRunAt).getTime()) : null;
  const nextIn = status.nextRunAt ? formatCountdown(new Date(status.nextRunAt).getTime() - now) : null;
  const overdue = status.nextRunAt && new Date(status.nextRunAt).getTime() < now;

  return (
    <div className="flex items-center gap-3 text-[11px]">
      {/* Status dot */}
      {status.isRunning ? (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-amber-600 font-medium">Syncing…</span>
        </div>
      ) : status.enabled ? (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span className="text-ink-400">Auto-refresh</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
          <span className="text-ink-400">Paused</span>
        </div>
      )}

      {/* Last run */}
      {lastRunAgo && !status.isRunning && (
        <span className="text-ink-400">
          Updated {lastRunAgo}
          {status.lastRunDurationSec ? <span className="text-ink-300"> · {status.lastRunDurationSec}s</span> : null}
        </span>
      )}

      {/* Next run countdown */}
      {status.enabled && !status.isRunning && nextIn && (
        <span className={overdue ? 'text-amber-500' : 'text-ink-300'}>
          · next {overdue ? 'momentarily' : `in ${nextIn}`}
        </span>
      )}

      {/* Refresh Now button — admin only */}
      {isAdmin() && !status.isRunning && (
        <button
          onClick={triggerRefresh}
          disabled={triggering}
          className="ml-1 px-2 py-0.5 rounded border border-surface-200 text-ink-500 hover:text-brand-600 hover:border-brand-200 transition-all disabled:opacity-50"
          title="Trigger incremental backfill now"
        >
          {triggering ? '…' : '↻ Refresh'}
        </button>
      )}
    </div>
  );
}

function formatAgo(ms) {
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatCountdown(ms) {
  if (ms <= 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec > 0 ? remSec + 's' : ''}`.trim();
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
