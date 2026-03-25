import React, { useEffect, useState } from 'react';
import { Section, Skel, Table, fmtI } from '../components/UI';
import { api, getUser, isManagerPlus } from '../hooks/useApi';

export default function EmailPage() {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', recipients: '', frequency: 'daily', reportType: 'daily_ops_summary' });
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  useEffect(() => { load(); }, []);
  async function load() { setLoading(true); try { const d = await api('/email/schedules'); setSchedules(d.schedules || []); } catch {} setLoading(false); }

  const create = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      await api('/email/schedules', { method: 'POST', body: JSON.stringify({
        ...form, recipients: form.recipients.split(',').map(e => e.trim()).filter(Boolean)
      })});
      setShowCreate(false); setForm({ name: '', recipients: '', frequency: 'daily', reportType: 'daily_ops_summary' });
      await load();
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  const toggle = async (s) => {
    try { await api(`/email/schedules/${s._id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) }); await load(); }
    catch (e) { alert('Failed: ' + e.message); }
  };

  const remove = async (s) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    try { await api(`/email/schedules/${s._id}`, { method: 'DELETE' }); await load(); }
    catch (e) { alert('Failed: ' + e.message); }
  };

  const sendNow = async (s) => {
    setSending(s._id); setLastResult(null);
    try {
      const d = await api('/email/send-now', { method: 'POST', body: JSON.stringify({
        scheduleId: s._id, recipients: s.recipients, templateId: s.templateId
      })});
      setLastResult(d.templateData);
      await load();
    } catch (e) { alert('Send failed: ' + e.message); }
    setSending(null);
  };

  if (loading) return <Skel rows={5} cols={4} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">Email Reports</h1>
          <p className="text-xs text-ink-400 mt-0.5">{schedules.length} configured · SendGrid dynamic templates</p></div>
        {isManagerPlus() && <button onClick={() => setShowCreate(!showCreate)} className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-ink-900 text-sm rounded-lg font-medium">+ New Schedule</button>}
      </div>

      {lastResult && <div className="card-surface p-4 border-emerald-200 bg-emerald-600/5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-emerald-600">Email sent successfully</span>
          <button onClick={() => setLastResult(null)} className="text-[10px] text-ink-400 hover:text-ink-900">Dismiss</button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div><span className="text-ink-400">Date:</span> <span className="text-ink-900">{lastResult.report_date}</span></div>
          <div><span className="text-ink-400">Active:</span> <span className="text-ink-900">{fmtI(lastResult.total_active_orders)}</span></div>
          <div><span className="text-ink-400">Waiting:</span> <span className="text-ink-900">{fmtI(lastResult.waiting_orders)}</span></div>
          <div><span className="text-ink-400">&gt;72h:</span> <span className="text-red-600 font-medium">{fmtI(lastResult.orders_over_72h)}</span></div>
        </div>
      </div>}

      {showCreate && <div className="card-surface p-5">
        <Section title="Create Email Schedule" />
        <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div><label className="text-[10px] text-ink-400 uppercase">Schedule Name</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} required placeholder="Daily Ops Report"
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Recipients (comma-separated)</label>
            <input type="text" value={form.recipients} onChange={e => setForm(f => ({...f, recipients: e.target.value}))} required placeholder="ops@myiee.org, lead@myiee.org"
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Frequency</label>
            <select value={form.frequency} onChange={e => setForm(f => ({...f, frequency: e.target.value}))}
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              <option value="daily">Daily</option><option value="weekly">Weekly (Monday)</option><option value="monthly">Monthly (1st)</option>
            </select></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Report Type</label>
            <select value={form.reportType} onChange={e => setForm(f => ({...f, reportType: e.target.value}))}
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              <option value="daily_ops_summary">Daily Ops Summary</option><option value="weekly_kpi">Weekly KPI Report</option><option value="qc_digest">QC Digest</option>
            </select></div>
          <div className="col-span-full flex gap-2">
            <button type="submit" disabled={saving} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-ink-900 text-xs rounded font-medium">{saving ? 'Creating...' : 'Create'}</button>
            <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-1.5 bg-slate-700 text-ink-900 text-xs rounded">Cancel</button>
          </div>
        </form>
      </div>}

      <div className="card-surface overflow-hidden">
        <table className="tbl w-full">
          <thead><tr><th>Name</th><th>Recipients</th><th>Frequency</th><th>Type</th><th>Status</th><th>Last Sent</th><th></th></tr></thead>
          <tbody>{schedules.map(s => (
            <tr key={s._id}>
              <td className="font-medium text-ink-900">{s.name}</td>
              <td className="text-xs text-ink-400 max-w-[200px] truncate">{(s.recipients || []).join(', ')}</td>
              <td className="text-xs">{s.frequency}</td>
              <td className="text-xs text-ink-400">{s.reportType}</td>
              <td>{s.enabled ? <span className="text-emerald-600 text-xs">Active</span> : <span className="text-ink-500 text-xs">Paused</span>}</td>
              <td className="text-xs text-ink-500">{s.lastSentAt ? new Date(s.lastSentAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'Never'}</td>
              <td className="text-right">
                <div className="flex gap-1 justify-end">
                  <button onClick={() => sendNow(s)} disabled={sending === s._id}
                    className="text-[10px] text-brand-600 hover:text-ink-900 px-2 py-0.5 border border-surface-200 rounded">
                    {sending === s._id ? 'Sending...' : 'Send Now'}
                  </button>
                  <button onClick={() => toggle(s)} className={`text-[10px] px-2 py-0.5 border rounded ${s.enabled ? 'text-amber-600 border-amber-500/20' : 'text-emerald-600 border-emerald-200'}`}>
                    {s.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button onClick={() => remove(s)} className="text-[10px] text-red-600 border border-red-200 rounded px-2 py-0.5">Delete</button>
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!schedules.length && <div className="p-8 text-center text-ink-500 text-sm">No email schedules configured. Click + New Schedule to set up automated reports.</div>}
      </div>

      <div className="card-surface p-4">
        <Section title="SendGrid Template Variables" sub="Use these in your dynamic template design" />
        <div className="mt-3 overflow-x-auto">
          <table className="tbl w-full"><thead><tr><th>Variable</th><th>Type</th><th>Description</th></tr></thead>
            <tbody>
              {[
                ['report_date', 'string', 'Formatted date (e.g. "Monday, March 25, 2026")'],
                ['total_active_orders', 'number', 'Total orders in non-terminal statuses'],
                ['waiting_orders', 'number', 'Orders in waiting/holding statuses'],
                ['orders_over_24h', 'number', 'Waiting orders older than 24 hours'],
                ['orders_over_72h', 'number', 'Waiting orders older than 72 hours (critical)'],
                ['top_queues', 'array', 'Top 5 queues: [{status, count, median_hrs}]'],
                ['qc_events_today', 'number', 'QC events in last 24 hours'],
                ['qc_fixed', 'number', 'Fixed-it QC events'],
                ['qc_kickback', 'number', 'Kick-it-back QC events'],
                ['kpi_segments_today', 'number', 'Processing segments in last 24 hours'],
                ['dashboard_url', 'string', 'Link back to the dashboard'],
              ].map(([v, t, d], i) => (
                <tr key={i}><td className="font-mono text-xs text-emerald-600">{'{{' + v + '}}'}</td><td className="text-xs text-ink-400">{t}</td><td className="text-xs">{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
