import React, { useState, useCallback } from 'react';
import { api } from '../hooks/useApi';
import { fmt, fmtI, fmtDur, fmtDateTime } from '../components/UI';

const PROD_ADMIN_BASE = 'https://admin.myiee.org/orders';

function TypeBadge({ type }) {
  const cfg = type === 'qc'
    ? { bg:'bg-violet-50 border-violet-200 text-violet-700', icon:'✓', label:'QC Event' }
    : { bg:'bg-brand-50 border-brand-200 text-brand-700', icon:'◈', label:'Segment' };
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${cfg.bg}`}>{cfg.icon} {cfg.label}</span>;
}

function StatCard({ label, value, sub, color = 'text-ink-900' }) {
  return (
    <div className="bg-surface-50 border border-surface-200 rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-400">{label}</div>
      <div className={`text-xl font-display font-bold mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function OrderTracker() {
  const [input, setInput]   = useState('');
  const [order, setOrder]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');
  const [expandedIdx, setExpandedIdx] = useState(null);

  const search = useCallback(async (serial) => {
    const s = (serial || input).trim();
    if (!s) return;
    setLoading(true); setError(''); setOrder(null); setExpandedIdx(null);
    try {
      const d = await api(`/data/order/${encodeURIComponent(s)}`);
      setOrder(d);
    } catch (e) {
      setError(e.message || 'Order not found');
    }
    setLoading(false);
  }, [input]);

  const handleKey = (e) => { if (e.key === 'Enter') search(); };

  const qcIcon = (e) => e.isFixedIt ? '✔ Fixed It' : e.isKickItBack ? '↩ Kick Back' : e.errorType || 'QC';
  const qcColor = (e) => e.isFixedIt ? 'text-emerald-600' : e.isKickItBack ? 'text-red-600' : 'text-violet-600';

  const bucketColor = (bucket) => ({
    'In-Range': 'text-emerald-600 bg-emerald-50 border-emerald-200',
    'Out-of-Range Short': 'text-amber-600 bg-amber-50 border-amber-200',
    'Out-of-Range Long': 'text-orange-600 bg-orange-50 border-orange-200',
    'Exclude Short': 'text-slate-500 bg-slate-50 border-slate-200',
    'Exclude Long': 'text-red-600 bg-red-50 border-red-200',
  }[bucket] || 'text-ink-400 bg-surface-50 border-surface-200');

  return (
    <div className="space-y-5" data-tour="order-tracker-title">
      <div>
        <h1 className="text-xl font-display font-bold text-ink-900">Order Tracker</h1>
        <p className="text-xs text-ink-400 mt-0.5">Search by order serial number to see the full processing lifecycle</p>
      </div>

      {/* Search bar */}
      <div className="card-surface p-4">
        <div className="flex gap-2 max-w-xl">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
            placeholder="e.g. 1632385511"
            className="flex-1 px-4 py-2.5 bg-white border border-surface-200 rounded-xl text-sm text-ink-900 focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 placeholder-ink-400 font-mono" />
          <button onClick={() => search()} disabled={loading || !input.trim()}
            className="px-5 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-semibold rounded-xl transition-colors">
            {loading ? '⟳' : 'Search'}
          </button>
        </div>
        {error && <div className="mt-3 text-sm text-red-600 flex items-center gap-2">⚠ {error}</div>}
      </div>

      {order && (
        <>
          {/* Order header */}
          <div className="card-surface p-4">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-display font-bold text-ink-900 font-mono">{order.serialNumber}</span>
                  {order.orderType && <span className="px-2 py-0.5 rounded-lg bg-brand-50 text-brand-700 text-xs font-semibold border border-brand-200 capitalize">{order.orderType}</span>}
                </div>
                {order.firstSeen && (
                  <p className="text-xs text-ink-400 mt-1">
                    First seen {fmtDateTime(order.firstSeen)}
                    {order.lastSeen && order.lastSeen !== order.firstSeen && ` · Last activity ${fmtDateTime(order.lastSeen)}`}
                  </p>
                )}
              </div>
              <a href={`${PROD_ADMIN_BASE}/${order.serialNumber}`} target="_blank" rel="noreferrer"
                className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-brand-600 hover:bg-brand-50 font-medium flex items-center gap-1.5">
                ↗ Open in admin
              </a>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
              <StatCard label="Segments"   value={fmtI(order.totalSegments)} sub={order.openSegments > 0 ? `${order.openSegments} open` : 'all closed'} color={order.openSegments>0?'text-amber-600':'text-ink-900'} />
              <StatCard label="QC Events"  value={fmtI(order.totalQcEvents)} sub={order.kickBackCount > 0 ? `${order.kickBackCount} kick-back` : 'no kick-backs'} color={order.kickBackCount>0?'text-red-600':'text-ink-900'} />
              <StatCard label="Fixed It"   value={fmtI(order.fixedItCount)} />
              <StatCard label="Kick-Back"  value={fmtI(order.kickBackCount)} color={order.kickBackCount>0?'text-red-600':'text-ink-900'} />
              <StatCard label="Total Time" value={`${order.totalMinutes}m`} sub={`${order.uniqueWorkers} worker${order.uniqueWorkers!==1?'s':''}`} />
              <StatCard label="Statuses"   value={fmtI(order.uniqueStatuses.length)} sub={order.uniqueStatuses.slice(0,2).join(', ')} />
            </div>
          </div>

          {/* Timeline */}
          <div className="card-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-200">
              <span className="text-xs font-semibold text-ink-700">Timeline — {order.timeline.length} events</span>
            </div>
            <div className="relative pl-8 py-4 pr-4 space-y-0">
              {/* Vertical line */}
              <div className="absolute left-[26px] top-6 bottom-6 w-px bg-surface-200" />

              {order.timeline.map((ev, i) => {
                const isExp = expandedIdx === i;
                const isSeg = ev.type === 'segment';
                const isQc  = ev.type === 'qc';
                return (
                  <div key={i} className="relative flex gap-3 py-2">
                    {/* Dot */}
                    <div className={`absolute left-[-22px] w-3 h-3 rounded-full border-2 mt-2.5 ${isSeg ? 'bg-brand-400 border-brand-600' : 'bg-violet-400 border-violet-600'}`} />
                    <div className="flex-1 min-w-0">
                      <button onClick={() => setExpandedIdx(isExp ? null : i)}
                        className="w-full text-left group">
                        <div className="flex items-center gap-2 flex-wrap">
                          <TypeBadge type={ev.type} />
                          <span className="text-xs font-semibold text-ink-900">
                            {isSeg ? ev.statusName || ev.statusSlug || '—' : <span className={qcColor(ev)}>{qcIcon(ev)}</span>}
                          </span>
                          {isSeg && ev.workerName && <span className="text-xs text-ink-500">{ev.workerName}</span>}
                          {isQc && ev.accountableName && <span className="text-xs text-ink-500">→ {ev.accountableName}</span>}
                          <span className="text-[10px] text-ink-400 font-mono ml-auto">{ev.at ? fmtDateTime(ev.at) : '—'}</span>
                          {isSeg && !ev.isOpen && ev.durationMinutes != null && (
                            <span className="text-[10px] font-mono text-ink-600 bg-surface-100 px-1.5 py-0.5 rounded">{fmtDur(ev.durationMinutes)}</span>
                          )}
                          {isSeg && ev.isOpen && <span className="text-[10px] font-semibold text-amber-600">Open</span>}
                          <span className="text-ink-300 text-xs group-hover:text-ink-500">{isExp ? '▲' : '▼'}</span>
                        </div>
                      </button>

                      {isExp && (
                        <div className="mt-2 ml-2 p-3 bg-surface-50 border border-surface-200 rounded-lg text-xs space-y-1.5">
                          {isSeg && <>
                            {ev.statusSlug   && <div><span className="text-ink-400 w-28 inline-block">Status slug</span><span className="font-mono text-ink-700">{ev.statusSlug}</span></div>}
                            {ev.workerEmail  && <div><span className="text-ink-400 w-28 inline-block">Worker email</span><span className="font-mono text-ink-700">{ev.workerEmail}</span></div>}
                            {ev.workerUserId && <div><span className="text-ink-400 w-28 inline-block">Worker ID</span><span className="font-mono text-ink-700">{ev.workerUserId}</span></div>}
                            {ev.departmentName&&<div><span className="text-ink-400 w-28 inline-block">Department</span><span className="text-ink-700">{ev.departmentName}</span></div>}
                            {ev.durationSeconds!=null&&<div><span className="text-ink-400 w-28 inline-block">Duration</span><span className="font-mono text-ink-700">{Math.round(ev.durationSeconds)}s ({fmtDur(ev.durationMinutes)})</span></div>}
                            {ev.changedByName && <div><span className="text-ink-400 w-28 inline-block">Changed by</span><span className="text-ink-700">{ev.changedByName}</span></div>}
                            {ev.reportItemCount>0&&<div><span className="text-ink-400 w-28 inline-block">Reports</span><span className="font-mono text-ink-700">{ev.reportItemCount} — {ev.reportItemName||'—'}</span></div>}
                            {ev.end && <div><span className="text-ink-400 w-28 inline-block">Ended at</span><span className="font-mono text-ink-700">{fmtDateTime(ev.end)}</span></div>}
                          </>}
                          {isQc && <>
                            {ev.issueName    && <div><span className="text-ink-400 w-28 inline-block">Issue</span><span className="text-ink-700">{ev.issueName}</span></div>}
                            {ev.reporterName && <div><span className="text-ink-400 w-28 inline-block">Reported by</span><span className="text-ink-700">{ev.reporterName}</span></div>}
                            {ev.accountableName&&<div><span className="text-ink-400 w-28 inline-block">Accountable</span><span className="text-ink-700">{ev.accountableName}</span></div>}
                            {ev.statusAtQcName&&<div><span className="text-ink-400 w-28 inline-block">Status at QC</span><span className="text-ink-700">{ev.statusAtQcName}</span></div>}
                            {ev.departmentName&&<div><span className="text-ink-400 w-28 inline-block">Department</span><span className="text-ink-700">{ev.departmentName}</span></div>}
                          </>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!order && !loading && !error && (
        <div className="card-surface flex flex-col items-center justify-center py-24 text-center">
          <div className="text-5xl mb-4 opacity-20">🔍</div>
          <h3 className="text-base font-display font-bold text-ink-700 mb-1">Enter an order serial number</h3>
          <p className="text-sm text-ink-400 max-w-xs">Search any order to see its full segment history, QC events, workers, and durations in chronological order.</p>
        </div>
      )}
    </div>
  );
}
