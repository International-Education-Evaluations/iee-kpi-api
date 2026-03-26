import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';

// ── Tour step definitions ────────────────────────────────────
// selector: CSS selector for the highlighted element (null = centre-screen modal)
// route: navigate here before showing this step
// title / body: content
// position: 'bottom' | 'top' | 'left' | 'right' | 'center'
const TOUR_STEPS = [
  {
    route: '/',
    selector: null,
    position: 'center',
    title: '👋 Welcome to IEE Ops Dashboard',
    body: "This quick tour will walk you through every section. You can exit at any time by pressing Escape or clicking outside. Let's go!",
  },
  {
    route: '/',
    selector: '[data-tour="kpi-overview-title"]',
    position: 'bottom',
    title: '📊 KPI Overview',
    body: 'Your top-level performance view — segments processed, closed/open counts, average duration, In-Range rate, and unique orders. Covers the last 60 days.',
  },
  {
    route: '/',
    selector: '[data-tour="filter-bar"]',
    position: 'bottom',
    title: '🔍 Filters',
    body: 'Narrow down by Department, Order Type, Status, Worker, or date range. All charts and tables update instantly. Use "Clear filters" to reset.',
  },
  {
    route: '/',
    selector: '[data-tour="metric-cards"]',
    position: 'bottom',
    title: '📈 Metric Cards',
    body: 'Key performance numbers at a glance. The ↑↓ arrow shows week-over-week volume change. Cards update to reflect your active filters.',
  },
  {
    route: '/',
    selector: '[data-tour="bucket-chart"]',
    position: 'right',
    title: '🪣 5-Bucket Classification',
    body: 'Every closed segment is classified against your benchmark thresholds: Exclude Short → OOR Short → In-Range → OOR Long → Exclude Long. The In-Range % is your primary quality KPI.',
  },
  {
    route: '/',
    selector: '[data-tour="breakdown-table"]',
    position: 'top',
    title: '🖱️ Drilldown Tables',
    body: 'Click any row in "By Status" or "By Worker" to open a slide-over drawer with individual order-level segments. All columns are sortable — click any header.',
  },
  {
    route: '/kpi/users',
    selector: '[data-tour="user-drilldown-title"]',
    position: 'bottom',
    title: '👤 User Drill-Down',
    body: 'Select any worker to see their full performance breakdown — XpH trend, status breakdown, every order they worked, and individual segment detail with durations down to the second.',
  },
  {
    route: '/qc',
    selector: '[data-tour="qc-title"]',
    position: 'bottom',
    title: '✅ QC Overview',
    body: 'All quality control events. Fixed It vs Kick Back rates by department, issue type, and individual user. Use the date range filter to scope to any period. Click any row to drill in.',
  },
  {
    route: '/queue',
    selector: '[data-tour="queue-title"]',
    position: 'bottom',
    title: '⏳ Queue Operations',
    body: 'Live snapshot of all active orders by status — waiting counts, aging buckets, oldest orders. Click any status row to see the individual orders currently sitting in it.',
  },
  {
    route: '/queue',
    selector: '[data-tour="queue-tabs"]',
    position: 'bottom',
    title: '📜 Wait Summary',
    body: '"Wait Summary (2024+)" shows historical throughput — median, avg, P75, P90 wait times per status over 90 days. Useful for identifying chronic bottleneck statuses.',
  },
  {
    route: '/reports',
    selector: '[data-tour="report-builder-title"]',
    position: 'bottom',
    title: '🛠️ Report Builder',
    body: 'Build custom queries across KPI segments and QC events. Choose any metric, group-by dimension, and chart type. Export to CSV for offline analysis.',
  },
  {
    route: '/chat',
    selector: '[data-tour="chat-title"]',
    position: 'bottom',
    title: '🤖 AI Assistant',
    body: 'Ask questions in plain English — "Who had the highest XpH last week?", "Are there any statuses with >48hr orders?", "Show me QC trends by department". Powered by Claude with live data access.',
  },
  {
    route: '/settings',
    selector: '[data-tour="settings-title"]',
    position: 'bottom',
    title: '⚙️ Configuration',
    body: 'Set XpH benchmarks per status (L0–L5), configure 5-bucket classification thresholds, set production hours, and assign user levels. All changes are audited.',
  },
  {
    route: '/admin/users',
    selector: '[data-tour="admin-users-title"]',
    position: 'bottom',
    title: '👥 User Management',
    body: 'Create users, send invite emails, assign roles (admin/manager/viewer), and manage API keys. Invite links expire after 7 days and can be resent.',
  },
  {
    route: '/admin/backfill',
    selector: '[data-tour="backfill-title"]',
    position: 'bottom',
    title: '🔄 Data Backfill',
    body: 'Controls for the data sync engine. Trigger an immediate incremental backfill, run a full re-seed, or adjust the auto-refresh interval. All dashboard data reads from the backfill cache — never from production directly.',
  },
  {
    route: '/',
    selector: null,
    position: 'center',
    title: "🎉 You're all set!",
    body: "That covers the full dashboard. Your data refreshes automatically every few minutes. If you ever want this tour again, click \"Take a tour\" in the sidebar. Happy analyzing!",
  },
];

const STORAGE_KEY = 'iee_tour_completed';

