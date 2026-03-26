import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';

// ── Tour step definitions ────────────────────────────────────────────────────
// Each step navigates to a route, waits for render, then highlights a selector.
// selector: null = centred modal (no spotlight)
// position: where the tooltip appears relative to the highlighted element
const TOUR_STEPS = [
  {
    route: '/',
    selector: null,
    position: 'center',
    title: '👋 Welcome to IEE Ops',
    body: "This 2-minute tour walks through every section of the dashboard. Press Esc or click outside to exit at any time.",
  },
  {
    route: '/',
    selector: '[data-tour="kpi-overview-title"]',
    position: 'bottom',
    title: '📊 KPI Overview',
    body: 'Your main performance view — 95k+ segments covering the last 60 days. Segments, closed/open counts, avg duration, In-Range rate, and unique orders.',
  },
  {
    route: '/',
    selector: '[data-tour="filter-bar"]',
    position: 'bottom',
    title: '🔍 Filters',
    body: 'Filter by Department, Order Type, Status, Worker, or date range. All charts and tables respond instantly. "Clear filters" resets everything.',
  },
  {
    route: '/',
    selector: '[data-tour="metric-cards"]',
    position: 'bottom',
    title: '📈 Metric Cards',
    body: 'Live KPI numbers at a glance. The ↑↓ arrow shows week-over-week volume change. All cards reflect your active filters.',
  },
  {
    route: '/',
    selector: '[data-tour="bucket-chart"]',
    position: 'right',
    title: '🪣 5-Bucket Classification',
    body: 'Every closed segment is classified against your benchmark thresholds: Exclude Short → OOR Short → In-Range → OOR Long → Exclude Long. In-Range % is your primary quality KPI.',
  },
  {
    route: '/',
    selector: '[data-tour="breakdown-table"]',
    position: 'top',
    title: '📋 Breakdown Tabs',
    body: 'Three tabs: By Status, By Worker, and Segments. Click any status or worker row to open a detailed drilldown. The Segments tab shows every individual segment with full detail.',
  },
  {
    route: '/kpi/users',
    selector: '[data-tour="user-drilldown-title"]',
    position: 'bottom',
    title: '👤 User Drill-Down',
    body: 'Select any worker to see their XpH trend, daily volume, status breakdown, every order worked, and segment-level detail. Your last selected worker is remembered across navigation.',
  },
  {
    route: '/kpi/scorecard',
    selector: '[data-tour="scorecard-title"]',
    position: 'bottom',
    title: '🎯 Performance Scorecard',
    body: 'Every worker side-by-side — XpH vs benchmark target, In-Range %, attainment badge (green/amber/red), level, and total hours. Default sort surfaces lowest attainment first.',
  },
  {
    route: '/kpi/departments',
    selector: '[data-tour="dept-comparison-title"]',
    position: 'bottom',
    title: '🏢 Department Comparison',
    body: 'Side-by-side department performance — XpH, In-Range %, segment volume, avg duration, and QC kick-back rate. Switch the chart metric with the buttons above the chart.',
  },
  {
    route: '/kpi/heatmap',
    selector: '[data-tour="heatmap-title"]',
    position: 'bottom',
    title: '🌡️ Shift Heatmap',
    body: 'Processing patterns by hour × day-of-week. See when your team is most active and whether quality or throughput shifts at certain times. Switch between Volume, Avg Duration, and XpH.',
  },
  {
    route: '/qc',
    selector: '[data-tour="qc-title"]',
    position: 'bottom',
    title: '✅ QC Overview',
    body: 'All quality control events — Fixed It vs Kick Back rates by department, issue type, and individual user. Filter by date range to scope to any period.',
  },
  {
    route: '/queue',
    selector: '[data-tour="queue-title"]',
    position: 'bottom',
    title: '⏳ Queue Operations',
    body: 'Live snapshot of all open orders by status — waiting counts, aging buckets, oldest order. Click any row to see the individual orders currently sitting in that status.',
  },
  {
    route: '/orders',
    selector: '[data-tour="order-tracker-title"]',
    position: 'bottom',
    title: '🔍 Order Tracker',
    body: 'Paste any order serial number and see its complete processing lifecycle — every status, who worked it, how long each step took, and any QC events attached.',
  },
  {
    route: '/reports',
    selector: '[data-tour="report-builder-title"]',
    position: 'bottom',
    title: '🛠️ Report Builder',
    body: 'Build custom reports across KPI and QC data. Choose any metric (XpH, In-Range %, kick-back rate…), group by dimension, pick a chart type, and export to CSV.',
  },
  {
    route: '/chat',
    selector: '[data-tour="chat-title"]',
    position: 'bottom',
    title: '🤖 AI Assistant',
    body: 'Ask questions in plain English — "Who had the highest XpH last week?", "Show QC trends by department", "Are there any statuses with >48hr open orders?". Conversations are saved per user.',
  },
  {
    route: '/settings',
    selector: '[data-tour="settings-title"]',
    position: 'bottom',
    title: '⚙️ Configuration',
    body: 'Set XpH benchmarks per status (L0–L5), configure 5-bucket thresholds, set production hours, and assign user levels. All changes are immediately reflected in all views.',
  },
  {
    route: '/',
    selector: null,
    position: 'center',
    title: "🎉 You're all set!",
    body: "That covers the full dashboard. Data refreshes automatically every few minutes. Click \"Take a tour\" in the sidebar any time to replay this. Happy analyzing!",
  },
];

