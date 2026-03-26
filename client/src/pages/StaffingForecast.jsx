import React, { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
         Tooltip, Legend, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { api } from '../hooks/useApi';
import { fmt, fmtI, TOOLTIP_STYLE } from '../components/UI';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const fmtHour = h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
const fmtHrs  = h => h == null ? '—' : h < 24 ? `${h}h` : `${Math.round(h/24*10)/10}d`;

function heatStyle(val, max) {
  if (!max || !val) return { background:'#f1f5f9', color:'#94a3b8' };
  const p = Math.min(val / max, 1);
  return { background:`rgba(0,174,239,${0.08 + p * 0.85})`, color: p > 0.5 ? '#fff' : '#0369a1' };
}

function SLABadge({ status }) {
  const cfg = { 'on-track':['bg-emerald-100 text-emerald-700 border-emerald-200','✓ On Track'],
                'at-risk':  ['bg-amber-100 text-amber-700 border-amber-200','~ At Risk'],
                'breaching':['bg-red-100 text-red-700 border-red-200','✗ Breaching'] }[status]
           || ['bg-surface-100 text-ink-500 border-surface-200','—'];
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cfg[0]}`}>{cfg[1]}</span>;
}

function StatCard({ label, value, sub, color = 'text-ink-900' }) {
  return (
    <div className="bg-surface-50 border border-surface-200 rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-400">{label}</div>
      <div className={`text-xl font-display font-bold mt-1 ${color}`}>{value ?? '—'}</div>
      {sub && <div className="text-[10px] text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}


// ── Model Transparency Component ─────────────────────────────────────────────
const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function ConfidenceDot({ weeks }) {
  if (weeks >= 8) return (
    <span title={`${weeks} weeks of data — stable`}
      className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />{weeks}w
    </span>
  );
  if (weeks >= 4) return (
    <span title={`${weeks} weeks of data — building`}
      className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700">
      <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />{weeks}w
    </span>
  );
  return (
    <span title={`${weeks} weeks of data — too few for reliable patterns`}
      className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600">
      <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />{weeks}w
    </span>
  );
}

function ModelTransparency({ meta, dept }) {
  const [open, setOpen] = React.useState(false);

  const overallConfidence = (() => {
    if (!meta) return 'unknown';
    const minWeeks = Math.min(...(meta.dowSampleWeeks || [0]));
    const avgWeeks = (meta.dowSampleWeeks || []).reduce((a,b) => a+b, 0) / 7;
    const hasEnoughSegs = meta.xphSampleSize >= 200;
    if (minWeeks >= 8 && hasEnoughSegs) return 'high';
    if (avgWeeks >= 4 && hasEnoughSegs) return 'medium';
    return 'low';
  })();

  const confidenceConfig = {
    high:   { label:'High Confidence', color:'text-emerald-700', bg:'bg-emerald-50 border-emerald-200', dot:'bg-emerald-500' },
    medium: { label:'Building Confidence', color:'text-amber-700', bg:'bg-amber-50 border-amber-200', dot:'bg-amber-400' },
    low:    { label:'Low Confidence', color:'text-red-700', bg:'bg-red-50 border-red-200', dot:'bg-red-400' },
    unknown:{ label:'No Data', color:'text-ink-500', bg:'bg-surface-50 border-surface-200', dot:'bg-ink-300' },
  }[overallConfidence];

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';

  return (
    <div className={`card-surface border overflow-hidden ${confidenceConfig.bg}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-3 flex items-center justify-between hover:opacity-80 transition-opacity">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${confidenceConfig.dot} inline-block`} />
          <span className={`text-xs font-bold ${confidenceConfig.color}`}>ℹ Model Transparency — {confidenceConfig.label}</span>
          {dept && <span className="text-[10px] text-ink-500 bg-white/60 px-1.5 py-0.5 rounded border border-white/80">{dept}</span>}
        </div>
        <span className="text-[10px] text-ink-400">{open ? '▲ Hide' : '▼ View details'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-white/50">

          {/* Data foundation */}
          <div className="pt-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-500 mb-2">Data Foundation</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label:'Orders in model', value: fmtI(meta.totalOrders || 0), sub:'since go-live' },
                { label:'Date range', value: `${fmtDate(meta.earliestDate)}`, sub: `→ ${fmtDate(meta.latestDate)}` },
                { label:'Data span', value: `${meta.dataSpanWeeks}w`, sub: `${meta.dataSpanDays} calendar days` },
                { label:'Segments for XpH', value: fmtI(meta.xphSampleSize || 0), sub:'last 60 days' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="bg-white/60 rounded-lg px-3 py-2 border border-white/80">
                  <div className="text-[9px] uppercase tracking-wider text-ink-400 mb-0.5">{label}</div>
                  <div className="text-sm font-bold text-ink-900">{value}</div>
                  <div className="text-[9px] text-ink-400">{sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-day stability */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-500 mb-2">
              Day-of-Week Pattern Stability
              <span className="ml-2 font-normal normal-case text-ink-400">≥8 weeks = stable · 4–7 = building · &lt;4 = unreliable</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {DOW_NAMES.map((day, d) => (
                <div key={day} className="bg-white/60 border border-white/80 rounded-lg px-3 py-2 text-center min-w-[60px]">
                  <div className="text-[9px] font-semibold text-ink-500 mb-1">{day}</div>
                  <ConfidenceDot weeks={meta.dowSampleWeeks?.[d] || 0} />
                </div>
              ))}
            </div>
            {Math.min(...(meta.dowSampleWeeks || [0])) < 4 && (
              <p className="text-[10px] text-red-600 mt-2">
                ⚠ Some days have fewer than 4 weeks of data. Heatmap patterns for those days may reflect noise rather than real demand cycles. Revisit this model after accumulating 8+ weeks.
              </p>
            )}
          </div>

          {/* XpH warning */}
          {(meta.xphSampleSize || 0) < 200 && (
            <div className="bg-amber-100/60 border border-amber-200 rounded-lg px-3 py-2">
              <p className="text-[11px] text-amber-800">
                <strong>Low XpH sample size ({fmtI(meta.xphSampleSize)} segments).</strong> The weighted team XpH is based on fewer segments than ideal. XpH estimates stabilise around 500+ segments. The staffing number may shift as more data accumulates.
              </p>
            </div>
          )}

          {/* Model assumptions */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-500 mb-2">Model Assumptions (known limitations)</div>
            <div className="space-y-1.5">
              {[
                ['100% staff utilisation', 'The model assumes every staff member is processing orders continuously. Real utilisation is typically 70–85%. Add 20–30% buffer to the recommended numbers.'],
                ['Orders arrive evenly within each hour', 'The model averages arrivals across each 1-hour window. If your 6pm orders all arrive at 6:01pm, the peak is sharper than the model shows.'],
                ['All statuses have equal staffing weight', 'The weighted XpH treats all statuses as interchangeable. In reality Digital Fulfillment workers cannot do Initial Evaluation work. Department filtering helps, but cross-status staffing variance is not modelled.'],
                ['No seasonality or events', `You have ${meta.dataSpanWeeks} weeks of data — not enough to detect annual cycles, institutional deadlines, or promotional events. A Georgia Tech admission deadline spike will not be predicted.`],
                ['No queue backlog factor', 'The model calculates staff needed for incoming demand only. If there is an existing backlog, additional staff is required to drain it on top of handling new arrivals.'],
              ].map(([title, desc]) => (
                <div key={title} className="flex gap-2 text-[11px]">
                  <span className="text-ink-300 mt-0.5 shrink-0">→</span>
                  <span><strong className="text-ink-700">{title}:</strong> <span className="text-ink-500">{desc}</span></span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[10px] text-ink-400 pt-1 border-t border-white/50">
            Model generated {new Date(meta.generatedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} · Data updates every 5 minutes with backfill
          </div>
        </div>
      )}
    </div>
  );
}

export default function StaffingForecast() {
  const [staffing, setStaffing]   = useState(null);
  const [sla,      setSla]        = useState(null);
  const [loading,  setLoading]    = useState(true);
  const [tab,      setTab]        = useState('demand');
  const [dept,     setDept]       = useState('');           // active department filter
  const [departments, setDepartments] = useState([]);

  const loadData = (selectedDept = dept) => {
    setLoading(true);
    const q = selectedDept ? `?dept=${encodeURIComponent(selectedDept)}` : '';
    Promise.all([
      api(`/data/forecast/staffing${q}`).catch(e => ({ error: e.message })),
      api(`/data/forecast/sla-analysis${q}`).catch(e => ({ error: e.message })),
    ]).then(([s, sl]) => {
      setStaffing(s);
      setSla(sl);
      // staffing endpoint now always returns departments from backfill_order_turnaround
      // Fall back to sla.departments if staffing doesn't have them yet
      const depts = s?.departments || sl?.departments || [];
      if (depts.length > 0) setDepartments(depts);
      setLoading(false);
    });
  };

  useEffect(() => { loadData(); }, []); // eslint-disable-line

  const handleDeptChange = (d) => {
    setDept(d);
    loadData(d);
  };

  // ── Demand heatmap (arrivals by dow × hour) ─────────────────────────────────
  const arrivalGrid = useMemo(() => {
    if (!staffing?.arrivals) return { grid: [], max: 0 };
    const grid = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => {
        const slot = staffing.arrivals.find(s => s.dow === d && s.hour === h);
        return slot?.count || 0;
      })
    );
    const max = Math.max(...grid.flat(), 1);
    return { grid, max };
  }, [staffing]);

  // ── Required staff model ────────────────────────────────────────────────────
  // staff = ceil( arrivals_in_window / xph_for_primary_statuses )
  // Primary = Processing statuses (not Waiting). XpH from segments.
  const staffingModel = useMemo(() => {
    if (!staffing?.arrivals || !staffing?.xphByStatus) return [];
    // Average XpH across all processing statuses (weighted by volume)
    const totalSegs = staffing.xphByStatus.reduce((a, s) => a + s.segments, 0);
    const weightedXph = totalSegs > 0
      ? staffing.xphByStatus.reduce((a, s) => a + s.xph * (s.segments / totalSegs), 0)
      : 4; // safe fallback

    // For each hour bucket, compute average arrivals across all days
    return HOURS.map(h => {
      const avgArrivals = DAYS.reduce((a, _, d) => a + (arrivalGrid.grid[d]?.[h] || 0), 0) / 7;
      const requiredStaff = avgArrivals > 0 ? Math.ceil(avgArrivals / weightedXph) : 0;
      return {
        hour: h, label: fmtHour(h), avgArrivals: Math.round(avgArrivals * 10) / 10,
        requiredStaff, weightedXph: Math.round(weightedXph * 100) / 100,
      };
    });
  }, [staffing, arrivalGrid]);

  const peakHour = staffingModel.length
    ? staffingModel.reduce((a, b) => a.avgArrivals >= b.avgArrivals ? a : b)
    : null;
  const peakDow  = DAYS.reduce((best, _, d) => {
    const tot = HOURS.reduce((a, h) => a + (arrivalGrid.grid[d]?.[h] || 0), 0);
    return tot > (HOURS.reduce((a, h) => a + (arrivalGrid.grid[best]?.[h] || 0), 0)) ? d : best;
  }, 0);
  const maxStaff = staffingModel.length ? Math.max(...staffingModel.map(s => s.requiredStaff), 1) : 1;

  // Daily trend chart
  const trendData = useMemo(() => (sla?.dailyTrend || []).map(d => ({
    date: d._id.slice(5), count: d.count, evaluation: d.evaluation, translation: d.translation,
  })).slice(-60), [sla]);

  if (loading) return (
    <div className="flex items-center justify-center py-24 text-ink-400 text-sm">
      Loading forecast data…
    </div>
  );

  // Surface server errors instead of crashing
  if (staffing?.error || sla?.error) return (
    <div className="card-surface p-8 text-center">
      <div className="text-2xl mb-3">⚠️</div>
      <h3 className="text-base font-display font-bold text-ink-700 mb-2">Forecast data unavailable</h3>
      <p className="text-sm text-ink-400 max-w-md mx-auto">
        {staffing?.error || sla?.error}
      </p>
      <p className="text-xs text-ink-300 mt-3">Run a backfill to seed the forecast data, then refresh this page.</p>
    </div>
  );

  const noData = !staffing?.arrivals?.length;

  return (
    <div className="space-y-4" data-tour="forecast-title">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-display font-bold text-ink-900">Staffing Forecast</h1>
          <p className="text-xs text-ink-400 mt-0.5">
            Demand patterns from {fmtI(staffing?.totalOrders || 0)} orders · {fmtI(Math.round(staffing?.avgPerDay || 0))} avg orders/day
            {dept && <span className="ml-2 px-1.5 py-0.5 bg-brand-100 text-brand-700 text-[10px] rounded font-semibold">{dept}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Dept</label>
            <select value={dept} onChange={e => handleDeptChange(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-surface-200 rounded-lg text-xs text-ink-800 focus:outline-none focus:border-brand-400">
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex gap-1 bg-surface-100 p-1 rounded-lg border border-surface-200 flex-wrap">
            {[['demand','📈 Demand'],['staffing','👥 Staffing Model'],['sla','⏱ SLA Analysis'],['bottlenecks','🚧 Bottlenecks']].map(([k,l]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${tab===k?'bg-white text-brand-600 shadow-sm border border-surface-200':'text-ink-500 hover:text-ink-700'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {noData && (
        <div className="card-surface p-8 text-center">
          <div className="text-4xl mb-3 opacity-20">📊</div>
          <h3 className="text-base font-display font-bold text-ink-700 mb-1">Building forecast data</h3>
          <p className="text-sm text-ink-400 max-w-md mx-auto">
            The order arrival backfill runs during each data sync. Trigger a full backfill from Data Backfill to seed the 180-day history, then return here.
          </p>
        </div>
      )}

      {!noData && (
        <>
          {/* ── Summary strip ───────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Orders (history)" value={fmtI(staffing.totalOrders)} sub="all time in backfill" />
            <StatCard label="Avg Orders / Day" value={fmt(staffing.avgPerDay)} sub={`last ${staffing.spanDaysActual || staffing.modelMeta?.dataSpanDays || '—'} days`} />
            <StatCard label="Peak Hour" value={peakHour ? fmtHour(peakHour.hour) : '—'} sub={`~${peakHour?.avgArrivals||0} orders avg`} />
            <StatCard label="Peak Day" value={DAYS[peakDow]} sub="highest weekly volume" />
          </div>

          {/* ── Demand tab ──────────────────────────────────────── */}
          {tab === 'demand' && (
            <div className="space-y-4">
              {/* Volume trend */}
              {trendData.length > 0 && (
                <div className="card-surface p-4 bg-slate-900">
                  <div className="text-xs font-semibold text-slate-400 mb-3">Daily Order Volume — Last 60 Days</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={trendData} margin={{ left:0, right:8, top:4, bottom:20 }}>
                      <defs>
                        <linearGradient id="evalGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#00aeef" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#00aeef" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill:'#94a3b8', fontSize:9 }} interval={Math.max(0,Math.floor(trendData.length/10))} />
                      <YAxis tick={{ fill:'#94a3b8', fontSize:10 }} />
                      <Tooltip {...TOOLTIP_STYLE} />
                      <Area type="monotone" dataKey="evaluation" name="Evaluation" stroke="#00aeef" strokeWidth={2} fill="url(#evalGrad)" stackId="1" />
                      <Area type="monotone" dataKey="translation" name="Translation" stroke="#16a34a" strokeWidth={2} fill="rgba(22,163,74,0.15)" stackId="1" />
                      <Legend wrapperStyle={{ fontSize:11 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Arrival heatmap */}
              <div className="card-surface p-4">
                <div className="text-xs font-semibold text-ink-600 mb-3">
                  Order Arrivals by Hour × Day (UTC) — historical average
                </div>
                <div className="overflow-x-auto">
                  <div style={{ minWidth: 650 }}>
                    <div className="flex ml-10 mb-1">
                      {HOURS.filter(h => h % 3 === 0).map(h => (
                        <div key={h} className="text-center text-[9px] text-ink-400" style={{ width:`${100/24*3}%` }}>{fmtHour(h)}</div>
                      ))}
                    </div>
                    {DAYS.map((day, d) => (
                      <div key={day} className="flex items-center mb-px">
                        <div className="w-10 shrink-0 text-[10px] font-semibold text-ink-500 text-right pr-2">{day}</div>
                        {HOURS.map(h => {
                          const v = arrivalGrid.grid[d]?.[h] || 0;
                          return (
                            <div key={h} title={`${day} ${fmtHour(h)}: ~${v} orders`}
                              className="flex-1 h-7 flex items-center justify-center text-[9px] font-mono rounded-sm mx-px cursor-default transition-colors"
                              style={heatStyle(v, arrivalGrid.max)}>
                              {v > 0 ? v : ''}
                            </div>
                          );
                        })}
                        <div className="w-10 shrink-0 text-[10px] font-mono text-ink-400 text-right pl-2">
                          {HOURS.reduce((a, h) => a + (arrivalGrid.grid[d]?.[h] || 0), 0)}
                        </div>
                      </div>
                    ))}
                    <div className="flex ml-10 mt-1">
                      {HOURS.map(h => {
                        const t = DAYS.reduce((a, _, d) => a + (arrivalGrid.grid[d]?.[h] || 0), 0);
                        return <div key={h} className="flex-1 text-[9px] font-mono text-center text-ink-400">{t||''}</div>;
                      })}
                    </div>
                  </div>
                </div>
                {/* Day-of-week volume summary */}
                <div className="mt-4 pt-3 border-t border-surface-100">
                  <div className="text-[10px] font-semibold text-ink-500 mb-2">Weekly volume by day</div>
                  <div className="flex gap-2 items-end h-16">
                    {DAYS.map((day, d) => {
                      const total = HOURS.reduce((a, h) => a + (arrivalGrid.grid[d]?.[h] || 0), 0);
                      const maxDay = Math.max(...DAYS.map((_, dd) => HOURS.reduce((a,h) => a+(arrivalGrid.grid[dd]?.[h]||0), 0)), 1);
                      const pct = total / maxDay;
                      const isWeekend = d === 0 || d === 6;
                      return (
                        <div key={day} className="flex-1 flex flex-col items-center gap-1">
                          <div className="text-[9px] font-mono text-ink-500">{total}</div>
                          <div className="w-full rounded-t-sm"
                            style={{ height:`${Math.max(pct*44,2)}px`, background:isWeekend?'#94a3b8':'#00aeef', opacity:0.8 }} />
                          <div className={`text-[10px] font-bold ${isWeekend?'text-ink-400':'text-ink-700'}`}>{day}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-1 mt-3">
                  <span className="text-[10px] text-ink-400 mr-1">Low</span>
                  {[0.1,0.3,0.5,0.7,0.9].map(p=>(
                    <div key={p} className="w-5 h-3 rounded-sm" style={{ background:`rgba(0,174,239,${0.08+p*0.85})` }}/>
                  ))}
                  <span className="text-[10px] text-ink-400 ml-1">High</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Staffing Model tab ──────────────────────────────── */}
          {tab === 'staffing' && (
            <div className="space-y-4">
              <div className="card-surface p-4 bg-amber-50 border border-amber-200">
                <div className="text-xs font-semibold text-amber-800 mb-1">How this model works</div>
                <p className="text-[11px] text-amber-700 leading-relaxed">
                  <strong>Required staff = ceil( avg orders arriving at hour H ÷ team XpH )</strong>.
                  XpH is computed from the last 60 days of segment data, weighted by volume across all statuses.
                  This is a lower-bound estimate — it assumes 100% utilization. Add 20–30% for breaks, queue variance, and context switching.
                  The number shown is concurrent staff needed at peak, not total headcount.
                </p>
              </div>

              {/* ── Dept data warning if arrivals fell back to system-wide ── */}
              {staffing?.arrivalsDeptNote && (
                <div className="card-surface p-3 bg-red-50 border border-red-200 text-[11px] text-red-700">
                  <strong>⚠ Data Warning:</strong> {staffing.arrivalsDeptNote}
                </div>
              )}

              {/* ── Model Transparency Panel ─────────────────────────── */}
              {staffing?.modelMeta && <ModelTransparency meta={staffing.modelMeta} dept={dept} />}

              <div className="card-surface p-4 bg-slate-900">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <span className="text-xs font-semibold text-slate-400">Required Concurrent Staff by Hour (avg across all days)</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-400">Weighted XpH: <strong className="text-brand-400">{staffingModel[0]?.weightedXph}</strong></span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={staffingModel} margin={{ left:0, right:8, top:4, bottom:30 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill:'#94a3b8', fontSize:9 }} angle={-40} textAnchor="end" height={50} />
                    <YAxis tick={{ fill:'#94a3b8', fontSize:10 }} />
                    <Tooltip {...TOOLTIP_STYLE}
                      labelFormatter={(label) => `Hour: ${label}`}
                      formatter={(v, n) => n === 'requiredStaff' ? [`${v} staff`, 'Concurrent staff needed'] : [`${v} orders`, 'Avg arrivals/hr']} />
                    <Bar dataKey="requiredStaff" name="Staff needed" radius={[4,4,0,0]}>
                      {staffingModel.map((s,i) => <Cell key={i} fill={s.requiredStaff >= maxStaff*0.8 ? '#dc2626' : s.requiredStaff >= maxStaff*0.5 ? '#d97706' : '#16a34a'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Per-status XpH */}
              <div className="card-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-200">
                  <span className="text-xs font-semibold text-ink-600">XpH by Status — last 60 days</span>
                </div>
                <table className="w-full">
                  <thead className="bg-surface-50 border-b border-surface-200">
                    <tr>
                      {['Status','Segments','XpH (segs/hr)','Avg Duration','Staff at 50 ord/hr'].map(h=>(
                        <th key={h} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(staffing?.xphByStatus || []).map(r => (
                      <tr key={r.statusSlug} className="border-b border-surface-100 hover:bg-surface-50 text-sm">
                        <td className="px-3 py-2 font-medium text-ink-900">{r.statusName||r.statusSlug}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtI(r.segments)}</td>
                        <td className="px-3 py-2 font-mono text-xs font-semibold text-right text-brand-700">{fmt(r.xph)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{r.avgDurMin}m</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{r.xph>0?Math.ceil(50/r.xph):'-'} staff</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── SLA Analysis tab ────────────────────────────────── */}
          {tab === 'sla' && (
            <div className="space-y-4">
              <div className="card-surface p-4 bg-brand-50 border border-brand-200">
                <div className="text-xs font-semibold text-brand-800 mb-1">📌 How SLA recommendations are derived</div>
                <p className="text-[11px] text-brand-700 leading-relaxed">
                  Recommendations = <strong>P75 actual turnaround × 1.2 buffer</strong>, rounded up to the nearest half-day.
                  P75 means 75% of orders complete within this time. The 20% buffer accounts for queue variance and staffing gaps.
                  These are data-driven starting points — adjust based on your commitments to customers.
                </p>
              </div>

              <div className="card-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-600">SLA Recommendations by Report Type + Process Time</span>
                  <span className="text-[10px] text-ink-400">Based on last {staffing?.spanDaysActual || staffing?.modelMeta?.dataSpanDays || 180} days</span>
                </div>
                <table className="w-full">
                  <thead className="bg-surface-50 border-b border-surface-200">
                    <tr>
                      {['Report Type','Process Time','Orders','P50','P75','P90','Current Late %','Recommended SLA','Status'].map(h=>(
                        <th key={h} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(sla?.recommendations || []).sort((a,b)=>b.count-a.count).map((r,i) => (
                      <tr key={i} className="border-b border-surface-100 hover:bg-surface-50 text-sm">
                        <td className="px-3 py-2 font-medium text-ink-900">{r.reportItemName||'—'}</td>
                        <td className="px-3 py-2 text-xs text-ink-600 font-mono">{r.processTimeSlug||'standard'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtI(r.count)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtHrs(r.p50Hrs)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right font-semibold">{fmtHrs(r.p75Hrs)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtHrs(r.p90Hrs)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`text-xs font-semibold ${r.latePct>25?'text-red-600':r.latePct>10?'text-amber-600':'text-emerald-600'}`}>{r.latePct}%</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-sm font-bold text-brand-700">{r.recommendedSlaDays}d</span>
                          <span className="text-[10px] text-ink-400 ml-1">({r.recommendedSlaHrs}h)</span>
                        </td>
                        <td className="px-3 py-2"><SLABadge status={r.status} /></td>
                      </tr>
                    ))}
                    {!(sla?.recommendations?.length) && (
                      <tr><td colSpan={9} className="px-3 py-6 text-center text-ink-400 text-sm">No completed orders in backfill yet — run a full backfill to seed data.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Bottlenecks tab ──────────────────────────────────── */}
          {tab === 'bottlenecks' && (
            <div className="space-y-4">
              <div className="card-surface p-4 bg-red-50 border border-red-200">
                <div className="text-xs font-semibold text-red-800 mb-1">🚧 What is a bottleneck?</div>
                <p className="text-[11px] text-red-700 leading-relaxed">
                  A status where the P75 queue wait time exceeds 4 hours — meaning 25% of orders wait more than 4 hours before anyone picks up the work.
                  These are where additional staff has the most impact on end-to-end turnaround.
                </p>
              </div>

              <div className="card-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-200">
                  <span className="text-xs font-semibold text-ink-600">Queue Bottlenecks — Waiting Status Wait Times (P75 &gt; 4h)</span>
                </div>
                <table className="w-full">
                  <thead className="bg-surface-50 border-b border-surface-200">
                    <tr>
                      {['Waiting Status','Observations','Avg Wait','P75 Wait','Max Wait','Staffing Impact'].map(h=>(
                        <th key={h} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(sla?.bottlenecks || []).map((r,i) => (
                      <tr key={i} className="border-b border-surface-100 hover:bg-surface-50 text-sm">
                        <td className="px-3 py-2 font-medium text-ink-900 font-mono text-xs">{r.statusSlug}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtI(r.count)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-right">{fmtHrs(r.avgWaitHrs)}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-bold ${r.p75Hrs>24?'text-red-600':r.p75Hrs>8?'text-amber-600':'text-orange-500'}`}>
                            {fmtHrs(r.p75Hrs)}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-right text-ink-500">—</td>
                        <td className="px-3 py-2 text-xs text-ink-600">
                          {r.p75Hrs > 24 ? '🔴 Critical — staff upstream' : r.p75Hrs > 8 ? '🟡 High — monitor closely' : '🟠 Moderate — watch trend'}
                        </td>
                      </tr>
                    ))}
                    {!(sla?.bottlenecks?.length) && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-emerald-600 text-sm font-semibold">✓ No critical bottlenecks detected in last {staffing?.spanDaysActual || staffing?.modelMeta?.dataSpanDays || 180} days</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Full status wait time table */}
              {sla?.byStatus?.length > 0 && (
                <div className="card-surface overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-200">
                    <span className="text-xs font-semibold text-ink-600">All Status Wait Times — avg time orders spend in each Waiting queue</span>
                  </div>
                  <table className="w-full">
                    <thead className="bg-surface-50 border-b border-surface-200">
                      <tr>
                        {['Waiting Status','Orders Passed Through','Avg Wait','P75 Wait'].map(h=>(
                          <th key={h} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-400 text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sla.byStatus.map((r,i)=>(
                        <tr key={i} className="border-b border-surface-100 hover:bg-surface-50 text-sm">
                          <td className="px-3 py-2 font-mono text-xs text-ink-700">{r.statusSlug}</td>
                          <td className="px-3 py-2 font-mono text-xs text-right">{fmtI(r.count)}</td>
                          <td className="px-3 py-2 font-mono text-xs text-right">
                            {r.avgWaitMin >= 60 ? `${Math.round(r.avgWaitMin/60*10)/10}h` : `${r.avgWaitMin}m`}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-right">
                            {r.p75Min >= 60 ? `${Math.round(r.p75Min/60*10)/10}h` : `${r.p75Min}m`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}