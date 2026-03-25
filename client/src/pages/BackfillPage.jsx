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

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  async function load() {
    try {
      const [s, st, h] = await Promise.all([
        api('/backfill/status'),
        api('/backfill/settings'),
        api('/backfill/history').catch(() => ({ history: [] }))
      ]);
      setStatus(s); setSettings(st); setHistory(h.history || []);
      setRunning(s.isRunning);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  const triggerBackfill = async () => {
    setRunning(true);
    try { await api('/backfill/run', { method: 'POST', body: JSON.stringify({ days: settings?.days || 90 }) }); }
    catch (e) { alert('Failed: ' + e.message); setRunning(false); }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await api('/backfill/settings', { method: 'PUT', body: JSON.stringify(settings) });
      await load();
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  if (loading) return <Skel rows={6} cols={3} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-white">Data Backfill</h1>
          <p className="text-xs text-slate-400 mt-0.5">Sync production data into the dashboard for fast reads</p></div>
        <button onClick={triggerBackfill} disabled={running}
          className={`px-5 py-2 text-white text-sm rounded-lg font-medium ${running ? 'bg-amber-600 animate-pulse' : 'bg-navy-600 hover:bg-navy-500'}`}>
          {running ? 'Backfill Running...' : 'Run Backfill Now'}
        </button>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
        <Card label="Segments" value={fmtI(status?.currentCounts?.segments)} color="navy" />
        <Card label="QC Events" value={fmtI(status?.currentCounts?.qcEvents)} color="green" />
        <Card label="Users" value={fmtI(status?.currentCounts?.users)} color="plum" />
        <Card label="Last Run" value={status?.lastRunDurationSec ? status.lastRunDurationSec + 's' : '—'} color="slate" />
        <Card label="Orders" value={fmtI(status?.counts?.orders)} color="amber" />
        <Card label="Status" value={running ? 'Running' : 'Idle'} color={running ? 'amber' : 'green'} />
      </div>

      {/* Last Run Info */}
      {status?.lastRunAt && <div className="glass rounded-xl p-4">
        <Section title="Last Backfill" sub={`${new Date(status.lastRunAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} · Triggered by ${status.triggeredBy || 'system'}`} />
        {status.log && <div className="mt-3 bg-slate-800/50 rounded-lg p-3 max-h-48 overflow-y-auto">
          {status.log.map((line, i) => <div key={i} className="text-[11px] font-mono text-slate-400 leading-relaxed">{line}</div>)}
        </div>}
        {status.lastError && <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{status.lastError}</div>}
      </div>}

      {/* Settings */}
      <div className="glass rounded-xl p-5">
        <Section title="Auto-Refresh Settings" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Refresh Interval (minutes)</label>
            <input type="number" value={settings?.autoRefreshMinutes || 5} min={2} max={60}
              onChange={e => setSettings(s => ({ ...s, autoRefreshMinutes: parseInt(e.target.value) || 5 }))}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
            <p className="text-[10px] text-slate-500 mt-0.5">Minimum 2 minutes</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Data Window (days)</label>
            <input type="number" value={settings?.days || 90} min={7} max={365}
              onChange={e => setSettings(s => ({ ...s, days: parseInt(e.target.value) || 90 }))}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings?.enabled !== false}
                onChange={e => setSettings(s => ({ ...s, enabled: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-emerald-500" />
              <span className="text-sm text-slate-300">Auto-refresh enabled</span>
            </label>
          </div>
        </div>
        <button onClick={saveSettings} disabled={saving}
          className="mt-3 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-xs rounded font-medium">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* History */}
      {history.length > 0 && <div className="glass rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/40"><Section title="Backfill History" sub="Last 20 runs" /></div>
        <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr>
          <th>Time</th><th>By</th><th>Duration</th><th className="text-right">Segments</th><th className="text-right">QC</th><th className="text-right">Users</th><th className="text-right">Orders</th>
        </tr></thead><tbody>
          {history.map((h, i) => (
            <tr key={i}>
              <td className="text-xs font-mono whitespace-nowrap">{h.lastRunAt ? new Date(h.lastRunAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '—'}</td>
              <td className="text-xs">{h.triggeredBy || '—'}</td>
              <td className="text-xs font-mono">{h.lastRunDurationSec}s</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.segments)}</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.qcEvents)}</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.users)}</td>
              <td className="text-right font-mono text-xs">{fmtI(h.counts?.orders)}</td>
            </tr>
          ))}
        </tbody></table></div>
      </div>}
    </div>
  );
}
