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
  const [tab, setTab] = useState('health'); // 'health' | 'coverage' | 'order'
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
          { key:'health',   label:'Data Health' },
          { key:'coverage', label:'Coverage Gaps' },
          { key:'order',    label:'Order Quality' },
        ]}
        active={tab} onChange={setTab}
      />

      {tab === 'health'   && <DataHealthTool />}
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

// ── Data Health tool ─────────────────────────────────────────────────────────
function DataHealthTool() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState({}); // serial -> bool

  const run = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api(`/diag/data-health?days=${encodeURIComponent(days)}`);
      setData(r);
    } catch (e) { setErr(e.message); setData(null); }
    setLoading(false);
  }, [days]);

  const repair = useCallback(async (serial) => {
    if (!confirm(`Re-sync ${serial} from live history and delete orphan segments?`)) return;
    setRepairing(p => ({ ...p, [serial]: true }));
    try {
      const r = await api('/diag/order-quality/repair', {
        method: 'POST',
        body: JSON.stringify({ serial }),
      });
      alert(`${serial}: deleted ${r.deletedCount} orphan segment${r.deletedCount === 1 ? '' : 's'} (live had ${r.liveProcessingEntries}, backfill had ${r.backfillSegments}).`);
      // Refresh the panel so the order drops out of the offender lists.
      await run();
    } catch (e) {
      alert(`Repair failed for ${serial}: ${e.message}`);
    } finally {
      setRepairing(p => ({ ...p, [serial]: false }));
    }
  }, [run]);

  return (
    <div className="space-y-4">
      <div className="card-surface p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1">Window (days)</label>
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="px-3 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100">
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <button onClick={run} disabled={loading}
          className="text-xs bg-brand-500 hover:bg-brand-600 disabled:bg-ink-300 text-white px-4 py-1.5 rounded-lg font-semibold">
          {loading ? 'Scanning…' : 'Run scan'}
        </button>
        <span className="text-[11px] text-ink-400">
          Reads only from <code className="font-mono text-[10px] bg-surface-100 px-1 rounded">backfill_kpi_segments</code> — no production load.
        </span>
      </div>

      {err && <div className="card-surface bg-red-50 border-red-200 p-3 text-xs text-red-700">{err}</div>}
      {!data && !loading && (
        <div className="card-surface p-8 text-center text-ink-400 text-sm">
          Click <span className="font-semibold">Run scan</span> to find orders with data-quality issues.
        </div>
      )}

      {data && <DataHealthResult data={data} onRepair={repair} repairing={repairing} />}
    </div>
  );
}

