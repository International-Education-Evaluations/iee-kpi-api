import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Section, Skel, FilterBar, FilterSelect, FilterInput, FilterReset, fmtI, fmt } from '../components/UI';
import { api } from '../hooks/useApi';

const TT = { contentStyle: { background: '#1e293b', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 12 } };
const PIE_COLORS = ['#00aeef', '#16a34a', '#F57F17', '#E65100', '#7B1FA2', '#00838F', '#C62828', '#4527A0', '#AD1457', '#1565C0'];

const METRICS = [
  { value: 'count', label: 'Count' },
  { value: 'avgDuration', label: 'Avg Duration (min)' },
  { value: 'totalHours', label: 'Total Hours' },
  { value: 'totalMinutes', label: 'Total Minutes' },
  { value: 'maxDuration', label: 'Max Duration (min)' },
  { value: 'minDuration', label: 'Min Duration (min)' },
  { value: 'uniqueOrders', label: 'Unique Orders' },
];

const GROUP_BY_KPI = [
  { value: 'worker', label: 'Worker Name' },
  { value: 'workerEmail', label: 'Worker Email' },
  { value: 'status', label: 'Status (slug)' },
  { value: 'statusName', label: 'Status Name' },
  { value: 'orderType', label: 'Order Type' },
  { value: 'date', label: 'Date' },
];

const GROUP_BY_QC = [
  { value: 'department', label: 'Department' },
  { value: 'errorType', label: 'Error Type' },
  { value: 'worker', label: 'Assigned To' },
  { value: 'issueName', label: 'Issue' },
  { value: 'date', label: 'Date' },
];

const CHARTS = [
  { value: 'bar', label: 'Bar Chart' },
  { value: 'horizontalBar', label: 'Horizontal Bar' },
  { value: 'line', label: 'Line Chart' },
  { value: 'pie', label: 'Pie Chart' },
  { value: 'table', label: 'Table Only' },
];