const STORAGE_KEY = 'iee_tour_v2_completed';

// ── SVG spotlight overlay ────────────────────────────────────────────────────
function TourOverlay({ rect, onBackdropClick, children }) {
  const pad = 10;
  const hasRect = rect && rect.width > 4;

  return createPortal(
    <div className="fixed inset-0 z-[9900] pointer-events-none" style={{ isolation: 'isolate' }}>
      {hasRect ? (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-auto"
          style={{ cursor: 'default' }}
          onClick={onBackdropClick}
        >
          <defs>
            <mask id="tour-spotlight-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={Math.max(0, rect.left - pad)}
                y={Math.max(0, rect.top - pad)}
                width={rect.width + pad * 2}
                height={rect.height + pad * 2}
                rx="8" fill="black"
              />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#tour-spotlight-mask)" />
          {/* Highlight ring */}
          <rect
            x={Math.max(0, rect.left - pad)}
            y={Math.max(0, rect.top - pad)}
            width={rect.width + pad * 2}
            height={rect.height + pad * 2}
            rx="8" fill="none"
            stroke="#00aeef" strokeWidth="2"
            className="pointer-events-none"
          />
        </svg>
      ) : (
        <div
          className="absolute inset-0 bg-black/60 pointer-events-auto"
          onClick={onBackdropClick}
        />
      )}
      <div className="pointer-events-auto absolute" style={{ zIndex: 9910 }}>
        {children}
      </div>
    </div>,
    document.body
  );
}

// ── Tooltip position calculator ──────────────────────────────────────────────
function getTooltipStyle(rect, position, w = 380) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const h  = 220; // estimated tooltip height
  const sp = 14;  // spacing from element
  const pad = 12;

  if (!rect || position === 'center') {
    return {
      position: 'fixed',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: Math.min(w, vw - 32),
      maxWidth: 420,
    };
  }

  let top, left;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top  + rect.height / 2;

  if (position === 'bottom') {
    top  = rect.bottom + sp;
    left = cx - w / 2;
  } else if (position === 'top') {
    top  = rect.top - h - sp;
    left = cx - w / 2;
  } else if (position === 'right') {
    top  = cy - h / 2;
    left = rect.right + sp;
  } else if (position === 'left') {
    top  = cy - h / 2;
    left = rect.left - w - sp;
  } else {
    top  = rect.bottom + sp;
    left = cx - w / 2;
  }

  // Flip if out of viewport
  if (position === 'bottom' && top + h > vh - pad) top = rect.top - h - sp;
  if (position === 'top'    && top < pad)           top = rect.bottom + sp;
  if (position === 'right'  && left + w > vw - pad) left = rect.left - w - sp;
  if (position === 'left'   && left < pad)           left = rect.right + sp;

  // Clamp to viewport
  left = Math.max(pad, Math.min(left, vw - w - pad));
  top  = Math.max(pad, Math.min(top, vh - h - pad));

  return { position: 'fixed', top, left, width: w };
}

