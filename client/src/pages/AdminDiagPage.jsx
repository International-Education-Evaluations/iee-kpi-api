import React, { useState, useCallback } from 'react';
import { Card, Pills, fmt, fmtI, fmtDateTime } from '../components/UI';
import { api } from '../hooks/useApi';

// Default the date range to the last 7 days so the page is useful on first load.
function defaultRange() {
  const today = new Date();
  const from  = new Date(today.getTime() - 7 * 86400000);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

export default function AdminDiagPage() {
  const [tab, setTab] = useState('coverage'); // 'coverage' | 'order'
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-display font-bold text-ink-900">Diagnostics</h1>
        <p className="text-[11px] text-ink-400 mt-0.5">
          Admin-only triage tools that hit the live <code className="font-mono text-[10px] bg-surface-100 px-1 rounded">/diag/*</code> endpoints with your session JWT.
        </p>
      </div>

      <Pills
        tabs={[
          { key:'coverage', label:'Coverage Gaps' },
          { key:'order',    label:'Order Quality' },
        ]}
        active={tab} onChange={setTab}
      />

      {tab === 'coverage' && <CoverageTool />}
      {tab === 'order'    && <OrderQualityTool />}
    </div>
  );
}

// ── Coverage tool ────────────────────────────────────────────────────────────
function CoverageTool() {
  const [{ from, to }, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    if (!from || !to) { setErr('Pick both from and to dates.'); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api(`/diag/coverage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setData(r);
    } catch (e) { setErr(e.message); setData(null); }
    setLoading(false);
  }, [from, to]);

  return (
    <div className="space-y-4">
      <div className="card-surface p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">From</label>
          <input type="date" value={from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
            className="px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">To</label>
          <input type="date" value={to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
            className="px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
        </div>
        <button onClick={run} disabled={loading}
          className="text-xs bg-brand-500 hover:bg-brand-600 disabled:bg-ink-300 text-white px-4 py-1.5 rounded-lg font-semibold">
          {loading ? 'Running…' : 'Run'}
        </button>
        <span className="text-[11px] text-ink-400">Range capped at 31 days. Production query may take 30-60s.</span>
      </div>

      {err && <div className="card-surface bg-red-50 border-red-200 p-3 text-xs text-red-700">{err}</div>}

      {data && <CoverageResult data={data} />}
    </div>
  );
}

function CoverageResult({ data }) {
  const totalProd     = data.days.reduce((a, d) => a + (d.prodTransitions || 0), 0);
  const totalSegments = data.days.reduce((a, d) => a + (d.segments || 0), 0);
  const backfillMissing = data.gaps.filter(g => g.kind === 'backfill-missing').length;
  const sourceMissing   = data.gaps.filter(g => g.kind === 'no-source-data').length;

  return (
    <div className="space-y-4">
      <div className="metric-grid-5">
        <Card label="Days" value={fmtI(data.range.days)} color="brand" />
        <Card label="Prod Transitions" value={fmtI(totalProd)} color="navy"
          tooltip="Sum of orderStatusHistory entries (Processing only) in the window — what V2 production has." />
        <Card label="Backfill Segments" value={fmtI(totalSegments)} color="green"
          tooltip="Sum of rows in iee_dashboard.backfill_kpi_segments with segmentStart in the window." />
        <Card label="Backfill-Missing Days" value={fmtI(backfillMissing)} color={backfillMissing > 0 ? 'red' : 'slate'}
          tooltip="Days where production has transitions but our backfill has zero segments. Indicates a backfill pipeline gap." />
        <Card label="Source-Missing Days" value={fmtI(sourceMissing)} color={sourceMissing > 0 ? 'amber' : 'slate'}
          tooltip="Days where neither V2 nor backfill has data. Could be weekend, outage, or upstream sync failure." />
      </div>

      {data.watchdogResets?.length > 0 && (
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-2">Watchdog resets in this window ({data.watchdogResets.length})</div>
          <table className="tbl w-full">
            <thead><tr>
              <th className="text-[10px] px-3 py-2 text-left text-ink-500">When</th>
              <th className="text-[10px] px-3 py-2 text-left text-ink-500">Elapsed (min)</th>
              <th className="text-[10px] px-3 py-2 text-left text-ink-500">Threshold (min)</th>
            </tr></thead>
            <tbody>
              {data.watchdogResets.map((r, i) => (
                <tr key={i} className="border-t border-surface-100">
                  <td className="px-3 py-2 text-xs">{fmtDateTime(r.timestamp)}</td>
                  <td className="px-3 py-2 text-xs font-mono">{r.data?.elapsedMin ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono">{r.data?.thresholdMin ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-surface p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-ink-600">Daily counts</div>
          <div className="text-[10px] text-ink-400">{data.days.length} days</div>
        </div>
        <div className="overflow-auto max-h-[500px]">
          <table className="tbl w-full">
            <thead className="sticky top-0 bg-surface-50">
              <tr>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Date</th>
                <th className="text-[10px] px-3 py-2 text-right text-ink-500">Prod transitions</th>
                <th className="text-[10px] px-3 py-2 text-right text-ink-500">Prod orders</th>
                <th className="text-[10px] px-3 py-2 text-right text-ink-500">Backfill segments</th>
                <th className="text-[10px] px-3 py-2 text-right text-ink-500">Backfill orders</th>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => {
                const gap = (d.prodTransitions > 0 && d.segments === 0) ? 'backfill-missing'
                          : (d.prodTransitions === 0 && d.segments === 0) ? 'no-source-data'
                          : null;
                return (
                  <tr key={d.date} className={`border-t border-surface-100 ${gap === 'backfill-missing' ? 'bg-red-50' : gap === 'no-source-data' ? 'bg-amber-50' : ''}`}>
                    <td className="px-3 py-2 text-xs font-mono">{d.date}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(d.prodTransitions)}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(d.prodOrders)}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(d.segments)}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(d.segOrders)}</td>
                    <td className="px-3 py-2 text-xs">
                      {gap === 'backfill-missing' && <span className="badge badge-danger">Backfill missing</span>}
                      {gap === 'no-source-data'   && <span className="badge badge-warning">No source data</span>}
                      {!gap && <span className="text-ink-300">OK</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-surface p-4 text-[11px] text-ink-500">
        Last backfill run: <span className="font-mono">{data.backfill?.lastRunAt ? fmtDateTime(data.backfill.lastRunAt) : '—'}</span>
        {data.backfill?.lastRunDurationSec != null && <> · {fmt(data.backfill.lastRunDurationSec, 0)}s</>}
        {data.backfill?.currentlyRunning && <> · <span className="badge badge-warning">Running</span></>}
        · Watchdog: {data.backfill?.watchdogThresholdMin}min
      </div>
    </div>
  );
}

// ── Order Quality tool ───────────────────────────────────────────────────────
function OrderQualityTool() {
  const [serial, setSerial] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    const s = serial.trim();
    if (!s) { setErr('Enter an order serial number.'); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api(`/diag/order-quality?serial=${encodeURIComponent(s)}`);
      setData(r);
    } catch (e) { setErr(e.message); setData(null); }
    setLoading(false);
  }, [serial]);

  return (
    <div className="space-y-4">
      <div className="card-surface p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Order serial number</label>
          <input type="text" value={serial} onChange={e => setSerial(e.target.value)}
            placeholder="e.g. 1632388091"
            onKeyDown={e => { if (e.key === 'Enter') run(); }}
            className="w-full px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 placeholder-ink-400 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
        </div>
        <button onClick={run} disabled={loading}
          className="text-xs bg-brand-500 hover:bg-brand-600 disabled:bg-ink-300 text-white px-4 py-1.5 rounded-lg font-semibold">
          {loading ? 'Running…' : 'Run'}
        </button>
      </div>

      {err && <div className="card-surface bg-red-50 border-red-200 p-3 text-xs text-red-700">{err}</div>}
      {data && <OrderQualityResult data={data} />}
    </div>
  );
}

function OrderQualityResult({ data }) {
  const a = data.summary?.anomalies || {};
  const totalAnomalies = (a.sameMinuteClusterCount || 0) + (a.outOfOrderCount || 0)
                       + (a.largeGapCount || 0) + (a.selfTransitionCount || 0);

  return (
    <div className="space-y-4">
      <div className="card-surface p-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-display font-bold text-ink-900">{data.orderSerialNumber}</div>
          <div className="text-[11px] text-ink-400 mt-0.5">
            {data.orderType || '—'} · {data.orderSource || '—'} · created {data.createdAt ? fmtDateTime(data.createdAt) : '—'}
            {data.completedAt && <> · completed {fmtDateTime(data.completedAt)}</>}
          </div>
        </div>
        {totalAnomalies > 0
          ? <span className="badge badge-danger">{totalAnomalies} anomalies</span>
          : <span className="badge badge-success">Clean</span>}
      </div>

      <div className="metric-grid-5">
        <Card label="History entries" value={fmtI(data.summary?.totalEntries)} color="navy"
          tooltip="Total entries in the order's orderStatusHistory array, including non-Processing transitions." />
        <Card label="Processing entries" value={fmtI(data.summary?.processingEntries)} color="brand"
          tooltip="Subset where updatedStatus.statusType === 'Processing' — these are the rows the dashboard turns into segments." />
        <Card label="Same-minute clusters" value={fmtI(a.sameMinuteClusterCount)} color={a.sameMinuteClusterCount > 0 ? 'red' : 'slate'}
          tooltip="Groups of 2+ entries stamped within the same wall-clock minute. Strong V1↔V2 batch-sync signal." />
        <Card label="Chain breaks (>24h)" value={fmtI(a.largeGapCount)} color={a.largeGapCount > 0 ? 'amber' : 'slate'}
          tooltip="Gaps over 24h between consecutive Processing entries with no intermediate non-Processing pause. Often missing transitions." />
        <Card label="Out-of-order" value={fmtI(a.outOfOrderCount)} color={a.outOfOrderCount > 0 ? 'amber' : 'slate'}
          tooltip="Entries whose createdAt is earlier than the entry before them (after sort). Signals replay/sync issues." />
      </div>

      {data.sameMinuteClusters?.length > 0 && (
        <AnomalyTable
          title={`Same-minute clusters (${data.sameMinuteClusters.length})`}
          rows={data.sameMinuteClusters}
          cols={[
            { key:'minute', label:'Minute', render:v => <span className="font-mono text-xs">{v}</span> },
            { key:'count',  label:'Entries', right:true, render:v => fmtI(v) },
            { key:'statuses', label:'Statuses', render:v => <span className="text-[11px] text-ink-500">{(v || []).join(' · ')}</span> },
          ]}
        />
      )}

      {data.largeGapsHours?.length > 0 && (
        <AnomalyTable
          title={`Chain breaks (${data.largeGapsHours.length})`}
          rows={data.largeGapsHours}
          cols={[
            { key:'fromAt', label:'From', render:v => <span className="font-mono text-[11px]">{fmtDateTime(v)}</span> },
            { key:'fromStatus', label:'Status', render:v => <span className="text-[11px]">{v}</span> },
            { key:'toAt', label:'To', render:v => <span className="font-mono text-[11px]">{fmtDateTime(v)}</span> },
            { key:'toStatus', label:'Status', render:v => <span className="text-[11px]">{v}</span> },
            { key:'hours', label:'Gap (hrs)', right:true, render:v => <span className="font-mono text-xs text-amber-700">{fmt(v)}</span> },
          ]}
        />
      )}

      {data.outOfOrderEntries?.length > 0 && (
        <AnomalyTable
          title={`Out-of-order entries (${data.outOfOrderEntries.length})`}
          rows={data.outOfOrderEntries}
          cols={[
            { key:'at',     label:'Stamped', render:v => <span className="font-mono text-[11px]">{fmtDateTime(v)}</span> },
            { key:'after',  label:'Comes after', render:v => <span className="font-mono text-[11px]">{fmtDateTime(v)}</span> },
            { key:'status', label:'Status' },
          ]}
        />
      )}

      {data.selfTransitions?.length > 0 && (
        <AnomalyTable
          title={`Self transitions (${data.selfTransitions.length})`}
          rows={data.selfTransitions}
          cols={[
            { key:'slug', label:'Status' },
            { key:'at',   label:'When', render:v => <span className="font-mono text-[11px]">{fmtDateTime(v)}</span> },
          ]}
        />
      )}

      <div className="card-surface p-4">
        <div className="text-xs font-semibold text-ink-600 mb-2">Full timeline ({data.history?.length || 0} entries)</div>
        <div className="overflow-auto max-h-[500px]">
          <table className="tbl w-full">
            <thead className="sticky top-0 bg-surface-50">
              <tr>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">When</th>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Type</th>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Status</th>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Assigned to</th>
                <th className="text-[10px] px-3 py-2 text-left text-ink-500">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {(data.history || []).map((h, i) => (
                <tr key={i} className="border-t border-surface-100">
                  <td className="px-3 py-2 text-[11px] font-mono text-ink-600">{fmtDateTime(h.createdAt)}</td>
                  <td className="px-3 py-2 text-[11px]">
                    <span className={`badge ${h.statusType === 'Processing' ? 'badge-info' : ''}`}>{h.statusType || '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-[11px]">{h.statusName || h.statusSlug || '—'}</td>
                  <td className="px-3 py-2 text-[11px] text-ink-600">{h.assignedTo || '—'}</td>
                  <td className="px-3 py-2 text-[11px] text-ink-500">{h.changedBy || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AnomalyTable({ title, rows, cols }) {
  return (
    <div className="card-surface p-4">
      <div className="text-xs font-semibold text-ink-600 mb-2">{title}</div>
      <div className="overflow-auto">
        <table className="tbl w-full">
          <thead><tr>
            {cols.map((c, i) => (
              <th key={i} className={`text-[10px] px-3 py-2 ${c.right ? 'text-right' : 'text-left'} text-ink-500`}>{c.label}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-surface-100">
                {cols.map((c, j) => (
                  <td key={j} className={`px-3 py-2 text-xs ${c.right ? 'text-right' : ''}`}>
                    {c.render ? c.render(r[c.key], r) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