export default function ReportBuilder() {
  const [filterOpts, setFilterOpts] = useState(null);
  const [config, setConfig] = useState({
    source: 'kpi', metric: 'count', groupBy: 'worker', chartType: 'bar', dateGrouping: 'day',
    filters: { dateFrom: '', dateTo: '', workers: [], statuses: [], orderTypes: [], departments: [], errorTypes: [], excludeOpen: true }
  });
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savedReports, setSavedReports] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => { loadFilters(); loadSaved(); }, []);
  async function loadFilters() { try { const d = await api('/reports/filters'); setFilterOpts(d); } catch {} }
  async function loadSaved() { try { const d = await api('/reports/saved'); setSavedReports(d.reports || []); } catch {} }

  const upd = (k, v) => setConfig(prev => ({ ...prev, [k]: v }));
  const updF = (k, v) => setConfig(prev => ({ ...prev, filters: { ...prev.filters, [k]: v } }));

  const runReport = async () => {
    setLoading(true);
    try {
      const d = await api('/reports/query', { method: 'POST', body: JSON.stringify(config) });
      setResults(d);
    } catch (e) { alert('Report failed: ' + e.message); }
    setLoading(false);
  };

  const saveReport = async () => {
    if (!saveName) return;
    try {
      await api('/reports/saved', { method: 'POST', body: JSON.stringify({ name: saveName, config }) });
      setSaveName(''); loadSaved();
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  const loadReport = (r) => { setConfig(r.config); };
  const deleteReport = async (id) => {
    if (!confirm('Delete this saved report?')) return;
    try { await api(`/reports/saved/${id}`, { method: 'DELETE' }); loadSaved(); } catch {}
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const token = sessionStorage.getItem('iee_t');
      const resp = await fetch('/reports/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ source: config.source, filters: config.filters })
      });
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `iee-${config.source}-export.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e.message); }
    setExporting(false);
  };

  const groupByOpts = config.source === 'qc' ? GROUP_BY_QC : GROUP_BY_KPI;
  const data = results?.results || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">Report Builder</h1>
          <p className="text-xs text-ink-400 mt-0.5">Create custom reports from KPI and QC data</p></div>
        <div className="flex gap-2">
          <button onClick={exportCsv} disabled={exporting} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-ink-900 text-xs rounded-lg font-medium">
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
          <button onClick={runReport} disabled={loading} className="px-4 py-1.5 bg-brand-500 hover:bg-brand-600 text-ink-900 text-xs rounded-lg font-medium">
            {loading ? 'Running...' : 'Run Report'}
          </button>
        </div>
      </div>

      {/* Config Panel */}
      <div className="card-surface p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Data Source</label>
            <select value={config.source} onChange={e => { upd('source', e.target.value); upd('groupBy', e.target.value === 'qc' ? 'department' : 'worker'); }}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              <option value="kpi">KPI Segments</option><option value="qc">QC Events</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Metric</label>
            <select value={config.metric} onChange={e => upd('metric', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              {METRICS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Group By</label>
            <select value={config.groupBy} onChange={e => upd('groupBy', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              {groupByOpts.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </div>
          {config.groupBy === 'date' && <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Date Grouping</label>
            <select value={config.dateGrouping} onChange={e => upd('dateGrouping', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </select>
          </div>}
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">Chart Type</label>
            <select value={config.chartType} onChange={e => upd('chartType', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900">
              {CHARTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.filters.excludeOpen} onChange={e => updF('excludeOpen', e.target.checked)}
                className="w-3.5 h-3.5 rounded border-surface-200 bg-white text-emerald-500" />
              <span className="text-[11px] text-ink-600">Exclude open</span>
            </label>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 pt-3 border-t border-surface-200">
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">From</label>
            <input type="date" value={config.filters.dateFrom} onChange={e => updF('dateFrom', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
          </div>
          <div>
            <label className="text-[10px] text-ink-400 uppercase block mb-1">To</label>
            <input type="date" value={config.filters.dateTo} onChange={e => updF('dateTo', e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
          </div>
          {config.source === 'kpi' && filterOpts && <>
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">Workers</label>
              <select multiple value={config.filters.workers} onChange={e => updF('workers', [...e.target.selectedOptions].map(o => o.value))}
                className="w-full px-2 py-1 bg-white border border-surface-200 rounded text-[11px] text-ink-900 h-16">
                {filterOpts.workers.map(w => <option key={w.email} value={w.email}>{w.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">Statuses</label>
              <select multiple value={config.filters.statuses} onChange={e => updF('statuses', [...e.target.selectedOptions].map(o => o.value))}
                className="w-full px-2 py-1 bg-white border border-surface-200 rounded text-[11px] text-ink-900 h-16">
                {filterOpts.statuses.map(s => <option key={s.slug} value={s.slug}>{s.name}</option>)}
              </select>
            </div>
          </>}
          {config.source === 'qc' && filterOpts && <>
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">Departments</label>
              <select multiple value={config.filters.departments} onChange={e => updF('departments', [...e.target.selectedOptions].map(o => o.value))}
                className="w-full px-2 py-1 bg-white border border-surface-200 rounded text-[11px] text-ink-900 h-16">
                {filterOpts.departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-ink-400 uppercase block mb-1">Error Type</label>
              <select multiple value={config.filters.errorTypes} onChange={e => updF('errorTypes', [...e.target.selectedOptions].map(o => o.value))}
                className="w-full px-2 py-1 bg-white border border-surface-200 rounded text-[11px] text-ink-900 h-16">
                {filterOpts.errorTypes.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </>}
        </div>
      </div>

      {/* Save / Load */}
      <div className="flex items-center gap-2 flex-wrap">
        <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Report name..."
          className="px-2.5 py-1 bg-white border border-surface-200 rounded text-xs text-ink-900 w-48" />
        <button onClick={saveReport} disabled={!saveName} className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-surface-200 disabled:text-ink-400 text-ink-900 text-[11px] rounded font-medium">Save</button>
        {savedReports.map(r => (
          <div key={r._id} className="flex items-center gap-1 px-2 py-0.5 bg-surface-50 border border-surface-200 rounded group">
            <button onClick={() => loadReport(r)} className="text-[11px] text-brand-600 hover:text-ink-900">{r.name}</button>
            <button onClick={() => deleteReport(r._id)} className="text-[10px] text-red-600 opacity-0 group-hover:opacity-100">×</button>
          </div>
        ))}
      </div>

      {/* Results */}
      {results && <div className="card-surface p-4">
        <div className="flex items-center justify-between mb-3">
          <Section title="Results" sub={`${fmtI(results.totalMatched)} records matched · ${results.resultCount} groups`} />
        </div>

        {/* Chart */}
        {config.chartType !== 'table' && data.length > 0 && <div className="mb-4">
          <ResponsiveContainer width="100%" height={320}>
            {config.chartType === 'pie' ? (
              <PieChart>
                <Pie data={data.slice(0, 12)} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={120} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {data.slice(0, 12).map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip {...TT} />
              </PieChart>
            ) : config.chartType === 'horizontalBar' ? (
              <BarChart data={data.slice(0, 20)} layout="vertical" margin={{ left: 10, right: 15 }}>
                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <YAxis type="category" dataKey="label" width={150} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip {...TT} /><Bar dataKey="value" fill="#00aeef" radius={[0, 4, 4, 0]} />
              </BarChart>
            ) : config.chartType === 'line' ? (
              <LineChart data={data} margin={{ left: 0, right: 15 }}>
                <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 9 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip {...TT} /><Line type="monotone" dataKey="value" stroke="#00aeef" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            ) : (
              <BarChart data={data.slice(0, 30)} margin={{ left: 0, right: 15 }}>
                <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 9 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip {...TT} /><Bar dataKey="value" fill="#00aeef" radius={[3, 3, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>}

        {/* Data Table */}
        <div className="overflow-x-auto">
          <table className="tbl w-full"><thead><tr>
            <th className="text-left">Group</th>
            <th className="text-right">{METRICS.find(m => m.value === config.metric)?.label || 'Value'}</th>
            <th className="text-right">Records</th>
          </tr></thead>
          <tbody>{data.map((r, i) => (
            <tr key={i}>
              <td className="text-sm font-medium text-ink-900">{r.label}</td>
              <td className="text-sm text-right font-mono">{fmt(r.value)}</td>
              <td className="text-xs text-right text-ink-400">{fmtI(r.count)}</td>
            </tr>
          ))}</tbody></table>
        </div>
      </div>}

      {!results && !loading && <div className="card-surface p-12 text-center text-ink-500">
        Configure your report above and click "Run Report" to see results.
      </div>}
    </div>
  );
}
