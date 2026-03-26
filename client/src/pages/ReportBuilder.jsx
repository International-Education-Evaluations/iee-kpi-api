import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';
import { api } from '../hooks/useApi';
import { TOOLTIP_STYLE, fmtI, fmt, fmtDur, fmtHrs, OrderLink } from '../components/UI';

// ── Constants ────────────────────────────────────────────────
const COLORS = ['#00aeef','#16a34a','#d97706','#7c3aed','#ea580c','#0891b2','#dc2626','#65a30d','#9333ea','#0284c7','#b45309','#15803d'];


const KPI_METRICS = [
  { value:'count',        label:'Segment Count',       unit:'segs',  fmt:v=>fmtI(v) },
  { value:'avgDuration',  label:'Avg Duration',         unit:'min',   fmt:v=>fmtDur(v) },
  { value:'medianDuration',label:'Median Duration',     unit:'min',   fmt:v=>fmtDur(v) },
  { value:'totalHours',   label:'Total Hours',          unit:'hrs',   fmt:v=>fmtHrs(v) },
  { value:'totalMinutes', label:'Total Minutes',        unit:'min',   fmt:v=>fmt(v) },
  { value:'maxDuration',  label:'Max Duration',         unit:'min',   fmt:v=>fmtDur(v) },
  { value:'minDuration',  label:'Min Duration',         unit:'min',   fmt:v=>fmtDur(v) },
  { value:'xph',          label:'XpH (segs/hour)',      unit:'xph',   fmt:v=>fmt(v) },
  { value:'uniqueOrders', label:'Unique Orders',        unit:'orders',fmt:v=>fmtI(v) },
  { value:'openRate',     label:'Open Rate %',          unit:'%',     fmt:v=>`${fmt(v)}%` },
  { value:'inRangeCount', label:'In-Range Count',       unit:'segs',  fmt:v=>fmtI(v) },
];

const QC_METRICS = [
  { value:'count',      label:'Event Count',   unit:'events', fmt:v=>fmtI(v) },
  { value:'fixedIt',    label:'Fixed It',      unit:'events', fmt:v=>fmtI(v) },
  { value:'kickBack',   label:'Kick It Back',  unit:'events', fmt:v=>fmtI(v) },
  { value:'fixRate',    label:'Fix Rate %',    unit:'%',      fmt:v=>`${fmt(v)}%` },
  { value:'kbRate',     label:'KB Rate %',     unit:'%',      fmt:v=>`${fmt(v)}%` },
  { value:'uniqueOrders',label:'Unique Orders',unit:'orders', fmt:v=>fmtI(v) },
];

const KPI_GROUP_BY = [
  { value:'worker',      label:'Worker Name' },
  { value:'workerEmail', label:'Worker Email' },
  { value:'department',  label:'Department' },
  { value:'statusName',  label:'Status Name' },
  { value:'statusSlug',  label:'Status Slug' },
  { value:'orderType',   label:'Order Type' },
  { value:'date',        label:'Date' },
  { value:'week',        label:'Week' },
  { value:'month',       label:'Month' },
  { value:'orderSource', label:'Order Source' },
];

const QC_GROUP_BY = [
  { value:'department',  label:'Department' },
  { value:'worker',      label:'Accountable User' },
  { value:'issueName',   label:'Issue Type' },
  { value:'errorType',   label:'Error Type' },
  { value:'orderType',   label:'Order Type' },
  { value:'date',        label:'Date' },
  { value:'week',        label:'Week' },
  { value:'month',       label:'Month' },
];

const CHART_TYPES = [
  { value:'bar',        label:'Bar',          icon:'▊' },
  { value:'hbar',       label:'Horiz. Bar',   icon:'▬' },
  { value:'line',       label:'Line',         icon:'↗' },
  { value:'area',       label:'Area',         icon:'◣' },
  { value:'pie',        label:'Pie',          icon:'◉' },
  { value:'table',      label:'Table',        icon:'≡' },
];