// ── Main Tour component ──────────────────────────────────────────────────────
export default function Tour({ onClose }) {
  const [step, setStep]       = useState(0);
  const [rect, setRect]       = useState(null);
  const [visible, setVisible] = useState(false);
  const navigate   = useNavigate();
  const location   = useLocation();
  const timerRef   = useRef(null);
  const current    = TOUR_STEPS[step];

  // Measure target element, retrying until it appears
  const measureElement = useCallback((selector, attempts = 0) => {
    clearTimeout(timerRef.current);
    if (!selector) { setRect(null); setVisible(true); return; }

    const el = document.querySelector(selector);
    if (el) {
      const r = el.getBoundingClientRect();
      // Confirm element is actually visible (not off-screen or zero-size)
      if (r.width > 2 && r.height > 2 && r.top < window.innerHeight && r.bottom > 0) {
        // Scroll element into view smoothly, then measure after scroll settles
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        timerRef.current = setTimeout(() => {
          const r2 = el.getBoundingClientRect();
          setRect(r2);
          setVisible(true);
        }, 300);
        return;
      }
    }

    if (attempts < 15) {
      timerRef.current = setTimeout(() => measureElement(selector, attempts + 1), 150);
    } else {
      // Give up — show tooltip in center without spotlight
      setRect(null);
      setVisible(true);
    }
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
    setRect(null);

    const targetRoute = current.route;
    const onCorrectRoute = location.pathname === targetRoute;

    if (!onCorrectRoute) {
      navigate(targetRoute);
      // Wait longer after navigation for React to render the new page
      timerRef.current = setTimeout(() => measureElement(current.selector), 600);
    } else {
      timerRef.current = setTimeout(() => measureElement(current.selector), 120);
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard nav
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && step < TOUR_STEPS.length - 1) setStep(s => s + 1);
      if (e.key === 'ArrowLeft'  && step > 0) setStep(s => s - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, step]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const prev = () => setStep(s => Math.max(0, s - 1));
  const next = () => {
    if (step < TOUR_STEPS.length - 1) setStep(s => s + 1);
    else finish();
  };
  const finish = () => { localStorage.setItem(STORAGE_KEY, '1'); onClose(); };
  const skip   = () => { localStorage.setItem(STORAGE_KEY, '1'); onClose(); };

  const tooltipStyle = getTooltipStyle(rect, current.position);
  const isLast = step === TOUR_STEPS.length - 1;
  const pct = Math.round((step + 1) / TOUR_STEPS.length * 100);

  if (!visible) return null;

  return (
    <TourOverlay rect={rect} onBackdropClick={skip}>
      <div style={{ ...tooltipStyle }} className="bg-white rounded-2xl shadow-2xl overflow-hidden border border-surface-200">
        {/* Progress bar */}
        <div className="h-1 bg-surface-100">
          <div className="h-full bg-brand-500 transition-all duration-400 ease-out" style={{ width: `${pct}%` }} />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-2">
          <h3 className="text-sm font-display font-bold text-ink-900 leading-snug pr-4 flex-1">
            {current.title}
          </h3>
          <button onClick={skip} className="text-ink-300 hover:text-ink-600 text-xl leading-none mt-[-2px] shrink-0 transition-colors">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pb-4 text-[13px] text-ink-600 leading-relaxed">
          {current.body}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-100 flex items-center justify-between bg-surface-50/80">
          <span className="text-[11px] text-ink-400">
            {step + 1} / {TOUR_STEPS.length}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={skip} className="px-3 py-1.5 text-xs text-ink-400 hover:text-ink-600 transition-colors">
              Skip tour
            </button>
            {step > 0 && (
              <button onClick={prev}
                className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-ink-600 hover:border-brand-300 hover:text-brand-600 transition-colors">
                ← Back
              </button>
            )}
            <button onClick={next}
              className="px-4 py-1.5 text-xs bg-brand-500 hover:bg-brand-600 text-white font-semibold rounded-lg transition-colors">
              {isLast ? 'Finish ✓' : 'Next →'}
            </button>
          </div>
        </div>

        {/* Keyboard hint */}
        <div className="px-5 py-1.5 bg-surface-50/50 border-t border-surface-100">
          <span className="text-[10px] text-ink-300">← → arrow keys to navigate · Esc to close</span>
        </div>
      </div>
    </TourOverlay>
  );
}

// ── Auto-start hook ──────────────────────────────────────────────────────────
export function useTourAutoStart() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!localStorage.getItem(STORAGE_KEY)) setShow(true);
    }, 2500);
    return () => clearTimeout(t);
  }, []);
  return [show, setShow];
}