// ── Spotlight overlay ────────────────────────────────────────
function TourOverlay({ rect, children }) {
  const pad = 8;
  const hasRect = rect && rect.width > 0;

  return createPortal(
    <div className="fixed inset-0 z-[9000] pointer-events-none" style={{ isolation: 'isolate' }}>
      {/* Dark backdrop with cutout */}
      {hasRect ? (
        <svg className="absolute inset-0 w-full h-full pointer-events-auto" style={{ cursor:'default' }}>
          <defs>
            <mask id="tour-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={rect.left - pad} y={rect.top - pad}
                width={rect.width + pad*2} height={rect.height + pad*2}
                rx="8" fill="black"
              />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#tour-mask)" />
          {/* Highlight ring */}
          <rect
            x={rect.left - pad} y={rect.top - pad}
            width={rect.width + pad*2} height={rect.height + pad*2}
            rx="8" fill="none" stroke="#00aeef" strokeWidth="2.5"
            className="pointer-events-none"
          />
        </svg>
      ) : (
        <div className="absolute inset-0 bg-black/55 pointer-events-auto" />
      )}
      {/* Tooltip card — pointer-events on */}
      <div className="pointer-events-auto">
        {children}
      </div>
    </div>,
    document.body
  );
}

// ── Tooltip position calculator ───────────────────────────────
function getTooltipStyle(rect, position, tooltipW = 360, tooltipH = 200) {
  const pad = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect || position === 'center') {
    return {
      position: 'fixed',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: Math.min(tooltipW, vw - 32),
    };
  }

  let top, left;
  const sp = 16; // spacing from element

  if (position === 'bottom') {
    top = rect.bottom + sp + 8;
    left = rect.left + rect.width/2 - tooltipW/2;
  } else if (position === 'top') {
    top = rect.top - tooltipH - sp;
    left = rect.left + rect.width/2 - tooltipW/2;
  } else if (position === 'right') {
    top = rect.top + rect.height/2 - tooltipH/2;
    left = rect.right + sp;
  } else if (position === 'left') {
    top = rect.top + rect.height/2 - tooltipH/2;
    left = rect.left - tooltipW - sp;
  }

  // Clamp to viewport
  left = Math.max(pad, Math.min(left, vw - tooltipW - pad));
  top  = Math.max(pad, Math.min(top,  vh - tooltipH - pad));

  return { position: 'fixed', top, left, width: tooltipW };
}

// ── Main Tour component ───────────────────────────────────────
export default function Tour({ onClose }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const timerRef = useRef(null);
  const current = TOUR_STEPS[step];

  const measureElement = useCallback(() => {
    if (!current.selector) { setRect(null); setVisible(true); return; }
    // Wait for navigation + render, then measure
    const attempt = (tries = 0) => {
      const el = document.querySelector(current.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect(r);
        setVisible(true);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } else if (tries < 12) {
        timerRef.current = setTimeout(() => attempt(tries + 1), 150);
      } else {
        setRect(null); setVisible(true); // fallback: show tooltip anyway
      }
    };
    setVisible(false);
    timerRef.current = setTimeout(() => attempt(), 100);
  }, [current]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (current.route && location.pathname !== current.route) {
      navigate(current.route);
      timerRef.current = setTimeout(measureElement, 400);
    } else {
      measureElement();
    }
  }, [step]); // eslint-disable-line

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const prev = () => setStep(s => Math.max(0, s - 1));
  const next = () => {
    if (step < TOUR_STEPS.length - 1) setStep(s => s + 1);
    else { localStorage.setItem(STORAGE_KEY, '1'); onClose(); }
  };
  const skip = () => { localStorage.setItem(STORAGE_KEY, '1'); onClose(); };

  const tooltipStyle = getTooltipStyle(rect, current.position);
  const isLast = step === TOUR_STEPS.length - 1;

  if (!visible) return null;

  return (
    <TourOverlay rect={rect}>
      <div style={tooltipStyle} className="bg-white rounded-2xl shadow-2xl overflow-hidden border border-surface-200">
        {/* Progress bar */}
        <div className="h-1 bg-surface-100">
          <div
            className="h-full bg-brand-500 transition-all duration-300"
            style={{ width: `${((step + 1) / TOUR_STEPS.length) * 100}%` }}
          />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-2">
          <div className="text-sm font-display font-bold text-ink-900 leading-snug pr-4">
            {current.title}
          </div>
          <button onClick={skip}
            className="text-ink-300 hover:text-ink-600 text-lg leading-none mt-0.5 shrink-0 transition-colors">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pb-4 text-[13px] text-ink-600 leading-relaxed">
          {current.body}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-100 flex items-center justify-between bg-surface-50">
          <span className="text-[11px] text-ink-400">
            {step + 1} / {TOUR_STEPS.length}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={skip}
              className="px-3 py-1.5 text-xs text-ink-400 hover:text-ink-600 transition-colors">
              Skip tour
            </button>
            {step > 0 && (
              <button onClick={prev}
                className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-ink-600 hover:border-brand-300 hover:text-brand-600 transition-colors">
                ← Back
              </button>
            )}
            <button onClick={next}
              className="px-4 py-1.5 text-xs bg-brand-500 hover:bg-brand-600 text-ink-900 font-semibold rounded-lg transition-colors">
              {isLast ? 'Finish ✓' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </TourOverlay>
  );
}

// ── Hook: auto-start tour for first-time users ────────────────
export function useTourAutoStart() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    // Small delay so the dashboard finishes rendering first
    const t = setTimeout(() => {
      if (!localStorage.getItem(STORAGE_KEY)) setShow(true);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
  return [show, setShow];
}