const SORT_OPTIONS = [
  { value:'value_desc', label:'Value ↓' },
  { value:'value_asc',  label:'Value ↑' },
  { value:'label_asc',  label:'Label A–Z' },
  { value:'label_desc', label:'Label Z–A' },
  { value:'count_desc', label:'Count ↓' },
];

const LIMIT_OPTIONS = [10, 20, 50, 100, 200, 500];

const DEFAULT_CONFIG = {
  source: 'kpi',
  metric: 'count',
  groupBy: 'worker',
  secondaryMetric: '',   // optional second series
  chartType: 'bar',
  sortBy: 'value_desc',
  limit: 20,
  filters: {
    dateFrom: '', dateTo: '',
    workers: [], statuses: [], orderTypes: [], departments: [],
    errorTypes: [], issues: [],
    excludeOpen: true,
    orderType: '',
  }
};

// ── Helpers ──────────────────────────────────────────────────
function fmtMetricValue(metricKey, v, source) {
  const list = source === 'qc' ? QC_METRICS : KPI_METRICS;
  const m = list.find(x => x.value === metricKey);
  return m ? m.fmt(v) : fmt(v);
}

function getMetricLabel(metricKey, source) {
  const list = source === 'qc' ? QC_METRICS : KPI_METRICS;
  return list.find(x => x.value === metricKey)?.label || metricKey;
}

