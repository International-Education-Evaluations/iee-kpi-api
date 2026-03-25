import React, { useEffect, useState } from 'react';
import { Card, Section, Skel, fmtI } from '../components/UI';
import { api, getUser } from '../hooks/useApi';

export default function GuardrailsPage() {
  const [guardrails, setGuardrails] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try {
      const [g, p] = await Promise.all([api('/ai/guardrails'), api('/ai/system-prompt')]);
      setGuardrails(g.guardrails); setPrompt(p.prompt || '');
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  const upd = (k, v) => setGuardrails(prev => ({ ...prev, [k]: v }));

  const saveGuardrails = async () => {
    setSaving(true); setMsg('');
    try {
      await api('/ai/guardrails', { method: 'PUT', body: JSON.stringify(guardrails) });
      setMsg('Guardrails saved!'); setTimeout(() => setMsg(''), 3000);
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  const savePrompt = async () => {
    setSavingPrompt(true);
    try {
      await api('/ai/system-prompt', { method: 'PUT', body: JSON.stringify({ content: prompt }) });
      setMsg('System prompt saved!'); setTimeout(() => setMsg(''), 3000);
    } catch (e) { alert('Failed: ' + e.message); }
    setSavingPrompt(false);
  };

  if (loading || !guardrails) return <Skel rows={8} cols={3} />;

  const ALL_TOOLS = [
    { id: 'fetch_kpi_summary', label: 'KPI Summary', desc: 'Aggregate KPI segments by status/worker' },
    { id: 'fetch_queue_snapshot', label: 'Queue Snapshot', desc: 'Live queue counts + aging' },
    { id: 'fetch_queue_wait_summary', label: 'Queue Wait Summary', desc: 'Historical wait time stats' },
    { id: 'fetch_qc_summary', label: 'QC Summary', desc: 'Error counts by dept/issue/user' },
    { id: 'fetch_user_list', label: 'User List', desc: 'Staff roster lookup' },
    { id: 'fetch_worker_pattern', label: 'Worker Pattern', desc: '"What did X do last week?"' },
    { id: 'fetch_anomaly_scan', label: 'Anomaly Scan', desc: 'Detect data inconsistencies' },
  ];

  const toggleTool = (id) => {
    const current = guardrails.allowedTools || [];
    upd('allowedTools', current.includes(id) ? current.filter(t => t !== id) : [...current, id]);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-white">AI Configuration</h1>
          <p className="text-xs text-slate-400 mt-0.5">Control chatbot behavior, guardrails, and system prompt</p></div>
        {msg && <span className="text-emerald-400 text-xs bg-emerald-600/10 border border-emerald-500/20 px-3 py-1 rounded">{msg}</span>}
      </div>

      {/* Guardrails */}
      <div className="glass rounded-xl p-5">
        <Section title="Guardrails" sub="Safety limits applied to every AI query" />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mt-4">
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Max Days (query window)</label>
            <input type="number" value={guardrails.maxDays || 90} onChange={e => upd('maxDays', parseInt(e.target.value) || 90)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
            <p className="text-[10px] text-slate-500 mt-0.5">Hard cap: 365</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Max Page Size</label>
            <input type="number" value={guardrails.maxPageSize || 2000} onChange={e => upd('maxPageSize', parseInt(e.target.value) || 2000)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
            <p className="text-[10px] text-slate-500 mt-0.5">Hard cap: 5000</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Max Tool Iterations</label>
            <input type="number" value={guardrails.maxToolIterations || 5} onChange={e => upd('maxToolIterations', parseInt(e.target.value) || 5)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
            <p className="text-[10px] text-slate-500 mt-0.5">Hard cap: 10</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Max Tokens (response length)</label>
            <input type="number" value={guardrails.maxTokens || 4096} onChange={e => upd('maxTokens', parseInt(e.target.value) || 4096)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
            <p className="text-[10px] text-slate-500 mt-0.5">Hard cap: 8192</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Claude Model</label>
            <select value={guardrails.model || 'claude-sonnet-4-20250514'} onChange={e => upd('model', e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white">
              <option value="claude-sonnet-4-20250514">Sonnet 4 (recommended)</option>
              <option value="claude-haiku-4-5-20251001">Haiku 4.5 (faster, cheaper)</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 uppercase block mb-1">Rate Limit (per min)</label>
            <input type="number" value={guardrails.rateLimitPerMinute || 10} onChange={e => upd('rateLimitPerMinute', parseInt(e.target.value) || 10)}
              className="w-full px-3 py-1.5 bg-slate-800/60 border border-slate-600/40 rounded text-sm text-white" />
          </div>
          <div className="flex items-center gap-3 col-span-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={guardrails.summaryOnly !== false} onChange={e => upd('summaryOnly', e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-navy-500" />
              <span className="text-sm text-slate-300">Summary only (no raw rows)</span>
            </label>
          </div>
        </div>

        <div className="mt-4">
          <label className="text-[10px] text-slate-400 uppercase block mb-2">Allowed Tools</label>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {ALL_TOOLS.map(t => (
              <label key={t.id} className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                (guardrails.allowedTools || []).includes(t.id) ? 'border-emerald-500/30 bg-emerald-600/5' : 'border-slate-700/40 bg-slate-800/20 opacity-50'
              }`}>
                <input type="checkbox" checked={(guardrails.allowedTools || []).includes(t.id)} onChange={() => toggleTool(t.id)}
                  className="w-4 h-4 mt-0.5 rounded border-slate-600 bg-slate-800 text-emerald-500 shrink-0" />
                <div>
                  <div className="text-xs font-medium text-white">{t.label}</div>
                  <div className="text-[10px] text-slate-400">{t.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <button onClick={saveGuardrails} disabled={saving}
          className="mt-4 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-sm rounded-lg font-medium">
          {saving ? 'Saving...' : 'Save Guardrails'}
        </button>
      </div>

      {/* System Prompt */}
      <div className="glass rounded-xl p-5">
        <Section title="System Prompt" sub="Instructions that define how the AI chatbot behaves. Glossary terms are appended automatically." />
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={14}
          className="w-full mt-3 px-4 py-3 bg-slate-800/50 border border-slate-600/40 rounded-lg text-sm text-white font-mono resize-y focus:outline-none focus:border-navy-400 leading-relaxed" />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={savePrompt} disabled={savingPrompt}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-sm rounded-lg font-medium">
            {savingPrompt ? 'Saving...' : 'Save Prompt'}
          </button>
          <span className="text-[10px] text-slate-500">Changes affect all users immediately. All edits are logged in the audit trail.</span>
        </div>
      </div>
    </div>
  );
}
