import React, { useState, useEffect, useCallback } from 'react';
import { api, isAdmin } from '../hooks/useApi';
import { useData } from '../hooks/useData';

export default function RefreshBar() {
  const [status, setStatus] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [triggering, setTriggering] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const { loadStatus, refreshAll, loadKpi, loadQc, loadQueue } = useData();

  const load = useCallback(async () => {
    try {
      const d = await api('/backfill/next', { silent: true });
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

  // Compute load-status rollup. Worst loader wins so a single failure surfaces.
  const loaders = loadStatus || {};
  const states  = Object.values(loaders).map(l => l?.state).filter(Boolean);
  const dataState = states.includes('error')   ? 'error'
                  : states.includes('partial') ? 'partial'
                  : states.includes('loading') ? 'loading'
                  : states.includes('ok')      ? 'ok'
                  : 'idle';
  const errorCount = Object.values(loaders).filter(l => l?.state === 'error').length;
  const partialCount = Object.values(loaders).filter(l => l?.state === 'partial').length;
  const showDataIndicator = dataState === 'error' || dataState === 'partial';

  if (!status && !showDataIndicator) return null;

  // Compute relative times
  const lastRunAgo = status?.lastRunAt ? formatAgo(now - new Date(status.lastRunAt).getTime()) : null;
  const nextIn = status?.nextRunAt ? formatCountdown(new Date(status.nextRunAt).getTime() - now) : null;
  const overdue = status?.nextRunAt && new Date(status.nextRunAt).getTime() < now;

  return (
    <div className="flex items-center gap-3 text-[11px] relative">
      {/* Data-load health indicator — only shows when something errored or partially failed */}
      {showDataIndicator && (
        <button onClick={() => setDiagOpen(o => !o)}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md border transition-colors ${
            dataState === 'error'
              ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
              : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
          }`}
          title="Show data load diagnostics">
          <span className={`w-1.5 h-1.5 rounded-full ${dataState === 'error' ? 'bg-red-500' : 'bg-amber-500'}`} />
          <span className="font-semibold">
            {dataState === 'error' ? `${errorCount} load error${errorCount === 1 ? '' : 's'}` : `${partialCount} partial`}
          </span>
        </button>
      )}

      {/* Diagnostic popover */}
      {diagOpen && (
        <DiagPopover
          loaders={loaders}
          onClose={() => setDiagOpen(false)}
          onRetryAll={() => { setDiagOpen(false); refreshAll(); }}
          onRetry={(key) => {
            setDiagOpen(false);
            if (key === 'kpi')   loadKpi(true);
            if (key === 'qc')    loadQc(true);
            if (key === 'queue') loadQueue(true);
          }}
        />
      )}

      {!status && <span className="text-ink-400">—</span>}
      {/* Status dot */}
      {!status ? null : status.isRunning ? (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-amber-600 font-medium">Syncing…</span>
        </div>
      ) : status?.enabled ? (
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
      {lastRunAgo && !status?.isRunning && (
        <span className="text-ink-400">
          Updated {lastRunAgo}
          {status?.lastRunDurationSec ? <span className="text-ink-300"> · {status.lastRunDurationSec}s</span> : null}
        </span>
      )}

      {/* Next run countdown */}
      {status?.enabled && !status?.isRunning && nextIn && (
        <span className={overdue ? 'text-amber-500' : 'text-ink-300'}>
          · next {overdue ? 'momentarily' : `in ${nextIn}`}
        </span>
      )}

      {/* Refresh Now button — admin only */}
      {isAdmin() && !status?.isRunning && (
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

function DiagPopover({ loaders, onClose, onRetry, onRetryAll }) {
  // Tap-outside-to-close.
  React.useEffect(() => {
    const h = (e) => { if (!e.target.closest?.('[data-diag-popover]')) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  const rows = [
    { key: 'kpi',   label: 'KPI segments + benchmarks + users' },
    { key: 'qc',    label: 'QC events' },
    { key: 'queue', label: 'Queue snapshot + wait summary' },
  ];
  const stateColor = (s) => s === 'ok'      ? 'bg-emerald-500'
                          : s === 'partial' ? 'bg-amber-500'
                          : s === 'error'   ? 'bg-red-500'
                          : s === 'loading' ? 'bg-brand-500 animate-pulse'
                          : 'bg-slate-300';
  const stateLabel = (s) => s === 'ok' ? 'OK' : s === 'partial' ? 'Partial' : s === 'error' ? 'Failed' : s === 'loading' ? 'Loading…' : 'Idle';

  return (
    <div data-diag-popover
      className="absolute top-full right-0 mt-2 w-[360px] z-50 card-surface bg-white shadow-xl border border-surface-200 p-3 text-left">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-display font-bold text-ink-900">Data load diagnostics</span>
        <button onClick={onRetryAll}
          className="text-[11px] font-semibold text-brand-600 hover:text-brand-700">
          Retry all
        </button>
      </div>
      <div className="space-y-2">
        {rows.map(r => {
          const l = loaders[r.key] || {};
          return (
            <div key={r.key} className="flex items-start gap-2 text-[11px]">
              <span className={`mt-1 w-2 h-2 rounded-full ${stateColor(l.state)} shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink-700">{r.label}</span>
                  <span className="text-ink-400">{stateLabel(l.state)}</span>
                </div>
                {l.error && <div className="text-red-600 mt-0.5 break-words">{l.error}</div>}
                {l.partial && Object.keys(l.partial).length > 0 && l.state === 'partial' && (
                  <div className="text-amber-700 mt-0.5">
                    {Object.entries(l.partial).filter(([, v]) => v !== 'ok').map(([k, v]) => (
                      <div key={k}><span className="font-mono">{k}</span>: {v}</div>
                    ))}
                  </div>
                )}
                {(l.state === 'error' || l.state === 'partial') && (
                  <button onClick={() => onRetry(r.key)}
                    className="mt-1 text-[10px] font-semibold text-brand-600 hover:text-brand-700">
                    Retry
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 pt-2 border-t border-surface-100 text-[10px] text-ink-400">
        If retries keep failing, check <code className="font-mono">/health</code> or the Diagnostics page for backfill watchdog resets.
      </div>
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
