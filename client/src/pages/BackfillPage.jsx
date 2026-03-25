import React, { useEffect, useState } from 'react';
import { Card, Section, Skel, fmtI } from '../components/UI';
import { api } from '../hooks/useApi';

export default function BackfillPage() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState('incremental');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  async function load() {
    try {
      const [s, st, h] = await Promise.all([
        api('/backfill/status'), api('/backfill/settings'),
        api('/backfill/history').catch(() => ({ history: [] }))
      ]);
      setStatus(s); setSettings(st); setHistory(h.history || []);
      setRunning(s.isRunning);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  const triggerBackfill = async () => {
    setRunning(true);
    const body = {};
    if (mode === 'full') { body.full = true; body.days = settings?.days || 90; }
    else if (mode === 'range') { body.dateFrom = dateFrom; body.dateTo = dateTo; }
    // incremental = empty body
    try { await api('/backfill/run', { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { alert('Failed: ' + e.message); setRunning(false); }
  };

  const saveSettings = async () => {
    setSaving(true);
    try { await api('/backfill/settings', { method: 'PUT', body: JSON.stringify(settings) }); await load(); }
    catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  // Quick month buttons
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const from = d.toISOString().slice(0, 10);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const to = last.toISOString().slice(0, 10);
    months.push({ label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), from, to });
  }

  if (loading) return <Skel rows={6} cols={3} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">Data Backfill</h1>
          <p className="text-xs text-ink-400 mt-0.5">Sync production data into the dashboard for fast reads</p></div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
        <Card label="Segments" value={fmtI(status?.currentCounts?.segments)} color="navy" />
        <Card label="QC Events" value={fmtI(status?.currentCounts?.qcEvents)} color="green" />
        <Card label="Users" value={fmtI(status?.currentCounts?.users)} color="plum" />
        <Card label="Last Run" value={status?.lastRunDurationSec ? status.lastRunDurationSec + 's' : '—'} color="slate" />
        <Card label="Open Segs" value={fmtI(status?.counts?.openSegments)} color="amber" />
        <Card label="Status" value={running ? 'Running' : 'Idle'} color={running ? 'amber' : 'green'} />
      </div>

      {/* Backfill Controls */}
      <div className="card-surface p-5">
        <Section title="Run Backfill" sub="Choose a mode and run" />

        <div className="flex gap-2 mt-3 mb-4">
          {[
            { key: 'incremental', label: 'Incremental', desc: 'Only new records since last run' },
            { key: 'range', label: 'Date Range', desc: 'Specific month or date window' },
            { key: 'full', label: 'Full Refresh', desc: 'Wipe and re-seed everything' },
          ].map(m => (
            <button key={m.key} onClick={() => setMode(m.key)}
              className={`flex-1 p-3 rounded-lg border text-left transition-all ${mode === m.key
                ? 'border-brand-200 bg-brand-500/10'
                : 'border-surface-200 hover:border-surface-300'}`}>
              <div className="text-sm font-medium text-ink-900">{m.label}</div>
              <div className="text-[10px] text-ink-400 mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>

        {mode === 'range' && <div className="mb-4 p-4 bg-surface-50 rounded-lg">
          <div className="text-[10px] text-ink-400 uppercase font-medium mb-2">Quick Select — Month</div>
          <div className="flex gap-1.5 flex-wrap mb-3">
            {months.map(m => (
              <button key={m.from} onClick={() => { setDateFrom(m.from); setDateTo(m.to); }}
                className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-all ${dateFrom === m.from && dateTo === m.to
                  ? 'bg-brand-500/20 border-brand-200 text-ink-900'
                  : 'border-surface-200 text-ink-400 hover:text-ink-900 hover:border-surface-200'}`}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">From Date</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="w-full px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
            </div>
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">To Date</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="w-full px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
            </div>
          </div>
        </div>}

        {mode === 'full' && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-xs text-red-600">Full refresh will delete all existing backfill data and re-fetch from production. Use only if data is corrupted or for initial setup.</p>
        </div>}

        <button onClick={triggerBackfill} disabled={running || (mode === 'range' && !dateFrom)}
          className={`px-5 py-2 text-ink-900 text-sm rounded-lg font-medium ${running ? 'bg-amber-600 animate-pulse' : mode === 'full' ? 'bg-red-600 hover:bg-red-500' : 'bg-brand-500 hover:bg-brand-600'} disabled:bg-surface-200 disabled:text-ink-400`}>
          {running ? 'Backfill Running...' : mode === 'full' ? 'Run Full Refresh' : mode === 'range' ? `Backfill ${dateFrom || '...'} → ${dateTo || 'now'}` : 'Run Incremental'}
        </button>
      </div>

      {/* Last Run Info */}
      {status?.lastRunAt && <div className="card-surface p-4">
        <Section title="Last Backfill" sub={`${new Date(status.lastRunAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} · ${status.mode || 'unknown'} · by ${status.triggeredBy || 'system'}`} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-xs">
          <div className="p-2 bg-surface-50 rounded"><span className="text-ink-500">Orders scanned:</span> <span className="text-ink-900 font-mono">{fmtI(status.counts?.ordersScanned)}</span></div>
          <div className="p-2 bg-surface-50 rounded"><span className="text-ink-500">Segments new:</span> <span className="text-emerald-600 font-mono">{fmtI(status.counts?.segmentsNew)}</span></div>
          <div className="p-2 bg-surface-50 rounded"><span className="text-ink-500">Segments updated:</span> <span className="text-amber-600 font-mono">{fmtI(status.counts?.segmentsUpdated)}</span></div>
          <div className="p-2 bg-surface-50 rounded"><span className="text-ink-500">QC new:</span> <span className="text-emerald-600 font-mono">{fmtI(status.counts?.qcNew)}</span></div>
        </div>
        {status.log && <details className="mt-3"><summary className="text-[10px] text-ink-500 cursor-pointer hover:text-ink-900">Run log ({status.log.length} entries)</summary>
          <div className="mt-2 bg-white rounded-lg p-3 max-h-48 overflow-y-auto">
            {status.log.map((line, i) => <div key={i} className="text-[11px] font-mono text-ink-400 leading-relaxed">{line}</div>)}
          </div>
        </details>}
        {status.lastError && <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{status.lastError}</div>}
      </div>}

      {/* Settings */}
      <div className="card-surface p-5">
        <Section title="Auto-Refresh Settings" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Refresh Interval (minutes)</label>
            <input type="number" value={settings?.autoRefreshMinutes || 5} min={1} max={60}
              onChange={e => setSettings(s => ({ ...s, autoRefreshMinutes: parseInt(e.target.value) || 5 }))}
              className="w-full px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
            <p className="text-[10px] text-ink-500 mt-0.5">Minimum 1 minute. Auto-refresh runs incremental only.</p>
          </div>
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Default Data Window (days)</label>
            <input type="number" value={settings?.days || 90} min={7} max={365}
              onChange={e => setSettings(s => ({ ...s, days: parseInt(e.target.value) || 90 }))}
              className="w-full px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings?.enabled !== false}
                onChange={e => setSettings(s => ({ ...s, enabled: e.target.checked }))}
                className="w-4 h-4 rounded border-surface-200 bg-white text-emerald-500" />
              <span className="text-sm text-ink-600">Auto-refresh enabled</span>
            </label>
          </div>
        </div>
        <button onClick={saveSettings} disabled={saving}
          className="mt-3 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-surface-200 disabled:text-ink-400 text-ink-900 text-xs rounded font-medium">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* History */}
      {history.length > 0 && <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200"><Section title="Backfill History" /></div>
        <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
          <th>Time</th><th>Mode</th><th>By</th><th>Duration</th><th className="text-right">New Segs</th><th className="text-right">Updated</th><th className="text-right">Total Segs</th><th className="text-right">QC New</th>
        </tr></thead><tbody>
          {history.map((h, i) => (
            <tr key={i}>
              <td className="text-xs font-mono whitespace-nowrap">{h.lastRunAt ? new Date(h.lastRunAt).toLocaleString('en-US', { timeZone: 'America/New_York', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '—'}</td>
              <td><span className={`text-[10px] px-1.5 py-0.5 rounded ${h.mode === 'full' ? 'bg-red-50 text-red-600' : h.mode === 'range' ? 'bg-brand-500/20 text-brand-600' : 'bg-emerald-50 text-emerald-600'}`}>{h.mode || '—'}</span></td>
              <td className="text-xs">{h.triggeredBy || '—'}</td>
              <td className="text-xs font-mono">{h.lastRunDurationSec}s</td>
              <td className="text-right font-mono text-xs text-emerald-600">{fmtI(h.counts?.segmentsNew)}</td>
              <td className="text-right font-mono text-xs text-amber-600">{fmtI(h.counts?.segmentsUpdated)}</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.segmentsTotal)}</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.qcNew)}</td>
            </tr>
          ))}
        </tbody></table></div>
      </div>}
    </div>
  );
}