// ── Multi-select pill component ──────────────────────────────
function MultiSelect({ label, options, value, onChange, valueKey='value', labelKey='label', placeholder='All' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (v) => {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  };

  const selectedLabels = value.map(v => options.find(o => o[valueKey]===v)?.[labelKey] || v);

  return (
    <div ref={ref} className="relative">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">{label}</label>
      <button onClick={() => setOpen(o => !o)} type="button"
        className={`w-full px-2.5 py-1.5 bg-white border rounded-lg text-xs text-left flex items-center justify-between gap-1 ${open?'border-brand-400 ring-2 ring-brand-100':'border-surface-200'}`}>
        <span className="truncate text-ink-700">
          {value.length === 0 ? <span className="text-ink-400">{placeholder}</span>
            : value.length <= 2 ? selectedLabels.join(', ')
            : `${value.length} selected`}
        </span>
        <span className="text-ink-400 shrink-0">{open?'▲':'▼'}</span>
      </button>
      {value.length > 0 && (
        <button onClick={() => onChange([])} className="absolute right-7 top-7 text-[10px] text-ink-300 hover:text-red-500 z-10">✕</button>
      )}
      {open && (
        <div className="absolute top-full left-0 z-50 w-full min-w-[180px] mt-1 bg-white border border-surface-200 rounded-lg shadow-xl max-h-52 overflow-y-auto">
          {options.length === 0 && <div className="px-3 py-2 text-xs text-ink-400">No options</div>}
          {options.map(o => {
            const v = o[valueKey]; const l = o[labelKey];
            const checked = value.includes(v);
            return (
              <label key={v} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs hover:bg-brand-50 ${checked?'bg-brand-50/60 text-brand-700':'text-ink-700'}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(v)}
                  className="w-3 h-3 rounded border-surface-300 text-brand-500 shrink-0" />
                <span className="truncate">{l}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
export default function ReportBuilder() {
  const [filterOpts, setFilterOpts]   = useState(null);
  const [config, setConfig]           = useState(DEFAULT_CONFIG);
  const [results, setResults]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [savedReports, setSavedReports] = useState([]);
  const [saveName, setSaveName]       = useState('');
  const [saveError, setSaveError]     = useState('');
  const [exporting, setExporting]     = useState(false);
  const [tab, setTab]                 = useState('chart'); // chart | table | raw

  useEffect(() => {
    api('/reports/filters').then(d => setFilterOpts(d)).catch(() => {});
    api('/reports/saved').then(d => setSavedReports(d.reports || [])).catch(() => {});
  }, []);

  const upd = useCallback((k, v) => setConfig(p => ({ ...p, [k]: v })), []);
  const updF = useCallback((k, v) => setConfig(p => ({ ...p, filters: { ...p.filters, [k]: v } })), []);

  const sourceMetrics  = config.source === 'qc' ? QC_METRICS  : KPI_METRICS;
  const sourceGroupBys = config.source === 'qc' ? QC_GROUP_BY : KPI_GROUP_BY;

  const runReport = async () => {
    setLoading(true); setResults(null);
    try {
      const d = await api('/reports/query', { method: 'POST', body: JSON.stringify(config) });
      setResults(d);
      setTab('chart');
    } catch (e) { alert('Report failed: ' + e.message); }
    setLoading(false);
  };

  const saveReport = async () => {
    if (!saveName.trim()) { setSaveError('Enter a name'); return; }
    setSaveError('');
    try {
      await api('/reports/saved', { method: 'POST', body: JSON.stringify({ name: saveName.trim(), config }) });
      setSaveName('');
      const d = await api('/reports/saved');
      setSavedReports(d.reports || []);
    } catch (e) { setSaveError(e.message); }
  };

  const loadReport = (r) => {
    setConfig(r.config);
    setResults(null);
  };

  const deleteReport = async (id) => {
    if (!confirm('Delete this saved report?')) return;
    try {
      await api(`/reports/saved/${id}`, { method: 'DELETE' });
      setSavedReports(p => p.filter(r => r._id !== id));
    } catch {}
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const token = localStorage.getItem('iee_t') || sessionStorage.getItem('iee_t');
      const resp = await fetch('/reports/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(config)
      });
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `iee-report-${config.source}-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e.message); }
    setExporting(false);
  };

  // Sort + limit the result data
  const chartData = useMemo(() => {
    if (!results?.results) return [];
    let d = [...results.results];
    switch (config.sortBy) {
      case 'value_asc':  d.sort((a,b) => a.value - b.value); break;
      case 'value_desc': d.sort((a,b) => b.value - a.value); break;
      case 'label_asc':  d.sort((a,b) => String(a.label).localeCompare(String(b.label))); break;
      case 'label_desc': d.sort((a,b) => String(b.label).localeCompare(String(a.label))); break;
      case 'count_desc': d.sort((a,b) => b.count - a.count); break;
    }
    return d.slice(0, config.limit);
  }, [results, config.sortBy, config.limit]);

  // Summary stats
  const stats = useMemo(() => {
    if (!chartData.length) return null;
    const vals = chartData.map(d => d.value).filter(v => typeof v === 'number');
    if (!vals.length) return null;
    const sum = vals.reduce((a,b)=>a+b,0);
    const avg = sum / vals.length;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const sorted = [...vals].sort((a,b)=>a-b);
    const median = sorted.length%2 ? sorted[Math.floor(sorted.length/2)] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
    return { sum, avg, max, min, median, n: vals.length };
  }, [chartData]);

  const metricDef = sourceMetrics.find(m => m.value === config.metric) || sourceMetrics[0];
  const hasSecondary = !!config.secondaryMetric && results?.results?.[0]?.secondary != null;

  const isDateGroupBy = ['date','week','month'].includes(config.groupBy);
  const avgLine = stats ? Math.round(stats.avg * 100) / 100 : null;

  const renderChart = () => {
    if (!chartData.length) return <div className="h-64 flex items-center justify-center text-ink-400 text-sm">No data to display</div>;

    const tickStyle = { fill:'#94a3b8', fontSize:10 };
    const formatVal = v => metricDef.fmt(v);

    switch (config.chartType) {
      case 'pie':
        return (
          <ResponsiveContainer width="100%" height={360}>
            <PieChart>
              <Pie data={chartData} dataKey="value" nameKey="label" cx="50%" cy="50%"
                outerRadius="70%" innerRadius="30%" paddingAngle={2}
                label={({ name, percent }) => percent > 0.03 ? `${String(name).substring(0,16)} ${(percent*100).toFixed(0)}%` : ''}
                labelLine={false} style={{ fontSize:10 }}>
                {chartData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [formatVal(v), metricDef.label]} />
              <Legend wrapperStyle={{ fontSize:11, paddingTop:8 }} />
            </PieChart>
          </ResponsiveContainer>
        );

      case 'hbar':
        return (
          <ResponsiveContainer width="100%" height={Math.max(300, chartData.length * 32 + 40)}>
            <BarChart data={chartData} layout="vertical" margin={{ left:8, right:24, top:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
              <XAxis type="number" tick={tickStyle} tickFormatter={formatVal} />
              <YAxis type="category" dataKey="label" width={160} tick={{ ...tickStyle, fontSize:11 }} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => [formatVal(v), n==='value'?metricDef.label:n]} />
              {avgLine && <ReferenceLine x={avgLine} stroke="#d97706" strokeDasharray="4 2" label={{ value:`avg`, fill:'#d97706', fontSize:9 }} />}
              <Bar dataKey="value" name={metricDef.label} radius={[0,4,4,0]}>
                {chartData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Bar>
              {hasSecondary && <Bar dataKey="secondary" name={getMetricLabel(config.secondaryMetric, config.source)} fill="#7c3aed" opacity={0.7} radius={[0,4,4,0]} />}
            </BarChart>
          </ResponsiveContainer>
        );

      case 'line':
        return (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ left:0, right:16, top:4, bottom:40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" tick={tickStyle} angle={-40} textAnchor="end" height={60} interval={Math.max(0,Math.floor(chartData.length/20))} />
              <YAxis tick={tickStyle} tickFormatter={formatVal} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => [formatVal(v), n==='value'?metricDef.label:n]} />
              {avgLine && <ReferenceLine y={avgLine} stroke="#d97706" strokeDasharray="4 2" />}
              <Line type="monotone" dataKey="value" name={metricDef.label} stroke={COLORS[0]} strokeWidth={2.5} dot={{ r:3, fill:COLORS[0] }} activeDot={{ r:5 }} />
              {hasSecondary && <Line type="monotone" dataKey="secondary" name={getMetricLabel(config.secondaryMetric,config.source)} stroke={COLORS[2]} strokeWidth={2} strokeDasharray="4 2" dot={false} />}
              <Legend wrapperStyle={{ fontSize:11, paddingTop:4 }} />
            </LineChart>
          </ResponsiveContainer>
        );

      case 'area':
        return (
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={chartData} margin={{ left:0, right:16, top:4, bottom:40 }}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS[0]} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={COLORS[0]} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" tick={tickStyle} angle={-40} textAnchor="end" height={60} interval={Math.max(0,Math.floor(chartData.length/20))} />
              <YAxis tick={tickStyle} tickFormatter={formatVal} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => [formatVal(v), n==='value'?metricDef.label:n]} />
              <Area type="monotone" dataKey="value" name={metricDef.label} stroke={COLORS[0]} strokeWidth={2} fill="url(#areaGrad)" />
              <Legend wrapperStyle={{ fontSize:11 }} />
            </AreaChart>
          </ResponsiveContainer>
        );

      default: // bar
        return (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ left:0, right:16, top:4, bottom:isDateGroupBy?40:60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="label" tick={tickStyle} angle={isDateGroupBy?-40:0} textAnchor={isDateGroupBy?"end":"middle"} height={isDateGroupBy?60:40} interval={Math.max(0,Math.floor(chartData.length/25))} />
              <YAxis tick={tickStyle} tickFormatter={formatVal} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v,n) => [formatVal(v), n==='value'?metricDef.label:n]} />
              {avgLine && <ReferenceLine y={avgLine} stroke="#d97706" strokeDasharray="4 2" label={{ value:'avg', position:'insideTopRight', fill:'#d97706', fontSize:9 }} />}
              <Bar dataKey="value" name={metricDef.label} radius={[4,4,0,0]}>
                {chartData.map((_,i) => <Cell key={i} fill={isDateGroupBy?COLORS[0]:COLORS[i%COLORS.length]} />)}
              </Bar>
              {hasSecondary && <Bar dataKey="secondary" name={getMetricLabel(config.secondaryMetric,config.source)} fill="#7c3aed" opacity={0.7} radius={[4,4,0,0]} />}
              {(hasSecondary || chartData.length > 1) && <Legend wrapperStyle={{ fontSize:11, paddingTop:4 }} />}
            </BarChart>
          </ResponsiveContainer>
        );
    }
  };

  const workers = (filterOpts?.workers || []).map(w => ({ value: w.id, label: w.name || w.id }));
  const statuses = filterOpts?.statuses || [];
  const departments = filterOpts?.departments?.map(d=>({value:d,label:d})) || [];
  const errorTypes = filterOpts?.errorTypes?.map(e=>({value:e,label:e})) || [];
  const issues = filterOpts?.issues?.map(i=>({value:i,label:i})) || [];
  const orderTypeOpts = [{value:'evaluation',label:'Evaluation'},{value:'translation',label:'Translation'}];

  const hasActiveFilters = config.filters.dateFrom || config.filters.dateTo ||
    config.filters.workers.length || config.filters.statuses.length ||
    config.filters.departments.length || config.filters.errorTypes.length ||
    config.filters.issues.length || config.filters.orderType;

  const resetFilters = () => setConfig(p => ({ ...p, filters: { ...DEFAULT_CONFIG.filters } }));

  return (
    <div className="space-y-4 min-h-screen">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-display font-bold text-ink-900" data-tour="report-builder-title">Report Builder</h1>
          <p className="text-xs text-ink-400 mt-0.5">Build, visualize, and export custom reports from KPI and QC data</p>
        </div>
        <div className="flex gap-2">
          {results && (
            <button onClick={exportCsv} disabled={exporting}
              className="px-3 py-2 bg-surface-100 hover:bg-surface-200 border border-surface-200 text-ink-700 text-xs rounded-lg font-medium flex items-center gap-1.5">
              {exporting ? '⏳ Exporting…' : '⬇ Export CSV'}
            </button>
          )}
          <button onClick={runReport} disabled={loading}
            className="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg font-semibold flex items-center gap-1.5">
            {loading ? <><span className="animate-spin">⟳</span> Running…</> : '▶ Run Report'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
        {/* ── Left panel: config ───────────────────── */}
        <div className="space-y-3">

          {/* Source + Metric */}
          <div className="card-surface p-4 space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Data & Metric</div>

            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Data Source</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[{value:'kpi',label:'KPI Segments'},{value:'qc',label:'QC Events'}].map(s=>(
                  <button key={s.value} onClick={() => {
                    const newGroupBy = s.value==='qc' ? 'department' : 'worker';
                    const newMetric = s.value==='qc' ? 'count' : config.metric;
                    setConfig(p=>({...p, source:s.value, groupBy:newGroupBy, metric:newMetric, secondaryMetric:''}));
                    setResults(null);
                  }}
                    className={`py-1.5 text-xs font-semibold rounded-lg border transition-all ${config.source===s.value?'bg-brand-500 text-white border-brand-500':'bg-white text-ink-600 border-surface-200 hover:border-brand-300'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Primary Metric</label>
              <select value={config.metric} onChange={e=>{upd('metric',e.target.value);setResults(null);}}
                className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
                {sourceMetrics.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {config.source === 'kpi' && (
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Secondary Metric <span className="text-ink-300 normal-case">(optional overlay)</span></label>
                <select value={config.secondaryMetric} onChange={e=>upd('secondaryMetric',e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
                  <option value="">None</option>
                  {sourceMetrics.filter(m=>m.value!==config.metric).map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Group By + Display */}
          <div className="card-surface p-4 space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Grouping & Display</div>

            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Group By</label>
              <select value={config.groupBy} onChange={e=>{upd('groupBy',e.target.value);setResults(null);}}
                className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
                {sourceGroupBys.map(g=><option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Chart Type</label>
              <div className="grid grid-cols-3 gap-1">
                {CHART_TYPES.map(c=>(
                  <button key={c.value} onClick={()=>upd('chartType',c.value)}
                    className={`py-1.5 text-[11px] font-medium rounded border transition-all ${config.chartType===c.value?'bg-brand-500 text-white border-brand-500':'bg-white text-ink-500 border-surface-200 hover:border-brand-300'}`}>
                    {c.icon} {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Sort By</label>
                <select value={config.sortBy} onChange={e=>upd('sortBy',e.target.value)}
                  className="w-full px-2 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
                  {SORT_OPTIONS.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Show Top</label>
                <select value={config.limit} onChange={e=>upd('limit',Number(e.target.value))}
                  className="w-full px-2 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
                  {LIMIT_OPTIONS.map(n=><option key={n} value={n}>Top {n}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="card-surface p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Filters</div>
              {hasActiveFilters && <button onClick={resetFilters} className="text-[10px] text-red-500 hover:text-red-700 font-medium">Clear all</button>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">From</label>
                <input type="date" value={config.filters.dateFrom} onChange={e=>updF('dateFrom',e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">To</label>
                <input type="date" value={config.filters.dateTo} onChange={e=>updF('dateTo',e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400" />
              </div>
            </div>

            <MultiSelect label="Order Type" options={orderTypeOpts} value={config.filters.orderType?[config.filters.orderType]:[]}
              onChange={v=>updF('orderType',v[v.length-1]||'')} placeholder="All types" />

            {config.source === 'kpi' && <>
              <MultiSelect label="Workers" options={workers}
                value={config.filters.workers} onChange={v=>updF('workers',v)} placeholder="All workers" />
              <MultiSelect label="Statuses" options={statuses.map(s=>({value:s.slug,label:s.name||s.slug}))}
                value={config.filters.statuses} onChange={v=>updF('statuses',v)} placeholder="All statuses" />
              <MultiSelect label="Departments" options={departments}
                value={config.filters.departments} onChange={v=>updF('departments',v)} placeholder="All departments" />
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input type="checkbox" checked={config.filters.excludeOpen} onChange={e=>updF('excludeOpen',e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-surface-300 text-brand-500" />
                <span className="text-xs text-ink-600">Exclude open segments</span>
              </label>
            </>}

            {config.source === 'qc' && <>
              <MultiSelect label="Departments" options={departments}
                value={config.filters.departments} onChange={v=>updF('departments',v)} placeholder="All departments" />
              <MultiSelect label="Error Type" options={errorTypes}
                value={config.filters.errorTypes} onChange={v=>updF('errorTypes',v)} placeholder="All types" />
              {issues.length > 0 && (
                <MultiSelect label="Issue" options={issues}
                  value={config.filters.issues} onChange={v=>updF('issues',v)} placeholder="All issues" />
              )}
            </>}
          </div>

          {/* Saved Reports */}
          <div className="card-surface p-4 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-2">Saved Reports</div>
            <div className="flex gap-2">
              <input type="text" value={saveName} onChange={e=>{setSaveName(e.target.value);setSaveError('');}}
                placeholder="Report name…" onKeyDown={e=>e.key==='Enter'&&saveReport()}
                className="flex-1 px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400 placeholder-ink-400" />
              <button onClick={saveReport} disabled={!saveName.trim()}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-xs rounded-lg font-medium">
                Save
              </button>
            </div>
            {saveError && <div className="text-[10px] text-red-500">{saveError}</div>}
            {savedReports.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {savedReports.map(r => (
                  <div key={r._id} className="flex items-center justify-between group px-2 py-1.5 rounded-lg hover:bg-surface-50 border border-transparent hover:border-surface-200">
                    <button onClick={()=>loadReport(r)} className="flex-1 text-left text-xs text-brand-600 hover:text-brand-800 font-medium truncate">{r.name}</button>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                      <span className="text-[9px] text-ink-300">{new Date(r.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
                      <button onClick={()=>deleteReport(r._id)} className="text-red-400 hover:text-red-600 text-xs">×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {savedReports.length === 0 && <div className="text-[11px] text-ink-400 text-center py-2">No saved reports</div>}
          </div>
        </div>

        {/* ── Right panel: results ─────────────────── */}
        <div className="space-y-3">
          {!results && !loading && (
            <div className="card-surface flex flex-col items-center justify-center py-24 text-center">
              <div className="text-5xl mb-4 opacity-20">📊</div>
              <h3 className="text-base font-display font-bold text-ink-700 mb-1">Configure and run</h3>
              <p className="text-sm text-ink-400 max-w-xs">Set your metric, grouping, and filters on the left, then click Run Report.</p>
            </div>
          )}

          {loading && (
            <div className="card-surface flex flex-col items-center justify-center py-24">
              <div className="animate-spin text-3xl mb-3 opacity-40">⟳</div>
              <div className="text-sm text-ink-500">Running report…</div>
            </div>
          )}

          {results && !loading && (
            <>
              {/* Stats bar */}
              {stats && (
                <div className="card-surface p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-ink-700">
                      {results.totalMatched.toLocaleString()} records · {results.resultCount} groups
                      {config.limit < results.resultCount && <span className="text-ink-400"> · showing top {config.limit}</span>}
                    </span>
                    <div className="flex gap-1">
                      {['chart','table'].map(t=>(
                        <button key={t} onClick={()=>setTab(t)}
                          className={`px-3 py-1 text-[11px] rounded font-medium transition-all ${tab===t?'bg-brand-500 text-white':'bg-surface-100 text-ink-500 hover:bg-surface-200'}`}>
                          {t==='chart'?'Chart':'Table'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {[
                      { label:'Total',  val: metricDef.fmt(stats.sum) },
                      { label:'Avg',    val: metricDef.fmt(stats.avg) },
                      { label:'Median', val: metricDef.fmt(stats.median) },
                      { label:'Max',    val: metricDef.fmt(stats.max) },
                      { label:'Min',    val: metricDef.fmt(stats.min) },
                    ].map(s => (
                      <div key={s.label} className="bg-surface-50 rounded-lg px-3 py-2">
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-400">{s.label}</div>
                        <div className="text-sm font-bold font-mono text-ink-800 mt-0.5">{s.val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Chart */}
              {tab === 'chart' && config.chartType !== 'table' && (
                <div className="card-surface p-4 bg-slate-900">
                  <div className="text-xs font-semibold text-slate-400 mb-3">
                    {metricDef.label} by {sourceGroupBys.find(g=>g.value===config.groupBy)?.label || config.groupBy}
                    {hasActiveFilters && <span className="ml-2 text-brand-400">· filtered</span>}
                  </div>
                  {renderChart()}
                </div>
              )}

              {/* Table */}
              {(tab === 'table' || config.chartType === 'table') && (
                <div className="card-surface overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink-600">Results — {chartData.length} rows</span>
                    <span className="text-[10px] text-ink-400">Sorted by {SORT_OPTIONS.find(s=>s.value===config.sortBy)?.label}</span>
                  </div>
                  <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                    <table className="tbl w-full">
                      <thead className="sticky top-0 z-10">
                        <tr>
                          <th className="text-left">#</th>
                          <th className="text-left">{sourceGroupBys.find(g=>g.value===config.groupBy)?.label||'Group'}</th>
                          <th className="text-right">{metricDef.label}</th>
                          {hasSecondary && <th className="text-right">{getMetricLabel(config.secondaryMetric,config.source)}</th>}
                          <th className="text-right">Records</th>
                          <th className="text-right">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chartData.map((r,i) => {
                          const share = stats?.sum > 0 ? Math.round(r.value/stats.sum*1000)/10 : 0;
                          return (
                            <tr key={i}>
                              <td className="text-ink-400 text-[11px] font-mono w-8">{i+1}</td>
                              <td className="font-medium text-ink-900 text-sm max-w-[200px] truncate" title={String(r.label)}>
                                {r.label || '(blank)'}
                              </td>
                              <td className="text-right font-mono font-semibold text-ink-900">{metricDef.fmt(r.value)}</td>
                              {hasSecondary && <td className="text-right font-mono text-ink-600">{r.secondary != null ? getMetricLabel(config.secondaryMetric,config.source)+': '+fmt(r.secondary) : '—'}</td>}
                              <td className="text-right text-ink-500 text-xs font-mono">{fmtI(r.count)}</td>
                              <td className="text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  <div className="w-16 h-1.5 rounded-full bg-surface-100 overflow-hidden">
                                    <div className="h-full rounded-full bg-brand-400" style={{ width:`${share}%` }} />
                                  </div>
                                  <span className="text-[10px] text-ink-400 w-8 text-right">{share}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