function DataHealthResult({ data, onRepair, repairing }) {
  const s = data.summary;
  const affectedPct = s.totalOrders > 0
    ? Math.round((s.anyAffectedOrderCount / s.totalOrders) * 1000) / 10
    : 0;

  return (
    <div className="space-y-4">
      <div className="metric-grid-5">
        <Card label="Orders in window" value={fmtI(s.totalOrders)} color="brand"
          tooltip="Distinct orders that have at least one segment in backfill_kpi_segments within the selected window." />
        <Card label="Affected orders" value={fmtI(s.anyAffectedOrderCount)} sub={`${affectedPct}% of orders`} color={s.anyAffectedOrderCount > 0 ? 'red' : 'green'}
          tooltip="Orders touched by at least one of the three data-quality patterns. Use the tables below to dig in." />
        <Card label="Same-minute clusters" value={fmtI(s.ordersWithSameMinuteClusters)} sub={`${fmtI(s.clusteredEntriesTotal)} clustered entries`} color={s.ordersWithSameMinuteClusters > 0 ? 'amber' : 'slate'}
          tooltip="Orders where 2+ Processing segments share the same wall-clock minute. V1↔V2 batch-sync signal. NOT autofixable — original times are lost." />
        <Card label="Long segments (>24h)" value={fmtI(s.ordersWithLongSegments)} color={s.ordersWithLongSegments > 0 ? 'amber' : 'slate'}
          tooltip="Closed Processing segments longer than 24 hours — usually chain-break artifacts where intermediate transitions went missing. Already excluded from Avg/Median in PR #2 if benchmarks classify them as Excl-Long." />
        <Card label="Multi-open orders" value={fmtI(s.ordersWithMultipleOpen)} color={s.ordersWithMultipleOpen > 0 ? 'red' : 'green'}
          tooltip="Orders with >1 open Processing segment. Structurally impossible if data is clean. AUTOFIXABLE via Repair — re-syncs from live history and deletes orphans." />
      </div>

      {data.multipleOpenOrders?.length > 0 && (
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-2">Multi-open orders ({data.multipleOpenOrders.length}) — autofixable</div>
          <div className="text-[11px] text-ink-500 mb-3">
            Each order below has multiple open Processing segments in our backfill. The "Repair" button re-reads live history and deletes orphans whose composite key no longer matches.
          </div>
          <div className="overflow-auto max-h-[400px]">
            <table className="tbl w-full">
              <thead className="sticky top-0 bg-surface-50">
                <tr>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Order</th>
                  <th className="text-[10px] px-3 py-2 text-right text-ink-500">Open count</th>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Open segments</th>
                  <th className="text-[10px] px-3 py-2 text-right text-ink-500">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.multipleOpenOrders.map(o => (
                  <tr key={o.orderSerialNumber} className="border-t border-surface-100">
                    <td className="px-3 py-2 text-xs font-mono">{o.orderSerialNumber}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono"><span className="badge badge-danger">{o.openCount}</span></td>
                    <td className="px-3 py-2 text-[11px] text-ink-500">
                      {(o.segments || []).slice(0, 3).map((seg, i) => (
                        <div key={i}>{fmtDateTime(seg.segmentStart)} · {seg.statusName} · {seg.workerName}</div>
                      ))}
                      {o.segments && o.segments.length > 3 && <div className="text-ink-300">… +{o.segments.length - 3} more</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => onRepair(o.orderSerialNumber)} disabled={repairing[o.orderSerialNumber]}
                        className="text-[11px] bg-emerald-600 hover:bg-emerald-700 disabled:bg-ink-300 text-white px-2.5 py-1 rounded font-semibold">
                        {repairing[o.orderSerialNumber] ? 'Repairing…' : 'Repair'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.sameMinuteOrders?.length > 0 && (
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-2">Same-minute cluster orders ({data.sameMinuteOrders.length}) — flag &amp; exclude</div>
          <div className="text-[11px] text-ink-500 mb-3">
            Original event times collapsed by V1↔V2 batch sync. We can't reconstruct them. KPI rollups already drop the zero-duration segments via the <code className="font-mono text-[10px] bg-surface-100 px-1 rounded">durationSeconds &gt; 0</code> filter; affected workers lose attribution for that real time.
          </div>
          <div className="overflow-auto max-h-[400px]">
            <table className="tbl w-full">
              <thead className="sticky top-0 bg-surface-50">
                <tr>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Order</th>
                  <th className="text-[10px] px-3 py-2 text-right text-ink-500">Cluster count</th>
                  <th className="text-[10px] px-3 py-2 text-right text-ink-500">Clustered entries</th>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Sample minutes</th>
                </tr>
              </thead>
              <tbody>
                {data.sameMinuteOrders.map(o => (
                  <tr key={o.orderSerialNumber} className="border-t border-surface-100">
                    <td className="px-3 py-2 text-xs font-mono">{o.orderSerialNumber}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(o.clusterCount)}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono">{fmtI(o.clusteredEntries)}</td>
                    <td className="px-3 py-2 text-[11px] text-ink-500">
                      {(o.minutes || []).slice(0, 3).map((m, i) => (
                        <div key={i}><span className="font-mono">{m.minute}</span> · {m.count} entries</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.longDurationSegments?.length > 0 && (
        <div className="card-surface p-4">
          <div className="text-xs font-semibold text-ink-600 mb-2">Long Processing segments &gt; 24h ({data.longDurationSegments.length}) — already excluded</div>
          <div className="text-[11px] text-ink-500 mb-3">
            Segments spanning more than a day. Most are chain-break artifacts (the V1↔V2 sync dropped intermediate transitions, so the segment spans the gap). PR #2's Excl-Long filter already removes these from Avg / Median / Total Hours / XpH if benchmarks classify them past <code className="font-mono text-[10px] bg-surface-100 px-1 rounded">excludeLongSec</code>.
          </div>
          <div className="overflow-auto max-h-[400px]">
            <table className="tbl w-full">
              <thead className="sticky top-0 bg-surface-50">
                <tr>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Order</th>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Status</th>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Worker</th>
                  <th className="text-[10px] px-3 py-2 text-left text-ink-500">Started</th>
                  <th className="text-[10px] px-3 py-2 text-right text-ink-500">Duration (hrs)</th>
                </tr>
              </thead>
              <tbody>
                {data.longDurationSegments.map((s, i) => (
                  <tr key={i} className="border-t border-surface-100">
                    <td className="px-3 py-2 text-xs font-mono">{s.orderSerialNumber}</td>
                    <td className="px-3 py-2 text-[11px]">{s.statusName}</td>
                    <td className="px-3 py-2 text-[11px] text-ink-500">{s.workerName || '—'}</td>
                    <td className="px-3 py-2 text-[11px] font-mono">{fmtDateTime(s.segmentStart)}</td>
                    <td className="px-3 py-2 text-xs text-right font-mono text-amber-700">{fmt((s.durationMinutes || 0) / 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {s.anyAffectedOrderCount === 0 && (
        <div className="card-surface bg-emerald-50 border-emerald-200 p-6 text-center">
          <div className="text-3xl mb-2">✓</div>
          <div className="text-sm font-semibold text-emerald-700">No data-quality issues detected in this window.</div>
        </div>
      )}
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
